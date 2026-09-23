//! Adversarial review 1: the escrow, attacked.
//!
//! Every test here is an attack from `docs/decisions/adversarial-review-1.md`. A test named for
//! what should be refused asserts that it is refused. A test named `finding_…` is an attack the
//! program accepts: it asserts the acceptance, so the suite pins the behaviour the report
//! describes, and a later change that closes the hole shows up here as a failure to update.
//!
//! Run with `cargo test --test adversarial -- --nocapture` to see what each attack did.

use forest_escrow_tests::*;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const AMOUNT: u64 = 1_000_000;

fn ended(events: &[Event]) -> (Outcome, u64, u64, u64, u64) {
    let Some(Event::Ended { outcome, balance, to_seller, to_buyer, rent_lamports, .. }) =
        events.iter().find(|e| e.name() == "Ended")
    else {
        panic!("no Ended event in {events:?}")
    };
    (*outcome, *balance, *to_seller, *to_buyer, *rent_lamports)
}

fn token_account_owned_by(program: Address, mint: &Address, owner: &Address, amount: u64) -> Account {
    let mut a = spl_token_account(mint, owner, amount);
    a.owner = program;
    a
}

/// A wrapped-SOL token account holding nothing: `is_native` is `Some(rent reserve)` at 109..121.
fn wsol_account(owner: &Address) -> Account {
    let mut a = spl_token_account(&NATIVE_MINT, owner, 0);
    a.data[109..113].copy_from_slice(&1u32.to_le_bytes());
    a.data[113..121].copy_from_slice(&2_039_280u64.to_le_bytes());
    a
}

fn sync_native_ix(account: Address) -> Instruction {
    Instruction { program_id: TOKEN_PROGRAM, accounts: vec![AccountMeta::new(account, false)], data: vec![17] }
}

fn spl_close_ix(account: Address, destination: Address, owner: Address) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(account, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data: vec![9],
    }
}

/// A plain SOL transfer: the system program's instruction 2.
fn sol_transfer_ix(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: solana_system_interface::program::ID,
        accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)],
        data,
    }
}

/// A second, independent buyer with a funded token account for the harness mint.
fn new_buyer(h: &mut Harness, tokens: u64) -> (Keypair, Address) {
    let buyer = Keypair::new();
    h.svm.airdrop(&buyer.pubkey(), 1_000_000_000).unwrap();
    let t = Address::new_unique();
    h.svm.set_account(t, spl_token_account(&h.mint, &buyer.pubkey(), tokens)).unwrap();
    (buyer, t)
}

// ---------------------------------------------------------------------------------------------
// 1. Account substitution
// ---------------------------------------------------------------------------------------------

#[test]
fn substitution_another_escrows_deposit_account_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let a = h.funded(&h.terms(1));
    let b = h.funded(&h.terms(2));
    // Approve A, but hand it B's deposit account: A's rules paying out B's money.
    let mut s = h.settle_accounts(&a);
    s.vault = vault_address(&b, &h.mint);
    let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    assert_eq!(h.vault_balance(&a), AMOUNT);
    assert_eq!(h.vault_balance(&b), AMOUNT);
    println!("rejected as expected: escrow A cannot pay out escrow B's deposit account");
}

#[test]
fn substitution_a_look_alike_deposit_account_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    // A token account for the right mint, owned by the escrow's own address, but not the one the
    // escrow recorded: anyone can make one of these.
    let look_alike = Address::new_unique();
    h.svm.set_account(look_alike, spl_token_account(&h.mint, &escrow, 5 * AMOUNT)).unwrap();
    let mut s = h.settle_accounts(&escrow);
    s.vault = look_alike;
    let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintHasOne"), "{err}");

    // Nor can one be handed to create in place of the associated token account.
    let t = h.terms(2);
    let escrow2 = escrow_address(&buyer.pubkey(), 2);
    let look_alike2 = Address::new_unique();
    h.svm.set_account(look_alike2, spl_token_account(&h.mint, &escrow2, 0)).unwrap();
    let mut ix = create_ix(&t, &h.create_accounts());
    ix.accounts[1].pubkey = look_alike2;
    let err = h.send(&[ix], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintAssociated") || err.contains("AccountNotAssociatedTokenAccount") || err.contains("2009") || err.contains("3014"), "{err}");
    assert!(!h.exists(&escrow2));
    println!("rejected as expected: a look-alike deposit account, at an ending and at create");
}

#[test]
fn substitution_payout_accounts_of_the_wrong_mint_owner_or_program_are_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    h.fund(&escrow, 500_000); // excess, so the buyer's slot would receive something
    let base = h.settle_accounts(&escrow);

    // The buyer's slot, holding another mint.
    let other_mint = Address::new_unique();
    h.svm.set_account(other_mint, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
    let wrong_mint = Address::new_unique();
    h.svm.set_account(wrong_mint, spl_token_account(&other_mint, &buyer.pubkey(), 0)).unwrap();
    let mut s = base;
    s.buyer_tokens = wrong_mint;
    let err = h.send(&[cancel_seller_ix(&s, seller.pubkey())], &[&seller]).expect_err("wrong mint");
    assert!(err.contains("ConstraintTokenMint"), "{err}");

    // The seller puts its own account in the buyer's slot, to catch the buyer's refund: the same
    // account twice is a duplicate, and a second account the seller owns is the wrong owner.
    let mut s = base;
    s.buyer_tokens = h.seller_tokens;
    let err = h.send(&[cancel_seller_ix(&s, seller.pubkey())], &[&seller]).expect_err("seller as buyer");
    assert!(err.contains("ConstraintDuplicateMutableAccount"), "{err}");
    let sellers_second = Address::new_unique();
    h.svm.set_account(sellers_second, spl_token_account(&h.mint, &seller.pubkey(), 0)).unwrap();
    let mut s = base;
    s.buyer_tokens = sellers_second;
    let err = h.send(&[cancel_seller_ix(&s, seller.pubkey())], &[&seller]).expect_err("seller's second account as buyer");
    assert!(err.contains("ConstraintTokenOwner"), "{err}");

    // A Token-2022 account laid out like a classic one, owned by the seller.
    let t22 = Address::new_unique();
    h.svm.set_account(t22, token_account_owned_by(TOKEN_2022_PROGRAM, &h.mint, &seller.pubkey(), 0)).unwrap();
    let mut s = base;
    s.seller_tokens = t22;
    let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("Token-2022 account");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");

    // Token-2022 passed as the token program for an ending.
    let mut ix = approve_ix(&base, buyer.pubkey(), 10_000);
    ix.accounts[5].pubkey = TOKEN_2022_PROGRAM;
    let err = h.send(&[ix], &[&buyer]).expect_err("Token-2022 program");
    assert!(err.contains("InvalidProgramId"), "{err}");

    // And at create.
    let mut ix = create_ix(&h.terms(2), &h.create_accounts());
    ix.accounts[5].pubkey = TOKEN_2022_PROGRAM;
    let err = h.send(&[ix], &[&buyer]).expect_err("Token-2022 program at create");
    assert!(err.contains("InvalidProgramId") || err.contains("ConstraintAssociated") || err.contains("AccountOwnedByWrongProgram"), "{err}");

    assert_eq!(h.vault_balance(&escrow), 1_500_000, "nothing moved");
    println!("rejected as expected: wrong mint, the seller in the buyer's slot, a Token-2022 account, Token-2022 as the program");
}

#[test]
fn substitution_an_escrow_shaped_account_owned_by_another_program_is_refused() {
    // The registry's program id, or any program's: an account laid out exactly like an escrow,
    // with the attacker as seller, owned by something other than the escrow program.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let stranger = Keypair::new();
    let escrow = h.funded(&h.terms(1));
    let mut data = h.account(&escrow).data;
    data[8 + 41..8 + 73].copy_from_slice(stranger.pubkey().as_ref()); // seller
    let registry = solana_address::address!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");
    for owner in [registry, solana_system_interface::program::ID, TOKEN_PROGRAM] {
        let forged = Address::new_unique();
        h.svm
            .set_account(forged, Account { lamports: 10_000_000, data: data.clone(), owner, executable: false, rent_epoch: 0 })
            .unwrap();
        let mut s = h.settle_accounts(&escrow);
        s.escrow = forged;
        let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("forged escrow");
        assert!(err.contains("AccountOwnedByWrongProgram"), "{owner}: {err}");
    }
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("rejected as expected: an escrow's bytes under three other owners");
}

// ---------------------------------------------------------------------------------------------
// 2. Signers
// ---------------------------------------------------------------------------------------------

#[test]
fn signers_the_rent_payer_must_sign_create_and_agree_keys_cannot_be_swapped() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();

    // A sponsor named as rent payer who did not sign: the buyer spending someone else's SOL.
    let sponsor = Keypair::new();
    h.svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: sponsor.pubkey(), mint: h.mint };
    let mut ix = create_ix(&h.terms(1), &a);
    ix.accounts[3].is_signer = false;
    let err = h.send(&[ix], &[&buyer]).expect_err("unsigned rent payer");
    assert!(err.contains("AccountNotSigner"), "{err}");

    let mut t = h.terms(2);
    t.arbiter = Some(arbiter.pubkey());
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    // Buyer and seller swapped in their slots.
    let err = h.send(&[agree_ix(&s, seller.pubkey(), buyer.pubkey(), 10_000)], &[&buyer, &seller]).expect_err("swapped");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    // The arbiter signing in the seller's slot.
    let err = h.send(&[agree_ix(&s, buyer.pubkey(), arbiter.pubkey(), 10_000)], &[&buyer, &arbiter]).expect_err("arbiter as seller");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("rejected as expected: an unsigned rent payer, swapped parties, the arbiter as seller");
}

// ---------------------------------------------------------------------------------------------
// 3. Re-initialisation and addresses
// ---------------------------------------------------------------------------------------------

#[test]
fn reinit_create_on_an_open_escrow_is_refused() {
    let mut h = Harness::new();
    let escrow = h.funded(&h.terms(1));
    let mut t = h.terms(1);
    t.seller = Keypair::new().pubkey(); // same address, new terms
    t.amount = 1;
    let err = h.create(&t).expect_err("must be refused");
    assert!(err.contains("already in use"), "{err}");
    let e = h.escrow(&escrow);
    assert_eq!((e.seller, e.amount), (h.seller.pubkey(), AMOUNT), "the terms stand");
    println!("rejected as expected: create over a live escrow");
}

#[test]
fn reinit_an_ended_escrows_address_never_holds_a_second_deal() {
    // Session 10's finding 7: the address was ["escrow", buyer, id], and the same buyer reusing an
    // id after the escrow closed got the same address for a new deal, even inside the transaction
    // that ended the first. The escrow account is no longer closed when a funded escrow ends, so
    // the address is taken for good: the deal id is single-use.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let s = h.settle_accounts(&escrow);
    let other_seller = Keypair::new();
    let mut t2 = h.terms(1);
    t2.seller = other_seller.pubkey();
    let err = h
        .send(&[approve_ix(&s, buyer.pubkey(), 10_000), create_ix(&t2, &h.create_accounts())], &[&buyer])
        .expect_err("end and reopen in one transaction");
    assert!(err.contains("already in use"), "{err}");
    h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("the ending alone");
    let err = h.create(&t2).expect_err("reopen later");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.escrow(&escrow).seller, h.seller.pubkey(), "the receipt still names the first deal's seller");
    println!("rejected as expected: an ended escrow's address never holds a second deal, in the same transaction or later");
}

// ---------------------------------------------------------------------------------------------
// 4. Arithmetic
// ---------------------------------------------------------------------------------------------

#[test]
fn arithmetic_a_cancellation_refund_is_never_below_the_steps_percent() {
    // The README's sealed rule: the seller's share rounds down, "in every split and in a
    // cancellation's remainder", so the buyer gets at least the step's percent of the amount.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    for (id, amount, refund_bps) in [(1u64, 3u64, 5_000u16), (2, 1, 9_999), (3, 7, 3_333), (4, 999_999, 1), (5, 101, 50)] {
        let mut t = h.terms(id);
        t.amount = amount;
        t.steps = vec![step(DAY, refund_bps)];
        let escrow = h.funded(&t);
        let s = h.settle_accounts(&escrow);
        let meta = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("cancel");
        let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
        assert_eq!(to_seller + to_buyer, balance);
        // Buyer's refund × 10,000 ≥ amount × refund_bps, in integers.
        assert!(
            u128::from(to_buyer) * 10_000 >= u128::from(amount) * u128::from(refund_bps),
            "amount {amount} at {refund_bps} bps: the buyer got {to_buyer}, below the step's percent"
        );
        assert_eq!(to_seller, share(amount, BPS - refund_bps), "the seller's share rounds down");
    }
    println!("rejected as expected: no cancellation pays the buyer less than the step's percent");
}

#[test]
fn arithmetic_splits_at_the_edges_add_up_and_never_overflow() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    // One base unit, split every way.
    for (id, bps) in [(1u64, 1u16), (2, 5_000), (3, 9_999), (4, 10_000), (5, 0)] {
        let mut t = h.terms(id);
        t.amount = 1;
        let escrow = h.funded(&t);
        let s = h.settle_accounts(&escrow);
        let meta = h.send(&[approve_ix(&s, buyer.pubkey(), bps)], &[&buyer]).expect("approve");
        let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
        assert_eq!((balance, to_seller + to_buyer), (1, 1));
        assert_eq!(to_seller, share(1, bps));
    }

    // The largest amount a u64 holds, in a fresh buyer's hands.
    let (big, big_tokens) = new_buyer(&mut h, u64::MAX);
    for (id, how) in [(10u64, "approve"), (11, "agree"), (12, "cancel_buyer")] {
        h.svm.set_account(big_tokens, spl_token_account(&h.mint, &big.pubkey(), u64::MAX)).unwrap();
        h.svm.set_account(h.seller_tokens, spl_token_account(&h.mint, &seller.pubkey(), 0)).unwrap();
        let mut t = h.terms(id);
        t.amount = u64::MAX;
        t.steps = vec![step(DAY, 3_333)];
        let a = CreateAccounts { buyer: big.pubkey(), payer: h.payer.pubkey(), mint: h.mint };
        h.send(&[create_ix(&t, &a)], &[&big]).expect("create");
        let escrow = escrow_address(&big.pubkey(), id);
        let vault = vault_address(&escrow, &h.mint);
        h.send(&[spl_transfer_ix(big_tokens, vault, big.pubkey(), u64::MAX), accept_ix(escrow, vault, seller.pubkey())], &[&big, &seller])
            .expect("fund, and the seller accepts");
        let s = SettleAccounts { escrow, vault, buyer_tokens: big_tokens, seller_tokens: h.seller_tokens, rent_payer: h.payer.pubkey() };
        let ix = match how {
            "approve" => approve_ix(&s, big.pubkey(), 7_777),
            "agree" => agree_ix(&s, big.pubkey(), seller.pubkey(), 1),
            _ => cancel_buyer_ix(&s, big.pubkey()),
        };
        let signers: Vec<&Keypair> = if how == "agree" { vec![&big, &seller] } else { vec![&big] };
        let meta = h.send(&[ix], &signers).unwrap_or_else(|e| panic!("{how}: {e}"));
        let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
        assert_eq!(balance, u64::MAX);
        assert_eq!(u128::from(to_seller) + u128::from(to_buyer), u128::from(u64::MAX), "{how}");
        assert_eq!(h.balance(&h.seller_tokens), to_seller, "{how}");
        assert_eq!(h.balance(&big_tokens), to_buyer, "{how}");
    }
    println!("rejected as expected: no overflow or lost unit at 1 or at u64::MAX, for approve, agree and cancel");
}

// ---------------------------------------------------------------------------------------------
// 5. Clocks and boundaries
// ---------------------------------------------------------------------------------------------

#[test]
fn clock_a_past_service_time_no_longer_releases_the_moment_the_money_lands() {
    // Session 10: a service time already past, with funding that arrived after the silence it
    // started, released in the same second. The clock now never starts before the seller accepts,
    // and starts at the acceptance if the service time is already behind it.
    let mut h = Harness::new();
    let mut t = h.terms(1);
    t.service_time = Some(T0 - 30 * DAY);
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, AMOUNT);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("not accepted");
    assert!(err.contains("NotAccepted"), "{err}");
    h.accept(&escrow).expect("accept");
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("silence from acceptance");
    assert!(err.contains("SilenceNotOver"), "{err}");
    println!("rejected as expected: a past service time counts from the acceptance, so silence runs its full length");
}

#[test]
fn finding_an_invoice_with_a_service_time_releases_as_soon_as_late_money_lands() {
    // What is left of it: a service time is the clock start whether or not the money has arrived,
    // as designed. An invoice is accepted at creation, so an invoice whose service time and silence
    // are both behind it by the time the buyer pays releases in the same second the money lands.
    // The buyer's app must not pay such an escrow; the client's `checkTerms` refuses it.
    let mut h = Harness::new();
    let mut t = h.terms(1);
    t.service_time = Some(T0 + DAY);
    let (escrow, _) = h.invoice(&t).expect("invoice");
    let s = h.settle_accounts(&escrow);
    h.set_time(T0 + 9 * DAY);
    h.fund(&escrow, AMOUNT);
    let meta = h.send(&[release_by_silence_ix(&s)], &[]).expect("accepted: released at once");
    assert_eq!(ended(&events(&meta.logs)).0, Outcome::ReleasedBySilence);
    println!("FINDING (client): an invoice paid after its service time plus silence releases at once; the buyer's app must check first");
}

#[test]
fn finding_steps_that_outlast_silence_race_the_seller() {
    // Silence seven days, but a full refund until day ten. From day seven and a second, both the
    // seller's release and the buyer's full cancellation are valid; whichever lands first wins.
    for buyer_first in [true, false] {
        let mut h = Harness::new();
        let buyer = h.buyer.insecure_clone();
        let mut t = h.terms(1);
        t.steps = vec![step(10 * DAY, 10_000)];
        let escrow = h.funded(&t);
        let s = h.settle_accounts(&escrow);
        h.set_time(T0 + 7 * DAY + 1);
        let meta = if buyer_first {
            h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("accepted: cancel after silence")
        } else {
            h.send(&[release_by_silence_ix(&s)], &[]).expect("accepted: release during a refund step")
        };
        let (outcome, ..) = ended(&events(&meta.logs));
        assert_eq!(outcome, if buyer_first { Outcome::CancelledByBuyer } else { Outcome::ReleasedBySilence });
    }
    println!("FINDING (for Carlos): the program accepts steps past silence, and then both endings are live");
}

#[test]
fn finding_a_service_time_at_the_end_of_time_blocks_silence_and_objection() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let mut t = h.terms(1);
    t.service_time = Some(i64::MAX);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    h.set_time(T0 + 10_000 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("silence overflows");
    assert!(err.contains("TimeOverflow"), "{err}");
    let err = h.send(&[object_ix(escrow, vault, buyer.pubkey())], &[&buyer]).expect_err("object overflows");
    assert!(err.contains("TimeOverflow"), "{err}");
    let err = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("cancel overflows");
    assert!(err.contains("TimeOverflow"), "{err}");
    // The money is not stuck: approve, agree, the arbiter and the seller's cancel still end it.
    h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve still works");
    println!("FINDING (nuisance, client): a service time of i64::MAX means silence never comes; approve still ends it");
}

// ---------------------------------------------------------------------------------------------
// 6. Replays and double spends
// ---------------------------------------------------------------------------------------------

#[test]
fn double_spend_two_endings_in_one_transaction_fail_together() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let s = h.settle_accounts(&escrow);
    for (first, second, signers) in [
        (approve_ix(&s, buyer.pubkey(), 10_000), cancel_seller_ix(&s, seller.pubkey()), vec![&buyer, &seller]),
        (cancel_seller_ix(&s, seller.pubkey()), approve_ix(&s, buyer.pubkey(), 10_000), vec![&seller, &buyer]),
        (approve_ix(&s, buyer.pubkey(), 10_000), approve_ix(&s, buyer.pubkey(), 0), vec![&buyer]),
    ] {
        let err = h.send(&[first, second], &signers).expect_err("the second ending must fail");
        assert!(err.contains("AccountNotInitialized") || err.contains("Ended"), "{err}");
    }
    assert!(h.exists(&escrow));
    assert_eq!(h.vault_balance(&escrow), AMOUNT, "the failed transactions moved nothing");
    println!("rejected as expected: two endings in one transaction revert together");
}

#[test]
fn double_spend_a_signed_ending_sent_twice_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    h.svm.expire_blockhash();
    let msg = Message::new(&[approve_ix(&s, buyer.pubkey(), 10_000)], Some(&h.payer.pubkey()));
    let tx = Transaction::new(&[&h.payer, &buyer], msg, h.svm.latest_blockhash());
    h.send_tx(tx.clone()).expect("first");
    // Someone pays the same address again, so a replay would have money to hit.
    h.svm.set_account(vault_address(&escrow, &h.mint), spl_token_account(&h.mint, &escrow, AMOUNT)).unwrap();
    let err = h.send_tx(tx).expect_err("replay");
    assert!(err.contains("AlreadyProcessed") || err.contains("BlockhashNotFound"), "{err}");
    // A fresh signature over the same approval: the escrow has ended.
    let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("sign again");
    assert!(err.contains("Ended"), "{err}");
    // Nor can the same id be reopened to catch it.
    let err = h.create(&t).expect_err("reopen");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.vault_balance(&escrow), AMOUNT, "the second payment is untouched");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT, "the seller was paid once");
    println!("rejected as expected: the same signed approval replayed, re-signed, and the id reopened");
}

#[test]
fn double_spend_nobody_moves_or_closes_the_deposit_account_directly() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let vault = vault_address(&escrow, &h.mint);
    let err = h.send(&[spl_transfer_ix(vault, h.buyer_tokens, buyer.pubkey(), AMOUNT)], &[&buyer]).expect_err("transfer out");
    assert!(err.contains("owner does not match") || err.contains("OwnerMismatch") || err.contains("custom program error: 0x4"), "{err}");
    let err = h.send(&[spl_close_ix(vault, buyer.pubkey(), buyer.pubkey())], &[&buyer]).expect_err("close");
    assert!(err.contains("0x4") || err.contains("0xb") || err.contains("owner"), "{err}");
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("rejected as expected: the buyer cannot pull or close the deposit account through the token program");
}

// ---------------------------------------------------------------------------------------------
// 7. Tokens
// ---------------------------------------------------------------------------------------------

#[test]
fn finding_a_self_minted_token_makes_a_receipt_that_looks_like_real_money() {
    // Any classic mint is accepted. A buyer who owns a mint can fund a billion "dollars" and
    // produce a Created and Closed pair naming any amount. Only the mint says it is worthless.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let fake = Address::new_unique();
    h.svm.set_account(fake, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
    let fake_tokens = Address::new_unique();
    h.svm.set_account(fake_tokens, spl_token_account(&fake, &buyer.pubkey(), 1_000_000_000_000_000)).unwrap();
    let seller_fake = Address::new_unique();
    h.svm.set_account(seller_fake, spl_token_account(&fake, &h.seller.pubkey(), 0)).unwrap();
    let mut t = h.terms(1);
    t.amount = 1_000_000_000_000_000;
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: h.payer.pubkey(), mint: fake };
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let vault = vault_address(&escrow, &fake);
    let s = SettleAccounts { escrow, vault, buyer_tokens: fake_tokens, seller_tokens: seller_fake, rent_payer: h.payer.pubkey() };
    let meta = h
        .send(
            &[create_ix(&t, &a), spl_transfer_ix(fake_tokens, vault, buyer.pubkey(), t.amount), approve_ix(&s, buyer.pubkey(), 10_000)],
            &[&buyer],
        )
        .expect("accepted");
    let (outcome, balance, ..) = ended(&events(&meta.logs));
    assert_eq!((outcome, balance), (Outcome::Approved, 1_000_000_000_000_000));
    println!("FINDING (index): a billion-unit receipt in a token the buyer minted; only the mint field tells");
}

#[test]
fn tokens_wrapped_sol_is_refused_at_create() {
    // Session 10's finding 2: SOL sent to a wrapped-SOL deposit account without a sync never
    // reached the buyer and left with the rent. The native mint is now refused at create, as the
    // buyer, as the seller, with or without money already at the address.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    h.svm.set_account(NATIVE_MINT, spl_mint_account(9, TOKEN_PROGRAM)).unwrap();
    let mut t = h.terms(1);
    t.amount = 100_000_000; // 0.1 SOL
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: h.payer.pubkey(), mint: NATIVE_MINT };
    let err = h.send(&[create_ix(&t, &a)], &[&buyer]).expect_err("the buyer, with the native mint");
    assert!(err.contains("NativeMint"), "{err}");
    let err = h.send(&[invoice_ix(&t, &a)], &[&seller]).expect_err("the seller, with the native mint");
    assert!(err.contains("NativeMint"), "{err}");
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let vault = vault_address(&escrow, &NATIVE_MINT);
    h.svm.set_account(vault, wsol_account(&escrow)).unwrap();
    h.send(&[sol_transfer_ix(buyer.pubkey(), vault, t.amount), sync_native_ix(vault)], &[&buyer]).expect("SOL sent first");
    let err = h.send(&[create_ix(&t, &a)], &[&buyer]).expect_err("over a funded wrapped-SOL account");
    assert!(err.contains("NativeMint"), "{err}");
    assert!(!h.exists(&escrow), "nothing written");
    println!("rejected as expected: wrapped SOL at create, from either party, even with money already there");
}

// ---------------------------------------------------------------------------------------------
// 8. Rent
// ---------------------------------------------------------------------------------------------

#[test]
fn rent_stray_sol_goes_to_the_rent_payer_only_if_the_escrow_never_held_the_amount() {
    // Someone pays the escrow's address in SOL instead of the token. It never counts as funding.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    // Never funded: close_unfunded closes the escrow account, and the stray SOL leaves with its rent.
    let (escrow, _) = h.create(&h.terms(1)).expect("create");
    h.send(&[sol_transfer_ix(buyer.pubkey(), escrow, 30_000_000)], &[&buyer]).expect("SOL to the escrow's address");
    let s = h.settle_accounts(&escrow);
    let meta = h.send(&[close_unfunded_ix(&s, seller.pubkey())], &[&seller]).expect("close");
    let Some(Event::Closed { rent_lamports, .. }) = events(&meta.logs).pop() else { panic!("no Closed") };
    assert!(rent_lamports > 30_000_000, "the rent payer got the stray SOL: {rent_lamports}");

    // Funded and ended: the escrow account is the receipt and is never closed, so SOL sent to its
    // address stays there. No instruction in the program moves lamports out of a receipt.
    let escrow2 = h.funded(&h.terms(2));
    let s2 = h.settle_accounts(&escrow2);
    h.send(&[approve_ix(&s2, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve");
    let before = h.lamports(&escrow2);
    h.send(&[sol_transfer_ix(buyer.pubkey(), escrow2, 30_000_000)], &[&buyer]).expect("SOL to a receipt");
    assert_eq!(h.lamports(&escrow2), before + 30_000_000, "locked in the receipt for good");
    println!("accepted, note: stray SOL goes to the rent payer from a never-funded escrow ({rent_lamports} lamports); at a receipt it stays forever");
}

#[test]
fn finding_a_sponsor_waits_for_the_last_deadline_and_cannot_close_a_funded_escrow_nobody_accepts() {
    // Session 10's finding 3: a buyer opens escrows on a sponsor's rent, names a seller key nobody
    // holds, and never ends them. The rent payer may now close one that never held the amount,
    // after its last deadline. Two holes stay, both for the sponsor's policy, not the program:
    // a last deadline a century away is a century's wait; and one funded with its amount, which
    // the seller never accepts, can be ended only by the buyer.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let sponsor = Keypair::new();
    h.svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
    let start = h.lamports(&sponsor.pubkey());
    let mut t = h.terms(1);
    t.seller = Address::new_unique(); // nobody's key
    t.steps = vec![step(36_500 * DAY, 10_000)]; // a century
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: sponsor.pubkey(), mint: h.mint };
    h.send(&[create_ix(&t, &a)], &[&buyer, &sponsor]).expect("create");
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let mut s = h.settle_accounts(&escrow);
    s.rent_payer = sponsor.pubkey();
    let err = h.send(&[close_unfunded_ix(&s, sponsor.pubkey())], &[&sponsor]).expect_err("a century early");
    assert!(err.contains("BeforeLastDeadline"), "{err}");
    h.set_time(T0 + 36_500 * DAY + 1);
    h.send(&[close_unfunded_ix(&s, sponsor.pubkey())], &[&sponsor]).expect("a century later");
    assert_eq!(h.lamports(&sponsor.pubkey()), start, "both rents back (the harness key pays the fees)");

    // The same, funded with the amount and never accepted: the sponsor cannot close it, ever.
    let mut t2 = h.terms(2);
    t2.seller = Address::new_unique();
    t2.amount = 1;
    t2.steps = vec![];
    h.send(&[create_ix(&t2, &a)], &[&buyer, &sponsor]).expect("create");
    let escrow2 = escrow_address(&buyer.pubkey(), 2);
    h.fund(&escrow2, 1);
    let mut s2 = h.settle_accounts(&escrow2);
    s2.rent_payer = sponsor.pubkey();
    h.set_time(T0 + 100_000 * DAY);
    let err = h.send(&[close_unfunded_ix(&s2, sponsor.pubkey())], &[&sponsor]).expect_err("funded");
    assert!(err.contains("StillFunded"), "{err}");
    let locked = h.lamports(&escrow2) + h.lamports(&vault_address(&escrow2, &h.mint));
    println!("FINDING (sponsor's money, for Carlos): {locked} lamports locked by one base unit and a seller who never accepts; a century-long step is a century's wait");
}

// ---------------------------------------------------------------------------------------------
// 9. Consent: the seller accepts before anything but a full payment happens
// ---------------------------------------------------------------------------------------------

#[test]
fn consent_a_stranger_cannot_lock_an_escrow_naming_any_seller() {
    // Session 10's finding 6: a stranger opened an escrow naming a seller who never heard of it,
    // funded it with one base unit and objected, and the seller's only way out marked the seller.
    // An objection now needs the seller's acceptance first, and the stranger can only take the
    // money back.
    let mut h = Harness::new();
    let seller = h.seller.insecure_clone();
    let (stranger, stranger_tokens) = new_buyer(&mut h, 10);
    let mut t = h.terms(1);
    t.amount = 1;
    let a = CreateAccounts { buyer: stranger.pubkey(), payer: stranger.pubkey(), mint: h.mint };
    let escrow = escrow_address(&stranger.pubkey(), 1);
    let vault = vault_address(&escrow, &h.mint);
    let err = h
        .send(
            &[create_ix(&t, &a), spl_transfer_ix(stranger_tokens, vault, stranger.pubkey(), 1), object_ix(escrow, vault, stranger.pubkey())],
            &[&stranger],
        )
        .expect_err("a lock on a seller who never accepted");
    assert!(err.contains("NotAccepted"), "{err}");
    // Nor does the seller need to do anything: it cannot cancel what it never accepted.
    h.send(&[create_ix(&t, &a), spl_transfer_ix(stranger_tokens, vault, stranger.pubkey(), 1)], &[&stranger]).expect("create and fund");
    let s = SettleAccounts { escrow, vault, buyer_tokens: stranger_tokens, seller_tokens: h.seller_tokens, rent_payer: stranger.pubkey() };
    let err = h.send(&[cancel_seller_ix(&s, seller.pubkey())], &[&seller]).expect_err("nothing to cancel");
    assert!(err.contains("NotAccepted"), "{err}");
    h.send(&[withdraw_ix(&s, stranger.pubkey())], &[&stranger]).expect("the stranger takes it back");
    println!("rejected as expected: no lock on a seller who never accepted; the stranger can only withdraw");
}

#[test]
fn finding_a_stranger_can_still_pay_any_seller_in_full_and_the_receipt_says_unaccepted() {
    // Paying in full needs nobody's consent, by decision: one base unit to a seller who did
    // nothing still makes a real Created, Approved and Ended at an address a review can point at.
    // What changed is the receipt: it says the seller never accepted, so an index can weigh it at
    // nothing.
    let mut h = Harness::new();
    let (stranger, stranger_tokens) = new_buyer(&mut h, 10);
    let mut t = h.terms(1);
    t.amount = 1;
    let a = CreateAccounts { buyer: stranger.pubkey(), payer: stranger.pubkey(), mint: h.mint };
    let escrow = escrow_address(&stranger.pubkey(), 1);
    let vault = vault_address(&escrow, &h.mint);
    let s = SettleAccounts { escrow, vault, buyer_tokens: stranger_tokens, seller_tokens: h.seller_tokens, rent_payer: stranger.pubkey() };
    let meta = h
        .send(
            &[create_ix(&t, &a), spl_transfer_ix(stranger_tokens, vault, stranger.pubkey(), 1), approve_ix(&s, stranger.pubkey(), 10_000)],
            &[&stranger],
        )
        .expect("accepted");
    let ev = events(&meta.logs);
    assert_eq!(ended(&ev).0, Outcome::Approved);
    let Some(Event::Ended { accepted_at, .. }) = ev.last().cloned() else { unreachable!() };
    assert_eq!(accepted_at, 0);
    assert_eq!(h.escrow(&escrow).accepted_at, 0, "the receipt: never accepted");
    assert_eq!(h.balance(&h.seller_tokens), 1);
    println!("FINDING (index): a receipt naming a seller who signed nothing still exists; it says accepted_at 0");
}

#[test]
fn consent_a_buyers_puppet_arbiter_decides_nothing_the_seller_did_not_accept() {
    // Session 10: the arbiter may not be the buyer's key, but nothing stops it being the buyer's
    // second key, and it gave the seller nothing. The arbiter can now act only once the seller has
    // accepted the escrow, arbiter and all; the seller's app refuses an arbiter it did not agree
    // to (the client's `checkTerms`), and then this escrow never runs.
    let mut h = Harness::new();
    let puppet = Keypair::new();
    let mut t = h.terms(1);
    t.arbiter = Some(puppet.pubkey());
    let (escrow, _) = h.create(&t).expect("create");
    h.fund(&escrow, AMOUNT);
    let s = h.settle_accounts(&escrow);
    let err = h.send(&[arbitrate_ix(&s, puppet.pubkey(), 0)], &[&puppet]).expect_err("before acceptance");
    assert!(err.contains("NotAccepted"), "{err}");
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("rejected as expected: the arbiter decides nothing until the seller accepts it");
}

// ---------------------------------------------------------------------------------------------
// 10. Across the two programs
// ---------------------------------------------------------------------------------------------

#[test]
fn pda_the_two_programs_cannot_share_an_address() {
    // Every address either program derives includes its own program id, so the same seeds under
    // the two programs land apart; and each program refuses accounts the other owns (see the
    // forged-escrow test above). Checked here for the seed strings both programs use.
    let registry = solana_address::address!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");
    let buyer = Keypair::new().pubkey();
    for seeds in [
        vec![b"escrow".to_vec(), buyer.as_ref().to_vec(), 7u64.to_le_bytes().to_vec()],
        vec![b"config".to_vec()],
        vec![b"list".to_vec(), 0u32.to_le_bytes().to_vec()],
        vec![b"code-tree".to_vec()],
        vec![b"code".to_vec(), [7u8; 32].to_vec()],
    ] {
        let s: Vec<&[u8]> = seeds.iter().map(|v| v.as_slice()).collect();
        let a = Address::find_program_address(&s, &PROGRAM_ID).0;
        let b = Address::find_program_address(&s, &registry).0;
        assert_ne!(a, b);
    }
    // Within the escrow, the seeds are fixed-length after the tag ("escrow", 32, 8), so two
    // different (buyer, id) pairs cannot concatenate to the same bytes.
    println!("rejected as expected: no seed collides across the two programs");
}

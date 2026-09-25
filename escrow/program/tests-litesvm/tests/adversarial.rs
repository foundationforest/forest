//! The escrow, attacked.
//!
//! The attacks from `docs/decisions/adversarial-review-1.md` that still apply to the escrow of
//! "Escrow" in the handoff, and the ones its options and its whole-balance rule open. A test named
//! for what should be refused asserts that it is refused. A test named `finding_…` is something
//! the program accepts by design: it asserts the acceptance, so the suite pins the behaviour the
//! README and the security checklist describe, and a later change shows up here as a failure.
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

/// SPL Token `SetAuthority`, `AccountOwner`: hand a token account to another key.
fn hand_over_ix(account: Address, owner: Address, new_owner: Address) -> Instruction {
    let mut data = vec![6u8, 2, 1];
    data.extend_from_slice(new_owner.as_ref());
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![AccountMeta::new(account, false), AccountMeta::new_readonly(owner, true)],
        data,
    }
}

/// A fresh buyer whose tokens sit at its standard account, which is also its refund address.
fn new_buyer(h: &mut Harness, tokens: u64) -> (Keypair, Address) {
    let buyer = h.someone();
    let t = refund_address(&buyer.pubkey(), &h.mint);
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
    // Release A, but hand it B's deposit account: A's rules paying out B's money.
    let s = Accounts { vault: vault_address(&b, &h.mint), ..h.accounts(&a) };
    let err = h.send(&[release_to_seller_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    let err = h.send(&[mark_funded_ix(a, s.vault)], &[]).expect_err("A marked by B's money");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    assert_eq!((h.vault_balance(&a), h.vault_balance(&b)), (AMOUNT, AMOUNT));
    println!("rejected as expected: escrow A cannot pay out, or be marked by, escrow B's deposit account");
}

#[test]
fn substitution_a_look_alike_deposit_account_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    // A token account for the right mint, held by the escrow's own address, but not the one the
    // escrow recorded: anyone can make one of these.
    let look_alike = Address::new_unique();
    h.svm.set_account(look_alike, spl_token_account(&h.mint, &escrow, 5 * AMOUNT)).unwrap();
    let s = Accounts { vault: look_alike, ..h.accounts(&escrow) };
    let err = h.send(&[release_to_seller_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintHasOne"), "{err}");

    // Nor can one be handed to create in place of the associated token account.
    let escrow2 = escrow_address(&buyer.pubkey(), 2);
    let look_alike2 = Address::new_unique();
    h.svm.set_account(look_alike2, spl_token_account(&h.mint, &escrow2, 0)).unwrap();
    let mut ix = create_ix(&h.terms(2), &h.create_accounts());
    ix.accounts[1].pubkey = look_alike2;
    let err = h.send(&[ix], &[&buyer]).expect_err("must be refused");
    assert!(err.contains("ConstraintAssociated") || err.contains("AccountNotAssociatedTokenAccount") || err.contains("2009") || err.contains("3014"), "{err}");
    assert!(!h.exists(&escrow2));
    println!("rejected as expected: a look-alike deposit account, at a way out and at create");
}

#[test]
fn substitution_payout_accounts_of_the_wrong_mint_owner_or_program_are_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let base = h.accounts(&escrow);

    // The buyer's slot, holding another mint, owned by the buyer.
    let other_mint = Address::new_unique();
    h.svm.set_account(other_mint, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
    let wrong_mint = Address::new_unique();
    h.svm.set_account(wrong_mint, spl_token_account(&other_mint, &buyer.pubkey(), 0)).unwrap();
    let err = h.send(&[release_to_buyer_ix(&Accounts { buyer_tokens: wrong_mint, ..base }, seller.pubkey())], &[&seller]).expect_err("wrong mint");
    assert!(err.contains("NotTheRefundAddress"), "{err}");

    // The seller puts its own account in the buyer's slot, to catch the buyer's share.
    let err = h
        .send(&[split_ix(&Accounts { buyer_tokens: h.seller_tokens, ..base }, buyer.pubkey(), seller.pubkey(), 5_000)], &[&buyer, &seller])
        .expect_err("the seller's account as the buyer's");
    assert!(err.contains("NotTheRefundAddress"), "{err}");

    // The seller's slot: the buyer's own account, the seller's standard one for another mint, a
    // Token-2022 look-alike. Only the seller's standard account for this mint is paid.
    let err = h.send(&[release_to_seller_ix(&Accounts { seller_tokens: h.refund(), ..base }, buyer.pubkey())], &[&buyer]).expect_err("the buyer's as the seller's");
    assert!(err.contains("NotTheSellersAccount"), "{err}");
    let sellers_other_mint = payout_address(&seller.pubkey(), &other_mint);
    h.svm.set_account(sellers_other_mint, spl_token_account(&other_mint, &seller.pubkey(), 0)).unwrap();
    let err = h.send(&[release_to_seller_ix(&Accounts { seller_tokens: sellers_other_mint, ..base }, buyer.pubkey())], &[&buyer]).expect_err("another mint");
    assert!(err.contains("NotTheSellersAccount"), "{err}");
    let t22 = Address::new_unique();
    h.svm.set_account(t22, token_account_owned_by(TOKEN_2022_PROGRAM, &h.mint, &seller.pubkey(), 0)).unwrap();
    let err = h.send(&[release_to_seller_ix(&Accounts { seller_tokens: t22, ..base }, buyer.pubkey())], &[&buyer]).expect_err("Token-2022 account");
    assert!(err.contains("NotTheSellersAccount"), "{err}");

    // Token-2022 passed as the token program, at a way out and at create.
    let mut ix = release_to_seller_ix(&base, buyer.pubkey());
    ix.accounts[4].pubkey = TOKEN_2022_PROGRAM;
    let err = h.send(&[ix], &[&buyer]).expect_err("Token-2022 program");
    assert!(err.contains("InvalidProgramId"), "{err}");
    let mut ix = create_ix(&h.terms(2), &h.create_accounts());
    ix.accounts[5].pubkey = TOKEN_2022_PROGRAM;
    let err = h.send(&[ix], &[&buyer]).expect_err("Token-2022 program at create");
    assert!(err.contains("InvalidProgramId") || err.contains("ConstraintAssociated") || err.contains("AccountOwnedByWrongProgram"), "{err}");

    assert_eq!(h.vault_balance(&escrow), AMOUNT, "nothing moved");
    println!("rejected as expected: wrong mint, the other party's account in either slot, a Token-2022 account, Token-2022 as the program");
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
    for owner in [registry, SYSTEM_PROGRAM, TOKEN_PROGRAM] {
        let forged = Address::new_unique();
        h.svm
            .set_account(forged, Account { lamports: 10_000_000, data: data.clone(), owner, executable: false, rent_epoch: 0 })
            .unwrap();
        let s = Accounts { escrow: forged, ..h.accounts(&escrow) };
        let err = h.send(&[release_to_seller_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("forged escrow");
        assert!(err.contains("AccountOwnedByWrongProgram"), "{owner}: {err}");
    }
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("rejected as expected: an escrow's bytes under three other owners");
}

// ---------------------------------------------------------------------------------------------
// 2. Signers and addresses
// ---------------------------------------------------------------------------------------------

#[test]
fn signers_whoever_fronts_the_rent_must_sign_create() {
    // A sponsor named as the payer who did not sign: the buyer spending someone else's SOL.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let sponsor = h.someone();
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: sponsor.pubkey(), mint: h.mint };
    let mut ix = create_ix(&h.terms(1), &a);
    ix.accounts[3].is_signer = false;
    let err = h.send(&[ix], &[&buyer]).expect_err("an unsigned payer");
    assert!(err.contains("AccountNotSigner"), "{err}");
    println!("rejected as expected: a payer who did not sign");
}

#[test]
fn reinit_create_on_a_live_escrow_is_refused() {
    let mut h = Harness::new();
    let escrow = h.funded(&h.terms(1));
    let t = Terms { seller: Keypair::new().pubkey(), amount: 1, timer: Some(Timer { days: 1, to: Side::Buyer }), ..h.terms(1) };
    let err = h.create(&t).expect_err("must be refused");
    assert!(err.contains("already in use"), "{err}");
    let e = h.escrow(&escrow);
    assert_eq!((e.seller, e.amount, e.timer), (h.seller.pubkey(), AMOUNT, None), "the terms stand");
    println!("rejected as expected: create over a live escrow");
}

#[test]
fn reinit_an_ended_escrows_address_never_holds_a_second_deal() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let s = h.accounts(&escrow);
    let t2 = Terms { seller: Keypair::new().pubkey(), ..h.terms(1) };
    let err = h
        .send(&[release_to_seller_ix(&s, buyer.pubkey()), create_ix(&t2, &h.create_accounts())], &[&buyer])
        .expect_err("end and reopen in one transaction");
    assert!(err.contains("already in use"), "{err}");
    h.release_to_seller(&escrow).expect("the ending alone");
    let err = h.create(&t2).expect_err("reopen later");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.escrow(&escrow).seller, h.seller.pubkey(), "the receipt still names the first deal's seller");
    println!("rejected as expected: an ended escrow's address never holds a second deal");
}

#[test]
fn nobody_can_open_the_address_a_buyer_is_about_to_use() {
    // The last version derived the address from the buyer's key and an id, and whoever opened it
    // named the seller, so anyone who saw a buyer's `create` could open that address first as an
    // invoice to itself. Carlos's first change: the address is the creator's key and an id, and
    // the creator signs `create`. The front-runner's invoice lands at its own address; the
    // buyer's one tap lands at the buyer's, untouched.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let squatter = h.someone();
    let meant = h.terms(1);
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let squat = Terms { seller: squatter.pubkey(), timer: Some(Timer { days: 1, to: Side::Seller }), ..h.terms(1) };
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: squatter.pubkey(), mint: h.mint };
    h.send(&[invoice_ix(&squat, &a)], &[&squatter]).expect("the squatter's own invoice");
    assert!(h.exists(&escrow_address(&squatter.pubkey(), 1)));
    assert!(!h.exists(&escrow));

    // The buyer's one tap, the deposit address made first, lands at the buyer's address.
    let s = h.accounts(&escrow);
    h.send(
        &[
            create_ata_idempotent_ix(h.payer.pubkey(), escrow, h.mint).0,
            create_ix(&meant, &h.create_accounts()),
            spl_transfer_ix(h.buyer_tokens, s.vault, buyer.pubkey(), AMOUNT),
            release_to_seller_ix(&s, buyer.pubkey()),
        ],
        &[&buyer],
    )
    .expect("the buyer's one tap");
    let e = h.escrow(&escrow);
    assert_eq!((e.seller, e.creator, e.timer), (h.seller.pubkey(), Side::Buyer, None), "the buyer's own terms");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT, "the seller the buyer meant is paid");
    println!("rejected as expected: a front-runner lands at its own address; the buyer's one tap is untouched");
}

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
        assert_ne!(Address::find_program_address(&s, &PROGRAM_ID).0, Address::find_program_address(&s, &registry).0);
    }
    // Within the escrow, the seeds are fixed-length after the tag ("escrow", 32, 8), so two
    // different (buyer, id) pairs cannot concatenate to the same bytes.
    println!("rejected as expected: no seed collides across the two programs");
}

// ---------------------------------------------------------------------------------------------
// 3. Arithmetic
// ---------------------------------------------------------------------------------------------

#[test]
fn arithmetic_splits_at_the_edges_add_up_and_never_overflow() {
    let mut h = Harness::new();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();

    // One base unit, split every way.
    for (id, bps) in [(1u64, 1u16), (2, 5_000), (3, 9_999), (4, 10_000), (5, 0)] {
        let escrow = h.funded(&Terms { amount: 1, ..h.terms(id) });
        let meta = h.split(&escrow, bps).expect("split");
        let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
        assert_eq!((balance, to_seller + to_buyer, to_seller), (1, 1, share(1, bps)));
    }

    // The largest balance a u64 holds, in a fresh buyer's hands, through every way out that divides
    // or moves it whole.
    let (big, big_tokens) = new_buyer(&mut h, u64::MAX);
    for (id, how) in [(10u64, "split"), (11, "arbitrate"), (12, "release_to_seller"), (13, "timer_release")] {
        h.svm.set_account(big_tokens, spl_token_account(&h.mint, &big.pubkey(), u64::MAX)).unwrap();
        h.svm.set_account(h.seller_tokens, spl_token_account(&h.mint, &seller.pubkey(), 0)).unwrap();
        let t = Terms {
            amount: u64::MAX,
            arbiter: Some(arbiter.pubkey()),
            timer: Some(Timer { days: 1, to: Side::Seller }),
            ..h.terms(id)
        };
        let a = CreateAccounts { buyer: big.pubkey(), payer: h.payer.pubkey(), mint: h.mint };
        let escrow = escrow_address(&big.pubkey(), id);
        let vault = vault_address(&escrow, &h.mint);
        h.send(&[create_ix(&t, &a), spl_transfer_ix(big_tokens, vault, big.pubkey(), u64::MAX), mark_funded_ix(escrow, vault)], &[&big])
            .expect("create, fund and mark");
        let s = Accounts { escrow, vault, buyer_tokens: big_tokens, seller_tokens: h.seller_tokens, rent_recipient: big.pubkey() };
        let (ix, signers): (Instruction, Vec<&Keypair>) = match how {
            "split" => (split_ix(&s, big.pubkey(), seller.pubkey(), 7_777), vec![&big, &seller]),
            "arbitrate" => (arbitrate_ix(&s, arbiter.pubkey(), 1), vec![&arbiter]),
            "release_to_seller" => (release_to_seller_ix(&s, big.pubkey()), vec![&big]),
            _ => {
                h.advance(DAY);
                (timer_release_ix(escrow, vault, h.seller_tokens, big.pubkey()), vec![])
            }
        };
        let meta = h.send(&[ix], &signers).unwrap_or_else(|e| panic!("{how}: {e}"));
        let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
        assert_eq!(balance, u64::MAX, "{how}");
        assert_eq!(u128::from(to_seller) + u128::from(to_buyer), u128::from(u64::MAX), "{how}");
        assert_eq!(h.balance(&h.seller_tokens), to_seller, "{how}");
        assert_eq!(h.balance(&big_tokens), to_buyer, "{how}");
    }
    println!("rejected as expected: no overflow or lost unit at 1 or at u64::MAX, for split, arbitrate, release and the timer");
}

// ---------------------------------------------------------------------------------------------
// 4. The timer
// ---------------------------------------------------------------------------------------------

#[test]
fn timer_the_mark_cannot_be_back_dated_or_made_before_the_money() {
    // The timer counts from the mark, and the mark is the moment `mark_funded` runs, with the
    // amount there. The side the timer favours marks as soon as the money lands; the other side
    // cannot delay it past that, and nobody can make it earlier.
    let mut h = Harness::new();
    let t = Terms { timer: Some(Timer { days: 2, to: Side::Seller }), ..h.terms(1) };
    let (escrow, _) = h.create(&t).expect("create");
    let err = h.mark_funded(&escrow).expect_err("before the money");
    assert!(err.contains("NotFunded"), "{err}");
    h.advance(5 * DAY);
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("the seller marks at once");
    assert_eq!(h.escrow(&escrow).funded_at, T0 + 5 * DAY, "the mark is now, not the creation");
    h.advance(2 * DAY - 1);
    let err = h.timer_release(&escrow, Side::Seller).expect_err("a second early");
    assert!(err.contains("TimerNotDue"), "{err}");
    println!("rejected as expected: the timer counts from a mark made with the money there, no earlier");
}

#[test]
fn finding_an_invoice_with_a_short_timer_to_the_seller_pays_the_seller_whatever_the_buyer_thinks() {
    // An option the creator sets and the other side accepts by paying or working. The seller
    // invoices with a one-day timer to itself; a buyer who pays without looking cannot stop it:
    // the buyer's only way out alone is to give. The buyer's app shows it before paying (the
    // client's `optionsNotAgreed`).
    let mut h = Harness::new();
    let t = Terms { timer: Some(Timer { days: 1, to: Side::Seller }), ..h.terms(1) };
    let (escrow, _) = h.invoice(&t).expect("invoice");
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("the seller marks");
    h.advance(DAY);
    h.timer_release(&escrow, Side::Seller).expect("accepted");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    println!("FINDING (app): a timer the buyer did not set pays the seller a day after funding; the app must show it before paying");
}

#[test]
fn finding_a_buyers_short_timer_to_itself_takes_back_money_the_seller_worked_for() {
    // The mirror: the buyer opens an escrow with a one-day timer to itself, pays, and the seller
    // works without looking. A day later anyone sends everything back. The seller's app shows the
    // timer before the seller works.
    let mut h = Harness::new();
    let t = Terms { timer: Some(Timer { days: 1, to: Side::Buyer }), ..h.terms(1) };
    let escrow = h.marked(&t);
    h.advance(DAY);
    h.timer_release(&escrow, Side::Buyer).expect("accepted");
    assert_eq!(h.buyer_total(), BUYER_START);
    println!("FINDING (app): a timer the seller did not set returns everything to the buyer; the app must show it before working");
}

#[test]
fn timer_whoever_sends_the_sellers_timer_can_pay_only_its_standard_account() {
    // Anyone sends a due timer. The last version paid the seller at any token account it held, so
    // the sender chose which: one the seller's wallet might not show. Carlos's second change: the
    // seller, like the buyer, is paid only at its standard token account for the mint.
    let mut h = Harness::new();
    let seller = h.seller.insecure_clone();
    let t = Terms { timer: Some(Timer { days: 1, to: Side::Seller }), ..h.terms(1) };
    let escrow = h.marked(&t);
    h.advance(DAY);
    // Anyone can make a token account held by the seller: here, a stranger does, and aims at it.
    let obscure = Address::new_unique();
    h.svm.set_account(obscure, spl_token_account(&h.mint, &seller.pubkey(), 0)).unwrap();
    let stranger = h.someone();
    let vault = vault_address(&escrow, &h.mint);
    let send_as_stranger = |h: &mut Harness, to: Address| {
        let ix = timer_release_ix(escrow, vault, to, h.buyer.pubkey());
        h.svm.expire_blockhash();
        let tx = Transaction::new(&[&stranger], Message::new(&[ix], Some(&stranger.pubkey())), h.svm.latest_blockhash());
        h.send_tx(tx)
    };
    let err = send_as_stranger(&mut h, obscure).expect_err("an account the seller holds, not its standard one");
    assert!(err.contains("NotTheSellersAccount"), "{err}");
    assert_eq!(h.balance(&obscure), 0);
    let standard = h.seller_tokens;
    send_as_stranger(&mut h, standard).expect("the stranger sends it, to the seller's standard account");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    println!("rejected as expected: the timer's sender cannot choose which of the seller's accounts is paid");
}

// ---------------------------------------------------------------------------------------------
// 5. The whole balance
// ---------------------------------------------------------------------------------------------

#[test]
fn finding_an_overpayment_goes_wherever_the_way_out_sends_the_balance() {
    // Carlos's rule: every way out pays out the whole balance, whatever it is. A second payment
    // made before the end, by mistake or by a second tap on a link, is part of the balance, and
    // `release_to_seller` sends it to the seller. The client's pay link asks only for what is
    // missing and refuses once the amount is there.
    let mut h = Harness::new();
    let escrow = h.funded(&h.terms(1));
    h.fund(&escrow, AMOUNT);
    let meta = h.release_to_seller(&escrow).expect("accepted");
    let (_, balance, to_seller, to_buyer, _) = ended(&events(&meta.logs));
    assert_eq!((balance, to_seller, to_buyer), (2 * AMOUNT, 2 * AMOUNT, 0));
    println!("FINDING (app): a double payment before the end went to the seller with the rest; only the seller can give it back");
}

#[test]
fn finding_a_part_payment_can_be_closed_under_the_buyer_by_the_seller() {
    // `close_unfunded` runs at any time while the balance is below the amount, by either party. A
    // buyer paying in two transfers can find the escrow closed between them:
    // the first part comes back, and the second, sent to the closed address, lands only if the
    // wallet makes the deposit account again. Then there is no receipt to recover it through; the
    // buyer reopening the same id adopts it.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    h.fund(&escrow, AMOUNT / 2);
    h.close_unfunded(&escrow, &seller).expect("the seller closes between the two parts");
    assert_eq!(h.balance(&h.refund()), AMOUNT / 2, "the first part back");
    let (make, vault) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    h.send(&[make, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT / 2)], &[&buyer]).expect("the second part");
    let err = h.recover_late(&escrow, &buyer).expect_err("no receipt");
    assert!(err.contains("AccountNotInitialized"), "{err}");
    h.create(&t).expect("the buyer reopens the id");
    h.close_unfunded(&escrow, &buyer).expect("and closes it");
    assert_eq!(h.buyer_total(), BUYER_START, "every unit back");
    println!("FINDING (app): a part payment can be closed under the buyer; pay in one transfer, or reopen the id to recover");
}

#[test]
fn finding_a_frozen_buyer_account_blocks_only_the_ways_out_that_pay_the_buyer() {
    // A classic mint's freeze authority can freeze the buyer's standard account. Every way out
    // that pays the buyer anything then fails until it is thawed; the ones that pay the buyer
    // nothing still run, since they do not touch it.
    let mut h = Harness::new();
    let arbiter = h.arbiter.insecure_clone();
    let t = Terms { arbiter: Some(arbiter.pubkey()), ..h.terms(1) };
    let escrow = h.funded(&t);
    let refund = h.refund();
    let mut frozen = h.account(&refund);
    frozen.data[108] = 2; // AccountState::Frozen
    h.svm.set_account(refund, frozen).unwrap();
    let err = h.release_to_buyer(&escrow).expect_err("frozen");
    assert!(err.contains("0x11") || err.contains("frozen") || err.contains("Frozen"), "{err}");
    let err = h.arbitrate(&escrow, 5_000).expect_err("frozen");
    assert!(err.contains("0x11") || err.contains("frozen") || err.contains("Frozen"), "{err}");
    h.arbitrate(&escrow, 10_000).expect("everything to the seller does not touch the buyer's account");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    println!("FINDING (token): a frozen buyer account blocks every way out that pays the buyer, and nothing else");
}

// ---------------------------------------------------------------------------------------------
// 6. Replays and double spends
// ---------------------------------------------------------------------------------------------

#[test]
fn double_spend_a_signed_way_out_sent_twice_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.accounts(&escrow);
    h.svm.expire_blockhash();
    let msg = Message::new(&[release_to_seller_ix(&s, buyer.pubkey())], Some(&h.payer.pubkey()));
    let tx = Transaction::new(&[&h.payer, &buyer], msg, h.svm.latest_blockhash());
    h.svm.send_transaction(tx.clone()).expect("first");
    // Someone pays the same address again, so a replay would have money to hit.
    h.svm.set_account(s.vault, spl_token_account(&h.mint, &escrow, AMOUNT)).unwrap();
    let err = h.svm.send_transaction(tx).expect_err("replay");
    assert!(format!("{:?}", err.err).contains("AlreadyProcessed"), "{:?}", err.err);
    // A fresh signature over the same release: the escrow has ended.
    let err = h.send(&[release_to_seller_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("sign again");
    assert!(err.contains("Ended"), "{err}");
    let err = h.create(&t).expect_err("reopen");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.vault_balance(&escrow), AMOUNT, "the second payment is untouched");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT, "the seller was paid once");
    println!("rejected as expected: the same signed release replayed, re-signed, and the id reopened");
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
    // produce a Created and Ended pair naming any amount. Only the mint says it is worthless.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let fake = Address::new_unique();
    h.svm.set_account(fake, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
    let fake_tokens = refund_address(&buyer.pubkey(), &fake);
    h.svm.set_account(fake_tokens, spl_token_account(&fake, &buyer.pubkey(), 1_000_000_000_000_000)).unwrap();
    let seller_fake = payout_address(&h.seller.pubkey(), &fake);
    h.svm.set_account(seller_fake, spl_token_account(&fake, &h.seller.pubkey(), 0)).unwrap();
    let t = Terms { amount: 1_000_000_000_000_000, ..h.terms(1) };
    let a = CreateAccounts { buyer: buyer.pubkey(), payer: h.payer.pubkey(), mint: fake };
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let vault = vault_address(&escrow, &fake);
    let s = Accounts { escrow, vault, buyer_tokens: fake_tokens, seller_tokens: seller_fake, rent_recipient: buyer.pubkey() };
    let meta = h
        .send(&[create_ix(&t, &a), spl_transfer_ix(fake_tokens, vault, buyer.pubkey(), t.amount), release_to_seller_ix(&s, buyer.pubkey())], &[&buyer])
        .expect("accepted");
    let (outcome, balance, ..) = ended(&events(&meta.logs));
    assert_eq!((outcome, balance), (Outcome::ReleasedToSeller, 1_000_000_000_000_000));
    println!("FINDING (index): a billion-unit receipt in a token the buyer minted; only the mint field tells");
}

#[test]
fn tokens_wrapped_sol_is_refused_at_create() {
    // SOL sent to a wrapped-SOL deposit account without a sync would never count and would leave
    // with the rent. The native mint is refused at create, as the buyer, as the seller, with or
    // without money already at the address.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    h.svm.set_account(NATIVE_MINT, spl_mint_account(9, TOKEN_PROGRAM)).unwrap();
    let t = Terms { amount: 100_000_000, ..h.terms(1) }; // 0.1 SOL
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
// 8. Rent, late money and the sweep
// ---------------------------------------------------------------------------------------------

#[test]
fn rent_stray_sol_goes_to_the_rent_recipient() {
    // Someone pays the escrow's address in SOL instead of the token. It never counts as funding.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    // Never funded: close_unfunded closes the escrow account, and the stray SOL leaves with its
    // rent, to the rent recipient: the creator, here the buyer.
    let (escrow, _) = h.create(&h.terms(1)).expect("create");
    h.send(&[sol_transfer_ix(seller.pubkey(), escrow, 30_000_000)], &[&seller]).expect("SOL to the escrow's address");
    let buyer_sol = h.lamports(&buyer.pubkey());
    let meta = h.close_unfunded(&escrow, &seller).expect("close");
    let Some(Event::Closed { rent_lamports, rent_recipient, .. }) = events(&meta.logs).pop() else { panic!("no Closed") };
    assert!(rent_lamports > 30_000_000, "the stray SOL went with the rents: {rent_lamports}");
    assert_eq!(rent_recipient, buyer.pubkey());
    assert_eq!(h.lamports(&buyer.pubkey()), buyer_sol + rent_lamports);

    // Ended: the receipt is never closed; `sweep_rent` moves what is above the minimum, the stray
    // SOL included, to the rent recipient. The program cannot tell stray SOL from rent.
    let escrow2 = h.funded(&h.terms(2));
    h.release_to_seller(&escrow2).expect("release");
    let before = h.lamports(&escrow2);
    h.send(&[sol_transfer_ix(seller.pubkey(), escrow2, 30_000_000)], &[&seller]).expect("SOL to a receipt");
    let buyer_sol = h.lamports(&buyer.pubkey());
    h.sweep(&escrow2).expect("sweep");
    assert_eq!(h.lamports(&escrow2), before, "back to its minimum");
    assert_eq!(h.lamports(&buyer.pubkey()), buyer_sol + 30_000_000, "the stray SOL went to the creator");
    println!("accepted, note: stray SOL goes to the creator, from a never-funded escrow at close ({rent_lamports} lamports) and from a receipt by sweep_rent");
}

/// Released, then paid again at the old address: the state `recover_late` is for.
fn ended_and_paid_again(h: &mut Harness, id: u64, late: u64) -> Address {
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(id));
    h.release_to_seller(&escrow).expect("release");
    let (make, vault) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    h.send(&[make, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), late)], &[&buyer]).expect("paid again");
    escrow
}

#[test]
fn late_money_goes_only_to_the_buyers_standard_account_and_only_after_the_end() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let thief = h.someone();

    // A live escrow's money is not late: it is the deal's.
    let live = h.funded(&h.terms(1));
    let live_vault = vault_address(&live, &h.mint);
    let err = h.send(&[recover_late_ix(live, live_vault, buyer.pubkey(), h.mint, thief.pubkey())], &[&thief]).expect_err("live");
    assert!(err.contains("NotEnded"), "{err}");

    let escrow = ended_and_paid_again(&mut h, 2, 300_000);
    let vault = vault_address(&escrow, &h.mint);
    let (thief_ata_ix, thief_ata) = create_ata_idempotent_ix(thief.pubkey(), thief.pubkey(), h.mint);
    h.send(&[thief_ata_ix], &[&thief]).expect("the thief's own token account");
    let (seller_ata_ix, seller_ata) = create_ata_idempotent_ix(seller.pubkey(), seller.pubkey(), h.mint);
    h.send(&[seller_ata_ix], &[&seller]).expect("the seller's standard token account");
    let cases: Vec<(&str, Instruction, &str)> = vec![
        ("the thief's token account", recover_late_ix_to(escrow, vault, buyer.pubkey(), thief_ata, h.mint, thief.pubkey()), "ConstraintTokenOwner"),
        ("the seller's standard account", recover_late_ix_to(escrow, vault, buyer.pubkey(), seller_ata, h.mint, thief.pubkey()), "ConstraintTokenOwner"),
        (
            "a token account the buyer holds, not the standard one",
            recover_late_ix_to(escrow, vault, buyer.pubkey(), h.buyer_tokens, h.mint, thief.pubkey()),
            "AccountNotAssociatedTokenAccount",
        ),
        ("the thief as the buyer", recover_late_ix(escrow, vault, thief.pubkey(), h.mint, thief.pubkey()), "ConstraintHasOne"),
        ("another escrow's deposit account", recover_late_ix(escrow, live_vault, buyer.pubkey(), h.mint, thief.pubkey()), "ConstraintHasOne"),
    ];
    for (what, ix, want) in cases {
        let err = h.send(&[ix], &[&thief]).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains(want), "{what}: expected {want}, got\n{err}");
    }
    assert_eq!(h.balance(&vault), 300_000, "nothing moved");
    h.send(&[recover_late_ix(escrow, vault, buyer.pubkey(), h.mint, thief.pubkey())], &[&thief]).expect("to the buyer");
    assert_eq!(h.balance(&h.refund()), 300_000);
    assert_eq!(h.balance(&thief_ata), 0);
    println!("rejected as expected: late money goes to the buyer's standard account and nowhere else, and only after the end");
}

#[test]
fn finding_a_buyer_who_hands_its_standard_account_away_blocks_its_own_late_money() {
    // `recover_late` makes the buyer's standard account if it is missing, with Anchor's
    // create-if-missing, which also checks that the buyer still holds it. A buyer who hands that
    // account to another key blocks its own late money there until it takes the account back.
    // Nothing else: the ways out check the address alone.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = ended_and_paid_again(&mut h, 1, 1);
    let refund = h.refund();
    h.send(&[hand_over_ix(refund, buyer.pubkey(), Keypair::new().pubkey())], &[&buyer]).expect("handed away");
    let err = h.recover_late(&escrow, &buyer).expect_err("blocked");
    assert!(err.contains("ConstraintTokenOwner") || err.contains("IllegalOwner") || err.contains("InvalidAccountOwner"), "{err}");
    println!("FINDING (known limit): recover_late checks who holds the buyer's standard account; a buyer who hands it away blocks its own late money");
}

#[test]
fn a_party_who_hands_its_standard_account_away_blocks_no_way_out() {
    // The ways out check each party's account by address, not by who holds it now: a party who
    // hands its standard account to another key cannot stop the arbiter, a split, or a timer. The
    // money goes to the address, as that party arranged.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let t = Terms { arbiter: Some(h.arbiter.pubkey()), ..h.terms(1) };
    let escrow = h.funded(&t);
    let refund = h.refund();
    let elsewhere = Keypair::new().pubkey();
    h.send(&[hand_over_ix(refund, buyer.pubkey(), elsewhere)], &[&buyer]).expect("the buyer hands its account away");
    h.send(&[hand_over_ix(h.seller_tokens, seller.pubkey(), elsewhere)], &[&seller]).expect("and the seller its own");
    h.arbitrate(&escrow, 6_000).expect("the arbiter still decides");
    assert_eq!((h.balance(&h.seller_tokens), h.balance(&refund)), (600_000, 400_000));
    println!("standard accounts handed to another key block nothing: the arbiter still decides");
}

#[test]
fn a_missing_buyer_account_is_made_in_the_same_transaction_by_whoever_sends_the_way_out() {
    // A buyer may close its empty standard account. A way out that pays the buyer then needs it
    // made first, which anyone can do in the same transaction with the standard idempotent
    // instruction, at its own cost; one that pays the buyer nothing does not need it at all.
    let mut h = Harness::new();
    let seller = h.seller.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    h.drop_refund();
    let err = h.release_to_buyer(&escrow).expect_err("no buyer account");
    // The token program refuses to pay an account that does not exist.
    assert!(err.contains("InvalidAccountData"), "{err}");
    let (make, refund) = create_ata_idempotent_ix(seller.pubkey(), h.buyer.pubkey(), h.mint);
    assert_eq!(refund, h.refund());
    let s = h.accounts(&escrow);
    h.send(&[make, release_to_buyer_ix(&s, seller.pubkey())], &[&seller]).expect("made, then paid, in one transaction");
    assert_eq!(h.balance(&refund), AMOUNT);

    // A split that pays the buyer nothing runs with no buyer account at all.
    let mut h = Harness::new();
    let escrow = h.funded(&h.terms(1));
    h.drop_refund();
    h.split(&escrow, 10_000).expect("all to the seller: the buyer's account is never touched");
    assert!(!h.exists(&h.refund()));
    println!("a missing buyer account: made first in the same transaction when the buyer is paid, and not needed when it is not");
}

#[test]
fn sweep_pays_only_the_recorded_rent_recipient_and_only_from_an_escrow() {
    let mut h = Harness::new();
    let thief = Keypair::new();
    let escrow = h.funded(&h.terms(1));
    let s = h.accounts(&escrow);
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let before = h.account(&escrow);

    let err = h.send(&[sweep_rent_ix(escrow, thief.pubkey())], &[]).expect_err("to a thief");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    let err = h.send(&[sweep_rent_ix(escrow, h.payer.pubkey())], &[]).expect_err("to the key that fronted the rent");
    assert!(err.contains("ConstraintHasOne"), "{err}");
    // Something that is not an escrow: its deposit account, and an escrow-shaped account another
    // program owns.
    let err = h.send(&[sweep_rent_ix(s.vault, h.payer.pubkey())], &[]).expect_err("a token account");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");
    let forged = Address::new_unique();
    let mut fake = before.clone();
    fake.owner = TOKEN_PROGRAM;
    fake.lamports += 50_000_000;
    h.svm.set_account(forged, fake).unwrap();
    let err = h.send(&[sweep_rent_ix(forged, h.payer.pubkey())], &[]).expect_err("forged");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");
    assert_eq!(h.account(&escrow).lamports, before.lamports, "nothing moved");
    h.sweep(&escrow).expect("to the rent recipient");
    assert_eq!(h.lamports(&escrow), (128 + ESCROW_LEN as u64) * RENT_FINAL);
    println!("rejected as expected: the sweep pays only the recorded rent recipient (the creator), and only from an escrow");
}

//! The escrow, run under LiteSVM with the clock moved by hand.
//!
//! Run with `cargo test -- --nocapture` to see the measured compute units and transaction bytes.

use forest_escrow_tests::*;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// 1.00 at six decimals: the standard deal's amount.
const AMOUNT: u64 = 1_000_000;

fn zero() -> Address {
    Address::default()
}

/// The `Ended` event: outcome, balance, to the seller, to the buyer, rent returned.
fn ended(events: &[Event]) -> (Outcome, u64, u64, u64, u64) {
    let Some(Event::Ended { outcome, balance, to_seller, to_buyer, rent_lamports, .. }) =
        events.iter().find(|e| e.name() == "Ended")
    else {
        panic!("no Ended event in {events:?}")
    };
    (*outcome, *balance, *to_seller, *to_buyer, *rent_lamports)
}

fn names(events: &[Event]) -> Vec<&'static str> {
    events.iter().map(|e| e.name()).collect()
}

/// The deposit account gone, the escrow account still there as the receipt, holding what the
/// parties were paid, and the parties' balances as given.
fn assert_ended(h: &Harness, escrow: &Address, buyer_tokens: u64, seller_tokens: u64) {
    assert!(!h.exists(&vault_address(escrow, &h.mint)), "the deposit account must be closed");
    let e = h.escrow(escrow);
    assert_eq!(e.status, Status::Ended, "the escrow account stays, ended");
    assert!(e.outcome.is_some() && e.ended_at != 0, "and says how and when");
    assert_eq!(h.balance(&h.buyer_tokens), buyer_tokens, "buyer's tokens");
    assert_eq!(h.balance(&h.seller_tokens), seller_tokens, "seller's tokens");
}

// ---------------------------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------------------------

#[test]
fn create_writes_the_terms_and_makes_the_deposit_account() {
    let mut h = Harness::new();
    let mut t = h.terms(7);
    t.arbiter = Some(h.arbiter.pubkey());
    t.service_time = Some(T0 + 10 * DAY);
    t.steps = vec![step(-DAY, 10_000), step(0, 5_000), step(DAY, 2_500), step(2 * DAY, 0)];
    let (escrow, meta) = h.create(&t).expect("create");

    let e = h.escrow(&escrow);
    assert_eq!(e.version, VERSION);
    assert_eq!(e.id, 7);
    assert_eq!(e.buyer, h.buyer.pubkey());
    assert_eq!(e.seller, h.seller.pubkey());
    assert_eq!(e.arbiter, h.arbiter.pubkey());
    assert_eq!(e.mint, h.mint);
    assert_eq!(e.vault, vault_address(&escrow, &h.mint));
    assert_eq!(e.rent_payer, h.payer.pubkey());
    assert_eq!(e.amount, AMOUNT);
    assert_eq!(e.service_time, T0 + 10 * DAY);
    assert_eq!(e.silence_days, 7);
    assert_eq!(e.steps, t.steps);
    assert_eq!(e.created_at, T0);
    assert_eq!(e.funded_at, 0);
    assert_eq!(e.status, Status::Open, "opened by the buyer: the seller has yet to accept");
    assert_eq!((e.accepted_at, e.ended_at, e.outcome, e.to_seller, e.to_buyer), (0, 0, None, 0, 0));

    // The deposit account: a classic token account for the mint, owned by the escrow, empty.
    let vault = h.account(&e.vault);
    assert_eq!(vault.owner, TOKEN_PROGRAM);
    assert_eq!(&vault.data[..32], h.mint.as_ref());
    assert_eq!(&vault.data[32..64], escrow.as_ref());
    assert_eq!(token_amount(&vault.data), 0);

    let events = events(&meta.logs);
    assert_eq!(names(&events), ["Created"]);
    assert_eq!(
        events[0],
        Event::Created {
            escrow,
            version: VERSION,
            id: 7,
            buyer: h.buyer.pubkey(),
            seller: h.seller.pubkey(),
            arbiter: h.arbiter.pubkey(),
            mint: h.mint,
            vault: e.vault,
            rent_payer: h.payer.pubkey(),
            amount: AMOUNT,
            service_time: T0 + 10 * DAY,
            silence_days: 7,
            steps: t.steps.clone(),
            created_at: T0,
        }
    );
    println!("created: {} bytes of state, deposit account at {}", ESCROW_LEN, e.vault);
}

#[test]
fn money_arrives_by_plain_transfer_and_anyone_marks_it_funded() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    // Nothing there yet: nothing to observe, before the seller accepts or after.
    let err = h.mark_funded(&escrow).expect_err("empty");
    assert!(err.contains("NotFunded"), "{err}");
    h.accept(&escrow).expect("accept");
    assert_eq!(h.escrow(&escrow).status, Status::Accepted);

    // Short by one base unit: not funded.
    h.fund(&escrow, AMOUNT - 1);
    let err = h.mark_funded(&escrow).expect_err("short");
    assert!(err.contains("NotFunded"), "{err}");
    assert_eq!(h.escrow(&escrow).status, Status::Accepted);

    // One more base unit, a day later. Nobody but the fee payer signs mark_funded.
    h.advance(DAY);
    h.fund(&escrow, 1);
    let meta = h.mark_funded(&escrow).expect("mark_funded");
    let e = h.escrow(&escrow);
    assert_eq!(e.status, Status::Funded);
    assert_eq!(e.funded_at, T0 + DAY, "the clock starts when the funding is observed");
    assert_eq!(events(&meta.logs), [Event::Funded { escrow, balance: AMOUNT, funded_at: T0 + DAY }]);

    // Observed once.
    let err = h.mark_funded(&escrow).expect_err("twice");
    assert!(err.contains("AlreadyFunded"), "{err}");

    // Money that arrived before the escrow did: create adopts the account, and the seller's
    // acceptance is the observation that counts it funded.
    let t2 = h.terms(2);
    let escrow2 = escrow_address(&h.buyer.pubkey(), 2);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.svm.set_account(vault2, spl_token_account(&h.mint, &escrow2, AMOUNT + 5)).unwrap();
    let (_, meta) = h.create(&t2).expect("create over an existing deposit account");
    assert_eq!(names(&events(&meta.logs)), ["Created"]);
    assert_eq!(h.escrow(&escrow2).status, Status::Open, "held, but not accepted");
    h.advance(DAY);
    let meta = h.accept(&escrow2).expect("accept");
    assert_eq!(names(&events(&meta.logs)), ["Accepted", "Funded"]);
    let e2 = h.escrow(&escrow2);
    assert_eq!(e2.status, Status::Funded);
    assert_eq!((e2.accepted_at, e2.funded_at), (T0 + 2 * DAY, T0 + 2 * DAY));
    println!("funded by two plain transfers; a pre-funded deposit account is adopted at create and counted at acceptance");
}

#[test]
fn the_buyer_approves_all_or_a_split_and_the_excess_comes_back() {
    let mut h = Harness::new();
    let s = h.settle_accounts(&escrow_address(&h.buyer.pubkey(), 1));
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    h.fund(&escrow, 1_500_000); // half a dollar too much
    // Never marked funded: approve checks the balance itself.
    let before = h.lamports(&h.payer.pubkey());
    let buyer = h.buyer.insecure_clone();
    let meta = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve all");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["Approved", "Ended"]);
    assert_eq!(ev[0], Event::Approved { escrow, seller_bps: 10_000, to_seller: AMOUNT, to_buyer: 500_000 });
    let (outcome, balance, to_seller, to_buyer, rent) = ended(&ev);
    assert_eq!((outcome, balance, to_seller, to_buyer), (Outcome::Approved, 1_500_000, AMOUNT, 500_000));
    assert_ended(&h, &escrow, BUYER_START - 1_500_000 + 500_000, AMOUNT);
    // The rent payer got both accounts' rent back. The same key paid the transaction fee, two
    // signatures at 5,000 lamports each, which is the only other thing that moved.
    assert_eq!(h.lamports(&h.payer.pubkey()), before + rent - 2 * 5_000, "rent back, one fee paid");

    assert_eq!(h.escrow(&escrow).accepted_at, 0, "paid in full before the seller accepted: the receipt says so");

    // A split: 70% to the seller, 30% and the excess back. A split needs the seller's acceptance.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.fund(&escrow2, 1_500_000);
    let err = h.send(&[approve_ix(&s2, buyer.pubkey(), 7_000)], &[&buyer]).expect_err("a split before acceptance");
    assert!(err.contains("NotAccepted"), "{err}");
    h.accept(&escrow2).expect("accept");
    let meta = h.send(&[approve_ix(&s2, buyer.pubkey(), 7_000)], &[&buyer]).expect("approve split");
    let ev = events(&meta.logs);
    assert_eq!(ev[0], Event::Approved { escrow: escrow2, seller_bps: 7_000, to_seller: 700_000, to_buyer: 800_000 });
    assert_ended(&h, &escrow2, 9_000_000 - 1_500_000 + 800_000, 1_700_000);

    // Zero to the seller is a split too.
    let t3 = h.terms(3);
    let (escrow3, _) = h.create(&t3).expect("create");
    h.accept(&escrow3).expect("accept");
    let s3 = h.settle_accounts(&escrow3);
    h.fund(&escrow3, AMOUNT);
    let meta = h.send(&[approve_ix(&s3, buyer.pubkey(), 0)], &[&buyer]).expect("approve nothing");
    assert_eq!(ended(&events(&meta.logs)).2, 0);
    assert_ended(&h, &escrow3, 8_300_000, 1_700_000);
    println!("approve: all, 70/30 and 0/100, excess back each time, exact");
}

#[test]
fn silence_releases_to_the_seller_and_anyone_may_send_it() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let escrow = h.funded(&t); // observed funded at T0
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, 250_000); // excess arriving later is still the buyer's

    h.set_time(T0 + 7 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("on the last second");
    assert!(err.contains("SilenceNotOver"), "{err}");

    h.set_time(T0 + 7 * DAY + 1);
    let meta = h.send(&[release_by_silence_ix(&s)], &[]).expect("one second past");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["ReleasedBySilence", "Ended"]);
    assert_eq!(
        ev[0],
        Event::ReleasedBySilence { escrow, clock_start: T0, silence_ended: T0 + 7 * DAY, to_seller: AMOUNT, to_buyer: 250_000 }
    );
    assert_ended(&h, &escrow, BUYER_START - 1_250_000 + 250_000, AMOUNT);
    println!("silence: refused at exactly seven days, released one second later by a key that is nobody");
}

#[test]
fn the_clock_starts_at_the_service_time_when_one_is_set() {
    let mut h = Harness::new();
    let mut t = h.terms(1);
    t.service_time = Some(T0 + 30 * DAY);
    t.steps = vec![step(-DAY, 10_000), step(0, 5_000)]; // until a day before: all; until the start: half
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);

    // Seven days after funding is nothing: silence counts from the service time.
    h.set_time(T0 + 7 * DAY + 1);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("too early");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 37 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("still the last second");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 37 * DAY + 1);
    h.send(&[release_by_silence_ix(&s)], &[]).expect("released");
    assert_ended(&h, &escrow, BUYER_START - AMOUNT, AMOUNT);

    // The steps count from the service time too: two days before, full refund; an hour before, half.
    let buyer = h.buyer.insecure_clone();
    for (id, at, refund_bps, step_index) in [(2u64, T0 + 28 * DAY, 10_000u16, 0u8), (3, T0 + 30 * DAY - 3_600, 5_000, 1)] {
        let mut t = h.terms(id);
        t.service_time = Some(T0 + 30 * DAY);
        t.steps = vec![step(-DAY, 10_000), step(0, 5_000)];
        h.set_time(T0);
        let escrow = h.funded(&t);
        let s = h.settle_accounts(&escrow);
        h.set_time(at);
        let meta = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("cancel");
        let ev = events(&meta.logs);
        let refund = share(AMOUNT, refund_bps);
        assert_eq!(
            ev[0],
            Event::CancelledByBuyer { escrow, step: step_index, refund_bps, to_buyer: refund, to_seller: AMOUNT - refund }
        );
    }
    // Three deals: seller got 1.00 + 0 + 0.50; buyer paid 3.00 and got 1.00 + 0.50 back.
    assert_eq!(h.balance(&h.seller_tokens), 1_500_000);
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - 3 * AMOUNT + 1_500_000);
    println!("service time set: silence and both steps measured from it, not from funding");
}

#[test]
fn the_buyer_objects_and_then_both_agree() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    h.set_time(T0 + 6 * DAY);
    let meta = h.send(&[object_ix(escrow, vault, buyer.pubkey())], &[&buyer]).expect("object");
    assert_eq!(events(&meta.logs), [Event::Objected { escrow, at: T0 + 6 * DAY, silence_ends: T0 + 7 * DAY }]);
    assert_eq!(h.escrow(&escrow).status, Status::Locked);

    // Locked: silence never releases it, however long.
    h.set_time(T0 + 400 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("locked");
    assert!(err.contains("Locked"), "{err}");

    // Both sign a 40/60 split.
    let meta = h.send(&[agree_ix(&s, buyer.pubkey(), seller.pubkey(), 4_000)], &[&buyer, &seller]).expect("agree");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["Agreed", "Ended"]);
    assert_eq!(ev[0], Event::Agreed { escrow, seller_bps: 4_000, to_seller: 400_000, to_buyer: 600_000 });
    assert_eq!(ended(&ev).0, Outcome::Agreed);
    assert_ended(&h, &escrow, BUYER_START - AMOUNT + 600_000, 400_000);

    // Agreement needs no lock: a funded, unlocked escrow can be agreed too, and so can one whose
    // funding was never marked. It needs the seller's acceptance, like everything but a full
    // approval or a withdrawal.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.fund(&escrow2, AMOUNT);
    let err = h.send(&[agree_ix(&s2, buyer.pubkey(), seller.pubkey(), 10_000)], &[&buyer, &seller]).expect_err("before acceptance");
    assert!(err.contains("NotAccepted"), "{err}");
    h.accept(&escrow2).expect("accept");
    h.send(&[agree_ix(&s2, buyer.pubkey(), seller.pubkey(), 10_000)], &[&buyer, &seller]).expect("agree unlocked");
    assert_ended(&h, &escrow2, BUYER_START - 2 * AMOUNT + 600_000, 1_400_000);
    println!("objected on day six, silence refused on day 400, agreed 40/60");
}

#[test]
fn an_objection_is_also_the_first_observation_of_funding() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    h.accept(&escrow).expect("accept");
    let vault = vault_address(&escrow, &h.mint);
    let buyer = h.buyer.insecure_clone();
    h.fund(&escrow, AMOUNT);
    h.set_time(T0 + 2 * DAY);
    let meta = h.send(&[object_ix(escrow, vault, buyer.pubkey())], &[&buyer]).expect("object");
    assert_eq!(names(&events(&meta.logs)), ["Funded", "Objected"]);
    let e = h.escrow(&escrow);
    assert_eq!(e.funded_at, T0 + 2 * DAY);
    assert_eq!(e.status, Status::Locked);
    println!("object on an unmarked escrow: Funded then Objected, funded_at set");
}

#[test]
fn the_arbiter_decides_from_funded_and_from_locked() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();

    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let meta = h.send(&[arbitrate_ix(&s, arbiter.pubkey(), 2_500)], &[&arbiter]).expect("arbitrate funded");
    let ev = events(&meta.logs);
    assert_eq!(
        ev[0],
        Event::Arbitrated { escrow, arbiter: arbiter.pubkey(), seller_bps: 2_500, to_seller: 250_000, to_buyer: 750_000 }
    );
    assert_eq!(ended(&ev).0, Outcome::Arbitrated);
    assert_ended(&h, &escrow, BUYER_START - AMOUNT + 750_000, 250_000);

    let mut t2 = h.terms(2);
    t2.arbiter = Some(arbiter.pubkey());
    let escrow2 = h.funded(&t2);
    let s2 = h.settle_accounts(&escrow2);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.send(&[object_ix(escrow2, vault2, buyer.pubkey())], &[&buyer]).expect("object");
    h.send(&[arbitrate_ix(&s2, arbiter.pubkey(), 10_000)], &[&arbiter]).expect("arbitrate locked");
    assert_ended(&h, &escrow2, BUYER_START - 2 * AMOUNT + 750_000, 1_250_000);
    println!("arbitrated 25/75 while funded, then all to the seller while locked");
}

#[test]
fn the_buyer_cancels_at_each_step_with_the_steps_refund() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    // Step 0 until day one: everything back. Step 1 until day three: half.
    for (id, at, step_index, refund_bps) in [(1u64, T0 + DAY - 1, 0u8, 10_000u16), (2, T0 + DAY, 1, 5_000), (3, T0 + 3 * DAY - 1, 1, 5_000)] {
        h.set_time(T0);
        let t = h.terms(id);
        let escrow = h.funded(&t);
        let s = h.settle_accounts(&escrow);
        h.fund(&escrow, 1); // one base unit of excess, to see it come back on top of the refund
        h.set_time(at);
        let meta = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("cancel");
        let ev = events(&meta.logs);
        let refund = share(AMOUNT, refund_bps);
        assert_eq!(names(&ev), ["CancelledByBuyer", "Ended"]);
        assert_eq!(
            ev[0],
            Event::CancelledByBuyer { escrow, step: step_index, refund_bps, to_buyer: refund + 1, to_seller: AMOUNT - refund }
        );
        assert_eq!(ended(&ev).0, Outcome::CancelledByBuyer);
        assert_eq!(h.escrow(&escrow).status, Status::Ended);
    }
    // Buyer paid 3 × 1.000001 and got back 1.000001 + 0.500001 + 0.500001.
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - 3_000_003 + 2_000_003);
    assert_eq!(h.balance(&h.seller_tokens), 1_000_000);
    println!("cancelled at day 1 minus a second (all back), day 1 (half), day 3 minus a second (half)");
}

#[test]
fn the_seller_cancels_from_funded_and_from_locked_and_the_buyer_gets_everything() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, 123);
    h.set_time(T0 + 100 * DAY); // any time
    let meta = h.send(&[cancel_seller_ix(&s, seller.pubkey())], &[&seller]).expect("cancel_seller");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["CancelledBySeller", "Ended"]);
    assert_eq!(ev[0], Event::CancelledBySeller { escrow, seller: seller.pubkey(), to_buyer: AMOUNT + 123 });
    assert_eq!(ended(&ev).0, Outcome::CancelledBySeller);
    assert_ended(&h, &escrow, BUYER_START, 0);

    let t2 = h.terms(2);
    h.set_time(T0);
    let escrow2 = h.funded(&t2);
    let s2 = h.settle_accounts(&escrow2);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.send(&[object_ix(escrow2, vault2, buyer.pubkey())], &[&buyer]).expect("object");
    h.send(&[cancel_seller_ix(&s2, seller.pubkey())], &[&seller]).expect("cancel_seller while locked");
    assert_ended(&h, &escrow2, BUYER_START, 0);
    println!("seller cancelled on day 100, and again from a lock: everything back both times");
}

#[test]
fn a_never_funded_escrow_is_closed_by_either_party_any_time_or_by_the_rent_payer_after_the_last_deadline() {
    // A rent payer who is neither party: a sponsor.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let sponsor = Keypair::new();
    h.svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
    let sponsor_start = h.lamports(&sponsor.pubkey());
    let open = |h: &mut Harness, t: &Terms| -> (Address, SettleAccounts) {
        let a = CreateAccounts { buyer: buyer.pubkey(), payer: sponsor.pubkey(), mint: h.mint };
        h.send(&[create_ix(t, &a)], &[&buyer, &sponsor]).expect("create");
        let escrow = escrow_address(&buyer.pubkey(), t.id);
        let mut s = h.settle_accounts(&escrow);
        s.rent_payer = sponsor.pubkey();
        (escrow, s)
    };

    // Partly funded, closed by the seller at once: the part comes back, both accounts close,
    // both rents go back to the sponsor, and nothing is left at the address.
    let t1 = h.terms(1);
    let (escrow, s) = open(&mut h, &t1);
    h.fund(&escrow, 400_000);
    let held = h.lamports(&escrow) + h.lamports(&s.vault);
    let meta = h.send(&[close_unfunded_ix(&s, seller.pubkey())], &[&seller]).expect("seller closes");
    assert_eq!(
        events(&meta.logs),
        [Event::Closed { escrow, closed_by: seller.pubkey(), to_buyer: 400_000, rent_payer: sponsor.pubkey(), rent_lamports: held }]
    );
    assert!(!h.exists(&escrow) && !h.exists(&s.vault), "never funded: no receipt, both accounts gone");
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START);
    assert_eq!(h.lamports(&sponsor.pubkey()), sponsor_start, "both rents back");

    // The buyer, at any time too, accepted or not.
    let t2 = h.terms(2);
    let (escrow2, s2) = open(&mut h, &t2);
    h.send(&[accept_ix(escrow2, s2.vault, seller.pubkey())], &[&seller]).expect("accept");
    h.send(&[close_unfunded_ix(&s2, buyer.pubkey())], &[&buyer]).expect("buyer closes at once");
    assert!(!h.exists(&escrow2));

    // The rent payer waits for the last deadline, measured from creation when there is no service
    // time (the standard terms' last step is at three days).
    let t3 = h.terms(3);
    let (escrow3, s3) = open(&mut h, &t3);
    h.set_time(T0 + 3 * DAY);
    let err = h.send(&[close_unfunded_ix(&s3, sponsor.pubkey())], &[&sponsor]).expect_err("too soon");
    assert!(err.contains("BeforeLastDeadline"), "{err}");
    h.set_time(T0 + 3 * DAY + 1);
    h.send(&[close_unfunded_ix(&s3, sponsor.pubkey())], &[&sponsor]).expect("the rent payer closes");
    assert!(!h.exists(&escrow3));

    // With a service time, from that instead.
    let mut t4 = h.terms(4);
    t4.service_time = Some(T0 + 20 * DAY);
    t4.steps = vec![step(-DAY, 10_000)];
    h.set_time(T0);
    let (_, s4) = open(&mut h, &t4);
    h.set_time(T0 + 19 * DAY);
    let err = h.send(&[close_unfunded_ix(&s4, sponsor.pubkey())], &[&sponsor]).expect_err("too soon");
    assert!(err.contains("BeforeLastDeadline"), "{err}");
    h.set_time(T0 + 19 * DAY + 1);
    h.send(&[close_unfunded_ix(&s4, sponsor.pubkey())], &[&sponsor]).expect("the rent payer closes");

    // No steps: the rent payer closes at once.
    let mut t5 = h.terms(5);
    t5.steps = vec![];
    let (escrow5, s5) = open(&mut h, &t5);
    h.send(&[close_unfunded_ix(&s5, sponsor.pubkey())], &[&sponsor]).expect("rent payer at once");
    assert!(!h.exists(&escrow5));

    // Nobody else, ever; and nobody at all once it holds the amount.
    let t6 = h.terms(6);
    let (escrow6, s6) = open(&mut h, &t6);
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    h.set_time(T0 + 400 * DAY);
    let err = h.send(&[close_unfunded_ix(&s6, stranger.pubkey())], &[&stranger]).expect_err("a stranger");
    assert!(err.contains("NotACloser"), "{err}");
    h.fund(&escrow6, AMOUNT);
    for (who, key) in [("buyer", &buyer), ("seller", &seller), ("rent payer", &sponsor)] {
        let err = h.send(&[close_unfunded_ix(&s6, key.pubkey())], &[key]).expect_err("funded");
        assert!(err.contains("StillFunded"), "{who}: {err}");
    }
    println!("never funded: either party at once, the rent payer after the last deadline or at once with no steps; both rents back, no receipt");
}

#[test]
fn rent_returns_to_the_rent_payer_on_every_ending_and_the_escrow_account_stays() {
    // A rent payer who is not the fee payer, so its balance moves only by rent.
    let mut h = Harness::new();
    let rent_payer = Keypair::new();
    h.svm.airdrop(&rent_payer.pubkey(), 1_000_000_000).unwrap();
    let start = h.lamports(&rent_payer.pubkey());
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();

    let endings: [(&str, u64, Outcome); 8] = [
        ("approve", 1, Outcome::Approved),
        ("release_by_silence", 2, Outcome::ReleasedBySilence),
        ("agree", 3, Outcome::Agreed),
        ("arbitrate", 4, Outcome::Arbitrated),
        ("cancel_buyer", 5, Outcome::CancelledByBuyer),
        ("cancel_seller", 6, Outcome::CancelledBySeller),
        ("withdraw", 7, Outcome::Withdrawn),
        ("approve before acceptance", 8, Outcome::Approved),
    ];
    let mut kept = 0;
    for (name, id, outcome) in endings {
        h.set_time(T0);
        let mut t = h.terms(id);
        t.arbiter = Some(arbiter.pubkey());
        let a = CreateAccounts { buyer: buyer.pubkey(), payer: rent_payer.pubkey(), mint: h.mint };
        h.send(&[create_ix(&t, &a)], &[&buyer, &rent_payer]).expect("create");
        let escrow = escrow_address(&buyer.pubkey(), id);
        let vault = vault_address(&escrow, &h.mint);
        let escrow_rent = h.lamports(&escrow);
        let vault_rent = h.lamports(&vault);
        assert_eq!(h.lamports(&rent_payer.pubkey()), start - kept - escrow_rent - vault_rent, "{name}: the rent payer paid both rents");
        let mut s = h.settle_accounts(&escrow);
        s.rent_payer = rent_payer.pubkey();
        let unaccepted = name == "withdraw" || name == "approve before acceptance";
        if !unaccepted {
            h.accept(&escrow).expect("accept");
        }
        h.fund(&escrow, AMOUNT);
        if !unaccepted {
            h.mark_funded(&escrow).expect("mark_funded");
        }
        let ix = match name {
            "approve" | "approve before acceptance" => approve_ix(&s, buyer.pubkey(), 10_000),
            "release_by_silence" => {
                h.set_time(T0 + 7 * DAY + 1);
                release_by_silence_ix(&s)
            }
            "agree" => agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000),
            "arbitrate" => arbitrate_ix(&s, arbiter.pubkey(), 5_000),
            "cancel_buyer" => cancel_buyer_ix(&s, buyer.pubkey()),
            "cancel_seller" => cancel_seller_ix(&s, seller.pubkey()),
            "withdraw" => withdraw_ix(&s, buyer.pubkey()),
            _ => unreachable!(),
        };
        let signers: Vec<&Keypair> = match name {
            "approve" | "approve before acceptance" | "cancel_buyer" | "withdraw" => vec![&buyer],
            "release_by_silence" => vec![],
            "agree" => vec![&buyer, &seller],
            "arbitrate" => vec![&arbiter],
            "cancel_seller" => vec![&seller],
            _ => unreachable!(),
        };
        let meta = h.send(&[ix], &signers).unwrap_or_else(|e| panic!("{name}: {e}"));
        let ev = events(&meta.logs);
        assert_eq!(ended(&ev).0, outcome, "{name}");
        assert_eq!(ended(&ev).4, vault_rent, "{name}: the Ended event says how much rent went back: the deposit account's");
        kept += escrow_rent;
        assert_eq!(h.lamports(&rent_payer.pubkey()), start - kept, "{name}: the deposit account's rent is back; the receipt keeps its own");
        assert!(!h.exists(&vault), "{name}: the deposit account is closed");
        assert_eq!(h.lamports(&escrow), escrow_rent, "{name}: the escrow account is not");
        let e = h.escrow(&escrow);
        assert_eq!((e.status, e.outcome, e.ended_at), (Status::Ended, Some(outcome), h.now()), "{name}: the receipt");
        assert_eq!(e.to_seller + e.to_buyer, AMOUNT, "{name}: the receipt's amounts add up");
        assert_eq!(e.accepted_at != 0, !unaccepted, "{name}: the receipt says whether the seller accepted");
    }
    println!("eight endings: the deposit account's rent back each time, {} lamports kept in each receipt", kept / 8);
}

// ---------------------------------------------------------------------------------------------
// The seller's acceptance
// ---------------------------------------------------------------------------------------------

#[test]
fn before_acceptance_only_a_full_approval_or_the_buyers_withdrawal_ends_a_funded_escrow() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();
    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    h.fund(&escrow, AMOUNT + 250_000);

    // A month later, with the money in, nothing that needs the seller's consent runs.
    h.set_time(T0 + 30 * DAY);
    let cases: Vec<(&str, Instruction, Vec<&Keypair>)> = vec![
        ("object", object_ix(escrow, vault, buyer.pubkey()), vec![&buyer]),
        ("release_by_silence", release_by_silence_ix(&s), vec![]),
        ("agree", agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000), vec![&buyer, &seller]),
        ("arbitrate", arbitrate_ix(&s, arbiter.pubkey(), 5_000), vec![&arbiter]),
        ("cancel_buyer", cancel_buyer_ix(&s, buyer.pubkey()), vec![&buyer]),
        ("cancel_seller", cancel_seller_ix(&s, seller.pubkey()), vec![&seller]),
        ("approve a split", approve_ix(&s, buyer.pubkey(), 9_999), vec![&buyer]),
    ];
    for (what, ix, signers) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains("NotAccepted"), "{what}: expected NotAccepted, got\n{err}");
    }
    assert_eq!(h.escrow(&escrow).status, Status::Open);
    // Observing the funding binds nobody: it records the time, and the escrow stays open. Anyone
    // may then send it all back, but only after the timeout, which counts from this moment.
    h.mark_funded(&escrow).expect("mark_funded before acceptance");
    assert_eq!((h.escrow(&escrow).status, h.escrow(&escrow).funded_at), (Status::Open, T0 + 30 * DAY));
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let err = h.close_unaccepted(&escrow, &stranger).expect_err("before the timeout");
    assert!(err.contains("BeforeTimeout"), "{err}");

    // The buyer takes everything back, the excess included. The receipt says nobody dealt.
    let meta = h.send(&[withdraw_ix(&s, buyer.pubkey())], &[&buyer]).expect("withdraw");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["Withdrawn", "Ended"]);
    assert_eq!(ev[0], Event::Withdrawn { escrow, to_buyer: AMOUNT + 250_000 });
    let (outcome, balance, to_seller, to_buyer, _) = ended(&ev);
    assert_eq!((outcome, balance, to_seller, to_buyer), (Outcome::Withdrawn, AMOUNT + 250_000, 0, AMOUNT + 250_000));
    let Event::Ended { accepted_at, .. } = ev[1] else { unreachable!() };
    assert_eq!(accepted_at, 0);
    assert_ended(&h, &escrow, BUYER_START, 0);
    assert_eq!(h.escrow(&escrow).outcome, Some(Outcome::Withdrawn));

    // Once the seller has accepted, the buyer's way out is a cancellation step, not a withdrawal;
    // and acceptance happens once.
    let escrow2 = h.funded(&h.terms(2));
    let s2 = h.settle_accounts(&escrow2);
    let err = h.send(&[withdraw_ix(&s2, buyer.pubkey())], &[&buyer]).expect_err("withdraw after acceptance");
    assert!(err.contains("AlreadyAccepted"), "{err}");
    let err = h.accept(&escrow2).expect_err("accept twice");
    assert!(err.contains("AlreadyAccepted"), "{err}");
    println!("before acceptance: seven instructions refused a month in, and close_unaccepted before its timeout; the buyer withdrew everything; after acceptance, no withdrawal");
}

#[test]
fn the_clock_never_starts_before_the_seller_accepts() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();

    // Funded at once, accepted ten days later, after a seven-day silence would have ended had it
    // counted from funding. It counts from the acceptance: the seller cannot accept and release in
    // one breath, and the buyer has the whole silence period after acceptance to object.
    let seller = h.seller.insecure_clone();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, AMOUNT);
    h.set_time(T0 + 10 * DAY);
    let err = h
        .send(&[accept_ix(escrow, s.vault, seller.pubkey()), release_by_silence_ix(&s)], &[&seller])
        .expect_err("accept and release together");
    assert!(err.contains("SilenceNotOver"), "{err}");
    let meta = h.accept(&escrow).expect("accept");
    assert_eq!(names(&events(&meta.logs)), ["Accepted", "Funded"], "the acceptance observes the funding");
    let e = h.escrow(&escrow);
    assert_eq!((e.accepted_at, e.funded_at, e.status), (T0 + 10 * DAY, T0 + 10 * DAY, Status::Funded));
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("silence from acceptance");
    assert!(err.contains("SilenceNotOver"), "{err}");
    // The steps count from the acceptance too: an hour in, step 0 (full refund) is in force.
    h.set_time(T0 + 10 * DAY + 3_600);
    let meta = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("cancel");
    let (outcome, _, to_seller, to_buyer, _) = ended(&events(&meta.logs));
    assert_eq!((outcome, to_seller, to_buyer), (Outcome::CancelledByBuyer, 0, AMOUNT));

    // A service time the seller accepts after: the clock starts at the acceptance, not before it.
    let mut t2 = h.terms(2);
    t2.service_time = Some(T0 + DAY);
    h.set_time(T0);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.fund(&escrow2, AMOUNT);
    h.set_time(T0 + 20 * DAY);
    h.accept(&escrow2).expect("accept, nineteen days after the service time");
    let err = h.send(&[release_by_silence_ix(&s2)], &[]).expect_err("silence from acceptance");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 27 * DAY);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.send(&[object_ix(escrow2, vault2, buyer.pubkey())], &[&buyer]).expect("the buyer can still object on day seven after acceptance");

    // A service time ahead of the acceptance is the clock start, as designed.
    let mut t3 = h.terms(3);
    t3.service_time = Some(T0 + 40 * DAY);
    let escrow3 = h.funded(&t3);
    let s3 = h.settle_accounts(&escrow3);
    h.set_time(T0 + 47 * DAY + 1);
    h.send(&[release_by_silence_ix(&s3)], &[]).expect("seven days after the service time");
    println!("funded day 0, accepted day 10: silence and steps from day 10; a past service time counts from acceptance; a future one as designed");
}

#[test]
fn an_escrow_the_seller_opens_is_an_invoice_accepted_from_creation() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let t = h.terms(1);
    let (escrow, meta) = h.invoice(&t).expect("invoice");
    assert_eq!(escrow, escrow_address(&buyer.pubkey(), 1), "the same address a buyer's escrow would have");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["Created", "Accepted"]);
    assert_eq!(ev[1], Event::Accepted { escrow, seller: h.seller.pubkey(), accepted_at: T0 });
    let e = h.escrow(&escrow);
    assert_eq!((e.status, e.accepted_at, e.created_at, e.buyer), (Status::Accepted, T0, T0, buyer.pubkey()));

    // The buyer pays by plain transfer, anyone marks it, and the deal runs: a split needs nothing more.
    h.advance(DAY);
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("mark_funded");
    assert_eq!(h.escrow(&escrow).funded_at, T0 + DAY, "the clock starts at funding");
    let s = h.settle_accounts(&escrow);
    let err = h.send(&[withdraw_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("no withdrawal from an invoice");
    assert!(err.contains("AlreadyAccepted"), "{err}");
    h.send(&[approve_ix(&s, buyer.pubkey(), 6_000)], &[&buyer]).expect("a split");
    assert_ended(&h, &escrow, BUYER_START - 600_000, 600_000);

    // An invoice over a deposit account that already holds the amount is funded from creation.
    let t2 = h.terms(2);
    let escrow2 = escrow_address(&buyer.pubkey(), 2);
    h.svm.set_account(vault_address(&escrow2, &h.mint), spl_token_account(&h.mint, &escrow2, AMOUNT)).unwrap();
    let (_, meta) = h.invoice(&t2).expect("invoice over a funded deposit account");
    assert_eq!(names(&events(&meta.logs)), ["Created", "Accepted", "Funded"]);
    assert_eq!(h.escrow(&escrow2).status, Status::Funded);
    println!("an invoice: Created and Accepted in one transaction, then paid and split like any accepted deal");
}

// ---------------------------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------------------------

/// The same instruction with `who` marked as not signing, the way a stranger would have to send
/// it: Anchor's `Signer` check refuses before the handler runs.
fn unsigned(mut ix: Instruction, who: &Address) -> Instruction {
    for m in ix.accounts.iter_mut() {
        if m.pubkey == *who {
            m.is_signer = false;
        }
    }
    ix
}

#[test]
fn the_wrong_signer_is_refused_for_every_instruction() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    // create: the buyer or the seller must sign. A stranger cannot open an escrow in either's name.
    let t = h.terms(1);
    let a = h.create_accounts();
    let err = h.send(&[unsigned(create_ix(&t, &a), &buyer.pubkey())], &[]).expect_err("create unsigned");
    assert!(err.contains("AccountNotSigner"), "{err}");
    let err = h.send(&[create_ix_by(&t, &a, stranger.pubkey())], &[&stranger]).expect_err("a stranger creates");
    assert!(err.contains("NotAParty"), "{err}");
    let err = h.send(&[create_ix_by(&t, &a, arbiter.pubkey())], &[&arbiter]).expect_err("the arbiter creates");
    assert!(err.contains("NotAParty"), "{err}");

    // accept: the seller and nobody else.
    let (open, _) = h.create(&h.terms(9)).expect("create");
    let open_vault = vault_address(&open, &h.mint);
    for (who, key) in [("the buyer", &buyer), ("the arbiter", &arbiter), ("a stranger", &stranger)] {
        let err = h.send(&[accept_ix(open, open_vault, key.pubkey())], &[key]).expect_err("accept");
        assert!(err.contains("ConstraintHasOne"), "accept by {who}: {err}");
    }
    let err = h.send(&[unsigned(accept_ix(open, open_vault, seller.pubkey()), &seller.pubkey())], &[]).expect_err("unsigned");
    assert!(err.contains("AccountNotSigner"), "{err}");
    assert_eq!(h.escrow(&open).accepted_at, 0);

    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);

    let cases: Vec<(&str, Instruction, Vec<&Keypair>, &str)> = vec![
        ("approve by the seller", approve_ix(&s, seller.pubkey(), 10_000), vec![&seller], "NotTheBuyer"),
        ("approve by a stranger", approve_ix(&s, stranger.pubkey(), 10_000), vec![&stranger], "NotTheBuyer"),
        ("object by the seller", object_ix(escrow, vault, seller.pubkey()), vec![&seller], "ConstraintHasOne"),
        ("object with the buyer not signing", unsigned(object_ix(escrow, vault, buyer.pubkey()), &buyer.pubkey()), vec![], "AccountNotSigner"),
        ("agree with only the buyer", unsigned(agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000), &seller.pubkey()), vec![&buyer], "AccountNotSigner"),
        ("agree with only the seller", unsigned(agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000), &buyer.pubkey()), vec![&seller], "AccountNotSigner"),
        ("agree by two strangers", agree_ix(&s, stranger.pubkey(), stranger.pubkey(), 5_000), vec![&stranger], "ConstraintHasOne"),
        ("arbitrate by the buyer", arbitrate_ix(&s, buyer.pubkey(), 5_000), vec![&buyer], "NotTheArbiter"),
        ("arbitrate by a stranger", arbitrate_ix(&s, stranger.pubkey(), 5_000), vec![&stranger], "NotTheArbiter"),
        ("cancel_buyer by the seller", cancel_buyer_ix(&s, seller.pubkey()), vec![&seller], "NotTheBuyer"),
        ("cancel_seller by the buyer", cancel_seller_ix(&s, buyer.pubkey()), vec![&buyer], "NotTheSeller"),
        ("cancel_seller by the arbiter", cancel_seller_ix(&s, arbiter.pubkey()), vec![&arbiter], "NotTheSeller"),
        ("close_unfunded by a stranger", close_unfunded_ix(&s, stranger.pubkey()), vec![&stranger], "StillFunded"),
        ("withdraw by the seller", withdraw_ix(&s, seller.pubkey()), vec![&seller], "ConstraintHasOne"),
        ("approve with the buyer not signing", unsigned(approve_ix(&s, buyer.pubkey(), 10_000), &buyer.pubkey()), vec![], "AccountNotSigner"),
        (
            "close_unaccepted by a stranger, accepted",
            close_unaccepted_ix(escrow, vault, buyer.pubkey(), h.mint, h.payer.pubkey(), stranger.pubkey()),
            vec![&stranger],
            "AlreadyAccepted",
        ),
        (
            "close_unaccepted with the caller not signing",
            unsigned(close_unaccepted_ix(escrow, vault, buyer.pubkey(), h.mint, h.payer.pubkey(), stranger.pubkey()), &stranger.pubkey()),
            vec![],
            "AccountNotSigner",
        ),
        ("recover_late by a stranger, live", recover_late_ix(escrow, vault, buyer.pubkey(), h.mint, stranger.pubkey()), vec![&stranger], "NotEnded"),
        (
            "recover_late with the caller not signing",
            unsigned(recover_late_ix(escrow, vault, buyer.pubkey(), h.mint, stranger.pubkey()), &stranger.pubkey()),
            vec![],
            "AccountNotSigner",
        ),
        ("sweep_rent to a stranger", sweep_rent_ix(escrow, stranger.pubkey()), vec![], "ConstraintHasOne"),
    ];
    for (what, ix, signers, want) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains(want), "{what}: expected {want}, got\n{err}");
    }

    // close_unfunded by a stranger on a never-funded escrow: the rule after the funding check.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    let err = h.send(&[close_unfunded_ix(&s2, stranger.pubkey())], &[&stranger]).expect_err("close by a stranger");
    assert!(err.contains("NotACloser"), "{err}");

    // Payouts go only to accounts the parties own: a stranger's token account as the seller's.
    let strangers_tokens = Address::new_unique();
    h.svm.set_account(strangers_tokens, spl_token_account(&h.mint, &stranger.pubkey(), 0)).unwrap();
    let mut bad = s;
    bad.seller_tokens = strangers_tokens;
    let err = h.send(&[approve_ix(&bad, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("wrong destination");
    assert!(err.contains("ConstraintTokenOwner"), "{err}");
    // And the rent goes only to the recorded rent payer.
    let mut bad = s;
    bad.rent_payer = stranger.pubkey();
    let err = h.send(&[approve_ix(&bad, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("wrong rent payer");
    assert!(err.contains("ConstraintHasOne"), "{err}");

    assert!(h.exists(&escrow), "nothing above touched the escrow");
    assert_eq!(h.vault_balance(&escrow), AMOUNT);
    println!("every instruction refused its wrong signer; payouts and rent cannot be redirected");
}

#[test]
fn an_unfunded_escrow_cannot_be_approved_agreed_arbitrated_cancelled_or_objected() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();
    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    h.fund(&escrow, AMOUNT - 1);
    // Before acceptance, the buyer's two exits need the amount too.
    let err = h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("approve short");
    assert!(err.contains("NotFunded"), "{err}");
    let err = h.send(&[withdraw_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("withdraw short");
    assert!(err.contains("NotFunded"), "{err}");
    h.accept(&escrow).expect("accept");

    let cases: Vec<(&str, Instruction, Vec<&Keypair>)> = vec![
        ("approve", approve_ix(&s, buyer.pubkey(), 10_000), vec![&buyer]),
        ("release_by_silence", release_by_silence_ix(&s), vec![]),
        ("object", object_ix(escrow, vault, buyer.pubkey()), vec![&buyer]),
        ("agree", agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000), vec![&buyer, &seller]),
        ("arbitrate", arbitrate_ix(&s, arbiter.pubkey(), 5_000), vec![&arbiter]),
        ("cancel_buyer", cancel_buyer_ix(&s, buyer.pubkey()), vec![&buyer]),
        ("cancel_seller", cancel_seller_ix(&s, seller.pubkey()), vec![&seller]),
    ];
    for (what, ix, signers) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains("NotFunded"), "{what}: expected NotFunded, got\n{err}");
    }
    assert_eq!(h.vault_balance(&escrow), AMOUNT - 1);
    println!("one base unit short: nine instructions refused, before and after acceptance, the money still in the deposit account");
}

#[test]
fn silence_is_refused_too_early_while_locked_and_before_the_clock_starts() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();

    // Accepted, funded but never observed, no service time: no clock to count from.
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    h.accept(&escrow).expect("accept");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, AMOUNT);
    h.set_time(T0 + 30 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("no clock");
    assert!(err.contains("ClockNotStarted"), "{err}");
    // Neither for a cancellation, which needs to know which step is in force.
    let err = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("no clock");
    assert!(err.contains("ClockNotStarted"), "{err}");
    // mark_funded now, and the clock starts now, not when the money arrived.
    h.mark_funded(&escrow).expect("mark_funded");
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("too early");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 37 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("the last second");
    assert!(err.contains("SilenceNotOver"), "{err}");

    // Locked, on the day it would have released.
    let vault = vault_address(&escrow, &h.mint);
    h.send(&[object_ix(escrow, vault, buyer.pubkey())], &[&buyer]).expect("object on the last second");
    h.set_time(T0 + 37 * DAY + 1);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("locked");
    assert!(err.contains("Locked"), "{err}");
    println!("silence: no clock, too early, the last second, then locked: all refused");
}

#[test]
fn the_buyer_cannot_cancel_after_the_last_deadline_or_while_locked_and_cannot_object_after_silence() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);

    h.set_time(T0 + 3 * DAY); // the last deadline itself is already too late
    let err = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("after the last deadline");
    assert!(err.contains("AfterLastDeadline"), "{err}");

    h.set_time(T0 + 7 * DAY + 1);
    let err = h.send(&[object_ix(escrow, vault, buyer.pubkey())], &[&buyer]).expect_err("after silence");
    assert!(err.contains("SilenceOver"), "{err}");

    let t2 = h.terms(2);
    h.set_time(T0);
    let escrow2 = h.funded(&t2);
    let s2 = h.settle_accounts(&escrow2);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.send(&[object_ix(escrow2, vault2, buyer.pubkey())], &[&buyer]).expect("object");
    let err = h.send(&[cancel_buyer_ix(&s2, buyer.pubkey())], &[&buyer]).expect_err("locked");
    assert!(err.contains("Locked"), "{err}");
    let err = h.send(&[approve_ix(&s2, buyer.pubkey(), 10_000)], &[&buyer]).expect_err("locked");
    assert!(err.contains("Locked"), "{err}");
    let err = h.send(&[object_ix(escrow2, vault2, buyer.pubkey())], &[&buyer]).expect_err("twice");
    assert!(err.contains("Locked"), "{err}");
    let err = h.send(&[close_unfunded_ix(&s2, buyer.pubkey())], &[&buyer]).expect_err("funded");
    assert!(err.contains("StillFunded"), "{err}");
    println!("cancel after day 3, object after day 7, and cancel, approve, object and close under a lock: all refused");
}

#[test]
fn an_ended_escrow_is_a_permanent_receipt_and_accepts_nothing() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();
    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    h.advance(DAY / 2);
    h.send(&[approve_ix(&s, buyer.pubkey(), 7_000)], &[&buyer]).expect("approve");

    // The receipt: everything the deal was, and how it ended, at an address that stays.
    let receipt = h.account(&escrow);
    let e = read_escrow(&receipt.data);
    assert_eq!((e.status, e.outcome), (Status::Ended, Some(Outcome::Approved)));
    assert_eq!((e.accepted_at, e.funded_at, e.ended_at), (T0, T0, T0 + DAY / 2));
    assert_eq!((e.amount, e.to_seller, e.to_buyer), (AMOUNT, 700_000, 300_000));
    assert_eq!((e.buyer, e.seller, e.arbiter, e.mint), (buyer.pubkey(), seller.pubkey(), arbiter.pubkey(), h.mint));
    assert!(!h.exists(&vault));

    // Someone pays the same address again: a wallet makes the deposit account again and sends.
    // With the deposit account back, every instruction still finds the escrow ended.
    h.svm.set_account(vault, spl_token_account(&h.mint, &escrow, 2 * AMOUNT)).unwrap();
    let cases: Vec<(&str, Instruction, Vec<&Keypair>)> = vec![
        ("accept", accept_ix(escrow, vault, seller.pubkey()), vec![&seller]),
        ("mark_funded", mark_funded_ix(escrow, vault), vec![]),
        ("object", object_ix(escrow, vault, buyer.pubkey()), vec![&buyer]),
        ("approve again", approve_ix(&s, buyer.pubkey(), 10_000), vec![&buyer]),
        ("release_by_silence", release_by_silence_ix(&s), vec![]),
        ("agree", agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000), vec![&buyer, &seller]),
        ("arbitrate", arbitrate_ix(&s, arbiter.pubkey(), 5_000), vec![&arbiter]),
        ("cancel_buyer", cancel_buyer_ix(&s, buyer.pubkey()), vec![&buyer]),
        ("cancel_seller after release", cancel_seller_ix(&s, seller.pubkey()), vec![&seller]),
        ("withdraw", withdraw_ix(&s, buyer.pubkey()), vec![&buyer]),
    ];
    h.set_time(T0 + 30 * DAY);
    for (what, ix, signers) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains("Ended"), "{what}: the escrow has ended, got\n{err}");
    }
    // close_unfunded, with less than the amount there: it would close the receipt, and must not.
    h.svm.set_account(vault, spl_token_account(&h.mint, &escrow, 1)).unwrap();
    for (who, key) in [("buyer", &buyer), ("seller", &seller)] {
        let err = h.send(&[close_unfunded_ix(&s, key.pubkey())], &[key]).expect_err("close the receipt");
        assert!(err.contains("Ended"), "{who}: {err}");
    }
    // And the address never opens again, whoever tries and whatever the terms.
    let mut t2 = h.terms(1);
    t2.seller = Keypair::new().pubkey();
    let err = h.create(&t2).expect_err("reopen as buyer");
    assert!(err.contains("already in use"), "{err}");
    let err = h.invoice(&t).expect_err("reopen as seller");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt's bytes never change");
    assert_eq!(h.account(&escrow).lamports, receipt.lamports);
    assert_eq!(h.balance(&h.seller_tokens), 700_000);
    // Two instructions still run on a receipt, and neither changes its bytes: the late money goes
    // back to the buyer, and there is no rent above the minimum to sweep at today's rate.
    let meta = h.recover_late(&escrow, &buyer).expect("recover_late");
    assert_eq!(names(&events(&meta.logs)), ["RecoveredLate"]);
    assert_eq!(h.balance(&h.refund()), 1);
    let err = h.sweep(&escrow).expect_err("nothing to sweep");
    assert!(err.contains("NothingToSweep"), "{err}");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt's bytes never change");
    assert_eq!(h.account(&escrow).lamports, receipt.lamports);
    println!("after approve the receipt stays: eleven instructions and two reopenings refused, its bytes unchanged; the late money went back to the buyer");
}

#[test]
fn arbitration_needs_an_arbiter_named_at_creation() {
    let mut h = Harness::new();
    let arbiter = h.arbiter.insecure_clone();
    let t = h.terms(1); // none
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let err = h.send(&[arbitrate_ix(&s, arbiter.pubkey(), 5_000)], &[&arbiter]).expect_err("no arbiter");
    assert!(err.contains("NoArbiter"), "{err}");
    assert_eq!(h.escrow(&escrow).arbiter, zero());
    println!("no arbiter named: arbitrate refused");
}

#[test]
fn a_token_2022_mint_is_refused() {
    let mut h = Harness::new();
    let mint22 = Address::new_unique();
    h.svm.set_account(mint22, spl_mint_account(6, TOKEN_2022_PROGRAM)).unwrap();
    let t = h.terms(1);
    let a = CreateAccounts { buyer: h.buyer.pubkey(), payer: h.payer.pubkey(), mint: mint22 };
    let buyer = h.buyer.insecure_clone();
    let err = h.send(&[create_ix(&t, &a)], &[&buyer]).expect_err("Token-2022");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");
    assert!(!h.exists(&escrow_address(&buyer.pubkey(), 1)));
    println!("a Token-2022 mint: refused, nothing written");
}

#[test]
fn bad_terms_are_refused_at_creation() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let buyer_key = buyer.pubkey();
    let seller = h.seller.pubkey();
    let cases: Vec<(&str, Box<dyn Fn(&mut Terms)>, &str)> = vec![
        ("unsorted steps", Box::new(|t| t.steps = vec![step(3 * DAY, 5_000), step(DAY, 10_000)]), "StepsUnsorted"),
        ("two steps on one deadline", Box::new(|t| t.steps = vec![step(DAY, 10_000), step(DAY, 5_000)]), "StepsUnsorted"),
        ("a refund over 100%", Box::new(|t| t.steps = vec![step(DAY, 10_001)]), "StepOverHundred"),
        ("five steps", Box::new(|t| t.steps = (1..=5).map(|i| step(i * DAY, 5_000)).collect()), "TooManySteps"),
        ("buyer equals seller", Box::new(move |t| t.seller = buyer_key), "SameParty"),
        ("the zero key as seller", Box::new(|t| t.seller = Address::default()), "EmptyKey"),
        ("the buyer as arbiter", Box::new(move |t| t.arbiter = Some(buyer_key)), "ArbiterIsAParty"),
        ("the seller as arbiter", Box::new(move |t| t.arbiter = Some(seller)), "ArbiterIsAParty"),
        ("amount zero", Box::new(|t| t.amount = 0), "AmountZero"),
        ("silence zero", Box::new(|t| t.silence_days = 0), "SilenceZero"),
        ("service time zero", Box::new(|t| t.service_time = Some(0)), "BadServiceTime"),
    ];
    for (what, change, want) in cases {
        let mut t = h.terms(1);
        change(&mut t);
        let a = h.create_accounts();
        let err = h.send(&[create_ix(&t, &a)], &[&buyer]).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains(want), "{what}: expected {want}, got\n{err}");
        assert!(!h.exists(&escrow_address(&buyer.pubkey(), 1)), "{what}: nothing written");
    }
    // Four steps, sorted, refunds anywhere in 0..=100%, is the most the shape holds, and fine.
    let mut t = h.terms(1);
    t.steps = vec![step(-DAY, 10_000), step(0, 7_500), step(DAY, 2_500), step(2 * DAY, 0)];
    h.create(&t).expect("four steps");
    println!("eleven bad term sets refused at create; four sorted steps accepted");
}

#[test]
fn a_split_over_ten_thousand_basis_points_is_refused() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();
    let mut t = h.terms(1);
    t.arbiter = Some(arbiter.pubkey());
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    for (what, ix, signers) in [
        ("approve", approve_ix(&s, buyer.pubkey(), 10_001), vec![&buyer]),
        ("agree", agree_ix(&s, buyer.pubkey(), seller.pubkey(), 10_001), vec![&buyer, &seller]),
        ("arbitrate", arbitrate_ix(&s, arbiter.pubkey(), 10_001), vec![&arbiter]),
    ] {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains("BadSplit"), "{what}: {err}");
    }
    println!("10,001 basis points: approve, agree and arbitrate all refused");
}

// ---------------------------------------------------------------------------------------------
// Session 12: money after the end, rent above the minimum, a seller who never answers, and a
// clock that waits for the money
// ---------------------------------------------------------------------------------------------

/// Anyone at all, with some SOL to pay for what it makes.
fn someone(h: &mut Harness) -> Keypair {
    let k = Keypair::new();
    h.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    k
}

#[test]
fn late_money_at_an_ended_escrow_goes_back_to_the_buyer_whoever_sends_it() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let s = h.settle_accounts(&escrow);
    h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve");
    let receipt = h.account(&escrow);
    let stranger = someone(&mut h);

    // Nothing arrived after the end: there is nothing to recover, and no deposit account to load.
    let err = h.recover_late(&escrow, &stranger).expect_err("nothing there");
    assert!(err.contains("AccountNotInitialized"), "{err}");

    // A second tap on the old pay link: the buyer's wallet makes the deposit account again and pays.
    let (ata_ix, vault) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    assert_eq!(vault, s.vault);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), 400_000)], &[&buyer]).expect("a second payment");
    let vault_rent = h.lamports(&vault);
    let buyer_sol = h.lamports(&buyer.pubkey());

    // A stranger sends it back. The buyer's refund address does not exist yet: the stranger makes
    // it and pays its rent (the harness key pays the fee).
    let refund = h.refund();
    assert!(!h.exists(&refund));
    let stranger_sol = h.lamports(&stranger.pubkey());
    let meta = h.recover_late(&escrow, &stranger).expect("recover_late");
    assert_eq!(events(&meta.logs), [Event::RecoveredLate { escrow, to_buyer: 400_000, rent_lamports: vault_rent }]);
    assert_eq!(h.balance(&refund), 400_000, "the late money is the buyer's, at the buyer's refund address");
    assert!(!h.exists(&vault), "the deposit account is closed again");
    assert_eq!(h.lamports(&buyer.pubkey()), buyer_sol + vault_rent, "its rent went to the buyer, whose wallet made it");
    assert_eq!(h.lamports(&stranger.pubkey()), stranger_sol - h.lamports(&refund), "the stranger paid for the refund address");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt does not change");
    assert_eq!(h.account(&escrow).lamports, receipt.lamports);

    // Again, the refund address already there, sent by the buyer this time.
    let (ata_ix, _) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), 1)], &[&buyer]).expect("a third payment");
    h.recover_late(&escrow, &buyer).expect("recover_late by the buyer");
    assert_eq!(h.balance(&refund), 400_001);
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - AMOUNT - 400_001, "every late unit is at the refund address");
    println!("late money after the end: back at the buyer's refund address, sent by a stranger who made it; the receipt unchanged");
}

#[test]
fn rent_above_the_minimum_goes_back_to_the_rent_payer_and_the_escrow_keeps_exactly_the_minimum() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let escrow = h.funded(&h.terms(1));
    let s = h.settle_accounts(&escrow);
    h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve");
    let live = h.funded(&h.terms(2));
    let receipt = h.account(&escrow);

    // At the rate it was made at, the receipt holds exactly its minimum.
    let err = h.sweep(&escrow).expect_err("nothing above the minimum");
    assert!(err.contains("NothingToSweep"), "{err}");

    // The cuts land: the same 319 bytes need far less. The excess goes to the rent payer, the
    // account keeps exactly the new minimum, and its bytes do not change.
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let minimum = (128 + ESCROW_LEN as u64) * RENT_FINAL;
    let excess = receipt.lamports - minimum;
    let payer = h.lamports(&h.payer.pubkey());
    let meta = h.sweep(&escrow).expect("sweep");
    assert_eq!(events(&meta.logs), [Event::RentSwept { escrow, lamports: excess, left: minimum }]);
    assert_eq!(h.lamports(&escrow), minimum);
    assert_eq!(h.lamports(&h.payer.pubkey()), payer + excess - 5_000, "the rent payer, who also paid this fee");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt's bytes do not change");
    let err = h.sweep(&escrow).expect_err("twice");
    assert!(err.contains("NothingToSweep"), "{err}");

    // SOL sent to the escrow's address leaves the same way: to the rent payer.
    h.send(&[sol_transfer_ix(buyer.pubkey(), escrow, 1_000_000)], &[&buyer]).expect("SOL to a receipt");
    let meta = h.sweep(&escrow).expect("sweep the stray SOL");
    assert_eq!(events(&meta.logs), [Event::RentSwept { escrow, lamports: 1_000_000, left: minimum }]);

    // A live escrow can be swept too, and still ends as usual, keeping the minimum.
    h.sweep(&live).expect("sweep a live escrow");
    assert_eq!(h.lamports(&live), minimum);
    let s2 = h.settle_accounts(&live);
    h.send(&[approve_ix(&s2, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve after a sweep");
    assert_eq!((h.escrow(&live).status, h.lamports(&live)), (Status::Ended, minimum));
    println!("rent sweep at {RENT_FINAL} lamports a byte: {excess} lamports back to the rent payer, {minimum} kept, bytes unchanged");
}

#[test]
fn a_funded_escrow_the_seller_never_accepts_goes_back_to_the_buyer_after_its_timeout() {
    // No steps: thirty days after the funding was observed.
    let mut h = Harness::new();
    let stranger = someone(&mut h);
    let mut t = h.terms(1);
    t.steps = vec![];
    let (escrow, _) = h.create(&t).expect("create");
    let vault = vault_address(&escrow, &h.mint);
    h.advance(DAY);
    h.fund(&escrow, AMOUNT + 5);
    let meta = h.mark_funded(&escrow).expect("mark_funded before acceptance");
    assert_eq!(events(&meta.logs), [Event::Funded { escrow, balance: AMOUNT + 5, funded_at: T0 + DAY }]);
    let e = h.escrow(&escrow);
    assert_eq!((e.status, e.funded_at, e.accepted_at), (Status::Open, T0 + DAY, 0), "observed, still open");
    let timeout = T0 + DAY + UNACCEPTED_DAYS * DAY;
    h.set_time(timeout);
    let err = h.close_unaccepted(&escrow, &stranger).expect_err("the last second of the wait");
    assert!(err.contains("BeforeTimeout"), "{err}");
    h.set_time(timeout + 1);
    let refund = h.refund();
    let vault_rent = h.lamports(&vault);
    let rent_payer = h.lamports(&h.payer.pubkey());
    let meta = h.close_unaccepted(&escrow, &stranger).expect("anyone, after the timeout");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["NeverAccepted", "Ended"]);
    assert_eq!(ev[0], Event::NeverAccepted { escrow, timeout, to_buyer: AMOUNT + 5 });
    let (outcome, balance, to_seller, to_buyer, rent) = ended(&ev);
    assert_eq!((outcome, balance, to_seller, to_buyer, rent), (Outcome::NeverAccepted, AMOUNT + 5, 0, AMOUNT + 5, vault_rent));
    assert_eq!(h.balance(&refund), AMOUNT + 5, "everything, the excess included, at the buyer's refund address");
    assert_eq!(h.balance(&h.seller_tokens), 0);
    assert_eq!(h.lamports(&h.payer.pubkey()), rent_payer + vault_rent - 2 * 5_000, "the deposit account's rent to the rent payer (who paid this two-signature fee)");
    assert!(!h.exists(&vault));
    let e = h.escrow(&escrow);
    assert_eq!(
        (e.status, e.outcome, e.to_seller, e.to_buyer, e.accepted_at, e.ended_at),
        (Status::Ended, Some(Outcome::NeverAccepted), 0, AMOUNT + 5, 0, timeout + 1),
        "the receipt stays, and says nobody accepted"
    );

    // With steps: after the last deadline, counted from the later of the service time and the
    // observed funding. Here the service time is later: two days after it.
    let mut h = Harness::new();
    let stranger = someone(&mut h);
    let mut t = h.terms(2);
    t.service_time = Some(T0 + 10 * DAY);
    t.steps = vec![step(-DAY, 10_000), step(2 * DAY, 5_000)];
    let (escrow, _) = h.create(&t).expect("create");
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("observed at T0");
    h.set_time(T0 + 12 * DAY);
    let err = h.close_unaccepted(&escrow, &stranger).expect_err("the last deadline itself");
    assert!(err.contains("BeforeTimeout"), "{err}");
    h.set_time(T0 + 12 * DAY + 1);
    h.close_unaccepted(&escrow, &stranger).expect("after the last deadline");
    assert_eq!(h.balance(&h.refund()), AMOUNT);

    // Here the funding is later: the same steps count from it.
    let mut t = h.terms(3);
    t.service_time = Some(T0 + 13 * DAY);
    t.steps = vec![step(2 * DAY, 10_000)];
    let (escrow, _) = h.create(&t).expect("create");
    h.set_time(T0 + 20 * DAY);
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("observed after the service time");
    h.set_time(T0 + 22 * DAY);
    let err = h.close_unaccepted(&escrow, &stranger).expect_err("two days after the funding, not the service time");
    assert!(err.contains("BeforeTimeout"), "{err}");
    h.set_time(T0 + 22 * DAY + 1);
    h.close_unaccepted(&escrow, &stranger).expect("after it");
    assert_eq!(h.balance(&h.refund()), 2 * AMOUNT);
    println!("never accepted: everything back to the buyer 30 days after funding, or after the last deadline from max(service time, funding)");
}

#[test]
fn close_unaccepted_needs_money_there_its_funding_observed_and_no_acceptance() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let stranger = someone(&mut h);
    let mut t = h.terms(1);
    t.steps = vec![];

    // Never funded: that is close_unfunded's case, not this one.
    let (unfunded, _) = h.create(&t).expect("create");
    h.fund(&unfunded, AMOUNT - 1);
    // Funded, never observed: nothing to count thirty days from, however long it waits.
    let t2 = Terms { id: 2, ..t.clone() };
    let (unobserved, _) = h.create(&t2).expect("create");
    h.fund(&unobserved, AMOUNT);
    // Observed, then accepted: the seller answered.
    let t3 = Terms { id: 3, ..t.clone() };
    let (accepted, _) = h.create(&t3).expect("create");
    h.fund(&accepted, AMOUNT);
    h.mark_funded(&accepted).expect("mark_funded");
    h.accept(&accepted).expect("accept");
    // An invoice is accepted from creation.
    let t4 = Terms { id: 4, ..t.clone() };
    let (invoice, _) = h.invoice(&t4).expect("invoice");
    h.fund(&invoice, AMOUNT);
    h.mark_funded(&invoice).expect("mark_funded");
    // Withdrawn by the buyer: ended.
    let t5 = Terms { id: 5, ..t.clone() };
    let (withdrawn, _) = h.create(&t5).expect("create");
    h.fund(&withdrawn, AMOUNT);
    h.mark_funded(&withdrawn).expect("mark_funded");
    let s5 = h.settle_accounts(&withdrawn);
    h.send(&[withdraw_ix(&s5, buyer.pubkey())], &[&buyer]).expect("withdraw");
    let (ata_ix, vault5) = create_ata_idempotent_ix(buyer.pubkey(), withdrawn, h.mint);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault5, buyer.pubkey(), AMOUNT)], &[&buyer]).expect("paid again");

    h.set_time(T0 + 1_000 * DAY);
    for (what, escrow, want) in [
        ("never funded", unfunded, "NotFunded"),
        ("never observed", unobserved, "FundingNotObserved"),
        ("accepted", accepted, "AlreadyAccepted"),
        ("an invoice", invoice, "AlreadyAccepted"),
        ("ended", withdrawn, "Ended"),
    ] {
        let err = h.close_unaccepted(&escrow, &stranger).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains(want), "{what}: expected {want}, got\n{err}");
    }
    // Once observed, the unobserved one waits thirty days from then, not from when the money came.
    h.mark_funded(&unobserved).expect("observed a thousand days late");
    let err = h.close_unaccepted(&unobserved, &stranger).expect_err("thirty days from the observation");
    assert!(err.contains("BeforeTimeout"), "{err}");
    println!("close_unaccepted refused: never funded, never observed, accepted, an invoice, ended");
}

#[test]
fn the_funding_can_be_observed_before_acceptance_and_the_acceptance_keeps_it() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, AMOUNT);
    h.advance(DAY);
    h.mark_funded(&escrow).expect("before acceptance");
    let err = h.mark_funded(&escrow).expect_err("once");
    assert!(err.contains("AlreadyFunded"), "{err}");
    h.advance(2 * DAY);
    let meta = h.accept(&escrow).expect("accept");
    assert_eq!(names(&events(&meta.logs)), ["Accepted"], "the funding was already observed; no second Funded");
    let e = h.escrow(&escrow);
    assert_eq!((e.status, e.funded_at, e.accepted_at), (Status::Funded, T0 + DAY, T0 + 3 * DAY));
    // The clock starts at the later of the two: the acceptance.
    h.set_time(T0 + 10 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("seven days from the acceptance");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 10 * DAY + 1);
    h.send(&[release_by_silence_ix(&s)], &[]).expect("released");
    println!("funding observed on day 1, accepted on day 3: funded_at kept, the clock from day 3");
}

#[test]
fn an_invoice_paid_late_gets_the_whole_silence_period() {
    // Session 11's open item 5: an invoice is accepted at creation, and its service time was the
    // clock start whether or not the money had come, so an invoice paid after its service time
    // plus silence released the second the money landed. The clock now waits for the funding.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let mut t = h.terms(1);
    t.service_time = Some(T0 + DAY);
    let (escrow, _) = h.invoice(&t).expect("invoice");
    let s = h.settle_accounts(&escrow);
    h.set_time(T0 + 30 * DAY);
    h.fund(&escrow, AMOUNT);
    h.mark_funded(&escrow).expect("mark_funded");
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("not at once");
    assert!(err.contains("SilenceNotOver"), "{err}");
    // The buyer has every step too: an hour in, step 0 (all back) is in force.
    h.advance(3_600);
    let meta = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect("cancel on step 0");
    assert_eq!(ended(&events(&meta.logs)).3, AMOUNT);

    // And the seller waits the whole silence period after the money lands.
    let mut t2 = h.terms(2);
    t2.service_time = Some(T0 + DAY);
    h.set_time(T0);
    let (escrow2, _) = h.invoice(&t2).expect("invoice");
    let s2 = h.settle_accounts(&escrow2);
    h.set_time(T0 + 30 * DAY);
    h.fund(&escrow2, AMOUNT);
    h.mark_funded(&escrow2).expect("mark_funded");
    h.set_time(T0 + 37 * DAY);
    let err = h.send(&[release_by_silence_ix(&s2)], &[]).expect_err("the last second of silence");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 37 * DAY + 1);
    h.send(&[release_by_silence_ix(&s2)], &[]).expect("released seven days after the money");
    println!("an invoice due on day 1 and paid on day 30: silence and steps count from day 30");
}

#[test]
fn a_service_time_does_not_start_the_clock_before_the_funding_is_observed() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let mut t = h.terms(1);
    t.service_time = Some(T0 + DAY);
    let (escrow, _) = h.create(&t).expect("create");
    h.accept(&escrow).expect("accept, before any money");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, AMOUNT);
    h.set_time(T0 + 30 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("the funding was never observed");
    assert!(err.contains("ClockNotStarted"), "{err}");
    let err = h.send(&[cancel_buyer_ix(&s, buyer.pubkey())], &[&buyer]).expect_err("nor for the buyer");
    assert!(err.contains("ClockNotStarted"), "{err}");
    h.mark_funded(&escrow).expect("observed on day 30");
    h.set_time(T0 + 37 * DAY);
    let err = h.send(&[release_by_silence_ix(&s)], &[]).expect_err("silence from the observation");
    assert!(err.contains("SilenceNotOver"), "{err}");
    h.set_time(T0 + 37 * DAY + 1);
    h.send(&[release_by_silence_ix(&s)], &[]).expect("released");
    println!("a service time with no observed funding starts nothing; the observation on day 30 does");
}

// ---------------------------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------------------------

fn measure(h: &mut Harness, what: &str, ix: Instruction, signers: &[&Keypair]) -> (u64, usize) {
    let with_budget = vec![ComputeBudgetInstruction::set_compute_unit_limit(200_000), ix.clone()];
    h.svm.expire_blockhash();
    let msg = Message::new(&with_budget, Some(&h.payer.pubkey()));
    let mut keys: Vec<&Keypair> = vec![&h.payer];
    keys.extend_from_slice(signers);
    let tx = Transaction::new(&keys, msg, h.svm.latest_blockhash());
    let bytes = bincode::serialize(&tx).unwrap().len();
    let meta = h.send_tx(tx).unwrap_or_else(|e| panic!("{what}: {e}"));
    let cu = meta.compute_units_consumed;
    println!(
        "   {what:<19} {cu:>7} compute units ({:.1}% of 1,400,000)   {bytes:>4} bytes on the wire ({:.0}% of 1,232)   {} bytes of data, {} accounts",
        cu as f64 / 1_400_000.0 * 100.0,
        bytes as f64 / 1232.0 * 100.0,
        ix.data.len(),
        ix.accounts.len(),
    );
    assert!(bytes < 1232);
    assert!(cu < 200_000);
    (cu, bytes)
}

#[test]
fn what_each_step_costs() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    println!("\n== one escrow, a legacy transaction with a compute-budget instruction ==");

    // create, with the fullest terms: an arbiter, a service time and four steps.
    let mut t = h.terms(1);
    t.arbiter = Some(h.arbiter.pubkey());
    t.service_time = Some(T0 + 10 * DAY);
    t.steps = vec![step(-DAY, 10_000), step(0, 7_500), step(DAY, 2_500), step(2 * DAY, 0)];
    let a = h.create_accounts();
    measure(&mut h, "create", create_ix(&t, &a), &[&buyer]);
    let escrow = escrow_address(&buyer.pubkey(), 1);
    let vault = vault_address(&escrow, &h.mint);
    h.fund(&escrow, AMOUNT + 1);
    measure(&mut h, "accept", accept_ix(escrow, vault, seller.pubkey()), &[&seller]);
    let s = h.settle_accounts(&escrow);
    measure(&mut h, "approve (split)", approve_ix(&s, buyer.pubkey(), 7_000), &[&buyer]);

    let t2 = h.terms(2);
    let escrow2 = h.funded(&t2);
    let s2 = h.settle_accounts(&escrow2);
    h.set_time(T0 + 7 * DAY + 1);
    measure(&mut h, "release_by_silence", release_by_silence_ix(&s2), &[]);

    h.set_time(T0);
    let t3 = h.terms(3);
    let escrow3 = h.funded(&t3);
    let s3 = h.settle_accounts(&escrow3);
    h.set_time(T0 + 2 * DAY);
    measure(&mut h, "cancel_buyer", cancel_buyer_ix(&s3, buyer.pubkey()), &[&buyer]);

    let (escrow4, _) = h.create(&h.terms(4)).expect("create");
    h.fund(&escrow4, AMOUNT);
    let s4 = h.settle_accounts(&escrow4);
    measure(&mut h, "withdraw", withdraw_ix(&s4, buyer.pubkey()), &[&buyer]);

    let (escrow5, _) = h.create(&h.terms(5)).expect("create");
    let s5 = h.settle_accounts(&escrow5);
    measure(&mut h, "close_unfunded", close_unfunded_ix(&s5, seller.pubkey()), &[&seller]);

    // close_unaccepted by a stranger, who first has to make the buyer's refund address; then
    // recover_late on the same escrow, with the refund address already there.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let mut t6 = h.terms(6);
    t6.steps = vec![];
    let (escrow6, _) = h.create(&t6).expect("create");
    h.fund(&escrow6, AMOUNT);
    h.mark_funded(&escrow6).expect("mark_funded");
    h.advance(UNACCEPTED_DAYS * DAY + 1);
    let vault6 = vault_address(&escrow6, &h.mint);
    let ix = close_unaccepted_ix(escrow6, vault6, buyer.pubkey(), h.mint, h.payer.pubkey(), stranger.pubkey());
    measure(&mut h, "close_unaccepted", ix, &[&stranger]);
    let (ata_ix, _) = create_ata_idempotent_ix(buyer.pubkey(), escrow6, h.mint);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault6, buyer.pubkey(), 1)], &[&buyer]).expect("late money");
    let ix = recover_late_ix(escrow6, vault6, buyer.pubkey(), h.mint, stranger.pubkey());
    measure(&mut h, "recover_late", ix, &[&stranger]);

    // sweep_rent once the cuts have landed.
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let ix = sweep_rent_ix(escrow6, h.payer.pubkey());
    measure(&mut h, "sweep_rent", ix, &[]);
    println!();
}

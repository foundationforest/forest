//! The escrow, run under LiteSVM with the clock moved by hand.
//!
//! Run with `cargo test -- --nocapture` to see the measured compute units and transaction bytes.

use forest_escrow_tests::*;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// 1.00 at six decimals: the standard deal's amount.
const AMOUNT: u64 = 1_000_000;

fn zero() -> Address {
    Address::default()
}

fn closed(events: &[Event]) -> (Outcome, u64, u64, u64, u64) {
    let Some(Event::Closed { outcome, balance, to_seller, to_buyer, rent_lamports, .. }) =
        events.iter().find(|e| e.name() == "Closed")
    else {
        panic!("no Closed event in {events:?}")
    };
    (*outcome, *balance, *to_seller, *to_buyer, *rent_lamports)
}

fn names(events: &[Event]) -> Vec<&'static str> {
    events.iter().map(|e| e.name()).collect()
}

/// Both accounts gone, the rent payer whole again, the parties' balances as given.
fn assert_ended(h: &Harness, escrow: &Address, buyer_tokens: u64, seller_tokens: u64) {
    assert!(!h.exists(escrow), "the escrow account must be closed");
    assert!(!h.exists(&vault_address(escrow, &h.mint)), "the deposit account must be closed");
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
    assert_eq!(e.status, Status::Open);

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

    // Short by one base unit: not funded.
    h.fund(&escrow, AMOUNT - 1);
    let err = h.mark_funded(&escrow).expect_err("short");
    assert!(err.contains("NotFunded"), "{err}");
    assert_eq!(h.escrow(&escrow).status, Status::Open);

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

    // Money that arrived before the escrow did: create adopts the account and counts it funded.
    let t2 = h.terms(2);
    let escrow2 = escrow_address(&h.buyer.pubkey(), 2);
    let vault2 = vault_address(&escrow2, &h.mint);
    h.svm.set_account(vault2, spl_token_account(&h.mint, &escrow2, AMOUNT + 5)).unwrap();
    let (_, meta) = h.create(&t2).expect("create over an existing deposit account");
    assert_eq!(names(&events(&meta.logs)), ["Created", "Funded"]);
    let e2 = h.escrow(&escrow2);
    assert_eq!(e2.status, Status::Funded);
    assert_eq!(e2.funded_at, T0 + DAY);
    println!("funded by two plain transfers; a pre-funded deposit account is adopted at create");
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
    assert_eq!(names(&ev), ["Approved", "Closed"]);
    assert_eq!(ev[0], Event::Approved { escrow, seller_bps: 10_000, to_seller: AMOUNT, to_buyer: 500_000 });
    let (outcome, balance, to_seller, to_buyer, rent) = closed(&ev);
    assert_eq!((outcome, balance, to_seller, to_buyer), (Outcome::Approved, 1_500_000, AMOUNT, 500_000));
    assert_ended(&h, &escrow, BUYER_START - 1_500_000 + 500_000, AMOUNT);
    // The rent payer got both accounts' rent back. The same key paid the transaction fee, two
    // signatures at 5,000 lamports each, which is the only other thing that moved.
    assert_eq!(h.lamports(&h.payer.pubkey()), before + rent - 2 * 5_000, "rent back, one fee paid");

    // A split: 70% to the seller, 30% and the excess back.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.fund(&escrow2, 1_500_000);
    let meta = h.send(&[approve_ix(&s2, buyer.pubkey(), 7_000)], &[&buyer]).expect("approve split");
    let ev = events(&meta.logs);
    assert_eq!(ev[0], Event::Approved { escrow: escrow2, seller_bps: 7_000, to_seller: 700_000, to_buyer: 800_000 });
    assert_ended(&h, &escrow2, 9_000_000 - 1_500_000 + 800_000, 1_700_000);

    // Zero to the seller is a split too.
    let t3 = h.terms(3);
    let (escrow3, _) = h.create(&t3).expect("create");
    let s3 = h.settle_accounts(&escrow3);
    h.fund(&escrow3, AMOUNT);
    let meta = h.send(&[approve_ix(&s3, buyer.pubkey(), 0)], &[&buyer]).expect("approve nothing");
    assert_eq!(closed(&events(&meta.logs)).2, 0);
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
    assert_eq!(names(&ev), ["ReleasedBySilence", "Closed"]);
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
    assert_eq!(names(&ev), ["Agreed", "Closed"]);
    assert_eq!(ev[0], Event::Agreed { escrow, seller_bps: 4_000, to_seller: 400_000, to_buyer: 600_000 });
    assert_eq!(closed(&ev).0, Outcome::Agreed);
    assert_ended(&h, &escrow, BUYER_START - AMOUNT + 600_000, 400_000);

    // Agreement needs no lock: a funded, unlocked escrow can be agreed too, and so can one whose
    // funding was never marked.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.fund(&escrow2, AMOUNT);
    h.send(&[agree_ix(&s2, buyer.pubkey(), seller.pubkey(), 10_000)], &[&buyer, &seller]).expect("agree unlocked");
    assert_ended(&h, &escrow2, BUYER_START - 2 * AMOUNT + 600_000, 1_400_000);
    println!("objected on day six, silence refused on day 400, agreed 40/60");
}

#[test]
fn an_objection_is_also_the_first_observation_of_funding() {
    let mut h = Harness::new();
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
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
    assert_eq!(closed(&ev).0, Outcome::Arbitrated);
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
        assert_eq!(names(&ev), ["CancelledByBuyer", "Closed"]);
        assert_eq!(
            ev[0],
            Event::CancelledByBuyer { escrow, step: step_index, refund_bps, to_buyer: refund + 1, to_seller: AMOUNT - refund }
        );
        assert_eq!(closed(&ev).0, Outcome::CancelledByBuyer);
        assert!(!h.exists(&escrow));
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
    assert_eq!(names(&ev), ["CancelledBySeller", "Closed"]);
    assert_eq!(ev[0], Event::CancelledBySeller { escrow, seller: seller.pubkey(), to_buyer: AMOUNT + 123 });
    assert_eq!(closed(&ev).0, Outcome::CancelledBySeller);
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
fn a_never_funded_escrow_is_closed_by_the_seller_any_time_or_the_buyer_after_the_last_deadline() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();

    // Partly funded, closed by the seller at once: the part comes back, nothing is marked.
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
    let s = h.settle_accounts(&escrow);
    h.fund(&escrow, 400_000);
    let meta = h.send(&[close_ix(&s, seller.pubkey())], &[&seller]).expect("seller closes");
    let ev = events(&meta.logs);
    assert_eq!(names(&ev), ["Closed"]);
    assert_eq!(closed(&ev), (Outcome::NeverFunded, 400_000, 0, 400_000, closed(&ev).4));
    assert_ended(&h, &escrow, BUYER_START, 0);

    // The buyer waits for the last deadline, measured from creation when there is no service time.
    let t2 = h.terms(2); // last step at three days
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    h.set_time(T0 + 3 * DAY);
    let err = h.send(&[close_ix(&s2, buyer.pubkey())], &[&buyer]).expect_err("too soon");
    assert!(err.contains("BeforeLastDeadline"), "{err}");
    h.set_time(T0 + 3 * DAY + 1);
    h.send(&[close_ix(&s2, buyer.pubkey())], &[&buyer]).expect("buyer closes");
    assert_ended(&h, &escrow2, BUYER_START, 0);

    // With a service time, from that instead.
    let mut t3 = h.terms(3);
    t3.service_time = Some(T0 + 20 * DAY);
    t3.steps = vec![step(-DAY, 10_000)];
    h.set_time(T0);
    let (escrow3, _) = h.create(&t3).expect("create");
    let s3 = h.settle_accounts(&escrow3);
    h.set_time(T0 + 19 * DAY);
    let err = h.send(&[close_ix(&s3, buyer.pubkey())], &[&buyer]).expect_err("too soon");
    assert!(err.contains("BeforeLastDeadline"), "{err}");
    h.set_time(T0 + 19 * DAY + 1);
    h.send(&[close_ix(&s3, buyer.pubkey())], &[&buyer]).expect("buyer closes");

    // No steps: the buyer closes at once.
    let mut t4 = h.terms(4);
    t4.steps = vec![];
    h.set_time(T0);
    let (escrow4, _) = h.create(&t4).expect("create");
    let s4 = h.settle_accounts(&escrow4);
    h.send(&[close_ix(&s4, buyer.pubkey())], &[&buyer]).expect("buyer closes at once");
    assert!(!h.exists(&escrow4));
    println!("never funded: seller at once with the part back; buyer after day 3, after the service time's deadline, or at once with no steps");
}

#[test]
fn rent_returns_to_the_rent_payer_on_every_ending() {
    // A rent payer who is not the fee payer, so its balance moves only by rent.
    let mut h = Harness::new();
    let rent_payer = Keypair::new();
    h.svm.airdrop(&rent_payer.pubkey(), 1_000_000_000).unwrap();
    let start = h.lamports(&rent_payer.pubkey());
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let arbiter = h.arbiter.insecure_clone();

    let endings: [(&str, u64); 7] = [
        ("approve", 1),
        ("release_by_silence", 2),
        ("agree", 3),
        ("arbitrate", 4),
        ("cancel_buyer", 5),
        ("cancel_seller", 6),
        ("close", 7),
    ];
    for (name, id) in endings {
        h.set_time(T0);
        let mut t = h.terms(id);
        t.arbiter = Some(arbiter.pubkey());
        let a = CreateAccounts { buyer: buyer.pubkey(), payer: rent_payer.pubkey(), mint: h.mint };
        h.send(&[create_ix(&t, &a)], &[&buyer, &rent_payer]).expect("create");
        let escrow = escrow_address(&buyer.pubkey(), id);
        let vault = vault_address(&escrow, &h.mint);
        let held = h.lamports(&escrow) + h.lamports(&vault);
        assert_eq!(h.lamports(&rent_payer.pubkey()), start - held, "{name}: the rent payer paid both rents");
        assert!(held > 0);
        let mut s = h.settle_accounts(&escrow);
        s.rent_payer = rent_payer.pubkey();
        if name != "close" {
            h.fund(&escrow, AMOUNT);
            h.mark_funded(&escrow).expect("mark_funded");
        }
        let ix = match name {
            "approve" => approve_ix(&s, buyer.pubkey(), 10_000),
            "release_by_silence" => {
                h.set_time(T0 + 7 * DAY + 1);
                release_by_silence_ix(&s)
            }
            "agree" => agree_ix(&s, buyer.pubkey(), seller.pubkey(), 5_000),
            "arbitrate" => arbitrate_ix(&s, arbiter.pubkey(), 5_000),
            "cancel_buyer" => cancel_buyer_ix(&s, buyer.pubkey()),
            "cancel_seller" => cancel_seller_ix(&s, seller.pubkey()),
            "close" => close_ix(&s, seller.pubkey()),
            _ => unreachable!(),
        };
        let signers: Vec<&Keypair> = match name {
            "approve" | "cancel_buyer" => vec![&buyer],
            "release_by_silence" => vec![],
            "agree" => vec![&buyer, &seller],
            "arbitrate" => vec![&arbiter],
            "cancel_seller" | "close" => vec![&seller],
            _ => unreachable!(),
        };
        let meta = h.send(&[ix], &signers).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(closed(&events(&meta.logs)).4, held, "{name}: the Closed event says how much rent went back");
        assert_eq!(h.lamports(&rent_payer.pubkey()), start, "{name}: the rent payer is whole again");
        assert!(!h.exists(&escrow) && !h.exists(&vault), "{name}: both accounts closed");
    }
    println!("seven endings, {} lamports of rent out and back each time", {
        let t = h.terms(99);
        let a = CreateAccounts { buyer: buyer.pubkey(), payer: rent_payer.pubkey(), mint: h.mint };
        h.send(&[create_ix(&t, &a)], &[&buyer, &rent_payer]).expect("create");
        let e = escrow_address(&buyer.pubkey(), 99);
        h.lamports(&e) + h.lamports(&vault_address(&e, &h.mint))
    });
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

    // create: the buyer must sign. A stranger cannot open an escrow in someone's name.
    let t = h.terms(1);
    let a = h.create_accounts();
    let err = h.send(&[unsigned(create_ix(&t, &a), &buyer.pubkey())], &[]).expect_err("create unsigned");
    assert!(err.contains("AccountNotSigner"), "{err}");

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
        ("close by a stranger", close_ix(&s, stranger.pubkey()), vec![&stranger], "StillFunded"),
        ("approve with the buyer not signing", unsigned(approve_ix(&s, buyer.pubkey(), 10_000), &buyer.pubkey()), vec![], "AccountNotSigner"),
    ];
    for (what, ix, signers, want) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(err.contains(want), "{what}: expected {want}, got\n{err}");
    }

    // close by a stranger on a never-funded escrow: the rule after the funding check.
    let t2 = h.terms(2);
    let (escrow2, _) = h.create(&t2).expect("create");
    let s2 = h.settle_accounts(&escrow2);
    let err = h.send(&[close_ix(&s2, stranger.pubkey())], &[&stranger]).expect_err("close by a stranger");
    assert!(err.contains("NotAParty"), "{err}");

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
    println!("one base unit short: seven instructions refused, the money still in the deposit account");
}

#[test]
fn silence_is_refused_too_early_while_locked_and_before_the_clock_starts() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();

    // Funded but never observed, no service time: no clock to count from.
    let t = h.terms(1);
    let (escrow, _) = h.create(&t).expect("create");
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
    let err = h.send(&[close_ix(&s2, buyer.pubkey())], &[&buyer]).expect_err("funded");
    assert!(err.contains("StillFunded"), "{err}");
    println!("cancel after day 3, object after day 7, and cancel, approve, object and close under a lock: all refused");
}

#[test]
fn nothing_can_be_done_to_an_escrow_after_it_ends() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let seller = h.seller.insecure_clone();
    let t = h.terms(1);
    let escrow = h.funded(&t);
    let s = h.settle_accounts(&escrow);
    let vault = vault_address(&escrow, &h.mint);
    h.send(&[approve_ix(&s, buyer.pubkey(), 10_000)], &[&buyer]).expect("approve");

    let cases: Vec<(&str, Instruction, Vec<&Keypair>)> = vec![
        ("cancel_seller after release", cancel_seller_ix(&s, seller.pubkey()), vec![&seller]),
        ("approve again", approve_ix(&s, buyer.pubkey(), 10_000), vec![&buyer]),
        ("object", object_ix(escrow, vault, buyer.pubkey()), vec![&buyer]),
        ("mark_funded", mark_funded_ix(escrow, vault), vec![]),
        ("close", close_ix(&s, seller.pubkey()), vec![&seller]),
    ];
    for (what, ix, signers) in cases {
        let err = h.send(&[ix], &signers).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(
            err.contains("AccountNotInitialized") || err.contains("AccountOwnedByWrongProgram"),
            "{what}: the account is gone, got\n{err}"
        );
    }
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    println!("after approve the accounts are gone: five instructions find nothing there");
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
    println!("\n== one escrow, a legacy transaction with a compute-budget instruction ==");

    // create, with the fullest terms: an arbiter, a service time and four steps.
    let mut t = h.terms(1);
    t.arbiter = Some(h.arbiter.pubkey());
    t.service_time = Some(T0 + 10 * DAY);
    t.steps = vec![step(-DAY, 10_000), step(0, 7_500), step(DAY, 2_500), step(2 * DAY, 0)];
    let a = h.create_accounts();
    measure(&mut h, "create", create_ix(&t, &a), &[&buyer]);
    let escrow = escrow_address(&buyer.pubkey(), 1);
    h.fund(&escrow, AMOUNT + 1);
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
    println!();
}

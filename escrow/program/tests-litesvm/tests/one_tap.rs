//! Adversarial review 1, the product check: can "Pay" be one tap?
//!
//! The handoff now lets a product make every payment an escrow that releases in the same second,
//! so every payment leaves a receipt at an address a review can point at. That needs `create`, a
//! plain transfer into the deposit account and `approve` to ride in one transaction. This file
//! sends exactly that, measures it, and checks what it leaves behind.
//!
//! Session 11: the escrow account is no longer closed when an escrow that held the amount ends. A
//! one-tap payment therefore leaves a permanent receipt, and the payer keeps its rent in it; the
//! deposit account's rent still comes back in the same transaction. The rent is measured here at
//! today's rate and at the rate the cuts end at.
//!
//! Run with `cargo test --test one_tap -- --nocapture` for the numbers.

use forest_escrow_tests::*;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const AMOUNT: u64 = 1_000_000;
/// Lamports per byte: what session 3 read from mainnet, and where SIMD-0437's cuts end.
const RENT_TODAY: u64 = 5_080;
/// The dollar price of SOL the READMEs use for every rent figure.
const SOL_USD: f64 = 100.24;

struct Measured {
    cu: u64,
    bytes: usize,
    events: Vec<Event>,
}

fn send_measured(h: &mut Harness, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Measured {
    let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(200_000)];
    all.extend(ixs);
    h.svm.expire_blockhash();
    let msg = Message::new(&all, Some(&h.payer.pubkey()));
    let mut keys: Vec<&Keypair> = vec![&h.payer];
    keys.extend_from_slice(signers);
    let tx = Transaction::new(&keys, msg, h.svm.latest_blockhash());
    let bytes = bincode::serialize(&tx).unwrap().len();
    let meta = h.send_tx(tx).unwrap_or_else(|e| panic!("one tap: {e}"));
    Measured { cu: meta.compute_units_consumed, bytes, events: events(&meta.logs) }
}

#[test]
fn create_fund_and_approve_ride_in_one_transaction() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    println!("\n== one tap: create, a plain transfer into the deposit account, approve, in one transaction ==");

    // A sponsor (the transaction's fee payer) pays the rent; the buyer signs create, the transfer
    // and the approval. Market defaults: seven silence days, no steps, no arbiter, no service time.
    let mut t = h.terms(1);
    t.steps = vec![];
    let escrow = escrow_address(&buyer.pubkey(), t.id);
    let vault = vault_address(&escrow, &h.mint);
    let s = h.settle_accounts(&escrow);
    let payer_before = h.lamports(&h.payer.pubkey());
    let ixs = vec![
        create_ix(&t, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT),
        approve_ix(&s, buyer.pubkey(), 10_000),
    ];
    let m = send_measured(&mut h, ixs, &[&buyer]);
    let names: Vec<_> = m.events.iter().map(|e| e.name()).collect();
    assert_eq!(names, ["Created", "Approved", "Ended"], "the receipt: no Funded, since nobody observed funding separately");
    let Some(Event::Ended { outcome, balance, to_seller, accepted_at, rent_lamports, .. }) = m.events.last().cloned() else { unreachable!() };
    assert_eq!((outcome, balance, to_seller, accepted_at), (Outcome::Approved, AMOUNT, AMOUNT, 0));
    assert!(!h.exists(&vault), "the deposit account is closed");
    let e = h.escrow(&escrow);
    assert_eq!((e.status, e.outcome, e.to_seller), (Status::Ended, Some(Outcome::Approved), AMOUNT), "the escrow account stays: the receipt");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - AMOUNT);
    let fee = 2 * 5_000;
    let receipt_rent = h.lamports(&escrow);
    assert_eq!(h.lamports(&h.payer.pubkey()), payer_before - fee - receipt_rent, "the deposit account's rent came back; the receipt's stays");
    println!(
        "   seller already has a token account : {:>6} compute units ({:.1}% of 1,400,000)   {:>4} bytes ({:.0}% of 1,232)",
        m.cu,
        m.cu as f64 / 1_400_000.0 * 100.0,
        m.bytes,
        m.bytes as f64 / 1232.0 * 100.0
    );
    println!("   the deposit account's {rent_lamports} lamports of rent come back in the same transaction; the receipt keeps {receipt_rent}");

    // The seller has never held this token: the same transaction creates the seller's account
    // first. That account's rent is not returned; it is the seller's account from then on.
    let seller2 = Keypair::new();
    let mut t2 = h.terms(2);
    t2.steps = vec![];
    t2.seller = seller2.pubkey();
    let (ata_ix, seller2_tokens) = create_ata_idempotent_ix(h.payer.pubkey(), seller2.pubkey(), h.mint);
    let escrow2 = escrow_address(&buyer.pubkey(), t2.id);
    let vault2 = vault_address(&escrow2, &h.mint);
    let s2 = SettleAccounts { escrow: escrow2, vault: vault2, buyer_tokens: h.buyer_tokens, seller_tokens: seller2_tokens, rent_payer: h.payer.pubkey() };
    let ixs = vec![
        ata_ix,
        create_ix(&t2, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, vault2, buyer.pubkey(), AMOUNT),
        approve_ix(&s2, buyer.pubkey(), 10_000),
    ];
    let m2 = send_measured(&mut h, ixs, &[&buyer]);
    assert_eq!(h.balance(&seller2_tokens), AMOUNT);
    println!(
        "   and the seller's account made first : {:>6} compute units ({:.1}%)   {:>4} bytes ({:.0}%)",
        m2.cu,
        m2.cu as f64 / 1_400_000.0 * 100.0,
        m2.bytes,
        m2.bytes as f64 / 1232.0 * 100.0
    );

    // The fullest terms a market could set, to see the ceiling: arbiter, service time, four steps.
    let mut t3 = h.terms(3);
    t3.arbiter = Some(h.arbiter.pubkey());
    t3.service_time = Some(T0);
    t3.steps = vec![step(-DAY, 10_000), step(0, 7_500), step(DAY, 2_500), step(2 * DAY, 0)];
    let escrow3 = escrow_address(&buyer.pubkey(), t3.id);
    let vault3 = vault_address(&escrow3, &h.mint);
    let s3 = h.settle_accounts(&escrow3);
    let ixs = vec![
        create_ix(&t3, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, vault3, buyer.pubkey(), AMOUNT),
        approve_ix(&s3, buyer.pubkey(), 10_000),
    ];
    let m3 = send_measured(&mut h, ixs, &[&buyer]);
    println!(
        "   fullest terms                       : {:>6} compute units ({:.1}%)   {:>4} bytes ({:.0}%)",
        m3.cu,
        m3.cu as f64 / 1_400_000.0 * 100.0,
        m3.bytes,
        m3.bytes as f64 / 1232.0 * 100.0
    );
    for m in [&m, &m2, &m3] {
        assert!(m.bytes <= 1232, "fits one transaction");
        assert!(m.cu < 200_000);
    }

    // The receipt's rent, measured: the same one tap with the Rent sysvar at today's rate and at
    // the rate the cuts end at. The payer's balance moves by the fee and by the receipt's rent,
    // and by nothing else: the deposit account's rent is fronted and returned inside the
    // transaction.
    for (id, rate) in [(10u64, RENT_TODAY), (11, RENT_FINAL)] {
        h.svm.set_sysvar(&rent_at(rate));
        let mut t = h.terms(id);
        t.steps = vec![];
        let escrow = escrow_address(&buyer.pubkey(), t.id);
        let vault = vault_address(&escrow, &h.mint);
        let s = h.settle_accounts(&escrow);
        let before = h.lamports(&h.payer.pubkey());
        let ixs = vec![
            create_ix(&t, &h.create_accounts()),
            spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT),
            approve_ix(&s, buyer.pubkey(), 10_000),
        ];
        send_measured(&mut h, ixs, &[&buyer]);
        let kept = before - 2 * 5_000 - h.lamports(&h.payer.pubkey());
        assert_eq!(kept, h.lamports(&escrow), "the receipt holds exactly what the payer kept out");
        assert_eq!(kept, (128 + ESCROW_LEN as u64) * rate, "{ESCROW_LEN} bytes and the 128-byte overhead, at {rate} a byte");
        let usd = kept as f64 / 1e9 * SOL_USD;
        println!("   the receipt's rent at {rate:>5} lamports/byte: {kept:>9} lamports, ${usd:.4} at SOL ${SOL_USD}, kept for good");
    }
    println!();
}

#[test]
fn a_second_payment_to_a_one_tap_link_goes_back_to_the_buyer() {
    // An index reading a one-tap payment sees the same Created and Ended it would see for an escrow
    // that lived a week, and the same receipt at the same kind of address. The receipt is
    // permanent, so a second transfer to the same link later lands in a deposit account the
    // escrow will never pay out as part of the deal, and the address never reopens. Session 11
    // left that money stranded for good. Session 12's `recover_late` sends it back to the buyer's
    // refund address, and anyone may send it.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let mut t = h.terms(1);
    t.steps = vec![];
    let escrow = escrow_address(&buyer.pubkey(), t.id);
    let vault = vault_address(&escrow, &h.mint);
    let s = h.settle_accounts(&escrow);
    h.send(
        &[
            create_ix(&t, &h.create_accounts()),
            spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT),
            approve_ix(&s, buyer.pubkey(), 10_000),
        ],
        &[&buyer],
    )
    .expect("one tap");
    let receipt = h.account(&escrow);
    // Someone pays the same link again: a wallet makes the deposit account again (anyone may) and
    // sends.
    let (ata_ix, again) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    assert_eq!(again, vault);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT)], &[&buyer]).expect("a second payment");
    assert_eq!(h.balance(&vault), AMOUNT, "at a closed-over deposit address");
    let err = h.create(&t).expect_err("the buyer cannot reopen the id");
    assert!(err.contains("already in use"), "{err}");
    for ix in [approve_ix(&s, buyer.pubkey(), 10_000), withdraw_ix(&s, buyer.pubkey()), close_unfunded_ix(&s, buyer.pubkey())] {
        let err = h.send(&[ix], &[&buyer]).expect_err("the escrow has ended");
        assert!(err.contains("Ended") || err.contains("StillFunded"), "{err}");
    }
    // A stranger sends it back. The buyer's refund address does not exist yet; the stranger makes
    // it, and pays for it.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let refund = h.refund();
    assert!(!h.exists(&refund));
    let meta = h.recover_late(&escrow, &stranger).expect("recover_late");
    let names: Vec<_> = events(&meta.logs).iter().map(|e| e.name()).collect();
    assert_eq!(names, ["RecoveredLate"]);
    assert_eq!(h.balance(&refund), AMOUNT, "the second payment is back with the buyer");
    assert!(!h.exists(&vault), "and the deposit account is closed again");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt still says one payment");
    println!("a second payment to a one-tap link: sent back to the buyer's refund address by a stranger; the receipt unchanged");
}

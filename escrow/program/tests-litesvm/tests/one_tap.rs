//! Adversarial review 1, the product check: can "Pay" be one tap?
//!
//! The handoff now lets a product make every payment an escrow that releases in the same second,
//! so every payment leaves a receipt at an address a review can point at. That needs `create`, a
//! plain transfer into the deposit account and `approve` to ride in one transaction. This file
//! sends exactly that, measures it, and checks what it leaves behind.
//!
//! Run with `cargo test --test one_tap -- --nocapture` for the numbers.

use forest_escrow_tests::*;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const AMOUNT: u64 = 1_000_000;

/// The associated token program's `CreateIdempotent`: payer, account, owner, mint, system, token.
fn create_ata_idempotent_ix(payer: Address, owner: Address, mint: Address) -> (Instruction, Address) {
    let ata = vault_address(&owner, &mint); // the same derivation, for any owner
    let ix = Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![1],
    };
    (ix, ata)
}

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
    assert_eq!(names, ["Created", "Approved", "Closed"], "the receipt: no Funded, since nobody observed funding separately");
    let Some(Event::Closed { outcome, balance, to_seller, rent_lamports, .. }) = m.events.last().cloned() else { unreachable!() };
    assert_eq!((outcome, balance, to_seller), (Outcome::Approved, AMOUNT, AMOUNT));
    assert!(!h.exists(&escrow) && !h.exists(&vault), "nothing stays open");
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - AMOUNT);
    let fee = 2 * 5_000;
    assert_eq!(h.lamports(&h.payer.pubkey()), payer_before - fee, "the rent came back in the same transaction");
    println!(
        "   seller already has a token account : {:>6} compute units ({:.1}% of 1,400,000)   {:>4} bytes ({:.0}% of 1,232)",
        m.cu,
        m.cu as f64 / 1_400_000.0 * 100.0,
        m.bytes,
        m.bytes as f64 / 1232.0 * 100.0
    );
    println!("   rent fronted for the transaction's length: {rent_lamports} lamports, all of it back; the receipt costs no rent");

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
    // The escrow account is 286 bytes and the deposit account 165; with the 128-byte overhead
    // each, at 5,080 lamports a byte (today) and 696 (after the cuts).
    let bytes = (128 + 8 + 278) + (128 + 165);
    println!("   rent fronted at 5,080 lamports/byte: {} lamports; at 696: {}", bytes * 5_080, bytes * 696);
    println!();
}

#[test]
fn a_one_tap_receipt_is_the_same_record_as_a_slow_one() {
    // An index reading a one-tap payment sees the same Created and Closed it would see for an
    // escrow that lived a week, at an address it can look up later. Nothing is left open, so a
    // second transfer to the same address later is stranded until the buyer reopens that id.
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
    // Someone pays the same link again: a wallet makes the deposit account again (anyone may) and
    // sends. Nothing in the program can pay it out until the same buyer reopens the same id.
    let (ata_ix, again) = create_ata_idempotent_ix(h.payer.pubkey(), escrow, h.mint);
    assert_eq!(again, vault);
    h.send(&[ata_ix, spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT)], &[&buyer]).expect("a second payment");
    assert!(!h.exists(&escrow));
    assert_eq!(h.balance(&vault), AMOUNT, "stranded at a closed escrow's deposit address");
    let (_, meta) = h.create(&t).expect("the buyer reopens the id");
    assert_eq!(events(&meta.logs).iter().map(|e| e.name()).collect::<Vec<_>>(), ["Created", "Funded"]);
    println!("a second payment to a one-tap link is stranded until the buyer reopens the id, which adopts it as funded");
}

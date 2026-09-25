//! The one-tap payment: `create`, a plain transfer into the deposit account and
//! `release_to_seller`, in one transaction.
//!
//! A product may make every payment an escrow released in the same second, so every payment
//! leaves a receipt at an address a review can point at. This file sends exactly that, measures
//! it, and checks what it leaves behind: a permanent receipt, whose rent the payer keeps in it,
//! and the deposit account's rent back in the same transaction. The rent is measured at today's
//! rate and at the rate the cuts end at.
//!
//! Run with `cargo test --test one_tap -- --nocapture` for the numbers.

use forest_escrow_tests::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Lamports per byte: what session 3 read from mainnet.
const RENT_TODAY: u64 = 5_080;
/// The dollar price of SOL the READMEs use for every rent figure.
const SOL_USD: f64 = 100.24;

#[test]
fn create_fund_and_release_to_seller_ride_in_one_transaction() {
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    println!("\n== one tap: create, a plain transfer into the deposit account, release_to_seller, in one transaction ==");

    // Another key (the transaction's fee payer) pays the rent; the buyer signs create, the
    // transfer and the release. Every option off. The buyer's standard account is not named.
    let t = h.terms(1);
    let escrow = escrow_address(&buyer.pubkey(), t.id);
    let vault = vault_address(&escrow, &h.mint);
    let s = h.accounts(&escrow);
    let payer_before = h.lamports(&h.payer.pubkey());
    let ixs = [
        create_ix(&t, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, vault, buyer.pubkey(), AMOUNT),
        release_to_seller_ix(&s, buyer.pubkey()),
    ];
    let (_, _, ev) = h.measure("one tap, the seller's account already there", &ixs, &[&buyer]);
    assert_eq!(names(&ev), ["Created", "Ended"], "the receipt: no Funded, since no way out needs the mark");
    let (outcome, balance, to_seller, to_buyer, rent_lamports) = ended(&ev);
    assert_eq!((outcome, balance, to_seller, to_buyer), (Outcome::ReleasedToSeller, AMOUNT, AMOUNT, 0));
    h.assert_closed(&vault, "the deposit account");
    let e = h.escrow(&escrow);
    assert_eq!((e.status, e.outcome, e.to_seller, e.creator), (Status::Ended, Some(Outcome::ReleasedToSeller), AMOUNT, Side::Buyer));
    assert_eq!(h.balance(&h.seller_tokens), AMOUNT);
    assert_eq!(h.balance(&h.buyer_tokens), BUYER_START - AMOUNT);
    let fee = 2 * 5_000; // two signatures; the compute-budget instruction sets a limit, not a price
    let receipt_rent = h.lamports(&escrow);
    assert_eq!(h.lamports(&h.payer.pubkey()), payer_before - fee - receipt_rent, "the deposit account's rent came back; the receipt's stays");
    println!("   the deposit account's {rent_lamports} lamports of rent come back in the same transaction; the receipt keeps {receipt_rent}");

    // The seller has never held this token: the same transaction makes the seller's standard
    // account first. That account's rent is not returned; it is the seller's account from then on.
    let seller2 = Keypair::new();
    let t2 = Terms { seller: seller2.pubkey(), ..h.terms(2) };
    let (make, seller2_tokens) = create_ata_idempotent_ix(h.payer.pubkey(), seller2.pubkey(), h.mint);
    let escrow2 = escrow_address(&buyer.pubkey(), t2.id);
    let vault2 = vault_address(&escrow2, &h.mint);
    let s2 = Accounts { seller_tokens: seller2_tokens, ..h.accounts(&escrow2) };
    let ixs = [
        make,
        create_ix(&t2, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, vault2, buyer.pubkey(), AMOUNT),
        release_to_seller_ix(&s2, buyer.pubkey()),
    ];
    h.measure("one tap, the seller's account made first", &ixs, &[&buyer]);
    assert_eq!(h.balance(&seller2_tokens), AMOUNT);

    // Both options on, to see the ceiling: an arbiter and a timer.
    let mut t3 = h.terms(3);
    t3.arbiter = Some(h.arbiter.pubkey());
    t3.timer = Some(Timer { days: 7, to: Side::Seller });
    let escrow3 = escrow_address(&buyer.pubkey(), t3.id);
    let s3 = h.accounts(&escrow3);
    let ixs = [
        create_ix(&t3, &h.create_accounts()),
        spl_transfer_ix(h.buyer_tokens, s3.vault, buyer.pubkey(), AMOUNT),
        release_to_seller_ix(&s3, buyer.pubkey()),
    ];
    h.measure("one tap, an arbiter and a timer", &ixs, &[&buyer]);

    // An invoice paid in one tap: the seller opened it earlier; the buyer's app reads it, then pays
    // and releases in one transaction. The receipt says the seller created it.
    let (invoice, _) = h.invoice(&h.terms(4)).expect("invoice");
    let s4 = h.accounts(&invoice);
    let ixs = [spl_transfer_ix(h.buyer_tokens, s4.vault, buyer.pubkey(), AMOUNT), release_to_seller_ix(&s4, buyer.pubkey())];
    h.measure("an invoice paid in one tap", &ixs, &[&buyer]);
    assert_eq!((h.escrow(&invoice).creator, h.escrow(&invoice).outcome), (Side::Seller, Some(Outcome::ReleasedToSeller)));

    // The receipt's rent, measured: the same one tap with the Rent sysvar at today's rate and at
    // the rate the cuts end at. The payer's balance moves by the fee and by the receipt's rent,
    // and by nothing else: the deposit account's rent is fronted and returned inside the
    // transaction.
    for (id, rate) in [(10u64, RENT_TODAY), (11, RENT_FINAL)] {
        h.svm.set_sysvar(&rent_at(rate));
        let t = h.terms(id);
        let escrow = escrow_address(&buyer.pubkey(), t.id);
        let s = h.accounts(&escrow);
        let before = h.lamports(&h.payer.pubkey());
        h.send(
            &[
                create_ix(&t, &h.create_accounts()),
                spl_transfer_ix(h.buyer_tokens, s.vault, buyer.pubkey(), AMOUNT),
                release_to_seller_ix(&s, buyer.pubkey()),
            ],
            &[&buyer],
        )
        .expect("one tap");
        let kept = before - 2 * 5_000 - h.lamports(&h.payer.pubkey());
        assert_eq!(kept, h.lamports(&escrow), "the receipt holds exactly what the payer kept out");
        assert_eq!(kept, (128 + ESCROW_LEN as u64) * rate, "{ESCROW_LEN} bytes and the 128-byte overhead, at {rate} a byte");
        let usd = kept as f64 / 1e9 * SOL_USD;
        println!("   the receipt's rent at {rate:>5} lamports/byte: {kept:>9} lamports, ${usd:.4} at SOL ${SOL_USD}, kept for good");
    }
    print_cu_summary();
}

#[test]
fn a_second_payment_to_a_one_tap_link_goes_back_to_the_buyer() {
    // The receipt is permanent, so a second transfer to the same link lands in a deposit account
    // the escrow will never pay out as part of the deal, and the address never reopens.
    // `recover_late` sends it back to the buyer's standard account, and anyone may send it.
    let mut h = Harness::new();
    let buyer = h.buyer.insecure_clone();
    let t = h.terms(1);
    let escrow = escrow_address(&buyer.pubkey(), t.id);
    let s = h.accounts(&escrow);
    h.send(
        &[
            create_ix(&t, &h.create_accounts()),
            spl_transfer_ix(h.buyer_tokens, s.vault, buyer.pubkey(), AMOUNT),
            release_to_seller_ix(&s, buyer.pubkey()),
        ],
        &[&buyer],
    )
    .expect("one tap");
    let receipt = h.account(&escrow);
    // Someone pays the same link again: a wallet makes the deposit account again (anyone may) and
    // sends.
    let (make, again) = create_ata_idempotent_ix(buyer.pubkey(), escrow, h.mint);
    assert_eq!(again, s.vault);
    h.send(&[make, spl_transfer_ix(h.buyer_tokens, s.vault, buyer.pubkey(), AMOUNT)], &[&buyer]).expect("a second payment");
    assert_eq!(h.balance(&s.vault), AMOUNT, "at a closed-over deposit address");
    let err = h.create(&t).expect_err("the buyer cannot reopen the id");
    assert!(err.contains("already in use"), "{err}");
    let err = h.release_to_seller(&escrow).expect_err("the escrow has ended");
    assert!(err.contains("Ended"), "{err}");
    // A stranger sends it back. The buyer's standard account does not exist yet; the stranger
    // makes it, and pays for it.
    let stranger = h.someone();
    let refund = h.refund();
    h.drop_refund();
    let meta = h.recover_late(&escrow, &stranger).expect("recover_late");
    assert_eq!(names(&events(&meta.logs)), ["RecoveredLate"]);
    assert_eq!(h.balance(&refund), AMOUNT, "the second payment is back with the buyer");
    h.assert_closed(&s.vault, "the deposit account, again");
    assert_eq!(h.account(&escrow).data, receipt.data, "the receipt still says one payment");
    println!("a second payment to a one-tap link: sent back to the buyer's standard account by a stranger; the receipt unchanged");
}

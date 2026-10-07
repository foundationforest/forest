//! The registry's rules, one by one, against real person proofs.
//!
//! `cargo test -- --nocapture` prints what each test showed.

use forest_registry_tests::*;
use groth16_solana::decompression::{decompress_g1, decompress_g2};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// 2026-10-07, 00:00 UTC, and a day later.
const T1: i64 = 1_791_331_200;
const T2: i64 = T1 + 86_400;

fn ready() -> (Harness, Fixtures) {
    (Harness::new(), Fixtures::load())
}

/// Refused, and for the reason named: an error name from `errors.rs` or Anchor's, or a runtime
/// message.
fn refused(result: Result<litesvm::types::TransactionMetadata, String>, wants: &[&str]) -> String {
    let err = result.err().expect("must be refused");
    assert!(wants.iter().any(|w| err.contains(w)), "expected one of {wants:?}, got\n{err}");
    err
}

/// Send `args` as `p`'s profile, signed by it, paid by the harness.
fn send_args(h: &mut Harness, p: &FixtureProof, args: &Args) -> Result<litesvm::types::TransactionMetadata, String> {
    let key = p.main_key();
    let ix = register_ix(h.payer.pubkey(), key.pubkey(), args);
    h.send(&[ix], &[&key])
}

#[test]
fn a_row_is_written_with_its_main_key_stamp_issuer_payer_time_and_label() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    h.set_time(T1);
    let meta = h.register(alice).expect("register");

    let row = h.row(&alice.stamp());
    assert_eq!(row.profile, alice.profile_address());
    assert_eq!(row.stamp, alice.stamp());
    assert_eq!(row.issuer, f.issuer("A"));
    assert_eq!(row.payer, h.payer.pubkey());
    assert_eq!(row.made, T1);
    assert_eq!(row.label, "tutoring/seller");

    // Exactly its size, exactly rent exempt, owned by the program; nothing else in it, the tier
    // included.
    let account = h.account(&alice.row_address());
    assert_eq!(account.owner, PROGRAM_ID);
    assert_eq!(account.data.len(), row_space("tutoring/seller".len()));
    assert_eq!(account.data.len(), 195);
    assert_eq!(account.lamports, h.svm.minimum_balance_for_rent_exemption(account.data.len()));
    println!(
        "a row: {} bytes, {} lamports of deposit, {} compute units",
        account.data.len(),
        account.lamports,
        meta.compute_units_consumed
    );
}

#[test]
fn the_rows_time_is_set_by_the_program() {
    // register carries no time: the program reads the chain's clock. Two rows written a day apart
    // carry the two times, and the first is not touched by the second.
    let (mut h, f) = ready();
    let (alice, bob) = (f.proof("alice-tutoring-A"), f.proof("bob-tutoring-A"));
    let args = alice.args();
    assert_eq!(register_data(&args).len(), REGISTER_LABEL_AT + args.label.len(), "no field for a time");

    h.set_time(T1);
    h.register(alice).expect("Alice");
    h.set_time(T2);
    h.register(bob).expect("Bob");
    assert_eq!(h.row(&alice.stamp()).made, T1);
    assert_eq!(h.row(&bob.stamp()).made, T2);
    println!("the program set each row's time from the clock: {T1} and {T2}");
}

#[test]
fn the_profile_must_sign() {
    // Alice's proof, sent with her profile named but without her signature: refused, whoever pays.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let mut ix = register_ix(h.payer.pubkey(), alice.profile_address(), &alice.args());
    ix.accounts[1].is_signer = false;
    let result = h.send(&[ix], &[]);
    assert_eq!(custom_error(&result), Some(err::ACCOUNT_NOT_SIGNER), "{result:?}");
    assert!(!h.exists(&alice.row_address()));
    println!("refused as expected: a row without its main key's signature");
}

#[test]
fn a_stranger_cannot_register_my_profile_or_take_my_proof() {
    // A stranger who has Alice's proof (it is public once sent) can neither land it on her profile
    // without her signature, nor sign it under a profile of their own: the proof names hers.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let stranger = h.funded(1_000_000_000);
    let mut unsigned = register_ix(stranger.pubkey(), alice.profile_address(), &alice.args());
    unsigned.accounts[1].is_signer = false;
    assert_eq!(custom_error(&h.send_as(&stranger, &[unsigned])), Some(err::ACCOUNT_NOT_SIGNER));
    let theirs = register_ix(stranger.pubkey(), stranger.pubkey(), &alice.args());
    refused(h.send_as(&stranger, &[theirs]), &["ProofRejected"]);
    assert!(!h.exists(&alice.row_address()));
    h.register(alice).expect("Alice herself, after both");
    println!("refused as expected: Alice's proof without her signature, and under a stranger's profile");
}

#[test]
fn anyone_may_pay_the_profile_included() {
    // A fee payer pays for Alice's row and is recorded as its payer; Bob pays for his own.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let fee_payer = h.funded(1_000_000_000);
    h.register_paid_by(&fee_payer, alice).expect("a fee payer pays");
    let row = h.row(&alice.stamp());
    assert_eq!((row.profile, row.payer), (alice.profile_address(), fee_payer.pubkey()));

    let bob = f.proof("bob-tutoring-A");
    let key = bob.main_key();
    h.svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
    let ix = register_ix(key.pubkey(), key.pubkey(), &bob.args());
    assert_eq!(ix.accounts.iter().filter(|m| m.is_signer).count(), 2, "two metas, one key");
    h.send_as(&key, &[ix]).expect("the profile pays for itself");
    let row = h.row(&bob.stamp());
    assert_eq!((row.profile, row.payer), (key.pubkey(), key.pubkey()));
    println!("a fee payer paid for Alice's row; Bob's profile paid for its own");
}

#[test]
fn one_row_per_stamp() {
    // Alice at issuer A under tutoring/seller: one row. The same issuer and label for her second
    // profile is the same stamp: refused. Her second profile through issuer B is another stamp: it
    // lands. Another label at issuer A is another stamp too.
    let (mut h, f) = ready();
    let first = f.proof("alice-tutoring-A");
    let second_profile = f.proof("alice-tutoring-A-second-profile");
    let through_b = f.proof("alice-tutoring-B");
    let cleaning = f.proof("alice-cleaning-A");
    assert_eq!(first.stamp(), second_profile.stamp());
    assert_ne!(first.stamp(), through_b.stamp());
    assert_eq!(second_profile.profile, through_b.profile);

    h.register(first).expect("the first row");
    refused(h.register(second_profile), &["already in use"]);
    h.register(through_b).expect("another issuer");
    h.register(cleaning).expect("another label");
    let row = h.row(&first.stamp());
    assert_eq!(row.profile, first.profile_address(), "the first row is untouched");
    assert_eq!(h.row(&through_b.stamp()).issuer, f.issuer("B"));
    println!("one row per stamp: a second profile in one market needs a second issuer");
}

#[test]
fn a_row_never_changes() {
    // Register once, then try everything that could touch the row: the same stamp for another
    // profile, the same register again, a gift of lamports, refunds as the rate falls, and time
    // passing. Its bytes and its size stay exactly what register wrote; only its lamports move,
    // and only by refund.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = a.row_address();
    h.set_rent(RENT_TODAY);
    h.set_time(T1);
    h.register(a).expect("register");
    let written = h.account(&address).data;

    h.set_time(T2);
    let stranger = h.funded(1_000_000_000);
    refused(h.register(f.proof("alice-tutoring-A-second-profile")), &["already in use"]);
    refused(h.register_paid_by(&stranger, a), &["already in use"]);
    let gift = solana_system_interface::instruction::transfer(&stranger.pubkey(), &address, 1_000_000);
    h.send_as(&stranger, &[gift]).expect("a gift");
    h.send_as(&stranger, &[refund_ix(h.payer.pubkey(), address)]).expect("refund the gift");
    h.set_rent(RENT_FINAL);
    h.send_as(&stranger, &[refund_ix(h.payer.pubkey(), address)]).expect("refund after the cuts");

    let account = h.account(&address);
    assert_eq!(account.data, written, "byte for byte what register wrote");
    assert_eq!(read_row(&account.data).made, T1);
    assert_eq!(account.lamports, rent_minimum(RENT_FINAL, written.len()));
    println!("a row never changed: another profile, the same register, a gift, two refunds and a day");
}

#[test]
fn a_proof_with_another_stamp_is_refused() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    // Alice's proof under Bob's stamp, and under her own other label's.
    for other in [f.proof("bob-tutoring-A"), f.proof("alice-cleaning-A")] {
        let args = Args { stamp: other.stamp(), ..alice.args() };
        refused(send_args(&mut h, alice, &args), &["ProofRejected"]);
        assert!(!h.exists(&other.row_address()), "nothing written");
    }
    println!("refused as expected: a proof must give the stamp its row sits at");
}

#[test]
fn a_proof_is_bound_to_its_label_and_profile() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let cases: Vec<(&str, Keypair, String)> = vec![
        ("Bob's profile, signing", f.proof("bob-tutoring-A").main_key(), alice.label.clone()),
        ("Alice's other profile, signing", f.proof("alice-tutoring-B").main_key(), alice.label.clone()),
        ("a stranger's profile, signing", Keypair::new(), alice.label.clone()),
        ("another label", alice.main_key(), "cleaning/seller".into()),
        ("a lookalike label", alice.main_key(), "tutoring/seller ".into()),
        ("the label in capitals", alice.main_key(), "Tutoring/Seller".into()),
    ];
    for (what, key, label) in cases {
        let args = Args { label, ..alice.args() };
        let ix = register_ix(h.payer.pubkey(), key.pubkey(), &args);
        let err = h.send(&[ix], &[&key]).err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert!(err.contains("ProofRejected"), "{what}: {err}");
    }
    assert!(!h.exists(&alice.row_address()));
    println!("refused as expected: a proof counts for its own label and main key only");
}

#[test]
fn a_wrong_issuer_key_is_refused() {
    // The proof names the issuer whose note it showed. Any other key in register is refused:
    // the other issuer's, the same two numbers swapped, half of each, and zero.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let (a, b) = (f.issuer("A"), f.issuer("B"));
    assert_eq!(alice.args().issuer, a);
    let cases: Vec<(&str, [[u8; 32]; 2])> = vec![
        ("the other issuer's key", b),
        ("x and y swapped", [a[1], a[0]]),
        ("A's x with B's y", [a[0], b[1]]),
        ("zero", [[0u8; 32]; 2]),
        ("the identity point", [[0u8; 32], be32(1)]),
    ];
    for (what, issuer) in cases {
        let args = Args { issuer, ..alice.args() };
        let err = send_args(&mut h, alice, &args).err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert!(err.contains("ProofRejected"), "{what}: {err}");
    }
    assert!(!h.exists(&alice.row_address()));
    h.register(alice).expect("with the issuer's own key");
    println!("refused as expected: five wrong issuer keys");
}

#[test]
fn a_tier_the_issuer_did_not_sign_is_refused() {
    // Alice's note at issuer A says tier 2. The same proof claiming any other tier is refused, and
    // so is her issuer B proof (tier 1) claiming A's tier.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    assert_eq!(alice.args().tier, be32(2));
    for tier in [be32(0), be32(1), be32(3), [0xffu8; 32]] {
        let args = Args { tier, ..alice.args() };
        let err = send_args(&mut h, alice, &args).err().expect("accepted");
        assert!(err.contains("ProofRejected") || err.contains("NotAFieldElement"), "{err}");
    }
    let through_b = f.proof("alice-tutoring-B");
    let args = Args { tier: be32(2), ..through_b.args() };
    refused(send_args(&mut h, through_b, &args), &["ProofRejected"]);
    assert!(!h.exists(&alice.row_address()) && !h.exists(&through_b.row_address()));
    println!("refused as expected: a tier other than the one the issuer signed");
}

#[test]
fn a_forged_proof_is_refused() {
    // Points that are not this proof: another person's real proof under Alice's inputs, Alice's own
    // points rearranged, and points that are not on the curve. Bit flips are in adversarial.rs.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let good = alice.args();
    let bobs = f.proof("bob-tutoring-A").proof();
    let other_label = f.proof("alice-cleaning-A").proof();
    let cases: Vec<(&str, Proof)> = vec![
        ("Bob's proof", bobs),
        ("Alice's own proof for another label", other_label),
        ("A and C swapped", Proof { a: good.proof.c, c: good.proof.a, ..good.proof }),
        ("A from Bob's proof", Proof { a: bobs.a, ..good.proof }),
        ("all zero", Proof { a: [0u8; 32], b: [0u8; 64], c: [0u8; 32] }),
        ("all ones", Proof { a: [0xffu8; 32], b: [0xffu8; 64], c: [0xffu8; 32] }),
    ];
    for (what, proof) in cases {
        let args = Args { proof, ..good.clone() };
        let err = send_args(&mut h, alice, &args).err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert!(err.contains("ProofRejected") || err.contains("ProofMalformed"), "{what}: {err}");
    }
    assert!(!h.exists(&alice.row_address()));
    println!("refused as expected: six forged proofs");
}

#[test]
fn refund_reaches_the_payer() {
    // Registered at the old high rate; the rate falls in steps; anyone sends refund each time; the
    // payer the row records receives exactly what is above the new minimum, and the row keeps
    // exactly the minimum.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = a.row_address();
    let payer = h.funded(1_000_000_000);
    h.set_rent(RENT_HIGH);
    h.register_paid_by(&payer, a).expect("register");
    let size = h.account(&address).data.len();
    assert_eq!(h.lamports_of(&address), rent_minimum(RENT_HIGH, size));

    let stranger = h.funded(1_000_000_000);
    refused(h.send_as(&stranger, &[refund_ix(payer.pubkey(), address)]), &["NothingToRefund"]);
    let mut total = 0;
    for rate in [RENT_TODAY, RENT_FINAL] {
        h.set_rent(rate);
        let (row_before, payer_before) = (h.lamports_of(&address), h.lamports_of(&payer.pubkey()));
        h.send_as(&stranger, &[refund_ix(payer.pubkey(), address)]).expect("refund");
        let excess = row_before - rent_minimum(rate, size);
        assert_eq!(h.lamports_of(&payer.pubkey()) - payer_before, excess, "the payer got exactly the excess");
        assert_eq!(h.lamports_of(&address), rent_minimum(rate, size), "the row kept exactly the minimum");
        total += excess;
        refused(h.send_as(&stranger, &[refund_ix(payer.pubkey(), address)]), &["NothingToRefund"]);
    }
    assert_eq!(h.row(&a.stamp()).stamp, a.stamp(), "the data is untouched");

    // Lamports anyone sends to a row are the payer's too.
    let gift = solana_system_interface::instruction::transfer(&stranger.pubkey(), &address, 1_000_000);
    h.send_as(&stranger, &[gift]).expect("a gift");
    let payer_before = h.lamports_of(&payer.pubkey());
    h.send_as(&stranger, &[refund_ix(payer.pubkey(), address)]).expect("refund the gift");
    assert_eq!(h.lamports_of(&payer.pubkey()) - payer_before, 1_000_000);
    println!("refunded to the payer: {total} lamports as the rate fell from {RENT_HIGH} to {RENT_FINAL} a byte, and a gift");
}

#[test]
fn refund_goes_only_to_the_recorded_payer() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = a.row_address();
    h.set_rent(RENT_HIGH);
    h.register(a).expect("register");
    h.set_rent(RENT_FINAL);
    let thief = h.funded(1_000_000_000);
    let before = h.lamports_of(&address);
    for to in [thief.pubkey(), a.profile_address(), address] {
        refused(h.send_as(&thief, &[refund_ix(to, address)]), &["NotThePayer", "Duplicate"]);
    }
    assert_eq!(h.lamports_of(&address), before);
    // An address with no row has nothing to refund.
    refused(h.send_as(&thief, &[refund_ix(thief.pubkey(), f.proof("bob-tutoring-A").row_address())]), &["AccountNotInitialized"]);
    println!("refused as expected: a refund to anyone but the recorded payer");
}

#[test]
fn the_label_is_free_text_up_to_128_bytes() {
    let (mut h, f) = ready();
    let longest = f.proof("alice-longest-A");
    assert_eq!(longest.label.len(), MAX_LABEL);
    let meta = h.register(longest).expect("a 128-byte label");
    assert_eq!(h.row(&longest.stamp()).label, longest.label);
    assert_eq!(h.account(&longest.row_address()).data.len(), 308, "the largest row");
    // 129 bytes is refused before the proof is even looked at.
    let args = Args { label: format!("{}x", longest.label), stamp: [9u8; 32], ..longest.args() };
    refused(send_args(&mut h, longest, &args), &["LabelTooLong"]);
    println!("a 128-byte label registered ({} compute units); 129 bytes refused", meta.compute_units_consumed);
}

#[test]
fn every_fixture_carries_the_scope_message_and_issuer_the_program_derives() {
    // The scope and the message are the program's to derive; the client's fixtures must carry the
    // same ones, and each proof's issuer key must be its issuer's.
    let f = Fixtures::load();
    for p in &f.proofs {
        assert_eq!(from_hex32(&p.scope), scope_of(&p.label), "{}: scope", p.name);
        assert_eq!(from_hex32(&p.message), message_of(&p.profile_address()), "{}: message", p.name);
        assert_eq!(p.args().issuer, f.issuer(&p.issuer), "{}: issuer", p.name);
    }
    assert_ne!(f.issuer("A"), f.issuer("B"), "two issuers, two keys");
    println!("{} proofs: each scope, message and issuer key what the program and the fixtures say", f.proofs.len());
}

#[test]
fn the_clients_compressed_points_are_the_proofs_own_points() {
    // The client writes the compressed form. If a flag or a byte order were wrong, the program
    // would decompress to a different point and nothing would verify; this says so directly.
    let f = Fixtures::load();
    for p in &f.proofs {
        let q = p.proof();
        assert_eq!(decompress_g1(&q.a).unwrap().to_vec(), hex(&p.uncompressed.a), "{}: A", p.name);
        assert_eq!(decompress_g2(&q.b).unwrap().to_vec(), hex(&p.uncompressed.b), "{}: B", p.name);
        assert_eq!(decompress_g1(&q.c).unwrap().to_vec(), hex(&p.uncompressed.c), "{}: C", p.name);
    }
    println!("{} proofs: the compressed points decompress to exactly snarkjs's points", f.proofs.len());
}

#[test]
fn the_wire_format_written_twice_still_matches() {
    // The client's bytes (`wire`, written by scripts/fixtures.ts) against this file's own encoders,
    // and against what the program actually writes.
    let (mut h, f) = ready();
    let w = &f.wire;
    let a = f.proof("alice-tutoring-A");
    let payer = Keypair::new_from_array(from_hex32(&w.payer_seed));
    assert_eq!(payer.pubkey().to_string(), w.payer);
    assert_eq!(PROGRAM_ID.to_string(), w.program_id, "the program id");
    assert_eq!(a.row_address().to_string(), w.row_address, "the row's address");
    assert_eq!(register_data(&a.args()), hex(&w.register), "register's bytes");
    assert_eq!(refund_data(), hex(&w.refund), "refund's bytes");

    // The client's own bytes, sent as they are while the clock reads `made`, write exactly the
    // row the client expects.
    h.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    h.set_time(w.made);
    let profile = a.main_key();
    let row = a.row_address();
    use solana_instruction::{AccountMeta as M, Instruction};
    let register = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![M::new(row, false), M::new_readonly(profile.pubkey(), true), M::new(payer.pubkey(), true), M::new_readonly(SYSTEM_PROGRAM, false)],
        data: hex(&w.register),
    };
    h.send_signed(&payer.pubkey(), &[&payer, &profile], &[register]).expect("the client's register");
    assert_eq!(h.account(&row).data, hex(&w.row), "the row the program wrote is the client's expected bytes");
    let view = read_row(&hex(&w.row));
    assert_eq!((view.profile, view.stamp, view.payer, view.made), (a.profile_address(), a.stamp(), payer.pubkey(), w.made));
    h.set_rent(RENT_FINAL);
    let refund = Instruction { program_id: PROGRAM_ID, accounts: vec![M::new(row, false), M::new(payer.pubkey(), false)], data: hex(&w.refund) };
    h.send_as(&payer, &[refund]).expect("the client's refund");
    println!("the client's bytes and this harness's agree, and the program wrote exactly the expected row");
}

#[test]
fn what_a_row_costs() {
    // Bytes on the wire and compute units, one proof per transaction, signed by the profile and a
    // separate payer, with no compute-budget instruction. Solana's default limit for one
    // instruction is 200,000 units; each must fit under it.
    let (mut h, f) = ready();
    let short = f.proof("alice-tutoring-A");
    let longest = f.proof("alice-longest-A");
    let mut rows = vec![];
    for (what, p) in [("register, a 15-byte label", short), ("register, a 128-byte label", longest)] {
        let profile = p.main_key();
        let ix = register_ix(h.payer.pubkey(), profile.pubkey(), &p.args());
        let msg = Message::new(std::slice::from_ref(&ix), Some(&h.payer.pubkey()));
        let bytes = bincode::serialize(&Transaction::new(&[&h.payer, &profile], msg, h.svm.latest_blockhash())).unwrap().len();
        let cu = h.send(&[ix], &[&profile]).expect(what).compute_units_consumed;
        rows.push((what, bytes, cu));
    }
    h.set_rent(RENT_FINAL);
    let ix = refund_ix(h.payer.pubkey(), short.row_address());
    let msg = Message::new(std::slice::from_ref(&ix), Some(&h.payer.pubkey()));
    let bytes = bincode::serialize(&Transaction::new(&[&h.payer], msg, h.svm.latest_blockhash())).unwrap().len();
    rows.push(("refund", bytes, h.send(&[ix], &[]).expect("refund").compute_units_consumed));

    println!("| | bytes of 1,232 | compute units of 200,000 |");
    for (what, bytes, cu) in &rows {
        println!("| {what} | {bytes} | {cu} |");
        assert!(*bytes <= 1_232, "{what}: {bytes} bytes");
        assert!(*cu < 200_000, "{what}: {cu} units, over the default limit");
    }
    let deposit = |rate: u64, label: usize| rent_minimum(rate, row_space(label));
    println!(
        "deposit for a 15-byte label: {} lamports today ({} a byte), {} after the cuts ({}); a 128-byte label: {} today, {} after",
        deposit(RENT_TODAY, 15),
        RENT_TODAY,
        deposit(RENT_FINAL, 15),
        RENT_FINAL,
        deposit(RENT_TODAY, MAX_LABEL),
        deposit(RENT_FINAL, MAX_LABEL),
    );
    assert_eq!((deposit(RENT_TODAY, 15), deposit(RENT_FINAL, 15)), (1_640_840, 224_808));
}

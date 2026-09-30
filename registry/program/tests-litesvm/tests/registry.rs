//! The registry's rules, one by one, against real Semaphore proofs.
//!
//! `cargo test -- --nocapture` prints what each test showed.

use forest_registry_tests::*;
use groth16_solana::decompression::{decompress_g1, decompress_g2};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

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

#[test]
fn a_line_is_written_with_its_profile_code_label_root_time_and_payer() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    h.set_time(1_790_000_123);
    let meta = h.register(alice).expect("register");

    let line = h.line(&alice.code_bytes());
    assert_eq!(line.profile, alice.profile_address());
    assert_eq!(line.code, alice.code_bytes());
    assert_eq!(line.payer, h.payer.pubkey());
    assert_eq!(line.time, 1_790_000_123);
    assert_eq!(line.label, "tutoring/seller");
    assert_eq!(line.roots, vec![alice.proof().root]);
    let address = line_address(&alice.code_bytes());
    assert_eq!(line.bump, Address::find_program_address(&[b"code", &alice.code_bytes()], &PROGRAM_ID).1, "the canonical bump");

    // Exactly its size, exactly rent exempt, owned by the program.
    let account = h.account(&address);
    assert_eq!(account.owner, PROGRAM_ID);
    assert_eq!(account.data.len(), line_space("tutoring/seller".len(), 1));
    assert_eq!(account.lamports, h.svm.minimum_balance_for_rent_exemption(account.data.len()));
    println!(
        "a line: {} bytes, {} lamports of deposit, {} compute units; the profile signed nothing",
        account.data.len(),
        account.lamports,
        meta.compute_units_consumed
    );
}

#[test]
fn the_profile_key_signs_nothing_and_anyone_may_send() {
    // A relayer sends Alice's register and pays for it. Alice's profile key is not in the
    // transaction at all: the proof names it, and only her secret could have made the proof.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let relayer = h.funded(1_000_000_000);
    let ix = register_fixture_ix(relayer.pubkey(), alice);
    assert!(ix.accounts.iter().all(|m| m.pubkey != alice.profile_address()), "the profile is not an account");
    assert_eq!(ix.accounts.iter().filter(|m| m.is_signer).count(), 1, "only the payer signs");
    h.send_as(&relayer, &[ix]).expect("a relayer registers for Alice");
    let line = h.line(&alice.code_bytes());
    assert_eq!((line.profile, line.payer), (alice.profile_address(), relayer.pubkey()));
    println!("a relayer registered Alice's line and is recorded as its payer; her profile key signed nothing");
}

#[test]
fn several_proofs_from_several_roots_make_one_line() {
    // One proof per transaction: register with list A, then one add_proof each for list B and for
    // list A as it grew. One line, its roots in the order they came, 32 bytes more per root, each
    // paid by that transaction's payer.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    let a1 = f.proof("alice-tutoring-A1");
    let address = line_address(&a.code_bytes());
    h.register(a).expect("register against A");
    let before = h.account(&address).lamports;

    let other_payer = h.funded(1_000_000_000);
    let paid_before = h.lamports_of(&other_payer.pubkey());
    let meta = h
        .send_as(&other_payer, &[add_proof_ix(other_payer.pubkey(), &b.code_bytes(), &b.proof())])
        .expect("add B, another payer");
    let grown = h.account(&address);
    assert_eq!(grown.data.len(), line_space(a.label.len(), 2));
    assert_eq!(grown.lamports, h.svm.minimum_balance_for_rent_exemption(grown.data.len()));
    assert_eq!(
        paid_before - h.lamports_of(&other_payer.pubkey()),
        grown.lamports - before + 5_000,
        "the add_proof payer paid exactly the 32 bytes and one signature"
    );
    h.add_proof(a1).expect("add A, grown");

    let line = h.line(&a.code_bytes());
    assert_eq!(line.roots, vec![a.proof().root, b.proof().root, a1.proof().root]);
    assert_eq!(line.payer, h.payer.pubkey(), "the payer recorded is register's, whoever adds");
    println!(
        "one line, three roots from two issuers' lists; each add_proof: {} compute units, 32 bytes",
        meta.compute_units_consumed
    );
}

#[test]
fn a_second_line_for_the_same_code_is_refused() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    h.register(a).expect("first");
    // The same human, the same label, another issuer's list: the same code, so the same address.
    refused(h.register(b), &["already in use"]);
    // The very same register again, by a stranger.
    let stranger = h.funded(1_000_000_000);
    refused(h.send_as(&stranger, &[register_fixture_ix(stranger.pubkey(), a)]), &["already in use"]);
    let line = h.line(&a.code_bytes());
    assert_eq!((line.roots.len(), line.payer), (1, h.payer.pubkey()), "nothing about the first line moved");
    println!("refused as expected: a second line for the same code, from another list or the same proof again");
}

#[test]
fn a_proof_with_a_different_code_is_refused() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let bob = f.proof("bob-tutoring-A");
    let alice_cleaning = f.proof("alice-cleaning-A");

    // register: Alice's proof under Bob's code, and under her own other label's code.
    for code in [bob.code_bytes(), alice_cleaning.code_bytes()] {
        let ix = register_ix(h.payer.pubkey(), &alice.profile_address(), &alice.label, &code, &alice.proof());
        refused(h.send(&[ix], &[]), &["ProofRejected"]);
        assert!(!h.exists(&line_address(&code)), "nothing written");
    }

    // add_proof: into Alice's line, Carol's proof against list B, a root the line lacks: it yields
    // Carol's code, not the line's. (Bob's proof and Alice's other label's share list A's root,
    // already in the line, so they are refused one rule earlier.)
    h.register(alice).expect("Alice's line");
    let carol = f.proof("carol-tutoring-B");
    let ix = add_proof_ix(h.payer.pubkey(), &alice.code_bytes(), &carol.proof());
    refused(h.send(&[ix], &[]), &["ProofRejected"]);
    for other in [bob, alice_cleaning] {
        let ix = add_proof_ix(h.payer.pubkey(), &alice.code_bytes(), &other.proof());
        refused(h.send(&[ix], &[]), &["RootAlreadyInLine"]);
    }
    // And the other way round: the other proof sent under its own code, where no line is.
    refused(h.add_proof(bob), &["AccountNotInitialized"]);
    assert_eq!(h.line(&alice.code_bytes()).roots.len(), 1);
    println!("refused as expected: every proof must yield the line's one code");
}

#[test]
fn a_proof_is_bound_to_its_label_and_profile() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let bob = f.proof("bob-tutoring-A");
    let code = alice.code_bytes();
    let cases: Vec<(&str, Address, String)> = vec![
        ("Bob's profile", bob.profile_address(), alice.label.clone()),
        ("a stranger's profile", Keypair::new().pubkey(), alice.label.clone()),
        ("another label", alice.profile_address(), "cleaning/seller".into()),
        ("a lookalike label", alice.profile_address(), "tutoring/seller ".into()),
        ("the label in capitals", alice.profile_address(), "Tutoring/Seller".into()),
    ];
    for (what, profile, label) in cases {
        let ix = register_ix(h.payer.pubkey(), &profile, &label, &code, &alice.proof());
        let err = h.send(&[ix], &[]).err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert!(err.contains("ProofRejected"), "{what}: {err}");
    }
    assert!(!h.exists(&line_address(&code)));

    // add_proof reads the label and the profile from the line itself. A line planted with another
    // profile or another label under Alice's code (as if it had been written for them) takes none
    // of her proofs.
    h.register(alice).expect("Alice's line");
    let address = line_address(&code);
    let real = h.account(&address);
    for (what, patch) in [("another profile", 0usize), ("another label", 1usize)] {
        let mut planted = real.clone();
        if patch == 0 {
            planted.data[8..40].copy_from_slice(bob.profile_address().as_ref());
        } else {
            planted.data[117] = b'T'; // "Tutoring/seller"
        }
        h.svm.set_account(address, planted).unwrap();
        let b = f.proof("alice-tutoring-B");
        let err = h.add_proof(b).err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert!(err.contains("ProofRejected"), "{what}: {err}");
    }
    println!("refused as expected: a proof counts for its own label and profile only, in register and in add_proof");
}

#[test]
fn anyone_may_add_a_root_the_person_proved() {
    // The proof is the authority, not a key: a stranger who holds Alice's proof for list B (she
    // sent it, it is public) lands it, pays for it, and changes nothing but adding that root.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    h.register(a).expect("register");
    let stranger = h.funded(1_000_000_000);
    h.send_as(&stranger, &[add_proof_ix(stranger.pubkey(), &b.code_bytes(), &b.proof())]).expect("a stranger adds B");
    let line = h.line(&a.code_bytes());
    assert_eq!(line.roots, vec![a.proof().root, b.proof().root]);
    assert_eq!((line.profile, line.payer), (a.profile_address(), h.payer.pubkey()));
    println!("a stranger added a root Alice proved; the line still names her profile and her payer");
}

#[test]
fn a_root_already_in_the_line_is_refused() {
    // A proof is public once sent. Without this rule a stranger could replay one proof until the
    // line was full, and no other issuer could ever be added.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    h.register(a).expect("register");
    refused(h.add_proof(a), &["RootAlreadyInLine"]);
    h.add_proof(b).expect("add B");
    let stranger = h.funded(1_000_000_000);
    for p in [a, b] {
        let ix = add_proof_ix(stranger.pubkey(), &p.code_bytes(), &p.proof());
        refused(h.send_as(&stranger, &[ix]), &["RootAlreadyInLine"]);
    }
    // Two copies in one transaction: the second is refused, and with it the first.
    h.register(f.proof("bob-tutoring-A")).expect("Bob's line");
    let a1 = f.proof("alice-tutoring-A1");
    let ix = add_proof_ix(h.payer.pubkey(), &a1.code_bytes(), &a1.proof());
    refused(h.send(&[ix.clone(), ix], &[]), &["RootAlreadyInLine"]);
    assert_eq!(h.line(&a.code_bytes()).roots.len(), 2);
    println!("refused as expected: a root already in the line, from its human, a stranger, or twice in one transaction");
}

#[test]
fn a_line_holds_sixteen_roots_and_refuses_a_seventeenth() {
    let (mut h, f) = ready();
    let proofs = f.alice_tutoring();
    assert_eq!(proofs.len(), MAX_ROOTS + 1);
    h.register(proofs[0]).expect("register");
    for p in &proofs[1..MAX_ROOTS] {
        h.add_proof(p).expect("add");
    }
    let code = proofs[0].code_bytes();
    let line = h.line(&code);
    assert_eq!(line.roots.len(), MAX_ROOTS);
    assert_eq!(h.account(&line_address(&code)).data.len(), line_space(line.label.len(), MAX_ROOTS));
    refused(h.add_proof(proofs[MAX_ROOTS]), &["LineFull"]);
    assert_eq!(h.line(&code).roots.len(), MAX_ROOTS);
    println!("a line held sixteen distinct roots and refused a seventeenth, a real one");
}

#[test]
fn refund_reaches_the_payer() {
    // Registered at the old high rate; the rate falls in steps; anyone sends refund each time; the
    // payer the line records receives exactly what is above the new minimum, and the line keeps
    // exactly the minimum.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let code = a.code_bytes();
    let address = line_address(&code);
    let payer = h.funded(1_000_000_000);
    h.set_rent(RENT_HIGH);
    h.send_as(&payer, &[register_fixture_ix(payer.pubkey(), a)]).expect("register");
    let size = h.account(&address).data.len();
    assert_eq!(h.lamports_of(&address), rent_minimum(RENT_HIGH, size));

    let stranger = h.funded(1_000_000_000);
    refused(h.send_as(&stranger, &[refund_ix(payer.pubkey(), &code)]), &["NothingToRefund"]);
    let mut total = 0;
    for rate in [RENT_TODAY, RENT_FINAL] {
        h.set_rent(rate);
        let (line_before, payer_before) = (h.lamports_of(&address), h.lamports_of(&payer.pubkey()));
        h.send_as(&stranger, &[refund_ix(payer.pubkey(), &code)]).expect("refund");
        let excess = line_before - rent_minimum(rate, size);
        assert_eq!(h.lamports_of(&payer.pubkey()) - payer_before, excess, "the payer got exactly the excess");
        assert_eq!(h.lamports_of(&address), rent_minimum(rate, size), "the line kept exactly the minimum");
        total += excess;
        refused(h.send_as(&stranger, &[refund_ix(payer.pubkey(), &code)]), &["NothingToRefund"]);
    }
    assert_eq!(h.line(&code).roots.len(), 1, "the data is untouched");

    // Lamports anyone sends to a line are the payer's too.
    let gift = solana_system_interface::instruction::transfer(&stranger.pubkey(), &address, 1_000_000);
    h.send_as(&stranger, &[gift]).expect("a gift");
    let payer_before = h.lamports_of(&payer.pubkey());
    h.send_as(&stranger, &[refund_ix(payer.pubkey(), &code)]).expect("refund the gift");
    assert_eq!(h.lamports_of(&payer.pubkey()) - payer_before, 1_000_000);
    println!("refunded to the payer: {total} lamports as the rate fell from {RENT_HIGH} to {RENT_FINAL} a byte, and a gift");
}

#[test]
fn refund_goes_only_to_the_recorded_payer() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let code = a.code_bytes();
    h.set_rent(RENT_HIGH);
    h.register(a).expect("register");
    h.set_rent(RENT_FINAL);
    let thief = h.funded(1_000_000_000);
    let before = h.lamports_of(&line_address(&code));
    for to in [thief.pubkey(), a.profile_address(), line_address(&code)] {
        refused(h.send_as(&thief, &[refund_ix(to, &code)]), &["NotThePayer", "Duplicate"]);
    }
    assert_eq!(h.lamports_of(&line_address(&code)), before);
    // A code with no line has nothing to refund.
    refused(h.send_as(&thief, &[refund_ix(thief.pubkey(), &f.proof("bob-tutoring-A").code_bytes())]), &["AccountNotInitialized"]);
    println!("refused as expected: a refund to anyone but the recorded payer");
}

#[test]
fn the_label_is_free_text_up_to_128_bytes() {
    let (mut h, f) = ready();
    let longest = f.proof("alice-longest-A");
    assert_eq!(longest.label.len(), MAX_LABEL);
    let meta = h.register(longest).expect("a 128-byte label");
    assert_eq!(h.line(&longest.code_bytes()).label, longest.label);
    // 129 bytes is refused before the proof is even looked at.
    let ix = register_ix(h.payer.pubkey(), &longest.profile_address(), &format!("{}x", longest.label), &[9u8; 32], &longest.proof());
    refused(h.send(&[ix], &[]), &["LabelTooLong"]);
    println!("a 128-byte label registered ({} compute units); 129 bytes refused", meta.compute_units_consumed);
}

#[test]
fn every_fixture_root_is_its_lists_leanimt_root() {
    // The program takes roots as given, so this is the client's side: each proof's root is the root
    // of the list it names, rebuilt here the slow way.
    let f = Fixtures::load();
    for p in &f.proofs {
        assert_eq!(lean_imt_root(&f.commitments_of(p)), p.proof().root, "{}", p.name);
        assert_eq!(from_hex32(&p.scope), scope_of(&p.label), "{}: scope", p.name);
        assert_eq!(from_hex32(&p.message), message_of(&p.profile_address()), "{}: message", p.name);
    }
    let roots: std::collections::HashSet<_> = f.alice_tutoring().iter().map(|p| p.proof().root).collect();
    assert_eq!(roots.len(), MAX_ROOTS + 1, "Alice's tutoring roots are all distinct");
    println!("{} proofs: each root is its list's, each scope and message what the program derives", f.proofs.len());
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
    let b = f.proof("alice-tutoring-B");
    let code = a.code_bytes();
    let payer = Keypair::new_from_array(from_hex32(&w.payer_seed));
    assert_eq!(payer.pubkey().to_string(), w.payer);
    assert_eq!(PROGRAM_ID.to_string(), w.program_id, "the program id");
    assert_eq!(line_address(&code).to_string(), w.line_address, "the line's address");
    assert_eq!(register_data(&a.profile_address(), &a.label, &code, &a.proof()), hex(&w.register), "register's bytes");
    assert_eq!(add_proof_data(&code, &b.proof()), hex(&w.add_proof), "add_proof's bytes");
    assert_eq!(refund_data(&code), hex(&w.refund), "refund's bytes");

    // The client's own bytes, sent as they are, write exactly the line the client expects.
    h.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    h.set_time(w.time);
    let ix = |data: &str, accounts: Vec<solana_instruction::AccountMeta>| solana_instruction::Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data: hex(data),
    };
    let line = line_address(&code);
    let system = solana_system_interface::program::ID;
    use solana_instruction::AccountMeta as M;
    h.send_as(&payer, &[ix(&w.register, vec![M::new(line, false), M::new(payer.pubkey(), true), M::new_readonly(system, false)])])
        .expect("the client's register");
    h.send_as(&payer, &[ix(&w.add_proof, vec![M::new(line, false), M::new(payer.pubkey(), true), M::new_readonly(system, false)])])
        .expect("the client's add_proof");
    assert_eq!(h.account(&line).data, hex(&w.line), "the line the program wrote is the client's expected bytes");
    let view = read_line(&hex(&w.line));
    assert_eq!((view.profile, view.payer, view.time, view.roots.len()), (a.profile_address(), payer.pubkey(), w.time, 2));
    h.set_rent(RENT_FINAL);
    h.send_as(&payer, &[ix(&w.refund, vec![M::new(line, false), M::new(payer.pubkey(), false)])]).expect("the client's refund");
    println!("the client's bytes and this harness's agree, and the program wrote exactly the expected line");
}

#[test]
fn what_a_line_costs() {
    // Bytes on the wire and compute units, one proof per transaction, each with one signature (the
    // payer) and no compute-budget instruction. Solana's default limit for one instruction is
    // 200,000 units; each must fit under it.
    let (mut h, f) = ready();
    let short = f.proof("alice-tutoring-A");
    let longest = f.proof("alice-longest-A");
    let b = f.proof("alice-tutoring-B");
    let size = |h: &Harness, ix: &solana_instruction::Instruction| {
        let msg = Message::new(std::slice::from_ref(ix), Some(&h.payer.pubkey()));
        let tx = Transaction::new(&[&h.payer], msg, h.svm.latest_blockhash());
        bincode::serialize(&tx).unwrap().len()
    };
    let mut rows = vec![];
    for (what, ix) in [
        ("register, a 15-byte label", register_fixture_ix(h.payer.pubkey(), short)),
        ("register, a 128-byte label", register_fixture_ix(h.payer.pubkey(), longest)),
    ] {
        let bytes = size(&h, &ix);
        let cu = h.send(&[ix], &[]).expect(what).compute_units_consumed;
        rows.push((what, bytes, cu));
    }
    let ix = add_proof_ix(h.payer.pubkey(), &b.code_bytes(), &b.proof());
    let bytes = size(&h, &ix);
    rows.push(("add_proof", bytes, h.send(&[ix], &[]).expect("add").compute_units_consumed));
    h.set_rent(RENT_FINAL);
    let ix = refund_ix(h.payer.pubkey(), &short.code_bytes());
    let bytes = size(&h, &ix);
    rows.push(("refund", bytes, h.send(&[ix], &[]).expect("refund").compute_units_consumed));

    println!("| | bytes of 1,232 | compute units of 200,000 |");
    for (what, bytes, cu) in &rows {
        println!("| {what} | {bytes} | {cu} |");
        assert!(*bytes <= 1_232, "{what}: {bytes} bytes");
        assert!(*cu < 200_000, "{what}: {cu} units, over the default limit");
    }
    let deposit = |rate: u64, label: usize, roots: usize| rent_minimum(rate, line_space(label, roots));
    println!(
        "deposit for a 15-byte label, one root: {} lamports today ({} a byte), {} after the cuts ({}); each more root {} today",
        deposit(RENT_TODAY, 15, 1),
        RENT_TODAY,
        deposit(RENT_FINAL, 15, 1),
        RENT_FINAL,
        32 * RENT_TODAY
    );
}

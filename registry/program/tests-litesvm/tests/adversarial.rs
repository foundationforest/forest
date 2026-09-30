//! Attacks on the registry: bent proofs, replays, substituted and planted accounts, front-running,
//! and the rent. Each test says what it tried and that it failed, or, for a `finding_`, what it
//! showed that is true by design.

use forest_registry_tests::*;
use num_bigint::BigUint;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const BN254_R: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

fn ready() -> (Harness, Fixtures) {
    (Harness::new(), Fixtures::load())
}

fn add_be(a: &[u8; 32], b: &str) -> [u8; 32] {
    let sum = BigUint::from_bytes_be(a) + b.parse::<BigUint>().unwrap();
    let bytes = sum.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn expect_err(result: Result<litesvm::types::TransactionMetadata, String>, what: &str, wants: &[&str]) {
    let err = result.err().unwrap_or_else(|| panic!("{what}: accepted"));
    assert!(wants.iter().any(|w| err.contains(w)), "{what}: expected one of {wants:?}, got\n{err}");
}

// ---------------------------------------------------------------------------------------------
// 1. Bending a real proof
// ---------------------------------------------------------------------------------------------

#[test]
fn proof_bound_to_its_root_code_and_field() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let other_root = f.proof("alice-tutoring-B").proof().root;
    let payer = h.payer.pubkey();
    let (profile, label, code) = (alice.profile_address(), alice.label.clone(), alice.code_bytes());
    let good = alice.proof();
    let with_root = |root: [u8; 32]| Proof { root, ..good };

    let cases: Vec<(&str, Instruction, &[&str])> = vec![
        ("another list's root", register_ix(payer, &profile, &label, &code, &with_root(other_root)), &["ProofRejected"]),
        ("a root nobody has", register_ix(payer, &profile, &label, &code, &with_root([7u8; 32])), &["ProofRejected"]),
        ("the zero root", register_ix(payer, &profile, &label, &code, &with_root([0u8; 32])), &["ProofRejected"]),
        ("the root plus the field order", register_ix(payer, &profile, &label, &code, &with_root(add_be(&good.root, BN254_R))), &["NotAFieldElement"]),
        ("the code plus the field order", register_ix(payer, &profile, &label, &add_be(&code, BN254_R), &good), &["NotAFieldElement"]),
        ("an empty label", register_ix(payer, &profile, "", &code, &good), &["ProofRejected"]),
    ];
    for (what, ix, wants) in cases {
        expect_err(h.send(&[ix], &[]), what, wants);
    }
    assert!(!h.exists(&line_address(&code)));
    assert!(!h.exists(&line_address(&add_be(&code, BN254_R))));
    println!("refused as expected: six ways of bending a real proof's public inputs");
}

#[test]
fn proof_every_single_bit_flip_in_the_points_is_refused() {
    // Every bit of A, B and C, flipped one at a time: 1,024 attempts in register (a proof for a line
    // that does not exist yet) and 1,024 in add_proof (a proof for a root the line lacks). Unflipped,
    // both would land, as the last two lines show.
    let (mut h, f) = ready();
    let tutoring_a = f.proof("alice-tutoring-A");
    let tutoring_b = f.proof("alice-tutoring-B");
    let cleaning = f.proof("alice-cleaning-A");
    h.register(tutoring_a).expect("the line add_proof aims at");
    let wants: &[&str] = &["ProofMalformed", "ProofRejected"];
    let mut tried = 0;
    for part in 0..3 {
        let len = if part == 1 { 64 } else { 32 };
        for byte in 0..len {
            for bit in 0..8 {
                let flip = |p: &FixtureProof| {
                    let mut q = p.proof();
                    match part {
                        0 => q.a[byte] ^= 1 << bit,
                        1 => q.b[byte] ^= 1 << bit,
                        _ => q.c[byte] ^= 1 << bit,
                    }
                    q
                };
                let ix = register_ix(h.payer.pubkey(), &cleaning.profile_address(), &cleaning.label, &cleaning.code_bytes(), &flip(cleaning));
                expect_err(h.send(&[ix], &[]), "register", wants);
                let ix = add_proof_ix(h.payer.pubkey(), &tutoring_b.code_bytes(), &flip(tutoring_b));
                expect_err(h.send(&[ix], &[]), "add_proof", wants);
                tried += 1;
            }
        }
    }
    assert_eq!(tried, 1024);
    assert!(!h.exists(&line_address(&cleaning.code_bytes())));
    assert_eq!(h.line(&tutoring_a.code_bytes()).roots.len(), 1);
    h.register(cleaning).expect("unflipped, register lands");
    h.add_proof(tutoring_b).expect("unflipped, add_proof lands");
    println!("refused as expected: {tried} single-bit changes to the proof points, in register and in add_proof each");
}

#[test]
fn a_label_that_is_not_utf8_is_refused() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let mut ix = register_fixture_ix(h.payer.pubkey(), a);
    // The label starts after the discriminator, the profile and its four-byte length.
    ix.data[8 + 32 + 4] = 0xff;
    expect_err(h.send(&[ix], &[]), "invalid UTF-8", &["InstructionDidNotDeserialize"]);
    println!("refused as expected: a label that is not UTF-8");
}

// ---------------------------------------------------------------------------------------------
// 2. Replays, front-running, pre-funding
// ---------------------------------------------------------------------------------------------

#[test]
fn replay_one_code_twice_in_one_transaction_reverts_both() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let ix = register_fixture_ix(h.payer.pubkey(), a);
    expect_err(h.send(&[ix.clone(), ix], &[]), "twice in one transaction", &["already in use"]);
    assert!(!h.exists(&line_address(&a.code_bytes())), "not even the first one");
    println!("refused as expected: the same register twice in one transaction, and nothing of the first survives");
}

#[test]
fn lamports_sent_to_a_line_address_first_do_not_block_it() {
    // Someone who saw a code (in a failed transaction, say) sends lamports to its address first,
    // hoping `init` finds the address taken.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = line_address(&a.code_bytes());
    h.svm
        .set_account(address, Account { lamports: 5_000_000, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 })
        .unwrap();
    h.register(a).expect("registers anyway");
    assert_eq!(h.account(&address).owner, PROGRAM_ID);
    assert_eq!(h.line(&a.code_bytes()).roots.len(), 1);
    println!("pre-funding a line's address does not block it");
}

#[test]
fn finding_a_front_runner_who_strips_a_proof_costs_one_transaction_never_the_line() {
    // By design anyone may send: the proof is the consent. Someone who sees Alice's register for
    // list A pending can land it first, as the payer. Alice's own transaction then fails, and the
    // line is exactly hers anyway: her profile, her label, her root. She adds list B next.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    let front = h.funded(1_000_000_000);
    h.send_as(&front, &[register_fixture_ix(front.pubkey(), a)]).expect("front-run");
    expect_err(h.register(a), "Alice's own register", &["already in use"]);
    h.add_proof(b).expect("Alice adds B");
    let line = h.line(&a.code_bytes());
    assert_eq!((line.profile, line.label.as_str(), line.roots.len()), (a.profile_address(), "tutoring/seller", 2));
    assert_eq!(line.payer, front.pubkey(), "the front-runner paid the deposit, and refunds go to it");
    println!("finding: a front-runner can only pay for Alice's line; it stays hers");
}

// ---------------------------------------------------------------------------------------------
// 3. Substituted and planted accounts
// ---------------------------------------------------------------------------------------------

#[test]
fn substitution_every_account() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let bob = f.proof("bob-tutoring-A");
    let code = a.code_bytes();
    let payer = h.payer.pubkey();
    let wrong_line = Address::find_program_address(&[b"code", &[1u8; 32]], &PROGRAM_ID).0;
    let not_a_pda = Keypair::new().pubkey();
    let fake_system = Keypair::new().pubkey();

    for (what, slot, to) in [("another code's address", 0, wrong_line), ("a random address", 0, not_a_pda), ("a fake system program", 2, fake_system)] {
        let mut ix = register_fixture_ix(payer, a);
        ix.accounts[slot].pubkey = to;
        expect_err(h.send(&[ix], &[]), what, &["ConstraintSeeds", "InvalidProgramId", "2006", "3008", "ProgramAccountNotFound", "not found"]);
    }
    assert!(!h.exists(&line_address(&code)));

    // add_proof and refund: Bob's line passed where Alice's code names hers.
    h.register(a).expect("Alice");
    h.register(bob).expect("Bob");
    let b = f.proof("alice-tutoring-B");
    let mut ix = add_proof_ix(payer, &code, &b.proof());
    ix.accounts[0].pubkey = line_address(&bob.code_bytes());
    expect_err(h.send(&[ix], &[]), "Bob's line for Alice's code", &["ConstraintSeeds"]);
    let mut ix = refund_ix(payer, &code);
    ix.accounts[0].pubkey = line_address(&bob.code_bytes());
    expect_err(h.send(&[ix], &[]), "refund, Bob's line for Alice's code", &["ConstraintSeeds"]);
    assert_eq!(h.line(&bob.code_bytes()).roots.len(), 1);
    println!("refused as expected: every account in register, add_proof and refund substituted");
}

#[test]
fn a_planted_line_owned_by_another_program_is_refused() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    h.register(a).expect("register");
    let address = line_address(&a.code_bytes());
    let mut planted = h.account(&address);
    planted.owner = Keypair::new().pubkey();
    h.svm.set_account(address, planted).unwrap();
    expect_err(h.add_proof(b), "add_proof", &["AccountOwnedByWrongProgram"]);
    expect_err(h.send(&[refund_ix(h.payer.pubkey(), &a.code_bytes())], &[]), "refund", &["AccountOwnedByWrongProgram"]);
    println!("refused as expected: a line's bytes under another program's ownership");
}

#[test]
fn finding_the_program_takes_any_32_bytes_as_a_profile() {
    // The program does not check that a profile is a usable ed25519 key (records/SPEC.md §1): only
    // the holder of an identity secret can bind one, and readers apply the key rules. A line for
    // the all-zero key would need a proof made for it, which only a human can make; here the zero
    // key with Alice's proof is refused because the proof names another key.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let ix = register_ix(h.payer.pubkey(), &Address::new_from_array([0u8; 32]), &a.label, &a.code_bytes(), &a.proof());
    expect_err(h.send(&[ix], &[]), "the zero key with Alice's proof", &["ProofRejected"]);
    println!("finding: any 32 bytes can be a line's profile if its human proves for them; readers check the key");
}

// ---------------------------------------------------------------------------------------------
// 4. Rent
// ---------------------------------------------------------------------------------------------

#[test]
fn a_rent_rise_freezes_nothing_and_add_proof_tops_up_to_the_new_minimum() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let b = f.proof("alice-tutoring-B");
    let address = line_address(&a.code_bytes());
    h.set_rent(RENT_FINAL);
    h.register(a).expect("register at the low rate");
    h.set_rent(RENT_HIGH);
    expect_err(h.send(&[refund_ix(h.payer.pubkey(), &a.code_bytes())], &[]), "refund below the new minimum", &["NothingToRefund"]);
    h.add_proof(b).expect("add_proof after a rise");
    let size = h.account(&address).data.len();
    assert_eq!(h.lamports_of(&address), rent_minimum(RENT_HIGH, size), "topped up to the new minimum, for the new size");
    println!("after a rent rise: refund refuses, add_proof tops the line up to the new minimum");
}

#[test]
fn finding_a_refund_to_a_payer_holding_no_sol_fails_until_someone_funds_it() {
    // The runtime refuses to leave a system account holding less than its own rent minimum, so a
    // refund smaller than that cannot land on a payer that has spent everything. It waits: the
    // excess stays in the line, and a refund lands once the payer holds a little SOL again.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let payer = h.funded(1_000_000_000);
    h.set_rent(RENT_TODAY);
    h.send_as(&payer, &[register_fixture_ix(payer.pubkey(), a)]).expect("register");
    h.svm
        .set_account(payer.pubkey(), Account { lamports: 0, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 })
        .unwrap();
    h.set_rent(RENT_TODAY - 10);
    expect_err(h.send(&[refund_ix(payer.pubkey(), &a.code_bytes())], &[]), "a refund to an empty payer", &["InsufficientFundsForRent"]);
    h.svm.airdrop(&payer.pubkey(), 10_000_000).unwrap();
    h.send(&[refund_ix(payer.pubkey(), &a.code_bytes())], &[]).expect("lands once the payer holds SOL");
    println!("finding: a small refund to an empty payer is refused by the runtime until the payer holds SOL, then lands");
}

#[test]
fn nothing_is_signed_but_the_payer() {
    // Every instruction carries exactly one signer, the payer, and refund none.
    let f = Fixtures::load();
    let a = f.proof("alice-tutoring-A");
    let payer = Keypair::new().pubkey();
    let signers = |ix: &Instruction| ix.accounts.iter().filter(|m: &&AccountMeta| m.is_signer).count();
    assert_eq!(signers(&register_fixture_ix(payer, a)), 1);
    assert_eq!(signers(&add_proof_ix(payer, &a.code_bytes(), &a.proof())), 1);
    assert_eq!(signers(&refund_ix(payer, &a.code_bytes())), 0);
}

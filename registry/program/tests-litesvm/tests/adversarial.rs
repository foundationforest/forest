//! Attacks on the registry: bent proofs, replays, substituted and planted accounts, a missing or
//! borrowed signature, and the rent. Each test says what it tried and that it failed, or, for a
//! `finding_`, what it showed that is true by design.

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

/// Send `args` as `p`'s profile, signed by it, paid by the harness.
fn send_args(h: &mut Harness, p: &FixtureProof, args: &Args) -> Result<litesvm::types::TransactionMetadata, String> {
    let key = p.main_key();
    let ix = register_ix(h.payer.pubkey(), key.pubkey(), args);
    h.send(&[ix], &[&key])
}

// ---------------------------------------------------------------------------------------------
// 1. Bending a real proof
// ---------------------------------------------------------------------------------------------

#[test]
fn proof_bound_to_its_root_market_stamp_and_field() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutoring-A");
    let good = alice.args();
    let other_root = f.proof("alice-tutoring-B").args().root;

    let cases: Vec<(&str, Args, &[&str])> = vec![
        ("another list's root", Args { root: other_root, ..good.clone() }, &["ProofRejected"]),
        ("a root nobody has", Args { root: [7u8; 32], ..good.clone() }, &["ProofRejected"]),
        ("the zero root", Args { root: [0u8; 32], ..good.clone() }, &["ProofRejected"]),
        ("the root plus the field order", Args { root: add_be(&good.root, BN254_R), ..good.clone() }, &["NotAFieldElement"]),
        ("the market stamp plus the field order", Args { market_stamp: add_be(&good.market_stamp, BN254_R), ..good.clone() }, &["NotAFieldElement"]),
        ("an empty label", Args { label: String::new(), ..good.clone() }, &["ProofRejected"]),
    ];
    for (what, args, wants) in cases {
        expect_err(send_args(&mut h, alice, &args), what, wants);
    }
    assert!(!h.exists(&alice.row_address()));
    assert!(!h.exists(&row_address(&add_be(&good.market_stamp, BN254_R))));
    println!("refused as expected: six ways of bending a real proof's public inputs");
}

#[test]
fn a_proof_made_with_the_earlier_4_0_0_files_is_refused() {
    // One row, proven twice: with Semaphore 4.0.0's files, the pin whose circuit left the path bits
    // unconstrained, and with 4.13.0's. Every public input is the same; only the proof differs. The
    // program's key is 4.13.0's, so the first is refused and the second lands.
    let (mut h, f) = ready();
    let old = Fixtures::earlier_pin();
    let new = f.proof(&old.name);
    let (o, n) = (old.args(), new.args());
    assert_eq!(o.market_stamp, n.market_stamp, "the same market stamp");
    assert_eq!(o.root, n.root, "the same root");
    assert_eq!(o.label, n.label, "the same label");
    assert_eq!(o.issuer, n.issuer, "the same issuer");
    assert_eq!(old.profile_address(), new.profile_address(), "the same profile");
    assert_ne!((o.proof.a, o.proof.c), (n.proof.a, n.proof.c), "two different proofs");

    expect_err(send_args(&mut h, &old, &o), "a proof made with the 4.0.0 files", &["ProofRejected"]);
    assert!(!h.exists(&new.row_address()));
    send_args(&mut h, new, &n).expect("the same row, proven with the 4.13.0 files");
    assert!(h.exists(&new.row_address()));
    println!("refused as expected: a 4.0.0 proof; the 4.13.0 proof for the same row lands");
}

#[test]
fn proof_every_single_bit_flip_in_the_points_is_refused() {
    // Every bit of A, B and C, flipped one at a time: 1,024 attempts at a register for a row that
    // does not exist yet. Unflipped, it lands, as the last line shows.
    let (mut h, f) = ready();
    let cleaning = f.proof("alice-cleaning-A");
    let wants: &[&str] = &["ProofMalformed", "ProofRejected"];
    let mut tried = 0;
    for part in 0..3 {
        let len = if part == 1 { 64 } else { 32 };
        for byte in 0..len {
            for bit in 0..8 {
                let mut args = cleaning.args();
                match part {
                    0 => args.proof.a[byte] ^= 1 << bit,
                    1 => args.proof.b[byte] ^= 1 << bit,
                    _ => args.proof.c[byte] ^= 1 << bit,
                }
                expect_err(send_args(&mut h, cleaning, &args), "register", wants);
                tried += 1;
            }
        }
    }
    assert_eq!(tried, 1024);
    assert!(!h.exists(&cleaning.row_address()));
    h.register(cleaning).expect("unflipped, register lands");
    println!("refused as expected: {tried} single-bit changes to the proof points");
}

#[test]
fn a_label_that_is_not_utf8_is_refused() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let key = a.main_key();
    let mut ix = register_ix(h.payer.pubkey(), key.pubkey(), &a.args());
    ix.data[REGISTER_LABEL_AT] = 0xff;
    expect_err(h.send(&[ix], &[&key]), "invalid UTF-8", &["InstructionDidNotDeserialize"]);
    println!("refused as expected: a label that is not UTF-8");
}

// ---------------------------------------------------------------------------------------------
// 2. Replays and pre-funding
// ---------------------------------------------------------------------------------------------

#[test]
fn replay_one_market_stamp_twice_in_one_transaction_reverts_both() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let key = a.main_key();
    let ix = register_ix(h.payer.pubkey(), key.pubkey(), &a.args());
    expect_err(h.send(&[ix.clone(), ix], &[&key]), "twice in one transaction", &["already in use"]);
    assert!(!h.exists(&a.row_address()), "not even the first one");
    println!("refused as expected: the same register twice in one transaction, and nothing of the first survives");
}

#[test]
fn lamports_sent_to_a_row_address_first_do_not_block_it() {
    // Someone who saw a market stamp (in a failed transaction, say) sends lamports to its address
    // first, hoping `init` finds the address taken.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = a.row_address();
    h.svm
        .set_account(address, Account { lamports: 5_000_000, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 })
        .unwrap();
    h.register(a).expect("registers anyway");
    assert_eq!(h.account(&address).owner, PROGRAM_ID);
    assert_eq!(h.row(&a.market_stamp()).root, a.args().root);
    assert_eq!(h.lamports_of(&address), 5_000_000.max(h.svm.minimum_balance_for_rent_exemption(row_space(a.label.len()))));
    println!("pre-funding a row's address does not block it");
}

#[test]
fn finding_a_proof_in_flight_cannot_be_stolen_and_a_whole_transaction_only_lands_as_sent() {
    // A proof is public once sent. Whoever copies Alice's proof needs her main key's signature to
    // land it on her profile, and cannot land it on their own: the proof names hers. Her whole
    // signed transaction, rebroadcast, lands exactly as she sent it, and only once.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let thief = h.funded(1_000_000_000);
    expect_err(h.send_as(&thief, &[register_ix(thief.pubkey(), thief.pubkey(), &a.args())]), "under the thief's profile", &["ProofRejected"]);

    let key = a.main_key();
    h.svm.expire_blockhash();
    let msg = solana_message::Message::new(&[register_ix(h.payer.pubkey(), key.pubkey(), &a.args())], Some(&h.payer.pubkey()));
    let tx = solana_transaction::Transaction::new(&[&h.payer, &key], msg, h.svm.latest_blockhash());
    h.send_tx(tx.clone()).expect("Alice's transaction");
    expect_err(h.send_tx(tx), "the same transaction again", &["AlreadyProcessed", "already in use"]);
    let row = h.row(&a.market_stamp());
    assert_eq!((row.profile, row.payer), (a.profile_address(), h.payer.pubkey()));
    println!("finding: a proof in flight is useless to anyone but its profile, and its transaction lands once, as sent");
}

// ---------------------------------------------------------------------------------------------
// 3. Substituted and planted accounts
// ---------------------------------------------------------------------------------------------

#[test]
fn substitution_every_account() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let key = a.main_key();
    let wrong_row = row_address(&[1u8; 32]);
    let not_a_pda = Keypair::new().pubkey();
    let fake_system = Keypair::new().pubkey();

    for (what, slot, to) in [("another market stamp's address", 0, wrong_row), ("a random address", 0, not_a_pda), ("a fake system program", 3, fake_system)] {
        let mut ix = register_ix(h.payer.pubkey(), key.pubkey(), &a.args());
        ix.accounts[slot].pubkey = to;
        expect_err(h.send(&[ix], &[&key]), what, &["ConstraintSeeds", "InvalidProgramId", "2006", "3008", "ProgramAccountNotFound", "not found"]);
    }
    assert!(!h.exists(&a.row_address()));

    // refund: Bob's row, with Alice's recorded payer named, pays nobody.
    let bob = f.proof("bob-tutoring-A");
    let other_payer = h.funded(1_000_000_000);
    h.register(a).expect("Alice");
    h.register_paid_by(&other_payer, bob).expect("Bob");
    h.set_rent(RENT_FINAL);
    let bob_before = h.account(&bob.row_address());
    expect_err(h.send(&[refund_ix(h.payer.pubkey(), bob.row_address())], &[]), "Bob's row to Alice's payer", &["NotThePayer"]);
    assert_eq!(h.account(&bob.row_address()), bob_before);
    println!("refused as expected: every account in register and refund substituted");
}

#[test]
fn a_planted_row_owned_by_another_program_is_refused() {
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    h.register(a).expect("register");
    let address = a.row_address();
    let mut planted = h.account(&address);
    planted.owner = Keypair::new().pubkey();
    planted.lamports += 1_000_000;
    h.svm.set_account(address, planted).unwrap();
    expect_err(h.send(&[refund_ix(h.payer.pubkey(), address)], &[]), "refund", &["AccountOwnedByWrongProgram"]);
    println!("refused as expected: a row's bytes under another program's ownership");
}

#[test]
fn an_account_of_the_registry_that_is_not_a_row_is_refused() {
    // refund takes any row without its market stamp: `Account` checks the owner and the `Row`
    // discriminator. An account the registry owns with other bytes (an empty one, or one with the
    // earlier version's `Line` discriminator and a payer where a row keeps one) is refused.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    h.register(a).expect("register");
    let mut line = vec![0u8; 333];
    line[..8].copy_from_slice(&discriminator("account", "Line"));
    line[168..200].copy_from_slice(h.payer.pubkey().as_ref());
    for (what, data) in [("zeroed", vec![0u8; 220]), ("a Line", line)] {
        let address = Keypair::new().pubkey();
        h.svm.set_account(address, Account { lamports: 10_000_000, data, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
        let result = h.send(&[refund_ix(h.payer.pubkey(), address)], &[]);
        assert_eq!(custom_error(&result), Some(err::ACCOUNT_DISCRIMINATOR_MISMATCH), "{what}: {result:?}");
    }
    println!("refused as expected: the registry's own accounts that are not rows");
}

#[test]
fn finding_the_program_takes_any_32_bytes_as_an_issuer() {
    // The program does not check that an issuer is a usable ed25519 key, or that it signed: readers
    // do. The all-zero issuer with an all-zero signature lands; no reader accepts it.
    let (mut h, f) = ready();
    let a = f.proof("bob-tutoring-A");
    let args = Args { issuer: Address::new_from_array([0u8; 32]), issuer_signature: [0u8; 64], ..a.args() };
    send_args(&mut h, a, &args).expect("stored as given");
    assert_eq!(h.row(&a.market_stamp()).issuer, Address::new_from_array([0u8; 32]));
    println!("finding: any 32 bytes can be a row's issuer; readers check the issuer and its signature");
}

// ---------------------------------------------------------------------------------------------
// 4. Rent
// ---------------------------------------------------------------------------------------------

#[test]
fn finding_after_a_rent_rise_a_row_holds_less_than_the_minimum_and_nothing_needs_more() {
    // A row is never written again, so nothing in the program ever needs it to hold the minimum
    // of a higher rate. After a rise it simply holds less: refund refuses, the row still reads, and
    // a later fall below what it holds makes the difference refundable again.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let address = a.row_address();
    h.set_rent(RENT_FINAL);
    h.register(a).expect("register at the low rate");
    let held = h.lamports_of(&address);
    h.set_rent(RENT_HIGH);
    expect_err(h.send(&[refund_ix(h.payer.pubkey(), address)], &[]), "refund below the new minimum", &["NothingToRefund"]);
    assert!(held < h.svm.minimum_balance_for_rent_exemption(h.account(&address).data.len()));
    assert_eq!(h.row(&a.market_stamp()).root, a.args().root, "the row still reads");
    assert_eq!(h.lamports_of(&address), held, "and holds what it held");
    println!("finding: after a rent rise a row holds less than the new minimum, reads as before, and refund refuses");
}

#[test]
fn finding_a_refund_to_a_payer_holding_no_sol_fails_until_someone_funds_it() {
    // The runtime refuses to leave a system account holding less than its own rent minimum, so a
    // refund smaller than that cannot land on a payer that has spent everything. It waits: the
    // excess stays in the row, and a refund lands once the payer holds a little SOL again.
    let (mut h, f) = ready();
    let a = f.proof("alice-tutoring-A");
    let payer = h.funded(1_000_000_000);
    h.set_rent(RENT_TODAY);
    h.register_paid_by(&payer, a).expect("register");
    h.svm
        .set_account(payer.pubkey(), Account { lamports: 0, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 })
        .unwrap();
    h.set_rent(RENT_TODAY - 10);
    expect_err(h.send(&[refund_ix(payer.pubkey(), a.row_address())], &[]), "a refund to an empty payer", &["InsufficientFundsForRent"]);
    h.svm.airdrop(&payer.pubkey(), 10_000_000).unwrap();
    h.send(&[refund_ix(payer.pubkey(), a.row_address())], &[]).expect("lands once the payer holds SOL");
    println!("finding: a small refund to an empty payer is refused by the runtime until the payer holds SOL, then lands");
}

#[test]
fn register_is_signed_by_the_profile_and_the_payer_and_refund_by_nobody() {
    let f = Fixtures::load();
    let a = f.proof("alice-tutoring-A");
    let payer = Keypair::new().pubkey();
    let signers = |ix: &Instruction| ix.accounts.iter().filter(|m: &&AccountMeta| m.is_signer).map(|m| m.pubkey).collect::<Vec<_>>();
    assert_eq!(signers(&register_ix(payer, a.profile_address(), &a.args())), vec![a.profile_address(), payer]);
    assert!(signers(&refund_ix(payer, a.row_address())).is_empty());
}

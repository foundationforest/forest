//! Adversarial review 1: the registry, attacked.
//!
//! Every test here is an attack from `docs/decisions/adversarial-review-1.md`, run against the
//! real Semaphore proofs in `fixtures/proofs.json`. A test named for what should be refused
//! asserts that it is refused. A test named `finding_…` is an attack the program accepts: it
//! asserts the acceptance, so the suite pins what the report describes.
//!
//! Run with `cargo test --test adversarial -- --nocapture` to see what each attack did.

use forest_registry_tests::*;
use num_bigint::BigUint;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

const TUTORS: &str = "online-tutors";
const QUARTER_USDC: u64 = 250_000;
const TOKEN_2022_PROGRAM: Address = solana_address::address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// BN254's scalar field order, the bound every public input must sit under.
const BN254_R: &str = "21888242871839275222246405745257275088548364400416422360885981858940010000001";

fn ready() -> (Harness, Fixtures) {
    let f = Fixtures::load();
    let mut h = Harness::new();
    for leaf in &f.list(0).leaves {
        h.insert(0, dec_to_be32(leaf));
    }
    (h, f)
}

/// A fixture's registration, as bytes an attacker can then change.
struct Reg {
    market: String,
    did: String,
    list_index: u32,
    root: [u8; 32],
    code: [u8; 32],
    a: [u8; 32],
    b: [u8; 64],
    c: [u8; 32],
}

impl Reg {
    fn of(p: &FixtureProof) -> Self {
        Reg {
            market: p.market.clone(),
            did: p.did.clone(),
            list_index: p.list_index,
            root: p.root_bytes(),
            code: p.code_bytes(),
            a: p.a_bytes(),
            b: p.b_bytes(),
            c: p.c_bytes(),
        }
    }
    fn ix(&self, accounts: &RegisterAccounts) -> Instruction {
        register_ix(
            &RegisterArgs {
                market: &self.market,
                did: &self.did,
                list_index: self.list_index,
                root: self.root,
                code: self.code,
                proof_a: self.a,
                proof_b: self.b,
                proof_c: self.c,
            },
            accounts,
        )
    }
}

fn accounts(h: &Harness, wallet: &Keypair, tokens: Address) -> RegisterAccounts {
    RegisterAccounts { payer: h.payer.pubkey(), profile_wallet: wallet.pubkey(), profile_tokens: tokens, treasury_tokens: h.treasury_tokens }
}

fn send_reg(h: &mut Harness, r: &Reg, wallet: &Keypair, tokens: Address) -> Result<litesvm::types::TransactionMetadata, String> {
    let ix = r.ix(&accounts(h, wallet, tokens));
    h.send_signed(&[ix], &[wallet])
}

fn add_be(a: &[u8; 32], b: &str) -> [u8; 32] {
    let sum = BigUint::from_bytes_be(a) + b.parse::<BigUint>().unwrap();
    let bytes = sum.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

// ---------------------------------------------------------------------------------------------
// 0. The key everyone can derive
// ---------------------------------------------------------------------------------------------

#[test]
fn finding_the_placeholder_treasury_is_anyones_key() {
    // Deployed exactly as it is, the program's TREASURY is derived from the public string in its
    // own source. A stranger who reads the repo signs as the treasury: takes the dials, names
    // itself issuer, adds humans who do not exist, and is paid every fee.
    let (mut h, f) = ready();
    let anyone = Keypair::new_from_array(*b"REPLACE-BEFORE-DEPLOY-treasury-0");
    assert_eq!(anyone.pubkey(), TREASURY, "the public seed is the treasury");
    let attacker = Keypair::new();
    h.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    h.send_signed(&[propose_treasury_ix(anyone.pubkey(), Some(attacker.pubkey()))], &[&anyone]).expect("propose");
    h.send_signed(&[accept_treasury_ix(attacker.pubkey())], &[&attacker]).expect("accept");
    assert_eq!(h.config().treasury, attacker.pubkey());
    h.send_signed(&[issuer_ix("add_issuer", attacker.pubkey(), 0, attacker.pubkey())], &[&attacker]).expect("self as issuer");
    for i in 0..3u8 {
        h.send_signed(&[insert_identity_ix(attacker.pubkey(), 0, [i + 1; 32].map(|b| b & 0x0f))], &[&attacker]).expect("a human who does not exist");
    }
    assert_eq!(h.list(0).leaf_count, 5 + 3);

    // And the next registration pays the attacker. (Alice's proof is against the root before the
    // three fake inserts, which is still in the ring.)
    let attacker_tokens = h.token_account_for(h.usdc, attacker.pubkey());
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    let mut a = accounts(&h, &wallet, tokens);
    a.treasury_tokens = attacker_tokens;
    h.send_signed(&[Reg::of(p).ix(&a)], &[&wallet]).expect("registration pays the attacker");
    assert_eq!(token_amount(&h.account(&attacker_tokens).data), QUARTER_USDC);
    println!("FINDING (money and promise, deploy blocker): the placeholder treasury is a public key pair; replace before deploy");
}

// ---------------------------------------------------------------------------------------------
// 1. The proof and what it is bound to
// ---------------------------------------------------------------------------------------------

#[test]
fn proof_bound_to_its_did_market_root_and_code() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let bob = f.proof("bob-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 10_000_000);

    let cases: Vec<(&str, Box<dyn Fn(&mut Reg)>, &[&str])> = vec![
        ("another profile's DID", Box::new(|r| r.did = bob.did.clone()), &["ProofRejected", "does not verify"]),
        ("a lookalike market name", Box::new(|r| r.market = "online-tutors ".into()), &["ProofRejected", "does not verify"]),
        ("the same name in capitals", Box::new(|r| r.market = "Online-Tutors".into()), &["ProofRejected", "does not verify"]),
        ("another human's code", Box::new(|r| r.code = bob.code_bytes()), &["ProofRejected", "does not verify"]),
        ("the same code plus the field order", Box::new(|r| r.code = add_be(&r.code, BN254_R)), &["NotAFieldElement", "field element"]),
        ("the same root plus the field order", Box::new(|r| r.root = add_be(&r.root, BN254_R)), &["RootNotRecent", "last 128", "NotAFieldElement"]),
        ("a root that was never the list's", Box::new(|r| r.root = [7u8; 32]), &["RootNotRecent", "last 128"]),
        ("the zero root", Box::new(|r| r.root = [0u8; 32]), &["RootNotRecent", "last 128"]),
        ("an empty market", Box::new(|r| r.market = String::new()), &["MarketNameLength", "between 1 and 64"]),
        ("a 65-byte market", Box::new(|r| r.market = "m".repeat(65)), &["MarketNameLength", "between 1 and 64"]),
        ("an empty DID", Box::new(|r| r.did = String::new()), &["DidLength", "between 1 and 64"]),
        ("a 65-byte DID", Box::new(|r| r.did = "d".repeat(65)), &["DidLength", "between 1 and 64"]),
        ("list 1 named for a list-0 proof", Box::new(|r| r.list_index = 1), &["AccountNotInitialized", "AccountOwnedByWrongProgram", "ConstraintSeeds", "3012"]),
    ];
    for (what, change, wants) in cases {
        let mut r = Reg::of(alice);
        change(&mut r);
        let err = send_reg(&mut h, &r, &wallet, tokens).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(wants.iter().any(|w| err.contains(w)), "{what}: expected one of {wants:?}, got\n{err}");
    }
    assert_eq!(h.code_tree().count, 0, "nothing written");
    assert_eq!(token_amount(&h.account(&tokens).data), 10_000_000, "nothing paid");
    println!("rejected as expected: thirteen ways of bending a real proof");
}

#[test]
fn proof_every_single_bit_flip_in_the_points_is_refused() {
    // Every bit of A, B and C, flipped one at a time: 1,024 attempts. None may register.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 10_000_000);
    let mut tried = 0;
    for part in 0..3 {
        let len = if part == 1 { 64 } else { 32 };
        for byte in 0..len {
            for bit in 0..8 {
                let mut r = Reg::of(alice);
                match part {
                    0 => r.a[byte] ^= 1 << bit,
                    1 => r.b[byte] ^= 1 << bit,
                    _ => r.c[byte] ^= 1 << bit,
                }
                let err = send_reg(&mut h, &r, &wallet, tokens).err().unwrap_or_else(|| panic!("part {part} byte {byte} bit {bit}: accepted"));
                assert!(err.contains("ProofMalformed") || err.contains("ProofRejected") || err.contains("does not verify") || err.contains("not a valid compressed"), "{err}");
                tried += 1;
            }
        }
    }
    assert_eq!(tried, 1024);
    assert_eq!(h.code_tree().count, 0);
    println!("rejected as expected: {tried} single-bit changes to the proof points");
}

#[test]
fn finding_the_paying_wallet_is_not_bound_to_the_did() {
    // A registration's proof binds the market and the DID. It does not bind the wallet that pays.
    // Anyone holding a copy of Alice's instruction (a relay, a fee payer, a front-runner) can
    // land it paying from their own wallet: Alice's DID gets Alice's badge. Harmless to Alice.
    // The flip side: the human who makes a proof chooses the DID, and nothing checks that the
    // human controls it, so a badge can be made for, and sold to, a profile its owner never
    // face-checked. One per human per market, still.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let (stranger, stranger_tokens) = h.wallet_with(h.usdc, 1_000_000);
    let meta = send_reg(&mut h, &Reg::of(alice), &stranger, stranger_tokens).expect("accepted");
    let ev = registered_events(&meta.logs);
    assert_eq!(ev[0].did, alice.did);
    assert_eq!(token_amount(&h.account(&stranger_tokens).data), 1_000_000 - QUARTER_USDC);
    println!("FINDING (for Carlos): the stranger paid, Alice's DID was badged; the payer is not in the event either");
}

// ---------------------------------------------------------------------------------------------
// 2. Replays and double spends
// ---------------------------------------------------------------------------------------------

#[test]
fn replay_one_code_twice_in_one_transaction_reverts_both() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    let ix = Reg::of(alice).ix(&accounts(&h, &w, t));
    let err = h.send_signed(&[ix.clone(), ix], &[&w]).expect_err("must be refused");
    assert!(err.contains("already in use"), "{err}");
    assert!(h.svm.get_account(&used_code_address(&alice.code_bytes())).is_none(), "not even the first one");
    assert_eq!(token_amount(&h.account(&t).data), 1_000_000);
    println!("rejected as expected: the same proof twice in one transaction, and nothing of the first survives");
}

#[test]
fn replay_lamports_sent_to_a_code_address_first_do_not_block_it() {
    // Someone who can compute a code (only its human can) or who saw it in a failed transaction
    // sends lamports to its address first, hoping `init` will find the address taken.
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let addr = used_code_address(&alice.code_bytes());
    h.svm
        .set_account(addr, Account { lamports: 5_000_000, data: vec![], owner: solana_system_interface::program::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    send_reg(&mut h, &Reg::of(alice), &w, t).expect("registers anyway");
    assert_eq!(h.account(&addr).owner, PROGRAM_ID);
    println!("rejected as expected: pre-funding a code's address does not block its registration");
}

// ---------------------------------------------------------------------------------------------
// 3. Account substitution
// ---------------------------------------------------------------------------------------------

#[test]
fn substitution_every_account_in_register() {
    let (mut h, f) = ready();
    let alice = Reg::of(f.proof("alice-tutors"));
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    let stranger = Keypair::new();

    let other_mint = Address::new_unique();
    h.svm.set_account(other_mint, spl_mint_account(6)).unwrap();
    let treasury_other_mint = h.token_account_for(other_mint, h.treasury);
    let strangers_usdc = h.token_account_for(h.usdc, stranger.pubkey());
    let (_victim, victims_usdc) = h.wallet_with(h.usdc, 5_000_000);
    let t22 = Address::new_unique();
    let mut acct = spl_token_account(&h.usdc, &h.treasury, 0);
    acct.owner = TOKEN_2022_PROGRAM;
    h.svm.set_account(t22, acct).unwrap();

    let base = alice.ix(&accounts(&h, &w, t));
    let cases: Vec<(&str, usize, Address, &[&str])> = vec![
        ("list 0 swapped for the code tree", 1, code_tree_address(), &["ConstraintSeeds", "AccountDiscriminator", "2006"]),
        ("the code tree swapped for list 0", 2, list_address(0), &["ConstraintSeeds", "AccountDiscriminator", "2006"]),
        ("a config that is the code tree", 0, code_tree_address(), &["ConstraintSeeds", "AccountDiscriminator", "2006"]),
        ("the code account at another address", 3, used_code_address(&[9u8; 32]), &["ConstraintSeeds", "2006"]),
        ("paying from a victim's token account", 6, victims_usdc, &["ConstraintTokenOwner", "2015"]),
        ("the fee to a stranger's account", 7, strangers_usdc, &["ConstraintTokenOwner", "2015"]),
        ("the fee to the treasury's account for another mint", 7, treasury_other_mint, &["MintMismatch", "different mints"]),
        ("the fee to a Token-2022 account", 7, t22, &["AccountOwnedByWrongProgram", "3007"]),
        ("Token-2022 as the token program", 8, TOKEN_2022_PROGRAM, &["InvalidProgramId", "3008"]),
    ];
    for (what, at, key, wants) in cases {
        let mut ix = base.clone();
        ix.accounts[at].pubkey = key;
        let err = h.send_signed(&[ix], &[&w]).err().unwrap_or_else(|| panic!("{what}: must be refused"));
        assert!(wants.iter().any(|x| err.contains(x)), "{what}: expected one of {wants:?}, got\n{err}");
    }
    assert_eq!(h.code_tree().count, 0);
    assert_eq!(token_amount(&h.account(&victims_usdc).data), 5_000_000, "the victim paid nothing");
    println!("rejected as expected: nine substitutions in register");
}

#[test]
fn substitution_a_token_2022_mint_cannot_be_accepted() {
    let (mut h, _f) = ready();
    let m22 = Address::new_unique();
    let mut acct = spl_mint_account(6);
    acct.owner = TOKEN_2022_PROGRAM;
    h.svm.set_account(m22, acct).unwrap();
    let err = h.send(&[add_token_ix(h.treasury, m22)], &[Harness::PAYER, Harness::TREASURY]).expect_err("Token-2022 mint");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");
    println!("rejected as expected: a Token-2022 mint at add_token");
}

// ---------------------------------------------------------------------------------------------
// 4. Signers, issuers and the treasury
// ---------------------------------------------------------------------------------------------

#[test]
fn signers_an_issuer_of_one_list_cannot_insert_into_another() {
    let (mut h, _f) = ready();
    let (payer, tk) = (h.payer.pubkey(), h.treasury);
    h.send(&[open_list_ix(payer, tk, 1)], &[Harness::PAYER, Harness::TREASURY]).expect("open_list");
    let issuer = h.issuer.pubkey();
    let err = h.send(&[insert_identity_ix(issuer, 1, dec_to_be32("5"))], &[Harness::PAYER, Harness::ISSUER]).expect_err("list 1");
    assert!(err.contains("may not insert"), "{err}");
    // Nor can an issuer manage issuers.
    let err = h.send(&[issuer_ix("add_issuer", issuer, 0, Keypair::new().pubkey())], &[Harness::PAYER, Harness::ISSUER]).expect_err("issuer as treasury");
    assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{err}");
    // And a commitment outside the field, or zero, is refused whoever inserts it.
    let over = add_be(&[0u8; 32], BN254_R);
    let err = h.send(&[insert_identity_ix(issuer, 0, over)], &[Harness::PAYER, Harness::ISSUER]).expect_err("r itself");
    assert!(err.contains("field element"), "{err}");
    let err = h.send(&[insert_identity_ix(issuer, 0, [0u8; 32])], &[Harness::PAYER, Harness::ISSUER]).expect_err("zero");
    assert!(err.contains("field element"), "{err}");
    println!("rejected as expected: an issuer outside its list, an issuer turning dials, out-of-field and zero commitments");
}

#[test]
fn finding_an_issuer_can_insert_the_same_commitment_twice() {
    // Harmless to the one-badge rule (a human's code depends on the secret and the market, not on
    // the leaf), and a reminder that the list is only as honest as its issuers: an issuer that
    // makes commitments itself makes humans.
    let (mut h, f) = ready();
    let leaf = dec_to_be32(&f.list(0).leaves[0]);
    h.insert(0, leaf);
    assert_eq!(h.list(0).leaf_count, 6);
    println!("FINDING (trust, known): a duplicate leaf is accepted; the issuer key is the list's whole honesty");
}

#[test]
fn treasury_a_handover_in_one_transaction_needs_both_keys_and_cannot_be_replayed() {
    let (mut h, _f) = ready();
    let old = h.treasury_signer();
    let new = Keypair::new();
    // Both steps in one transaction, both keys signing: allowed, and still proves the new key signs.
    h.send_signed(&[propose_treasury_ix(old.pubkey(), Some(new.pubkey())), accept_treasury_ix(new.pubkey())], &[&old, &new])
        .expect("one transaction, two signatures");
    assert_eq!(h.config().treasury, new.pubkey());
    // The accept again: nothing pending.
    let err = h.send_signed(&[accept_treasury_ix(new.pubkey())], &[&new]).expect_err("replay");
    assert!(err.contains("no treasury handover"), "{err}");
    // A key only the program could sign for (its own config address) can be proposed, and never accepted.
    h.send_signed(&[propose_treasury_ix(new.pubkey(), Some(config_address()))], &[&new]).expect("propose a PDA");
    assert_eq!(h.config().treasury, new.pubkey());
    println!("rejected as expected: an accept replayed; a key that cannot sign proposed and stuck pending");
}

#[test]
fn finding_the_treasury_can_accept_a_token_it_mints_itself() {
    // "No vouchers" is a rule in the program's text, but add_token takes any classic mint with two
    // to nineteen decimals. A treasury that mints its own "dollar" and hands it out has vouchers
    // again: registrations paid in a token that cost nobody anything.
    let (mut h, f) = ready();
    let voucher = Address::new_unique();
    h.svm.set_account(voucher, spl_mint_account(6)).unwrap();
    h.send(&[add_token_ix(h.treasury, voucher)], &[Harness::PAYER, Harness::TREASURY]).expect("add");
    let (w, t) = h.wallet_with(voucher, QUARTER_USDC);
    let mut a = accounts(&h, &w, t);
    a.treasury_tokens = h.token_account_for(voucher, h.treasury);
    h.send_signed(&[Reg::of(f.proof("alice-tutors")).ix(&a)], &[&w]).expect("paid in the voucher");
    println!("FINDING (promise, for Carlos): the treasury can bring vouchers back as a token; the program cannot tell");
}

// ---------------------------------------------------------------------------------------------
// 5. The rent sweep
// ---------------------------------------------------------------------------------------------

#[test]
fn sweep_nothing_twice_nothing_missing_and_a_rent_rise_freezes_nothing() {
    let (mut h, f) = ready();
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    let alice = f.proof("alice-tutors");
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    send_reg(&mut h, &Reg::of(alice), &w, t).expect("register");
    let treasury = h.treasury;

    // Nothing to sweep at the rate the accounts were made at.
    let err = h.send(&[sweep_rent_ix(&SweepTarget::CodeTree, treasury)], &[Harness::PAYER]).expect_err("nothing yet");
    assert!(err.contains("nothing above"), "{err}");

    // After the cut, once, then nothing.
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    for target in [SweepTarget::Config, SweepTarget::CodeTree, SweepTarget::List(0), SweepTarget::Code(alice.code_bytes())] {
        h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect("sweep");
        let err = h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect_err("twice");
        assert!(err.contains("nothing above"), "{err}");
    }

    // A code nobody registered, and a list nobody opened: no account, so not a target.
    for target in [SweepTarget::Code([3u8; 32]), SweepTarget::List(9)] {
        let err = h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect_err("absent");
        assert!(err.contains("not the registry account"), "{err}");
    }

    // The rate goes back up. Every account is now below the new minimum. The registry must keep
    // working: a registration writes the code tree and the list is read; neither may be frozen.
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    let bob = f.proof("bob-tutors");
    let (w2, t2) = h.wallet_with(h.usdc, 1_000_000);
    send_reg(&mut h, &Reg::of(bob), &w2, t2).expect("still registers after sweeping and a rent rise");
    let issuer = h.issuer.pubkey();
    h.send(&[insert_identity_ix(issuer, 0, dec_to_be32("77"))], &[Harness::PAYER, Harness::ISSUER]).expect("and still inserts");
    let tk = h.treasury;
    h.send(&[propose_treasury_ix(tk, Some(Keypair::new().pubkey()))], &[Harness::PAYER, Harness::TREASURY]).expect("and the config still takes writes");
    println!("rejected as expected: no double sweep, no sweep of an absent account, and no freeze if rent rises again");
}

#[test]
fn sweep_takes_from_nothing_but_the_target_and_gives_to_nothing_but_the_treasury() {
    let (mut h, f) = ready();
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    let alice = f.proof("alice-tutors");
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    send_reg(&mut h, &Reg::of(alice), &w, t).expect("register");
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let watch = [config_address(), code_tree_address(), list_address(0), used_code_address(&alice.code_bytes()), h.payer.pubkey(), h.treasury];
    let before: Vec<u64> = watch.iter().map(|a| h.account(a).lamports).collect();
    let target = SweepTarget::Code(alice.code_bytes());
    let treasury = h.treasury;
    h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect("sweep");
    let after: Vec<u64> = watch.iter().map(|a| h.account(a).lamports).collect();
    let taken = before[3] - after[3];
    assert_eq!(after[3], rent_minimum(RENT_FINAL, USED_CODE_LEN));
    assert_eq!(after[5], before[5] + taken, "all of it to the treasury");
    assert_eq!(&after[..3], &before[..3], "no other registry account moved");
    assert_eq!(after[4], before[4] - 5_000, "the caller paid its fee and nothing else");
    println!("rejected as expected: a sweep moved {taken} lamports from the one target to the treasury, nothing else");
}

#[test]
fn finding_a_sweep_into_a_treasury_holding_no_sol_fails_until_someone_funds_it() {
    // The runtime refuses any transaction that leaves a credited account below the rent-exempt
    // minimum. A treasury key that holds no SOL (a fresh key, or a multisig vault, after a
    // handover) is such an account: a sweep of less than an empty account's own rent (128 bytes'
    // worth, 650,240 lamports at today's 5,080) fails whole. The money is not lost; anyone can
    // send the treasury a little SOL and sweep again.
    let (mut h, f) = ready();
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    let p = f.proof("alice-tutors");
    let (w, t) = h.wallet_with(h.usdc, 1_000_000);
    send_reg(&mut h, &Reg::of(p), &w, t).expect("register at the old rate");
    let old = h.treasury_signer();
    let fresh = Keypair::new(); // holds nothing
    h.send_signed(&[propose_treasury_ix(old.pubkey(), Some(fresh.pubkey())), accept_treasury_ix(fresh.pubkey())], &[&old, &fresh])
        .expect("handover");
    h.svm.set_sysvar(&rent_at(RENT_TODAY));
    let target = SweepTarget::Code(p.code_bytes());
    let err = h.send(&[sweep_rent_ix(&target, fresh.pubkey())], &[Harness::PAYER]).expect_err("an empty treasury");
    assert!(err.contains("InsufficientFundsForRent"), "{err}");
    // The config's excess is bigger than an empty account's rent, so it lands, and after that the
    // treasury holds enough for the small ones too.
    h.send(&[sweep_rent_ix(&SweepTarget::Config, fresh.pubkey())], &[Harness::PAYER]).expect("a big sweep lands");
    h.send(&[sweep_rent_ix(&target, fresh.pubkey())], &[Harness::PAYER]).expect("and then the small one");
    println!("FINDING (nuisance, operations): an empty treasury refuses small sweeps until it holds ~0.00065 SOL");
}

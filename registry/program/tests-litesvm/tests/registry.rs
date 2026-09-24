//! The registry, run under LiteSVM against real Semaphore proofs made with the pinned July 2024
//! ceremony artifacts (`registry/client/scripts/fixtures.ts` writes them; the file is committed).
//!
//! Run with `cargo test -- --nocapture` to see the measured compute units and transaction bytes.

use forest_registry_tests::*;
use groth16_solana::decompression::{decompress_g1, decompress_g2};
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TUTORS: &str = "online-tutors";
const CLEANING: &str = "house-cleaning";

/// 0.25 at USDC's six decimals: the program's `USDC_FEE`.
const QUARTER_USDC: u64 = USDC_FEE;

/// A registry with list 0 filled and Alice's and Bob's wallets funded.
fn ready() -> (Harness, Fixtures) {
    let f = Fixtures::load();
    let mut h = Harness::new();
    for leaf in &f.list(0).leaves {
        h.insert(0, dec_to_be32(leaf));
    }
    (h, f)
}

/// A registration: the profile's own wallet (from the fixture) signs, and `fee_wallet` pays the fee
/// from `tokens`. When `fee_wallet` is the profile's wallet that is the paid path; otherwise another
/// key pays for it, which the program cannot tell apart.
fn register(
    h: &mut Harness,
    p: &FixtureProof,
    market: &str,
    list_index: u32,
    fee_wallet: &Keypair,
    tokens: Address,
) -> Result<litesvm::types::TransactionMetadata, String> {
    let profile = p.wallet_keypair();
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: profile.pubkey(),
        fee_authority: fee_wallet.pubkey(),
        fee_tokens: tokens,
        treasury_tokens: h.treasury_tokens,
    };
    let args = RegisterArgs {
        market,
        did: &p.did,
        list_index,
        root: p.root_bytes(),
        code: p.code_bytes(),
        proof_a: p.a_bytes(),
        proof_b: p.b_bytes(),
        proof_c: p.c_bytes(),
    };
    let ix = register_ix(&args, &accounts);
    sign_and_send(h, ix, &profile, fee_wallet)
}

/// The profile's wallet and the fee authority both sign; once, when they are the same key.
fn sign_and_send(
    h: &mut Harness,
    ix: Instruction,
    profile: &Keypair,
    fee_wallet: &Keypair,
) -> Result<litesvm::types::TransactionMetadata, String> {
    if profile.pubkey() == fee_wallet.pubkey() {
        h.send_signed(&[ix], &[profile])
    } else {
        h.send_signed(&[ix], &[profile, fee_wallet])
    }
}

// ---------------------------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------------------------

#[test]
fn two_humans_register_in_two_markets_each() {
    let (mut h, f) = ready();

    // The list the program built from its frontier is the list Semaphore would have built.
    let leaves: Vec<[u8; 32]> = f.list(0).leaves.iter().map(|l| dec_to_be32(l)).collect();
    let list = h.list(0);
    assert_eq!(list.leaf_count, leaves.len() as u64);
    assert_eq!(list.root, lean_imt_root(&leaves), "the on-chain root must match a full rebuild");
    assert_eq!(list.root, f.proof("alice-tutors").root_bytes(), "and the root the proofs were made against");

    let mut codes = Vec::new();
    for name in ["alice-tutors", "alice-cleaning", "bob-tutors", "bob-cleaning"] {
        let p = f.proof(name);
        // The paid path: each profile's own wallet signs and pays.
        let (wallet, tokens) = h.profile_with(p, h.usdc, 1_000_000);
        let meta = register(&mut h, p, &p.market, 0, &wallet, tokens).unwrap_or_else(|e| panic!("{name}: {e}"));

        // One entry per registration, in the transaction log and in no account.
        let events = registered_events(&meta.logs);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].market, p.market);
        assert_eq!(events[0].did, p.did);
        assert_eq!(events[0].wallet.to_string(), p.wallet, "the entry names the profile's wallet");
        assert_eq!(events[0].code, p.code_bytes());
        assert_eq!(events[0].list_index, 0);
        assert_eq!(events[0].list_owner, FOUNDATION_ISSUER, "and the owner of the list that vouched");

        // One account per code: nine bytes, owned by the registry, holding only its bump.
        let account = h.account(&used_code_address(&p.code_bytes()));
        assert_eq!(account.data.len(), USED_CODE_LEN);
        assert_eq!(account.owner, PROGRAM_ID);
        assert_eq!(account.data[..8], discriminator("account", "UsedCode"));

        // The wallet paid exactly 0.25 and nothing more.
        assert_eq!(token_amount(&h.account(&tokens).data), 1_000_000 - QUARTER_USDC);
        codes.push(p.code_bytes());
    }

    // Alice's two codes differ, and so do Alice's and Bob's in the same market: one badge per
    // market per human, and nothing on the chain links a human's two badges.
    assert_ne!(codes[0], codes[1]);
    assert_ne!(codes[0], codes[2]);

    // The arrival-order tree holds all four codes, in the order they arrived.
    let tree = h.code_tree();
    assert_eq!(tree.count, 4);
    assert_eq!(tree.root, lean_imt_root(&codes), "the code tree must match a full rebuild");

    // The treasury has four quarters.
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), 4 * QUARTER_USDC);
    println!("four registrations: treasury holds {} base units", 4 * QUARTER_USDC);
}

#[test]
fn a_second_list_is_opened_and_a_proof_against_it_is_accepted() {
    let (mut h, f) = ready();

    // The foundation's issuer opens a second list of its own: it owns it and inserts at once.
    let (payer, issuer) = (h.payer.pubkey(), h.issuer.pubkey());
    h.send(&[open_list_ix(payer, issuer, 1)], &[Harness::PAYER, Harness::ISSUER]).expect("open_list");
    assert_eq!(h.config().list_count, 2);
    for leaf in &f.list(1).leaves {
        h.insert(1, dec_to_be32(leaf));
    }

    let p = f.proof("carol-tutors-list1");
    assert_eq!(h.list(1).root, p.root_bytes());
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    register(&mut h, p, TUTORS, 1, &wallet, tokens).expect("a proof against list 1");
    assert_eq!(h.code_tree().count, 1);
    println!("list 1 opened by its owner, who inserts into it, and a proof against it accepted");
}

// ---------------------------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------------------------

#[test]
fn a_proof_for_another_market_is_rejected() {
    let (mut h, f) = ready();
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    // The program never takes the scope from the client: it derives it from the market name in
    // the instruction and hands it to the verifier, so the proof simply does not verify.
    let err = register(&mut h, p, CLEANING, 0, &wallet, tokens).expect_err("must be rejected");
    assert!(err.contains("does not verify"), "{err}");
    assert!(h.svm.get_account(&used_code_address(&p.code_bytes())).is_none());
    println!("a proof for \"{TUTORS}\" is rejected when the instruction says \"{CLEANING}\"");
}

#[test]
fn the_128th_insert_pushes_a_root_out_of_the_ring() {
    // List 0 has five leaves, so Alice's root sits at ring slot 4. The insert that writes slot 4
    // again is the one with leaf_count 132, which is the 128th after hers.
    let f = Fixtures::load();
    let p = f.proof("alice-tutors");

    for (extras, should_pass) in [(127usize, true), (128usize, false)] {
        let mut h = Harness::new();
        for leaf in &f.list(0).leaves {
            h.insert(0, dec_to_be32(leaf));
        }
        for leaf in f.extra_leaves.iter().take(extras) {
            h.insert(0, dec_to_be32(leaf));
        }
        assert_eq!(h.list(0).leaf_count, 5 + extras as u64);
        let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
        let out = register(&mut h, p, TUTORS, 0, &wallet, tokens);
        if should_pass {
            out.unwrap_or_else(|e| panic!("{extras} later it must still land: {e}"));
        } else {
            let err = out.expect_err("must be rejected");
            assert!(err.contains("last 128"), "{err}");
        }
        println!("{extras} inserts later: {}", if should_pass { "still accepted" } else { "root gone, rejected" });
    }
}

#[test]
fn a_code_cannot_be_used_twice() {
    let (mut h, f) = ready();
    let p = f.proof("alice-tutors");
    let (w1, t1) = h.wallet_with(h.usdc, 1_000_000);
    register(&mut h, p, TUTORS, 0, &w1, t1).expect("the first one");

    let (w2, t2) = h.wallet_with(h.usdc, 1_000_000);
    let err = register(&mut h, p, TUTORS, 0, &w2, t2).expect_err("the second must fail");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(token_amount(&h.account(&t2).data), 1_000_000, "nothing was taken for the second");
    assert_eq!(h.code_tree().count, 1);
    println!("the same code a second time: {}", err.lines().next().unwrap());
}

#[test]
fn a_proof_for_one_list_is_rejected_against_another() {
    let (mut h, f) = ready();
    let (payer, issuer) = (h.payer.pubkey(), h.issuer.pubkey());
    h.send(&[open_list_ix(payer, issuer, 1)], &[Harness::PAYER, Harness::ISSUER]).expect("open_list");
    for leaf in &f.list(1).leaves {
        h.insert(1, dec_to_be32(leaf));
    }

    let p = f.proof("alice-tutors"); // made against list 0
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    let err = register(&mut h, p, TUTORS, 1, &wallet, tokens).expect_err("must be rejected");
    assert!(err.contains("last 128"), "{err}");
    println!("a proof made against list 0, presented against list 1: rejected");
}

#[test]
fn an_unaccepted_token_is_rejected() {
    let (mut h, f) = ready();
    let other = Address::new_unique();
    h.svm.set_account(other, spl_mint_account(6)).unwrap();
    let treasury_tokens = Address::new_unique();
    let treasury = h.treasury;
    h.svm.set_account(treasury_tokens, spl_token_account(&other, &treasury, 0)).unwrap();
    let (wallet, tokens) = h.wallet_with(other, 1_000_000);

    let p = f.proof("alice-tutors");
    let profile = p.wallet_keypair();
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: profile.pubkey(),
        fee_authority: wallet.pubkey(),
        fee_tokens: tokens,
        treasury_tokens,
    };
    let args = RegisterArgs {
        market: TUTORS,
        did: &p.did,
        list_index: 0,
        root: p.root_bytes(),
        code: p.code_bytes(),
        proof_a: p.a_bytes(),
        proof_b: p.b_bytes(),
        proof_c: p.c_bytes(),
    };
    let err = h.send_signed(&[register_ix(&args, &accounts)], &[&profile, &wallet]).expect_err("must be rejected");
    assert!(err.contains("does not accept this mint"), "{err}");
    println!("a mint the treasury never added: rejected");
}

#[test]
fn too_little_paid_writes_nothing() {
    let (mut h, f) = ready();
    let p = f.proof("alice-tutors");
    // The fee is not a number the caller chooses: the program moves 0.25 or the whole thing
    // reverts. A wallet one base unit short is the only way to pay too little.
    let (wallet, tokens) = h.wallet_with(h.usdc, QUARTER_USDC - 1);
    let err = register(&mut h, p, TUTORS, 0, &wallet, tokens).expect_err("must be rejected");
    assert!(err.contains("insufficient funds"), "{err}");
    assert!(h.svm.get_account(&used_code_address(&p.code_bytes())).is_none(), "no code account");
    assert_eq!(h.code_tree().count, 0, "nothing appended");
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), 0);
    println!("one base unit short: no code, no entry, no fee");
}

#[test]
fn an_unauthorised_key_cannot_insert() {
    let (mut h, _f) = ready();
    let stranger = Keypair::new();
    let ix = insert_identity_ix(stranger.pubkey(), 0, dec_to_be32("12345"));
    let err = h.send_signed(&[ix], &[&stranger]).expect_err("must be rejected");
    assert!(err.contains("may not insert"), "{err}");

    // And once the list's owner removes an insert key, that key cannot insert either: here the
    // owner removes its own, and stays the owner.
    let issuer = h.issuer.pubkey();
    h.send(&[issuer_ix("remove_issuer", issuer, 0, issuer)], &[Harness::PAYER, Harness::ISSUER]).expect("remove_issuer");
    assert_eq!(h.list(0).owner, issuer, "removing its own insert key leaves the owner the owner");
    assert_eq!(h.list(0).issuer_count, 0);
    let before = h.list(0).leaf_count;
    let err = h
        .send(&[insert_identity_ix(issuer, 0, dec_to_be32("12345"))], &[Harness::PAYER, Harness::ISSUER])
        .expect_err("must be rejected");
    assert!(err.contains("may not insert"), "{err}");
    assert_eq!(h.list(0).leaf_count, before, "and nobody was added or removed");
    println!("a stranger, and a removed issuer, both rejected");
}

#[test]
fn only_the_treasury_changes_settings() {
    let (mut h, _f) = ready();
    let stranger = Keypair::new();

    // The treasury's dials are the accepted tokens and the handover. Nothing else is one.
    for (what, ix) in [
        ("add_token", add_token_ix(stranger.pubkey(), h.usdc, QUARTER_USDC)),
        ("propose_treasury", propose_treasury_ix(stranger.pubkey(), Some(stranger.pubkey()))),
    ] {
        let err = h.send_signed(&[ix], &[&stranger]).expect_err("must be rejected");
        assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{what}: {err}");
    }
    // Nor accept a handover nobody proposed.
    let err = h.send_signed(&[accept_treasury_ix(stranger.pubkey())], &[&stranger]).expect_err("must be rejected");
    assert!(err.contains("no treasury handover"), "accept_treasury: {err}");
    let config = h.config();
    assert_eq!(config.treasury, TREASURY, "and the treasury is still the constant");
    assert_eq!(config.pending_treasury, Address::default(), "and nothing is pending");
    assert_eq!(config.mints, vec![USDC_MINT], "and no token was added");
    println!("a stranger cannot add a token or take the treasury");
}

#[test]
fn add_token_records_the_fee_the_treasury_sets_once_and_refuses_zero() {
    let (mut h, _f) = ready();
    let tk = h.treasury;
    assert_eq!(h.config().fees, vec![USDC_FEE], "USDC at its constant, from init");

    // A fee of zero would be a free registration inside the program: refused, at any decimals.
    let zero = Address::new_unique();
    h.svm.set_account(zero, spl_mint_account(6)).unwrap();
    let err = h.send(&[add_token_ix(tk, zero, 0)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("FeeZero") || err.contains("above zero"), "{err}");

    // Not an SPL Token mint at all.
    let impostor = Address::new_unique();
    h.svm
        .set_account(
            impostor,
            solana_account::Account {
                lamports: 1_000_000,
                data: vec![0u8; 82],
                owner: PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let err = h.send(&[add_token_ix(tk, impostor, 1)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");

    // Any decimals now: the fee is an amount, not a rule over decimals. A six-decimal dollar at
    // 250,000; an eight-decimal one at 25,000,000; a zero-decimal token at 1 whole unit; an
    // eighteen-decimal one at whatever amount the treasury judges is worth 25 cents.
    let mut added = vec![h.usdc];
    let mut fees = vec![USDC_FEE];
    for (decimals, fee) in [(6u8, 250_000u64), (8, 25_000_000), (0, 1), (18, 83_000_000_000_000)] {
        let mint = Address::new_unique();
        h.svm.set_account(mint, spl_mint_account(decimals)).unwrap();
        h.send(&[add_token_ix(tk, mint, fee)], &[Harness::PAYER, Harness::TREASURY]).expect("add_token");
        added.push(mint);
        fees.push(fee);
    }
    let config = h.config();
    assert_eq!(config.mints, added, "USDC is mints[0] forever; nothing removes a mint");
    assert_eq!(config.fees, fees, "each mint's fee, as set");

    // Set once: a mint cannot be added again at another fee, and neither can USDC.
    let err = h.send(&[add_token_ix(tk, added[1], 1)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("already accepts"), "{err}");
    let err = h.send(&[add_token_ix(tk, h.usdc, 1)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("already accepts"), "{err}");
    assert_eq!(h.config().fees, fees, "no fee moved");
    println!("add_token: a zero fee, a non-mint and repeats refused; four mints recorded at the fees the treasury set");
}

#[test]
fn each_mint_pays_the_fee_the_treasury_set_for_it_and_usdc_pays_its_constant() {
    let (mut h, f) = ready();
    let tk = h.treasury;
    let treasury = h.treasury;

    // Suppose the dollar fails: the treasury accepts another token, here one counting in eight
    // decimals, at an amount it judges sensible. Registration continues in it.
    let other = Address::new_unique();
    h.svm.set_account(other, spl_mint_account(8)).unwrap();
    let other_fee = 31_250_000; // 0.3125 of it, say
    h.send(&[add_token_ix(tk, other, other_fee)], &[Harness::PAYER, Harness::TREASURY]).expect("add_token");
    let treasury_other = h.token_account_for(other, treasury);

    // Alice pays in USDC: the constant, 250,000.
    let alice = f.proof("alice-tutors");
    let (w6, t6) = h.profile_with(alice, h.usdc, 1_000_000);
    register(&mut h, alice, TUTORS, 0, &w6, t6).expect("USDC");
    assert_eq!(token_amount(&h.account(&t6).data), 1_000_000 - USDC_FEE);
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), USDC_FEE);

    // Bob pays in the other token: exactly the fee the treasury set, nothing derived from decimals.
    let bob = f.proof("bob-tutors");
    let (w8, t8) = h.profile_with(bob, other, 100_000_000);
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: w8.pubkey(),
        fee_authority: w8.pubkey(),
        fee_tokens: t8,
        treasury_tokens: treasury_other,
    };
    let args = RegisterArgs {
        market: TUTORS,
        did: &bob.did,
        list_index: 0,
        root: bob.root_bytes(),
        code: bob.code_bytes(),
        proof_a: bob.a_bytes(),
        proof_b: bob.b_bytes(),
        proof_c: bob.c_bytes(),
    };
    h.send_signed(&[register_ix(&args, &accounts)], &[&w8]).expect("the other token");
    assert_eq!(token_amount(&h.account(&t8).data), 100_000_000 - other_fee);
    assert_eq!(token_amount(&h.account(&treasury_other).data), other_fee);

    // One base unit short of the fee, in its own units, pays nothing.
    let alice_cleaning = f.proof("alice-cleaning");
    let (short, short_tokens) = h.profile_with(alice_cleaning, other, other_fee - 1);
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: short.pubkey(),
        fee_authority: short.pubkey(),
        fee_tokens: short_tokens,
        treasury_tokens: treasury_other,
    };
    let args = RegisterArgs {
        market: CLEANING,
        did: &alice_cleaning.did,
        list_index: 0,
        root: alice_cleaning.root_bytes(),
        code: alice_cleaning.code_bytes(),
        proof_a: alice_cleaning.a_bytes(),
        proof_b: alice_cleaning.b_bytes(),
        proof_c: alice_cleaning.c_bytes(),
    };
    let err = h.send_signed(&[register_ix(&args, &accounts)], &[&short]).expect_err("one unit short");
    assert!(err.contains("insufficient funds"), "{err}");
    assert_eq!(token_amount(&h.account(&short_tokens).data), other_fee - 1, "nothing taken");

    // The mint's decimals play no part: rewriting them (which no transaction can) changes nothing.
    h.svm.set_account(other, spl_mint_account(2)).unwrap();
    let bob_cleaning = f.proof("bob-cleaning");
    let (w, t) = h.profile_with(bob_cleaning, other, other_fee);
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: w.pubkey(),
        fee_authority: w.pubkey(),
        fee_tokens: t,
        treasury_tokens: treasury_other,
    };
    let args = RegisterArgs {
        market: CLEANING,
        did: &bob_cleaning.did,
        list_index: 0,
        root: bob_cleaning.root_bytes(),
        code: bob_cleaning.code_bytes(),
        proof_a: bob_cleaning.a_bytes(),
        proof_b: bob_cleaning.b_bytes(),
        proof_c: bob_cleaning.c_bytes(),
    };
    h.send_signed(&[register_ix(&args, &accounts)], &[&w]).expect("register");
    assert_eq!(token_amount(&h.account(&t).data), 0);
    println!("USDC paid its constant 250,000; the other token paid exactly the {other_fee} the treasury set");
}

// ---------------------------------------------------------------------------------------------
// The profile's consent
// ---------------------------------------------------------------------------------------------

#[test]
fn the_profiles_wallet_signs_on_the_paid_and_the_sponsored_path() {
    let (mut h, f) = ready();
    let alice = f.proof("alice-tutors");
    let alice_wallet = alice.wallet_keypair();
    fn args<'a>(p: &'a FixtureProof, market: &'a str) -> RegisterArgs<'a> {
        RegisterArgs {
            market,
            did: &p.did,
            list_index: 0,
            root: p.root_bytes(),
            code: p.code_bytes(),
            proof_a: p.a_bytes(),
            proof_b: p.b_bytes(),
            proof_c: p.c_bytes(),
        }
    }
    let (sponsor, sponsor_tokens) = h.wallet_with(h.usdc, 10_000_000);

    // Sponsored, and the profile does not sign: refused. Nobody badges a profile without it.
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: alice_wallet.pubkey(),
        fee_authority: sponsor.pubkey(),
        fee_tokens: sponsor_tokens,
        treasury_tokens: h.treasury_tokens,
    };
    let mut ix = register_ix(&args(alice, TUTORS), &accounts);
    ix.accounts[5].is_signer = false;
    let err = h.send_signed(&[ix], &[&sponsor]).expect_err("the profile did not sign");
    assert!(err.contains("AccountNotSigner"), "{err}");

    // Another wallet signing in the profile's place, with Alice's proof: the proof names Alice's
    // wallet, so it does not verify. A relay or a sponsor that saw the proof cannot land it under
    // its own key and burn Alice's code.
    let accounts_other = RegisterAccounts { profile_wallet: sponsor.pubkey(), ..accounts };
    let err = h
        .send_signed(&[register_ix(&args(alice, TUTORS), &accounts_other)], &[&sponsor])
        .expect_err("another wallet as the profile");
    assert!(err.contains("ProofRejected") || err.contains("does not verify"), "{err}");
    assert!(h.svm.get_account(&used_code_address(&alice.code_bytes())).is_none(), "Alice's code is not burned");

    // Sponsored, with the profile signing: the sponsor pays the fee, the profile consents.
    let accounts = RegisterAccounts { profile_wallet: alice_wallet.pubkey(), ..accounts_other };
    let meta = h
        .send_signed(&[register_ix(&args(alice, TUTORS), &accounts)], &[&alice_wallet, &sponsor])
        .expect("sponsored, the profile signing");
    assert_eq!(registered_events(&meta.logs)[0].wallet, alice_wallet.pubkey());
    assert_eq!(token_amount(&h.account(&sponsor_tokens).data), 10_000_000 - USDC_FEE, "the sponsor paid");

    // The paid path: the profile's wallet is also the fee authority.
    let cleaning = f.proof("alice-cleaning");
    let (wallet, tokens) = h.profile_with(cleaning, h.usdc, USDC_FEE);
    let meta = register(&mut h, cleaning, CLEANING, 0, &wallet, tokens).expect("paid");
    assert_eq!(registered_events(&meta.logs)[0].wallet, alice_wallet.pubkey());
    assert_eq!(token_amount(&h.account(&tokens).data), 0);
    println!("the profile's wallet signs on both paths; unsigned, or another wallet in its place, refused");
}

// ---------------------------------------------------------------------------------------------
// Closing a list
// ---------------------------------------------------------------------------------------------

#[test]
fn a_closed_list_takes_no_new_members_and_every_proof_against_it_stays_valid() {
    let (mut h, f) = ready();
    let issuer = h.issuer.pubkey();
    let before = h.list(0);
    let meta = h.send(&[close_list_ix(issuer, 0)], &[Harness::PAYER, Harness::ISSUER]).expect("close_list");
    assert!(meta.logs.iter().any(|l| l.starts_with("Program data: ")), "an entry in the log");
    let after = h.list(0);
    assert!(after.closed);
    assert_eq!((after.leaf_count, after.root, after.roots.clone(), after.issuers.clone()), (before.leaf_count, before.root, before.roots, before.issuers), "nothing else moved");

    // No new members, whoever inserts.
    let err = h
        .send(&[insert_identity_ix(issuer, 0, dec_to_be32("12345"))], &[Harness::PAYER, Harness::ISSUER])
        .expect_err("closed");
    assert!(err.contains("ListClosed") || err.contains("closed to new members"), "{err}");
    // Closed once, for good: no second close, and no instruction reopens or deletes it.
    let err = h.send(&[close_list_ix(issuer, 0)], &[Harness::PAYER, Harness::ISSUER]).expect_err("twice");
    assert!(err.contains("ListClosed") || err.contains("closed to new members"), "{err}");

    // The members already in it register as before, against the roots it kept.
    for name in ["alice-tutors", "bob-cleaning"] {
        let p = f.proof(name);
        let (wallet, tokens) = h.profile_with(p, h.usdc, USDC_FEE);
        register(&mut h, p, &p.market, 0, &wallet, tokens).unwrap_or_else(|e| panic!("{name}: {e}"));
    }

    // New joiners go to a new list; closing one list does not touch another.
    let payer = h.payer.pubkey();
    h.send(&[open_list_ix(payer, issuer, 1)], &[Harness::PAYER, Harness::ISSUER]).expect("open_list");
    h.insert(1, dec_to_be32("12345"));
    assert!(!h.list(1).closed);
    assert!(h.list(0).closed);
    println!("list 0 closed: no inserts, no second close; its members still register; list 1 takes new joiners");
}

// ---------------------------------------------------------------------------------------------
// Lists and their owners (session 14: issuers are open)
// ---------------------------------------------------------------------------------------------

#[test]
fn list_0_opens_at_init_owned_by_the_foundations_issuer_key_which_is_its_first_insert_key() {
    let mut h = Harness::bare();
    let (payer, usdc) = (h.payer.pubkey(), h.usdc);
    let meta = h.send(&[init_ix(payer, usdc)], &[Harness::PAYER]).expect("init");
    let list = h.list(0);
    assert_eq!(list.owner, FOUNDATION_ISSUER, "list 0 is the foundation issuer's, a program constant");
    assert_eq!(list.issuers, vec![FOUNDATION_ISSUER], "and that key is its first insert key");
    assert_eq!(list_opened_events(&meta.logs), vec![(0, FOUNDATION_ISSUER)], "init logs list 0's opening and owner");
    // It inserts at once, with no other step.
    h.insert(0, dec_to_be32("12345"));
    assert_eq!(h.list(0).leaf_count, 1);
    println!("init opens list 0 owned by the foundation's issuer key, which inserts at once");
}

#[test]
fn anyone_opens_a_list_pays_its_rent_owns_it_and_inserts_at_once() {
    let (mut h, _f) = ready();
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let before = h.lamports_of(&stranger.pubkey());
    let (index, meta) = h.open_list_as(&stranger).expect("anyone may open a list; the treasury signs nothing");
    assert_eq!(index, 1);
    assert_eq!(h.config().list_count, 2);
    let rent = h.svm.minimum_balance_for_rent_exemption(LIST_LEN);
    assert_eq!(h.lamports_of(&stranger.pubkey()), before - rent, "the opener paid the list's rent, and only that");
    assert_eq!(h.account(&list_address(1)).data.len(), LIST_LEN);
    let list = h.list(1);
    assert_eq!(list.owner, stranger.pubkey(), "the list records its owner");
    assert_eq!(list.issuers, vec![stranger.pubkey()], "who is its first insert key");
    assert_eq!(list_opened_events(&meta.logs), vec![(1, stranger.pubkey())], "the log names the owner");
    h.insert_as(&stranger, 1, dec_to_be32("12345")).expect("the owner inserts at once");
    assert_eq!(h.list(1).leaf_count, 1);

    // The payer and the owner may be two keys; the owner must sign, so a list is never recorded
    // as owned by a key that did not agree to it.
    let owner = Keypair::new();
    let payer = h.payer.pubkey();
    h.svm.expire_blockhash();
    let msg = Message::new(&[open_list_ix(payer, owner.pubkey(), 2)], Some(&payer));
    let mut tx = Transaction::new_unsigned(msg);
    tx.partial_sign(&[&h.payer], h.svm.latest_blockhash());
    let err = h.send_tx(tx).expect_err("the owner did not sign");
    assert!(err.contains("Signature"), "{err}");
    assert_eq!(h.config().list_count, 2, "and no list opened");
    h.send_signed(&[open_list_ix(payer, owner.pubkey(), 2)], &[&owner]).expect("paid by one key, owned by another");
    assert_eq!(h.list(2).owner, owner.pubkey());
    println!("a stranger opened list 1, paid its rent, owns it and inserted; list 2 paid by one key and owned by another");
}

#[test]
fn only_a_lists_owner_adds_or_removes_its_insert_keys_or_closes_it() {
    let (mut h, _f) = ready();
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    h.open_list_as(&stranger).expect("open list 1");
    let treasury = h.treasury_signer();
    let foundation = h.issuer.insecure_clone();
    let helper = Keypair::new().pubkey();

    // Nobody but a list's owner touches its keys or closes it: not the treasury, not the owner of
    // another list.
    for (who, key, list) in [("the treasury", &treasury, 0u32), ("the treasury", &treasury, 1), ("list 1's owner", &stranger, 0), ("list 0's owner", &foundation, 1)] {
        let owner_key = h.list(list).owner;
        for (what, ix) in [
            ("add_issuer", issuer_ix("add_issuer", key.pubkey(), list, helper)),
            ("remove_issuer", issuer_ix("remove_issuer", key.pubkey(), list, owner_key)),
            ("close_list", close_list_ix(key.pubkey(), list)),
        ] {
            let err = h.send_signed(&[ix], &[key]).expect_err("must be rejected");
            assert!(err.contains("only the list's owner"), "{who} {what} on list {list}: {err}");
        }
    }
    for list in [0, 1] {
        let l = h.list(list);
        assert!(!l.closed && l.issuers == vec![l.owner], "list {list} untouched");
    }

    // Its owner does all three.
    h.send_signed(&[issuer_ix("add_issuer", stranger.pubkey(), 1, helper)], &[&stranger]).expect("add");
    assert_eq!(h.list(1).issuers, vec![stranger.pubkey(), helper]);
    h.send_signed(&[issuer_ix("remove_issuer", stranger.pubkey(), 1, stranger.pubkey())], &[&stranger]).expect("remove its own");
    assert_eq!(h.list(1).issuers, vec![helper]);
    assert_eq!(h.list(1).owner, stranger.pubkey(), "and stays the owner");
    h.send_signed(&[close_list_ix(stranger.pubkey(), 1)], &[&stranger]).expect("close");
    assert!(h.list(1).closed);
    h.send_signed(&[issuer_ix("add_issuer", foundation.pubkey(), 0, helper)], &[&foundation]).expect("list 0's owner, on list 0");
    assert_eq!(h.list(0).issuers, vec![FOUNDATION_ISSUER, helper]);
    println!("the treasury and other lists' owners are refused; each list's owner manages its keys and closes it");
}

#[test]
fn the_entry_names_the_list_and_its_owner() {
    let (mut h, f) = ready();
    // A stranger opens list 1 and vouches for its humans.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    h.open_list_as(&stranger).expect("open list 1");
    for leaf in &f.list(1).leaves {
        h.insert_as(&stranger, 1, dec_to_be32(leaf)).expect("insert");
    }
    let p = f.proof("carol-tutors-list1");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    let meta = register(&mut h, p, TUTORS, 1, &wallet, tokens).expect("a proof against list 1");
    let events = registered_events(&meta.logs);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].list_index, 1, "the entry names the list");
    assert_eq!(events[0].list_owner, stranger.pubkey(), "and its owner, so an index can weigh who vouched");

    // And against list 0, the foundation's issuer key.
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.profile_with(p, h.usdc, 1_000_000);
    let meta = register(&mut h, p, TUTORS, 0, &wallet, tokens).expect("a proof against list 0");
    let events = registered_events(&meta.logs);
    assert_eq!((events[0].list_index, events[0].list_owner), (0, FOUNDATION_ISSUER));
    println!("each entry names its list and the list's owner");
}

// ---------------------------------------------------------------------------------------------
// The rent sweep
// ---------------------------------------------------------------------------------------------

#[test]
fn a_sweep_leaves_exactly_the_new_minimum() {
    let f = Fixtures::load();
    let mut h = Harness::new();
    // Start at the rate mainnet charged before September 2026, so the code account is created
    // with the larger deposit.
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    for leaf in &f.list(0).leaves {
        h.insert(0, dec_to_be32(leaf));
    }
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    register(&mut h, p, TUTORS, 0, &wallet, tokens).expect("register");

    let code_account = used_code_address(&p.code_bytes());
    let created = h.account(&code_account).lamports;
    assert_eq!(created, rent_minimum(RENT_HIGH, USED_CODE_LEN));

    // Now the rate falls, the way SIMD-0437 lowers it in steps. The deposit does not move on
    // its own: only an instruction in the owning program can move it.
    h.svm.set_sysvar(&rent_at(RENT_TODAY));
    let minimum = rent_minimum(RENT_TODAY, USED_CODE_LEN);
    let treasury_before = h.svm.get_balance(&h.treasury).unwrap();

    let treasury = h.treasury;
    let target = SweepTarget::Code(p.code_bytes());
    h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect("sweep");

    let left = h.account(&code_account).lamports;
    assert_eq!(left, minimum, "the account keeps exactly the new minimum and not one lamport less");
    assert_eq!(h.svm.get_balance(&h.treasury).unwrap(), treasury_before + (created - minimum));
    assert_eq!(h.account(&code_account).data.len(), USED_CODE_LEN, "and its data is untouched");

    // A second sweep at the same rate has nothing to take, so it fails rather than touching it.
    let err = h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect_err("nothing left");
    assert!(err.contains("nothing above"), "{err}");

    // The step after that takes the rest, and anyone may call it: no signer for the target.
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = sweep_rent_ix(&target, treasury);
    h.svm.expire_blockhash();
    let msg = Message::new(&[ix], Some(&stranger.pubkey()));
    let tx = Transaction::new(&[&stranger], msg, h.svm.latest_blockhash());
    h.send_tx(tx).expect("a stranger may sweep");
    assert_eq!(h.account(&code_account).lamports, rent_minimum(RENT_FINAL, USED_CODE_LEN));

    // The list account sweeps the same way, and so do the config and the code tree, so nothing
    // the registry owns can end up holding rent nobody can reach.
    for target in [SweepTarget::List(0), SweepTarget::Config, SweepTarget::CodeTree] {
        let address = target.address();
        let before = h.account(&address).lamports;
        h.send(&[sweep_rent_ix(&target, treasury)], &[Harness::PAYER]).expect("sweep");
        let after = h.account(&address).lamports;
        let expected = rent_minimum(RENT_FINAL, h.account(&address).data.len());
        assert_eq!(after, expected);
        println!("swept {address}: {before} -> {after}");
    }
}

#[test]
fn a_sweep_cannot_be_pointed_anywhere_else() {
    let (mut h, f) = ready();
    h.svm.set_sysvar(&rent_at(RENT_HIGH));
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    register(&mut h, p, TUTORS, 0, &wallet, tokens).expect("register");
    h.svm.set_sysvar(&rent_at(RENT_TODAY));

    let treasury = h.treasury;
    let code = p.code_bytes();

    // The target names one account; the instruction carries another. The program derives the
    // address itself, so the substitution cannot pass.
    let mut ix = sweep_rent_ix(&SweepTarget::Code(code), treasury);
    ix.accounts[1].pubkey = list_address(0);
    let err = h.send(&[ix], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("not the registry account"), "{err}");

    // The destination is the sealed treasury and nothing else.
    let mut ix = sweep_rent_ix(&SweepTarget::Code(code), treasury);
    ix.accounts[2].pubkey = h.payer.pubkey();
    let err = h.send(&[ix], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("ConstraintAddress") || err.contains("address"), "{err}");

    // An account this program does not own is not a sweep target either.
    let stranger = Address::new_unique();
    h.svm
        .set_account(
            stranger,
            solana_account::Account {
                lamports: 10_000_000_000,
                data: vec![],
                owner: solana_system_interface::program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let mut ix = sweep_rent_ix(&SweepTarget::Code(code), treasury);
    ix.accounts[1].pubkey = stranger;
    let err = h.send(&[ix], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("not the registry account"), "{err}");
    println!("a sweep aimed at the wrong account, the wrong treasury, or a stranger's: all refused");
}

// ---------------------------------------------------------------------------------------------
// What a registration costs, and what the client's compression really encodes
// ---------------------------------------------------------------------------------------------

#[test]
fn what_a_registration_costs() {
    let (mut h, f) = ready();
    println!("\n== one registration, one proof, compressed points ==");
    // The paid path: the profile's wallet signs and pays the fee; a fee payer covers the rest.
    // The other path: one key pays everything for someone else, and the profile's wallet signs
    // for consent. The program cannot tell the two apart and does not need to.
    let payer = h.payer.insecure_clone();
    let payer_tokens = h.token_account_for(h.usdc, payer.pubkey());
    h.svm.set_account(payer_tokens, spl_token_account(&h.usdc, &payer.pubkey(), 1_000_000)).unwrap();
    for (name, path) in [("alice-tutors", "paid"), ("bob-tutors", "paid for by another key")] {
        let p = f.proof(name);
        let profile = p.wallet_keypair();
        let (fee_authority, fee_tokens) = if path == "paid" {
            h.profile_with(p, h.usdc, 1_000_000)
        } else {
            (payer.insecure_clone(), payer_tokens)
        };
        let accounts = RegisterAccounts {
            payer: payer.pubkey(),
            profile_wallet: profile.pubkey(),
            fee_authority: fee_authority.pubkey(),
            fee_tokens,
            treasury_tokens: h.treasury_tokens,
        };
        let args = RegisterArgs {
            market: TUTORS,
            did: &p.did,
            list_index: 0,
            root: p.root_bytes(),
            code: p.code_bytes(),
            proof_a: p.a_bytes(),
            proof_b: p.b_bytes(),
            proof_c: p.c_bytes(),
        };
        let ix = register_ix(&args, &accounts);
        let data_len = ix.data.len();
        let accounts_len = ix.accounts.len();

        let with_budget = vec![ComputeBudgetInstruction::set_compute_unit_limit(220_000), ix.clone()];
        h.svm.expire_blockhash();
        let msg = Message::new(&with_budget, Some(&payer.pubkey()));
        let tx = Transaction::new(&[&payer, &profile], msg, h.svm.latest_blockhash());
        let bytes = bincode::serialize(&tx).unwrap().len();

        let meta = h.send_tx(tx).unwrap_or_else(|e| panic!("{path}: {e}"));
        let cu = meta.compute_units_consumed;

        println!("   {path} path");
        println!("     instruction data       : {data_len} bytes ({accounts_len} accounts)");
        println!("     transaction, on the wire: {bytes} bytes of the 1,232 limit ({:.0}%)", bytes as f64 / 1232.0 * 100.0);
        println!("     compute units consumed : {cu} of the 1,400,000 limit ({:.1}%)", cu as f64 / 1_400_000.0 * 100.0);
        assert!(bytes < 1232, "a registration must fit in one standard transaction");
        assert!(cu < 1_400_000);
    }
    println!("   (legacy transactions with a compute-budget instruction; the client's v0 form is two bytes more)\n");
}

#[test]
fn the_clients_compressed_points_are_the_proofs_own_points() {
    // The client writes the compressed form. If a flag or a byte order were wrong, the program
    // would decompress to a different point and nothing would verify; this says so directly.
    let f = Fixtures::load();
    for p in &f.proofs {
        assert_eq!(decompress_g1(&p.a_bytes()).unwrap().to_vec(), hex(&p.uncompressed.a), "{}: A", p.name);
        assert_eq!(decompress_g2(&p.b_bytes()).unwrap().to_vec(), hex(&p.uncompressed.b), "{}: B", p.name);
        assert_eq!(decompress_g1(&p.c_bytes()).unwrap().to_vec(), hex(&p.uncompressed.c), "{}: C", p.name);
    }
    println!("{} proofs: the compressed points decompress to exactly snarkjs's points", f.proofs.len());
}

#[test]
fn the_treasury_cannot_register_for_free() {
    // 0.25, always. The only key that could arrange for the fee to move from an account to itself
    // is the treasury's own, and the program refuses it: there is no exception for anyone.
    let (mut h, f) = ready();
    let usdc = h.usdc;
    let treasury = h.treasury;
    let treasury_tokens = h.treasury_tokens;
    h.svm.set_account(treasury_tokens, spl_token_account(&usdc, &treasury, 1_000_000)).unwrap();

    let p = f.proof("alice-tutors");
    let profile = p.wallet_keypair();
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: profile.pubkey(),
        fee_authority: treasury,
        fee_tokens: treasury_tokens,
        treasury_tokens,
    };
    let args = RegisterArgs {
        market: TUTORS,
        did: &p.did,
        list_index: 0,
        root: p.root_bytes(),
        code: p.code_bytes(),
        proof_a: p.a_bytes(),
        proof_b: p.b_bytes(),
        proof_c: p.c_bytes(),
    };
    let signer = h.treasury_signer();
    let err = h.send_signed(&[register_ix(&args, &accounts)], &[&profile, &signer]).expect_err("must be rejected");
    // Anchor's duplicate-mutable-account check fires before the program's own, which is why the
    // program says so anyway: the rule belongs in the program's text, not only in a macro's
    // output, because the bytes are frozen at deploy and a reader has to be able to find it.
    assert!(
        err.contains("to itself") || err.contains("DuplicateMutableAccount"),
        "{err}"
    );
    assert_eq!(token_amount(&h.account(&treasury_tokens).data), 1_000_000, "nothing moved");
    assert!(h.svm.get_account(&used_code_address(&p.code_bytes())).is_none(), "no badge either");
    println!("the treasury paying itself: refused, and no badge written");
}

#[test]
fn init_takes_usdc_only_at_its_address_and_in_six_decimals() {
    let mut h = Harness::bare();
    let payer = h.payer.pubkey();
    let usdc = h.usdc;

    // The mint must be the one at the program's constant. Any other address is refused before
    // anything is read from it.
    let other = Address::new_unique();
    h.svm.set_account(other, spl_mint_account(6)).unwrap();
    let err = h.send(&[init_ix(payer, other)], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("ConstraintAddress") || err.contains("address"), "{err}");

    // USDC's fee is the constant 250,000, which is 0.25 only at six decimals, so init reads the
    // mint and refuses any other count. (USDC has six; this rewrites the planted account.)
    for decimals in [1u8, 8] {
        h.svm.set_account(usdc, spl_mint_account(decimals)).unwrap();
        let err = h.send(&[init_ix(payer, usdc)], &[Harness::PAYER]).expect_err("must be rejected");
        assert!(err.contains("six decimals"), "{decimals}: {err}");
    }

    h.svm.set_account(usdc, spl_mint_account(6)).unwrap();
    h.send(&[init_ix(payer, usdc)], &[Harness::PAYER]).expect("init");
    let config = h.config();
    assert_eq!(config.mints, vec![USDC_MINT]);
    assert_eq!(config.fees, vec![USDC_FEE]);
    assert_eq!(config.treasury, TREASURY);
    assert_eq!(config.list_count, 1, "the first list is opened at init");
    assert_eq!(h.list(0).leaf_count, 0);
    assert_eq!(h.code_tree().count, 0);
    println!("init: the wrong mint address, and a USDC that does not count in six decimals, both refused");
}

#[test]
fn init_runs_once_and_writes_only_the_constants() {
    let mut h = Harness::bare();
    let usdc = h.usdc;

    // A stranger gets there first. They pay the rent and get nothing for it: the treasury is the
    // program's constant, not theirs, and there is no argument or signer through which they could
    // have named anything else.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = init_ix(stranger.pubkey(), usdc);
    h.svm.expire_blockhash();
    let msg = Message::new(&[ix], Some(&stranger.pubkey()));
    let tx = Transaction::new(&[&stranger], msg, h.svm.latest_blockhash());
    h.send_tx(tx).expect("anyone may init");
    let config = h.config();
    assert_eq!(config.treasury, TREASURY);
    assert_ne!(config.treasury, stranger.pubkey());
    assert_eq!(config.pending_treasury, Address::default(), "no handover is pending at init");
    assert_eq!(config.mints, vec![USDC_MINT]);

    // And the stranger can turn no dial.
    let err = h
        .send_signed(&[add_token_ix(stranger.pubkey(), usdc, USDC_FEE)], &[&stranger])
        .expect_err("must be rejected");
    assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{err}");

    // A second init, from anyone, fails: the config account already exists.
    let payer = h.payer.pubkey();
    let err = h.send(&[init_ix(payer, usdc)], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(h.config().treasury, TREASURY, "and nothing changed");
    println!("init by a stranger writes the constants; a second init: {}", err.lines().next().unwrap());
}

/// Every dial, tried from one key: the ones that must pass `has_one = treasury`. The lists are not
/// among them: a list is its owner's.
fn dials(h: &Harness, key: Address) -> Vec<(&'static str, Instruction)> {
    vec![
        ("add_token", add_token_ix(key, h.usdc, USDC_FEE)),
        ("propose_treasury", propose_treasury_ix(key, Some(key))),
    ]
}

fn assert_no_dial(h: &mut Harness, key: &Keypair, who: &str) {
    for (what, ix) in dials(h, key.pubkey()) {
        let err = h.send_signed(&[ix], &[key]).expect_err("must be rejected");
        assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{who} {what}: {err}");
    }
}

#[test]
fn a_handover_is_proposed_then_accepted_and_only_then_does_anything_move() {
    let (mut h, f) = ready();
    let old = h.treasury;
    let old_key = h.treasury_signer();
    let usdc = h.usdc;

    // Not the zero key, and not the current key.
    let err = h
        .send(&[propose_treasury_ix(old, Some(Address::default()))], &[Harness::PAYER, Harness::TREASURY])
        .expect_err("must be rejected");
    assert!(err.contains("zero key"), "{err}");
    let err = h
        .send(&[propose_treasury_ix(old, Some(old))], &[Harness::PAYER, Harness::TREASURY])
        .expect_err("must be rejected");
    assert!(err.contains("is the current one"), "{err}");
    assert_eq!(h.config().pending_treasury, Address::default());

    // Step one. A plain key here; a multisig's vault address works the same way.
    let multisig = Keypair::new();
    h.svm.airdrop(&multisig.pubkey(), 1_000_000).unwrap();
    h.send(&[propose_treasury_ix(old, Some(multisig.pubkey()))], &[Harness::PAYER, Harness::TREASURY])
        .expect("propose_treasury");
    let config = h.config();
    assert_eq!(config.treasury, old, "nothing has moved");
    assert_eq!(config.pending_treasury, multisig.pubkey(), "the proposal is recorded");

    // Between the two steps the old key keeps every power: it turns the dials, is paid, and is
    // swept. The pending key can do nothing yet.
    h.send(&[add_token_ix(old, usdc, USDC_FEE)], &[Harness::PAYER, Harness::TREASURY])
        .expect_err("USDC is already accepted: past has_one, refused on the merits");
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(usdc, 1_000_000);
    register(&mut h, p, TUTORS, 0, &wallet, tokens).expect("paid to the old treasury while a proposal is pending");
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), QUARTER_USDC);
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let target = SweepTarget::Code(p.code_bytes());
    h.send(&[sweep_rent_ix(&target, old)], &[Harness::PAYER]).expect("swept to the old treasury while a proposal is pending");
    assert_no_dial(&mut h, &multisig, "the pending key, before accepting,");

    // Only the pending key can accept: not a stranger, not the old treasury.
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000).unwrap();
    let err = h.send_signed(&[accept_treasury_ix(stranger.pubkey())], &[&stranger]).expect_err("must be rejected");
    assert!(err.contains("only the proposed treasury key"), "{err}");
    let err = h.send_signed(&[accept_treasury_ix(old)], &[&old_key]).expect_err("must be rejected");
    assert!(err.contains("only the proposed treasury key"), "{err}");
    assert_eq!(h.config().treasury, old, "still nothing has moved");

    // Step two.
    h.send_signed(&[accept_treasury_ix(multisig.pubkey())], &[&multisig]).expect("accept_treasury");
    let config = h.config();
    assert_eq!(config.treasury, multisig.pubkey());
    assert_eq!(config.pending_treasury, Address::default(), "the slot is cleared");

    // Now the old key can turn no dial, including proposing a handover back to itself.
    assert_no_dial(&mut h, &old_key, "the old key, after acceptance,");
    let err = h.send_signed(&[accept_treasury_ix(old)], &[&old_key]).expect_err("must be rejected");
    assert!(err.contains("no treasury handover"), "{err}");

    // Nor be paid: a token account the old key owns is refused as the fee's destination, and
    // one the new treasury owns is where the quarter goes. (The rent rate goes back up first, so
    // this badge's account has something above the final minimum for the sweep below.)
    h.svm.set_sysvar(&rent_at(RENT_TODAY));
    let p = f.proof("alice-cleaning");
    let (wallet, tokens) = h.wallet_with(usdc, 1_000_000);
    let err = register(&mut h, p, CLEANING, 0, &wallet, tokens).expect_err("must be rejected");
    assert!(err.contains("ConstraintTokenOwner") || err.contains("token owner"), "{err}");
    assert_eq!(token_amount(&h.account(&tokens).data), 1_000_000, "nothing moved");
    h.treasury_tokens = h.token_account_for(usdc, multisig.pubkey());
    register(&mut h, p, CLEANING, 0, &wallet, tokens).expect("paid to the new treasury");
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), QUARTER_USDC);

    // Nor receive swept rent: the sweep's destination is whatever the config says now.
    h.svm.set_sysvar(&rent_at(RENT_FINAL));
    let target = SweepTarget::Code(p.code_bytes());
    let err = h.send(&[sweep_rent_ix(&target, old)], &[Harness::PAYER]).expect_err("must be rejected");
    assert!(err.contains("ConstraintAddress") || err.contains("address"), "{err}");
    h.send(&[sweep_rent_ix(&target, multisig.pubkey())], &[Harness::PAYER]).expect("swept to the new treasury");

    // The new treasury holds every dial, the handover included, and can hand back the same way.
    h.send_signed(&[propose_treasury_ix(multisig.pubkey(), Some(old))], &[&multisig]).expect("and proposes again");
    h.send_signed(&[accept_treasury_ix(old)], &[&old_key]).expect("and the old key accepts");
    assert_eq!(h.config().treasury, old);
    println!("treasury handed over in two steps: nothing moved until the new key signed, then everything did");
}

#[test]
fn a_second_proposal_overwrites_the_first_and_proposing_nothing_clears_it() {
    let (mut h, _f) = ready();
    let old = h.treasury;
    let first = Keypair::new();
    let second = Keypair::new();
    h.svm.airdrop(&first.pubkey(), 1_000_000).unwrap();
    h.svm.airdrop(&second.pubkey(), 1_000_000).unwrap();

    h.send(&[propose_treasury_ix(old, Some(first.pubkey()))], &[Harness::PAYER, Harness::TREASURY]).expect("first");
    h.send(&[propose_treasury_ix(old, Some(second.pubkey()))], &[Harness::PAYER, Harness::TREASURY]).expect("second");
    assert_eq!(h.config().pending_treasury, second.pubkey(), "the second proposal replaced the first");

    // The first key can no longer accept; the second can.
    let err = h.send_signed(&[accept_treasury_ix(first.pubkey())], &[&first]).expect_err("must be rejected");
    assert!(err.contains("only the proposed treasury key"), "{err}");
    assert_eq!(h.config().treasury, old);

    // A proposal of nothing clears the slot, and then nobody can accept.
    h.send(&[propose_treasury_ix(old, None)], &[Harness::PAYER, Harness::TREASURY]).expect("clear");
    assert_eq!(h.config().pending_treasury, Address::default());
    let err = h.send_signed(&[accept_treasury_ix(second.pubkey())], &[&second]).expect_err("must be rejected");
    assert!(err.contains("no treasury handover"), "{err}");
    assert_eq!(h.config().treasury, old, "the treasury never moved");

    // A typo, in other words a key nobody holds, can be proposed and simply never accepted.
    let nobody = Address::new_unique();
    h.send(&[propose_treasury_ix(old, Some(nobody))], &[Harness::PAYER, Harness::TREASURY]).expect("propose a typo");
    assert_eq!(h.config().pending_treasury, nobody);
    let usdc = h.usdc;
    let err = h.send(&[add_token_ix(old, usdc, USDC_FEE)], &[Harness::PAYER, Harness::TREASURY]).expect_err("already accepted");
    assert!(err.contains("already accepts this mint"), "past has_one, so the treasury still holds its dials: {err}");
    h.send(&[propose_treasury_ix(old, Some(second.pubkey()))], &[Harness::PAYER, Harness::TREASURY]).expect("and corrects it");
    h.send_signed(&[accept_treasury_ix(second.pubkey())], &[&second]).expect("accepted by the corrected key");
    assert_eq!(h.config().treasury, second.pubkey());
    println!("a second proposal overwrites the first; proposing nothing clears it; a typo is recoverable");
}

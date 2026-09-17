//! The registry, run under LiteSVM against real Semaphore proofs made with the pinned July 2024
//! ceremony artifacts (`registry/client/scripts/fixtures.ts` writes them; the file is committed).
//!
//! Run with `cargo test -- --nocapture` to see the measured compute units and transaction bytes.

use forest_registry_tests::*;
use groth16_solana::decompression::{decompress_g1, decompress_g2};
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TUTORS: &str = "online-tutors";
const CLEANING: &str = "house-cleaning";

/// A registry with list 0 filled and Alice's and Bob's wallets funded.
fn ready() -> (Harness, Fixtures) {
    let f = Fixtures::load();
    let mut h = Harness::new();
    for leaf in &f.list(0).leaves {
        h.insert(0, dec_to_be32(leaf));
    }
    (h, f)
}

fn register(
    h: &mut Harness,
    p: &FixtureProof,
    market: &str,
    list_index: u32,
    wallet: &Keypair,
    tokens: Address,
) -> Result<litesvm::types::TransactionMetadata, String> {
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: wallet.pubkey(),
        profile_tokens: tokens,
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
    h.send_signed(&[ix], &[wallet])
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
        let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
        let meta = register(&mut h, p, &p.market, 0, &wallet, tokens).unwrap_or_else(|e| panic!("{name}: {e}"));

        // One entry per registration, in the transaction log and in no account.
        let events = registered_events(&meta.logs);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].market, p.market);
        assert_eq!(events[0].did, p.did);
        assert_eq!(events[0].code, p.code_bytes());
        assert_eq!(events[0].list_index, 0);

        // One account per code: nine bytes, owned by the registry, holding only its bump.
        let account = h.account(&used_code_address(&p.code_bytes()));
        assert_eq!(account.data.len(), USED_CODE_LEN);
        assert_eq!(account.owner, PROGRAM_ID);
        assert_eq!(account.data[..8], discriminator("account", "UsedCode"));

        // The wallet paid exactly 0.25 and nothing more.
        assert_eq!(token_amount(&h.account(&tokens).data), 1_000_000 - REGISTRATION_FEE);
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
    assert_eq!(token_amount(&h.account(&h.treasury_tokens).data), 4 * REGISTRATION_FEE);
    println!("four registrations: treasury holds {} base units", 4 * REGISTRATION_FEE);
}

#[test]
fn a_second_list_is_opened_and_a_proof_against_it_is_accepted() {
    let (mut h, f) = ready();

    let (payer, tk) = (h.payer.pubkey(), h.treasury_key.pubkey());
    h.send(&[open_list_ix(payer, tk, 1)], &[Harness::PAYER, Harness::TREASURY]).expect("open_list");
    assert_eq!(h.config().list_count, 2);
    let issuer = h.issuer.pubkey();
    h.send(&[issuer_ix("add_issuer", tk, 1, issuer)], &[Harness::PAYER, Harness::TREASURY]).expect("add_issuer");
    for leaf in &f.list(1).leaves {
        h.insert(1, dec_to_be32(leaf));
    }

    let p = f.proof("carol-tutors-list1");
    assert_eq!(h.list(1).root, p.root_bytes());
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    register(&mut h, p, TUTORS, 1, &wallet, tokens).expect("a proof against list 1");
    assert_eq!(h.code_tree().count, 1);
    println!("list 1 opened, its own issuer added, and a proof against it accepted");
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
    let (payer, tk) = (h.payer.pubkey(), h.treasury_key.pubkey());
    h.send(&[open_list_ix(payer, tk, 1)], &[Harness::PAYER, Harness::TREASURY]).expect("open_list");
    let issuer = h.issuer.pubkey();
    h.send(&[issuer_ix("add_issuer", tk, 1, issuer)], &[Harness::PAYER, Harness::TREASURY]).expect("add_issuer");
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
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: wallet.pubkey(),
        profile_tokens: tokens,
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
    let err = h.send_signed(&[register_ix(&args, &accounts)], &[&wallet]).expect_err("must be rejected");
    assert!(err.contains("does not accept this mint"), "{err}");
    println!("a mint the treasury never added: rejected");
}

#[test]
fn too_little_paid_writes_nothing() {
    let (mut h, f) = ready();
    let p = f.proof("alice-tutors");
    // The fee is not a number the caller chooses: the program moves 0.25 or the whole thing
    // reverts. A wallet one base unit short is the only way to pay too little.
    let (wallet, tokens) = h.wallet_with(h.usdc, REGISTRATION_FEE - 1);
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

    // And once the treasury key removes an issuer, that key cannot insert either.
    let tk = h.treasury_key.pubkey();
    let issuer = h.issuer.pubkey();
    h.send(&[issuer_ix("remove_issuer", tk, 0, issuer)], &[Harness::PAYER, Harness::TREASURY]).expect("remove_issuer");
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
fn only_the_treasury_key_changes_settings() {
    let (mut h, _f) = ready();
    let stranger = Keypair::new();
    let payer = h.payer.pubkey();

    for (what, ix) in [
        ("open_list", open_list_ix(payer, stranger.pubkey(), 1)),
        ("add_issuer", issuer_ix("add_issuer", stranger.pubkey(), 0, stranger.pubkey())),
        ("add_token", add_token_ix(stranger.pubkey(), h.usdc)),
    ] {
        let err = h.send_signed(&[ix], &[&stranger]).expect_err("must be rejected");
        assert!(err.contains("ConstraintHasOne") || err.contains("has one"), "{what}: {err}");
    }
    println!("a stranger cannot open a list, add an issuer or add a token");
}

#[test]
fn add_token_takes_only_the_shape_the_config_fixes() {
    let (mut h, _f) = ready();
    let tk = h.treasury_key.pubkey();
    assert_eq!(h.config().token_decimals, 6);

    // Nine decimals would make 250,000 base units mean 0.00025, not 0.25.
    let nine = Address::new_unique();
    h.svm.set_account(nine, spl_mint_account(9)).unwrap();
    let err = h.send(&[add_token_ix(tk, nine)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("exactly the decimals"), "{err}");

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
    let err = h.send(&[add_token_ix(tk, impostor)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("AccountOwnedByWrongProgram"), "{err}");

    // A second dollar stablecoin with the right shape is accepted, and USDC stays first.
    let usdt = Address::new_unique();
    h.svm.set_account(usdt, spl_mint_account(6)).unwrap();
    h.send(&[add_token_ix(tk, usdt)], &[Harness::PAYER, Harness::TREASURY]).expect("add_token");
    let config = h.config();
    assert_eq!(config.mints.len(), 2);
    assert_eq!(config.mints[0], h.usdc, "USDC is mints[0] forever; nothing removes a mint");
    assert_eq!(config.mints[1], usdt);

    // And the same one twice is refused.
    let err = h.send(&[add_token_ix(tk, usdt)], &[Harness::PAYER, Harness::TREASURY]).expect_err("must be rejected");
    assert!(err.contains("already accepts"), "{err}");
    println!("add_token: wrong decimals, wrong owner and a repeat all refused");
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
    let p = f.proof("alice-tutors");
    let (wallet, tokens) = h.wallet_with(h.usdc, 1_000_000);
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: wallet.pubkey(),
        profile_tokens: tokens,
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
    let msg = Message::new(&with_budget, Some(&h.payer.pubkey()));
    let tx = Transaction::new(&[&h.payer, &wallet], msg, h.svm.latest_blockhash());
    let bytes = bincode::serialize(&tx).unwrap().len();

    let meta = h.send_tx(tx).expect("register");
    let cu = meta.compute_units_consumed;

    println!("\n== one registration, one proof, compressed points ==");
    println!("   instruction data      : {data_len} bytes ({accounts_len} accounts)");
    println!("   transaction, on the wire: {bytes} bytes of the 1,232 limit ({:.0}%)", bytes as f64 / 1232.0 * 100.0);
    println!("   compute units consumed : {cu} of the 1,400,000 limit ({:.1}%)", cu as f64 / 1_400_000.0 * 100.0);
    println!("   (a legacy transaction with a compute-budget instruction; the client's v0 form is two bytes more)\n");

    assert!(bytes < 1232, "a registration must fit in one standard transaction");
    assert!(cu < 1_400_000);
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
    let accounts = RegisterAccounts {
        payer: h.payer.pubkey(),
        profile_wallet: treasury,
        profile_tokens: treasury_tokens,
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
    let err = h.send_signed(&[register_ix(&args, &accounts)], &[&signer]).expect_err("must be rejected");
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
fn init_holds_the_first_mint_to_the_same_rule_as_every_later_one() {
    let mut h = Harness::bare();
    let nine = Address::new_unique();
    h.svm.set_account(nine, spl_mint_account(9)).unwrap();
    let (payer, tk, treasury) = (h.payer.pubkey(), h.treasury_key.pubkey(), h.treasury);

    let err = h
        .send(&[init_ix(payer, tk, treasury, nine)], &[Harness::PAYER, Harness::TREASURY])
        .expect_err("must be rejected");
    assert!(err.contains("exactly the decimals"), "{err}");

    let usdc = h.usdc;
    h.send(&[init_ix(payer, tk, treasury, usdc)], &[Harness::PAYER, Harness::TREASURY]).expect("init");
    let config = h.config();
    assert_eq!(config.mints, vec![usdc]);
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.treasury_key, tk);
    assert_eq!(config.list_count, 1, "the first list is opened at init");
    assert_eq!(h.list(0).leaf_count, 0);
    assert_eq!(h.code_tree().count, 0);
    println!("init: a mint add_token would refuse is refused here too");
}

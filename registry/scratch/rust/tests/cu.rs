//! Q5: compute units for a registration, measured under LiteSVM with the scratch SBF program
//! (../program, built with `cargo build-sbf`). Two or three real depth-20 Semaphore proofs, one keccak,
//! a 20-level Poseidon insert, code accounts created as PDAs, and an SPL token transfer.
//! Transaction bytes are counted separately, in ../js/txsize.mjs.
use ark_bn254::{Fq, G1Affine};
use ark_ff::{BigInteger, PrimeField};
use litesvm::LiteSVM;
use num_bigint::BigUint;
use serde::Deserialize;
use solana_account::Account;
use solana_address::Address;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::ops::Neg;

#[derive(Deserialize)]
struct File { cases: Vec<Case> }
#[derive(Deserialize)]
struct Case { proof: Proof, publicSignals: Vec<String> }
#[derive(Deserialize)]
struct Proof { pi_a: Vec<String>, pi_b: Vec<Vec<String>>, pi_c: Vec<String> }

fn be32(s: &str) -> [u8; 32] {
    let b = BigUint::parse_bytes(s.as_bytes(), 10).unwrap().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}
fn g1(p: &[String]) -> [u8; 64] { let mut o = [0u8; 64]; o[..32].copy_from_slice(&be32(&p[0])); o[32..].copy_from_slice(&be32(&p[1])); o }
fn g2(p: &[Vec<String>]) -> [u8; 128] {
    let mut o = [0u8; 128];
    o[..32].copy_from_slice(&be32(&p[0][1])); o[32..64].copy_from_slice(&be32(&p[0][0]));
    o[64..96].copy_from_slice(&be32(&p[1][1])); o[96..].copy_from_slice(&be32(&p[1][0]));
    o
}
fn negate_g1(p: &[u8; 64]) -> [u8; 64] {
    let a = G1Affine::new_unchecked(Fq::from_be_bytes_mod_order(&p[..32]), Fq::from_be_bytes_mod_order(&p[32..])).neg();
    let mut o = [0u8; 64];
    o[..32].copy_from_slice(&a.x.into_bigint().to_bytes_be()); o[32..].copy_from_slice(&a.y.into_bigint().to_bytes_be());
    o
}
/// proof_a (negated) | proof_b | proof_c | 4 public inputs, 384 bytes, as the program reads it.
fn proof_blob(c: &Case) -> (Vec<u8>, [u8; 32]) {
    let mut v = Vec::new();
    v.extend_from_slice(&negate_g1(&g1(&c.proof.pi_a)));
    v.extend_from_slice(&g2(&c.proof.pi_b));
    v.extend_from_slice(&g1(&c.proof.pi_c));
    for s in &c.publicSignals { v.extend_from_slice(&be32(s)); }
    (v, be32(&c.publicSignals[1]))
}

const TOKEN: Address = solana_address::address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

fn token_account(mint: &Address, owner: &Address, amount: u64) -> Account {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state: Initialized
    Account { lamports: 2_039_280, data: d, owner: TOKEN, executable: false, rent_epoch: 0 }
}
fn mint_account() -> Account {
    let mut d = vec![0u8; 82];
    d[44] = 6; // decimals
    d[45] = 1; // is_initialized
    Account { lamports: 1_461_600, data: d, owner: TOKEN, executable: false, rent_epoch: 0 }
}

struct Run { label: &'static str, proofs: usize, hash_rounds: u8, pdas: usize, transfer: bool }

const MARKET: &[u8] = b"online-tutors";

fn run(r: &Run) -> (u64, Vec<String>) {
    run_with_market(r, MARKET).expect("transaction should succeed")
}

fn run_with_market(r: &Run, market: &[u8]) -> Result<(u64, Vec<String>), String> {
    let so = std::fs::read("../program/target/deploy/registry_cu_scratch.so").expect("build the program first: cargo build-sbf in ../program");
    // A fixed program id, so the PDA bump (and therefore find_program_address's cost,
    // 1,500 CU per attempt) is the same on every run and the numbers are reproducible.
    let program_id = solana_address::address!("FoREsT1itwbGkPHmVqNtR6eZ4ZtwW5g2SsYZrKt8Hnfe");
    let mut svm = LiteSVM::new();
    svm.add_program(program_id, &so).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let f: File = serde_json::from_str(&std::fs::read_to_string("../js/proofs-20.json").unwrap()).unwrap();
    let mut data = vec![r.proofs as u8, r.hash_rounds, r.pdas as u8, r.transfer as u8, market.len() as u8];
    data.extend_from_slice(market);
    let mut nullifiers = Vec::new();
    for i in 0..r.proofs {
        let (blob, n) = proof_blob(&f.cases[i % f.cases.len()]);
        data.extend_from_slice(&blob);
        nullifiers.push(n);
    }
    let mut metas = vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(solana_system_interface::program::ID, false)];
    for i in 0..r.pdas {
        let seed = nullifiers.get(i).copied().unwrap_or([i as u8; 32]);
        let (pda, _) = Address::find_program_address(&[b"code", &seed], &program_id);
        metas.push(AccountMeta::new(pda, false));
    }
    let wallet = Keypair::new();
    if r.transfer {
        let mint = Address::new_unique();
        let (src, dst) = (Address::new_unique(), Address::new_unique());
        svm.set_account(mint, mint_account()).unwrap();
        svm.set_account(src, token_account(&mint, &wallet.pubkey(), 1_000_000)).unwrap();
        svm.set_account(dst, token_account(&mint, &Address::new_unique(), 0)).unwrap();
        metas.push(AccountMeta::new(src, false));
        metas.push(AccountMeta::new(dst, false));
        metas.push(AccountMeta::new_readonly(wallet.pubkey(), true));
        metas.push(AccountMeta::new_readonly(TOKEN, false));
    }
    let ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        Instruction { program_id, accounts: metas, data },
    ];
    let msg = Message::new(&ixs, Some(&payer.pubkey()));
    let signers: Vec<&Keypair> = if r.transfer { vec![&payer, &wallet] } else { vec![&payer] };
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(meta) => Ok((meta.compute_units_consumed, meta.logs)),
        Err(e) => Err(e.meta.logs.join("\n")),
    }
}

#[test]
fn compute_units_for_a_registration() {
    let runs = [
        Run { label: "1 proof only", proofs: 1, hash_rounds: 0, pdas: 0, transfer: false },
        Run { label: "2 proofs only", proofs: 2, hash_rounds: 0, pdas: 0, transfer: false },
        Run { label: "2 proofs + keccak + 20 poseidon + 2 PDAs (free number)", proofs: 2, hash_rounds: 20, pdas: 2, transfer: false },
        Run { label: "2 proofs + keccak + 20 poseidon + 2 PDAs + token transfer (paid)", proofs: 2, hash_rounds: 20, pdas: 2, transfer: true },
        Run { label: "3 proofs + keccak + 20 poseidon + 2 PDAs + token transfer (paid, gap check)", proofs: 3, hash_rounds: 20, pdas: 2, transfer: true },
    ];
    for r in &runs {
        let (cu, logs) = run(r);
        println!("\n== {} ==\n   compute units consumed: {}   (limit 1,400,000)", r.label, cu);
        for l in logs.iter().filter(|l| l.contains("consumed") || l.contains("consumption") || l.contains("Program log")) { println!("   {}", l); }
        assert!(cu < 1_400_000);
    }
}

/// The program recomputes the scope from the market name in the instruction and requires the
/// proof's scope public signal to match, so a proof made for one market cannot register another.
#[test]
fn a_proof_for_another_market_is_rejected() {
    let r = Run { label: "wrong market name", proofs: 1, hash_rounds: 0, pdas: 0, transfer: false };
    let err = run_with_market(&r, b"house-cleaning").expect_err("must be rejected");
    assert!(err.contains("scope mismatch"), "unexpected logs:\n{err}");
    println!("a depth-20 proof for \"online-tutors\" is rejected when the instruction says \"house-cleaning\"");
}

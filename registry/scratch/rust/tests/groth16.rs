//! Q2: a real Semaphore proof (snarkjs, published depth-20 artifacts) verified with
//! groth16-solana on the host (solana-bn254 does the curve arithmetic, the same as the syscalls).
use ark_bn254::{Fq, G1Affine};
use ark_ff::{BigInteger, PrimeField};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use num_bigint::BigUint;
use serde::Deserialize;
use std::ops::Neg;

#[derive(Deserialize)]
struct File { depth: usize, vkey: Vk, cases: Vec<Case> }
#[derive(Deserialize)]
struct Vk { nPublic: usize, vk_alpha_1: Vec<String>, vk_beta_2: Vec<Vec<String>>, vk_gamma_2: Vec<Vec<String>>, vk_delta_2: Vec<Vec<String>>, IC: Vec<Vec<String>> }
#[derive(Deserialize)]
struct Case { name: String, proof: Proof, publicSignals: Vec<String> }
#[derive(Deserialize)]
struct Proof { pi_a: Vec<String>, pi_b: Vec<Vec<String>>, pi_c: Vec<String> }

fn be32(s: &str) -> [u8; 32] {
    let b = BigUint::parse_bytes(s.as_bytes(), 10).unwrap().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}
/// snarkjs G1 [x, y, 1] -> 64 bytes: x big-endian, y big-endian.
fn g1(p: &[String]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&be32(&p[0]));
    out[32..].copy_from_slice(&be32(&p[1]));
    out
}
/// snarkjs G2 [[x0, x1], [y0, y1], [1, 0]] -> 128 bytes: x1, x0, y1, y0, each big-endian
/// (the imaginary part first, as the alt_bn128 syscalls and the EVM precompile expect).
fn g2(p: &[Vec<String>]) -> [u8; 128] {
    let mut out = [0u8; 128];
    out[..32].copy_from_slice(&be32(&p[0][1]));
    out[32..64].copy_from_slice(&be32(&p[0][0]));
    out[64..96].copy_from_slice(&be32(&p[1][1]));
    out[96..].copy_from_slice(&be32(&p[1][0]));
    out
}
/// The one change a snarkjs proof needs: A is negated, because the verifier feeds the pairing
/// e(-A, B) e(inputs, gamma) e(C, delta) e(alpha, beta) == 1 and the syscall has no negation.
fn negate_g1(p: &[u8; 64]) -> [u8; 64] {
    let x = Fq::from_be_bytes_mod_order(&p[..32]);
    let y = Fq::from_be_bytes_mod_order(&p[32..]);
    let a = G1Affine::new_unchecked(x, y).neg();
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&a.x.into_bigint().to_bytes_be());
    out[32..].copy_from_slice(&a.y.into_bigint().to_bytes_be());
    out
}

fn load(depth: usize) -> File {
    serde_json::from_str(&std::fs::read_to_string(format!("../js/proofs-{depth}.json")).unwrap()).unwrap()
}

fn run(depth: usize) {
    let f = load(depth);
    assert_eq!(f.vkey.nPublic, 4);
    let ic: Vec<[u8; 64]> = f.vkey.IC.iter().map(|p| g1(p)).collect();
    let vk = Groth16Verifyingkey {
        nr_pubinputs: 4,
        vk_alpha_g1: g1(&f.vkey.vk_alpha_1),
        vk_beta_g2: g2(&f.vkey.vk_beta_2),
        vk_gamme_g2: g2(&f.vkey.vk_gamma_2),
        vk_delta_g2: g2(&f.vkey.vk_delta_2),
        vk_ic: &ic,
    };
    for c in &f.cases {
        let a = g1(&c.proof.pi_a);
        let a_neg = negate_g1(&a);
        let b = g2(&c.proof.pi_b);
        let cc = g1(&c.proof.pi_c);
        let mut inputs = [[0u8; 32]; 4];
        for (i, s) in c.publicSignals.iter().enumerate() { inputs[i] = be32(s); }

        let mut v = Groth16Verifier::new(&a_neg, &b, &cc, &inputs, &vk).unwrap();
        v.verify().expect("proof with negated A verifies");
        println!("depth {} case {}: verifies with groth16-solana (A negated, big-endian, G2 imaginary-first)", depth, c.name);

        let mut v = Groth16Verifier::new(&a, &b, &cc, &inputs, &vk).unwrap();
        assert!(v.verify().is_err(), "the un-negated snarkjs proof must NOT verify");

        let mut bad = inputs;
        bad[1][31] ^= 1; // a different nullifier
        let mut v = Groth16Verifier::new(&a_neg, &b, &cc, &bad, &vk).unwrap();
        assert!(v.verify().is_err(), "a changed public input must not verify");
    }
    // A proof made for the other scope does not verify against this case's public inputs.
    let (m, b1) = (&f.cases[0], &f.cases[1]);
    let mut inputs = [[0u8; 32]; 4];
    for (i, s) in m.publicSignals.iter().enumerate() { inputs[i] = be32(s); }
    let a_neg = negate_g1(&g1(&b1.proof.pi_a));
    let (b, c) = (g2(&b1.proof.pi_b), g1(&b1.proof.pi_c));
    let mut v = Groth16Verifier::new(&a_neg, &b, &c, &inputs, &vk).unwrap();
    assert!(v.verify().is_err());
}

#[test]
fn depth_20_semaphore_proof_verifies() { run(20) }

#[test]
fn depth_32_semaphore_proof_verifies() { run(32) }

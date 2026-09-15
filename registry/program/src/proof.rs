//! The Groth16 side: Semaphore's circuit, verified with `groth16-solana` and the sealed key.
//!
//! The verification key in `verifying_key.rs` was written by `groth16-solana`'s own converter
//! from `semaphore-32.json`, the depth-32 verification key of the public July 2024 Semaphore
//! ceremony. It is baked in forever; see `registry/artifacts/README.md`.
//!
//! Two wire-format steps, both from session 3's feasibility check:
//!
//! 1. the points arrive compressed (32, 64, 32 bytes instead of 64, 128, 64), so they are
//!    decompressed with the `alt_bn128` syscalls before verification;
//! 2. `proof_a` must be negated, because the verifier checks
//!    `e(-A, B) * e(inputs, gamma) * e(C, delta) * e(alpha, beta) == 1` and the pairing syscall
//!    has no negation of its own.
//!
//! The negation happens here, in the program, not on the device: the sealed side owns the
//! convention, so a client cannot get it subtly wrong and a reader has one place to check it.

use anchor_lang::prelude::*;
use groth16_solana::{
    decompression::{decompress_g1, decompress_g2},
    groth16::Groth16Verifier,
};

use crate::errors::RegistryError;
use crate::verifying_key::VERIFYINGKEY;

/// BN254's base field modulus, big-endian. Used only to negate a point's y coordinate.
const BN254_P: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// BN254's scalar field order, big-endian. Every public input must be below it.
const BN254_R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Is this 32-byte big-endian value a BN254 scalar? Byte-wise comparison of two big-endian
/// arrays is numeric comparison.
pub fn is_field_element(x: &[u8; 32]) -> bool {
    *x < BN254_R
}

/// `(x, y)` becomes `(x, p - y)`, both 32-byte big-endian halves of a 64-byte G1 point.
fn negate_g1(g1: &[u8; 64]) -> [u8; 64] {
    let mut out = *g1;
    if g1[32..].iter().all(|b| *b == 0) {
        return out; // y = 0 is its own negation
    }
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = BN254_P[i] as i16 - g1[32 + i] as i16 - borrow;
        if d < 0 {
            out[32 + i] = (d + 256) as u8;
            borrow = 1;
        } else {
            out[32 + i] = d as u8;
            borrow = 0;
        }
    }
    out
}

/// Verify one Semaphore proof against the sealed key.
///
/// `public_inputs` are in the order snarkjs and the Semaphore library use them:
/// `[merkleTreeRoot, nullifier, message, scope]`. The caller supplies the root and the nullifier
/// (the code); the program derives the message and the scope itself, so a proof made for another
/// market or another profile simply does not verify.
pub fn verify(
    proof_a: &[u8; 32],
    proof_b: &[u8; 64],
    proof_c: &[u8; 32],
    public_inputs: &[[u8; 32]; 4],
) -> Result<()> {
    for input in public_inputs {
        require!(is_field_element(input), RegistryError::NotAFieldElement);
    }
    let a = decompress_g1(proof_a).map_err(|_| error!(RegistryError::ProofMalformed))?;
    let b = decompress_g2(proof_b).map_err(|_| error!(RegistryError::ProofMalformed))?;
    let c = decompress_g1(proof_c).map_err(|_| error!(RegistryError::ProofMalformed))?;
    let a_neg = negate_g1(&a);

    let mut verifier = Groth16Verifier::new(&a_neg, &b, &c, public_inputs, &VERIFYINGKEY)
        .map_err(|_| error!(RegistryError::ProofMalformed))?;
    verifier
        .verify()
        .map_err(|_| error!(RegistryError::ProofRejected))?;
    Ok(())
}

//! Semaphore's tree, on the chain.
//!
//! Semaphore's `Group` is a LeanIMT over Poseidon(2). Its rules, from `@zk-kit/lean-imt` and
//! checked against it byte for byte in session 3:
//!
//! - leaves are appended left to right; there are no zero leaves and no fixed depth;
//! - a parent is `Poseidon(left, right)`; a node with no right sibling is copied up unchanged,
//!   not hashed against a zero;
//! - depth is `ceil(log2(size))`, so a tree of one leaf has depth 0 and its root is the leaf.
//!
//! An append needs one node per level: the left node at that level still waiting for a right
//! sibling. That is the frontier, and it is all the program stores. No client ever supplies a
//! Merkle path to append, which is why an append costs no transaction bytes at all.

use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::errors::RegistryError;

/// The depth the circuit's verification key is sealed at. A list holds at most 2^32 leaves.
pub const MAX_DEPTH: usize = 32;
/// Levels 0 to `MAX_DEPTH` inclusive: the last leaf of a full depth-32 tree lands at level 32.
pub const FRONTIER_LEN: usize = MAX_DEPTH + 1;

/// Semaphore's hash: Poseidon over BN254 with circomlib's parameters, big-endian field elements,
/// through Solana's `sol_poseidon` syscall.
pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    Ok(hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .map_err(|_| error!(RegistryError::HashFailed))?
        .0)
}

/// `ceil(log2(count))`, with depth 0 for a tree of one leaf.
pub fn depth_for(count: u64) -> u32 {
    if count <= 1 {
        0
    } else {
        64 - (count - 1).leading_zeros()
    }
}

/// Append one leaf, update the frontier in place, and return the new root.
///
/// `count` is the number of leaves already in the tree, so it is also the new leaf's index.
pub fn append(frontier: &mut [[u8; 32]; FRONTIER_LEN], count: u64, leaf: [u8; 32]) -> Result<[u8; 32]> {
    let new_count = count.checked_add(1).ok_or(error!(RegistryError::TreeFull))?;
    let depth = depth_for(new_count) as usize;
    require!(depth <= MAX_DEPTH, RegistryError::TreeFull);

    // Walk up while the index bit is 1: the new node is a right sibling, so it hashes with the
    // node waiting at that level. The first 0 bit is where it comes to rest and waits in turn.
    let mut node = leaf;
    let mut i = count;
    let mut level = 0usize;
    while i & 1 == 1 {
        node = poseidon2(&frontier[level], &node)?;
        i >>= 1;
        level += 1;
    }
    frontier[level] = node;

    // Fold the rest of the way to the root. `i` is the resting node's index at `level`, and it is
    // even, so the first step is always a copy-up. Above that, a 1 bit means a left sibling exists
    // and is the one the frontier holds; a 0 bit means no partner, so the node is copied up.
    let mut root = node;
    let mut j = i;
    let mut l = level;
    while l < depth {
        if j & 1 == 1 {
            root = poseidon2(&frontier[l], &root)?;
        }
        j >>= 1;
        l += 1;
    }
    Ok(root)
}

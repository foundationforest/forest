//! Q3: Solana's Poseidon (solana-poseidon, the same code the syscall runs) against Semaphore's
//! poseidon-lite vectors, and the LeanIMT roots rebuilt with the Solana-side hash.
use num_bigint::BigUint;
use serde::Deserialize;
use solana_poseidon::{hashv, Endianness, Parameters};

#[derive(Deserialize)]
struct Vectors { poseidon2: Vec<P2>, trees: Vec<Tree>, proofs: Vec<Proof> }
#[derive(Deserialize)]
struct P2 { inputs: Vec<String>, out: String }
#[derive(Deserialize)]
struct Tree { leaves: Vec<String>, depth: usize, root: String }
#[derive(Deserialize)]
struct Proof { size: usize, leaf: usize, siblings: Vec<String>, index: u64, root: String }

fn be(s: &str) -> [u8; 32] {
    let b = BigUint::parse_bytes(s.as_bytes(), 10).unwrap().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}
fn dec(b: &[u8; 32]) -> String { BigUint::from_bytes_be(b).to_string() }
fn h2(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b]).unwrap().to_bytes()
}

fn vectors() -> Vectors {
    serde_json::from_str(&std::fs::read_to_string("../js/vectors.json").unwrap()).unwrap()
}

#[test]
fn poseidon2_matches_semaphore() {
    for v in vectors().poseidon2 {
        let out = h2(&be(&v.inputs[0]), &be(&v.inputs[1]));
        assert_eq!(dec(&out), v.out, "poseidon2({:?})", v.inputs);
        println!("poseidon2({}, {}) = {} (solana-poseidon == poseidon-lite)", v.inputs[0], v.inputs[1], v.out);
    }
}

/// The on-chain tree rules: a level's nodes pair up left to right; a node with no right sibling is
/// copied up unhashed; depth = ceil(log2(size)); size 1 has depth 0 and root = leaf.
fn lean_imt_root(leaves: &[[u8; 32]]) -> ([u8; 32], usize) {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut depth = 0;
    while level.len() > 1 {
        let mut next = Vec::new();
        for pair in level.chunks(2) {
            next.push(if pair.len() == 2 { h2(&pair[0], &pair[1]) } else { pair[0] });
        }
        level = next;
        depth += 1;
    }
    (level[0], depth)
}

#[test]
fn lean_imt_roots_match_semaphore_group() {
    for t in vectors().trees {
        let leaves: Vec<[u8; 32]> = t.leaves.iter().map(|l| be(l)).collect();
        let (root, depth) = lean_imt_root(&leaves);
        assert_eq!(dec(&root), t.root, "size {}", leaves.len());
        assert_eq!(depth, t.depth);
        println!("size {}: depth {} root {} (Rust == @zk-kit/lean-imt)", leaves.len(), depth, t.root);
    }
}

/// The circuit's rule (binary-merkle-root.circom): walk `siblings.len()` levels, bit i of `index`
/// says whether the node is on the right; levels with no sibling are skipped entirely.
#[test]
fn lean_imt_proofs_verify_with_solana_hash() {
    let v = vectors();
    for p in v.proofs {
        let t = v.trees.iter().find(|t| t.leaves.len() == p.size).unwrap();
        let mut node = be(&t.leaves[p.leaf]);
        for (i, s) in p.siblings.iter().enumerate() {
            let s = be(s);
            node = if (p.index >> i) & 1 == 1 { h2(&s, &node) } else { h2(&node, &s) };
        }
        assert_eq!(dec(&node), p.root, "size {} leaf {}", p.size, p.leaf);
        println!("size {} leaf {}: {} siblings, index {}, root reproduced", p.size, p.leaf, p.siblings.len(), p.index);
    }
}

/// Insert cost model: an append touches at most `depth` hashes, and only the left siblings
/// on the path of the last leaf are needed (the "frontier"), one per level.
#[test]
fn append_with_frontier_matches_full_rebuild() {
    let leaves: Vec<[u8; 32]> = (1u64..=37).map(|i| { let mut b = [0u8; 32]; b[24..].copy_from_slice(&i.to_be_bytes()); b }).collect();
    let mut frontier: Vec<Option<[u8; 32]>> = Vec::new(); // frontier[level] = the left node waiting for a right sibling
    for n in 1..=leaves.len() {
        // append leaf n-1 (index n-1)
        let mut node = leaves[n - 1];
        let mut idx = n - 1;
        let mut level = 0;
        loop {
            if frontier.len() <= level { frontier.push(None); }
            if idx & 1 == 1 {
                node = h2(&frontier[level].unwrap(), &node);
                idx >>= 1; level += 1;
            } else {
                frontier[level] = Some(node);
                break;
            }
        }
        // the root: fold the frontier from the top, copying nodes with no partner
        let (full, _) = lean_imt_root(&leaves[..n]);
        // recompute root from the frontier: walk the path of the last leaf upward across all levels
        let depth = if n == 1 { 0 } else { (usize::BITS - (n - 1).leading_zeros()) as usize };
        let mut r = leaves[n - 1];
        let mut i = n - 1;
        for l in 0..depth {
            if i & 1 == 1 { r = h2(&frontier[l].unwrap(), &r); }
            i >>= 1;
        }
        assert_eq!(r, full, "size {}", n);
    }
    println!("appends 1..=37 with a per-level frontier reproduce the full-rebuild root");
}

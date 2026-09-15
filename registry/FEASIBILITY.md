# Registry feasibility check

Session 3, September 15, 2026. Build-order item 4, taken before the `markets` repo session on purpose: the registry is the one piece nobody has built on Solana, and its answer can change the plan. Report only. Nothing here is built or shipped. Every number below was produced in this session; the scripts and tests that produced them are in `scratch/` and can be rerun.

## The short version

**Verdict: go, with changes.** Every piece fits together as designed: Semaphore's circuit and its published setup files work unchanged, a real Semaphore proof verifies inside a Solana program, Solana's built-in Poseidon hash reproduces Semaphore's tree exactly, an identity can be made from 32 bytes our keys recipe derives, and a registration with two proofs uses about a sixth of one transaction's compute limit. No fallback is needed.

Three things change the plan:

1. **The design's "badge-(k-1) exists" check cannot be enforced with two proofs.** A numbered code is a hash of the scope and the human's secret. Nothing on the chain links this human's badge-k to their badge-(k-1) unless the registration also carries a proof for badge-(k-1). So either a registration past the first carries three proofs (measured: it fits, 322,000 compute units of 1,400,000, about 0.7 seconds more on the device), or the check is dropped and the later cross-profile proof deals with gaps another way. This is a decision for Carlos, listed under Open.
2. **Bytes, not compute, are the tight limit.** A paid registration with two proofs in the plain format is 1,296 bytes, over Solana's 1,232-byte limit. It fits with either of two standard tools (a lookup table for the fixed accounts: 1,175 bytes; compressed proof points: 1,040 bytes), and both together make three proofs fit too (1,112 bytes). Solana activated a 4,096-byte transaction format on mainnet today (epoch 1035); it would remove the problem, but it is hours old, drops two features we use, and Kora's support for it is unverified. Recommendation: compressed points plus a lookup table.
3. **Storage per badge is paid in rent by the sponsor, and it is about the size of the fee.** Two never-closed accounts per badge cost 0.0024 SOL today (about 0.25 dollars at 102.31 dollars per SOL). Solana is in the middle of a five-step rent cut; when it completes (planned for about November 2026), the same two accounts cost about 0.03 dollars. Plain accounts are the recommendation for v1: the alternative (Light Protocol's compressed accounts, about 0.003 dollars per badge) makes a sealed program depend on three services and on programs that one private key can upgrade.

Two more things to settle before anything is sealed: the provenance of the current setup files (the keys in use since August 2025 come from a newer setup than the public July 2024 ceremony, and the docs do not say who ran it), and the tree depth (a million identities fit in depth 20, but depth 32 removes the cap forever at zero on-chain cost and 0.3 seconds more per proof on the device).

What it costs per registration, measured or computed this session:

| Item | Two proofs | Three proofs |
|---|---|---|
| Compute units (limit 1,400,000) | 224,890 paid, 222,016 free | 321,981 paid |
| Transaction bytes (limit 1,232; 4,096 in the new format) | 1,296 plain; 1,175 with a lookup table; 1,040 compressed; 919 both | 1,617 plain; 1,112 compressed plus lookup table |
| Rent for the badge's accounts, today | 0.0024 SOL, about 0.25 dollars | same |
| Rent after the planned cuts finish | 0.00033 SOL, about 0.03 dollars | same |
| Network fee | 0.00001 SOL, paid by Kora | same |
| Proof time on this machine, in Node, depth 20 | 0.63 to 0.70 s each, warm | same per proof |
| Proof time estimate on a mid-range phone, depth 20 | 2 to 5 s each | same per proof |

## 1. The circuit and its setup files

**Circuit.** Semaphore v4, `packages/circuits/src/semaphore.circom` in `semaphore-protocol/semaphore`, published on npm as `@semaphore-protocol/circuits` 4.14.3 (July 8, 2026). Circom 2.1.5. Read this session from the repository's main branch. Its inputs and outputs:

| Signal | Kind | Meaning |
|---|---|---|
| `secret` | private input | the secret scalar of the identity (see section 4) |
| `merkleProofLength`, `merkleProofIndex`, `merkleProofSiblings[MAX_DEPTH]` | private inputs | the Merkle path of the identity commitment |
| `message` | public input | an arbitrary value the proof is bound to; the circuit only squares it |
| `scope` | public input | the topic; one proof per identity per scope is detectable |
| `merkleRoot` | output | the root the path leads to |
| `nullifier` | output | `Poseidon(2)([scope, secret])` |

The commitment is `Poseidon(2)([Ax, Ay])` where `(Ax, Ay)` is the Baby Jubjub public key `secret * B8`. The circuit also enforces `secret < l` (the subgroup order) with `LessThan(251)`. The Merkle root comes from `@zk-kit/binary-merkle-root.circom` 2.0.0, which takes a dynamic depth and one packed `index`; its source warns that it outputs 0 when `depth > MAX_DEPTH`, so the verifier must bound the depth and never accept root 0.

Public signals, in the order snarkjs and the Semaphore library use them: `[merkleTreeRoot, nullifier, message, scope]` (from `packages/proof/src/verify-proof.ts`). Confirmed by generating proofs (section 2).

**How the library hashes scope and message.** `packages/proof/src/hash.ts`: `keccak256(32-byte big-endian value) >> 8`. A text scope goes through ethers' `encodeBytes32String` first, which right-pads with zeros and refuses more than 31 bytes; a `Uint8Array` is taken as a big-endian number as is. This session passed both as 32-byte arrays: scope = the market name's UTF-8, right-padded with zeros; message = the profile's DID, UTF-8, exactly 32 bytes for a `did:plc`. So:

- market code: scope = `bytes32("online-tutors")`, nullifier `17029940321254103264959984922092211033446662906971341308726669191533849106632` for the test identity;
- numbered code: scope = `bytes32("badge-1")`, nullifier `8803688732587729885222386551452594017826593719582718270677866086200416936534`;
- on the chain, the program recomputes `keccak256(padded bytes) >> 8` from the market name in the instruction and requires the proof's scope signal to equal it; keccak is a Solana syscall and the recomputation plus the comparison cost 390 compute units. The scratch program does this, and a test (`a_proof_for_another_market_is_rejected`) shows a proof made for `online-tutors` failing when the instruction says `house-cleaning`. So the client never supplies the scope, only the name.

A market name longer than 32 bytes would need hashing first; the markets directory should cap names or the program should hash names unconditionally. Listed under Open. The `message` binds the proof to the DID, so a proof cannot be replayed for another profile. The same identity with the same scope and a different DID gives the same nullifier (checked); a different identity gives a different one (checked).

**Setup files.** Published at `https://snark-artifacts.pse.dev/semaphore/<version>/semaphore-<depth>.{zkey,wasm,json}` for depths 1 to 32, served by PSE's snark-artifacts project (`@zk-kit/artifacts` 2.0.1 fetches them; `@semaphore-protocol/proof` 4.14.3 hardcodes version `4.13.0`). Downloaded and hashed this session:

| File | Bytes | SHA-256 |
|---|---|---|
| `4.13.0/semaphore-20.zkey` | 3,890,175 | `33f9a067a80c7daf90e085449073613a9559a1904dd40aeb6d603afb7988c2cc` |
| `4.13.0/semaphore-20.wasm` | 1,847,949 | `6f71e55586929e520e76027ebe067daac8b41e2f4b8057313a5fd0304e1e44ee` |
| `4.13.0/semaphore-20.json` | 3,744 | `6fda771369c19517c8f7575cb9f1d18a8846e46baa1dc0c032bac9492c29559e` |
| `4.13.0/semaphore-32.zkey` | 5,850,470 | `2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650` |
| `4.13.0/semaphore-32.wasm` | 1,859,813 | `528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5` |
| `4.13.0/semaphore-32.json` | 3,746 | `3c0fd8c30c15df4db6970c0dfac35a3ac8d566ed5924072c9852ee566d4a90ae` |

The files were last modified August 26, 2025. They correspond to the circuit source: proofs generated with the 4.13.0 wasm and zkey verify against the 4.13.0 verification key, both in snarkjs and in groth16-solana (section 2), and the wasm takes the single `merkleProofIndex` input of the current circuit.

**Provenance, the part that needs an answer.** The public "Semaphore V4 Ceremony" (PSE's p0tion, ceremony.pse.dev, over 400 participants, finished July 13, 2024) produced the `4.0.0` artifacts for the previous circuit, which took an array `merkleProofIndices`. The circuit changed in `@semaphore-protocol/circuits` 4.13.0 (binary-merkle-root 2.0.0, one packed index), and new keys were published as `4.13.0`. Comparing the two depth-20 verification keys this session: `vk_alpha_1`, `vk_beta_2`, `vk_gamma_2` identical (same phase 1), `vk_delta_2` and `IC` different (a new phase 2). The Semaphore docs still cite only the 2024 ceremony; nothing found says who contributed to the 4.13.0 phase 2. A sealed program bakes one verification key in forever, so this must be confirmed with PSE first. If the 4.13.0 setup was not a public ceremony, the alternative is the `4.0.0` artifacts with `@semaphore-protocol/*` 4.12.x pinned (the old circuit and library still exist on npm). Both are "Semaphore's circuit and setup files, unchanged".

**Depth.** The circuit's `MAX_DEPTH` is a compile-time bound; the tree's real depth is dynamic and the proof carries it, so one depth-20 key verifies proofs for any list of up to 2^20 = 1,048,576 identities. The key is sealed with the program, so the depth is a hard cap on how many humans v1 can ever hold. On-chain cost does not depend on the depth: the verification key has five points whatever the depth, and verification cost is the same. Device cost does: measured 0.63 to 0.70 s per proof at depth 20 and 0.93 to 1.11 s at depth 32, and a 2 MB larger download. Proposal: depth 32 (4.29 billion, no cap), with depth 20 as the alternative if 0.3 s per proof matters more than the cap. Artifacts exist for both.

## 2. Verifying on Solana

**Verifier.** `groth16-solana` 0.2.0 from crates.io (Light Protocol; `Groth16Verifier::new(proof_a, proof_b, proof_c, public_inputs, vk)`, then `verify()`), built on `solana-bn254` 2.x, which on the Solana target calls the `alt_bn128` syscalls and on a host does the same arithmetic in software. The repository's main branch is ahead of the published crate (a `circom-vk` build feature, pinocchio, a benchmark of 91,448 compute units for four public inputs); 0.2.0 ships a Node script, `parse_vk_to_rust.js`, that does the key conversion. Either is fine; the report used the published crate as is.

**Conversion of the verification key** (`semaphore-20.json` from snarkjs, four public inputs) to the crate's `Groth16Verifyingkey`, exactly what the crate's script does:

1. Every field element is a decimal string; write it as 32 bytes big-endian.
2. G1 points (`vk_alpha_1`, each `IC[i]`): drop the trailing projective `1`; bytes are `x || y`, 64 bytes.
3. G2 points (`vk_beta_2`, `vk_gamma_2`, `vk_delta_2`): snarkjs gives `[[x0, x1], [y0, y1], [1, 0]]`; bytes are `x1 || x0 || y1 || y0`, 128 bytes (imaginary part first, the order the syscalls and the EVM precompile expect).
4. `vk_ic` is the list of five G1 points. `nr_pubinputs` is not read by `verify()` (the script writes the IC length, 5).

Run this session: `node parse_vk_to_rust.cjs ../artifacts/semaphore-20.json ../program/src` wrote `verifying_key.rs`, used by the scratch program.

**Conversion of a proof** (snarkjs `proof.json`): `pi_a` and `pi_c` as G1 above, `pi_b` as G2 above, and public signals as 32-byte big-endian. One change is required: **`pi_a` must be negated** (`y` becomes `p - y`) before it is handed to the verifier, because the verifier checks `e(-A, B) * e(inputs, gamma) * e(C, delta) * e(alpha, beta) == 1` and the pairing syscall has no negation of its own. The scratch test does this with `ark-bn254` on the host; on a device it is one field subtraction. Nothing else changes.

**Result.** `scratch/rust/tests/groth16.rs`, `cargo test --test groth16`: the depth-20 and depth-32 proofs for both scopes verify with `groth16-solana` 0.2.0. The same proof with `pi_a` not negated fails; a proof with one public input changed fails; the badge-1 proof against the market proof's public inputs fails. So a proof for Semaphore's circuit verifies unchanged, with the negation of A as the only wire-format step. The scratch SBF program (section 5) then verified the same proofs under LiteSVM using the real syscalls.

## 3. Hashing

**Same hash.** Solana's Poseidon syscall (`sol_poseidon`, exposed as `solana-poseidon`, parameters `Bn254X5`, endianness `BigEndian`) is Light Protocol's `light-poseidon`, generated from circomlib's parameters: BN254 scalar field, x^5 S-box, 8 full rounds, width 3 for two inputs (57 partial rounds), 1 to 12 inputs. Semaphore hashes with `poseidon-lite` 0.3.0 (`poseidon2`), also circomlib's parameters. `scratch/rust/tests/poseidon.rs` checks four vectors written by `scratch/js/tree.mjs`; all match, for example:

```
poseidon2(1, 2) = 7853200120776062878684798364095072458815029376092732009249414926327459813530
              = 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a
poseidon2(0, 0) = 14744269619966411208579211824598458697587494354926760081771325075741142829156
```

Cost measured in the scratch program: 20 two-input hashes, 17,431 compute units, 872 each. Agave charges `61 * n^2 + 542` for the syscall itself, so 786 for two inputs; the rest is the loop and the copies around it.

**Tree rules.** Semaphore's `Group` is `@zk-kit/lean-imt` 2.2.5 with `poseidon2` (`packages/group/src/index.ts`). The rules, from its source and confirmed by the tests:

- Leaves are appended left to right; no zero leaves, no fixed depth. Depth is `ceil(log2(size))`; a tree of one leaf has depth 0 and its root is the leaf.
- Parents are `hash(left, right)`. A node with no right sibling is copied up unchanged (not hashed with a zero).
- A Merkle proof lists only the levels where a sibling exists, so its length can be less than the depth, and its `index` packs the left/right bits of those levels only. The circuit walks `merkleProofLength` levels and uses the bits of `index`.

Small trees built two ways (`@zk-kit/lean-imt` in JS, and a Rust rebuild with `solana-poseidon`) give the same roots for sizes 1, 2, 3, 4, 5 and 8, for example size 3: `16127060048284825593061728854900944353039729664315771964025865858524127961853` = `h(h(11, 22), 33)`. The JS proofs for leaves 0 and 2 of the size-3 tree and leaves 0 and 4 of the size-5 tree reproduce the root under the circuit's walk in Rust.

**What the on-chain tree must do to stay identical.** Store the size, the current root, and a frontier of one 32-byte node per level (the left node at each level still waiting for a right sibling, at most `depth` of them, 32 levels at most). An append walks up from the new leaf: while the index bit is 1, hash `(frontier[level], node)`; at the first 0 bit, store the node in the frontier and stop; the new root is the fold of the last leaf's path where a node with no partner is copied. The scratch test `append_with_frontier_matches_full_rebuild` checks this for sizes 1 to 37. Keep a short history of recent roots so a proof made moments before an insert still verifies (Semaphore's contract keeps old roots valid for one hour by default); reject a proof whose depth exceeds the sealed `MAX_DEPTH` and never hold root 0 in the history (the empty tree). Storing the leaves themselves on the chain is not needed for verification and costs 32 bytes of rent each; the issuer must publish the list (or it is replayed from the insert transactions) so a device can build its path.

## 4. The identity

`@semaphore-protocol/identity` 4.14.3: `new Identity(privateKey)` takes a `Buffer`, `Uint8Array` or string of any length (a random 32 bytes if omitted). `scratch/js/identity.mjs` built one from 32 bytes derived the way `keys/SPEC.md` derives every key: `HKDF-SHA256(seed, salt = empty, info = "forest.foundation/identity/v1", 32)`, with the seed from `keys/test/vectors.json`. The library's answer was reproduced by hand, step by step, from `@zk-kit/eddsa-poseidon` 1.1.0:

1. `h = BLAKE-512(privateKey)`, first 32 bytes (`blake512` from `@noble/hashes/blake1` gave the same bytes).
2. Prune: `h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40`.
3. `secretScalar = (little-endian integer of h >> 3) mod l`, with `l = 2736030358979909402780800718157159386076813972158567259200215660948447373041`.
4. `publicKey = secretScalar * B8` on Baby Jubjub (`@zk-kit/baby-jubjub` 1.0.3).
5. `commitment = Poseidon(2)([publicKey.x, publicKey.y])`.

So the identity commitment is a Poseidon hash of the two coordinates of a Baby Jubjub public key, and that key is the secret scalar (BLAKE-512 of our 32 bytes, pruned, shifted) times the base point. The nullifier uses the same secret scalar: `Poseidon(2)([scope, secretScalar])`. For the test bytes: secret scalar `2637071886574317557357748745269659878450060864322449153662462920291629818323`, commitment `14568690134484466610252976219100933485694269593799802854234702390895629808185`. Same bytes give the same identity; the wallet key's bytes give a different one; `export()`/`import()` round-trips.

**What `keys/` would need** (not changed this session): one more HKDF output from the seed with info `forest.foundation/identity/v1`, returned as 32 bytes, with no profile index in the string because the identity is per human. The spec's fixed-strings table gets one row; the library gets one function (`identitySecret(seed)`), the test vectors one pinned value. The Semaphore identity object is built from those bytes on the device at proof time; nothing is stored. The Semaphore library's own hashing (BLAKE-512, pruning) stays as is; it is part of the sealed circuit's definition of a commitment.

## 5. One transaction

**Method.** Measured, not estimated. A scratch SBF program (`scratch/program`, built with `cargo build-sbf` from Solana CLI 4.2.2, platform-tools v1.54, downloaded this session from release.anza.xyz) verifies N real depth-20 proofs with `groth16-solana` 0.2.0, hashes the market name with keccak, does a 20-level Poseidon insert, creates code accounts as PDAs (40 bytes each) through the system program, and does one SPL Token transfer of 0.25 (250,000 base units). It ran under LiteSVM 0.16.0 (`scratch/rust/tests/cu.rs`, `cargo test --test cu -- --nocapture`), which runs the real syscalls and reports compute units. Transaction bytes were counted with `@solana/web3.js` 1.99.0 (`scratch/js/txsize.mjs`), cross-checked against real serialization wherever the message fit.

**Compute units, of 1,400,000 per transaction:**

| Run | Total | Breakdown from the program's own logs |
|---|---|---|
| one proof, nothing else | 99,798 | verify 97,204; entry, logging and exit about 2,400 |
| two proofs, nothing else | 196,889 | 97,204 + 97,091 |
| two proofs, keccak and the scope check, 20 Poseidon, two code accounts (a free number) | 222,016 | keccak and the check 390; Poseidon 17,426; two PDAs 8,488; the rest as above |
| the same plus the 0.25 transfer (a paid number) | 224,890 | transfer 2,174 including the call (the token program itself used 76: the p-token rewrite is active on mainnet, feature `ptokFjwy...` checked) |
| three proofs, everything (a paid number with the gap check) | 321,981 | one more verify, 97,091 |

The program id is pinned in the test, because `find_program_address` costs 1,500 compute units per bump it tries and a different program id gives a different bump; across random ids the total moved by a few thousand units. A sealed program should store each PDA's bump and use `create_program_address`, which costs one attempt.

Compressed proof points would add decompression: 398 for each G1 and 13,610 for the G2 (Agave's cost table), 14,406 per proof, so about 254,000 for two proofs and 365,000 for three. Both alt_bn128 syscall features, including compression, read as activated on mainnet this session (`A16q37op...` and `EJJewYSd...`). All far below the limit; two proofs use 16 percent of it. The transaction needs a `SetComputeUnitLimit` instruction above the 200,000 default; Kora allows it (it only checks the priority fee).

**Bytes.** Solana's legacy and v0 transactions are limited to 1,232 bytes. The counts, for a realistic instruction (market name, DID, root, badge number, one proof and nullifier per code; accounts: registry state, tree, code PDAs, the previous code, the entry, payer, system program, and for a paid number the profile wallet, its token account, the treasury's, the token program; one signature for Kora, one more for the profile wallet when paying; a compute-limit instruction):

| Proofs | Points | Paid | Plain | With a lookup table |
|---|---|---|---|---|
| 2 | 256 B each | no | 1,100 | 1,041 |
| 2 | 256 B each | yes | **1,296, over** | 1,175 |
| 2 | 128 B compressed | no | 844 | 785 |
| 2 | 128 B compressed | yes | 1,040 | 919 |
| 3 | 256 B each | no | **1,421, over** | **1,362, over** |
| 3 | 256 B each | yes | **1,617, over** | **1,496, over** |
| 3 | 128 B compressed | no | 1,037 | 978 |
| 3 | 128 B compressed | yes | **1,233, over by one** | 1,112 |

A lookup table (one foundation-owned table listing the fixed accounts, referenced by one byte each; Kora resolves them) or compressed points brings two proofs under the limit; both together bring three proofs under it. Solana's new v1 transaction format raises the limit to 4,096 bytes and every row fits in it; its feature gate (`txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL`) shows activated on mainnet at epoch 1035, that is today, September 15, 2026. It also removes lookup tables and compute-budget instructions (the limit moves into a header), and Kora's code only logs a warning for it. Recommendation for v1: stay on the v0 format with compressed points and a lookup table; revisit the v1 format once Kora supports it.

**One or two transactions.** Both proofs (or all three) fit in one instruction of one transaction, so a registration is atomic: both codes are written or neither, and the fee moves only when they are. Two instructions in one transaction would gain nothing in bytes or compute. Two transactions would lose atomicity: a market code without its numbered code, or a paid fee without a badge, would need cleanup rules a sealed program cannot get wrong.

Other limits: 64 accounts per transaction (this uses 12 to 13); the 0.25 transfer needs the profile wallet's signature and Kora's `max_signatures` at 2 or more; Kora's `require_one_of_programs` can require the registry program with no custom code, and its `max_allowed_lamports` must cover the rent below because the payer of `create_account` is the fee payer.

## 6. Storage per badge

**Plain accounts.** Mainnet rent today, read from the Rent sysvar this session: 5,080 lamports per byte, exemption threshold 1.0, so an account costs `(128 + data bytes) * 5,080` lamports once, held as long as it exists (the RPC's `getMinimumBalanceForRentExemption` gave 650,240 for 0 bytes and 1,666,240 for 200, matching). The rate was 6,960 until September 3 and is on a five-step cut (SIMD-0437) to 696 lamports per byte; step 2 landed September 11, the remaining steps are planned for Agave 4.4, about November 2026. At 102.31 dollars per SOL (CoinGecko, fetched this session):

| Accounts per badge | Bytes | Rent today | Rent at 696 per byte |
|---|---|---|---|
| Market code PDA holding the entry (market name up to 64, DID 32, both codes 64, number, discriminator, bump: 176 bytes) | 176 | 1,544,320 lamports, 0.158 dollars | 0.022 dollars |
| Numbered code PDA (number and a pointer, 40 bytes) | 40 | 853,440 lamports, 0.087 dollars | 0.012 dollars |
| **Total, two accounts** | | **2,397,760 lamports = 0.0024 SOL = 0.245 dollars** | **0.034 dollars** |
| Alternative: a third, separate entry account (two 40-byte codes plus a 176-byte entry) | 256 | 3,251,200 lamports, 0.333 dollars | 0.046 dollars |

Storing the entry inside the market code account saves one account with no loss: the market code must exist anyway and is what indexes look up. A million badges: about 2,400 SOL today, about 330 SOL after the cuts. Rent is locked, never spent, and never returned because the accounts must never close (a code must never be reusable). Who pays it is an open question: the fee payer of the transaction (Kora) unless the program takes it from the 0.25.

**Light Protocol's compressed accounts.** Live on mainnet, audited (ten reports listed), used through `light-sdk` 0.25.0 and `@lightprotocol/stateless.js` 0.23.3. Per their fee table: 5,000 lamports per state tree touched per instruction, about 300 per new leaf, 10,000 per new address (needed for a unique id like a code), so about 15,300 lamports (0.0016 dollars) per compressed code account, 0.003 dollars per badge, and no rent. What it costs in return:

- Three services: Photon, the indexer (Helius maintains it; self-hostable, Postgres), which every read of compressed state goes through; a prover (Go, self-hostable, needs the proving keys), which every write needs for its validity proof; and a forester, which empties the nullifier and address queues and rolls trees over. A full queue is a liveness failure for that tree (their whitepaper). With the prover down: reads work, no writes. With Photon down: neither. Hosting all three is possible from open source; who runs them in production and with what promise is not documented.
- Non-inclusion proofs exist and are the thing we would want later: address trees (indexed Merkle trees, V2 height 40) prove "this address does not exist" through `getValidityProof` with `newAddressesWithTrees`, and anyone can ask for any address. Compute: about 100,000 units for the validity proof plus about 100,000 for their system program per transaction, on top of ours.
- The four Light programs on mainnet are upgradeable, all by the same upgrade authority, `7PeqkcCXeqgsp5Mi15gjJh8qvSLk7n3dgNuyfPhJJgqY`, a plain key, not a multisig (read this session). Light Protocol was acquired by Helius in June 2026. A sealed registry whose storage lives inside programs one key can change is not sealed.

**Recommendation for v1: plain accounts.** The reason is the sealing rule: v1 must work with nothing but the Solana runtime under it, and the rent is 0.25 dollars now and about 0.03 dollars in a few months. What the later cross-profile proof needs is a set of codes with provable non-inclusion; codes are public, so anyone can build an indexed Merkle tree of them from the chain at any time, and the v1 proof's verifier (a later, separate program) can carry that root. Nothing in v1's storage has to change for that. If compressed accounts are picked later: a v2 registry writes codes as compressed accounts with addresses, the "never reused" check becomes Light's address non-inclusion at registration time (their prover in the loop for every registration), the per-badge cost drops to about 0.003 dollars, and the registry inherits Light's upgrade key and services. Reads of v1 codes stay where they are; nothing needs migrating because codes are public either way.

## 7. Proving on a phone

**Measured here** (Node 22.22, `snarkjs` 0.7.5, one process, 4 cores, this container; `scratch/js/prove.mjs`, logs kept as `prove-20.log` and `prove-32.log`), a group of 1,001 members, three runs each after one warm-up:

| Depth | Prove, warm | First proof (includes loading the wasm and zkey) | Verify | Process memory |
|---|---|---|---|---|
| 20 | 627 to 696 ms | 1,254 ms | 19 to 21 ms | 337 to 341 MB |
| 32 | 928 to 1,111 ms | 1,469 ms | 19 to 33 ms | 343 to 356 MB |

Memory is the whole Node process including both artifacts and the group; the proof itself needs a few hundred megabytes at most. Downloads once per device: 5.7 MB at depth 20, 7.7 MB at depth 32.

**Semaphore's own benchmarks** (docs.semaphore.pse.dev/benchmarks) are on an Apple M2 Pro laptop, in Node 23 and Chrome 139, at depth 20, published as images with no numeric table, so they could not be quoted; the page says v4 does not perform worse than v3 despite the extra identity constraints.

**Phone estimate** (an estimate, not a measurement): browser WASM on a mid-range phone runs snarkjs roughly 3 to 6 times slower than a desktop core, with multithreading through web workers. That puts a depth-20 proof at 2 to 5 seconds and depth 32 at 3 to 7 seconds. Two proofs per registration is 4 to 10 seconds at depth 20 on a mid-range phone; three proofs 6 to 15 seconds. A registration happens once per market per human, after a face check that itself takes longer, so this is acceptable with a progress indicator; it is not acceptable for anything done often. A real measurement on a mid-range Android and an older iPhone belongs to the session that builds the registry client; the `keys/test-page` pattern (a static page) is the cheapest way to get it.

## Verdict

**Go with these changes.**

1. The "badge-(k-1) exists" rule: as written it cannot be checked, because nothing links two of a human's numbered codes on the chain. Either registrations past the first carry a third proof (scope `badge-(k-1)`; measured cost above) or the rule is dropped. Carlos decides; both are feasible.
2. Transaction format: compressed proof points and a foundation-owned lookup table, so a registration fits under 1,232 bytes with two or three proofs. Revisit the 4,096-byte v1 format when Kora supports it.
3. Depth: seal depth 32 unless 0.3 seconds per proof on the device matters more than a cap of 1,048,576 humans. On-chain cost is the same.
4. Before sealing: confirm with PSE who ran the 4.13.0 phase-2 setup. If it was not a public ceremony, pin the 4.0.0 artifacts and `@semaphore-protocol/*` 4.12.x instead.
5. Storage: plain accounts, two per badge, the entry inside the market code account. Budget rent at 0.0024 SOL per badge now and expect it to fall about sevenfold by the end of 2026.
6. Scope and message: scope is the market name's UTF-8 right-padded to 32 bytes (cap names at 32 bytes or hash longer ones, to be decided); message is the DID's 32 bytes; the program recomputes both hashes itself and never trusts the client's values.
7. The keys recipe gains one per-human HKDF output, `forest.foundation/identity/v1`.

No fallback from the handoff is needed.

## Sealed versus dial

These cannot change after v1 deploys, because a change breaks every existing proof, code, or account:

- **The hash:** Poseidon over BN254 with circomlib's parameters (x^5, 8 full rounds, width 3 for two inputs), big-endian field elements, through the `sol_poseidon` syscall. Used for tree nodes; also the definition of a commitment and a nullifier through the circuit.
- **The tree rules:** LeanIMT as in section 3: append only, copy-up without a sibling, dynamic depth, `MAX_DEPTH` equal to the sealed circuit depth, the frontier layout, the root-history rule (how many recent roots stay valid), root 0 never valid.
- **The circuit and the verification key:** Semaphore 4.13.0 (or 4.0.0) at the chosen depth, baked in as a constant; public signals in the order root, nullifier, message, scope; the negation of A; the field-size check on public inputs; the depth bound.
- **Scope and message derivation:** `keccak256(bytes32) >> 8` with the exact padding rule for market names, the exact string for numbered codes (`badge-` followed by the decimal number, no padding), and the DID as message.
- **Code derivation:** a code is the circuit's nullifier, `Poseidon(2)([scope, secretScalar])`; the program's uniqueness rule is "the PDA for this nullifier must not exist".
- **Account layouts and seeds:** the PDA seed strings and layouts of the code accounts, the entry, and the registry state (frontier, size, roots, issuer key, treasury key, dials), because clients and indexes read them forever.
- **The identity derivation on the device:** BLAKE-512, pruning and shift as Semaphore does it, and our `forest.foundation/identity/v1` string; not in the program, but a change makes every existing commitment unreachable.
- **The rule set:** the fee amount (0.25), USDC as an always-accepted token, the issuer-insert instruction, the order of checks.

These are dials the treasury key can turn:

- the number of free badges (N) and the end date;
- the list of accepted dollar tokens beyond USDC;
- the issuer key (if the program lets the treasury rotate it; recommended);
- the root-history window length, if it is stored as a setting rather than a constant.

## Open questions for Carlos

1. **Gap check: third proof, or drop it?** Third proof: every registration after the first carries three proofs; 322,000 compute units of 1,400,000, one more compressed point set (128 bytes; fits with a lookup table), about 0.7 seconds more on the device, and one more account read. The later cross-profile proof then needs only "badge-(N+1) does not exist". Drop it: cheapest registration, but a human can leave gaps (badge-1, badge-2, badge-7), so "none hidden" cannot be proven by one non-inclusion; the later circuit must prove non-inclusion for every unused number up to a bound, or accept that hidden badges are possible.
2. **Depth 20 or 32?** 32: no cap ever, 0.3 seconds more per proof on the device, 2 MB more download once. 20: a permanent cap of 1,048,576 humans in v1, and v2 with a fresh list if it is reached.
3. **Which setup files?** 4.13.0: the current library as is, provenance of the phase 2 to confirm with PSE. 4.0.0: a public ceremony with over 400 participants, but the old circuit and the 4.12.x libraries pinned forever in our client.
4. **Who pays the rent?** About 0.0024 SOL per badge today (0.25 dollars), about 0.03 dollars after the cuts, locked forever. Kora's fee payer by default (its `max_allowed_lamports` must allow it), or the program takes it out of the 0.25 for paid numbers (free numbers still cost the foundation).
5. **Transaction format now or later?** v0 with compressed points and a lookup table: 14,406 more compute units per proof and a decompression step, both routine. The v1 format: 4,096 bytes and no tricks, but activated today and unverified in Kora.
6. **Market names over 32 bytes:** cap them in the markets directory, or hash every name before it becomes a scope. Hashing costs nothing on the chain and one rule in the client; capping costs a rule in the markets validator.
7. **Where the leaf list lives.** Devices need every commitment to build a path. The issuer publishes a file (simple, one more thing to host), or clients replay insert transactions from an RPC (no hosting, slow at a million leaves), or both.
8. **Root-history window.** Semaphore uses one hour. Longer is friendlier to slow devices; shorter means a removed or wrong leaf stops working sooner. There is no removal in v1, so longer costs nothing except a few more 32-byte slots.

## What this session did not do

It did not run anything on a phone, on devnet, or against Kora. It did not write the registry program. It did not confirm the 4.13.0 ceremony's contributors, or the constraint count of the circuit (Semaphore publishes it only as an image). The SPL Token transfer was measured under the p-token rewrite, which the mainnet feature gate shows as active; the older token program would cost about 4,000 more compute units, immaterial here.

## Sources

- Semaphore: `semaphore-protocol/semaphore` main branch (`packages/circuits/src/semaphore.circom`, `packages/proof/src/{generate-proof,verify-proof,hash,to-bigint}.ts`, `packages/identity/src/index.ts`, `packages/group/src/index.ts`, `packages/contracts/contracts/Semaphore.sol`); npm `@semaphore-protocol/*` 4.14.3, `@zk-kit/lean-imt` 2.2.5, `@zk-kit/eddsa-poseidon` 1.1.0, `@zk-kit/baby-jubjub` 1.0.3, `@zk-kit/binary-merkle-root.circom` 2.0.0, `@zk-kit/artifacts` 2.0.1, `poseidon-lite` 0.3.0, `snarkjs` 0.7.5; `https://snark-artifacts.pse.dev/semaphore/{4.0.0,4.13.0}/`; `privacy-scaling-explorations/snark-artifacts` (`OVERVIEW.md`, `packages/semaphore/package.json`); docs.semaphore.pse.dev (home, benchmarks).
- Solana: `groth16-solana` 0.2.0 (crates.io) and its main branch (`README.md`, `BENCHMARKS.md`, `src/groth16.rs`); `solana-poseidon` 2.2.1 and 5.0.0; `light-poseidon` 0.4.0 README; Agave `program-runtime/src/execution_budget.rs` (compute costs), `syscalls/src/lib.rs` (Poseidon formula); `solana-sdk` `packet/src/lib.rs` (1,232), `rent/src/lib.rs`; solana.com docs on transactions, lookup tables, larger transactions (SIMD-0296, SIMD-0385), reduced rent (SIMD-0437); mainnet RPC reads this session: `getVersion` (4.3.0-rc.0), `getEpochInfo` (epoch 1035), `getMinimumBalanceForRentExemption`, the Rent sysvar, feature accounts `txv1aq4pp...` and `ptokFjwy...`; LiteSVM 0.16.0; Solana CLI 4.2.2 with platform-tools v1.54.
- Light Protocol: zkcompression.com (considerations, transaction lifecycle, Merkle trees and validity proofs, compressed account model, addresses, security), `Lightprotocol/light-protocol` (`light-paper.md`, forester and prover READMEs, `program-libs/hasher/src/poseidon.rs`), `helius-labs/photon` README and source, mainnet program accounts read this session, helius.dev acquisition post.
- Kora: `solana-foundation/kora` main branch (`README.md`, `kora.toml`, `crates/lib/src/validator/transaction_validator.rs`, `crates/lib/src/config.rs`), version 2.2.0-beta.8.
- Price: CoinGecko simple price API, 102.31 dollars per SOL at fetch time.

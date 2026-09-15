# registry/scratch

Throwaway scripts and tests used to get the numbers in `../FEASIBILITY.md`. Scratch, not a library, not the registry program. Nothing here ships. Kept so every number in the report can be rerun.

- `js/`: Node scripts. `npm install`, then `npm run fetch` is not needed if `../artifacts` is present; otherwise download the Semaphore 4.13.0 artifacts for depths 20 and 32 from `https://snark-artifacts.pse.dev/semaphore/4.13.0/` into `artifacts/`. `node identity.mjs` (Q4), `node tree.mjs` (Q3, writes `vectors.json`), `node prove.mjs 20` and `node prove.mjs 32` (Q1, Q2, Q7, write `proofs-<depth>.json`), `node txsize.mjs` (Q5). `parse_vk_to_rust.cjs` is groth16-solana 0.2.0's own key converter, copied unchanged.
- `program/`: a scratch Solana program that verifies N proofs, hashes, creates PDAs and does a token transfer, only to measure compute units. Build with `cargo build-sbf` (Solana CLI 4.2.2, platform-tools v1.54).
- `rust/`: host tests. `cargo test -- --nocapture`: Poseidon and tree roots against the JS vectors, groth16-solana verification of the snarkjs proofs, and the compute-unit measurement under LiteSVM (needs `program/target/deploy/registry_cu_scratch.so`).
- `*.log`, `vectors.json`, `proofs-*.json`: outputs kept as evidence. The artifacts themselves (about 13 MB) are not committed.

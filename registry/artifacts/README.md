# The setup files the registry is sealed against

Devnet only: these files back the devnet registry; nothing is on mainnet.

Up: [registry](../README.md).

Semaphore's circuit and its published setup files, used unchanged. Forest wrote none of this.

- **Which ones.** The `4.0.0` files at depth 32, from the public Semaphore V4 ceremony (PSE's
  p0tion, over 400 participants, finished July 13, 2024). The newer `4.13.0` files in the library's
  default path come from a later setup whose second phase has no published transcript, so these are
  pinned instead. The library line that matches them is `@semaphore-protocol/*` 4.12.1, which
  `../client` and `keys/` both use.
- **What is committed.** `semaphore-32.json`, the verification key. The program has it baked in as
  `../program/src/verifying_key.rs`.
- **What is not.** `semaphore-32.zkey` and `semaphore-32.wasm`, used only to make a proof on a
  device. `manifest.json` pins them by URL and SHA-256, and `npm run fetch` refuses anything whose
  hash does not match.

```
npm ci
npm run fetch      # the proving key and the witness generator, hash-checked
npm run vk         # rewrite ../program/src/verifying_key.rs from semaphore-32.json
```

`parse_vk_to_rust.cjs` is `groth16-solana` 0.2.0's own converter, copied unchanged. `npm run vk` on
an unchanged `semaphore-32.json` must leave `verifying_key.rs` byte for byte the same; if it does
not, the program is no longer sealed against this ceremony.

| File | Bytes | SHA-256 |
|---|---|---|
| `semaphore-32.json` | 3,741 | `9b3ab0a193f448714db224bd22540bf4e98f0e6418aa347b0a8cdfbc246ad588` |
| `semaphore-32.zkey` | 5,841,577 | `0654f6692b026a0e98972db610a7084136ee6303a1960944e866205942d051c7` |
| `semaphore-32.wasm` | 1,850,862 | `f5c50ff3847c1b93e3439098719739e34136f505d1899b620d1641339d67ee7a` |

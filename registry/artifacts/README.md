# The setup files the registry is sealed against

Semaphore's circuit and its published setup files, used unchanged. Forest wrote none of this.

- **Which ones.** The `4.0.0` artifacts at depth 32, from the public Semaphore V4 Ceremony (PSE's
  p0tion, over 400 participants, finished July 13, 2024). Session 3 found that the newer `4.13.0`
  artifacts in the library's default path come from a later setup whose phase two has no published
  transcript, so the handoff pins these instead. The library line that matches these files is
  `@semaphore-protocol/*` **4.12.1**, which is what `../client` and `keys/` both use.
- **What is committed.** `semaphore-32.json`, the verification key, 3.7 kB. The program has it
  baked in forever as `../program/src/verifying_key.rs`, so it belongs in the repo where anyone can
  check it.
- **What is not.** `semaphore-32.zkey` (5.8 MB) and `semaphore-32.wasm` (1.8 MB). They are only
  ever used to *make* a proof, on a device, and they are pinned by URL and SHA-256 in
  `manifest.json`. `npm run fetch` downloads them and refuses anything whose hash does not match.

```
npm install
npm run fetch      # the proving key and the witness generator, hash-checked
npm run vk         # rewrite ../program/src/verifying_key.rs from semaphore-32.json
```

`parse_vk_to_rust.cjs` is `groth16-solana` 0.2.0's own converter, copied unchanged. Running
`npm run vk` on an unchanged `semaphore-32.json` must leave `verifying_key.rs` byte for byte the
same; if it does not, the program is no longer sealed against this ceremony.

| File | Bytes | SHA-256 |
|---|---|---|
| `semaphore-32.json` | 3,741 | `9b3ab0a193f448714db224bd22540bf4e98f0e6418aa347b0a8cdfbc246ad588` |
| `semaphore-32.zkey` | 5,841,577 | `0654f6692b026a0e98972db610a7084136ee6303a1960944e866205942d051c7` |
| `semaphore-32.wasm` | 1,850,862 | `f5c50ff3847c1b93e3439098719739e34136f505d1899b620d1641339d67ee7a` |

The zkey's hash is the one session 4 recorded from the same URL, so nothing at PSE has changed
under us since.

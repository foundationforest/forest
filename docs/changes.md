Log of what was built, learned, and left open, appended at the end of every session.

## 2026-09-14: repo memory and skeleton (PR #1)

- **Built:** `CLAUDE.md`, `docs/handoff.md`, `docs/changes.md`, and the eleven-folder skeleton (`shapes/`, `keys/`, `registry/`, `escrow/`, `issuer/`, `host/`, `carrier/`, `feepayer/`, `index/`, `names/`, `docs/`), one-line `README.md` each in the future tense. Root `README.md` says "fee payer" to match the handoff.
- **Learned:** the repo had one commit, a Node `.gitignore`, and Apache 2.0. None of the new folder names collide with an ignore pattern.
- **Open:** whether the first session entry should also go into `docs/changes.md` (CLAUDE.md says append at the end of every session; that task said one line). Nothing else decided. Answered by the next session: it does.

## 2026-09-15: session 1, record shapes, plus handoff corrections

- **Built:**
  - Three design changes applied to `CLAUDE.md` and `docs/handoff.md` as supplied: escrow is one shape (no modes; per hour, per day, per job is the app's arithmetic; a market file sets only silence days, arbiter allowed, accepted tokens); names are a random handle free per badged profile plus optional paid chosen names (no per-human handle market); ramp is Crossmint or Onramper.
  - `shapes/`: four AT Protocol lexicons (`foundation.forest.profile`, `.post`, `.review`, `.credential`), a validator as a library and a command line, one example record of each shape, an online-tutors market fixture, and 32 tests on Node's built-in runner. `@atproto/lexicon` and `@atproto/syntax` used unchanged; nothing else written.
- **Chosen, not decided** (the handoff was silent; the simplest option was taken; each can be reversed before anything ships):
  - Namespace: flat under the domain, `foundation.forest.<shape>`, no group segment.
  - Record keys: profile `literal:self` (one per folder); post, review, credential `tid`.
  - `createdAt` required on all four shapes.
  - Profile: `name` required; `photo` (blob, png or jpeg, at most 1 MB), `contact` (free text), `about` (free text, "what I do"), `wallet` (base58 text, 32 to 44 characters; lexicons cannot check base58, so length only) all optional.
  - Post: `direction` is a closed enum `offer|request`; `market` and `role` are plain strings up to 64 characters (a directory name, and a role from the market file); `remote` boolean required and `location` free text optional; `expires` optional datetime; `price` is a ref to a `#price` object: `amount` as decimal text in whole token units ("25", "12.50"), `token` as the symbol listed in the market file, `per` a closed enum `hour|day|job`.
  - Review: `subject` a DID, required; `rating` integer 1 to 5; `text` required; `escrow` optional, the escrow account's base58 address, made required by the market's review evidence rule. No pointer to the post.
  - Credential: `issuer` a DID; `credential` typed `unknown`, the W3C credential as issued, not re-described in lexicon terms.
  - Market file: JSON with exactly eight keys: `name`, `roles`, `fields`, `silenceDays`, `arbiterAllowed`, `reviewEvidence`, `credentialIssuers`, `tokens`. `fields` is keyed by `profile`, `post`, `review` (a credential is the issuer's, so no market extras), each `{ properties, required }` in lexicon field syntax, types limited to string, integer, boolean, or an array of those; no nesting, no refs, no redefining a base field, no `$` names. `reviewEvidence` is `escrow` (every review carries an escrow pointer) or `none`. `tokens` are `{ symbol, mint }` pairs. The fixture uses 7 silence days and the mainnet USDC mint.
  - Records are open, as AT Protocol records are: undeclared fields pass. The rule "fields only in allowed places, never a new shape" is enforced on the market file, not by rejecting unknown fields in records.
  - With a market file, the validator cross-checks four things: post market name, post role, post token, review escrow presence. `silenceDays` and `arbiterAllowed` are read by the app at escrow creation; no record refers to them, so nothing checks them.
  - One `package.json` per folder, no root workspace. Node's built-in test runner. Dependencies pinned.
- **Learned:**
  - In `@atproto/lexicon`, `Lexicons.add` does not validate the lexicon document; `parseLexiconDoc` does. Object validation ignores undeclared properties. Nested objects must go through `ref`; inline `object` is not allowed in properties. A blob in JSON must pass through `jsonToLex` before validation or it fails as "should be a blob ref". `format: language` exists for BCP 47 tags.
  - Node 22 `node --test <dir>` treats the directory as a file; it needs a file pattern.
- **Open:**
  - Stale text this session was told not to touch: the Layers table "Names" row still says "one per human (see Names)"; "Open" still lists "Per-mode timeouts as market defaults" though modes are gone; `names/README.md` and `escrow/README.md` still describe the old design.
  - Whether the market file should name the pricing unit (per hour) or the post alone carries `price.per`. The eight-key list has no place for it, so the post carries it.
  - Whether a record names the token by symbol (readable; the market file resolves the mint) or by mint (exact). Symbol chosen.
  - Whether a review should also point at the post it is about, not only the profile.
  - Whether session 2's validator in the `markets` repo reuses `validateMarket` from here, so the rule lives once.
  - Whether a review with no escrow behind it is storable at all in a market whose evidence rule is `escrow`, or only weighs nothing. The validator rejects it.

## 2026-09-15: session 2, keys recipe, plus session 1 fixes

- **Built:**
  - Session 1 fixes: the handoff's Names row and its "Open" list; `names/README.md` and `escrow/README.md` on the current design; the review evidence rule no longer rejects anything in `shapes/`; market tokens are `{ symbol, mint, chain }`; build order items 2 and 3 swapped; the Keys recipe row now says the seed file label is derived from the passkey's secret. A3 found nothing beyond the Names row: "Don't resurrect" lists "one handle per human" as a thing not to bring back, which is right, and the registry's "one numbered code per human" stays.
  - `keys/`: `SPEC.md` (the recipe in plain words plus exact steps), a TypeScript library for browsers and Node (`seedFromPrf`, `profileKeys`, `genesisOperation`, `didGenesis`, `submitGenesis`, `seedFileLabel`, `wrapSeed`, `unwrapSeed`, `exportWords`, `importWords`), `test/vectors.json` with pinned answers, 22 tests on Node's runner, a static test page with its README, and a one-paragraph `README.md`. Existing parts unchanged: Web Crypto (HKDF, AES-GCM, SHA-256), `@atproto/crypto` (secp256k1 keypairs, did:key, low-S signing), `@noble/curves` (ed25519), `@ipld/dag-cbor`, `@scure/bip39`, `@scure/base`. Written here: the did:plc genesis builder (about twenty lines), because the directory's own library does not run in a browser.
- **Decided** (each with its reason):
  - The review evidence rule weighs, never rejects. A market file's `reviewEvidence` is metadata for indexes, which weigh a review without that evidence near zero; the validator never fails a review for lacking it. Reason: the handoff's principle "nothing required, everything priced". This closes session 1's open question "whether a review with no escrow behind it is storable at all": it is, and it weighs nothing.
  - Accepted tokens in a market file are objects `{ symbol, mint, chain }`, not symbols. Posts and reviews keep naming the token by symbol; the market file is what pins the symbol to a mint. Reason: a symbol alone can be faked by a lookalike token. This closes session 1's "symbol or mint" question: symbol in records, mint in the market file. `chain` is the slug `solana`; CAIP-2 is not needed now, closed.
  - Build order: the `markets` repo session (was item 2) now comes after the keys session (was item 3).
  - The did:plc genesis operation is built and signed on the device, in a browser, because the design creates the DID on the device. `@did-plc/lib` is not shimmed; a small builder does DAG-CBOR, the control key's signature, and the hash, per the did:plc method, and the tests check it against `@did-plc/lib`'s `createOp`, `assureValidCreationOp` and `validateOperationLog`. The DIDs are pinned in the vectors.
  - The seed file's label is derived from that passkey's secret, not random, so a new device finds its own seed file from nothing but its passkey. The unlock rule in the spec: compute the PRF, compute the label, unwrap if a file exists under it, otherwise derive the seed directly. The first passkey needs no file.
- **Chosen, not decided** (the spec was silent; the simplest option was taken; each can be reversed before anything ships):
  - Fixed strings: the PRF input is the UTF-8 of `forest.foundation/prf/v1`; HKDF info strings are `forest.foundation/seed/v1`, `forest.foundation/profile/<n>/control/v1`, `.../signing/v1`, `.../wallet/v1`, `forest.foundation/seed-file/key/v1`, `.../label/v1`, with the profile index in decimal. A `v1` suffix on every string; a change is a new version, never an edit.
  - HKDF-SHA256 with an empty salt everywhere, all separation in the info string; every key is one HKDF output straight from the seed (no intermediate per-profile secret).
  - secp256k1 for both the control and the signing key (the AT Protocol default; P-256 is the other option did:plc accepts). ed25519 for the wallet is forced by Solana.
  - An HKDF output that is not a valid secp256k1 scalar makes the library throw; no retry rule (chance below 2^-127, untestable).
  - Seed file: AES-256-GCM with a fresh random 12-byte nonce, the label as additional data, label = 32 HKDF bytes in base64url without padding, ciphertext = nonce then GCM output in base64url without padding, exactly two fields. `unwrapSeed` refuses a file whose label is not the passkey's, with a clear message, before trying to decrypt.
  - Paper: 24 English BIP39 words with the seed as entropy; BIP39's PBKDF2 step is not used. Import forgives case and spacing.
  - Genesis parameters: a bare handle gets `at://`, a bare host gets `https://`, copied from `@did-plc/lib` so the same inputs give the same DID either way. Submit is a `fetch` POST to `https://plc.directory/<did>` by default.
  - The wallet is returned as `{ privateKey (32-byte ed25519 seed), publicKey, address }`; the did:plc keys as non-exportable `@atproto/crypto` keypairs.
  - "The AT Protocol identity package" was read as `@did-plc/lib`, the directory's library, used as a dev dependency for verification only. `@atproto/identity` resolves names and DIDs; nothing here resolves, so it is not used.
  - Tooling: one `package.json` in `keys/`, pinned versions, Node's test runner over the `.ts` files directly, `tsc` for a `dist/` build (ignored), esbuild for the test page bundle at `test-page/dist/forest-keys.js` (ignored; built with `npm run build:page`).
  - Test vectors were generated once by this implementation and pinned (regression vectors), with two independent checks inside the tests: HKDF against `@noble/hashes`, and the whole genesis operation against `@did-plc/lib`.
  - Test page defaults: handle `handle.example`, host `https://host.example`; `localStorage` keeps only the credential id and the last seed fingerprint.
- **Learned:**
  - Node 22.18 and later strip TypeScript types by default, so `node --test test/*.test.ts` runs with no build; imports must name `.ts` files and `tsc` rewrites them for `dist/`.
  - `@did-plc/lib`'s npm build (0.0.4, 2023) is a Node bundle: it creates a pino logger at load and pulls in axios's Node adapter, so it cannot run in a browser without shimming a dozen Node modules. Three rounds of shims did not get it to load.
  - DAG-CBOR sorts map keys and secp256k1 signatures are deterministic (RFC 6979), so an independent builder produces the same signed operation and the same DID as the library, byte for byte. The test relies on this.
  - TypeScript 5.9's Web Crypto types want `Uint8Array<ArrayBuffer>`, not a view over any buffer; the library copies inputs into plain buffers before handing them to Web Crypto.
  - The test page could be exercised here after all: headless Chromium with a virtual authenticator that supports PRF (CDP `WebAuthn.addVirtualAuthenticator` with `hasPrf`) created a passkey, unlocked, reproduced the same fingerprint and rows after a reload, changed the DID with the handle and kept the keys, and showed 24 words. The bundle reproduces every pinned vector in Chromium. Real authenticators (Apple, Android, Windows) are still untested, which is the handoff's own item.
  - `@scure/bip39` 2.x pins `@noble/hashes` 2.x while `@atproto/crypto` wants 1.x, so `node_modules` holds two copies of the noble packages. Harmless.
  - PRF results at passkey creation are not reliable across browsers and authenticators; the page evaluates PRF on `get` only.
- **Open:**
  - Whether a product also writes a seed file under the first passkey, so every passkey follows one path. Harmless either way; the spec does not require it.
  - The handoff's "tests on Apple, Android, Windows" for the keys session: not done here; the test page is ready for them.
  - Session 1's other open items stand: the pricing unit in the market file, a review pointing at its post, and whether the `markets` repo's validator reuses `validateMarket`.

## 2026-09-15: session 3, registry feasibility check (report only)

- **Build order:** item 4 (the `registry/` feasibility check) was taken before item 3 (the `markets` repo), on purpose: the registry is the one piece nobody has built on Solana, and its answer can change the plan. The handoff's build-order note records the reorder. The `markets` repo session is next.
- **Built:** `registry/FEASIBILITY.md`, a report answering the seven questions with commands, numbers and sourced versions, plain language first. `registry/scratch/` holds what produced the numbers and is marked scratch in its own README: Node scripts (`identity.mjs`, `tree.mjs`, `prove.mjs`, `txsize.mjs`, plus groth16-solana's own `parse_vk_to_rust.cjs` copied unchanged), a throwaway Solana program used only to measure compute units, and host tests (Poseidon and tree roots against the JS vectors, Groth16 verification of real snarkjs proofs, and the compute-unit run under LiteSVM). No registry program was written. The 13 MB of Semaphore artifacts are not committed.
- **Verdict: go, with changes.** Every piece works: Semaphore's circuit and its published setup files unchanged, a real proof verifying with groth16-solana, Solana's Poseidon reproducing Semaphore's tree exactly, an identity from 32 bytes the keys recipe can derive, and a two-proof registration at 224,890 compute units of 1,400,000. No fallback needed.
- **Learned:**
  - The handoff's "the program checks that badge-(k-1) exists" cannot be done with two proofs. A numbered code is `Poseidon(scope, secret)`; nothing on the chain links one human's badge-k to their badge-(k-1). Either registrations past the first carry a third proof (measured: 321,981 compute units, still fits) or the rule is dropped and the later cross-profile proof handles gaps. Carlos decides.
  - Bytes are the binding limit, not compute. A paid two-proof registration is 1,296 bytes against the 1,232-byte limit. A lookup table brings it to 1,175, compressed proof points to 1,040, both to 919, and both make three proofs fit at 1,112. Solana's 4,096-byte v1 transaction format activated on mainnet today (epoch 1035) but removes lookup tables and compute-budget instructions, and Kora only logs a warning for it.
  - The setup files in use (`4.13.0`, August 2025) are not the ones the public July 2024 ceremony produced. The circuit changed when `@zk-kit/binary-merkle-root.circom` 2.0.0 replaced the array of path indices with one packed index; comparing the depth-20 keys, phase 1 is identical and `vk_delta_2` and `IC` differ, so a new phase 2 was run. Who ran it is not documented. A sealed program bakes one key in forever, so this needs PSE's answer before v1; the fallback is the `4.0.0` artifacts with the 4.12.x libraries pinned.
  - A snarkjs proof needs exactly one change to verify with groth16-solana: negate `pi_a`. Everything else is byte layout (big-endian, G2 imaginary part first). The un-negated proof, a changed public input, and a proof for another scope all fail, as they should.
  - Solana's Poseidon syscall and Semaphore's `poseidon-lite` agree on every vector tried. LeanIMT's rules (append only, a node with no right sibling copied up unhashed, dynamic depth, proofs that skip sibling-less levels) reproduce byte for byte in Rust, and an append using a one-node-per-level frontier gives the same root as a full rebuild for sizes 1 to 37. That frontier is what the on-chain tree should store.
  - The identity commitment is `Poseidon(2)` of the two coordinates of a Baby Jubjub public key, itself `secretScalar * B8` where the scalar is BLAKE-512 of the private bytes, first 32, pruned, read little-endian, shifted right 3, mod `l`. Reproduced by hand. `keys/` needs one more HKDF output, info `forest.foundation/identity/v1`, per human not per profile. Not added this session.
  - Rent fell twice this month (SIMD-0437, 6,960 to 6,333 to 5,080 lamports per byte; three more steps planned for about November). Two accounts per badge cost 0.0024 SOL today, about 0.25 dollars, and about 0.03 dollars once the cuts finish. Light Protocol's compressed accounts would be about 0.003 dollars per badge, but cost a dependency on an indexer, a prover and a forester, and its four mainnet programs share one plain-key upgrade authority. Plain accounts recommended for v1; nothing about that choice blocks the later non-inclusion proof, because codes are public and anyone can build an indexed tree of them.
  - Proof time here, in Node: 0.63 to 0.70 s at depth 20 and 0.93 to 1.11 s at depth 32, so the depth costs almost nothing on chain and about 0.3 s on a device. Semaphore publishes its own benchmarks only as images, so no numbers could be quoted from them.
  - `find_program_address` costs 1,500 compute units per bump it tries, so a sealed program should store each bump and use `create_program_address`. The scratch test pins the program id for this reason.
  - Toolchain note for later sessions: GitHub's web UI, API and `codeload` return 403 here, but `raw.githubusercontent.com`, `git clone` over HTTPS, npm, `static.crates.io`, `release.anza.xyz` and GitHub release assets all work. Nothing needed for this session was blocked.
- **Open** (all in the report with what each costs either way):
  - The gap check: third proof, or drop it.
  - Depth 20 or 32, sealed forever.
  - Which setup files, pending PSE's answer on the 4.13.0 phase 2.
  - Who pays the rent: Kora's fee payer, or the program out of the 0.25.
  - Transaction format: v0 with compressed points and a lookup table now, or the new 4,096-byte format once Kora supports it.
  - Market names over 32 bytes: cap them in the markets directory, or hash every name before it becomes a scope. This one lands on the next session, since it is the `markets` repo's rule.
  - Where the list of commitments lives, so a device can build its path.
  - How long a recent root stays valid.
  - Not measured here: a proof on a real phone, anything on devnet, anything against Kora.
  - Session 1 and 2 items still stand: the pricing unit in the market file, a review pointing at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, and the keys tests on Apple, Android and Windows.

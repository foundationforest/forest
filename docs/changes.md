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

## 2026-09-15: session 4, Soil, registry decisions, identity secret, storage report

- **Built:**
  - **Part A, decisions into the memory files.** The first app is Soil, not Cabin, in `docs/handoff.md` (the only file that named it: eight places, including the heading "What Soil needs from the foundation" and the product column of the "Foundation versus product" table). Its domain is `soil.host`, not bought yet. Reason for the log: the soil is where the seed grows its roots; one syllable; Cabin was crowded and its domain cost three times as much. `CLAUDE.md`, `README.md` and the folder READMEs did not name it, so they were not touched. The "Registry (the detail that matters)" section was replaced with the supplied text. The handoff's "Open" list lost the free-numbers item and gained three (the Semaphore transcript, scopes per market or per market and role, when a second list opens); "Don't resurrect" gained six. The Layers table: the Host row runs on Soil (Railway, plain SQLite files), the Registry row's "What" now names the set of list fingerprints and the rent sweep. `CLAUDE.md`'s registration rule is now one proof, one rule, 25 cents, always.
  - **Part B, the per-human identity secret in `keys/`.** One more HKDF output from the seed, info `forest.foundation/identity/v1`, 32 bytes, no profile index. `src/identity.ts` adds `identitySecret(seed)` and `humanIdentity(seed)`, which returns Semaphore's identity object and its commitment; `@semaphore-protocol/identity` is used unchanged. `SPEC.md` gains a section 4 (sections 4 to 9 became 5 to 10), a plain-words item, a fixed-strings row, and a line in "what this does not do": losing the seed loses the identity, and the person cannot be put on the list again without another face check. `test/vectors.json` pins the secret, the secret scalar, the public key and the commitment; five tests were added, 27 pass, nothing existing changed and every existing vector still passes unchanged. `npm run check` and both builds pass; the browser bundle reproduces the commitment and is now 453.7 kB.
  - **Part C, `docs/decisions/used-code-storage.md`.** The three storage shapes compared with numbers produced this session, the two extra questions answered, and a recommendation: option 3, an account per code plus an append-only tree of codes. `docs/README.md` now mentions `decisions/`.
- **Edited beyond the literal instructions, because the supplied decisions made them false.** Each is small and each is listed so it can be reversed:
  - Layers, Fee payer row: was "sponsors any registration that carries a valid proof". The new Registry section says the sponsor must only pay for markets in the directory, or a bad actor drains it, so the row now says that.
  - Reputation, private disclosure: was "shows that badge-(N+1) doesn't exist". Numbered codes are gone, so it now says the seller shows, for every other market in the directory, either the badge or that no code of theirs exists there, which is what the new Registry section describes.
  - Layers, Keys recipe row: now also names the identity secret, because after Part B the keys layer produces one.
  - The supplied Registry bullets were given the document's existing style (a `-` bullet with a bold lead-in label). No word was changed.
- **Chosen, not decided** (the simplest option was taken; each can be reversed before anything ships):
  - `@semaphore-protocol/identity` pinned at **4.12.1**, the line that matches the 4.0.0 ceremony artifacts the handoff now pins, rather than the current 4.14.3. Measured first: 4.12.1 and 4.14.3 produce byte-identical secret scalars, public keys and commitments from the same 32 bytes, so the pin costs nothing and keeps one version line across the repo.
  - Names: `identitySecret(seed)` for the raw bytes (session 3's report proposed that name) and `humanIdentity(seed)` for the identity and its commitment together.
  - The vectors pin the secret scalar and public key as well as the commitment, so a change anywhere in Semaphore's derivation shows up as a failing test rather than a changed commitment with no explanation.
  - `@zk-kit/baby-jubjub` and `poseidon-lite` added as dev dependencies only, so the by-hand recomputation in the tests does not go through the Semaphore wrapper.
- **Learned:**
  - **The finding that decides the storage question: Solana no longer commits its accounts in a Merkle tree.** `accounts_lt_hash` (SIMD-0215) is activated on mainnet at slot 347,328,000 and `remove_accounts_delta_hash` at slot 348,624,000. A lattice hash is a sum with no paths, so nothing can be proven in it or out of it, and a program cannot enumerate the accounts it owns either. So a circuit can never prove a code is absent from a set of accounts, and with accounts alone the "none hidden" promise would rest on trusting whoever publishes the code list.
  - An indexed Merkle tree is the right structure and does not fit. Its non-membership proof is 32 bytes per level plus the low leaf, and a registration has 192 bytes of headroom. The deepest code tree whose proof still fits alongside a registration is depth 4, which holds 16 codes.
  - Rent per code is 2.6 times cheaper when the tree lives inside accounts the program owns rather than one account per code, because the 128-byte per-account overhead disappears. About $53,000 against about $138,500 at a million codes today. Written up as a fourth shape, not recommended, because it is the most logic in the one program that can never be fixed.
  - Verified in the runtime source, for the sweep: `set_lamports` returns `ExternalAccountLamportSpend` only when the program does **not** own the account, so a program may debit its own accounts with no signature; an instruction whose lamports do not balance fails with `UnbalancedInstruction`; and `minimum_balance` is `(128 + bytes) * lamports_per_byte` at an exemption threshold of 1.0. The excess a sweep would recover is about $0.1195 per badge, about $120,000 at a million badges, and without the instruction it is locked forever.
  - Measured from the 4.0.0 proving keys the handoff now pins: 6,454 witness variables at depth 20 and 9,418 at depth 32, so **247 wires per extra Merkle level**. One market in the later completeness proof costs about 8,900 constraints, roughly one whole Semaphore proof. The wall is not seconds, it is the proving key: about 111 MB at 20 markets and about 277 MB at 50, which no phone downloads. Directory size, not proof speed, is what bounds that design. Hashes recorded in the report.
  - **The handoff's new "Transaction shape" figures are session 3's two-proof numbers.** With one proof a registration is smaller than 1,040 bytes and nearer 9 percent than 16 percent of the compute limit. The text was written exactly as supplied; the conclusion holds with more room than it claims, not less. Say whether to correct the figures.
  - Of the nine items the instruction said to remove from the handoff's "Open", only one was there (whether the 25 cents funds anything given free numbers). The other eight live in `registry/FEASIBILITY.md`'s own "Open questions for Carlos" and in this log. The new Registry section answers six of them (depth, setup files, transaction format, who pays the rent, where the list lives, root history) and drops the gap check with numbered codes. `FEASIBILITY.md` was left exactly as written, because it is a dated report of what session 3 found, not a live plan.
  - Toolchain: `raw.githubusercontent.com`, `static.crates.io`, `crates.io`'s API, npm, `snark-artifacts.pse.dev`, the mainnet RPC and CoinGecko all work here. GitHub's API was not needed.
- **Open:**
  - The permutation proof option 3 leans on (proving a sorted tree holds the same values as the program's append-only tree) has not been built or costed. It is the largest unknown behind the recommendation, it lives entirely outside the sealed program, and it should be looked at before v1 deploys.
  - Whether the code tree's depth is sealed at 32, like the list of humans.
  - Whether the handoff's registration byte and compute figures get corrected to the one-proof numbers.
  - Whether `host/README.md` should now name Soil, since the Layers table does.
  - Not done here: any registry program, anything on devnet, anything against Kora, any measurement of an indexed-tree insert or a second append under LiteSVM, and any proof on a phone.
  - Still standing from earlier sessions: the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, and session 3's "not measured here" list.

## 2026-09-15: session 5, registry program v1, built and tested locally

- **Build order:** item 6 (`registry/` v1) taken, minus devnet. The program is built and tested on a local validator and under LiteSVM. Nothing was deployed anywhere.
- **Built:**
  - **Part A, three corrections to `docs/handoff.md`.** The "Transaction shape" bullet's figures were session 3's two-proof numbers; they are now this session's measurements on the built program, 831 bytes of the 1,232 limit and 9.5% of the compute limit. The "Later, same data" bullet was replaced with the supplied text, given the document's existing style (a `-` bullet with a bold lead-in label, backticks on the path) and not a word changed otherwise. The new "Open" item was added next to the other ceremony question.
  - **`registry/program/`,** the sealed program. Anchor 1.2, built with `cargo build-sbf` (Solana CLI 4.2.2). Four account kinds: one config (treasury address, treasury key, up to sixteen accepted mints with USDC first, the decimals every mint must carry, how many lists are open), one identity list per list (current root, a ring of the last 128, a 33-node frontier, leaf count, up to eight issuer keys), one arrival-order code tree (root, frontier, count), and one nine-byte account per used code. Eight instructions: `init`, `open_list`, `add_issuer`, `remove_issuer`, `insert_identity`, `register`, `add_token`, `sweep_rent`. No upgrade, no pause, no admin override of a registration, and nothing that removes a mint or takes a code back.
  - **`registry/program/tests-litesvm/`,** seventeen tests under LiteSVM against five real Semaphore proofs made with the pinned July 2024 artifacts: the happy path (two humans, two markets each, four codes, four quarters in the treasury, the code tree matching a full rebuild), a second list opened and its proof accepted, and rejections for a proof presented against another market, a root that fell out of the ring, a code used twice, a proof for one list against another, an unaccepted mint, a wallet one base unit short, an unauthorised issuer and a removed one, a stranger trying to change settings, `add_token` with the wrong decimals or the wrong owner, `init` with a mint `add_token` would refuse, the treasury trying to pay itself, and four ways of pointing a sweep somewhere it should not go. The sweep test creates a code account at the old rate, lowers the rate, sweeps, and asserts the account keeps exactly the new minimum, then does it again at the final rate from a stranger's key. The test crate imports nothing from the program: it writes the instruction bytes, the account layouts and the discriminators out by hand, the way an outside client has to, so a drift on either side fails a test.
  - **`registry/client/`,** TypeScript for a browser or Node: derive the code from the identity secret and the market name, build the Merkle path, generate the proof with snarkjs, compress the points, and assemble the transaction for a fee payer to co-sign. It makes no network calls of its own; the caller passes in the leaves and the blockhash. Ten tests with no chain, and one against a validator it starts itself, which runs the whole path from `keys/`'s identity secret to a badge on the chain and then fails to buy the same badge twice.
  - **`registry/artifacts/`,** the pinned ceremony files: the depth-32 verification key committed (3.7 kB), the 7.7 MB of proving artifacts pinned by URL and SHA-256 with a hash-checking fetch script, and `groth16-solana`'s own key converter copied unchanged.
  - **`registry/README.md`,** rewritten: what is here, how to run it, what one registration costs, what is sealed against what is a dial, and the two commands that remove the upgrade authority at mainnet deploy.
- **Chosen, not decided** (the handoff was silent; the simplest option was taken; each is reversible until something ships, and each is in `registry/README.md` with its reason):
  - The DID is hashed with a namespace the way the market name is, `keccak256("forest.foundation/profile/v1/" ‖ did) >> 8`, rather than padded into 32 bytes. One extra keccak, and a sealed program with no length cap on either input. The scope namespace is `forest.foundation/market/v1/`.
  - "A dollar stablecoin" is enforced as far as a program can enforce it: a classic SPL Token mint, initialized, with exactly the decimals the config fixes (six, written at `init`). No program can know what a mint is worth; the rest is the treasury key's judgement. With the decimals fixed, the 25-cent rule is one constant and never a conversion.
  - The transaction's fee payer pays the code account's rent, not the 0.25. That is the Kora path and it keeps the fee one number forever.
  - `sweep_rent` also covers the config and the code tree, not only code accounts and lists.
  - The code tree's depth is 32, like the list of humans. This answers session 4's open question.
  - Market names and DIDs are bounded at 64 bytes in the instruction. Not a limit on a scope, since both are hashed; only on what one transaction and one log entry carry.
  - Sixteen accepted mints and eight issuer keys per list, fixed, so no account ever changes size and the sweep always measures against a size that cannot move.
  - Zero-copy for the identity list and the code tree, plain Anchor accounts for the config and the code accounts.
  - Anchor 1.2 built with `cargo build-sbf` rather than the Anchor CLI, and no IDL: the client and the Rust tests both write the bytes by hand, which is the check that matters for a format that can never change.
  - The program id for local work is `FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B`. No keypair for it is committed and none is needed: LiteSVM loads a program at any address and the test validator takes `--bpf-program`. Mainnet gets a fresh one.
- **Beyond the literal instructions, because leaving them would have been wrong.** Two checks were added after the first run passed, each small and each reversible:
  - `register` refuses a fee whose two token accounts are the same. Anchor's own duplicate-mutable-account check catches it first, so the program's check never fires; it is written anyway because the deployed bytes are frozen and the rule has to be findable in the program's own text, not only in what a macro generated. The only key that could have arranged it was the treasury's, and "one rule, 25 cents, always" has no exception for anyone.
  - `init` holds the first mint to the same rule `add_token` holds every later one to, so there is no mint in the config that `add_token` would have refused. This added one account to `init` and removed one argument.
- **Learned:**
  - **A registration is 829 bytes and 132,302 compute units.** That is 67% of the 1,232-byte limit and 9.5% of the 1,400,000 compute limit, measured under LiteSVM on a legacy transaction with a compute-budget instruction; the client's v0 form is 831 bytes and 132,296 units on a local validator. Session 4 guessed "nearer 9 percent than 16" from session 3's parts, and that was right. No address lookup table is needed and none is used.
  - `@semaphore-protocol/*` 4.12.1 proves against the 4.0.0 depth-32 artifacts unchanged, in about 0.8 to 1.2 seconds in Node. The zkey's SHA-256 is the one session 4 recorded, so nothing at PSE has moved under us.
  - Semaphore's own `generateProof` hashes the scope and the message for you, as `keccak256(bytes32(value)) >> 8`, which caps a scope at 32 bytes. The client therefore calls `snarkjs.groth16.fullProve` directly and hands the circuit the two field values the program derives for itself. Nothing about the circuit or the artifacts changes.
  - The frontier needs **33** nodes, not 32: the last leaf of a full depth-32 tree walks all the way up and comes to rest at level 32.
  - The ring's edge is exact and worth pinning: list 0 with five leaves puts a proof's root at slot 4, it still lands after 127 more inserts, and the 128th overwrites it. Both are tested.
  - `solana-rent` changed shape at 4.x: the field is `lamports_per_byte` and the exemption threshold is 1.0, so the minimum is `(128 + bytes) * rate` with no doubling. The bytes on the wire are the same as the old struct's, so a program reading the old shape gets the same answer. LiteSVM's `set_sysvar` lowers the rate mid-test, which is how the sweep is tested without waiting for mainnet.
  - Compressed BN254 points, exactly: arkworks sets the top bit of the most significant byte when `y > -y` (`YIsNegative`, 0x80), and Fq2 compares on the imaginary part first. So a compressed G1 is x big-endian with that bit in byte 0, and a compressed G2 is `x.c1` then `x.c0`, big-endian, with the bit in byte 0. The client writes them; the program decompresses them with the syscall; a test asserts the round trip against snarkjs's own points, so a wrong flag fails loudly instead of silently failing verification.
  - Anchor 1.2 (solana-* 3.x) and `groth16-solana` 0.2.0 (solana-bn254 2.x) coexist in one program under Solana CLI 4.2.2 with no trouble. `solana-poseidon` needs the `agave-unstable-api` feature from 4.0.0 onward: the syscall is stable, the Rust wrapper around it is what carries the warning.
  - `@solana/web3.js`'s `confirmTransaction` opens a websocket subscription that keeps Node alive after a test has passed. The validator test polls `getSignatureStatuses` instead, and exits.
  - A3 found nothing to replace: the handoff's "Open" had no line about the completeness proof's key size or the sorted-tree check. Those live in `registry/FEASIBILITY.md` section 7 and in session 4's entry above, both dated records rather than the live plan, so neither was touched and the new item was added instead.
- **Open:**
  - The supplied "Open" line, "The per-market completeness circuit and its ceremony (v1, needs a public)", reads as if a word is missing after "a public". It was written in verbatim. Say whether it should read "needs a public ceremony".
  - Whoever calls `init` first becomes the treasury key forever. The mitigation is operational: deploy and initialise in the same breath, from the same machine. Worth saying whether that is enough or whether the treasury key should be baked in as a constant.
  - Not done here: devnet, Kora, a proof on a phone, any confirmation from PSE about the ceremony, an address lookup table, and any paid review. `docs/handoff.md`'s "Before mainnet" list stands in full.
  - The permutation proof the code tree exists for is still not built or costed. It is the largest unknown behind option 3 and it lives entirely outside the sealed program.
  - Still standing from earlier sessions: the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, and session 3's "not measured here" list.

## 2026-09-17: session 6, registry treasury and decimals fixes, host evaluation

- **Build order:** two fixes to item 6 (`registry/`) decided by Carlos, one wording fix, and item 5 (`host/` evaluation, report only). Nothing deployed anywhere; no host code.
- **Decided by Carlos, and done:**
  - **A1, the treasury is a program constant.** Because a deploy race must not be able to take the treasury: session 5 made whoever signed `init` first the treasury key forever, with "deploy and initialise in the same breath" as the only defence. Now `TREASURY` is a constant in `program/src/lib.rs`, a clearly marked placeholder to be replaced with the charter's treasury address before the first deploy; `init` takes no argument and no treasury signer and writes only constants, so anyone may send it and it does not matter who; a second `init` fails. One new instruction, `set_treasury`, signed by the current treasury, hands everything over to a new key so the treasury can move to a multisig later. Tests: a stranger's `init` writes the constants and gives the stranger nothing; a second `init` fails; `set_treasury` by a non-treasury key fails; after a handover the old key can turn no dial, is refused as the fee's destination, and is refused as the sweep's destination, while the new key can do all three and hand over again.
  - **A2, decimals are read from the mint, not sealed.** Because a sealed decimals constant could lock out a future dollar token: session 5 fixed six decimals into the config at `init` and `add_token` refused anything else. Now `add_token` (and `init`) read the mint's decimals and store them next to the mint, and `register` charges `25 × 10^(decimals − 2)` base units of that mint: 250,000 of a six-decimal token, 25,000,000 of an eight-decimal one, both 0.25. A mint with fewer than two decimals (0.25 is not a whole number of its units) or more than nineteen (the fee overflows a u64) is refused. Every other mint check is as it was. Tests: a six-decimal and an eight-decimal mint both accepted and both charged exactly 25 cents in their own units; one base unit short in the eight-decimal token pays nothing; decimals of 0, 1, 20 and 255 refused. README and the handoff's "Accepted tokens" bullet now say the rule is 25 cents in the mint's own decimals.
  - **A3, the truncated wording.** The handoff's "Open" line now reads "The per-market completeness circuit and its ceremony (v1; the ceremony needs real independent contributors, so it waits for a public)."
- **Built:**
  - `registry/program/`: `TREASURY` and `USDC_MINT` constants, `registration_fee(decimals)`, `set_treasury`, `Config` with a `decimals` array beside `mints` and a single `treasury` field (566 bytes, was 583), a `devnet` cargo feature, three new errors. Builds with Solana CLI 4.2.2, the same as session 5.
  - `registry/program/tests-litesvm/`: the wire format written out by hand a second time, updated to match; twenty tests pass (seventeen before), including the three above. A registration is still 829 bytes and now 133,072 compute units, 770 more than session 5 for the per-mint fee lookup.
  - `registry/client/`: the same constants and `registrationFee`, `initIx` with no treasury, `setTreasuryIx`, the new config layout; twelve chain-free tests pass (ten before), including one that fails if the treasury or USDC constants in `lib.rs`, the test crate and the client ever disagree. The validator test plants a USDC-shaped mint at the constant address with `solana-test-validator --account`.
  - `registry/README.md`: the sealed rules, the dials, and the deploy section rewritten for the constants and `set_treasury`; the config rent row and the compute figure updated.
  - `docs/decisions/host.md`: the host evaluation, report only.
- **Chosen, not decided** (beyond the literal instructions, because leaving them would have left the race open; each reversible until deploy, each in `registry/README.md` with its reason):
  - **The USDC mint is a constant too.** With `init` open to anyone, a mint argument would have let a stranger seat a junk six-decimal mint at `mints[0]` forever, which is the same race one field over. Mainnet's USDC by default, devnet's under `--features devnet`. The cost is one build per network.
  - **One treasury field, not two.** Session 5 kept the fee destination and the dial-signing key apart. A handover to a multisig has to move both or it moves nothing, and a multisig's vault address is one key that both owns token accounts and signs, so they were merged into one `treasury`. If a cold destination separate from the dial key is wanted, that is a one-field change before deploy.
  - **`register` does not re-read the mint.** The task allowed either. A classic SPL Token mint has no instruction that changes its decimals and none that closes it, so the byte recorded at `add_token` is the byte the mint holds forever; re-reading would add one account and 32 bytes to every registration to guard a change the token program cannot make. A test rewrites the mint's decimals under LiteSVM, which no transaction can do, and shows the fee is still the recorded 0.25. Flip it if a paid review disagrees: the mint account joins `register` and one `require!` compares.
  - **The placeholder treasury is derived from a public seed** (`REPLACE-BEFORE-DEPLOY-treasury-0`) so the Rust tests and the client tests can sign for it without a secret file. Anyone with the repo can sign for it, which is the point of replacing it; the README says so next to the deploy commands.
  - **`set_treasury` refuses the zero key and the current key**, nothing else. It cannot check that the new key can sign; a typo is unrecoverable, and the README says so.
- **Learned:**
  - Anchor 1.2's prelude exports `pubkey!`, so a constant address is one line and the `address = USDC_MINT` account constraint enforces it before anything is read from the account. `Keypair::new_from_array(seed)` on the Rust side and `Keypair.fromSeed(seed)` on the JS side give the same key from the same 32 bytes, which is what makes a placeholder both fixed and signable.
  - The per-mint fee costs 770 compute units and no bytes on the wire: 133,072 under LiteSVM, 133,066 on a local validator, 829 and 831 bytes as before.
  - `solana-test-validator --account <address> <file>` plants any account at genesis, which is how a test gets a mint at USDC's real address. The file must not sit inside the `--ledger` directory, because `--reset` empties that directory before the account files are read; the first run of the test skipped for exactly that reason.
  - Three research agents for the host evaluation were cut off by a session rate limit before reporting anything; the report was written from direct reading instead. Every claim in it cites a file and line.
  - **Vow already does Forest's two-phase write**: the server builds an unsigned commit, sends the bytes to the browser over a WebSocket, the browser signs with a key derived from the passkey's PRF output, the server verifies and stores. The result is a normal commit a relay verifies against the DID document. It is also untested (zero test files), needs an IPFS node for every block and blob, still signs genesis and imported commits with a server key, ignores `swapCommit`, pins a personal fork of `indigo`, and logs every request's address.
  - **The reference PDS signs in one function** (`packages/repo/src/util.ts` `signCommit`) called from one place in the actor store, reads a per-user private key file from disk, and its relay-facing code never touches the key. The split for a two-phase write is confined to `repo.ts`, the repo transactor, two new handlers and account creation. `importRepo` stores an outside commit but does not verify its signature.
  - rsky-pds moved to SQLite on 2026-07-14 and once shared one signing key across every repo, with a migration binary to per-actor keys. millipds's write is one function whose author already wrote "we could perhaps work in two phases" in a comment. tranquil-pds is Postgres and AGPL.
- **Open:**
  - The devnet build carries the same placeholder treasury; a real devnet key is needed before item 6 goes to devnet.
  - The validator test passed here (831 bytes, 133,066 compute units, the second badge refused) but the Node process did not exit on its own afterwards and was killed by hand. Session 5 said it exits; something keeps the event loop alive after a pass, and it was not chased.
  - Not done here: devnet; Kora; a proof on a phone; PSE confirmation; any paid review. `docs/handoff.md`'s "Before mainnet" list stands in full.
  - Still standing from earlier sessions: the permutation proof the code tree exists for, the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, and session 3's "not measured here" list.

## 2026-09-21: session 7, two-step treasury handover, host fork

- **Build order:** one fix to item 6 (`registry/`) decided by Carlos, three decisions closed, and the host built: the fork `docs/decisions/host.md` recommended, now decided. Nothing deployed anywhere.
- **Decided by Carlos, and done:**
  - **A1, the treasury moves in two steps.** `set_treasury` is gone. `propose_treasury`, signed by the current treasury, records a pending key (refusing the zero key and the current key; a later proposal overwrites, and proposing nothing clears); `accept_treasury`, signed by the pending key, is the only thing that moves the treasury, and it clears the slot. Until acceptance the old key turns every dial, is paid every fee and receives every sweep; after it, none of the three. Because a typo in a one-step handover locks the treasury forever: every dial frozen, every fee sent to nobody. Now a key nobody holds can be proposed but never accepted.
  - **A2, two items closed.** `register` does not re-read the mint: a classic SPL Token mint has no instruction that changes its decimals, so the byte recorded at `add_token` is the byte the mint holds forever, and re-reading would cost every registration an account for a change the token program cannot make. The fee destination and the dial key stay one field: a multisig's vault address both owns token accounts and signs, so one field moves both at once and nothing is lost.
  - **A3, no passkey gesture per write.** A write from Soil needs only the seed unlocked for the session. The passkey unlocks the seed; the signing key then signs from memory. A prompt per post or review was Vow's choice, not Forest's; a product may add one and the host cannot tell. Recorded in `docs/handoff.md` under "What Soil needs from the foundation".
  - **The host path**, taken from `docs/decisions/host.md`: fork the reference PDS's write path. The report is kept as written with one line at the top saying so.
  - All four are removed from session 6's "Open" list above.
- **Built, Part A:**
  - `registry/program/`: `propose_treasury(Option<Pubkey>)` and `accept_treasury()`, two new errors, a `pending_treasury` field appended to `Config` after `bump` (598 bytes, was 566; every offset before it unchanged), `init` writes an empty slot, two events. `registry/program/tests-litesvm/`: the wire format by hand a second time, and 21 tests (20 before): propose then accept; accept by a stranger, by the old treasury, and with nothing pending refused; every power stays with the old key until acceptance, including being paid and swept, and the pending key can do nothing; none after; a second proposal overwrites the first; proposing nothing clears; a proposed typo is harmless and corrected; `init` still writes the placeholder constant and an empty slot; the stranger test covers both new instructions. `registry/client/`: `proposeTreasuryIx`, `acceptTreasuryIx`, `decodeConfig` with `pendingTreasury`, the discriminator pins updated, 13 tests (12 before). `registry/README.md`: the dial, the rent row (config 606 bytes), the compute figure, "What `init` writes", chosen items 10 and 11. `docs/handoff.md`: a "Treasury handover" bullet in the Registry section, the Host row of the Layers table, the Soil section.
- **Built, Part B, `host/`:**
  - Bluesky's reference PDS at `9c76c3422ed0c5369871633d2c4ed67a2f61ae33` (2026-09-21, `@atproto/pds` 0.5.34), pinned in `host/UPSTREAM`, plus five patches in `host/patches/` (15 files, about 1,100 lines added, 46 changed, all in `packages/repo` and `packages/pds`): the repo library's commit formatting split from signing, byte-identical for upstream; an actor store that writes no key file and hands every server-signing path a keypair that refuses with `NoSigningKey`; the device-signed two-phase write (`foundation.forest.host.prepareCommit` and `submitCommit`, two lexicons and three handler files, authenticated by the device's service token, stateless between the phases, `swapCommit` honoured, a rev newer than the head required, the signature checked against the DID document's key over the rebuilt bytes) with the genesis creating the folder around the device's signature; `importRepo` accepting the device's token (one line); and the request serializer stripped of the socket address and every address header.
  - `build.sh` (clone at the pin, `git am` the patches, `pnpm install --frozen-lockfile`, build the PDS, the dev-env harness and the sync consumer), `run.sh` (the host on SQLite files from `pds.env`), `test.sh`, `pds.env.example`, and `test/device.ts`, the reference client: token per call, prepare, sign, submit, upload, import.
  - `test/host.test.ts`, the six tests the task asked for, on Node's runner against a local PLC directory and two in-process hosts: a folder from `keys/`'s DID with the genesis signed on the device; the four `shapes/` examples written through the two phases and read back, photo included; no key material anywhere under the host's data (every file read, every form of the seed and both keys searched for); the wrong key, a stale head with and without `swapCommit`, and a replay both ways refused, plus the server-signed path refusing the folder; the firehose read by `@atproto/sync` with every commit verified against the DID document, and the served repo verified by hand; and the move to a second host by CAR, served the same, verified, keyless, and still writable. All pass, here and from a clean directory through `build.sh`. Upstream's tests for `packages/repo` (58) and the PDS's crud, sync, file-upload and account-migration suites (97) pass on the fork.
  - `host/README.md`: all of the above, patch by patch, plus what a product must do and what is not done.
- **Chosen, not decided** (the handoff was silent; the simplest option was taken; each in `host/README.md` or `registry/README.md` with its reason):
  - Registry: the pending slot appended after `bump` so pinned offsets hold; `propose_treasury` takes an `Option`, `None` clears, so there is no third instruction and the zero key stays an error.
  - Host: stateless between the phases (recompute at submit; no pending table); the genesis is the creation, no separate endpoint and never a half-made folder; folders made active and only when the DID document already points at the host, so a move is point, genesis, import; the handle is the DID document's, validated by upstream's signup rules, first come first served, verified by nobody on the host; method and error names; `importRepo` keeps upstream's no-signature-check; tests outside the monorepo on Node's runner; the host's own rotation key still required by upstream's config, unused by any Forest DID.
- **Learned:**
  - Everything the design needed already had a seam upstream: `formatCommit` is deterministic given writes and rev and `formatInitCommit` already took a rev; `userServiceAuth` already verifies a token signed by the account's own key against the DID document; `uploadBlob` already accepted it; `createAccount` in the account manager needs no email or password, only an `actor` row; the `actor` table's handle is nullable but the creation path types it required. The fork is 1,100 lines because of that, not despite it.
  - The eager key load was the one real obstacle: `ActorStore.transact` read the key file before doing anything. Vow's mistake, signing genesis on the server, is avoided by having no key at all, so the genesis has to be prepared without an actor store: an in-memory blockstore does it in four lines.
  - `activateAccount` cannot serve a keyless folder: it checks for the host's own rotation key in the DID and reads the account's key file. Hence "active at creation, DID pointed here first", and hence no sync event after an import.
  - Upstream's `lex build` walks the whole `lexicons/` tree, so two JSON files under `lexicons/foundation/` become `foundation.forest.host.*` with no generated code in the patches. Generated lexicon code is gitignored upstream.
  - Node 22 strips TypeScript types but rejects constructor parameter properties; `keys/` and the tests avoid them. Upstream's identity resolver refuses plain `http` by default (SSRF protection), which is right and which a localhost test has to override with a plain `fetch`. The OAuth provider inside the PDS refuses a plain-http public URL unless dev mode is on, so a localhost `run.sh` needs `PDS_DEV_MODE=1`; a real hostname is https and does not.
  - A registration now costs 133,188 compute units (133,072 before), the price of a config 32 bytes bigger. Bytes on the wire unchanged, 829.
  - `pkill -f` with a pattern that appears in one's own shell command kills the shell. Twice.
- **Open:**
  - What handle a fresh, unnamed profile carries at genesis. `keys/`'s genesis requires one, the host validates it by upstream's signup rules (a service domain of the host, or a domain that resolves to the DID), and the foundation's names come only after a badge. A product decision the host design depends on: a placeholder domain the host lists as a service domain, or a rule change on the host.
  - Whether the host should refuse an imported CAR whose root does not verify against the DID document (one argument to `verifyDiff`; upstream does not pass it).
  - Whether the host should carry the four `shapes/` lexicons and validate Forest records itself, or leave validation to the device.
  - After an import there is no sync event, and the old host keeps serving the folder as active. Both need a keyless equivalent of `activateAccount` and `deactivateAccount`, or the carrier's own handling of a moved DID. Not built.
  - Whether a folder's owner can deactivate or delete it through the host without a session. Not built.
  - Railway, names and the carrier for the host: not started. The two-step round trip from a phone: not measured.
  - How the five patches rebase onto a newer upstream: unknown until tried.
  - Not done here: devnet; Kora; a proof on a phone; PSE confirmation; any paid review. `docs/handoff.md`'s "Before mainnet" list stands in full. The validator test's Node process that session 6 saw not exiting was not chased.
  - Still standing from earlier sessions: the permutation proof the code tree exists for, the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, the devnet placeholder treasury, and session 3's "not measured here" list.

## 2026-09-21: session 8, escrow design and escrow program v1, built and tested locally

- **Build order:** item 7 (`escrow/` v1) taken, minus devnet. The program is built and tested under LiteSVM and on a local validator. Nothing was deployed anywhere.
- **Built, Part A, `docs/handoff.md`:** the "Escrow" section replaced with the supplied text, word for word, in the document's own style (`-` bullets). The Layers table's Escrow row now says what the section says: a classic SPL token in its own deposit account, released by the buyer's approval, silence, agreement or an optional arbiter, cancelled by the buyer on time steps or by the seller at any time, every state change in the log. One other sentence contradicted the new section: the market file list under "Record shapes and markets" now includes default cancellation steps. Nothing else in the handoff disagreed.
- **Built, Part B:**
  - **`escrow/program/`,** the sealed program. Anchor 1.2, `cargo build-sbf` (Solana CLI 4.2.2). One account kind: the escrow, 278 bytes, at `["escrow", buyer, id]`, holding version, buyer, seller, arbiter (zero key for none), mint, the deposit account's address, the rent payer, amount, service time (zero for none), silence days, up to four steps of (offset in seconds from the clock start, refund in basis points), created time, funded time (set when first observed), status and bump. The deposit account is the escrow's associated token account for the mint. Ten instructions: `create`, `mark_funded`, `approve`, `release_by_silence`, `object`, `agree`, `arbitrate`, `cancel_buyer`, `cancel_seller`, `close`. Ten events, every one with the amounts. No admin, no config account, no upgrade, no pause, no fee.
  - **`escrow/program/tests-litesvm/`,** 22 tests with the clock moved by hand, the wire format and the account layout written out a second time without importing the program: every instruction's happy path with exact balances, the excess above the amount coming back on top of every payout, the clock starting at the service time when set, an objection as the first observation of funding, a pre-funded deposit account adopted at `create`; and the rejections: the wrong signer for every instruction, an unfunded approve (and six others), silence a second too early and while locked and before the clock started, buyer cancel on and after the last deadline and while locked, seller cancel after release (the account is gone), arbitrate without an arbiter, a Token-2022 mint, unsorted, duplicate and over-100% steps, five steps, buyer equals seller, the buyer or seller as arbiter, a zero amount, zero silence, a split over 10,000, a close on a funded escrow, a payout aimed at a stranger's token account, rent aimed at a stranger. Rent goes out at creation and comes back to the rent payer, to the lamport, on all seven endings including never-funded.
  - **`escrow/client/`,** TypeScript for a browser or Node: every instruction, `termsFor` from a market file's defaults and the parties' choices, `schedule` (the clock start, when silence releases, each deadline, the step in force, what the buyer can do now), `payout` and `cancelPayout`, the deposit address and `solanaPayUrl`, `decodeEscrow` and `decodeEvents`. Twelve tests with no chain, and one on a validator it starts itself: create from a market file with a service time, fund by a plain SPL transfer (half a dollar over), `mark_funded` signed by nobody, approve 70/30, balances and rent exact, events decoded from the log.
  - **`escrow/README.md`,** rewritten: layout, how to run it, what one escrow costs, what is sealed, what the app decides, the state machine as a table, how a review's escrow pointer resolves, the two commands that remove the upgrade authority, thirteen chosen-not-decided items, what this does not do.
- **Chosen, not decided** (the handoff was silent; the simplest option was taken; each is in `escrow/README.md` with its reason and reversible until something ships):
  - The escrow address is a program-derived address of the buyer and a random 64-bit id, and the deposit account is its associated token account: the address every wallet derives for "send this token here", so a plain transfer from anywhere lands by construction.
  - `create` adopts an existing deposit account and counts the escrow funded at once if it already holds the amount.
  - A step's deadline is a signed offset in seconds from the clock start (negative: before a service time; positive: after funding); offsets strictly rising; refunds in any order. The market file writes steps as `{ hours, refundPercent }`.
  - The seller's share rounds down everywhere; the buyer gets the rest of the balance.
  - A never-funded escrow's last deadline, for the buyer's `close`, is measured from the service time if set, else from creation.
  - The seller may cancel while locked (a concession, the buyer gets everything); the buyer may not approve while locked, as the handoff says.
  - The arbiter may not be a party; the seller may not be the buyer or the zero key; a service time is any positive unix time; silence days are sixteen bits; every ending takes both parties' token accounts so seven endings share one account list.
  - Anchor 1.2 with `cargo build-sbf` and no IDL, as in the registry. Program id for local work `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT`, no keypair committed.
- **Learned:**
  - **What one escrow costs:** `create` with the fullest terms 31,000 to 46,000 compute units (2 to 3% of the limit) and 650 bytes on the wire (53% of 1,232); `approve` 14,037 units and 482 bytes; `release_by_silence` 12,008 and 383; `cancel_buyer` 14,247 and 480. `create` varies between runs because its two address derivations try bump seeds at 1,500 units a try and the keys are random; the endings derive nothing and are fixed to the unit. Rent for the two accounts is 4,920,720 lamports at LiteSVM's rate (286 and 165 bytes), all returned.
  - A skipped `mark_funded` blocks nothing except silence and the buyer's cancellation, which need a clock start and cannot take one from a moment nobody recorded. `object` records it, and `create` records it when the deposit account was funded first. The client's `schedule` reports a null clock so the app knows to send `mark_funded`, in the same transaction if it likes.
  - Anchor's `Signer` type fails with `AccountNotSigner` (3010), not `ConstraintSigner`; the latter is the `#[account(signer)]` constraint. A test that named the wrong one caught nothing until it ran.
  - Anchor 1.2's `CpiContext::new_with_signer` takes the program's key, not its account info, as the registry's code already showed.
  - LiteSVM 0.16 bundles the classic token program, Token-2022 and the associated token program, so `create`'s CPI into the associated token program needs nothing loaded, and `set_sysvar::<Clock>` moves time to the second.
  - The test validator is 4 seconds for the whole deal, and `getSignaturesForAddress` on a closed escrow's address is how an index will read its history.
  - The market template (`shapes/`) has exactly eight keys, so the cancellation steps the handoff now names cannot go in a market file until the template and `markets` grow a ninth. The client reads the field if present and treats its absence as no steps.
- **Open:**
  - The market template needs a `cancellationSteps` field (hours from the clock start and a refund percent, per the client) in `shapes/` and the `markets` repo, and `online-tutors` needs its default steps decided. Not done here: one task per session.
  - Whether a review's escrow pointer should carry the closing transaction's signature as well as the address, since a buyer can reuse an address by reusing an id. Or whether the program should refuse an id whose escrow has closed, which would need it to keep a record per closed escrow and would cost rent forever.
  - Whether the wallets people use (Phantom and the rest) accept a program-derived address as a Solana Pay recipient for a token transfer. Squads vaults suggest yes; not tried on a phone. If not, the link names the deposit account directly, which the client also gives.
  - Money sent to a closed escrow's deposit address is recoverable only by the same buyer re-creating the same id, which adopts the account. Whether that is enough, or the app should warn, is a product question.
  - Whether `approve` should be allowed while locked (the buyer conceding), symmetrically with the seller's cancel under a lock. Refused now, as the handoff reads.
  - Whether `release_by_silence` and `cancel_buyer` should observe funding themselves when they can (they cannot: a failed transaction records nothing), or whether the app always bundles `mark_funded`.
  - Not done here: devnet, Kora, a phone, any paid review. `docs/handoff.md`'s "Before mainnet" list stands in full, and the lawyer pass over the escrow program is on it.
  - Still standing from earlier sessions: the host's genesis handle, the host's import checks and deactivation, the carrier and Railway for the host, the permutation proof the code tree exists for, the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, the devnet placeholder treasury, and session 3's "not measured here" list.

## 2026-09-22: session 9, test site and handover experiment

- **Build order:** outside the numbered list; asked for by Carlos. A static test site to put online and try on real phones. Nothing deployed. Nothing under `keys/`, `registry/`, `escrow/` or `host/` changed.
- **Built:**
  - **`testsite/`:** a static site with no server and no framework.
    - `index.html` links the two pages.
    - `build.sh` writes `dist/`.
    - `vercel.json` is copied into `dist/` by the build.
    - `README.md` covers deploying (import the repo into Vercel, root `testsite/dist`), rebuilding, and that nothing here is a product.
    - `testsite/dist/` is committed, as an exception in the root `.gitignore`, so the site can go online without a build step. It has no source maps.
  - **`testsite/keys/`:** the keys test page with the same behaviour. `index.html` is `keys/test-page/index.html` with a footer and a link back.
    - `page.js` is copied from `keys/test-page` at build time and never kept here, so it can't drift.
    - The library is bundled by `keys/`'s own esbuild, with `build:page`'s entry and flags plus `--minify`: 234 KB.
  - **`testsite/handover/`:** the experiment. One plain JS file with no dependencies.
    - **Start handover** makes a deal id (16 random bytes) and a P-256 session key in the page. It creates a passkey with:
      - challenge = SHA-256(deal id ‖ raw session public key)
      - a random 16-byte user id
      - `authenticatorAttachment` `cross-platform`, so the browser offers its QR flow
      - user verification required, attestation `none`
    - It records:
      - the credential id and public key
      - `getTransports()` and `authenticatorAttachment`
      - the flags, sign count and AAGUID
      - the creation checks: the challenge echoed, origin, type, relying-party hash, user present, credential id and key matching the browser's
      - the raw bytes
    - **Confirm again** signs in with that passkey over the same challenge and checks the signature in the page with Web Crypto (ES256 via DER to r‖s, and RS256).
    - Every try is recorded, failures included, with timings and the error. There is a note field. **Download report** saves JSON with the seller's user agent. The report survives a reload.
    - `README.md` is the test script for a person: six cases, numbered steps, what to send back, and what this is not.
  - **Checked here:** headless Chromium with CDP virtual authenticators, from a scratch script that is not committed, as with the keys page. It covered:
    - create and confirm through a cross-platform authenticator, and through a platform one with the control option
    - ES256 and RS256
    - the signature verified again, independently, with Node's crypto
    - a swapped public key refused
    - a failed ceremony recorded
    - the download, and the note surviving a reload
    - the keys page's create, unlock, reload and unlock giving the same fingerprint and DIDs from the minified bundle

    The build is byte-for-byte reproducible. The QR flow itself can't be simulated: no real phone has run either page.
- **Changed from the task, because it could not be done as written:**
  - **No signature at creation.** Attestation `none` returns an empty statement, so creation carries no signature to check. The page checks everything else at creation and checks the signature at Confirm again, over the same deal challenge.
  - **A choice was added for the control:** "this device (the control)" asks for `platform`. With `cross-platform` pinned, as the task specified, the browser never offers the phone's own passkey, so the same-device case couldn't be run at all.
  - **The control's expected result was changed.** The task expected transports `internal` and not `hybrid`. But `getTransports()` lists what the authenticator can be used over later, not how this ceremony travelled (WebAuthn's `[[transports]]` slot and MDN both say so), so a phone's passkey may report `["hybrid","internal"]` either way. The field that reports this ceremony is `authenticatorAttachment` (`cross-platform` or `platform`). The test script names it, and says to record transports as they come.
- **Chosen, not decided** (the task was silent; the simplest option was taken):
  - The deal id's size and encoding.
  - P-256 for the session key, whose private half is not used.
  - The challenge's exact byte order.
  - The same challenge for Confirm again.
  - "Resident key not required" read as `preferred`, not `discouraged`. Phones make a discoverable passkey either way, and a browser may hide the phone option for a request that discourages one. That is a guess about browser menus, not tested.
  - A 120-second timeout.
  - The deal is prepared before the tap, so the tap goes straight into the passkey call. Safari may refuse a passkey call that follows other async work; not tested.
  - One report per case, holding every try until "Clear report", kept in `localStorage`.
  - No download button on the keys page, because "unchanged in behaviour".
  - `vercel.json` copied into `dist/`, because Vercel reads it from the root directory it is given, and `trailingSlash` set so `/keys` redirects to `/keys/`, where the relative script paths resolve.
- **Learned:**
  - **Nothing signed says a ceremony went phone to phone.** `clientDataJSON` and authenticator data carry no transport. The Bluetooth check is enforced by the browser on the device running the page, and the page records what that browser reports.
    - So a completed QR-flow ceremony is evidence of closeness only to whoever trusts that device. It is not evidence to a third party, such as an index weighing a review.
    - A buyer and seller who collude can produce the same report without meeting.
    - Beyond that, a relay with two Bluetooth radios and an internet link can stretch the range. The screenshot cheat doesn't test it.
    - The one part a third party can check is the buyer's passkey signature over the deal challenge.
    - Written into the test script's "What this is not".
  - In Chromium's virtual authenticators, a `usb` authenticator reports transports `["usb"]` and attachment `cross-platform`; an `internal` one reports `["internal"]` and `platform`. Real phones are expected to differ on transports; not tried.
  - A root `.gitignore` line `dist` also matches nested folders called `dist`. The exception needs `!testsite/dist/**` as well as `!testsite/dist/`, because the keys page loads `./dist/forest-keys.js`.
- **Open:**
  - The six cases on real phones. Not run; the answers come back as reports.
  - **What the handover is for.** If it should count as evidence to anyone but the seller (an index, a review's weight), something the buyer's phone signs would have to carry the closeness, and WebAuthn gives nothing for that. If it is only for the two parties, it may already be enough. A question for a chat with Carlos, not decided here.
  - Whether an iPhone or an Android phone, as the seller's device, shows a QR code for another device when a page asks for `cross-platform`. Unknown until tried; the test script says to record it.
  - Whether the keys page should get a download button for its own results, which would help the still-pending keys tests on Apple, Android and Windows.
  - Still standing from earlier sessions: the market template's `cancellationSteps` and `online-tutors`' default steps, a review's escrow pointer, the Solana Pay recipient on a phone, the host's genesis handle, the host's import checks and deactivation, the carrier and Railway for the host, the permutation proof the code tree exists for, the pricing unit in the market file, whether a review points at its post, whether the `markets` validator reuses `validateMarket`, whether a product writes a seed file under the first passkey, the keys tests on Apple, Android and Windows, the devnet placeholder treasury, and session 3's "not measured here" list.

## 2026-09-22: session 10, deals, wallets, adversarial review 1

- **Build order:** outside the numbered list; asked for by Carlos. Two parts: decisions from a chat written into `docs/handoff.md`, and an adversarial review of the two sealed programs. Nothing deployed anywhere.
- **Decided (Part A, from the chat with Carlos, written into `docs/handoff.md`):**
  - **A new section, "Deals and evidence", after "Reputation".** Every interaction is a deal with a 32-byte random deal id, and an escrow's account address is its deal id. Because a review needs something to point at even when no rating is given, and one id shared by both sides turns two reviews into two receipts.
  - **A review is a signed claim about another profile pointing at a deal id; it can be as thin as "I dealt with this person on this deal".** Because two reviews pointing at each other across one deal id already are the two sides' receipts, so no new record shape is needed.
  - **Evidence, for now, is one kind: the escrow's receipt on chain; indexes weigh it, programs never interpret it.** Because the sealed programs cannot learn new kinds of evidence, and indexes can.
  - **No evidence proves two people were physically together.** Because two people who agree to lie can relay their devices from anywhere and no phone signs a physical measurement (session 9's handover experiment found the same for WebAuthn); collusion is bounded by identity and reviewer trust instead.
  - **A product may make every payment an escrow that releases in the same second, and the program must let create, fund and approve ride in one transaction.** Because then every payment has a receipt at an address a review can point at, and "Pay" stays one tap.
  - **The review shape's "escrow pointer" is now "deal id" in the handoff; the four shapes stay as they are.** Because a deal can exist without an escrow, and when there is one its address is the deal id.
  - **Reading Forest is public HTTP with no keys; the foundation publishes a skill file at forest.foundation and in `index/`; writing goes through the door in Soil (MCP).** Because any AI can read public JSON with a plain text guide, while writing needs the user's keys, which only the app holds; so the index's machine endpoint is designed for that skill: stable URLs, JSON, no session. Written into the Index row of the Layers table and "What Soil needs from the foundation".
  - **Wallets: one central wallet per person and one per profile; the central wallet only meets ramps; deals touch only profile wallets.** Because receipts must bind to profiles, and every seller cashing out to one place is where profiles link on chain.
  - **Moves between the central wallet and a profile wallet go through a third-party privacy pool once one is live on mainnet, reviewed and cleared by a lawyer, in round amounts after a random wait; until then they are direct and the button says so; Forest never builds or embeds a pool.** Because equal amounts minutes apart are a link anyone can read, and a user moving their own money through a reviewed pool is not Forest doing it. Replaces the old last bullet of "Escrow"; "What Soil needs from the foundation" says the same.
  - **Three items added to "Don't resurrect":** money entering each profile only from outside with no central wallet (because the cash-out funnel links profiles anyway); a mutual-receipt evidence type (because two reviews pointing at one deal id already are it); Bluetooth or NFC co-presence as evidence anyone can verify (because nothing a phone signs carries closeness).
- **Built (Part B, the adversarial review):**
  - **`docs/decisions/adversarial-review-1.md`:** the report. A three-line verdict, fourteen findings by severity, the threat list per program with every attack and its test, the one-tap product check, the fuzzing runs and their coverage, rules an index must follow, and what could not be tested.
  - **The adversarial suites:**
    - `escrow/program/tests-litesvm/tests/adversarial.rs`, 23 tests;
    - `escrow/program/tests-litesvm/tests/one_tap.rs`, 2 tests;
    - `registry/program/tests-litesvm/tests/adversarial.rs`, 15 tests, against the real proofs;
    - new and extended tests in both clients' `test/client.test.ts`.

    A test named `finding_…` asserts an attack the program accepts, so the suite records what the report says.
  - **Fuzzing:**
    - `escrow/program/trident-tests/`: Trident 0.12 against the built escrow, with a model of every escrow and seven invariants checked after every step.
    - `registry/program/tests-litesvm/tests/invariants.rs`: the registry's five invariants as a LiteSVM property test, seeded and replayable.
    - `registry/program/trident-tests/`: kept as the record of why Trident cannot run the registry.
  - **Fixed, each with a test that failed first:**
    - The escrow's `cancel_buyer` rounded the buyer's refund down, so the seller's share rounded up, against the README's sealed rule. It now computes the seller's share as `share(amount, 10,000 − refund)`, one line. The client's `cancelPayout` and its test match.
    - Both clients' event decoders (`decodeEvents`, `decodeRegisteredEvents`) took `Program data:` lines from any program, so an index using them would have shown forged badges and forged receipts. Both now read only lines their own program wrote (`programDataLines`), by following the runtime's invoke lines.
  - **READMEs:** both list the new suites and how to run them. The escrow README states the cancellation rounding and the decoder rule. The registry README says a new treasury key should hold a little SOL.
- **Learned:**
  - **One-tap Pay works with no program change.** `create`, a plain transfer in and `approve` fit one transaction: 51,727 compute units (3.7%) and 668 bytes (54%); 57,735 and 710 bytes if the seller's token account is made in the same transaction; 749 bytes with the fullest terms. The rent is fronted and returned inside the transaction, so the receipt costs no rent. There is no `Funded` event in it.
  - **Trident 0.12 runs the escrow but cannot run the registry.**
    - The registry fails because `trident-svm` 0.2.0 starts from `SVMFeatureSet::default()` (every feature off) and its builder cannot change that. The Poseidon and alt_bn128 syscalls are therefore never registered, and the first hash fails as "unsupported BPF instruction".
    - Its runtime does not check signatures: every key can sign.
    - Its progress bar swallows assertion messages when output is not a terminal. `TRIDENT_WITH_EXIT_CODE=1` gives exit 99 on any failure, and `script` recovers the messages.
  - **The escrow fuzzer finds this session's rounding bug by itself:** 40 failures in 24,000 steps on the unfixed program.
  - **Long runs:**
    - Escrow: 40,000,000 flow calls (27,184,961 transactions) in 32 minutes, every invariant held, all 25 of the program's own refusals reached.
    - Registry: 1,600,000 flow calls in two 14-minute runs, every invariant held.
  - **The runtime refuses any transaction that leaves a credited account below rent exemption.** Two consequences:
    - A treasury key holding no SOL refuses sweeps smaller than an empty account's rent.
    - After the rent rate rises, a small top-up of a registry account is refused.
  - **A rent rise after a sweep freezes nothing.** A rent-paying account can still be written, as long as its lamports do not grow.
  - **The native mint and SOL:** wrapped SOL that arrives without a sync, and SOL sent to an escrow's address, both end with the rent payer.
  - **Solana Pay and a program-derived recipient:**
    - `@solana/pay` 1.0.26 derives the deposit account with no off-curve check, and requires it to exist and not be frozen.
    - `@solana/spl-token`'s helper refuses an off-curve owner by default.
- **Open (for Carlos; each with its trade-offs in the report):**
  - **Deploy blocker:** replace the registry's placeholder `TREASURY` before any deploy. Also consider a build guard that refuses a mainnet build with the placeholder.
  - **Seller consent:** strangers can lock, make receipts on, or rig escrows naming any seller. The report recommends indexes weigh only deals the seller acknowledged (two reviews across one deal id, or a seller signature on the escrow), plus terms checks in the seller's app. A seller co-sign in the program only if that proves not enough.
  - **The deal id:** an escrow address can hold two deals by the same buyer, and it is neither 32 random bytes nor single-use. Options: define the deal id as the address plus its `Created` slot or signature; keep a permanent marker per closed address; or accept it.
  - **Wrapped SOL:** refuse the native mint at `create` (recommended, one line), or sync before paying out.
  - **The sponsor:** its rent can be locked in escrows nobody ends. Options: a sponsor policy (sponsor `create` only when funded in the same transaction), or let the rent payer close a never-funded escrow after a wait.
  - **Vouchers:** the treasury can accept a token it mints itself and so bring vouchers back. Only the treasury's own discipline stops it.
  - **The paying wallet:** it is not bound to the DID. Options: an index rule (the profile's declared wallet must have paid), binding the wallet into the proof's message (only before deploy), or accepting badge selling as bounded.
  - **Timing:** registering right after joining can link a face check to a profile. Needs a client wait rule, sized from real joining rates.
  - **The client's `termsFor`:** accepts milliseconds as seconds, refund steps longer than silence, and a past service time. Refuse or warn.
  - **`shapes/`:** the review lexicon still calls its field `escrow`; the handoff now says deal id. Renaming it is a `shapes/` session. Where the person's central wallet's key comes from (a `keys/` derivation, presumably) is not decided here.
  - **Not done here:**
    - the Kora config (so the fee payer went untested);
    - devnet, a phone, a face check;
    - the cryptographic review of groth16-solana and the syscalls;
    - the paid review and the lawyer pass in "Before mainnet".
  - **Still standing from earlier sessions:** the market template's `cancellationSteps` and `online-tutors`' default steps; the Solana Pay recipient on a phone; the host's genesis handle, import checks and deactivation; the carrier and Railway for the host; the permutation proof the code tree exists for; the pricing unit in the market file; whether a review points at its post; whether the `markets` validator reuses `validateMarket`; whether a product writes a seed file under the first passkey; the keys tests on Apple, Android and Windows; the devnet placeholder treasury; the handover's real-phone cases; and session 3's "not measured here" list.

## 2026-09-23: session 11, hardening from adversarial review 1

- **Build order:** outside the numbered list; asked for by Carlos. Two parts decided by Carlos in a chat (escrow, registry), plus three policy lines in the handoff. Nothing deployed anywhere.
- **Decided (by Carlos; built here):**
  - **Escrow: the seller accepts.** A new status, `accepted`, and a new instruction, `accept`, signed by the seller, with an `Accepted` event. Because a stranger could otherwise open an escrow naming any seller, then lock it, arbitrate it with a puppet, or rig its clock (review finding 6).
  - **Escrow: before acceptance, only a full approval and the buyer's withdrawal touch a funded escrow.** `approve` at 10,000 basis points runs; `object`, `release_by_silence`, `arbitrate`, `agree`, `cancel_seller`, `cancel_buyer` and `mark_funded` are refused with `NotAccepted`. Because paying in full never needs the seller's consent, and nothing else should happen without it.
  - **Escrow: the buyer's withdrawal is `withdraw`**, everything back, outcome `Withdrawn`. Because a buyer whose seller never answers must be able to take the money back.
  - **Escrow: an escrow the seller opens is an invoice, accepted from creation.** `create` now takes a creator signer, the buyer or the seller, and the buyer moves into its arguments. Because the party who writes the terms has consented to them.
  - **Escrow: receipts are permanent.** At every ending the deposit account closes and its rent goes back to the rent payer; the escrow account stays, with its final state, amounts and outcome (status `Ended`), so its address can never be reused. Because the address is the deal id and a review points at it forever (finding 7).
  - **Escrow: `close_unfunded` replaces `close`.** An escrow that never held the amount is closed, both accounts and both rents, by the buyer or the seller at any time, or by its rent payer after its last deadline (at any time with no steps). Because a never-funded escrow is no receipt, and a sponsor needs a way to its rent (finding 3).
  - **Escrow: wrapped SOL is refused at `create`.** Because SOL sent to a wrapped-SOL deposit account without a sync went to the rent payer, not the buyer (finding 2).
  - **Registry: the profile's wallet signs every registration**, on the sponsored path as well as the paid one. Because nobody should be able to put a badge on a profile they don't control (finding 9).
  - **Registry: the fee is stored per accepted mint, set once at `add_token` in that mint's units; USDC stays at 0.25 as a program constant nothing can change or remove.** Because if the dollar ever fails, the treasury adds another token with a sensible amount and registration continues.
  - **Registry: `close_list`.** The treasury closes a list to new insertions; proofs against it stay valid forever; no instruction deletes a list. Because a list must be retirable without breaking anyone's badge.
  - **Registry: a treasury holding no SOL is a deploy-checklist line, not a program change.** Because the runtime, not the program, refuses to leave a credited account below rent exemption, so no one-line fix is safe.
  - **Handoff, Soil:** Soil waits a random interval, minutes to hours, between joining and a first registration, and the issuer inserts identities in batches. Because otherwise a badge can be matched to a face check by timing (finding 10).
  - **Handoff, Keys:** the central wallet is derived from the seed with its own info string, like profile wallets but with no index. Because it must come back from the seed like every other key, and link to no profile.
  - **Handoff, Open:** a later circuit proving the profile's key and the identity secret come from one seed; v1. Because that closes badge selling entirely, which the profile's signature alone does not.
- **Chosen here, not decided (each in a README's "Chosen, not decided"; for Carlos to confirm or undo):**
  - **The clock never starts before acceptance:** it starts at the later of the acceptance and the service time or, with no service time, the funding. Because a seller who accepted after silence had run out could accept and release in one transaction, before the buyer could object.
  - **`mark_funded` is refused before acceptance, and `accept` observes funding.** Because Carlos's rule lets only two instructions touch a funded escrow before acceptance, and one observation keeps the clock unambiguous.
  - **The profile's wallet goes into the proof's message** (`keccak(profile namespace ‖ wallet ‖ DID) >> 8`), not only into the signer list. Because with a signature alone, a relay or the sponsor that saw a proof before it landed could land it under its own key and spend the person's code for good.
  - **The `Registered` entry names the wallet, and an index counts a badge only when the profile record declares that wallet.** Because no program can read a DID's records, so that check is what makes "the profile signs" mean "only its owner badges it".
  - **The fee authority is its own signer slot** (`fee_authority`, `fee_tokens`), separate from the profile's wallet and the payer. Because the sponsored path pays the fee from the sponsor's tokens while the profile consents.
  - **A closed list stays closed**; the flag sits in a padding byte of the list account, so its size and offsets are unchanged. **`init` requires USDC to count in six decimals**, since the constant is 0.25 only then. **A fee of zero is refused**, and no other amount.
  - **The escrow's ending event is `Ended`; `Closed` now means only a never-funded escrow closed.** Because a `Closed` on an account that stays would mislead every index. The escrow's status values were renumbered in order (open, accepted, funded, locked, ended) and the new fields appended after `bump`; nothing is deployed.
  - **`withdraw` and `close_unfunded` name no seller token account.** Because a buyer should never have to make one to get their own money back (finding 12).
  - **The client's `checkTerms`**, run by `termsFor`, `createIx` and `acceptIx` before anything is signed: a service time below 10^10 (so milliseconds are caught) and not already past; no step outlasting silence; the escrow's arbiter equal to the one the signer agreed to, and none if none. Because those are the three terms the program accepts but nobody means (finding 13).
  - **`registry/client`'s `test:validator` runs with `--test-force-exit`.** Because it passes and then never exits, at HEAD as well: something the prover loads keeps Node alive.
- **Built:**
  - **`escrow/program/`:** `accept`, `withdraw` and `close_unfunded` (replacing `close`); an `Ended` check first in every instruction; the native mint refused; the account 278 → 311 bytes (accepted_at, ended_at, outcome, to_seller, to_buyer); events `Accepted`, `Withdrawn`, `Ended`, `Closed` (new layout); errors `NotAccepted`, `AlreadyAccepted`, `Ended`, `NativeMint`, `NotACloser`, appended so the old codes keep their numbers.
  - **`escrow/program/tests-litesvm/`:** 51 tests (47 before): the wire format by hand again; new tests for acceptance, the invoice, the withdrawal, the clock before acceptance, receipts that accept nothing after the end (a re-created deposit account included), `close_unfunded` from each closer, wrapped SOL, and one-tap Pay's rent at 5,080 and 696 lamports a byte. Session 10's `finding_…` tests for findings 2, 6 and 7 are now refusals; the sponsor's and the one-tap link's findings are restated as they stand now.
  - **`escrow/program/trident-tests/`:** the model knows acceptance, invoices, withdrawals, `close_unfunded`, wrapped SOL and permanent receipts, and checks an eighth invariant (a receipt never changes or closes).
  - **`escrow/client/`:** `acceptIx` (built only from the escrow account read off the chain, after `checkTerms`), `withdrawIx`, `closeUnfundedIx`, `invoiceIx` and `invoice` (the seller's create and the pay link), `checkTerms`, the new account fields and events, the clock with acceptance; 16 unit tests (14 before) and a validator test running a proposal the seller accepts and an invoice paid in one tap.
  - **`registry/program/`:** `fee_authority` and `fee_tokens` beside the profile's wallet; the wallet in the message; the wallet in `Registered`; `fees` in place of `decimals` in the config (598 → 710 bytes); `USDC_FEE`, `USDC_DECIMALS`; `add_token(fee)`; `close_list` and a closed flag; errors `FeeZero` and `ListClosed`.
  - **`registry/program/tests-litesvm/`:** 39 tests (37 before), against fixtures regenerated with each profile's wallet (codes, roots and scopes unchanged; Alice's wallet is her profile 0 wallet from the keys recipe's test seed); new tests for both signing paths, a front-run under another wallet, fees per mint, and closing a list; the property test models the profile's signature, fees per mint and closed lists (R6).
  - **`registry/client/`:** `messageOf(wallet, did)`, the wallet through `proveMembership` and `buildRegistration`, the new register accounts, `addTokenIx(fee)`, `closeListIx`, `feeFor`, the new config and list layouts and the wallet in the entry; 15 unit tests (13 before); a validator test on the sponsored path, with a front-run that must fail and leave the code unused.
  - **Docs:** both READMEs (the escrow's state machine; the registry's sealed rules, dials and a deploy checklist whose first line replaces the placeholder treasury); `feepayer/README.md`; the handoff's Layers rows, Registry and Escrow sections, and the three policy lines; an addendum to `docs/decisions/adversarial-review-1.md` saying where each finding stands.
- **Learned:**
  - **Trident's clock runs on the wall.** `trident-svm` 0.2.0 moves its clock forward by the wall-clock time each transaction took, so a model that reads the time after sending is now and then a second late. The first 40-million-flow run stopped with 26 failures of the new receipt invariant ("whether the seller accepted", one second off); the program was right. The model now reads the time before sending in `accept`, `fund_and_mark` and `mark_funded`. Session 10's two funding flows had the same flaw, hidden because no invariant compared the funding time.
  - **The fuzzer catches a missing end check.** With the `Ended` check taken out of `approve` alone, 344 failures in 200,000 flows (exit 99). Restored before the long run.
  - **Long runs:**
    - Escrow: 40,000,000 flow calls (25,918,318 transactions, 5,138,400 landed, no panic) in 19 minutes on four threads, every invariant held, 591,492 endings, each checked as a receipt afterwards; seed `52ccadf6…45640b73`. All 30 of the program's own refusals were reached in a smaller run with metrics.
    - Registry: 1,600,000 flow calls in two 14-minute runs (seeds 1111 and 2222), every invariant held, R6 included: 81,574 registrations landed, 17,353 lists closed and 9,014 insertions into a closed list refused, 15,125 zero fees refused.
  - **"Fails before" was checked against session 10's built programs:** 50 of the 51 escrow tests and 34 of the 39 registry tests fail there; the six that pass test behaviour this session did not change. The account layouts and instruction lists changed, so most would fail on the wire alone; the evidence about behaviour is session 10's `finding_…` tests, which asserted each attack and now assert its refusal.
  - **One-tap Pay now costs the payer the receipt's rent:** 2,270,760 lamports ($0.23) at 5,080 a byte, 311,112 ($0.031) at 696. The deposit account's rent still comes back in the same transaction. 45,800 to 71,400 compute units (3 to 5%) and 700 bytes (57%); the spread across runs is the address derivation, since the keys are new each run.
  - **A registration is 830 bytes (67%)** with two signers on either path, 133,033 compute units with the profile paying the fee and 135,474 with a sponsor paying it; 832 bytes and 133,027 units in the client's v0 form on a local validator.
  - **Putting the wallet in the message changed no code, root or scope** in the fixtures: the code comes from the scope and the identity secret, never the message. Alice's wallet in the fixtures is her profile 0 wallet from the keys recipe's test seed (`Azh4zBXf…r41UWx`), so `registry/` and `keys/` agree.
  - **`registry/client`'s validator test never exits, at HEAD too.** It passes and then waits forever; `--test-force-exit` ends it.
- **Open (for Carlos):**
  1. **Money sent after the end is lost.** Anyone can make an ended escrow's deposit account again and pay into it (a second tap on a paid one-tap link does exactly that), and no instruction moves it (`one_tap.rs`). Options: an instruction anyone can call that pays such tokens to the buyer and closes the account, only before deploy; or apps never show a link once it is paid, which does not stop a copied address.
  2. **Receipts keep rent, and anything sent to them.** Every funded escrow keeps 319 bytes of rent for good ($0.23 today, $0.031 after the cuts), and SOL sent to an escrow's address stays in its receipt. Nothing sweeps it. Options: accept it; or a sweep to the rent payer of whatever sits above the receipt's rent-exempt minimum.
  3. **A sponsor's rent in a funded escrow nobody accepts.** Only the buyer can end it (a full approval or a withdrawal), so a sponsor's rent waits on the buyer; and an unfunded escrow whose steps run a century keeps its rent payer waiting a century. Options: a sponsor policy (sponsor only escrows funded and accepted in one transaction, or with deadlines under a cap); or let the rent payer send the money back to the buyer after the last deadline.
  4. **One-tap receipts are unaccepted** unless the payment is to an invoice: `accepted_at` stays zero. If indexes weigh only deals the seller acknowledged, as the review recommends, every one-tap payment to a proposal counts for less. Products could make one-tap Pay always pay an invoice the seller published. How an index weighs an unaccepted receipt is open.
  5. **An invoice paid late releases at once.** An invoice is accepted at creation, so its clock starts at its service time; money that lands after silence has run out can be released the same second. The client's `checkTerms` catches it only if the buyer's app runs it with the current time before paying. Program option, only before deploy: never start the clock before the funding.
  6. **CLAUDE.md says "25 cents, always".** USDC's fee is the 0.25 constant; another token's fee is whatever the treasury sets once at `add_token`, as decided. The rule's wording may want "in USDC; another accepted token's fee is set once when it is added".
  7. **`keys/SPEC.md` has no central wallet yet.** The handoff says it has its own info string and no index; the string itself (`forest.foundation/central/wallet/v1`, say) and its test vectors are a `keys/` session.
  8. **Confirm or undo the choices listed above**, above all: the clock's start at the later of acceptance and the service time or funding; the wallet in the proof's message; and the index rule that a badge counts only when the profile record's declared `wallet` is the entry's wallet (the handoff states it; no index code exists yet).
  9. **Deploy blocker, still:** the registry's placeholder `TREASURY` is the first line of the new deploy checklist.
- **Not done here:**
  - `registry/program/trident-tests/` still models session 10's wire format; it cannot run anyway, and `invariants.rs` is the model kept current.
  - The Kora config (so neither fee payer path went through Kora); devnet, a phone, a face check; the cryptographic review of groth16-solana and the syscalls; the paid review and the lawyer pass.
- **Still standing:** from session 10, the vouchers finding (the treasury can accept a token it mints itself and now sets that token's fee; only its own discipline stops it), the size of Soil's random wait (from real joining rates), and `shapes/`' review lexicon still calling its field `escrow`. From earlier sessions, the market template's `cancellationSteps` and `online-tutors`' default steps; the Solana Pay recipient on a phone; the host's genesis handle, import checks and deactivation; the carrier and Railway for the host; the permutation proof the code tree exists for; the pricing unit in the market file; whether a review points at its post; whether the `markets` validator reuses `validateMarket`; whether a product writes a seed file under the first passkey; the keys tests on Apple, Android and Windows; the devnet placeholder treasury; the handover's real-phone cases; and session 3's "not measured here" list.

## 2026-09-23: session 12, follow-ups from session 11

- **Build order:** outside the numbered list; asked for by Carlos. Two parts: program follow-ups Carlos decided in a chat (escrow, registry wording, keys), and handoff updates. Nothing deployed anywhere.
- **Decided (by Carlos; built or written here), one line of reason each:**
  - **A1, escrow, late money:** `recover_late`. Anyone may send it on an ended escrow; whatever sits at its deposit address, re-created or not, goes to the buyer's refund address, which the caller may create. Because a second tap on an old pay link is almost always the buyer's own money.
  - **A2, escrow, rent sweep:** `sweep_rent`, mirroring the registry's. What the escrow account holds above its current rent-exempt minimum goes to the rent payer; it never goes below the minimum or touches anything else; anyone may send it. Because receipts are never closed, so without it every receipt would keep for good the rent Solana's cuts free.
  - **A3, escrow, unaccepted timeout:** `close_unaccepted`. Anyone may close a funded escrow nobody accepted, after its last cancellation deadline, or 30 days after funding with no steps: all money to the buyer's refund address, rent to the rent payer, receipt kept with outcome "never accepted". Because a sponsor's rent must not depend on the buyer coming back.
  - **A4, escrow, clock start:** the latest of service time, funding and acceptance; funding always counts. Because an old invoice paid late could otherwise be released at once.
  - **A5, escrow, the rest:** README state machine, client (`recoverLateIx`, `sweepRentIx`, `closeUnacceptedIx`, the clock in `terms.ts`), one-time pay links, three new fuzz invariants, the handoff's Escrow section. Because each of those states or checks the rules above.
  - **The refund address is the buyer's associated token account for the escrow's mint** (settled with Carlos in this session's planning). The two instructions anyone may send pay the buyer only there and let the caller create it; endings the buyer signs keep taking any token account the buyer owns. Because two keys recorded at creation fix it, so nothing new is stored, and only a computed address is one a stranger can create.
  - **`mark_funded` may run before the seller accepts** (settled with Carlos in this session's planning). It records the time and nothing else. Because A3's thirty days count from the funding and nothing else could record it for an escrow nobody accepted, and A4's clock takes the later of it and the acceptance, so recording it early starts nothing early.
  - **A6, registry wording:** CLAUDE.md's rule is now "Registration: one proof, one rule: 25 cents in USDC, always; other accepted tokens at the fee set for them."; the handoff's Registration bullet says the same. Because another token's fee is whatever the treasury set at `add_token`, so "25 cents, always" was true of USDC only.
  - **A7, keys, central wallet:** info string `forest.foundation/central/v1`, no profile index, an ed25519 wallet like the profile wallets. Because it must come back from the seed like every other key, and link to no profile.
  - **B1, names:** v1 has only random handles, the host's at creation (under the app's domain) and the foundation's under forest.foundation when a profile is badged; chosen names are v2, sold by auction once there are enough people to make prices real; random names always free. Because a price set before there are enough people is not a real price.
  - **B2, pools and ramps:** features an app offers and a user chooses; any app may offer any provider; Hinkal the first pool candidate, Crossmint the first ramp; nothing about them built into the foundation. Because a user choosing a provider in an app is not the foundation doing it.
  - **B3, receipt weighting:** an index weighs a deal by who said yes; both counts in full; a one-tap payment with no acceptance is real but one-sided until the seller reviews the same deal id; an escrow nobody accepted and nobody paid in full counts for nothing. Because a payment the seller never agreed to is one party's word about a deal.
- **Closed from session 11's "Open":** 1 (A1); 2 (A2); 3 (A3, for a funded escrow nobody accepts; a far deadline is still the sponsor's policy, see Open); 4 (B3); 5 (A4); 6 (A6); 7 (A7); and 8 in part, since the clock's start is now Carlos's rule. From 8, the wallet in the proof's message and the index rule on the declared wallet are still for Carlos to confirm; 9, the placeholder `TREASURY`, stands.
- **Chosen here, not decided (each in `escrow/README.md`'s "Chosen, not decided", 19 to 23, unless said):**
  - **`recover_late` closes the re-created deposit account and sends its rent to the buyer.** It runs with no tokens there too. Not to the caller: the caller could front-run to take rent the buyer's wallet paid. Not to the rent payer: it did not pay that rent.
  - **An unaccepted escrow's last deadline counts from the later of the service time and the observed funding.** That is A4's clock without the acceptance, the only clock start there is before one.
  - **`sweep_rent` runs on an escrow in any state.** A live escrow's lamports are the rent payer's either way.
  - **Appended names.** The outcome `NeverAccepted` is 7. The errors `NotEnded`, `NothingToSweep`, `FundingNotObserved` and `BeforeTimeout` go after the old ones. The events are `NeverAccepted`, `RecoveredLate` and `RentSwept`. `close_unaccepted` emits `NeverAccepted` then `Ended`, not `Closed`, since its account stays. The account's size and offsets are unchanged.
  - **"Open" for a pay link means open or accepted, with the funding not yet observed.**
    - `solanaPayUrl` now takes the escrow account read off the chain; `awaitingPayment` says whether a link may be built.
    - Status `open` alone would have refused an invoice, which is accepted from creation.
  - **B1, beyond the two bullets:**
    - "First come, first served" is dropped from the Names section, since chosen names are auctioned now.
    - The Layers row and `names/README.md` say the same as the bullets.
  - **B2, beyond the new text:**
    - The old gate ("once one is live on mainnet, reviewed, and cleared by a lawyer") went with the old text.
    - The advice that an app using a pool moves round amounts after a random wait, and that a direct move's button says it links the two, is kept.
  - **`keys/SPEC.md`:** the central wallet is a new section 5, so sections 5 to 10 became 6 to 11, as session 4 did for the identity secret.
- **Built:**
  - **`escrow/program/`:**
    - `recover_late`, `sweep_rent` and `close_unaccepted`, 12 → 15 instructions;
    - `Escrow::unaccepted_timeout`, `UNACCEPTED_DAYS`, and the clock start in `state.rs`;
    - `mark_funded` without the acceptance gate, and `accept` keeping an earlier observation;
    - three events (16 in all), the outcome, four errors, and reworded messages for `ClockNotStarted`, `NotAccepted` and `StillFunded`.
  - **`escrow/program/tests-litesvm/`:** 64 tests (51 before).
    - The wire format by hand again.
    - New in `escrow.rs`: late money, the sweep at 696 lamports a byte, both timeouts, the refusals, the early observation, an invoice paid late, and a service time with no observation.
    - New in `adversarial.rs`: redirecting late money or a timeout, a closed never-funded escrow, sweep substitutions and a rent rise, the race with acceptance, and two findings (a century-long step; funding after the last deadline).
    - Session 11's tests for the invoice paid late, stray SOL, the sponsor and one-tap's second payment now assert the new behaviour.
    - The cost test measures the three new instructions.
  - **`escrow/program/trident-tests/`:**
    - The model follows the new clock and the early `mark_funded`.
    - New flows: `recover_late`, `sweep_rent`, `close_unaccepted`, and SOL tips to escrow addresses.
    - Buyers' refund addresses count toward I6.
    - I8 is now "bytes never change, never closes"; I9 to I11 are new, I11 run at the end of every run.
  - **`escrow/client/`:**
    - `refundAddress`, `associatedTokenAddress`, `recoverLateIx`, `sweepRentIx`, `closeUnacceptedIx`;
    - `unacceptedTimeout`, `schedule().closeUnacceptedAt` and the clock in `terms.ts`;
    - `awaitingPayment` and the one-time `solanaPayUrl`;
    - the new outcome and events.
    - 17 unit tests (16 before). The validator test adds a second payment to a paid invoice's address, sent back by a stranger, and a SOL tip swept back to the rent payer.
  - **`keys/`:** `INFO.central`, `centralWallet(seed)` in `src/central.ts`, `SPEC.md` (plain words, a new section 5, the fixed-strings row, the vectors line), `vectors.json` (a `central` object; every existing value unchanged), 3 new tests (30 in all).
  - **Docs:**
    - `CLAUDE.md` (A6);
    - `docs/handoff.md`: the Layers rows for Escrow and Names, Registration, the Escrow section (refund address, clock, acceptance, late money, rent, events, wallets), Deals and evidence, Names, What Soil needs, Open;
    - `escrow/README.md`;
    - `names/README.md`;
    - an "After session 12" section in `docs/decisions/adversarial-review-1.md`, whose session 11 table names two tests renamed here.
- **Learned:**
  - **"Fails before" was checked against session 11's built program:** 22 of the 64 LiteSVM tests fail there, and every program change has at least one of them:
    - `recover_late`: the late-money tests and one-tap's second payment;
    - `sweep_rent`: the sweep tests and the stray-SOL test;
    - `close_unaccepted`: the timeout tests and the sponsor test;
    - the clock: `an_invoice_paid_late_gets_the_whole_silence_period`, `a_service_time_does_not_start_the_clock_before_the_funding_is_observed` and the adversarial invoice test;
    - the early observation: `the_funding_can_be_observed_before_acceptance_and_the_acceptance_keeps_it`.

    The other 42 test behaviour this session did not change. In `keys/`, the new tests fail against the old library (no `centralWallet` export).
  - **The fuzzer reaches everything new and catches two planted bugs.**
    - In 5,000 iterations with metrics: all 34 of the program's own refusals, the four new ones included. `recover_late` landed 1,338 times, `close_unaccepted` 740 (627 of them the end-of-run check sending back every unaccepted escrow), and `sweep_rent` 2,819.
    - With the timeout check taken out of `close_unaccepted`: 2,184 I11 failures, exit 99.
    - With the session 11 clock put back: I7 failures on `cancel_buyer`, `object` and `release_by_silence`, exit 99.
    - Both restored; the rebuilt program is byte-identical.
  - **Long runs, every invariant held:**
    - 40,000,000 flow calls (500,000 iterations of 80) on four threads, 815 seconds, exit 0, seed `aeb99d5a…857b3e`.
    - That build predates a one-line doc comment on `accept`, and the binaries differ in 75 bytes. Anchor's `error!` records source line numbers, and the comment shifted them by one.
    - So the same run was repeated on the committed program: 815 seconds, exit 0, seed `d8df6f01…ceee798e`, the binary's hash checked before and after.
  - **Costs:**
    - `close_unaccepted`, making the buyer's refund address: 31,500 to 45,100 compute units (2 to 3%), 579 bytes (47%).
    - `recover_late`, the refund address already there: 11,700 to 16,200 (0.8 to 1.2%), 578 bytes.
    - `sweep_rent`: 4,290 (0.3%), 251 bytes (20%).
    - The spread is the refund address's derivation. The old instructions moved by at most 21 units.
    - At 696 lamports a byte a sweep returns 2,800,008 of a receipt's 3,111,120 at LiteSVM's rate. At mainnet's 5,080 a receipt made today gets back 1,959,648 once the cuts land.
  - **Anchor 1.2 details:**
    - Its duplicate-writable check covers only account types it writes back on exit. So the buyer sending `recover_late` itself, as buyer and caller at once, is fine.
    - On an existing token account, `init_if_needed` with `associated_token` checks the owner before the address. A stranger's account fails with `ConstraintTokenOwner`; one the buyer owns that is not its standard account fails with `AccountNotAssociatedTokenAccount`.
    - After an ending, `accept` fails loading the closed deposit account before its own `Ended` check.
  - **A sponsor that ends an unaccepted escrow for a buyer with no standard token account pays for that account.** Its rent (2,039,280 lamports at LiteSVM's rate) equals the deposit account's rent it gets back, so it nets nothing.
  - **Hinkal, read about this session:** a blog post (blockeden.xyz, April 19, 2026) says:
    - its privacy wallet went live on Solana on March 16, 2026;
    - shielded use needs an "Access Token" minted after an attestation by a major exchange, a custodian or a KYC provider.

    The page says nothing about audits, or about whether money can leave the pool to an address that holds no token. "Audited" in the handoff is Carlos's word; this session did not check it.
- **Open (for Carlos):**
  1. **Which wallet holds a pool's compliance attestation.**
     - On the central wallet it adds to what the ramp's check already ties to that wallet.
     - On a profile wallet it would put a person next to a profile, which CLAUDE.md forbids.
     - Whether Hinkal lets a pool move money to a profile wallet that holds no token of its own is not known here.
  2. **SOL sent to an escrow's address goes to the rent payer, not to whoever sent it.** That is A2's rule; the program cannot tell stray SOL from rent. Changing it is a program change, only before deploy.
  3. **An escrow funded after its own last cancellation deadline can be sent back at once**, before the seller could accept (`finding_an_escrow_funded_after_its_own_last_deadline_can_go_back_before_the_seller_could_accept`). The money goes to the buyer, so nobody is robbed; the deal lapses. Options:
     - accept it;
     - have the buyer's app refuse to fund such an escrow;
     - a floor on the timeout after funding (a program change, only before deploy).
  4. **A far deadline is still a far wait for the rent payer, funded or not** (`finding_a_sponsor_waits_for_the_last_deadline_even_a_century_away`). The sponsor's policy should cap the deadlines it sponsors.
  5. **Tokens of another mint sent to an escrow's address are not recovered.** They land in the escrow's associated token account for that mint, which nothing signs for. Options: a `recover_late` for any mint (a program change, only before deploy), or accept it.
  6. **The endings the buyer does not sign still pay the buyer at any token account the buyer owns.** These are `release_by_silence`, `cancel_seller`, `arbitrate`, and `close_unfunded` by the seller or the rent payer. CLAUDE.md's "refund address fixed at creation" is fully true only of `recover_late` and `close_unaccepted`. Options: tighten them all to the refund address (a program change, only before deploy), or reword the rule.
  7. **A frozen refund address blocks the two anyone-sent returns.** If the mint's freeze authority (USDC has one) freezes the buyer's standard token account, `recover_late` and `close_unaccepted` fail until it is unfrozen. The buyer can still `withdraw` to any account it owns, but a sponsor's rent waits. Noted, not tested.
  8. **CLAUDE.md's names rule** ("badged profiles only, a random one free per profile, chosen names paid") does not mention v1's host handle under the app's domain, or that chosen names are v2 by auction. It is Carlos's to reword.
  9. **B2 removed the foundation's gate on pools.** Whether an app offering one keeps "reviewed and cleared by a lawyer" is the app's call. The "Before mainnet" lawyer pass lists the ramp referral but not a pool.
  10. **B1 leaves three questions** (in the handoff's Open):
     - when chosen names open and how the auction runs;
     - whether an auctioned name is held for good or renewed, and where its money goes (the handoff's "Don't resurrect" lists recurring foundation revenue);
     - whether a badged profile's active handle moves to forest.foundation by default.
  11. **Still from session 11:** confirm or undo the wallet in the proof's message and the index rule on the declared wallet; the registry's placeholder `TREASURY` blocks any deploy.
- **Not done here:**
  - devnet, a phone, Kora;
  - the paid review and the lawyer pass;
  - the registry's tests, not rerun because no registry file changed;
  - `testsite/dist`'s committed keys bundle, which predates `centralWallet` (its page does not use it; `testsite/build.sh` rebuilds it).
- **Still standing:**
  - From session 10: the vouchers finding, the size of Soil's random wait, and `shapes/`' review lexicon still calling its field `escrow`.
  - From earlier sessions:
    - the market template's `cancellationSteps` and `online-tutors`' default steps;
    - the Solana Pay recipient on a phone;
    - the host's genesis handle, import checks and deactivation;
    - the carrier and Railway for the host;
    - the permutation proof the code tree exists for;
    - the pricing unit in the market file;
    - whether a review points at its post;
    - whether the `markets` validator reuses `validateMarket`;
    - whether a product writes a seed file under the first passkey;
    - the keys tests on Apple, Android and Windows;
    - the devnet placeholder treasury;
    - the handover's real-phone cases;
    - session 3's "not measured here" list.

## 2026-09-23: session 13, handoff rewritten clean, market model

- **Build order:** outside the numbered list; asked for by Carlos. Two parts: `docs/handoff.md` rewritten as one current document, and the two shape changes the market model forces. Nothing deployed anywhere. Neither sealed program changed.
- **Decided (by Carlos; written or built here):**
  - **The handoff is one current document.** It follows Carlos's nineteen sections, with no history and the Markets section in his words. Because it had been patched session by session and read like a diff.
  - **Markets.** A category is a deal shape (home services, freelance work, buy and sell at launch); a market is a trade inside one; a market file suggests and restricts nothing. Because the arbiter, the token, the auto-release days and the cancellation steps are the seller's to set per offer.
  - **The post carries the seller's terms**, and an escrow is created from them. `termsFor` takes an offer's terms; a market file's values are suggestions only.
  - **The market template loses every field that restricts a deal**, keeps evidence types and suggested values, and gains a `category`.
  - **Settled in this session's planning:** a post names its token by mint. Because with no token list in the market file, a symbol has nothing to pin it to a mint. This ends session 2's rule "symbol in records, mint in the market file".
  - **Also settled in planning:** `terms` is optional in the lexicon and required on an offer by the validator. Because a request's terms come from the seller who answers it.
- **Handoff corrected to match code:**
  1. **New issuers.** The Face check row said new issuers "register themselves". In the registry only the treasury adds or removes issuer keys, up to eight per list. The handoff now says an issuer that inserts into the lists needs the treasury to add its key; any issuer can sign credentials. The row's "owns the account holding the list" went too: the lists are the program's accounts, and the treasury decides who inserts.
  2. **Refund address.** The Escrow section said "the instructions anyone may send pay the buyer only there". Only `recover_late` and `close_unaccepted` do. `release_by_silence`, which anyone may send, pays the buyer's excess to any token account the buyer owns, as the other endings do.
  3. **Review.** The handoff said a review points at a deal id and can have no rating. The lexicon requires a rating (1 to 5) and text, and its pointer is `escrow`, the escrow's address. The handoff describes the lexicon, and marks the deal-id pointer and the optional rating as decided, not built.
  4. **Pay link.** The handoff said it points at the deposit address. `solanaPayUrl` names the escrow's address; the wallet derives the deposit account from it.
  5. **Not built, and now marked so, not dropped:** a seed from an existing wallet's signature (nothing in `keys/`), and the host giving a random handle at creation (the host takes whatever handle the DID document names).
- **Also in the handoff, beyond the literal instructions** (each small, each reversible):
  - **Decisions from this log that had never reached the handoff:**
    - evidence weighs, it never rejects (session 2);
    - the first treasury and USDC are program constants, and `init` writes only constants (session 6);
    - one treasury key both receives the fees and turns the dials, and a mint's fee is never read again at `register` (session 7).
  - **"Later", not "v1", for the later circuits.** The old handoff called the zero-knowledge aggregate and the one-seed circuit "v1". But the programs' v1 is the launch version, and `CLAUDE.md` puts the cross-profile proof out of scope for v1. "Later" removes the clash without touching `CLAUDE.md`.
  - **Runs on names places:** Railway, Vercel and Supabase, Solana, Didit, plc.directory and the user's device. "Foundation" and "Theirs" are gone. Names run with the index, since the index serves the page.
  - **Open** now holds the handoff's list plus the questions for Carlos still open from sessions 7 to 12, grouped by area. Chores went to "Build status and order".
  - **Don't resurrect** is grouped by area, with the explanations dropped and the rules kept. One line is added: market files that restrict a deal.
  - **Layout, not wording:** in the Markets section, "Later shapes ... Wellness and health are out." sits under the category bullet, after the three sub-bullets. It is about categories, not buy and sell.
  - **"How work splits"** opens "Build status and order". The one-test note (the seed identical on iPhone and Mac) moved there.
  - **Reasons dropped.** The handoff keeps a reason only where a rule makes no sense without one; the rest stay in this log.
  - **The index's reading rules** from adversarial review 1 are referenced, not stated as decided.
  - **Hinkal is named without "audited".** Session 12 could not confirm the audit.
- **Enforcement of market values on a deal, removed:**
  - `escrow/client`'s `termsFor` refused a mint the market file did not list and an arbiter where `arbiterAllowed` was false. Both checks are gone.
  - `shapes/`' validator refused a post whose token symbol the market file did not list. That check is gone too.
  - Nothing else in the repo reads a market file's values against a deal. The programs never read market files, and the registry uses only a market's name.
- **Chosen, not decided** (the simplest option; each reversible before anything ships):
  - **Names.**
    - The post's block is `terms`, with `autoReleaseDays`, `cancellationSteps` and `arbiter`.
    - The price's token is `price.mint`.
    - The market keys are `category`, `evidenceTypes` and `suggested` (`{ autoReleaseDays, cancellationSteps }`).
    - "Auto-release" is the plain word; the program's name for it stays "silence".
  - **`evidenceTypes` is a list** in place of the single `reviewEvidence` (`escrow` or `none`), because the Markets text says a file lists them. An empty list means none.
  - **`category` and `evidenceTypes` are any slugs.** No fixed list is checked, because a later category is a file, not code, and the validator checks structure only.
  - **Whole hours and whole percents.** The AT Protocol data model has no floats, and a market file follows the post. The client's `stepFromOffer` still accepts fractions.
  - **The arbiter is a key (base58), not a DID.** Parties are keys and the escrow stores a key; a DID would need its profile's declared wallet read at deal time.
  - **The validator checks every step.** In a post's terms and in a market's suggested values, steps must rise strictly and end by auto-release, the same rule as `checkTerms`, so terms that pass can make an escrow.
  - **`suggested` must hold both keys**, and its steps may be an empty list. The `online-tutors` fixture suggests 7 days and no steps; its real steps are still open.
  - **`termsFor` takes no overrides.** The auto-release days, the steps and the arbiter come only from the offer, so `Choices` lost `silenceDays`, `steps` and `arbiter`. A market's values reach a deal only through `suggestedTerms`, which fills a seller's form.
  - **Renamed:** `stepFromMarket` is now `stepFromOffer`, and `MarketStep` is `OfferStep`. `MarketDefaults` became `OfferTerms` and `MarketSuggestions`. The fixture `lenient-market.json` became `restricting-market.json`: its one fault is the removed `arbiterAllowed` key.
  - **The handoff's title date** is today's.
- **Built:**
  - **`docs/handoff.md`,** rewritten.
  - **`shapes/`:**
    - The post lexicon gains `terms` (`#terms`, `#cancellationStep`), and `#price` names `mint` in place of `token`.
    - The validator has seven market keys.
    - It checks a post's terms (an offer carries them), `category`, `evidenceTypes` and `suggested`, and no longer checks market tokens.
    - The examples, both fixtures, the README.
    - 39 tests (33 before).
  - **`escrow/client/`:**
    - `termsFor(offer, choices, now?)`, `suggestedTerms`, `stepFromOffer`, the new types.
    - Both terms tests rewritten, and the validator test built from offer terms. 17 unit tests, as before.
    - The README's "What the app decides", choices 3 and 12 and the table row. The package description and the header comment.
- **Learned:**
  - **The market file's token list held something up.** Posts named their token by a symbol that only the market file pinned to a mint. Removing the list forced the post's price to name the mint, a third shape change the task had not listed; Carlos chose it in planning.
  - **The Solana toolchain installs here.** Solana CLI 4.2.2 came from `release.anza.xyz` without trouble. `cargo build-sbf` built the escrow program in 28 seconds, and the escrow client's validator test passed on a local validator in 7 seconds, with terms built from an offer.
  - **"Fails before":**
    - Against the old validator and post lexicon, with the new examples, 28 of the 39 shapes tests fail. The 11 that pass cover behaviour this session did not change (the other shapes, extra fields, the command line's usage errors).
    - Against the old `terms.ts`, the client test file does not load: `stepFromOffer` is not exported.
- **Open:**
  1. **`online-tutors`' suggested steps**, and each standard market's suggested values. A `markets` repo decision.
  2. **What a category file holds.** The Markets text says later shapes are new category files; no category file format exists yet.
  3. **The index's list of tokens it counts.** It takes over from the market file's token list. Adversarial review 1's index rule 3 ("count a receipt only if its mint is one the market accepts") now points at a list markets no longer carry. The review is a dated report and was left as written.
  4. **The review shape**, decided and not built: a deal-id pointer, and an optional rating.
  5. **`CLAUDE.md` was not changed.** No line contradicts the new handoff. The names line session 12 flagged ("chosen names paid") fits v2 auctions, and "refund address fixed at creation" is true of the address; which endings use it is in the handoff's Open.
  6. **`feepayer/README.md`'s first line** still says the sponsor pays for "any registration that carries a valid proof". Its own body, and the handoff, say only markets in the `markets` repo. Not touched here.
- **Still standing** (chores; the design questions are in the handoff's Open):
  - the keys tests on Apple, Android and Windows devices;
  - the handover's real-phone cases;
  - how the host's five patches rebase;
  - `registry/program/trident-tests/`' stale model;
  - `testsite/dist`'s keys bundle, which predates `centralWallet`;
  - the registry client's validator test, which needs `--test-force-exit`;
  - devnet, Kora, a phone, a face check, the paid review and the lawyer pass.

## 2026-09-24: session 14, Roots, open issuers, no sponsorship in the foundation, reviews optional

- **Build order:** outside the numbered list; asked for by Carlos in five parts. Both sealed programs changed, locally only. Nothing deployed anywhere.
- **Decided (by Carlos; built or written here), one reason each:**
  - **The app is Roots**, renamed from Soil; where a domain is named, "Roots' own domain". Because that is the product's name.
  - **Issuers are open.** Anyone opens a list, pays its rent, owns it, and alone adds or removes its insert keys or closes it; the treasury gates no list and no issuer; lists are never deleted; `init` still opens list 0 with the foundation's issuer key. Because who vouches for a human is a slot anyone must be able to fill, like indexes and apps.
  - **The entry names the list and its owner.** Because an index weighs a badge by who vouched.
  - **Extra vouches ride in the folder**, with no program change: proofs of the same secret against other issuers' lists, checked against their roots on chain. One badge per market per issuer; the market weighs which issuers count. Because the lists' roots are already public, so nothing on chain needs to know.
  - **Nothing in the foundation is built for sponsorship.** The program charges everyone; a sponsor is only a payer who pays for someone else, which the program cannot tell and never needs to. Because Forest builds for people who pay; anything paid on someone's behalf is an outside layer, never in the foundation.
  - **The fee payer is Kora, configured:** it co-signs a person's transaction and charges the network fee in their dollar token. Because people should never need SOL.
  - **The treasury's dials are the accepted tokens and their fees, the handover, and where the rent sweep pays.** Because lists are now their owners'.
  - **Every ending that returns money to the buyer pays only the buyer's standard token account for the mint**, the endings anyone may trigger included. Because then "refund address fixed at creation" is fully true: no ending can send the buyer's money anywhere else.
  - **A review requires only whom it is about;** rating, text and `dealId` (the escrow's address, else 32 random bytes as hex) are optional. Because a review can be as thin as pointing at a person; what is missing weighs less; nothing is refused.
  - **Names are a later feature, not core.** At creation the app gives a folder the random name the folder software requires, under its own domain, and nobody sees it; readable names under forest.foundation come later, paid, random or chosen by auction, after Roots. Because core stays minimal; a name is convenience, not identity; the DID is the identity.
  - **Bring your own key is dropped.** One way in: the passkey makes the seed; the 24 words are the optional backup and the way to carry the seed anywhere, a backup, not a login. Because the words already carry the seed anywhere, so a second way in adds a path to build and secure and nothing a person needs.
  - **Settled in this session's planning (Carlos):**
    - list 0's owner is a new program constant, `FOUNDATION_ISSUER`, not the treasury, so the treasury touches no list;
    - a list's owner is also its first insert key, so an opener inserts at once;
    - `CLAUDE.md`'s three lines are reworded in Carlos's words: Kora as the fee payer service (no sponsorship built in); "the program charges everyone; any payer may pay for someone else; the program cannot tell and never needs to"; "names are a later feature, not core; the DID is the identity";
    - a review's `createdAt` stays required, as on every shape, since the app writes it and the reviewer says nothing by it.
- **Closed by the above:**
  - session 12's open 6 (the endings the buyer does not sign paid any account the buyer owns) and 8 (`CLAUDE.md`'s names rule);
  - session 12's open 10, third question (whether a badged profile's handle moves to forest.foundation by default): no, readable names are later and paid;
  - session 13's open 4 (the review shape, now built), 5 (`CLAUDE.md` unchanged, now changed) and 6 (`feepayer/README.md`'s first line, now rewritten);
  - session 10's standing chore: the review lexicon calling its pointer `escrow`;
  - the handoff's "what handle a new profile carries at genesis": the app's random name under its own domain;
  - session 13's "a seed from an existing wallet's signature, not built": dropped, and in "Don't resurrect".
- **Chosen, not decided** (the simplest option; each reversible before anything ships):
  - **A new list's payer and owner are two account slots, and the owner signs.** Like `register`'s roles; the signature means no list is recorded as owned by a key that did not agree, or that nobody holds.
  - **The owner is appended** to the list account (5,456 bytes after the discriminator become 5,488), to `ListOpened` and to `Registered`, so every earlier offset and field stays. `add_issuer`, `remove_issuer` and `close_list` no longer take the config and check the owner in the handler (`NotTheListOwner`, appended). `init` logs `ListOpened` for list 0 too.
  - **The placeholder issuer key** is derived from the public seed `REPLACE-BEFORE-DEPLOY-issuer-000`, like the treasury's, and is a second deploy blocker (`finding_the_placeholder_issuer_key_is_anyones_key`, deploy checklist step 2).
  - **The endings check the buyer's account by address alone,** not by who holds it. A classic token account can be handed to another key; with its holder checked, a buyer could hand its account away and block the seller's release by silence forever (`a_buyer_who_hands_its_refund_address_to_another_key_cannot_block_the_sellers_release`). `NotTheRefundAddress` is appended. `recover_late` and `close_unaccepted` were left as they were.
  - **A missing refund address is made by whoever sends the ending,** first in the same transaction, the standard idempotent way (`makeRefundAddressIx` in the client). The program makes it itself only in the two instructions that already did.
  - **The escrow client's ending builders take `buyer` and `mint`** in place of `buyerTokens`, and name the refund address themselves, so a caller cannot name another account.
  - **A malformed `dealId` is refused** by the validator (neither base58 of 32 bytes nor 64 lowercase hex): a pointer that points at nothing is broken, not thin.
  - **Roots runs the fee payer instance** in the handoff's foundation-and-product table, because operations are paid in products; the foundation keeps the configuration. The old table had the foundation run a registration fee payer only to sponsor.
  - **`feepayer/README.md` says "none of the person's keys"** where Carlos wrote "holds no keys": Kora signs as the payer, so it holds one key, its own.
  - **`docs/decisions/` still say Soil.** They are dated reports, left as written, as session 13 left adversarial review 1.
- **Built:**
  - **`registry/program/`:** `open_list` for anyone, a list owner, owner-only `add_issuer`, `remove_issuer` and `close_list`, list 0 owned by `FOUNDATION_ISSUER` at `init`, `list_owner` in the entry, `owner` in `ListOpened`. The comments say nothing of sponsors.
  - **`registry/program/tests-litesvm/`:** the harness writes the new format; 44 tests (39 before): five new, `list_0_opens_at_init_owned_by_the_foundations_issuer_key_which_is_its_first_insert_key`, `anyone_opens_a_list_pays_its_rent_owns_it_and_inserts_at_once`, `only_a_lists_owner_adds_or_removes_its_insert_keys_or_closes_it`, `the_entry_names_the_list_and_its_owner`, `finding_the_placeholder_issuer_key_is_anyones_key`; the treasury-dial tests narrowed to the tokens and the handover. The property test's model: anyone opens a list; per-list owners; a new invariant R7 (a list's owner never changes, and only it changes the list's keys or closes it); R6 checks the entry's list and owner.
  - **`registry/client/`:** `openListIx({ payer, owner })`, owner-signed `addIssuerIx`, `removeIssuerIx` and `closeListIx`, `decodeIdentityList().owner`, `RegisteredEvent.listOwner`, `FOUNDATION_ISSUER` and a test that it matches the program; 16 unit tests (15 before). The validator test opens a second list as a stranger, and registers with the fee payer paying SOL and the profile paying the 25 cents.
  - **`escrow/program/`:** `Escrow::refund_address()`; `Settle`, `SettleAs`, `SettleBoth`, `Withdraw` and `CloseUnfunded` take only the refund address as the buyer's account.
  - **`escrow/program/tests-litesvm/`:** the harness gives the buyer an empty standard account and pays every ending there; 67 tests (64 before): `every_ending_that_pays_the_buyer_pays_only_its_refund_address`, `a_buyer_who_hands_its_refund_address_to_another_key_cannot_block_the_sellers_release`, `a_missing_refund_address_is_made_in_the_same_transaction_by_whoever_sends_the_ending`.
  - **`escrow/program/trident-tests/`:** the model accepts an ending only when it names the buyer's refund address and that account exists; most people start with one; a new flow, `make_refund`, makes one the idempotent way.
  - **`escrow/client/`:** the builders above and `makeRefundAddressIx`; 17 unit tests, as before; the validator test makes the refund address in the approval's own transaction.
  - **`shapes/`:** the review lexicon (`subject` and `createdAt` required; `rating`, `text`, `dealId` optional), the `dealId` check, the example, the README; 41 tests (39 before).
  - **Text:** `CLAUDE.md` (three lines, Carlos's words), `docs/handoff.md` (Roots, open issuers, "Everyone pays", the dials, the refund address, reviews, names, keys, build order, Open, Don't resurrect), `feepayer/README.md` (from scratch), `names/README.md`, `registry/README.md`, `escrow/README.md`, `shapes/README.md`, `issuer/README.md`, the root `README.md`, `keys/SPEC.md` (the words are a backup, not a login; the handle example).
- **Learned:**
  - **"Fails before", against the programs as session 13 left them:**
    - registry: `list_0_opens_at_init...` finds list 0 with no owner (the zero key); `anyone_opens_a_list...`, `only_a_lists_owner...` and `the_entry_names_the_list...` stop where a stranger opens a list (`ConstraintHasOne`, the treasury); `two_humans_register...` finds no owner in the entry; `finding_the_placeholder_issuer_key...` stops at the old `add_issuer`, which wants the config first. Without a temporary shim that adds the issuer the old way, every test using list 0 fails earlier still: the old `init` gave list 0 no insert key (`NotAnIssuer`).
    - escrow: `every_ending_that_pays_the_buyer...` shows all eight (`approve`, `release_by_silence`, `agree`, `arbitrate`, `cancel_buyer`, `cancel_seller`, `withdraw`, `close_unfunded`) paying the buyer at another account it owns; `a_buyer_who_hands...` is refused with `ConstraintTokenOwner`, the block the old holder check allowed. `a_missing_refund_address...` passes before and after: it documents the client path, and no program change stands behind it.
    - shapes: the thinnest review is refused (rating and text were required); a malformed `dealId` passes (an unknown field was not checked).
  - **Everything green after:** registry 44 LiteSVM tests and its client's 16 plus the validator test; escrow 67 LiteSVM tests and its client's 17 plus the validator test; shapes 41. The registry property test: 1,000 iterations of 40 flows, 40,000 flows in 39 seconds, every invariant held. The escrow fuzzer: 1,000 iterations of 80 flows, then 20,000 of 80, both ending with exit code 0 under `TRIDENT_WITH_EXIT_CODE=1`.
  - **Costs.** A registration: 830 bytes (legacy; 832 as the client's v0 on a local validator), 133,087 units with the profile paying the fee and 135,528 with another key paying (133,081 on a local validator): 54 units more for the owner in the entry. An identity list is 5,496 bytes: $2.86 of rent today, $0.39 after the cuts, paid by whoever opens it. Every escrow ending now derives the refund address, so it costs about 1,600 to 7,600 units more than session 12's fixed figures and varies with the keys: `approve` with a split 17,000 to 23,000, `release_by_silence` 14,900 to 20,900 (twelve runs each).
  - **An open list is only as honest as its owner.** A list owner can add commitments it made itself and badge them; the registry cannot tell. What stops it counting is the index weighing the entry's list owner, which is why the entry now names it.
  - **The fee payer is also a storage-deposit payer.** In a registration and an escrow's creation the transaction's payer puts down storage deposits, not only the network fee. Unless its price counts them, the fee payer pays them on the person's behalf, which is sponsorship by another name.
- **Open:**
  1. **A list's rent above its minimum sweeps to the treasury,** though now an outside issuer paid it (a code account's already did, though whoever registered paid it). Sweeping to whoever paid means recording the payer: a program change, possible only before deploy.
  2. **A list's owner never changes.** An issuer that moves to a multisig opens a new list and closes the old; its old members stay on the old one. A handover like the treasury's would be one more sealed instruction.
  3. **A frozen refund address now blocks every ending that pays the buyer anything,** not only `recover_late` and `close_unaccepted`, until the token's freeze authority unfreezes it. An ending that pays the buyer nothing (silence with no excess, a full approval with no excess) still runs.
  4. **`recover_late` and `close_unaccepted` still check who holds the refund address** (Anchor's create-if-missing does), unlike the other endings. A buyer who hands it away blocks only its own late money and, in `close_unaccepted`, the rent payer's deposit rent. Making them address-only is a program change.
  5. **Whether Kora's price counts the storage deposit it puts down inside a program call.** Not checked; for the fee payer session.
  6. **Who runs the fee payer instance:** this session's handoff says Roots; Carlos to confirm.
  7. **How an index reads extra vouches from a folder, and how a market file names the issuers it counts.** Neither exists; the market template has no issuers key for badges (only `credentialIssuers`).
  8. **Anyone can open lists without limit,** each costing its opener a list's rent; indexes grow by list. Nothing but the rent bounds it.
- **Still standing** (chores; the design questions are in the handoff's Open):
  - `keys/src/words.ts`, `keys/test-page` and `testsite/` still call the words a "paper export" in an error message and a heading;
  - `host/`' tests were not rerun: the example review they write changed only a field name, and the host does not validate Forest records;
  - `registry/program/trident-tests/`' stale model, and `testsite/dist`'s keys bundle, as before;
  - the keys tests on Apple, Android and Windows devices; the handover's real-phone cases; how the host's five patches rebase;
  - devnet, Kora, a phone, a face check, the paid review and the lawyer pass.

## 2026-09-24: session 15, a list's rent and handover, both programs prepared for devnet

- **Build order:** step 1 of the handoff's "Next" (the devnet deploy), asked for by Carlos in two parts: two registry fixes he decided, then both programs on devnet, exercised for real. Part A is done. Part B is built, scripted and rehearsed end to end on a local validator, and stopped at the deploy: the devnet faucet granted 3.3 SOL in about 3.5 hours, and the deploy needs about 5.37 on the deploy key. Nothing is deployed anywhere.
- **Decided (by Carlos; built here), one reason each:**
  - **A list's spare rent goes to its owner.** `sweep_rent` on a list pays the excess above the rent-exempt minimum to the list's owner; the config and the code tree (and code accounts) still pay the treasury. Because whoever paid the rent gets it back.
  - **A list's owner can hand over,** in two steps like the treasury: `propose_list_owner` (the owner signs, names a key; a later proposal overwrites, proposing nothing clears) and `accept_list_owner` (the named key signs); nothing moves until the new key signs. Because an issuer must be able to move to a multisig or recover from a leaked key without opening a new list.
  - **The handover moves ownership only** (Carlos, in planning): the insert keys stay as they were; a new owner that means to drop the old key removes it itself.
  - **Devnet keys live outside the repo, printed nowhere, and die with the machine** (Carlos, in planning); a later devnet session redeploys with fresh keys and new program ids.
  - **No waiting on Circle's captcha:** a test dollar (6 decimals) accepted with `add_token` pays for the registration and both deals, and `docs/devnet.md` says devnet USDC was not used and why. **SOL:** retry with backoff and smaller amounts; if still blocked, stop, record what was done, and Carlos funds the addresses.
- **Closed by the above:** session 14's open 1 (a list's rent swept to the treasury) and 2 (a list's owner never changes).
- **Chosen, not decided** (the simplest option; each reversible before anything ships):
  - **`pending_owner` is appended to the list account** (5,488 bytes after the discriminator become 5,520), so every earlier offset stays. The events (`ListOwnerProposed`, `ListOwnerChanged`) and errors (`ListOwnerEmpty`, `ListOwnerUnchanged`, `NoPendingListOwner`, `NotThePendingListOwner`, `WrongSweepRecipient`) are appended.
  - **A closed list can be handed over,** because its rent still pays its owner.
  - **The zero key and the current owner are refused as proposals,** as for the treasury.
  - **`sweep_rent`'s third account is the recipient, checked in the handler** (the list's owner, read from the list's own bytes after the address and program checks, or the treasury). A wrong one fails with `WrongSweepRecipient` where it failed with Anchor's `ConstraintAddress`. `RentSwept` is unchanged: the rule decides the recipient, and the transaction names it.
  - **The devnet builds put their keys into a copy of the source** (`devnet/build.sh`): the registry's `declare_id!`, `TREASURY` and `FOUNDATION_ISSUER`, the escrow's `declare_id!`, each checked to appear exactly once, and nothing else differs. The committed placeholders stay, because the tests sign for them, and the program ids must change because Anchor refuses to run at an address other than its `declare_id!` and nobody holds a keypair for either vanity id.
  - **The devnet record is a committed JSON file** (`devnet/devnet.json`, public keys, addresses and signatures only) that the scripts write and the smoke tests read; `docs/devnet.md` is its readable form.
  - **A payer key plays the fee payer in the deals too,** so the parties hold only test dollars.
  - **The client reads a list's members from the log** (`fetchListLeaves`): every transaction that touched the list, its `IdentityInserted` entries written by the registry itself, ordered, gaps refused, and the rebuilt root checked against the list account read first. It reads through the caller's connection.
- **Built:**
  - **`registry/program/`:** the list sweep to the owner; `propose_list_owner` and `accept_list_owner`; `pending_owner`; the events and errors above. A registration measures 133,093 and 135,534 units under LiteSVM (6 more than session 14; the list account is 32 bytes bigger).
  - **`registry/program/tests-litesvm/`:** 47 tests (44 before): `a_lists_spare_rent_goes_to_its_owner_and_everything_else_to_the_treasury`, `a_lists_owner_hands_it_over_in_two_steps_and_only_then_does_anything_move`, `a_second_list_owner_proposal_overwrites_the_first_nothing_clears_it_and_a_closed_list_hands_over_too`. Changed because the rule changed: `a_sweep_leaves_exactly_the_new_minimum` and `sweep_nothing_twice_nothing_missing_and_a_rent_rise_freezes_nothing` swept list 0 to the treasury and now sweep it to `FOUNDATION_ISSUER`; `a_sweep_cannot_be_pointed_anywhere_else` and `a_handover_is_proposed_then_accepted...` expect `WrongSweepRecipient` for a wrong recipient. The harness writes both new instructions and reads `pending_owner`. The property test models handovers (propose, accept, both in one transaction) and pays a list's sweep to its owner of the moment; R2 and R7 restated.
  - **`registry/client/`:** `proposeListOwnerIx`, `acceptListOwnerIx`, `sweepRentIx({ recipient })`, `decodeIdentityList().pendingOwner` (and a refusal of the old length), `decodeIdentityInsertedEvents`, `leavesFromEvents`, `listRoot`, `fetchListLeaves`; 20 unit tests (16 before); the validator test passes on the changed program. `scripts/devnet.ts` and `test/devnet.test.ts` (five read-only smoke tests, `npm run test:devnet`).
  - **`escrow/client/`:** `scripts/devnet.ts` (the two deals) and `test/devnet.test.ts` (three read-only smoke tests). No program change; 67 LiteSVM tests and 17 unit tests, as before.
  - **`devnet/`:** `keys.sh` (fresh throwaway keys outside the repo, a fresh record), `build.sh`, `deploy.sh` (over RPC, upgrade authority kept, deployed bytes checked against the build), `devnet.json`.
  - **Text:** `docs/devnet.md`; `registry/README.md` (lists and their owners, the dials, the checklist, the rent table, costs, chosen items 21 and 22, devnet pointers); `escrow/README.md` (devnet pointers); `docs/handoff.md` (Registry: lists, the dials, the sweep, the treasury; build status; Next; Open).
- **Learned:**
  - **"Fails before", against the program as session 14 left it:** the rent test swept list 1's excess to the treasury, and it landed (`tests/registry.rs:852`); both handover tests stop at the first `propose_list_owner`, `InstructionFallbackNotFound` (Anchor 101), since it did not exist.
  - **Everything green after:** registry 47 LiteSVM tests, its client's 20 and the validator test; escrow 67 LiteSVM tests and its client's 17. The property test: 1,000 iterations of 40 flows, 40,000 flows in 55 seconds, every invariant held (seed 1790230254337997354); 489 proposals and 70 separate accepts landed, and 920 propose-and-accept pairs in one transaction.
  - **Costs.** An identity list is 5,528 bytes: $2.88 of rent today, $0.39 after the cuts. On a local validator at the devnet build's program id a registration took 139,075 units and 832 bytes (v0), the proof 2.8 seconds: the addresses the program derives take other bump seeds under another program id. Deploying costs each program's data account plus, while it uploads, a buffer of the same size: about 3.35 SOL at the peak for the registry (1.67 kept) and 3.69 for the escrow (1.85 kept), at devnet's 5,080 lamports a byte.
  - **The devnet faucet all but refuses a cloud machine.** 5 of 448 requests granted between 06:12 and 09:37 UTC, all through Alchemy's public demo endpoint, 3.3 SOL in all; `api.devnet.solana.com` granted nothing. `faucet.solana.com`, a web page that offers a GitHub sign-in, was not tried from the machine. A devnet session needs its keys funded by a person, or a paid RPC's faucet.
  - **`init` already writes devnet USDC** at 0.25 in a devnet build; there is no step that adds it, and `add_token` would refuse it.
  - **"Whoever paid gets it back" and "the owner gets it" differ when payer and owner are two keys.** List 0's rent is paid by whoever sends `init` and swept to `FOUNDATION_ISSUER`; a list a fee payer pays for sweeps to its owner, who pays the fee payer. The program records the owner, not the payer.
  - **A leaked owner key can race a handover:** until the accept it is still the owner and can propose its own key. Propose and accept in one transaction, both keys signing, leaves no moment between them.
  - **The local rehearsal caught three things before they cost devnet SOL:** the Solana CLI wants a keypair named even to read (with no default keypair on the machine, `solana program show` fails), which stopped the deploy script right after a deploy that had landed, before it recorded anything; a test validator turns on SIMD-0500, which refuses these SBPF v0 builds (devnet and mainnet have it off); and snarkjs keeps a script alive after it is done.
- **Open:**
  1. **Funding a devnet deploy.** Who funds the next session's deploy key (about 5.4 SOL) and payer (about 0.1): Carlos by hand from `faucet.solana.com`, or a paid RPC with a faucet. This session's keys hold 3.3 SOL that nobody can move once the machine is gone.
  2. **SIMD-0500.** Once it activates, SBPF v0 to v2 programs can no longer be deployed. Both programs build as v0. The mainnet deploy either happens first or uses a later SBPF build (`cargo build-sbf --arch v3`), which nobody has tried with Anchor 1.2, groth16-solana and the Poseidon syscall.
  3. **A code account's rent above its minimum still sweeps to the treasury,** though whoever registered paid it. Sweeping it to the payer means recording the payer: a program change, possible only before deploy.
  4. **The phone reads every transaction that touched a list,** registrations included, to find its members. That is fine for a devnet list; a list with many members needs the leaves published somewhere (the issuer, an index) and checked against the root, which the client already does.
  5. Session 14's open 3 to 8 stand.
- **Still standing** (chores; the design questions are in the handoff's Open):
  - `registry/program/trident-tests/`' stale model, and `testsite/dist`'s keys bundle, as before;
  - the keys tests on Apple, Android and Windows devices; the handover's real-phone cases; how the host's five patches rebase;
  - the devnet deploy and run, Kora, a phone, a face check, the paid review and the lawyer pass.

## 2026-09-24: session 18, devnet keys from one phrase; the deploy still unfunded

- **Build order:** step 1 of the handoff's "Next" (the devnet deploy), asked for by Carlos: keys that survive the machine, funding with a person in the loop, then the whole run as session 15 rehearsed it. The first part is done. The deploy did not happen: after 90 minutes the deploy key held 2.0 SOL, and Carlos could not get SOL from faucet.solana.com. Nothing is deployed anywhere.
- **Decided (by Carlos; built here):** every devnet key is derived from one phrase, `FOREST_DEVNET_SEED`, by a standard key stretch with one label per key, so any later session with the same phrase gets the same keys. If the phrase is missing, stop. Wait up to 90 minutes for funding, then commit what exists and stop.
- **Chosen, not decided** (the simplest option; each reversible, since devnet holds nothing yet):
  - **PBKDF2-HMAC-SHA256, 600,000 iterations, salt `forest-devnet:<label>`, 32 bytes, as the ed25519 seed.** The phrase is NFKD-normalised, trimmed, and its whitespace collapsed. Standard in every language, and one primitive, so anyone can reproduce it without this repo.
  - **Four labels beyond the six asked for** (`registry-program`, `escrow-program`, `test-dollar-mint`, `test-dollar-authority`), because the program ids and the test dollar must come out the same too.
  - **Key files in `~/.forest-devnet/keys` by default,** outside the repo. A file there that holds another key is refused, not overwritten, since it may hold test SOL.
  - **`keys.sh` keeps `devnet/devnet.json` as it is** when it already names the derived keys, so a rerun never drops a deploy's record.
- **Built:**
  - **`devnet/keys.sh`,** rewritten to derive rather than generate. It uses Node's crypto only, and no longer needs `solana-keygen`. It prints public keys only. Two runs gave the same keys, and `solana-keygen pubkey` reads the files and agrees.
  - **`devnet/devnet.json`:** the derived keys and this session's faucet record (`airdrops`). No deploy yet.
  - **Both devnet builds,** on session 15's toolchain (Solana CLI 4.2.2, `cargo-build-sbf` 4.1.0, platform-tools v1.54). Same sizes as session 15; new hashes, because the keys are new. They are in `docs/devnet.md`.
  - **Text:** `docs/devnet.md` rewritten for what is on devnet now (keys, cost, faucet, builds, how to rerun, what differs from mainnet); `registry/README.md` and `escrow/README.md` (status and devnet pointers); `docs/handoff.md` (build status, Next 1).
- **Learned:**
  - **The deploy costs one copy of each program, not two: about 3.53 SOL for both, not 5.37.** Solana CLI 4.2.2 funds the upload buffer with the program data's rent and checks only that plus fees. The loader hands the buffer's SOL back to the payer before it funds the program data (`cli/src/program.rs`, `do_process_program_deploy`). Session 15 counted the buffer and the program data both. This comes from reading the source; no devnet deploy has shown it yet.
  - **The faucet: 2 of 62 requests granted, 2.0 SOL, both through Alchemy's public demo endpoint** (16:25 and 16:27 UTC). `api.devnet.solana.com` answered "Internal error" 18 times, then 429 ("airdrop limit … or run dry") 13 times; Alchemy answered 429 29 times.
  - **Every other route is closed to a machine.** faucet.solana.com needs a Cloudflare captcha on every request, which was not attempted. Ankr and Helius need an API key; dRPC has no free devnet; publicnode has no devnet. The devnet proof-of-work faucets (`PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL`, 22 of them) are drained: the two with anything left hold 0.02 SOL or less.
  - **SIMD-0500 is not active on devnet:** its feature account (`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`) does not exist there, so the SBPF v0 builds still deploy.
  - **The toolchain installs here in under a minute,** and both devnet builds take 2.5 minutes.
- **Open:**
  1. **Funding: about 1.8 SOL more to the deploy key** (`2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A`). The 2.0 SOL already there stay usable, since the key comes back from the phrase. Three ways, each needing a person:
     - faucet.solana.com, signed in with GitHub, which raises its limit;
     - anyone who holds devnet SOL;
     - a free Helius or Ankr API key given to the session, whose faucets grant small amounts.
  2. **Anyone who holds the phrase holds the devnet programs' upgrade authority** and every devnet key. That is fine for devnet. The phrase must never be reused for anything on mainnet.
  3. **Whether the devnet builds are byte for byte reproducible** on another machine with the same toolchain: the next session's hashes will say.
  4. Session 15's open 2 to 5 stand.
- **Still standing:** as session 15 listed, with the devnet deploy and run still not done.

## 2026-09-24: plan update, no-clock escrow, open markets, AI-first index, parallel sessions

- **Build order:** asked for by Carlos so five sessions can start in parallel from one plan and one schema: docs, `shapes/` and one skill install. No program code. `escrow/`, `index/` and `registry/` untouched.
- **Decided (by Carlos; written here):**
  - **The escrow has no clock.** Money comes out only when the two sides agree: the buyer releases to the seller, the seller releases to the buyer, or both sign a split. An arbiter and a timer (N days from funding, to one named side) exist only if the creator turns them on. Acceptance, service time, silence, auto-release, objection and cancellation steps are gone; cancellation and refund are the seller releasing, or a split. Reason: the no-clock escrow is what a person expects of holding money.
  - **Anyone can make any market.** A market is a name; the `markets` repo is the directory of recommended spellings, grouped in categories for reading; indexes group aliases; the recommended badge scope is `market/role`. Reason: nothing in the foundation gates a market.
  - With these, and with no reason given beyond them: receipt weighting (a receipt counts fully when the seller created the escrow or reviewed the deal; a one-sided payment is a real receipt, but one-sided; anything else counts for nothing); the AI-first index (the same open pages for people and machines, schema.org data, a JSON twin per page, a sitemap, `llms.txt` and the read skill, one open ranking); sessions in parallel when they own different folders, each logging to `docs/changes/<topic>.md`, then a consolidation session; the safe-solana-builder skill for any change to a Solana program.
- **Chosen, not decided** (the simplest option; each reversible before anything ships):
  - **`timer.days` is a whole number from 1 to 65,535,** the same sixteen-bit bound the old escrow held for its days. The escrow session may change the program's bound; the lexicon then follows.
  - **A market file's `description` is one line of at most 300 characters.**
  - **`credentialIssuers` stays in the market template, required and possibly empty.** The decision named what to keep (name, category, evidence types, extra fields) and what to remove (`suggested`, money, time); `credentialIssuers` was in neither list. Removing it is one line.
  - **`roles` is optional; absent, a market's roles are `seller` and `buyer`** (`rolesOf`, `DEFAULT_ROLES`). A market file may still name its own.
  - **The example post turns on no option,** since every option is off by default, and takes the role `seller`. The example market file names no roles.
  - **Terms stay open, like every record:** a leftover `autoReleaseDays` in an old post passes and means nothing.
  - **No parallel session owns `shapes/`,** so none edits it (added to "Building in parallel", since every session builds on the same schema).
  - **`CLAUDE.md`'s market rule drops "only directory names count in indexes and badges"**, which contradicts "nothing is excluded" and "indexes group aliases"; its intro now says "A market is a name"; and its last line sends a parallel session's log to `docs/changes/<topic>.md`, or it would tell the five sessions to do what "Building in parallel" forbids.
  - **The skill's source is recorded in `.claude/skills/safe-solana-builder/SOURCE.md`:** the repository has no license file and states MIT only in its README, and MIT asks that the notice travel with copies.
  - **The wallets line** ("every profile has its own wallet, plus one central wallet ...; Forest never builds one") went into "Wallets", which already said the rest, not into "Escrow".
- **Built:**
  - **`docs/handoff.md`:** "Escrow" and "Markets" replaced with the decided text; "Who said yes", the post and market file in "Record shapes", the Index row and paragraph, "The shape", "What Forest is", the Registry's scope line, the Layers escrow row, "Wallets", "What Roots needs", build status and "Next" (five in parallel, then consolidation; the devnet deploy still waiting); new "Building in parallel"; Open rewritten for markets and escrow. No mention of acceptance, service time, silence, auto-release, cancellation steps, done marks, unaccepted timeouts or seller consent remains, and nothing says a market is gated, excluded, drafted or activated.
  - **`CLAUDE.md`:** the escrow and market rules, the intro, the skill line, the parallel log line. **`docs/README.md`:** `changes/`.
  - **`shapes/`:** the post's `terms` hold only `arbiter` and `timer` (`{ days, to }`, `to` is `seller` or `buyer`), all optional, on an offer or a request; `cancellationStep` is gone. The market template drops `suggested`, adds an optional one-line `description`, and makes `roles` optional (`seller`, `buyer` by default). The validator checks structure only; everything about steps, auto-release days and "an offer carries terms" is removed. Examples, the fixture, 42 tests (41 before) and `shapes/README.md` updated.
  - **`.claude/skills/safe-solana-builder/`:** `SKILL.md` and `references/` from github.com/Frankcastleauditor/safe-solana-builder at commit `9e94436`, unchanged, without `.git` and `examples/`; plus `SOURCE.md`.
- **Learned:**
  - **A badge scope `market/role` can outgrow the registry.** The registry takes a market name of at most 64 bytes (`MAX_MARKET_NAME`); a market file allows a 64-character name and 64-character roles, so a long pair can never be registered. Nothing refuses it yet.
  - **The escrow client reads what `shapes/` no longer has:** `escrow/client/src/terms.ts` has `suggestedTerms(market.suggested)` and `OfferTerms.autoReleaseDays`. It does not import `shapes/`, so nothing breaks now; the escrow session updates it. `host/`' tests write `shapes/examples/*.json` without validating them, so the new examples change nothing there.
  - **The skill's `SKILL.md` points at `examples/`,** which was not copied; a session using it finds none. It also asks which framework and test tool to use; in this repo both are settled (Anchor 1.2, LiteSVM).
  - `docs/decisions/adversarial-review-1.md` still describes the old escrow (acceptance, silence, cancellation). It is a dated report of what was reviewed and was left as it is.
- **Open:**
  1. **The 64-byte scope:** the market validator refuses a `market/role` pair over 64 bytes, or the registry's bound rises before deploy.
  2. **Escrow gaps the new text leaves** (in the handoff's Open): where money "to the buyer" lands, now that the rule no longer fixes a refund address at creation; whether the arbiter may be a party; where money above the amount goes; who may send the timer's payout.
  3. **Whether a market file keeps `credentialIssuers`.**
  4. **`escrow/README.md` and `index/README.md` describe the old design;** their sessions own them.
- **Still standing:** as session 18 listed, with the devnet deploy and run still not done.

## 2026-09-25: issuer, the parallel session's log

From `docs/changes/issuer.md`, as it was written, folded here by the integration session.

### 2026-09-25: the issuer, face check to list, batched

- **Build order:** step 2 of the handoff's "Next", the issuer flow, asked for by Carlos. It runs on
  a local validator with a stand-in Didit. Nothing is deployed: no real face check, no devnet, no
  Railway.
- **Decided (by Carlos, in planning; built here):**
  - **The issuer also opens the Didit session (`POST /session`).** The task had the app get a session
    id by itself, but opening a session needs the foundation's API key (`POST /v3/session/`), which
    an app can't hold. And the handoff rules out the face check as a product-side service. So the
    service has three routes, not two.
- **Chosen, not decided:** the fourteen in `issuer/README.md`, "Chosen, not decided". The ones that
  matter most:
  - **A random `vendor_data` on every session.**
  - **`POSSIBLE_DUPLICATED_FACE` refuses.**
  - **A refused session is not used up.**
  - **Status is a POST,** so no commitment ever sits in a URL.
  - **Session ids are kept hashed.**
  - **`VACUUM` after every batch.**
  - **One insert per transaction, paid by the issuer key.**
- **Built:**
  - **`issuer/`, a small HTTP service in TypeScript** on Node's built-in HTTP and SQLite.
    - Its one dependency is `@solana/web3.js`, pinned to the registry client's version.
    - `src/didit.ts`: the `FaceCheck` interface, the Didit v3 client, and `judge`, the one rule.
    - `src/store.ts`: two tables that share nothing.
    - `src/list.ts`: the list's members and the insert, through `registry/client`.
    - `src/batch.ts`: shuffle, the triggers, and the rewrite after each batch.
    - `src/server.ts`: the three routes. `src/service.ts`: configuration from the environment.
  - **Tests:** 18 without a chain and one end to end on `solana-test-validator`, all passing.
    - **Without a chain:** the accepted flow; a failed liveness check refused; a duplicate face
      refused (both codes, whether Didit's rules declined it or not); a reused session refused,
      including two requests racing on one session; every other refusal and malformed body;
      batches shuffled (neither arrival order nor the file's key order); both triggers; no double
      insert after a crash; a failed batch keeps the rest queued.
    - **The raw file:** after the batch, the file holds none of 300 commitments in any form, no
      session id in the clear, only the two tables, and no journal beside it. With `secure_delete`
      and `VACUUM` turned off, this test fails.
    - **The Didit client:** tested against a local stand-in answering in the shape of Didit's
      documents.
    - **End to end on a validator:** `init`, the service started from environment variables with
      the real chain client, three people submitted, one batch, and the list's leaves read back
      with `fetchListLeaves` are exactly those three.
    - `registry/client`'s own tests still pass (20 of 20).
  - **`issuer/README.md`:** what the service does and never does, the API, the Didit workflow it
    expects, how to run it, the environment variables, and what Railway will need.
- **Learned:**
  - **Didit's API is version 3.**
    - Fetching a decision: `GET https://verification.didit.me/v3/session/{id}/decision/` with an
      `x-api-key` header. Opening a session: `POST /v3/session/`.
    - A decision carries `liveness_checks[]`, each with its own `status` and `warnings[].risk`.
    - Didit's own documents write the status both as `Approved` and as `APPROVED`.
  - **A duplicate face is a risk code, not a status.**
    - Didit's face search runs inside every liveness step and reports `DUPLICATED_FACE` or
      `POSSIBLE_DUPLICATED_FACE`, meaning the face was "already verified under a different
      `vendor_data`".
    - Its standalone Face Search returns "Approved" for a pure duplicate and leaves the policy to
      the caller. So the issuer checks the codes itself rather than trusting a status.
  - **Deleting a Didit session removes its face from the duplicate search,** and the person can
    then pass again unflagged, under a new secret. A workflow can also turn the face search off
    (`face_search_enabled: false`), and then no decision says "duplicate". The issuer can see
    neither. Both are operating rules in the README.
  - **Didit lets an API key see only its own application's sessions.** A product holding its own
    Didit key could not hand the foundation a session to check, which is another reason the
    issuer opens the session.
  - **Railway's HTTP logs keep every request's client address and path,** for 3 to 90 days by
    plan, with no documented way to turn them off.
  - **Deleting a SQLite row does not remove it from the file.** With neither `secure_delete` nor
    `VACUUM`, 156 of 300 deleted commitments were still readable in the file. Either one alone
    removed them all.
  - **The registry takes the same commitment twice**
    (`finding_an_issuer_can_insert_the_same_commitment_twice`). So a batch re-reads the list first,
    and waits for each insert until its blockhash expires, never less.
- **Open:**
  1. **Losing the seed, against the duplicate check.** The handoff says a person who loses their
     seed gets back on the list with another face check. But that face is already on the list, so
     Didit reports a duplicate and this issuer refuses it, forever. Either the handoff's sentence
     changes, or something decides when a known face may join again. Letting it join again gives
     one human two secrets, so two badges per market.
  2. **A passed check that never reached `/submit`** (the device lost between the check and the
     submit) locks the person out the same way: their face is Didit's, and their session id is
     gone with the device.
  3. **A minimum batch size.** An hourly batch of one person is an anonymity set of one for anyone
     who sees both Didit's session times and the chain. Should a batch wait for at least N?
  4. **Railway's address logs conflict with "no address logs".** The service keeps none, but
     Railway keeps every client address for days. This applies to the host and every other
     Railway service too. It needs a decision: accept it, find a host that does not log, or put
     something in front.
  5. **No rate limit on `/session` or `/submit`.** Anyone can open Didit sessions at the
     foundation's cost (Didit bills per check, beyond a free monthly allowance), and a flood of
     submits spends Didit's decision rate limit.
  6. **Where the issuer key file lives on Railway:** on the volume (every backup then holds it), or
     written at start from a sealed variable. Before mainnet it is the real `FOUNDATION_ISSUER`
     key, not the placeholder.
  7. **A manual approval in Didit's console keeps the duplicate warning,** so the issuer still
     refuses a false duplicate that a person has cleared. Is there a path for a false positive?
  8. **Two face checks by one person at the same moment** may not see each other in Didit's
     duplicate search if neither is approved yet. Didit's documents don't say; ask Didit.
  9. **`fetchListLeaves` reads every transaction that touched the list,** at start and before
     every batch. Fine at thousands of members, not at millions; an index could serve the members
     instead.
  10. **The Didit client is tested against a stand-in built from Didit's documents, not Didit
      itself.** Its first real run should compare a real decision's shape with `parseDecision`.

### 2026-09-25: the issuer, round two: a request limit, and the key from a sealed variable

- **Build order:** a follow-up to the issuer, asked for by Carlos. The first round's pull request
  (#20) was already merged, so this round is a new pull request from `main`, not an update to #20.
  Nothing is deployed.
- **Decided (by Carlos; built here):**
  - **A simple request limit on opening sessions:** per network address, in memory only, never
    written to disk or logs, a few per hour. A refused request gets a plain "try later". It exists to
    stop someone running up the foundation's Didit bill. The README says it resets on restart and is
    not a security boundary.
  - **The issuer key on Railway comes as a sealed variable** (`ISSUER_KEYPAIR`, the key file's
    contents), written at start to a file readable only by the service in a temporary directory,
    never in the repo or the image. `ISSUER_KEYPAIR_PATH` stays for local runs.
  - **No change to batching:** hourly or at 50, shuffled. The proof already hides which entry on the
    list is anyone's, so a minimum batch size adds little. This closes round one's open 3.
- **Chosen, not decided** (the simplest option; `issuer/README.md`, items 15 to 19):
  - **Five sessions per address per hour by default** (`SESSION_LIMIT_PER_HOUR`), in a window that
    starts at the address's first request. Only `/session` is counted, after its body is checked.
    A refusal is `429 {"error": "try_later"}`, and Didit is not asked.
  - **An IPv6 address counts by its /64,** since one device or household usually holds a whole
    /64. An IPv4 address counts alone. `::ffff:`-mapped IPv4 counts as the IPv4 address.
  - **The limit keeps keyed hashes, not addresses:** HMAC-SHA256 under a random key made at start
    and never written. Windows whose hour has passed are dropped once an hour.
  - **The address comes from a proxy's header only when `CLIENT_ADDRESS_HEADER` names one**
    (`x-real-ip` on Railway). Unset, the connection's own address counts and every such header is
    ignored, so a client can't choose its own address where no proxy stands in front.
  - **The key file is deleted as soon as the key is loaded.** Nothing reads it again. The file is in
    a new directory under the system's temporary directory (0700), holding one file (0600). The
    variable is taken out of the process's environment once read.
  - **Setting both key variables is refused,** rather than one silently winning.
- **Built:**
  - **`issuer/src/limit.ts`:** the limit and the address grouping.
  - **In `issuer/src/list.ts`:** `parseKeypair`, whose errors quote none of the key, and
    `writeKeyFile`. `issuer/src/service.ts` and `issuer/src/server.ts` wire both in.
  - **A leak fixed on the way:** a malformed key file used to fail with JSON's own parse error,
    which quotes part of the text it fails on, so a broken key would have printed part of itself to
    the log. Both key paths now fail with a message naming only the variable or the file.
  - **Tests:** three new ones without a chain, 21 in all, and the validator test now runs with the
    key from `ISSUER_KEYPAIR`. All pass.
    - **The limit over HTTP:** three sessions, then `try_later`, with Didit not asked; another
      address unaffected; three IPv6 addresses in one /64 share a count, and the next /64 doesn't;
      a malformed request isn't counted; with no header named, a client's own `x-real-ip` is
      ignored; no address in the log or the file.
    - **The limit's clock:** a fresh share after an hour, stale windows dropped, the /64 grouping.
    - **The key:** from a variable, the file and its directory private to the user and under the
      temporary directory, removed afterwards; malformed keys refused without quoting them; both
      variables refused.
    - **End to end:** on the validator, the service loaded the key from `ISSUER_KEYPAIR`, and its
      file was gone once the service was up.
    - Turning the limit off fails two tests; writing the key file readable by all fails one.
  - **`issuer/README.md`:** "The request limit", the two key variables, Railway's
    `CLIENT_ADDRESS_HEADER`, and items 15 to 19 of "Chosen, not decided".
- **Learned:**
  - **Behind Railway's edge, the connection's address is the edge's,** so a limit that counts it
    would limit everyone together. Railway puts the client's address in `X-Real-IP` (its networking
    documents).
  - **Railway hands sealed variables to builds as well as deployments,** so "not in the image" holds
    only while no build step reads `ISSUER_KEYPAIR`. None does.
- **Open:**
  1. **Shared addresses share one count.** People behind one carrier-grade NAT or one campus address
     get five sessions an hour between them. Whether that is too few is for real traffic to show;
     the number is one variable.
  2. **`/submit` is not limited.** Each submit asks Didit for a decision, which costs nothing but
     spends Didit's rate limit. Its documents give 600 requests a minute per key in one place
     ("Retrieve Session") and 100 decision reads a minute in another (its agent skills).
  3. **The limit's memory grows with the number of addresses in an hour.** One entry each, dropped
     after the hour. Someone with very many addresses could grow it; not measured.
  4. Round one's open 1, 2, 4 and 7 to 10 stand. Its 5 (no rate limit) and 6 (the key on Railway)
     are closed by this round, and its 3 (a minimum batch) by Carlos's decision.

## 2026-09-25: index, part one, the parallel session's log

From `docs/changes/index.md`, as it was written, folded here by the integration session.

### 2026-09-25: index part one, the data, the scores, JSON

- **Build order:** step 5 of the handoff's "Next" (the index), first half, asked for by Carlos:
  - ingest records from a firehose and registry and escrow events from the chain;
  - score uniqueness and trust, each signed twice;
  - serve JSON.

  Pages, the JSON twin of every page, sitemap, llms.txt, the read skill, the badge and pay link, and
  the deploy are part two. Ran in parallel with other sessions; touched `index/` and this file
  only. Nothing is deployed anywhere.
- **Asked for by Carlos, built as asked:**
  - Postgres with plain SQL migrations.
  - Records from the host's firehose, verified against DID documents.
  - Only the programs' own events.
  - Escrow events through one adapter, so the rewrite in progress changes one file.
  - A badge counts only when the profile declares its wallet.
  - Per-issuer weights in a config file: the foundation's list at 1, others at 0.
  - Evidence weights in three classes.
  - Scores never blended, signed with EdDSA-Poseidon and Ed25519.
  - Market aliases in a config file.
  - The endpoints listed.
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing ships):
  1. **Aliases group posts and URLs, never badges.** A badge counts only under the directory name,
     byte for byte (adversarial review 1, rule 2). If aliases merged badges, one human could
     register under two spellings and hold two badges in one market.
  2. **A reviewer's starting weight is its best uniqueness, with a floor of 0.05 for no counted
     badge.** "Weighted by the reviewer's own trust" with "everyone starts at zero" leaves every
     score at zero forever without a seed; the handoff's "an unbadged reviewer's review weighs near
     zero" supplies it.
     - The reviewer's weight is `max(u, 0.05) × (1 + t/(|t|+1))`, iterated to a fixed point
       (tolerance 1e-9, at most 100 rounds).
     - Uniqueness is only an input to how much a review weighs. The two scores are published
       separately.
  3. **Trust is a sum, not an average.** Each review adds `weight × evidence × (rating − 3)/2`, so
     it can go below zero. No rating counts as neutral (0). Self-reviews are ignored.
  4. **Dedupe:** per reviewer and subject, one review per deal id with evidence under it, and one in
     all (the latest) for everything without. Without this, invented deal ids inflate a score for
     free.
  5. **Evidence classes:**
     - paid and accepted (or invoiced): 1
     - one-tap paid, not accepted: 0.5, or 1 once the seller reviews the same deal id
     - withdrawn, never accepted, never paid, or no receipt: 0.05

     "Paid" is a `Funded` event or an ending that paid from a full balance (rule 6: an ending proves
     funding). An escrow in progress that is funded and accepted already counts fully.
  6. **A receipt counts only when the reviewer and the subject are its two parties by their
     declared wallets**, either way round, and its token is in `countedMints` (USDC mainnet and
     devnet). This is the handoff's "the index decides which tokens it counts"; market files no
     longer list tokens.
  7. **Uniqueness combines issuers as `1 − Π(1 − w)`.** Two issuers at 0.5 give 0.75: more than
     either alone, never more than 1. A sum would overclaim; a maximum would ignore a second voucher.
  8. **The weight follows the list owner the `Registered` entry names**, not whoever owns the list
     after a handover.
  9. **A scope is split at the first colon into market and role.** A role must be one of the market
     file's roles to count. Whether scopes carry roles is still the `markets` repo's call.
  10. **Categories come from the market files' `category` field**; there are no category files yet.
  11. **Trust is per profile, not per market**, because a review names no market.
  12. **Score encoding for signing:**
      - Values are in millionths.
      - The Poseidon message is `Poseidon(domain, kind, fieldHash(did), scopeOf(scope), value + 2^63, at)`.
        The scope is the registry's own `scopeOf`, so a later circuit ties a uniqueness score to the
        Semaphore scope of that market's badge.
      - The Ed25519 signature is over a six-line text statement.
      - Both keys come by HKDF-SHA256 from one seed, `INDEX_SIGNING_SEED`.
      - A value that did not change keeps its statement and signatures.
  13. **The index's public keys are served at `/`**, an endpoint not on the list, because without
      them nobody can check a signature.
  14. **Offer order: badged sellers first, then trust, then newest.** Two keys side by side, not one
      blended number.
  15. **An alias URL answers 301** to the directory name.
  16. **Search:** substring match over directory market names, aliases, categories and roles, and
      Postgres full-text search with the `simple` configuration (no language favoured) over live
      offers.
  17. **Full recompute on every change**, debounced by 250 ms, one run at a time.
  18. **Profiles and receipts link by declared wallets.** `/deals/{id}` lists the profiles that
      declare each party's wallet. That is public data the profiles published.
  19. **Not acted on in part one:** identity, account and sync events from the firehose; backfill
      by `getRepo`; photos beyond their CID and type; the unresolved-lock mark (stored as `locked`,
      not weighed).
  20. **The resolver uses plain fetch only when `PLC_URL` is `http://`** (local). Otherwise it keeps
      `@atproto/identity`'s default fetch, which refuses private addresses.
  21. **The index imports `registry/client`, `escrow/client` and `shapes` by relative path**, not as
      packages. Node strips TypeScript types only outside `node_modules`, and those packages are not
      built or published.
  22. **`CHAIN_COMMITMENT` defaults to `finalized`**; tests read `confirmed`.
- **Built** (all in `index/`):
  - **Schema:** `migrations/001_init.sql`: profiles, posts, reviews, credentials,
    chain_transactions (the log archive), badges, escrow_receipts, cursors, review_weights, scores.
  - **Record reader:** `src/records/firehose.ts` (`@atproto/sync` 0.4.10, the host pin's own
    version, with `MemoryRunner` and the cursor in Postgres) and `src/records/store.ts` (the lexicon
    check with `shapes/src/validate.js`, then upsert or delete).
  - **Chain reader:** `src/chain/poll.ts`, which pages `getSignaturesForAddress` back to its cursor,
    archives logs and reads each transaction in one database transaction.
  - **Adapters:** `src/chain/registry.ts` over `decodeRegisteredEvents`, and `src/chain/escrow.ts`,
    **the escrow adapter**, over `decodeEvents`, mapping to the index's own `EscrowFact`.
  - **Scores:** `src/scores/compute.ts` (pure), `sign.ts`, `run.ts`.
  - **Endpoints:** `src/api/routes.ts` (web-standard `handle(Request)`) and `server.ts`
    (node:http). `src/main.ts` runs everything; `src/migrate.ts` only migrates.
  - **Config:** `config/issuers.json`, `aliases.json`, `scoring.json`.
  - **Tests, 20, all passing here:**
    - `test/scoring.test.ts` (8): every evidence class, badge counting, the uniqueness
      combination, dedupe, self-reviews, the fixed point, negative trust.
    - `test/sign.test.ts` (4): both signatures verify; a changed value or another index's keys fail
      both.
    - `test/e2e.test.ts` (1 test, 7 steps), on a local PLC, the host from `host/`, a local
      validator with both programs, and a throwaway Postgres database. It covers three profiles and
      two posts (one under an alias); three real badges on list 0, one for an undeclared wallet;
      a paid deal (open, accept, transfer, mark funded, approve); reviews both ways plus one with a
      made-up deal id; a forged commit refused for its signature next to a genuine one stored;
      scores exactly as the formula gives, with both signatures verified from the served JSON; and
      every endpoint's fields, status codes and cache headers.
  - **Text:** `index/README.md` and `index/SCORING.md`.
- **Learned:**
  - **The firehose consumer does the verification, and does it whole.** A commit for Ana's DID
    signed with Mallory's key reaches `onError` as a `FirehoseParseError`. Its cause is a
    `RepoVerificationError`, "Invalid signature on commit", raised after one retry with a fresh key.
    Nothing from that commit reaches the index's code. Ops whose Merkle proof fails are dropped
    silently.
  - **The payment into an escrow is invisible to a reader that follows the escrow program.** A plain
    token transfer into the deposit address never names the program, so `getSignaturesForAddress`
    on the program does not return it. The index learns the escrow was paid only from `Funded` or
    an ending. That makes rule 6 (an ending proves funding) necessary, not just convenient. The
    test's deal is four escrow transactions, not five.
  - **Two badged people who review each other once converge to 1.618 each** (x = 1 + x/(x+1)). A
    pair reinforces itself; trust is not a count of good deals. Worth a look when Carlos weighs the
    formula.
  - **EdDSA-Poseidon signing is slow in JavaScript: about 88 ms per score**, and verification
    about the same (zk-kit 1.0.4 on this machine, both signatures together). 10,000 changed scores
    take about 15 minutes, inside one database transaction as built. Fine for part one; it needs a
    worker, batching outside the transaction, or a faster library before it has real traffic.
  - **Mixing the clients' copy of `@solana/web3.js` with the index's works** on every path used
    here (instructions, versioned transactions, keys), because web3.js checks shapes, not classes.
    The adapters still turn everything into strings at the boundary.
  - **Timings here:** the end-to-end test takes about 29 seconds, of which about 19 are the three
    registrations (a proof each). The unit tests take about 1 second.
  - **The machine was reset between turns once:** Postgres had to be started again. A later
    session should expect to run `pg_ctlcluster 16 main start` first.
- **Open** (questions for Carlos; not decided here):
  1. **Where the readers run.** The endpoints fit Vercel functions, but the firehose reader holds a
     websocket and the chain reader a poll loop, which serverless cannot keep. Railway, like the
     host and carrier? Part two needs the answer.
  2. **Collusion by real small deals.** Two real people who accept each other's tiny escrows gain
     full evidence each time. Candidates: a minimum amount per counted token, less weight for repeat
     deals between the same two profiles, or both.
  3. **An unbadged profile can claim someone else's wallet** by declaring it, and so be matched to
     that wallet's receipts. It gains at most the 0.05 reviewer floor. The stricter rule, "a wallet
     counts only when a badge proves it", would close it, and would also make an unbadged buyer's
     receipt count as none.
  4. **The trust scale.** A raw sum with mutual reinforcement (the 1.618 above). Whether readers
     need it normalised, or shown as counts beside it, is a part-two question for the pages.
  5. **No rating counts as neutral.** The handoff's "what is missing weighs less" could also mean a
     thin review is a small positive vouch.
  6. **Which tokens count.** Only USDC (mainnet and devnet) is in `countedMints`. Whether the
     treasury's other accepted tokens should count automatically is Carlos's call.
  7. **The issuer weights file names the registry's placeholder `FOUNDATION_ISSUER`.** When the
     registry's placeholder is replaced before mainnet, `config/issuers.json` must change with it.
  8. **Escrow versions.** One escrow program id is read. New deals move to a new version while old
     ones finish on theirs, so the reader needs a list of ids, each with its adapter. After the
     rewrite lands, `src/chain/escrow.ts` is where that goes.
  9. **Backfill and moves.** Only the firehose from cursor 0. A folder imported on another host, or
     history older than the firehose keeps, needs `getRepo` and `verifyRepo`; identity and account
     events (a moved or deactivated folder) are not acted on.
  10. **Signing at scale** (the 88 ms above), and whether the index's signing seed lives in the
      deploy's secrets or a key service.
  11. **The index keeps its own log archive,** but it has only the RPC's word for what the logs say.
      A second RPC to cross-check, or reading the receipt accounts too, is a choice for the deploy.

## 2026-09-25: escrow, the parallel session's log

From `docs/changes/escrow.md`, as it was written, folded here by the integration session.

### 2026-09-25: the escrow rewritten to "Escrow" in the handoff

- **Task,** from Carlos: rewrite the escrow program, its client, tests and fuzzer to the handoff's
  new Escrow section (money in, and out only when the two sides agree; every option off by
  default), using the safe-solana-builder skill, and write its security checklist. One pull
  request. No deploy.
- **Base.** This branch starts from `main` at `77dfeed`. The spec (the handoff's new "Escrow"), the
  skill (`.claude/skills/safe-solana-builder/`) and the post lexicon's new `#terms` are on the
  unmerged `claude/wonderful-dirac-2b7ysa` ("Plan update: no-clock escrow…"), read from there. The
  pull request touches only `escrow/` and this file.
- **Decided (by Carlos, given in the task; written here):**
  - The ways out once funded: `release_to_seller` (the buyer signs), `release_to_buyer` (the
    seller signs), `split` (both sign, any split), `arbitrate` (only if an arbiter was named; it
    signs any split), `timer_release` (only if a timer was set; anyone, once N days have passed
    since funding; everything to the side it names), and `close_unfunded` for a never-funded escrow
    (either party or the rent payer, any time, rent to the rent payer). Everything else is removed:
    acceptance, invoices-as-acceptance, service time, the silence clock, objection and locks,
    cancellation steps, withdraw-before-accept, the unaccepted timeout.
  - Kept: create by either party (a seller-created escrow is an invoice), the deposit address,
    `mark_funded` by anyone, the permanent receipt, `recover_late` to the buyer's standard account,
    `sweep_rent` to the rent payer, classic SPL tokens only, wrapped SOL refused.
  - Carlos's four answers, all toward the fewest rules: money to the buyer always lands in the
    buyer's standard token account for the mint; the arbiter can be anyone, a party included; the
    escrow records an agreed amount for the receipt, but every way out pays out the whole balance
    (releases send all of it, `split` and `arbitrate` divide it by percentage; no amount limits, no
    excess rule); once a timer is due, anyone may trigger it.
  - These answer four of the escrow questions in the handoff's Open (where money to the buyer lands,
    whether the arbiter may be a party, where money above the amount goes, who may send the timer).
- **Chosen, not decided** (the simplest option; each reversible before deploy, each in
  `escrow/README.md`):
  1. **Funded means the live balance covers the amount,** checked by every way out; below it the
     only exit is `close_unfunded`. So a receipt always means the amount was held, and one-tap Pay
     needs no `mark_funded`.
  2. **`mark_funded` records a time and nothing else,** and only the timer reads it. No way out
     records the funding time, so a receipt nobody marked (every one-tap payment) says
     `funded_at` 0.
  3. **A split is in basis points** (`u16`, at most 10,000), the seller's share rounded down.
  4. **The timer is due from the second:** `now ≥ funded_at + days × 86,400`. Days are sixteen bits,
     1 to 65,535, matching the lexicon.
  5. **The buyer's account must exist only when the buyer is paid.** It is checked by address, and
     the token program checks the rest when it pays. So a never-paid escrow closes, and a split of
     everything to the seller runs, with no buyer account at all.
  6. **One `Ended` event for every way out,** with the outcome inside. Six events in all: `Created`,
     `Funded`, `Ended`, `Closed`, `RecoveredLate`, `RentSwept`.
  7. **The escrow records its creator** (buyer or seller), in the account and in `Created`, for the
     index's rule that a receipt counts fully when the seller created the escrow. It replaces
     `accepted_at`.
  8. **`timer_release` names one account,** the named side's: the buyer's by address, a seller's by
     holder and mint, checked in the handler.
  9. **Buyer and seller must differ; no key may be the zero key,** the arbiter's included (the zero
     key means "no arbiter" in the account).
  10. **`close_unfunded` has no wait for anyone.** No deadline exists.
  11. **The pay link takes the deposit account's balance and asks only for what is missing,** and
      refuses once the amount is there: an overpayment is no longer sent back by the program.
  12. **`recover_late` and `sweep_rent` are unchanged** from the last version, with their known limits.
  13. **Seller payouts stay as before:** any token account the seller holds for the mint. Only the
      buyer's rule was decided.
  14. **A fresh layout,** 256 bytes after the discriminator (was 311), fields in a new order, errors
      renumbered: nothing is deployed.
  15. **`overflow-checks = true`** in the program's release profile, and the three features
      Anchor's macros test for are declared, so the build has no warnings.
- **Built:**
  - **`escrow/program/`:** ten instructions (`create`, `mark_funded`, `release_to_seller`,
    `release_to_buyer`, `split`, `arbitrate`, `timer_release`, `close_unfunded`, `recover_late`,
    `sweep_rent`), 24 errors, six events, one `pay_out` and one `end` helper shared by all five ways
    out. The skill's header block. The build is 311,680 bytes (sha256 `88cbc548…e8cf1e` here), with
    no warnings and no stack-frame report.
  - **`escrow/program/tests-litesvm/`:** the harness and the wire format rewritten by hand; 49 tests.
    - `escrow.rs` (20): every way out with exact balances (an overpaid balance, splits at 0, 1,
      5,000, 9,999 and 10,000 basis points, the arbiter as a third key and as either party, the timer
      a second early and at due to each side and at 65,535 days, `close_unfunded` by each allowed
      closer). Every rejection asked for: the wrong signer on each instruction, `arbitrate` with no
      arbiter, `timer_release` with no timer, unmarked, early, or marked in the same transaction, a
      payout to anything but the buyer's standard account (five ways out), a Token-2022 mint,
      wrapped SOL, a double ending (in one transaction and later, with late money there), late money
      forwarded, a sweep never below the minimum. Plus the costs.
    - `adversarial.rs` (27): the attacks from adversarial review 1 that still apply, and new
      `finding_…` tests pinning what the program accepts by design (a short timer the other side
      did not set, each way; an overpayment going to the seller; a part payment closed under the
      buyer; a frozen buyer account; the timer's sender choosing the seller's account; a front-run
      address).
    - `one_tap.rs` (2): create, fund and `release_to_seller` in one transaction, measured, with its
      receipt and rent; a second payment to its link sent back.
  - **`escrow/program/trident-tests/`:** the model and flows rewritten; twelve invariants (I5, money
    leaves only with an authority named at creation, checked apart from the model's own verdict;
    I11, nothing is stuck: every live escrow ends by its parties' signatures at the end of each run;
    I12, a timer never pays early).
  - **`escrow/client/`:**
    - a builder per instruction, plus `payInOneTap`, `transferIx`, `makeStandardAccountIx` and
      `keysOf` / `keysFor`;
    - `optionsFromPost` and `termsFor` from a post's optional `terms` block;
    - `optionsNotAgreed` and `assertOptionsAgreed`, the check before a person works or pays: every
      arbiter or timer they did not set, whose key an arbiter is, and which side a timer favours;
    - `whatDiffers`, the check that an escrow is the one meant;
    - `timerDueAt`, `timerDue`, `payout`;
    - the pay link takes the balance;
    - decoding for the new account and events.
    - Tests: 17 unit tests, and the validator test running three deals (a 70/30 split of an
      overpaid balance, an invoice paid in one tap, a refund before a timer is due) plus late money
      and a sweep. `scripts/devnet.ts` and `test/devnet.test.ts` move to the new deals (an invoice
      paid in one tap; a proposal marked and split 60/40); type-checked, not run.
  - **`escrow/README.md`** rewritten: the state table, costs, what is sealed, what the app decides.
    **`escrow/security-checklist.md`:** every rule in the skill's shared base, anchor and LiteSVM
    references, the high-risk decisions, and fourteen known limits.
- **Measured** (LiteSVM, twelve runs with fresh keys):
  - one tap 42,300 to 63,300 compute units and 691 bytes; 55,800 to 84,300 and 733 bytes with the
    seller's account made in it;
  - `release_to_seller` 10,782 to 10,799; `split` 15,200 to 21,200; `create` 31,600 to 57,200;
  - a receipt's rent 1,991,360 lamports ($0.20) at 5,080 a byte and 272,832 ($0.027) at 696, 279,400
    less than before at today's rate.
- **Verified:**
  - all 49 LiteSVM tests, 17 client tests and the validator test pass;
  - the fuzzer ran 50,000 iterations of 80 flows (4,000,000 flows) in 98 seconds, exit 0, every
    instruction both accepted and refused thousands of times (`timer_release` accepted 2,753 times).
    That binary differed from the final one only in how `Closed` adds its two rents (a checked add
    became a saturating one); 10,000 iterations (800,000 flows) on the final binary, exit 0;
  - mutation checks: dropping the buyer check on `release_to_seller` and moving the timer a day
    early, applied together, failed four LiteSVM tests across two files (the wrong-signer test for
    the first, three timer tests for the second). The early timer alone made the fuzzer exit 99.
    The program was restored and rebuilt after each check.
- **Learned:**
  1. **Anyone can open the address a buyer is about to use.** The address is `["escrow", buyer,
     id]`, and whoever opens it names the seller, so a front-runner can open it as an invoice to
     itself with its own options. No money moves (one tap fails whole, the squatted escrow never held
     anything and the buyer can close it), but an app that pays apart from its own `create` must
     check `whatDiffers` first. The last version had the same address scheme.
  2. **Whole-balance payouts turn the pay link into a money question.** A second tap before the end
     now pays the seller, not the buyer back, so the link asks only for what is missing.
  3. **Anchor 1.2's duplicate-mutable-account check skips `UncheckedAccount`,** so the buyer's
     address-checked account can coincide with the seller's if the buyer handed it to the seller;
     both shares land there, nothing is corrupted. Documented in the checklist (§4), not refused:
     refusing would let a buyer block the arbiter.
  4. **The token program refuses to pay an account that does not exist with `InvalidAccountData`**:
     that is the refusal when a way out pays the buyer and its standard account is missing.
  5. **The program is smaller:** 311,680 bytes against the old devnet build's 363,120. By session
     15's own ratio, its devnet deploy costs about 1.58 SOL rather than 1.8455 (estimated, not
     measured), and `docs/devnet.md`'s escrow size, hash and cost are stale. A clean rebuild here
     gave the same bytes as the build before it.
  6. **The skill asks for a framework and a test tool first;** here both are settled (Anchor 1.2,
     LiteSVM). It asks for a `zz_cu_summary` test; each measuring test prints its own table instead,
     so the numbers do not depend on test order.
- **Open** (each a program change, possible only before deploy, unless it says otherwise):
  1. **Where the seller is paid.** Any token account the seller holds, and for `timer_release` the
     sender chooses which. Should the seller, like the buyer, be paid only at its standard account?
  2. **Whether a way out should record the funding time** when nobody marked it, so every receipt
     says when the money was there.
  3. **The front-run address** (learned 1). Keep the scheme, or derive the address from both parties
     and the id? The second would change every client and index.
  4. **`recover_late` still checks who holds the buyer's standard account** (kept unchanged, as
     asked), so a buyer who hands it away blocks only its own late money.
  5. **Frozen accounts:** a classic mint's freeze authority (USDC has one) can stop every way out by
     freezing the deposit account, or the ways out that pay the buyer by freezing the buyer's.
  6. **SOL and other-mint tokens sent to an escrow's address,** unchanged from before.
  7. **For the consolidation session** (not this session's folders):
     - the handoff's Open has four escrow questions Carlos answered here, and still lists the frozen
       account, SOL and other-mint items;
     - `docs/devnet.md` describes the old deals (accept, object, agree), size, hash and cost;
     - `docs/decisions/adversarial-review-1.md` describes the old escrow;
     - an index reads `creator` where it read `accepted_at`;
     - the handoff's build status still calls `escrow/` "the design before 'Escrow' above was
       rewritten".
  8. **`shapes/` needs nothing:** the client reads the post's `#terms` as the plan update defined it,
     and the lexicon's `timer.days` bound matches the program's sixteen bits.
- **Still standing:** as the plan update listed, with the devnet deploy and run still not done; the
  escrow half of it would now deploy this version.

### 2026-09-25, round 2: whose address, where the seller is paid, where rent goes, "Pay" through a fee payer

- **Task,** from Carlos, after the first pull request merged: four changes to the escrow, each with a
  test that fails before and passes after, every suite kept green; the fuzzer's long campaign on
  the final binary; the costs measured again; the README and checklist updated; `feepayer/`'s local
  test run end to end against the new escrow ("each deposit charged to the person once, every
  refund back to them"), editing that test only where the escrow change broke it. No deploy.
- **Base.** `main` at `6423919` (the plan update, the fee payer and carrier, and the issuer's
  request limit all merged). The pull request touches `escrow/`, this file and
  `feepayer/test/feepayer.test.ts`.
- **Decided (by Carlos, given in the task; written here):**
  1. **Nobody can take someone else's escrow address.** The address is `["escrow", creator, id]`,
     from the key of whoever opens it, and the creator signs `create`. `whatDiffers` goes, since its
     only purpose was that squatting.
  2. **The seller is paid only at its standard token account for the mint,** like the buyer, on
     every way out, the timer included.
  3. **Rent goes back to the person, never to whoever fronted it.** The creator is recorded as the
     rent recipient at creation; the deposit account's rent at every ending, both rents at
     `close_unfunded` and every `sweep_rent` go to that key. The reason: a fee payer fronts the
     deposit in SOL and charges the person for it in dollars.
  4. **The fee payer can sign "Pay":** every client builder that funds in the same transaction
     makes the deposit address first, as its own instruction (the associated token program's
     idempotent create), before `create`. One tap included.
  - These close round 1's open 1 (where the seller is paid) and open 3 (the front-run address), and
    `docs/changes/services.md`'s open 1 (option a) and open 2.
- **Chosen, not decided** (each reversible before deploy):
  1. **The field keeps its offset and changes its name:** bytes 169..201 are `rent_recipient`, always
     the creator's key, where they were `rent_payer`. It is redundant with `creator` plus the two
     party keys, and kept so `has_one` pins it and a reader need not work it out. Whoever fronted
     the rent is recorded nowhere, the `Created` event included.
  2. **`close_unfunded` is the parties' only.** The rent payer lost its right to close, since the rent
     is no longer its own (`NotACloser` for anyone else, the payer included).
  3. **`recover_late` keeps sending the re-made deposit account's rent to the buyer,** not the
     creator: that rent was fronted after the end by whoever paid late, almost always the buyer's
     wallet, not at creation.
  4. **The seller's slot is checked by address alone,** as the buyer's is: `UncheckedAccount` with
     `address = escrow.payout_address()`, the token program checking the rest when it pays. So it
     must exist only when the seller is paid something, and a split of everything to the buyer runs
     with no seller account.
  5. **Two error messages changed** (`NotACloser`, `NotTheSellersAccount`); their codes did not.
  6. **The client:** `escrowAddress(creator, id)`; `creatorKey`, `payoutAddress`,
     `makeDepositAddressIx` and `createAndFund` (the deposit address, `create`, the transfer) added;
     `payInOneTap` is `createAndFund` plus the release; `keysFor` takes an optional creator, not a
     payer; no builder takes a seller account any more; `closeUnfundedIx` refuses a closer who is
     not a party; `rentPayer` is `rentRecipient` in the account and the events. `invoice()` still
     sends `create` alone: it funds nothing.
- **Built:**
  - **The program:** the seeds, the recorded recipient, `has_one = rent_recipient` and
    `close = rent_recipient` everywhere, the seller's slot by address in `release_to_seller`, `split`
    and `arbitrate`, the timer's `to` by address for either side, `check_sellers_account` removed,
    every signature made with the creator's key (`creator_key`). 303,432 bytes, sha256
    `46ea84c2…45cc76`, no warnings.
  - **Tests first.** The harness and the three LiteSVM files were changed before the program. Against
    the round-1 binary (rebuilt from its source: the same sha256, `88cbc548…`), 24 of 51 failed,
    among them the new `the_escrow_address_is_the_creators_and_nobody_can_open_someone_elses`
    (`ConstraintSeeds`: the old seeds are the buyer's), `a_payout_lands_only_at_the_receiving_partys_standard_account`
    ("paid the Seller elsewhere") and `rent_goes_back_to_the_creator_never_to_whoever_fronted_it`
    (the payer recorded, not the buyer); both one-tap tests failed, the old program wanting the payer
    in the rent slot. After the change all 51 pass. The client's one-tap test was written first too: the old `payInOneTap` gave
    three instructions, the first not the deposit address.
  - **LiteSVM, 51 tests:** `escrow.rs` 22 (two new: whose the address is, where rent goes), with the
    closers, the sweep and the payout-address test rewritten for both sides; `adversarial.rs` 27,
    the front-run finding turned into `nobody_can_open_the_address_a_buyer_is_about_to_use`, the
    timer's seller-account finding into `timer_whoever_sends_the_sellers_timer_can_pay_only_its_standard_account`,
    a party handing its standard account away tested for both sides; `one_tap.rs` 2, the deposit
    address first in every one tap.
  - **The fuzzer:** I13 (an escrow's address is its creator's; one `create` in twenty aims at
    another key's address and must be refused); I3 checks rent reaches the creator to the lamport and
    nobody else, the payer named in the rent slot now and then and refused; I5 checks each party is
    paid only at its standard account; the payer, the seller or anyone tries `close_unfunded`; two
    `create`s in three make the deposit address first. Against the round-1 binary it fails at once
    (I7 at `create`, I3 on the recipient).
  - **The client** as above; 16 unit tests (the `whatDiffers` test gone). The validator test's
    buyer and seller hold no SOL, and every refund reaches them: the split's deposit rent to the
    buyer, the invoice's to the seller, the refund's to the buyer, a swept tip to the seller, and a
    sweep named to the payer refused. `scripts/devnet.ts` and `test/devnet.test.ts` follow
    (type-checked, not run).
  - **`feepayer/test/feepayer.test.ts`:** its escrow part rewritten on the new client (see learned
    1): pay, release, one tap, and a third escrow opened and closed unfunded, all through Kora, plus
    a sweep. Its registration part is unchanged.
  - **`escrow/README.md`** and **`escrow/security-checklist.md`** updated: the addresses, both payout
    rules, where rent goes, the new costs, fifteen known limits.
- **Measured** (LiteSVM, twelve runs with fresh keys):
  - one tap, the deposit address first: 39,400 to 52,900 compute units, 701 bytes; with the seller's
    account made in it 53,000 to 71,000 and 743 bytes;
  - `release_to_seller` 11,400 to 14,400 (it now derives the seller's address); `create` 31,600 to
    49,700; `release_to_buyer`, `arbitrate`, the timer, `close_unfunded` and `sweep_rent` 32 bytes
    longer, since the creator is a key those transactions did not otherwise carry;
  - the rents do not change: at 5,080 lamports a byte the payer fronts 3,479,800 in a one tap, the
    buyer gets the deposit's 1,488,440 back in the same transaction, the receipt keeps 1,991,360.
  - Through Kora (`feepayer/`, mock prices, one base unit per lamport): pay charged 4,777,650 for
    4,777,600 spent; the release 10,050 for 10,000; the one tap 4,777,650 for 4,777,600, where the
    fee payer's session measured 2,039,330 over (the deposit it got back, plus 50); the person got 9,846,160 lamports back (three deposit rents,
    one escrow rent, a swept tip) and the fee payer none.
- **Verified:** 51 LiteSVM tests; 16 client tests; the validator test; `feepayer`'s local test end
  to end with Kora 2.0.5; the fuzzer's long campaign on the final binary (`46ea84c2…`): 50,000
  iterations of 80 flows (4,000,000 flows), exit 0, every way out accepted thousands of times
  (`timer_release` 2,772, `arbitrate` 6,048, `close_unfunded` 80,510, `sweep_rent` 48,701).
- **Learned:**
  1. **`feepayer`'s local test was broken on `main`.** It merged after round 1 but was written
     against the escrow client before it (`approveIx`, `OfferTerms`, `rentPayer`), so it could not
     load. Ported here, as the task allowed.
  2. **Refunds now arrive as SOL in a wallet that may hold none.** That works: an empty wallet must
     end at the rent-exempt minimum for an empty account, and every refund but a sweep is larger at
     any rate (165 and 256 bytes against 0). A small sweep into an empty wallet fails until more has
     built up; nothing is lost.
  3. **`throughKora`'s quote is one signature short when the person signs only the payment.** It asks
     for the price before adding the payment instruction, so a sweep (which needs no signature) was
     quoted for one signature and refused ("Required 10000 lamports"). The test sends the sweep from another key instead; anyone
     may. A fee payer client must quote with the payment in place.
  4. **Every escrow step through Kora is charged exactly what the fee payer spends, plus 50
     lamports.** With rent no longer coming back to it, Kora 2.0.5's outflow-only price is right,
     and Kora 2.2's counting of returning rent is no longer needed for the escrow.
  5. **The round-1 build reproduces:** its source rebuilt here gave the same sha256.
- **Open:**
  1. **A party named as the escrow itself** (checklist limit 3): accepted by `create`, and it locks
     the deal's money. Refuse it at `create` (one more check, before deploy), or leave it to the
     app? Not tested.
  2. **Refunds arrive in SOL.** In a fee payer's app the person's wallet holds none otherwise. How is
     it shown or used without saying "SOL": left in the wallet, paid back out at ramp-out, or taken
     by the fee payer as payment (Kora could accept SOL as a paid token)?
  3. **Frozen accounts now include the seller's,** with no way round: the seller can no longer name
     another account. Every way out that pays a party waits while that party's standard account is
     frozen.
  4. Still standing from round 1: whether a way out should record the funding time;
     `recover_late`'s holder check; SOL and other-mint tokens at an escrow's address.
  5. **For the consolidation session** (not this session's folders):
     - the handoff (line 109) says rent above the minimum goes "back to whoever paid it" and that a
       never-funded escrow closes by "either party or its rent payer": now the creator, and either
       party only; its Open (line 226) still lists where money to the buyer lands and "SOL … goes to
       the rent payer";
     - `feepayer/README.md`'s "The deposit, answered: counted, and never given back" and its open
       "The refund gap" are answered: every deposit comes back to the person;
     - `docs/changes/services.md` opens 1 and 2 are closed by this round;
     - an index derives an invoice's address from the seller's key;
     - `docs/devnet.md`'s escrow size, hash and cost are stale (303,432 bytes now).

#### Round 2, one more before merge: a party cannot be the escrow itself

- **Task,** from Carlos, on the same pull request: `create` refuses a party equal to the escrow's
  own address or its deposit address, with a test. This closes round 2's open 1.
- **Built:**
  - **The program:** after the zero-key checks, `create` refuses a buyer or seller equal to the
    escrow account or its deposit account (`PartyIsTheEscrow`, appended as the 25th error so no
    other code moved). Neither can ever sign, so a party named as either could never give, agree or
    be paid, and money paid in could leave only by a way out that pays it nothing. 304,912 bytes,
    sha256 `57e83f6a…36af2c7`, no warnings.
  - **Test first:** `a_party_cannot_be_the_escrow_itself_or_its_deposit_address` (`escrow.rs`): the
    escrow and its deposit address as seller in the buyer's escrow, as buyer in the seller's
    invoice, and once with the deposit address made first in the same transaction (the whole
    transaction reverts). On the round-2 binary (`46ea84c2…`) it failed at its first case, the escrow
    accepted as seller; now it passes.
  - **The fuzzer:** I14. One `create` in twenty names the escrow or its deposit address as the
    party the creator does not sign for, and the model expects a refusal. Against the round-2
    binary it fails at once (`I7 create: model says false, program said true`).
  - **The client:** `createIx` (and so `invoiceIx`, `createAndFund`, `payInOneTap`) throws
    `PartyIsTheEscrow` before building; its test failed first too.
- **Chosen, not decided:** the arbiter is not checked the same way. An arbiter nobody can sign for is
  an option that never runs; the parties can still end the escrow, so nothing is locked.
- **Measured:** the check costs about 40 compute units at `create` (its least, 31,613, is now
  31,652). The table is re-measured on this binary; every other row keeps its least, and the most
  moves only with the keys each run draws.
- **Verified:** 52 LiteSVM tests, 16 client tests, the validator test, `feepayer`'s local test
  through Kora (the same charges: pay 4,777,650 for 4,777,600, the release 10,050 for 10,000, the
  one tap 50 over; 9,846,160 lamports back to the person), and the fuzzer's long campaign on this
  binary, 50,000 iterations of 80 flows (4,000,000 flows) in 109 seconds, exit 0, `create`
  refused 83,560 times and accepted 183,406.
- **Open:** a party key nobody controls in general (a lost key, another program's address, some
  other token account) cannot be told apart, and stays a known limit (checklist limit 3).

## 2026-09-25: fee payer and carrier, the parallel session's log

From `docs/changes/services.md`, as it was written, folded here by the integration session.

### 2026-09-25: the fee payer and the carrier, configured and run locally

- **Build order:** the handoff's "Next" steps 3 (the fee payer's config) and 4 (the carrier's
  config), asked for by Carlos together, in one session that owns `feepayer/` and `carrier/` only.
  Both ran on this machine. Nothing is deployed anywhere: no devnet, no mainnet, no Railway.
- **Decided (by Carlos, in planning):**
  - **The carrier is Bluesky's relay plus Jetstream.** The filter to `foundation.forest.*` is each
    index's subscription parameter, not the carrier's. Chosen over:
    - Tap, which filters on the server but splits its events between connected clients, so it feeds
      one index;
    - the relay alone, with the filter left to the host.

    Because no standard piece filters on the server for more than one subscriber, and nothing custom
    is allowed.
- **Closed by this session:** session 14's open 5 ("whether Kora's price counts the storage deposit
  it puts down inside a program call"). It does (learned 1). What it does not count is the
  deposit coming back (learned 2, open 1).
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing is deployed):
  - **Fee payer:**
    1. **Kora 2.0.5**, the latest stable release, pinned in `feepayer/KORA`. `main` is 2.2.0-beta.8.
    2. **Margin 0.** The charge is the cost, plus the 50 lamports Kora adds for the payment
       instruction. Because nothing inside charges anything but the registry.
    3. **Paid to the fee payer's own token account** (no separate `payment_address`).
    4. **At most 0.01 SOL of deposits and three signatures per transaction.**
    5. **No compute budget program, so no priority fee.** The five programs asked for, and no more.
    6. **No API key or HMAC.** A browser page cannot keep a secret, and every transaction pays.
    7. **The local run prices with Kora's mock**, on a copy of `kora.toml` with one line changed.
  - **Carrier:**
    1. **The legacy Jetstream** (`jetstream-legacy`), not the rewrite. The rewrite archives the
       whole network, backfills every host, and serves nothing until it has.
    2. **Hosts are added by an admin only.** Public `requestCrawl` is off.
    3. **The relay's strict sync checks**, its default.
    4. **`JETSTREAM_LIVENESS_TTL=24h`**, and events kept 24 hours.
    5. **SQLite and files on disk.**
    6. **Both pins are today's latest commits:** indigo `dbcca561…`, jetstream-legacy `8a65de4e…`.
    7. **For the local run only, the host is written into the relay's `host` table.** The admin
       endpoint cannot add a loopback host (learned 8).
- **Built:**
  - **`feepayer/`:**
    - `KORA`, `build.sh` (`cargo install kora-cli --locked`);
    - `kora.toml`: five programs, USDC, margin 0, and the fee payer's key allowed only to fund new
      accounts;
    - `signers.toml` (the key from `FOREST_FEEPAYER_KEY`);
    - `run.sh`, which refuses a key file inside the repo;
    - `test/feepayer.test.ts`;
    - `README.md`, rewritten.
  - **`carrier/`:**
    - `UPSTREAM`, `build.sh` (`go build` of `cmd/relay` and `cmd/jetstream` at the pins);
    - `relay.env.example`, `jetstream.env.example`, `run.sh`;
    - `test/carrier.test.ts`;
    - `README.md`, rewritten.
  - **The fee payer's local run** (about 20 seconds):
    - A validator with both programs and a test dollar at USDC's address. Kora 2.0.5 through
      `run.sh`, its key read from a file path outside the repo.
    - A wallet that never holds a lamport registers once, then pays for two escrows (pay then
      release, and one tap), all in the test dollar.
    - Seven refusals, each with nothing landing and nothing moving.
    - Every balance checked.
  - **The carrier's local run** (about 8 seconds):
    - The host from `host/` and a local directory of DIDs, the relay, and Jetstream, run from the
      two `.env.example` files.
    - A device writes: a genesis; a profile (with a photo) and a post; an `app.bsky.feed.post`; a
      commit holding a second post and a second non-Forest record.
    - An index subscribed for `foundation.forest.*` gets the identity event, the account event, the
      profile and both posts, each exactly as written, and neither non-Forest record. An
      unfiltered subscriber gets all five records.
    - The relay logs no warning and skips no signature check.
    - Both runs passed twice in a row.
- **Learned:**
  1. **Kora's price counts storage deposits, including ones made inside a program call.** It
     simulates each transaction, reads every inner instruction, and counts each System
     `CreateAccount` the fee payer funds. Measured, in lamports:
     - registration: charged 963,570 = network fee 10,000 + code account 953,520 + 50;
     - escrow pay: charged 5,160,450 = 10,000 + escrow account 3,111,120 + deposit address 2,039,280
       + 50.

     A registration paying only the network fee is refused ("Insufficient token payment. Required
     963520 lamports"). The fee payer paid for nobody, in every case.
  2. **Kora does not count what comes back, and the escrow gives the person's deposits to the fee
     payer.** The escrow records the transaction's payer as its rent payer and returns rent only to
     that key. So:
     - when an escrow ends, its deposit address's rent (2,039,280 here; $0.149 on mainnet today at
       $100 a SOL; $0.020 after the rent cuts) goes to the fee payer, though the person paid for it;
     - a one-tap escrow is charged that rent for an address it makes and closes itself. Tested to
       the lamport: the charge minus the cost is 2,039,280 + 50;
     - after the rent cuts, anyone may sweep a receipt's rent above the new minimum to the fee payer:
       $0.196 per escrow made at today's rate.

     Up to about $0.35 per escrow in all. The registration has no such gap: a code account never
     closes.
  3. **Kora 2.0.5 refuses an escrow's "Pay" as the escrow client builds it.** It looks up the
     destination of every token transfer before signing. The deposit address does not exist until
     the escrow program makes it inside `create`, so Kora answers "Account … not found".
     - It accepts an account made in the same transaction only by a top-level associated-token-account
       instruction (`token/token.rs`, `find_ata_creation_for_destination`).
     - Putting `CreateIdempotent` for the deposit address, paid by the fee payer, before `create`
       fixes it, about 10 bytes more. The escrow's `init_if_needed` accepts the account already made.
  4. **Kora's mock prices every mint but devnet USDC and wrapped SOL at 0.001 SOL a token**, about a
     tenth of a dollar's worth. So the local run's test dollar is worth one lamport a base unit, and
     the person starts with 100 of them.
  5. **Kora simulates before it checks anything.** A transaction that fails simulation is refused with
     the simulation's error, not the rule it breaks. The first draft of the "take the payment back"
     refusal failed for lack of tokens before the fee payer policy was reached.
  6. **Kora 2.0.5 reads the key from a path; `main` does not.** Built `--locked`, it uses
     solana-keychain 0.1.0, which reads the variable as a file path first, then as a JSON array or
     base58. `main` uses 1.4.0, which takes the key itself only. Railway, with no files, passes the
     key itself either way.
  7. **`kora config validate` warns three times:**
     - no auth;
     - `allow_create_account`, which is priced, capped at 0.01 SOL and tested;
     - Token-2022's permanent delegate, which cannot arise, since that program is not on the list.
  8. **The relay cannot add a loopback host.** Its reachability check uses a client that refuses
     loopback and private addresses and any port but 80 and 443 (its SSRF guard, with no switch).
     The admin `requestCrawl` for `localhost:2583` answers "host server unreachable". Its WebSocket
     dial skips that guard for plain-http hosts, and the local run writes the host row directly. On
     Railway the relay must reach Forest hosts at their public https addresses, never over the
     private network.
  9. **The relay checks history only from an account's second commit.** It checks the first
     commit's signature only, and logs "not verifying prevData or MST inversion for first commit
     from account" (once, in the test). When it cannot resolve a DID, its code passes a commit on
     with no signature check and a log line (read in `verify.go`, not provoked).
  10. **Jetstream exits after 15 seconds with no new event**, expecting to be restarted, and trims
      its store on the same clock. Fine for Bluesky's whole network; for a new one it means
      restarts every quiet minute. Hence 24 hours.
  11. **Jetstream splits a commit into its records**, so a commit holding a Forest record and
      another record delivers the Forest one alone to a filtered index.
  12. **Toolchain here:**
      - Solana CLI 4.2.2 from `release.anza.xyz`;
      - Kora 2.0.5 in about 12 minutes of Rust;
      - the relay and Jetstream in about 5 minutes, Go fetching the 1.26 toolchain itself;
      - `host/build.sh` in about 10 minutes.

      All four built at once on four cores. Nothing needed was blocked.
- **Open:**
  1. **The escrow's rent goes to the fee payer, not the person** (learned 2). The fix must land
     before the escrow deploys, and these three are the options:
     - (a) **An escrow program change:** a rent-refund key, the buyer's wallet, recorded apart from
       the key that funds the rent, so every close and sweep pays the person.
     - (b) **An outside refund:** whoever runs the fee payer hands back what returns to it. Custom
       code in a product, and trust.
     - (c) **Accept it:** say the deposits are the fee payer's. That contradicts "nothing inside
       charges anything".
  2. **The escrow's one tap through a fee payer needs the deposit address made at the top**
     (learned 3). `escrow/client` has no builder for "Pay" and its tests compose it without that
     instruction. The escrow session or Roots adds it. Not changed here: not this session's folder.
  3. **Priority fees.** With the compute budget program off the list, no transaction carries a
     priority fee, and under congestion one may land late. Allowing it lets the person set one and
     pay for it: Kora's price includes it. Keep the five programs, or add the sixth?
  4. **Kora 2.2, once stable.** It hardens the fee payer against being drained, counts a closed
     account's rent coming back (which may close half of open 1), and no longer reads the key from a
     path. Read, not run.
  5. **A payment address apart from the fee payer's key**, so the dollars it collects sit under a
     colder key.
  6. **Who runs the fee payer, and its operations loop.** Someone must keep SOL on its key and turn
     collected dollars back into SOL. With margin 0, anyone who makes and then closes an account
     they own gets SOL at the price source's rate: the fee payer is a SOL seller at the oracle, with
     no margin for the oracle's error. The handoff has Roots run an instance; Carlos to confirm
     (session 14's open 6).
  7. **"Forest records only" is the index's filter, and "registered profiles only" is nobody's.**
     Neither piece can do either without custom code. Options:
     - the index filters both, reading the registry itself;
     - or the host refuses records outside `foundation.forest.*`, which makes the relay's stream
       Forest-only at the source, and verifiable. That is a host change, for the host session.
  8. **The relay passes a commit unchecked when a DID stops resolving** (learned 9). Accept, or have
     indexes that must be sure read the relay's own stream and check signatures themselves.
  9. **Who decides what a Forest host is.** Now an admin adds each one. A list the foundation keeps?
     Open `requestCrawl`, leaving the rest to the indexes' filters?
  10. **A relay admits 100 active folders per host by default.** Raise it per host, or list trusted
      hosts, before any host grows past that.
  11. **jetstream-legacy has had no commit since April 2026.** If Bluesky retires it, the rewrite
      (or Tap per index) replaces it.
- **Still standing:** nothing is deployed anywhere, and the handoff's "Before mainnet" list stands.
  The lawyer pass it names covers the fee payer.

## 2026-09-25: index, part two, the parallel session's log

From `docs/changes/index-2.md`, as it was written, folded here by the integration session.

### 2026-09-25: index part two, pages for people and machines

- **Build order:** step 5 of the handoff's "Next" (the index), second half, asked for by Carlos.
  The same data as open pages, for people and for machines, with no login anywhere. Ran in parallel
  with other sessions; touched `index/` and this file only. Nothing is deployed anywhere.
- **Asked for by Carlos, built as asked:**
  - **Pages for people,** rendered on the server as plain HTML with no JavaScript: home
    (categories), category, market (offers, sellers ranked), profile, deal (the receipt). No crypto
    words anywhere a person reads.
  - **For machines:**
    - schema.org JSON-LD on every page;
    - a JSON twin of every page at the same URL with `.json`, linked from the page;
    - `sitemap.xml`, and a `robots.txt` that allows everyone;
    - `llms.txt`;
    - the read skill at `/skill.md`.
  - **The badge shown plainly** ("Verified real person, one per market", and who vouched), and a
    **Pay link** on every offer in one documented format (`index/PAYLINK.md`).
  - **The split for hosting:** readers and pages as two processes on one database, documented for
    Railway and, for the pages, Vercel (`index/HOSTING.md`). No deploy.
  - **The tests listed:** every page renders, the JSON-LD validates, each twin matches its page,
    the sitemap lists every page, the skill's URLs resolve, and no banned words.
- **Found on `main`, and fixed here because part two stands on it:**
  1. **Part one did not fit the escrow that merged after it (#22).**
     - `src/chain/escrow.ts` no longer type-checked.
     - An ended deal made the chain reader write `to_timestamp(NaN)` and stop.
     - Every real payment scored "nobody said yes", because the accept step is gone.

     Asked mid-session whether to fix it here; **Carlos chose to fix it here.**
  2. **Part one crashed on the current market file.** `online-tutors.json` no longer lists
     `roles`, and `badgeScope` and `/search` called `roles.includes` on undefined. A unit test
     already failed on `main`. Fixed with shapes' own `rolesOf` (seller and buyer when absent).
  3. **Part one split a badge scope at `:`.** `CLAUDE.md` and `shapes/README.md` recommend
     `market/role` (`online-tutors/seller`). Now only `/`. Never both, since two spellings are two
     codes, so two badges for one human in one market.
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing ships):
  1. **The pages own the bare paths; part one's JSON moved to the `.json` twins.** The spec puts
     the twin at the page's URL with `.json`, and part one's JSON sat at those URLs:
     - `/` became `/index.json`, which also carries the public keys;
     - `/categories` folded into `/index.json`;
     - `/markets/{m}/offers` folded into `/markets/{m}.json`;
     - `/profiles/{did}/reviews` folded into `/profiles/{did}.json`.

     Nothing called them.
  2. **One model per page.** A data function returns an object; that object is the twin, and the
     HTML is rendered from it. That is what keeps the twin and the page from saying different
     things.
  3. **Evidence under the rewritten escrow is the handoff's words, literally.**
     - Paid and created by the seller (an invoice): 1.
     - Paid and created by the buyer: 0.5, or 1 once the seller reviews the deal.
     - Not paid: 0.05.
     - "Paid" is a funding mark or any ending, since every way out needs the full amount.

     A split (both sign) or a release back to the buyer (the seller signs) is not read as the
     seller saying yes; see Open 1.
  4. **The Pay link is an https link at the index:**

         {PUBLIC_URL}/pay?v=1&offer=<at-uri>&cid=<cid>&price.amount=…&price.mint=…&price.per=…[&terms.arbiter=…][&terms.timer.days=…&terms.timer.to=…]

     - Every parameter after `cid` is the post record's own field, by its path.
     - The parameters come in one fixed order, and unknown ones are ignored.
     - **No seller key, on purpose.** The app reads it from the seller's profile, so a forged link
       cannot redirect money.
     - The link checks against the record by `cid`.
     - A browser shows the terms, an app can take the link, and an AI can parse it.
     - The handoff's "one-time Solana Pay link naming the escrow's address" is the next step, after
       an escrow exists; the escrow client makes it (`solanaPayUrl`, `invoice`). Both are in
       `PAYLINK.md`.
     - The link shows only on a live offer whose profile names a key.
  5. **JSON-LD shapes:**
     - A profile is a `ProfilePage` about a `Person`, or a `LocalBusiness` when a live offer names
       a place. Its offers are `Offer`s of a `Service`, priced with `UnitPriceSpecification`.
     - Reviews and the rating are nodes of their own, with `itemReviewed` pointing at the
       profile. schema.org's `review` and `aggregateRating` do not take a `Person`.
     - A market is a `CollectionPage` with an `OfferCatalog`.
     - A deal is a `PayAction`. `MoneyTransfer` does not take `recipient`.
  6. **`AggregateRating` from trust alone, on 1 to 5, as `3 + 2·t/(|t|+1)`.**
     - It uses the same curve the reviewer weight uses.
     - `reviewCount` is the counted rated reviews.
     - `ratingExplanation` says it is not an average of stars.
     - With no counted rated review there is no rating.
  7. **How the pages show the scores:**
     - Trust as its number, with the counts beside it ("1.62 · from 2 reviews, 1 backed by a
       payment"). This answers part one's open question 4 for now.
     - Uniqueness as a percentage on each badge.
     - The two are never on one line as one number.
  8. **Money:**
     - A new `config/currencies.json` maps a token to a currency for display (USDC mainnet and
       devnet as `$`, 6 decimals).
     - Any other token shows as "a price in a currency this index doesn't show", with no number.
  9. **Dates** are `en-GB` in UTC ("5 Sept 2026"), the same for every reader. The pages are in
     English only.
  10. **`noindex` pages:**
      - search results, pay links, and deals with no receipt;
      - these are open to all but kept out of the sitemap;
      - the sitemap is one `urlset` (fine under 50,000 pages).
  11. **The web process holds no seed.** The readers write the public keys to a new `index_meta`
      table when they start; the pages read them.
  12. **Processes:**
      - `node src/main.ts readers | web`, or both with no argument.
      - `PUBLIC_URL` is an origin (default `https://forest.foundation`).
      - `llms.txt` and `skill.md` are written for forest.foundation and served with `PUBLIC_URL`
        in its place.
  13. **The read skill's profile, deal and Pay link examples are the test data's fixed ids.**
      Nothing is live, so the only real URLs are local ones. The skill says so.
  14. **Validating against schema.org means its vocabulary.**
      - The vocabulary is release 30.1 (sha256 pinned), cut to classes, properties, domains,
        ranges and enumeration members: 190 KB in `index/test/schemaorg/`, with the script that
        makes it.
      - The check is strict: every type is a class, every property's domain takes the node, and
        every value fits the range.
      - It does not check any search engine's own rich-result rules.
  15. **Banned words, checked in each page's visible text and shown attributes:** wallet, USDC,
      chain, blockchain, gas, crypto, token, Solana, mint. The read skill (for machines) names
      Solana in its "check it yourself" parts, and tells agents not to say those words to people.
  16. **An empty search's twin answers with no results** (part one's `/search` answered 400), so
      every page has a twin.
  17. **Profile photos are not shown.** Only the blob's id is kept; see Open 7.
- **Built** (all in `index/`):
  - **Pages:**
    - `src/web/`: `data.ts` (page models, with part one's queries moved in), `pages.ts`,
      `html.ts`, `words.ts`, `jsonld.ts`, `paylink.ts`, `pay.ts`, `machine.ts`, `routes.ts`, and
      `server.ts` moved from `src/api/`. `src/api/` is gone.
    - `skill.md`, `llms.txt`, `PAYLINK.md`, `HOSTING.md`.
  - **Readers and pages:** `src/main.ts` starts the readers, the pages, or both. The config gains
    `PUBLIC_URL` and `CURRENCIES_FILE`, and the seed is optional for the pages.
  - **Escrow fit:**
    - `src/chain/escrow.ts` maps `Created` (with `creator`, `arbiter`, `timer`), `Funded`,
      `Ended` and `Closed`, and ignores `RecoveredLate` and `RentSwept`.
    - `src/chain/poll.ts` stores them.
    - `migrations/002_pages.sql`: receipts gain `creator`, `arbiter`, `timer_days` and `timer_to`,
      and lose `accepted_at` and `locked`; plus `index_meta`.
    - `src/scores/compute.ts` and `run.ts`: the evidence rule above.
    - `SCORING.md`: the evidence table, the `market/role` scope, and how the pages show scores.
  - **Tests, 29, all passing here:**
    - `test/scoring.test.ts` (8, evidence rewritten for the new escrow, `/` scopes and default
      roles) and `test/sign.test.ts` (4).
    - `test/pages.test.ts` (1 test, 8 steps) over `test/fixture.ts`: part one's story (Ana, Ben,
      Cleo; two offers, one under an alias, one with a timer; three badges, Cleo's for an
      undeclared key; one invoice paid in one tap; three reviews) written into a fresh database.
      Records go through part one's own `applyRecordOp` and scores come from the real recompute.
      It checks all six things asked for, plus the Pay link's round trip and its `check`
      (`matches`, `changed`, `differs`, `notFound`, `invalid`).
    - `test/e2e.test.ts` (1 test, 7 steps), moved to the new escrow client and the twins. Ana
      invoices Ben; Ben pays and releases in one transaction. The scores are the same as part
      one's (Ben 1.618, Ana 1.618 − 0.0025); both signatures verify from the served JSON; the
      receipt says `creator: seller`, `releasedToSeller` and no funding mark. **Run here**, not
      only type-checked.
  - `npm run check` is clean (it failed on `main`).
- **Verified:**
  - `npm test`, 29 of 29, three full runs after the last fix; about 30 s, 19 of them three
    registration proofs.
  - The page tests alone, 15 runs in a row.
  - Readers and pages as two separate processes on one database: the readers wrote the keys, and
    the pages, holding no seed, served them in `/index.json`.
  - The vocabulary extractor, run against the network, gives the vendored file byte for byte.
- **Learned:**
  - **Parallel sessions can break each other through the merge order.** Part one merged against
    the old escrow client; the escrow rewrite merged after it. Nothing ran the index's
    type-check, so `main` carried an index that didn't compile. Each package's own check isn't
    enough; the consolidation session (or a CI job) should run every package's `check` after each
    merge.
  - **pg's pool resolves `end()` before its sockets close.** A test that then drops its database
    `with (force)` sometimes kills a closing connection, which reports an error nobody listens for:
    about 1 run in 12 here. Waiting for `pg_stat_activity` to empty first fixed it (15 of 15). Part
    one's end-to-end test had the same race; fixed the same way.
  - **schema.org has no rating or review on a Person.** `itemReviewed` takes any Thing, so
    standalone `Review` and `AggregateRating` nodes are how a person-to-person marketplace says it
    in valid schema.org. `recipient` is not a `MoneyTransfer` property; `PayAction` has it.
  - **The whole end-to-end test runs on a fresh machine of this kind** (setup not timed) after:
    - the Solana CLI 4.2.2 from Anza's installer;
    - `cargo build-sbf` for both programs. The escrow build came out at 311,680 bytes, the size
      the escrow session logged;
    - `host/build.sh`;
    - `npm run fetch` for the proving files.
  - **Node's `en-GB` dates now write "Sept",** not "Sep".
  - **An invoice paid in one tap is two transactions** the index sees (the create, then
    pay-and-release), and no funding mark: the ending alone proves the payment.
- **Open** (questions for Carlos; not decided here):
  1. **Does a seller's signature on the way out count as the seller saying yes?** A split needs
     both signatures, and a release back to the buyer is signed by the seller. Today, on a
     buyer-created escrow, both still count half until the seller reviews, because the handoff
     names only "created the escrow or reviewed the deal".
  2. **The 1 to 5 rating made from trust.** Is putting trust on schema.org's scale acceptable, or
     should machines get only the raw trust and counts? It is trust alone, never blended with
     uniqueness.
  3. **Address logs at the hosting platforms.** The index logs no visitor address, but Railway's
     HTTP logs and Vercel's request logs are the platforms' own. What they record about a visitor,
     and whether it can be turned off, was not checked, and must be before any deploy ("No address
     logs").
  4. **Which apps open a Pay link.** An https link at forest.foundation opens in a browser. For an
     app to take it directly, the domain must list that app (Apple's and Android's app-link files),
     much like the passkey's related-origins file. Which apps the foundation lists, and on what
     rule, is Carlos's call. Until then, a person opens the link in their app by hand.
  5. **The index claims forest.foundation's root.** The pages live at `/`. The passkey's
     `/.well-known/webauthn` (related origins), and any app-link files, must be served by the same
     deployment or routed around it.
  6. **Languages.** "Global from day one" and English-only pages. Which languages, and whether a
     page follows the reader's browser or its own URL.
  7. **Photos.** A profile's photo is a blob on its own host. Showing it means linking to that host
     (which then sees each visitor's address) or the index fetching and serving it. Not shown yet.
  8. **A plain `market` badge and `market/role` badges both count.** One human can hold
     `online-tutors`, `online-tutors/seller` and `online-tutors/buyer`: three badges in one market.
     Should a plain `market` scope count when the market has roles? This is the `markets` repo's
     call, or Carlos's.
  9. **Scale:**
     - a profile page lists every review;
     - the sitemap is one file;
     - offers are ranked with correlated subqueries;
     - every page is computed per request behind a 30-second cache;
     - the pool is 10 connections, where a serverless instance wants 1 (HOSTING.md).

     All fine at test size; each is later work.
  10. **The read skill's examples are test data.** Swap them for real ones once a real market has
      profiles.
  11. **The market page's "verified real people" count includes buyers' badges.** It counts every
      counted badge in the market, not only sellers'.
  12. **Part one's open questions stand,** except the trust scale (Open 4 there), answered for now
      by showing counts beside the number.

## 2026-09-25: integration, everything tested together, automatic checks, plan up to date

- **Build order:** asked for by Carlos once the five parallel sessions (escrow, issuer, fee payer and carrier, index parts one and two) had merged: run every package together and fix what broke, add automatic checks, make his small decisions, fold the logs, and bring the handoff in line with the code. One pull request; no deploy. Touched `index/`, `shapes/`, `testsite/`, `names/`, `docs/`, `feepayer/README.md`, `keys/SPEC.md`, `CLAUDE.md` and a new `.github/`; the two programs, their clients, the issuer, the host and the carrier are unchanged.
- **Decided (by Carlos; built here):**
  - The index counts badges only under market names in the `markets` repo's directory, read from that repo and never copied, and groups posts with that repo's alias table; its own alias list goes. Badges under any other name carry no weight in it.
  - Only `market/role` badges count; a plain `market` badge counts for nothing.
  - A seller's signature on a split, a refund or an invoice counts as the seller saying yes, fully.
  - `remote` is optional on posts.
  - The escrow's `create` refuses a party equal to the escrow or its deposit address: already built by the escrow session (`PartyIsTheEscrow`), so nothing changed.
  - `testsite/`: the handover experiment goes, its idea dropped; the keys page stays. `names/README.md` is one line. `docs/devnet.md`'s escrow numbers are marked stale.
  - A lost seed cannot rejoin the same issuer's list; the 24 words are the only backup.
  - What is next (devnet; services online; the full loop on devnet by script; an independent AI attack pass on both programs; then Roots) and the mainnet checklist (real keys, placeholders replaced, the newer program format, the attack pass, the entity owning the Didit account and the domain, sealing). Asked in planning, Carlos kept the paid review, the lawyer pass and the three devnet markets in the checklist too.
- **Everything run together.** On one machine (4 cores, Solana CLI 4.2.2, Node 22.22, Postgres 16, Kora 2.0.5, the host and carrier at their pins), on the merged `main` (`d49b7ab`) and again after the fixes:

  | Package | What ran | Result |
  |---|---|---|
  | `shapes/` | tests | 43 pass (42 on `main`, plus the `remote` test) |
  | `keys/` | type-check, tests | clean, 30 pass |
  | `registry/program/` | `cargo build-sbf`; 47 LiteSVM tests; the property test at 200 iterations | 329,136 bytes; 47 pass; 8,000 flows, every invariant held |
  | `registry/client/` | type-check, 20 unit tests, the validator test | clean, all pass |
  | `escrow/program/` | `cargo build-sbf`; 52 LiteSVM tests; the fuzzer at 2,000 iterations | 304,912 bytes, sha256 `57e83f6a…36af2c7`; 52 pass; 160,000 flows, exit 0 |
  | `escrow/client/` | type-check, 16 unit tests, the validator test | clean, all pass |
  | `issuer/` | type-check, 21 tests, the validator test | clean, all pass |
  | `host/` | `build.sh`, `test.sh` | upstream's 58 and 97 pass, Forest's 7 pass |
  | `carrier/` | `build.sh`, the local run | passes |
  | `feepayer/` | `build.sh`, the local run through Kora | passes; the charges the escrow session measured, to the lamport |
  | `index/` | type-check; unit, page and end-to-end tests | **broken on `main`**; after the fix clean, 34 pass, nothing skipped |

  Not run, on purpose: both clients' `test:devnet` (nothing is deployed on devnet, so they fail by design) and the registry's Trident fuzzer (it cannot run; `invariants.rs` stands in for it).
- **What broke, and why:**
  1. **The index did not type-check or pass end to end against the escrow client.** Its end-to-end test called `releaseToSellerIx({ keys, sellerTokens })`, and escrow round 2 took the seller's account out of every builder, since the seller is paid only at its standard account for the mint. The test never made that account, so on `main` the release failed with `InvalidAccountData`, and the scoring and page steps after it failed too (three of seven steps). Why: index part two (#25) merged before escrow round 2 (#26), each green on its own, and nothing ran one against the other. Fixed in the test: it makes Ana's standard account (`makeStandardAccountIx`) before the release, which now takes only the keys.
  2. **The fee payer's test did not break:** escrow round 2 had already ported it. Its README did: it still said the deposits went to the fee payer and that the escrow client could not make the deposit address first. Both were fixed by round 2; the README follows the code, with this run's numbers.
- **Chosen, not decided** (each reversible, since nothing ships):
  1. **The index reads the directory from raw files:** `directory.md` from `MARKETS_URL` (default `https://raw.githubusercontent.com/foundationforest/markets/main`; a commit in place of `main` pins it), then each market file it links. GitHub's API is rate-limited per address without a key, and both it and the tarball endpoint answer 403 from this session; raw files answer.
  2. **A market counts when `directory.md` lists it** and its file validates at `<category>/<name>.json` under the same name. A file the page does not list counts for nothing.
  3. **The Aliases table is read the way the markets repo's `check.sh` reads it.**
  4. **A file that cannot be fetched stops the index's start;** a file that fetches but is not valid is refused and reported, and the rest count. So a network failure never drops a market quietly.
  5. **Read once, at start,** like the index's other configuration.
  6. **A plain-market badge is not counted with its own reason, `noRole`,** so the page says why ("registered for the market without a side").
  7. **The seller's signature is read from the ending:** `split` and `releasedToBuyer` count fully; `arbitrated`, `timerReleased` and `releasedToSeller` on a buyer-created escrow stay one-sided until the seller reviews.
  8. **A post with no `remote` is stored with `remote` null** (`index/migrations/003_remote_optional.sql`); the twin says null and the page shows no place.
  9. **The tests' markets repo is a stand-in** in `index/test/markets/` (one market, `online-tutors`, and its aliases), served over local HTTP, so the tests read it through the same fetch as the real one.
  10. **The checks:** one workflow, `.github/workflows/checks.yml`. On every pull request and push to `main`: each Node package's type-check and fast tests (shapes, keys, both clients, the issuer), the index's type-check, unit and page tests on a Postgres service, and both programs built with their LiteSVM tests. Nightly and by hand: the three validator tests, the fuzzers' long campaigns (the registry's 1,000 iterations, the escrow's 50,000), and the host, carrier, fee payer and index end to end. The LiteSVM tests run on every pull request: they need no validator, and they are the sealed programs' main check; they took about 5 and 2.5 minutes here with other builds running. A skipped test fails its step. The actions are pinned to their newest major versions.
  11. **The logs were folded as they were written,** each under a dated heading for its topic, one level down, without their notes to the folding session.
  12. **`CLAUDE.md`'s Kora line** says the fee payer charges the network fee and any storage deposit it puts down, as the handoff and `kora.toml` do; read alone it made the deposits a sponsorship.
  13. **`testsite/dist/` rebuilt,** which also refreshes its stale keys bundle.
- **Corrections to the handoff, where it disagreed with the code:**
  1. Layers, carrier: the relay serves every record on the hosts it reads, and each index keeps Forest's types; "carries registered profiles only" is nobody's.
  2. Layers, index: the readers run on Railway (a websocket and a poll loop cannot run on Vercel); the pages on Railway or Vercel; one Postgres. The badge and pay link run with the pages.
  3. Layers and the fee payer: it charges the network fee and every storage deposit it puts down, with no margin, not the network fee alone.
  4. Escrow: the address is the creator's, each side is paid only at its standard account, rent goes back to the creator, a never-funded escrow is closed by a party only, funded means the live balance, every way out pays the whole balance, and a party cannot be the escrow. The handoff said rent went back to whoever paid it and that the rent payer could close.
  5. Who said yes: anything else weighs near zero (0.05 in the index), not nothing.
  6. Reputation: trust is over the reviews a profile received, not given and received.
  7. Issuers: an index weighs which issuers count (the foundation's by its issuer weights), not the market; how a market could name its issuers stays open.
  8. The index: it reads the relay's own stream and checks every signature itself; it does not read Jetstream. Its Pay link is an https link at the index naming the offer; the Solana Pay link naming the escrow's address comes from the escrow client once an escrow exists.
  9. The carrier, index, fee payer and issuer were "planned"; all are built and tested locally.
  10. Build status: `escrow/` is the program "Escrow" describes; `testsite/` has no handover page; the devnet deploy needs about 3.2 SOL at the escrow's present size, not 3.53 (an estimate from its size).
  11. Keys: a lost seed cannot rejoin the same issuer's list (the handoff said a new face check puts the person back); the 24 words are the only backup. `keys/SPEC.md` said the same and is corrected too.
  12. Open: dropped as answered, whether Kora counts a deposit made inside a program call (it does), the four escrow questions Carlos answered in round 1, whether the markets validator reuses `shapes/`' (its `check.sh` runs it), what a category page holds (a heading and a paragraph in `directory.md`, and the index's category page), and where the index's readers run.
- **Built:**
  - `index/`: `src/markets.ts` (`Directory.fetch`, `parseDirectory`, `market/role` only), `src/config.ts` (`MARKETS_URL`; `MARKETS_DIR`, `ALIASES_FILE` and `config/aliases.json` gone), `src/main.ts`, `src/scores/compute.ts` (`noRole`; seller-signed endings), `src/web/words.ts`, `src/records/store.ts`, `src/web/data.ts`, `migrations/003_remote_optional.sql`; `test/markets.test.ts` (4), `test/markets-repo.ts`, `test/markets/`; `test/scoring.test.ts` (9), `test/fixture.ts` and `test/e2e.test.ts` on `market/role` badges, a post with no `remote`, and the escrow client's builders; `README.md`, `SCORING.md`, `HOSTING.md`, `skill.md`.
  - `shapes/`: `remote` optional in the post lexicon, a test, `README.md`.
  - `.github/workflows/checks.yml`, checked with actionlint 1.7.12.
  - `feepayer/README.md`, `keys/SPEC.md`, `testsite/` (handover removed, `dist/` rebuilt), `names/README.md`, `docs/devnet.md`.
  - The five logs folded above; `docs/changes/` keeps a one-line `README.md`.
  - `docs/handoff.md` as above, with one Open list; `CLAUDE.md`'s Kora line.
- **Learned:**
  - **Merge order broke the index twice:** part one against escrow round 1, part two against round 2. Each pull request was green alone. The workflow runs every package on every pull request from here.
  - **The escrow build reproduces byte for byte:** 304,912 bytes and sha256 `57e83f6a…36af2c7` here, the escrow session's own on another machine of this kind.
  - **The carrier and the index were built toward different streams.** The carrier session put Jetstream in front for indexes; the index reads the relay's stream with Bluesky's consumer and checks every signature itself, which is the stronger of the two.
  - **The real directory:** 18 markets in three categories and 62 aliases, all read and valid through the index's new loader. `online-tutors`, the tests' market, is an alias of `tutoring` there.
  - **The `markets` repo recommends `market:role` with a colon,** following index part one's colon; the plan, `shapes/` and index part two use the slash, and the foundation's index counts only the slash.
  - **Node's TAP summary reads `# skipped 0`,** which is what the workflow checks.
  - **A post with no `remote` stopped the index's store** on its `not null` column; no record could have one until this change.
- **Open** (new here; the whole list, deduplicated and tagged, is the handoff's Open):
  1. The `markets` repo moves to `market/role` with a slash, and its `check.sh` checks that every file is listed in `directory.md`. *Mechanical,* in that repo.
  2. Whether the carrier keeps Jetstream, now that the foundation's index reads the relay's stream. *Needs Carlos.*
  3. The index refreshes the directory on a timer, not only at start. *Mechanical.*
  4. The workflow's first runs on GitHub's machines, and the nightly jobs' first run after merge. *Mechanical.*
  5. `keys/` and its test pages call the 24 words a "paper export". *Mechanical.*
- **Still standing:** nothing is deployed anywhere; the devnet deploy key holds 2.0 SOL of about 3.4 needed.

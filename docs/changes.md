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

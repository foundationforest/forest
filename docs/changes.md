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

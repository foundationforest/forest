# Forest: foundation handoff (September 14, 2026)

This is the plan for the `forest` repo. Claude Code reads `CLAUDE.md` and this file at the start of every session. Nothing is shipped. One test has passed: a passkey-derived seed, identical on iPhone and Mac. Every choice has its because so it can be challenged. When something here turns out wrong, change it, and say what changed in `docs/changes.md`.

## How work splits

- A chat with Carlos decides: stress tests, searches, anything that isn't code.
- Claude Code builds: one repo per session, one task per session, plan mode first. Bad at "should we" questions; leave those as open items in `docs/changes.md` instead of deciding them.
- Carlos does what only he can: accounts, passwords, money, the entity, the first sellers.

At the end of every session, append to `docs/changes.md`: what was built, what was learned, what is now open. Never edit this file to mark design as done.

## What Forest is

An open environment where a person owns their profile, their offers and their reputation, and can transact with strangers with no platform in the middle. One human, face-checked once. Profiles are free folders, one per market. A market is a text file. Any AI can read the records and, through one connection, act in them.

One sentence: one human, one record, any market, no one in between.

Why it works: accountability. You can't start over (one human, one badge per market). Evidence exists (a verified human staking their own reputation on a review, with the escrow receipt underneath). Nobody can erase it (signed records in your own folder, indexed by anyone). The foundation supplies accountability. Products get you paid.

Why now: four capabilities became cheap in about three years, all needed: unique human without a state (face liveness plus dedupe as an API), keys normal people can hold (passkeys), money a program can hold legally at zero marginal cost (stablecoins), a reader that needs no interface (AI agents). Global from day one; nothing is region-specific.

## The shape

A passkey unlocks a seed on the device. The seed derives, per profile, a control key, a signing key, a Solana wallet, and a permanent name (a DID). Each profile has a folder of signed records on a host that stores but never signs. A carrier (the AT Protocol relay) passes records to indexes; indexes rank and serve pages any AI reads. A registry on Solana gives one verified human one badge per market without revealing who. An escrow on Solana holds money between strangers. A foundation name service gives badged profiles a readable name under forest.foundation. Products are thin apps on top; the first is Cabin.

## Keys, profiles, badges

Three rungs of one ladder. There are no accounts anywhere.

1. **A key.** From a passkey (the default) or from any existing wallet (sign one fixed message, derive the seed the same way every time). With a key you can pay, and pay into escrow.
2. **A profile.** A folder with a DID. Free, unlimited, no chain. Needed before a badge. Reviews live in profiles, so a review needs one; an unbadged reviewer's review weighs near zero.
3. **A badge.** Face once, then one registry entry per market. Reviews carry weight both ways.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Keys recipe | Passkey secret (WebAuthn PRF) to seed, seed to per-profile keys, wallet and DID. Seed file format for extra passkeys (seed encrypted under each passkey's secret, stored under a random label). Paper export format. The passkey belongs to forest.foundation; products are listed in `/.well-known/webauthn` (related origins), Cabin first | Ours: a spec and a small library from existing parts | User's device |
| Folders | One per profile: profile, posts, reviews, credentials, photos, all signed on device | AT Protocol lexicons and libraries, unchanged | A host |
| Host | Stores folders, serves the live feed, never holds a signing key, accepts client-signed commits. Candidate: Vow (a keyless PDS, experimental). Else the smallest fork of a standard PDS's write path | Configured or forked, decided after evaluation | Products (Railway) |
| Directory | Public cards: name, current key, current host | did:plc, run independently; we keep a replica | Theirs |
| Carrier | Subscribes to hosts, verifies signatures, carries registered profiles and Forest record types only | AT Protocol relay, configured | Foundation (Railway) |
| Index | Reads the carrier, scores, serves category pages, profile pages, a machine endpoint. Open algorithm. Signs scores with a ZK-friendly signature (EdDSA over Poseidon) alongside the normal one | Ours | Supabase and Vercel, at forest.foundation |
| Registry | Sealed program: list of verified humans, one code per (human, market), one numbered code per human, free dials, the 25-cent rule | Ours; Semaphore circuit unchanged, groth16-solana verifier, Poseidon syscall | Solana |
| Fee payer, registrations | Sponsors any registration that carries a valid proof, rate-limited. No vouchers, no tokens, no custom code | Kora, configured | Foundation (Railway) |
| Escrow | Sealed program per version: holds a plain SPL token between two keys; releases on approval, timeout, agreed split, or optional arbiter | Ours | Solana |
| Face check | Once. Passive liveness plus dedupe. Foundation runs it as the first issuer and owns the account holding the list; Didit holds the faces. New issuers register themselves | Didit | Theirs |
| Issuer flow | Face check result to identity commitment to list insert | Ours, small | Foundation (Railway) |
| Names | `handle.forest.foundation` serves the profile page and resolves to the DID. Badged profiles only; one per human (see Names) | Ours, small | Foundation |
| Badge and pay link | On forest.foundation, so they outlive any product. Pay link is a Solana Pay URL to the escrow's deposit address | Ours, in the index | Foundation |

## Foundation versus product

Rule: a piece that only works if everyone shares one is a public good and goes in the foundation; anything someone needs to compete with us is in the foundation; money flows and interfaces are products. Code open in the foundation; operations paid in products.

| Foundation (open) | Cabin (first app, replaceable) |
|---|---|
| Record shapes, market template, markets directory | The app page: unlock, profiles, posts, reviews, signing, escrow buttons, AI permissions |
| Keys recipe, seed file format, paper export | Hosting an instance of the host; seed-file store |
| Registry, escrow, host software, carrier, index, ranking, registration fee payer, names, issuer | Fee payer for everything else (fund, release, send) |
| Badge and pay link on forest.foundation | Ramp link-out (exchange instructions and a prefilled ramp page in v0; Onramper when an entity exists) |
| | The door: an MCP server that holds no keys and forwards signing to the app |

Repos: `foundationforest/forest` (all foundation code, Apache 2.0) and `foundationforest/markets` (files, CC0). The product org holds `cabin`. Names: Forest at forest.foundation; Cabin at its own domain.

## Registry (the detail that matters)

- **List.** Each verified human adds one identity commitment (made on their device) to a Merkle tree the issuer key can insert into. Hashing must match Semaphore's circuit exactly (Poseidon; the syscall exists on Solana).
- **Proof.** Semaphore's current circuit, unchanged, with its public trusted-setup files. We write only the Solana side: verifier glue (groth16-solana), the tree, the codes, the rules. No new circuit in v1.
- **Registration.** One transaction carries: the market name, the profile's DID, a market code (proof with scope = market name), and a numbered human code (proof with scope = "badge-k"). The program checks both proofs, that neither code is used, and that "badge-(k-1)" exists (or k = 1). Then it records everything. The number k is public; identity is not.
- **Free dials.** Numbers 1 through N are free; N and an end date are settings the treasury key can change. N = 5 now. After that the program takes 0.25 in an accepted dollar token from the profile's wallet in the same transaction. The amount is sealed.
- **Accepted tokens.** USDC always (sealed, so registration can never be halted). Others added by the treasury key, restricted to dollar stablecoins pegged one to one.
- **Scopes are generic.** "handle" is a market like any other (see Names). Standard category names live in the `markets` directory; the program accepts any scope, and only directory names count in indexes and badges.
- **Sponsor.** The foundation's Kora sponsors any registration transaction; the proof is the anti-spam; Kora's rate limits handle junk. Cost per registration is the network fee plus storage.
- **Sealed per version.** The upgrade key is removed after deploy. A v2 is a new program; migrating the list costs, so v1 must be right. First sellers use v1 on devnet before mainnet.
- **Later, same data.** A v1 circuit proves "exactly N badges whose scores sum past T" without naming any. Non-inclusion of "badge-(N+1)" is what makes "none hidden" provable. Design the storage so codes sit in a Merkle tree that can be proven against (Light's compressed accounts, or a plain tree).

## Escrow

- Parties are Solana keys. A profile's wallet is a key; a Phantom wallet is a key. The program never knows about DIDs.
- Each escrow has its own deposit address, fundable by a plain transfer from anywhere. The program checks "balance at least the amount," never "exactly." The refund address is set at creation to the buyer's key.
- Modes: fixed, per unit, capped. Silence rule: release to the seller after N days; if the buyer objects, locked until both agree; an unresolved lock marks both. Optional arbiter per market file.
- v1 accepts classic SPL Token mints only (no Token-2022 extensions). Because a transfer fee, a permanent delegate, or a transfer hook changes what "hold X, release X" means, and a sealed program can't be patched.
- Sealed per version. New deals use the newest version; old deals finish on theirs.
- Moving money between profiles links them on chain. Options for users: one main wallet (default, linked), fund a profile directly from an exchange, or a third-party shielded pool by link-out. Forest never builds or embeds one.

## Reputation

- Two scores per profile, never blended: uniqueness (which issuers vouched) and trust (open algorithm over reviews given and received, weighted by the reviewer's own trust). Everyone starts at zero; a badge means real and accountable, not good.
- Per human, three tiers: public linking (a signed record in each profile pointing at the others; the user's choice), private disclosure to one buyer (the seller's app signs "these profiles are mine" with each profile key, encrypts it to the buyer's key, and shows that "badge-(N+1)" doesn't exist; the buyer checks the chain; disclosing to a buyer is disclosing), and a v1 ZK aggregate.
- The index signs every score with a ZK-friendly signature from day one so the v1 circuit never needs an expensive signature check.

## Record shapes and markets

Four shapes, shared by every market: profile (name, photo, contact, what I do, declared wallet), post (direction, market, role, description, price block, availability, location or remote, optional expiry), review (about whom, rating, text, escrow pointer), credential (a W3C verifiable credential, issuer DID, one copy per profile). Nobody issues credentials yet; the shape exists so nothing changes when they arrive.

A market file adds: standard name, roles, extra fields, allowed escrow settings and default timeouts, review evidence rule, accepted credential issuers, accepted tokens. Market files add fields, never new shapes. First example: online tutors (per-unit escrow). Three real markets are still open; candidates are online services. Category pages publish at a density threshold.

## Names

- `carlos.forest.foundation` is the profile page and the AT Protocol handle (it resolves to the DID through `/.well-known/atproto-did`).
- Only badged profiles. One per human: "handle" is a market in the directory; a registration in it lets that DID claim one name. First come, first served. The foundation never judges disputes.
- Price is a treasury dial, $1 or zero. Any app or host claims names through the same open endpoint; the UI is theirs.
- Profiles without a name are reachable by DID on forest.foundation.
- Built after the index, since the index serves the page.

## What Cabin needs from the foundation

The keys recipe as a library; the host image or fork; the fee-payer config pattern; the record shapes and validator; the registry client (build a proof on the device, submit through the foundation's fee payer); the escrow client; the names endpoint. Cabin adds only its page, its host instance, its seed-file store, its fee payer, ramp links, and the door.

## Build order (one session each)

1. `shapes/`: the four lexicons, a validator, one example record of each.
2. `markets` repo: the template, its validator, the directory file, the online-tutors example.
3. `keys/`: the recipe spec, the library, the seed file format, paper export, tests on Apple, Android, Windows.
4. `registry/` feasibility check, report only: Semaphore's circuit and setup files as is; tree hashing match; two proofs plus the numbered code inside one transaction's compute budget; storage cost per badge, plain versus compressed.
5. `host/` evaluation, report only: Vow as is, or the smallest fork.
6. `registry/` v1 on devnet.
7. `escrow/` v1 on devnet.
8. `issuer/`, `carrier/`, `feepayer/` configs.
9. `index/` with badge and pay link.
10. `names/`.

Meeting points, in order: issuer flow (face check to registry entry); carrier and index with badge and link; escrow with the silence rule; names; the door (in Cabin).

Done when one stranger, with their own USDC, completes verify, register, post, get found, get paid, get reviewed, alone.

## Before mainnet

The foundation entity (a UK company limited by guarantee; forms before the first stranger's real face or the first grant application). One paid review of the two programs and the key handling by someone who has shipped Solana programs. One lawyer pass over the escrow program, the fee payer, the ramp referral, and biometric data responsibility. Three markets with sellers who ran the loop on devnet.

## Open

Which three markets. Whether the 25 cents funds anything given free numbers. Per-mode timeouts as market defaults. Whether one stablecoin holds for EU users. Which ramps accept a prefilled link with no partner account. Whether a moved passkey keeps its PRF secret (the design assumes not). Whether the registry should also emit an attestation other Solana apps can read (parked).

## Don't resurrect

Chain posts; a Forest-written folder standard; the chain debate; issuer-assisted recovery in v0; a Forest-invented name system (names are AT Protocol handles under the foundation domain); ten free tokens; vouchers and blind tokens for registration; custom code inside Kora; Mercury; Bridge; Stripe Atlas; Ramp Network direct; Transak in v0; a UK Ltd in v0; Meld; the registry as a service for other apps; recurring foundation revenue; manifesto-first; three long pages as the product; Semaphore contracts deployed unchanged; the face check as a product-side service; the cross-profile proof as v0; a per-human score that links profiles without the user choosing; user accounts anywhere; address logs; Commerce Kit; Private Channels; Mexico as a default for anything.

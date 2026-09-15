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

A passkey unlocks a seed on the device. The seed derives, per profile, a control key, a signing key, a Solana wallet, and a permanent name (a DID). Each profile has a folder of signed records on a host that stores but never signs. A carrier (the AT Protocol relay) passes records to indexes; indexes rank and serve pages any AI reads. A registry on Solana gives one verified human one badge per market without revealing who. An escrow on Solana holds money between strangers. A foundation name service gives badged profiles a readable name under forest.foundation. Products are thin apps on top; the first is Soil.

## Keys, profiles, badges

Three rungs of one ladder. There are no accounts anywhere.

1. **A key.** From a passkey (the default) or from any existing wallet (sign one fixed message, derive the seed the same way every time). With a key you can pay, and pay into escrow.
2. **A profile.** A folder with a DID. Free, unlimited, no chain. Needed before a badge. Reviews live in profiles, so a review needs one; an unbadged reviewer's review weighs near zero.
3. **A badge.** Face once, then one registry entry per market. Reviews carry weight both ways.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Keys recipe | Passkey secret (WebAuthn PRF) to seed, seed to per-profile keys, wallet and DID, and one identity secret per person for the registry. Seed file format for extra passkeys (seed encrypted under each passkey's secret, stored under a label derived from that passkey's secret, carrying no identity). Paper export format. The passkey belongs to forest.foundation; products are listed in `/.well-known/webauthn` (related origins), Soil first | Ours: a spec and a small library from existing parts | User's device |
| Folders | One per profile: profile, posts, reviews, credentials, photos, all signed on device | AT Protocol lexicons and libraries, unchanged | A host |
| Host | Stores folders, serves the live feed, never holds a signing key, accepts client-signed commits. Candidate: Vow (a keyless PDS, experimental). Else the smallest fork of a standard PDS's write path | Configured or forked, decided after evaluation | Soil (Railway, plain SQLite files) |
| Directory | Public cards: name, current key, current host | did:plc, run independently; we keep a replica | Theirs |
| Carrier | Subscribes to hosts, verifies signatures, carries registered profiles and Forest record types only | AT Protocol relay, configured | Foundation (Railway) |
| Index | Reads the carrier, scores, serves category pages, profile pages, a machine endpoint. Open algorithm. Signs scores with a ZK-friendly signature (EdDSA over Poseidon) alongside the normal one | Ours | Supabase and Vercel, at forest.foundation |
| Registry | Sealed program: a set of list fingerprints, one code per (human, market), the 25-cent rule, a rent sweep instruction | Ours; Semaphore circuit unchanged, groth16-solana verifier, Poseidon syscall | Solana |
| Fee payer, registrations | Sponsors registrations whose market is in the directory and whose proof checks out, rate-limited. No vouchers, no tokens, no custom code | Kora, configured | Foundation (Railway) |
| Escrow | Sealed program per version: one shape, an amount of a plain SPL token held between two keys; released by approval, silence, split, or optional arbiter | Ours | Solana |
| Face check | Once. Passive liveness plus dedupe. Foundation runs it as the first issuer and owns the account holding the list; Didit holds the faces. New issuers register themselves | Didit | Theirs |
| Issuer flow | Face check result to identity commitment to list insert | Ours, small | Foundation (Railway) |
| Names | Every badged profile gets a random handle free, like `k7m2q.forest.foundation`; it is the profile page and the AT Protocol handle. Chosen names are optional, one per profile, paid yearly (amount a treasury dial) | Ours, small | Foundation |
| Badge and pay link | On forest.foundation, so they outlive any product. Pay link is a Solana Pay URL to the escrow's deposit address | Ours, in the index | Foundation |

## Foundation versus product

Rule: a piece that only works if everyone shares one is a public good and goes in the foundation; anything someone needs to compete with us is in the foundation; money flows and interfaces are products. Code open in the foundation; operations paid in products.

| Foundation (open) | Soil (first app, replaceable) |
|---|---|
| Record shapes, market template, markets directory | The app page: unlock, profiles, posts, reviews, signing, escrow buttons, AI permissions |
| Keys recipe, seed file format, paper export | Hosting an instance of the host; seed-file store |
| Registry, escrow, host software, carrier, index, ranking, registration fee payer, names, issuer | Fee payer for everything else (fund, release, send) |
| Badge and pay link on forest.foundation | Ramp: exchange instructions and a prefilled ramp page in v0; Crossmint (self-serve on staging now; production when they accept us, sole proprietor first) or Onramper |
| | The door: an MCP server that holds no keys and forwards signing to the app |

Repos: `foundationforest/forest` (all foundation code, Apache 2.0) and `foundationforest/markets` (files, CC0). The product org holds `soil`. Names: Forest at forest.foundation; Soil at soil.host (not bought yet).

## Registry (the detail that matters)

- **List.** Each verified human adds one identity commitment (made on their device) to a Merkle tree the issuer key can insert into. Hashing must match Semaphore's circuit exactly (Poseidon; the syscall exists on Solana). Tree depth 32. The program holds a set of list fingerprints, not one, so more lists can be opened later without a new program; it starts with a single list. When a second list opens, new joiners are assigned randomly across all open lists, so which list a person is in never tells you when they joined. Not sharded on day one, because the anonymity set is the size of your own list and splitting early shrinks it when it is smallest.
- **Proof.** Semaphore's circuit unchanged, with the artifacts from the public July 2024 ceremony and the matching library version pinned. Not the later artifacts: their phase two has no published transcript, and the verification key is sealed forever. The same circuit and ceremony are what World ID uses at millions of users. We write only the Solana side: verifier glue (groth16-solana; negating the first proof point is the one conversion), the tree, the used codes, the rules.
- **Registration.** One transaction carries: the market name, the profile's DID, one proof whose scope is the market name, and 0.25 in an accepted dollar token. One rule, always: 25 cents. There are no free slots, no numbered codes and no vouchers in the program.
- **Scopes are hashed.** The scope is a fixed-size hash of a namespaced market name, so any length of name works. The program recomputes the hash from the name in the instruction and compares it to the proof's scope, or a proof for one market would count for another. The program accepts any scope; only names in the `markets` directory count in indexes and badges. Whether a scope is a market ("online-tutors") or a market and role ("online-tutors:seller") is a directory file decision, changeable at any time, not a program decision.
- **Accepted tokens.** USDC always (sealed, so registration can never be halted). Others added by the treasury key, restricted to dollar stablecoins pegged one to one.
- **Free registrations live outside the program.** The foundation's sponsor pays the 25 cents under its own policy, which can change forever without touching the sealed program. The policy must only sponsor registrations whose market is in the directory, or a bad actor registers endlessly in invented markets and drains it. With a small directory the ceiling is one badge per market per human, so v0 needs no extra proof, only that check and a rate limit. Later, when the directory is large, the sponsor can require a proof of "fewer than N badges across the directory", which is the same walk as the completeness proof below.
- **Rent sweep.** Solana is lowering the rent deposit in steps. Accounts may hold less once a step lands, but only an instruction in the owning program can move the excess out. A sealed program without one locks that money forever. The program must have a sweep instruction from day one, sending only the excess above the current rent-exempt minimum to the treasury, never touching anything else.
- **Transaction shape.** Compressed proof points, standard transaction format, no address lookup tables. A registration is 831 bytes of the 1,232 limit and 9.5% of the compute limit, measured on the built program.
- **Recent fingerprints.** The program remembers the last 128 list fingerprints and accepts a proof against any of them, so a proof made just before someone else joins still lands. Safe because nobody is ever removed.
- **No removals.** Once a human is in the list they cannot be taken out. If a duplicate ever passes the face check, v1 cannot undo it.
- **Sponsor.** The foundation's Kora sponsors the network fee for any registration whose proof checks out, rate-limited.
- **Sealed per version.** The upgrade key is removed after deploy. A v2 is a new program; migrating the list costs, so v1 must be right. First sellers use v1 on devnet before mainnet.
- **Later, same data.** Completeness is one small proof per market, not one proof over all markets: for each market in the directory, "my code for this market is present" or "is absent", all sharing one proving key of a few megabytes. Absence is proven against a sorted version of the code list; the verifier (a buyer's app or an index) rebuilds that sorted list itself from the chain's arrival-order fingerprint, so nothing is trusted. These per-market proofs are a new circuit and need their own ceremony; that is v1, and the registry does not wait for it. The sealed program's only job for this is option 3 in `docs/decisions/used-code-storage.md`: an account per used code, plus the arrival-order fingerprint of all codes.

## Escrow

One shape. An amount of a plain SPL token held between two keys, buyer and seller, released by rule.

- Parties are Solana keys. A profile's wallet is a key; any wallet is a key. The program never knows about DIDs.
- Each escrow has its own deposit address, fundable by a plain transfer from anywhere. The program checks "balance at least the amount," never "exactly." The refund address is the buyer's key, fixed at creation.
- Release: the buyer approves (all to the seller, or an agreed split with the rest back to the buyer); or silence (release to the seller after N days); or objection (locked until both agree; an unresolved lock marks both); or an optional arbiter key named at creation.
- Per hour, per day, per job: the app multiplies before funding. One escrow per payment. The program has no modes.
- v1 accepts classic SPL Token mints only (no Token-2022 extensions). Because a transfer fee, a permanent delegate, or a transfer hook changes what "hold X, release X" means, and a sealed program can't be patched.
- Sealed per version. New deals use the newest version; old deals finish on theirs.
- Moving money between profiles links them on chain. Options for users: one main wallet (default, linked), fund a profile directly from an exchange, or a third-party shielded pool by link-out. Forest never builds or embeds one.

## Reputation

- Two scores per profile, never blended: uniqueness (which issuers vouched) and trust (open algorithm over reviews given and received, weighted by the reviewer's own trust). Everyone starts at zero; a badge means real and accountable, not good.
- Per human, three tiers: public linking (a signed record in each profile pointing at the others; the user's choice), private disclosure to one buyer (the seller's app signs "these profiles are mine" with each profile key, encrypts it to the buyer's key, and shows, for every other market in the directory, either the badge or that no code of theirs exists there; the buyer checks the chain; disclosing to a buyer is disclosing), and a v1 ZK aggregate.
- The index signs every score with a ZK-friendly signature from day one so the v1 circuit never needs an expensive signature check.

## Record shapes and markets

Four shapes, shared by every market: profile (name, photo, contact, what I do, declared wallet), post (direction, market, role, description, price block, availability, location or remote, optional expiry), review (about whom, rating, text, escrow pointer), credential (a W3C verifiable credential, issuer DID, one copy per profile). Nobody issues credentials yet; the shape exists so nothing changes when they arrive.

A market file adds: standard name, roles, extra fields, default silence days, whether an arbiter is allowed, review evidence rule, accepted credential issuers, accepted tokens. Market files add fields, never new shapes. First example: online tutors (priced per hour; one escrow per session). Three real markets are still open; candidates are online services. Category pages publish at a density threshold.

## Names

- A handle is a readable alias for one profile's DID: a domain name that resolves to the DID (`/.well-known/atproto-did`) while the DID points back. One profile, one active handle; the user can move it to any domain; the DID never changes.
- Every badged profile gets a random handle free, like `k7m2q.forest.foundation`. It is the profile page and the share link. Random names link nothing.
- A chosen name is optional, one per profile, priced like a domain: yearly, amount a treasury dial. Choosing the same word on two profiles links them; the user's choice, said in the copy.
- Badged profiles only. First come, first served. The foundation never judges disputes.
- Any app or host claims names through the same open endpoint; the UI is theirs. Profiles without a foundation handle are still reachable by DID on forest.foundation.
- Built after the index, since the index serves the page.

## What Soil needs from the foundation

The keys recipe as a library; the host image or fork; the fee-payer config pattern; the record shapes and validator; the registry client (build a proof on the device, submit through the foundation's fee payer); the escrow client; the names endpoint. Soil adds only its page, its host instance, its seed-file store, its fee payer, ramp links, and the door.

## Build order (one session each)

Items 2 and 3 swapped on September 15, 2026: the `markets` repo session now comes after the keys session (logged in `docs/changes.md`). Item 4, the registry feasibility check, was then taken before the `markets` repo session on September 15, 2026, because it is the only piece nobody has built on Solana and its answer can change the plan (logged in `docs/changes.md`). Its report is `registry/FEASIBILITY.md`.

1. `shapes/`: the four lexicons, a validator, one example record of each.
2. `keys/`: the recipe spec, the library, the seed file format, paper export, tests on Apple, Android, Windows.
3. `markets` repo: the template, its validator, the directory file, the online-tutors example.
4. `registry/` feasibility check, report only: Semaphore's circuit and setup files as is; tree hashing match; two proofs plus the numbered code inside one transaction's compute budget; storage cost per badge, plain versus compressed.
5. `host/` evaluation, report only: Vow as is, or the smallest fork.
6. `registry/` v1 on devnet.
7. `escrow/` v1 on devnet.
8. `issuer/`, `carrier/`, `feepayer/` configs.
9. `index/` with badge and pay link.
10. `names/`.

Meeting points, in order: issuer flow (face check to registry entry); carrier and index with badge and link; escrow with the silence rule; names; the door (in Soil).

Done when one stranger, with their own USDC, completes verify, register, post, get found, get paid, get reviewed, alone.

## Before mainnet

The foundation entity (a UK company limited by guarantee; forms before the first stranger's real face or the first grant application). One paid review of the two programs and the key handling by someone who has shipped Solana programs. One lawyer pass over the escrow program, the fee payer, the ramp referral, and biometric data responsibility. Three markets with sellers who ran the loop on devnet.

## Open

Which three markets. Default silence days per market. Whether one stablecoin holds for EU users. Which ramps accept a prefilled link with no partner account. Whether a moved passkey keeps its PRF secret (the design assumes not). Whether the registry should also emit an attestation other Solana apps can read (parked). Whether Crossmint or Onramper accepts a sole proprietor for production. Whether Crossmint's bank rails cover the first sellers' countries. Whether the Semaphore team publishes a transcript for the later artifacts. The per-market completeness circuit and its ceremony (v1, needs a public). Whether scopes are per market or per market and role, decided when the first real markets are written. When a second list is opened.

## Don't resurrect

Chain posts; a Forest-written folder standard; the chain debate; issuer-assisted recovery in v0; a Forest-invented name system (names are AT Protocol handles under the foundation domain); ten free tokens; vouchers and blind tokens for registration; custom code inside Kora; Mercury; Bridge; Stripe Atlas; Ramp Network direct; Transak in v0; a UK Ltd in v0; Meld; the registry as a service for other apps; recurring foundation revenue; manifesto-first; three long pages as the product; Semaphore contracts deployed unchanged; the face check as a product-side service; the cross-profile proof as v0; a per-human score that links profiles without the user choosing; user accounts anywhere; address logs; Commerce Kit; Private Channels; Mexico as a default for anything; escrow modes (fixed, per unit, capped; one shape only); a per-human handle market; one handle per human; wallet infrastructure providers (Turnkey, Privy, Crossmint wallets) for keys; numbered per-human codes (they would have put the same code in two registrations and publicly linked a human's profiles); free-slot codes inside the program; splitting the list on day one; Turso, Hetzner or any other host for v0 (Railway and plain SQLite files first, Hetzner when the host serves real photos); depth 20.

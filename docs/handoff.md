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

The central wallet (see "Wallets" under Escrow) is derived from the seed with its own info string, like profile wallets but with no index.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Keys recipe | Passkey secret (WebAuthn PRF) to seed, seed to per-profile keys, wallet and DID, and one identity secret per person for the registry. Seed file format for extra passkeys (seed encrypted under each passkey's secret, stored under a label derived from that passkey's secret, carrying no identity). Paper export format. The passkey belongs to forest.foundation; products are listed in `/.well-known/webauthn` (related origins), Soil first | Ours: a spec and a small library from existing parts | User's device |
| Folders | One per profile: profile, posts, reviews, credentials, photos, all signed on device | AT Protocol lexicons and libraries, unchanged | A host |
| Host | Stores folders, serves the live feed, never holds a signing key, accepts client-signed commits. The reference PDS with its write path forked: a device-signed two-phase write, folders created from a device-made DID, no key file per account, no address logs (`host/`) | Bluesky's reference PDS at a pinned commit plus a small patch series; everything else unchanged | Soil (Railway, plain SQLite files) |
| Directory | Public cards: name, current key, current host | did:plc, run independently; we keep a replica | Theirs |
| Carrier | Subscribes to hosts, verifies signatures, carries registered profiles and Forest record types only | AT Protocol relay, configured | Foundation (Railway) |
| Index | Reads the carrier, scores, serves category pages, profile pages, a machine endpoint. Reading is public HTTP with no keys: the machine endpoint has stable URLs, JSON and no session, and a skill file (plain text teaching any AI where the endpoints are and how to read them) is published at forest.foundation and in `index/`. Writing needs the user's keys and goes through the door in Soil. Open algorithm. Signs scores with a ZK-friendly signature (EdDSA over Poseidon) alongside the normal one | Ours | Supabase and Vercel, at forest.foundation |
| Registry | Sealed program: a set of list fingerprints, one code per (human, market), the 25-cent rule (0.25 USDC fixed, a fee per other accepted token), the profile's own wallet signing every registration, a rent sweep instruction | Ours; Semaphore circuit unchanged, groth16-solana verifier, Poseidon syscall | Solana |
| Fee payer, registrations | Sponsors registrations whose market is in the directory and whose proof checks out, rate-limited: it co-signs for fees, the profile signs for consent. No vouchers, no tokens, no custom code | Kora, configured | Foundation (Railway) |
| Escrow | Sealed program per version: one shape, an amount of a classic SPL token held between two keys, buyer and seller, in its own deposit account; accepted by the seller before anything but full payment (or opened by the seller, as an invoice); released by the buyer's approval, by silence, by both keys agreeing a split, or by an optional arbiter; cancelled by the buyer on time steps agreed at creation, or by the seller at any time after accepting; withdrawn by the buyer before. Once funded and ended, its account stays as a permanent receipt. Rules the chain reads by itself, signatures and time; every state change in the log | Ours | Solana |
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
- **Registration.** One transaction carries: the market name, the profile's DID, one proof whose scope is the market name, and the fee in an accepted token. One rule, always: 25 cents. There are no free slots, no numbered codes and no vouchers in the program.
- **The profile signs.** The profile's wallet, the key derived for that profile, signs every registration, on the sponsored path as well as the paid one, and the proof's message names that wallet as well as the DID. Because otherwise anyone could put a badge on a profile they don't control; and with the wallet only in the signer list, whoever saw a proof before it landed (a relay, the sponsor) could land it under their own key and spend the person's code. The entry names the wallet; a badge counts for a profile only when its profile record declares that wallet. A human who holds another profile's wallet can still badge it: selling a badge takes both keys, and the later circuit under "Open" closes it.
- **Scopes are hashed.** The scope is a fixed-size hash of a namespaced market name, so any length of name works. The program recomputes the hash from the name in the instruction and compares it to the proof's scope, or a proof for one market would count for another. The program accepts any scope; only names in the `markets` directory count in indexes and badges. Whether a scope is a market ("online-tutors") or a market and role ("online-tutors:seller") is a directory file decision, changeable at any time, not a program decision.
- **Accepted tokens.** USDC always, at 0.25, a program constant that cannot be changed or removed (sealed, so registration can never be halted). Others added by the treasury key, each with its fee set once at `add_token` in that mint's own units, meant to be worth 25 cents. Because if the dollar ever fails, the treasury adds another token with a sensible amount and registration continues. The program refuses a fee of zero and cannot judge any other; that is the treasury's discipline.
- **Free registrations live outside the program.** The foundation's sponsor pays the 25 cents under its own policy, which can change forever without touching the sealed program. The sponsor co-signs for fees; the profile signs for consent. The policy must only sponsor registrations whose market is in the directory, or a bad actor registers endlessly in invented markets and drains it. With a small directory the ceiling is one badge per market per human, so v0 needs no extra proof, only that check and a rate limit. Later, when the directory is large, the sponsor can require a proof of "fewer than N badges across the directory", which is the same walk as the completeness proof below.
- **Treasury handover.** Two steps. The current treasury proposes a key (`propose_treasury`), and nothing moves until that key signs `accept_treasury`: until then the old key turns every dial, is paid every fee and receives every sweep, and it can overwrite or clear the proposal. Because a one-step handover with a typo in it locks the treasury forever: every dial frozen, every fee sent to nobody. A key that cannot sign can be proposed but never accepted.
- **Closing a list.** The treasury key can close a list to new insertions (`close_list`), for good. Proofs against a closed list stay valid forever. No instruction ever deletes a list.
- **Rent sweep.** Solana is lowering the rent deposit in steps. Accounts may hold less once a step lands, but only an instruction in the owning program can move the excess out. A sealed program without one locks that money forever. The program must have a sweep instruction from day one, sending only the excess above the current rent-exempt minimum to the treasury, never touching anything else.
- **Transaction shape.** Compressed proof points, standard transaction format, no address lookup tables. A registration is 832 bytes of the 1,232 limit (v0) and 9.5 to 9.7% of the compute limit, measured on the built program with the profile signing on both paths.
- **Recent fingerprints.** The program remembers the last 128 list fingerprints and accepts a proof against any of them, so a proof made just before someone else joins still lands. Safe because nobody is ever removed.
- **No removals.** Once a human is in the list they cannot be taken out. If a duplicate ever passes the face check, v1 cannot undo it.
- **Sponsor.** The foundation's Kora sponsors the network fee for any registration whose proof checks out, rate-limited. It signs as fee payer; the profile's wallet signs too.
- **Treasury without SOL.** The runtime refuses a transaction that leaves an account it credits below rent exemption, so a small sweep into a treasury address holding no SOL fails until the address holds a little. The deploy checklist in `registry/README.md` funds it first.
- **Sealed per version.** The upgrade key is removed after deploy. A v2 is a new program; migrating the list costs, so v1 must be right. First sellers use v1 on devnet before mainnet.
- **Later, same data.** Completeness is one small proof per market, not one proof over all markets: for each market in the directory, "my code for this market is present" or "is absent", all sharing one proving key of a few megabytes. Absence is proven against a sorted version of the code list; the verifier (a buyer's app or an index) rebuilds that sorted list itself from the chain's arrival-order fingerprint, so nothing is trusted. These per-market proofs are a new circuit and need their own ceremony; that is v1, and the registry does not wait for it. The sealed program's only job for this is option 3 in `docs/decisions/used-code-storage.md`: an account per used code, plus the arrival-order fingerprint of all codes.

## Escrow

One shape. An amount of a classic SPL token held between two keys, buyer and seller, released by rules the chain can read by itself: signatures and time. Never by events.

- Parties are Solana keys. A profile's wallet is a key; any wallet is a key. The program never knows about DIDs. An optional arbiter key may be named at creation.
- Deposit address. Each escrow has its own token account. Money arrives by plain transfer from anywhere: the app, a pay link, a friend, an AI. The escrow counts as funded when the balance is at least the amount; anything above the amount goes back to the buyer at the end.
- Service time, optional. When set, the silence clock starts there; otherwise it starts when the escrow is funded.
- Acceptance. The seller accepts the escrow as it stands before anything but paying in full can happen. Before acceptance only two things can touch a funded escrow: the buyer's approval of everything to the seller (paying in full never needs the seller's consent) and the buyer's withdrawal of everything. No objection, no silence, no arbiter, no agreement, no seller's cancellation until the seller accepts; after it, everything runs as below. An escrow the seller opens is accepted from creation: an invoice. The clock never starts before acceptance. Because otherwise a stranger could open an escrow naming any seller, lock it, or name its arbiter and its clock.
- Release. The buyer approves: all to the seller, or a split with the rest back to the buyer. Or silence: after N days from the clock start, anyone may release to the seller. Or agreement: both keys sign any split. Or the arbiter, if named, decides any split.
- Objection. The buyer objects before silence releases: the escrow is locked; only agreement or the arbiter can end it. An unresolved lock marks both, in the log.
- Cancellation, by time only. Up to four steps of (deadline, refund percent to the buyer), agreed at creation. The buyer cancels alone before a deadline and gets that step's percent; after the last deadline the buyer cannot cancel alone. The seller cancels at any time after accepting and before release: the buyer gets everything back, and the log marks the seller.
- Receipts are permanent. When an escrow that held the amount ends, its deposit account is closed and that rent returned to whoever paid it, but the escrow account is never closed: it keeps its final state, amounts and outcome, so the address is a permanent receipt and can never hold another deal. An escrow that never held the amount is closed, and both rents returned, by the buyer or the seller at any time, or by the rent payer after its last deadline (at any time with no steps). Because the deal id is the address, and a review points at it forever.
- Rent. Whoever pays the creation rent is recorded. The deposit account's rent goes back to them at the end; the receipt keeps its own.
- Tokens. Classic SPL Token mints only, and not wrapped SOL. Because Token-2022 extensions change what "hold X, release X" means, a sealed program cannot be patched, and SOL sent to a wrapped-SOL deposit account without a sync never reaches the buyer.
- Sealed per version. No upgrade, no pause, no admin, no fee. New deals use the newest version; old deals finish on theirs.
- Per hour or per job is the app multiplying before funding. One escrow per payment. The market file carries the defaults (silence days, arbiter allowed or not, the cancellation steps, accepted tokens); the app puts them in the escrow at creation.
- Every state change is emitted in the log with amounts, so indexes can read outcomes: created, accepted, funded, approved, released by silence, objected, agreed, arbitrated, cancelled by buyer, cancelled by seller, withdrawn, ended, and closed (never funded). The ending is in the account too.
- Wallets. A person has one central wallet and one wallet per profile. The central wallet is where money enters from a ramp and leaves to one; it never pays a seller and never receives from a buyer. Every deal touches only profile wallets, so receipts bind to profiles. Moves between the central wallet and a profile wallet are where profiles could be linked on chain, going in and, above all, coming out, because every seller cashes out to one place. Those moves go through a third-party privacy pool once one is live on mainnet, reviewed, and cleared by a lawyer; the app moves round amounts and waits a random while, since equal amounts minutes apart are a link anyone can read. Until then the moves are direct and the button says it connects the two on chain. Forest never builds or embeds a pool; a user moving their own money through a reviewed one is not Forest doing it.

## Reputation

- Two scores per profile, never blended: uniqueness (which issuers vouched) and trust (open algorithm over reviews given and received, weighted by the reviewer's own trust). Everyone starts at zero; a badge means real and accountable, not good.
- Per human, three tiers: public linking (a signed record in each profile pointing at the others; the user's choice), private disclosure to one buyer (the seller's app signs "these profiles are mine" with each profile key, encrypts it to the buyer's key, and shows, for every other market in the directory, either the badge or that no code of theirs exists there; the buyer checks the chain; disclosing to a buyer is disclosing), and a v1 ZK aggregate.
- The index signs every score with a ZK-friendly signature from day one so the v1 circuit never needs an expensive signature check.

## Deals and evidence

- Every interaction is a deal with a deal id: 32 random bytes chosen at creation. When an escrow exists, its account address is the deal id.
- A review is a signed claim by one profile about another, pointing at a deal id. It can be as thin as "I dealt with this person on this deal," with no rating. Two reviews pointing at each other across one deal id are the two sides' receipts; no separate record shape is needed for that.
- Evidence is what proves a deal happened beyond the parties' word. For now there is one kind: the escrow's permanent receipt on chain. Indexes weigh a review by the reviewer's own trust and by the evidence under its deal; programs never interpret either.
- No evidence proves two people were physically together: two people who agree to lie can relay their devices from anywhere, and no phone signs a physical measurement. Collusion is bounded by identity (one badge per human per market) and by reviewer trust, not by evidence.
- A product may make every payment an escrow, even one that releases in the same second, so that every payment has a receipt at an address a review can point at. That is a product default, not a program rule; the program must let create, fund and approve ride in one transaction so "Pay" is one tap.

## Record shapes and markets

Four shapes, shared by every market: profile (name, photo, contact, what I do, declared wallet), post (direction, market, role, description, price block, availability, location or remote, optional expiry), review (about whom, rating, text, deal id), credential (a W3C verifiable credential, issuer DID, one copy per profile). Nobody issues credentials yet; the shape exists so nothing changes when they arrive.

A market file adds: standard name, roles, extra fields, default silence days, whether an arbiter is allowed, default cancellation steps, review evidence rule, accepted credential issuers, accepted tokens. Market files add fields, never new shapes. First example: online tutors (priced per hour; one escrow per session). Three real markets are still open; candidates are online services. Category pages publish at a density threshold.

## Names

- A handle is a readable alias for one profile's DID: a domain name that resolves to the DID (`/.well-known/atproto-did`) while the DID points back. One profile, one active handle; the user can move it to any domain; the DID never changes.
- Every badged profile gets a random handle free, like `k7m2q.forest.foundation`. It is the profile page and the share link. Random names link nothing.
- A chosen name is optional, one per profile, priced like a domain: yearly, amount a treasury dial. Choosing the same word on two profiles links them; the user's choice, said in the copy.
- Badged profiles only. First come, first served. The foundation never judges disputes.
- Any app or host claims names through the same open endpoint; the UI is theirs. Profiles without a foundation handle are still reachable by DID on forest.foundation.
- Built after the index, since the index serves the page.

## What Soil needs from the foundation

The keys recipe as a library; the host image or fork; the fee-payer config pattern; the record shapes and validator; the registry client (build a proof on the device, submit through the foundation's fee payer); the escrow client; the names endpoint. Soil adds only its page, its host instance, its seed-file store, its fee payer, ramp links, and the door.

Reading Forest is public HTTP and needs no keys, so the foundation publishes a skill file (a plain text file teaching any AI where the index's endpoints are and how to read them) at forest.foundation and in `index/`; writing needs the user's keys, so it goes through the door in Soil (MCP). The index's machine endpoint is designed with that skill in mind: stable URLs, JSON, no session.

Money in Soil follows the wallets rule under "Escrow": one central wallet per person and one wallet per profile. Ramp links pay into and out of the central wallet only; every deal is paid from and to profile wallets only. Soil's button for a move between the central wallet and a profile wallet says it connects the two on chain, and the move is direct, until a third-party privacy pool is live on mainnet, reviewed and cleared by a lawyer; then Soil moves round amounts through it after a random wait. The foundation gives Soil nothing for the pool: no code, no embed.

Soil waits a random interval, minutes to hours, between a person joining the list and their first registration; the issuer inserts identities in batches, not one by one, so a badge cannot be matched to a face check by timing.

A write from Soil needs only the seed unlocked for the session, never a passkey gesture per write. The passkey's job is to unlock the seed; the signing key then signs from memory for as long as the session lasts. A prompt on every post and review was Vow's choice, not Forest's; Soil may add one, and the host neither requires nor can tell.

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

Which three markets. Default silence days per market. Whether one stablecoin holds for EU users. Which ramps accept a prefilled link with no partner account. Whether a moved passkey keeps its PRF secret (the design assumes not). Whether the registry should also emit an attestation other Solana apps can read (parked). Whether Crossmint or Onramper accepts a sole proprietor for production. Whether Crossmint's bank rails cover the first sellers' countries. Whether the Semaphore team publishes a transcript for the later artifacts. The per-market completeness circuit and its ceremony (v1; the ceremony needs real independent contributors, so it waits for a public). Whether scopes are per market or per market and role, decided when the first real markets are written. When a second list is opened. A later circuit proving the profile's key and the identity secret come from one seed, which closes badge selling entirely; v1.

## Don't resurrect

Chain posts; a Forest-written folder standard; the chain debate; issuer-assisted recovery in v0; a Forest-invented name system (names are AT Protocol handles under the foundation domain); ten free tokens; vouchers and blind tokens for registration; custom code inside Kora; Mercury; Bridge; Stripe Atlas; Ramp Network direct; Transak in v0; a UK Ltd in v0; Meld; the registry as a service for other apps; recurring foundation revenue; manifesto-first; three long pages as the product; Semaphore contracts deployed unchanged; the face check as a product-side service; the cross-profile proof as v0; a per-human score that links profiles without the user choosing; user accounts anywhere; address logs; Commerce Kit; Private Channels; Mexico as a default for anything; escrow modes (fixed, per unit, capped; one shape only); a per-human handle market; one handle per human; wallet infrastructure providers (Turnkey, Privy, Crossmint wallets) for keys; numbered per-human codes (they would have put the same code in two registrations and publicly linked a human's profiles); free-slot codes inside the program; splitting the list on day one; Turso, Hetzner or any other host for v0 (Railway and plain SQLite files first, Hetzner when the host serves real photos); depth 20; money entering each profile only from outside, with no central wallet (the cash-out funnel links profiles anyway); a mutual-receipt evidence type (two reviews pointing at one deal id already are it); Bluetooth or NFC co-presence as evidence anyone can verify.

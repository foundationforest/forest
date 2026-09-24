# Forest: foundation handoff (September 24, 2026)

The plan for the `forest` repo, as the design stands in the code today. Claude Code reads `CLAUDE.md` and this file before every session. Nothing is shipped: everything below is design, and "Build status and order" says what exists and where it has run. The reason behind each choice is in `docs/changes.md`. When something here turns out wrong, change it and say what changed there.

## What Forest is

Forest is an open environment where a person owns their profile, their offers and their reputation, and deals with strangers with no platform in the middle. Each person is checked once, by face, to be one real human. A profile is a free folder of signed records, and a person may hold many. A market is a text file anyone can read. Any AI can read the records and, through one connection, act in them.

One sentence: one human, one record, any market, no one in between.

Why it works: accountability. You can't start over: one human gets one badge per market. Evidence exists: a verified human stakes their own reputation on a review, with the payment receipt underneath. Nobody can erase it: the records are signed, live in your own folder, and anyone can index them. The foundation supplies accountability; products get people paid.

Why now: four things became cheap in about three years, and Forest needs all four. Proof that someone is one unique human without a government (face liveness and deduplication as an API). Keys normal people can hold (passkeys). Money a program can hold at no cost per deal (stablecoins). A reader that needs no interface (AI agents). Global from day one; nothing is region-specific.

## The shape

A passkey on your phone unlocks a secret seed that never leaves the device. From the seed come all your keys: for each profile, the keys that sign its records and its own wallet, and for you as a person, one identity for the registry and one central wallet. Each profile is a folder of signed records kept by a host, which stores but never signs. A carrier passes the records to indexes; an index ranks them and serves pages that people and AIs read. On Solana, a registry gives one verified human one badge per market without saying who, and an escrow holds money between strangers until the deal's own rules release it. The DID is the identity; readable names are a later feature. Products are thin apps on top; the first is Roots.

## Keys, profiles, badges

Three rungs of one ladder. There are no accounts anywhere.

1. **A key.** From a passkey, the one way in: the passkey makes the seed, and the 24 words are the optional backup and the way to carry the seed anywhere. With a key you can pay, and pay into escrow.
2. **A profile.** A folder with a permanent name (a DID). Free, unlimited, nothing on chain. Needed before a badge. Reviews live in profiles, so a review needs one; an unbadged reviewer's review weighs near zero.
3. **A badge.** A face check once, then one registry entry per market. Reviews carry weight both ways.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Keys recipe | Passkey secret (WebAuthn PRF) to seed; seed to each profile's control key, signing key, wallet and DID, plus one identity secret and one central wallet per person. Seed file format for extra passkeys. The 24 words, a backup | Ours: a spec and a small library from existing parts | The user's device |
| Folders | One per profile: profile, posts, reviews, credentials, photos, all signed on the device | AT Protocol lexicons and libraries, unchanged | The host |
| Host | Stores folders and serves the live feed; accepts only commits signed on the device; holds no signing key; keeps no address logs | Bluesky's reference PDS at a pinned commit, with its write path forked by five patches (`host/`) | Railway, plain SQLite files |
| Directory | Public cards: name, current key, current host | did:plc, run independently; the foundation keeps a replica | plc.directory |
| Carrier | Subscribes to hosts, verifies signatures, carries registered profiles and Forest record types only | AT Protocol relay, configured | Railway |
| Index | Reads the carrier; scores; serves category pages, profile pages and a machine endpoint; publishes the read skill; signs scores | Ours | Vercel and Supabase, at forest.foundation |
| Registry | Sealed program: lists of verified humans that anyone may open and vouch for, one code per human per market, 25 cents per registration, the profile's wallet signing | Ours; Semaphore's circuit unchanged, groth16-solana, the Poseidon syscall | Solana |
| Fee payer | Co-signs a person's transaction and charges its network fee in their dollar token, so nobody needs SOL; holds none of their keys and decides nothing | Kora, configured, no custom code | Railway |
| Escrow | Sealed program: an amount of a classic token held between two keys, released by rules the chain reads by itself | Ours | Solana |
| Face check | Once: passive liveness plus deduplication. Didit holds the faces | Didit | Didit |
| Issuer flow | The foundation's issuer: face check result to identity commitment to an insert into its own list, in batches | Ours, small | Railway |
| Names (later) | Readable names under forest.foundation, paid, random or chosen by auction; built after Roots | Ours, small | Vercel and Supabase, with the index |
| Badge and pay link | On forest.foundation, so they outlive any product | Ours, in the index | Vercel and Supabase |

## Foundation versus product

The rule: a piece that only works if everyone shares one is a public good and goes in the foundation; anything someone needs to compete with us is in the foundation; money flows and interfaces are products. Code is open in the foundation; operations are paid in products.

Four slots are open to anyone: issuers, indexes, evidence types and apps. The foundation runs the first of each; anyone may run another. Weights and interpretations live in indexes, never in programs.

- **Issuers** vouch that a person is one human. Issuers are an open slot: anyone may open a list in the registry, owning it and naming the keys that insert into it; the registry checks nothing about who an issuer is. The foundation runs the first, with Didit's face check, on the list `init` opens. One badge per market per issuer. Extra vouches ride in the folder. The market weighs which issuers count (see "Registry"). Any issuer can sign credentials.
- **Indexes** read the records and weigh them. The foundation runs the first, at forest.foundation.
- **Evidence types** show a deal happened beyond the parties' word. The first is the escrow's receipt.
- **Apps** are where people act. The first is Roots.

| Foundation (open) | Roots (first app, replaceable) |
|---|---|
| Record shapes, market template, the `markets` repo | The app page: unlock, profiles, posts, reviews, signing, escrow buttons, AI permissions |
| Keys recipe, seed file format, the 24 words as a backup | An instance of the host; a seed-file store |
| Registry, escrow, host software, carrier, index, ranking, the fee payer's configuration, the first issuer, names (later) | An instance of the fee payer |
| Badge and pay link on forest.foundation | Ramp: exchange instructions and a prefilled ramp page in v0; Crossmint (self-serve on staging; production once they accept a sole proprietor) or Onramper |
| | The door: an MCP server that holds no keys and forwards signing to the app |

Repos: `foundationforest/forest` (all foundation code, Apache 2.0) and `foundationforest/markets` (market and category files, CC0). The product org holds `roots`. Forest lives at forest.foundation; Roots at Roots' own domain (not bought yet).

## Keys

`keys/SPEC.md` is the recipe, exact enough that any product following it opens the same seed from the same passkey.

- **The recipe.** The passkey's PRF secret becomes a 32-byte seed by HKDF-SHA256. Every key is one more HKDF output from the seed under its own label, so knowing one key says nothing about another or about the seed. For each profile: a control key and a signing key (secp256k1; the DID's rotation key and its signing key) and a wallet (ed25519). The DID is made on the device from those keys.
- **The seed file.** A second passkey opens the same seed through a seed file: the seed encrypted under that passkey's secret, stored under a label derived from the same secret. A new device finds its file from nothing but its passkey; whoever stores the file learns nothing, and nothing in it names a person, a profile or a passkey. The first passkey needs no file.
- **The 24 words.** The seed as 24 English words: the optional backup, and the way to carry the seed anywhere. A backup, not a login: they restore the seed onto a device, where a passkey then opens it. They open everything, so they are for paper only.
- **The passkey's domain.** The passkey belongs to forest.foundation. Products that use it are listed in `https://forest.foundation/.well-known/webauthn` (related origins), Roots first, so one passkey serves every product.
- **The identity secret.** One per person, with no profile index, so the registry holds one entry per human while profiles stay apart. Only its commitment leaves the device, once to each issuer that vouches for the person. Losing the seed loses it: the badges stay, and getting back on the list takes another face check.
- **The central wallet.** One per person, with its own label and no profile index, so it links to no profile's keys. See "Wallets".
- **No recovery** without a passkey or the words. A passkey moved between providers is assumed to lose its PRF secret and needs its own seed file.
- **No gesture per write.** A write needs only the seed unlocked for the session; the signing key then signs from memory. A product may add a prompt; the host cannot tell.

## Registry

A sealed Solana program that gives one verified human one badge per market, without saying which human.

- **Lists.** Each verified human adds one identity commitment, made on their device, to a list: a Merkle tree of depth 32 that the list's insert keys can insert into, hashed exactly as Semaphore's circuit hashes (Poseidon, through Solana's syscall). Anyone may open a list: whoever opens it pays its rent and is recorded as its owner and its first insert key, and only the owner adds or removes its insert keys (up to eight) or closes it. The treasury has no say over any list. `init` opens the first, owned by the foundation's issuer key, a program constant. An issuer with more than one open list assigns its new joiners randomly across them, so a list never tells when someone joined. The first list is not split on day one. Issuers insert in batches.
- **Issuers are an open slot.** The registry checks nothing about who opens a list; every registration's entry names the list and its owner, so an index can weigh a badge by who vouched. One badge per market per issuer: a code comes from a person's secret and the market, whichever list the proof is made against, so a second badge in the same market needs a second secret on another issuer's list. Extra vouches ride in the folder: a profile may keep proofs of its secret against other issuers' lists, made with the badge's market as scope so they show the badge's code, and anyone checks them against those lists' fingerprints (their roots) on chain. That needs no program change and is not built. The market weighs which issuers count.
- **The proof.** Semaphore's circuit unchanged, with the artifacts of the public July 2024 ceremony (4.0.0, depth 32) and the matching library pinned; not the later artifacts, whose second phase has no published transcript. Forest writes only the Solana side: the verifier glue (groth16-solana; the first proof point is negated), the trees, the used codes and the rules.
- **A registration** is one transaction: the market name, the profile's DID, one proof whose scope is the market name, the list root the proof is made against, the code, and the fee. The code is the proof's nullifier: the same for one human in one market, unguessable for anyone else. An account at an address derived from the code is what makes it once per human per market.
- **The fee.** One rule: 25 cents in USDC, always; other accepted tokens at the fee set for them. USDC's address and its 0.25 fee are program constants that nothing can change or remove. The treasury may accept up to fifteen more classic tokens, each at a fee above zero set once in that token's own units and meant to be worth 25 cents; nothing changes a token's fee and nothing removes a token. There are no free slots, no numbered codes and no vouchers in the program.
- **The profile signs.** The profile's wallet signs every registration, whoever pays, and the proof's message names that wallet and the DID, so a proof counts for one market, one profile and one wallet. The entry in the log names the wallet; a badge counts for a profile only when its profile record declares that wallet. A human who holds another profile's wallet can still badge it; the later circuit under "Open" closes that.
- **Names are hashed.** The scope is a hash of the namespaced market name, and the message a hash of the wallet and the namespaced DID, so a name or a DID can be any length. The program recomputes both. It accepts any scope; only names in the `markets` repo count in indexes and badges. Whether a scope is a market ("online-tutors") or a market and role ("online-tutors:seller") is a `markets` repo decision.
- **Everyone pays.** The program charges everyone: the 25 cents come from the fee authority's tokens, and the network fee and the storage deposit from the transaction's payer, while the profile's wallet signs. Whoever signs to pay, pays. A payer may pay for someone else; the program cannot tell and never needs to. Nothing in the foundation is built to pay on anyone's behalf.
- **The treasury.** The first treasury is a program constant, and `init` writes only constants, whoever sends it. One treasury key receives every fee and every sweep and turns every dial. It moves in two steps: the current treasury proposes a key, and nothing moves until that key signs to accept; until then the old key keeps everything and may change or clear the proposal. A treasury key holds a little SOL before it can receive a small sweep.
- **The dials.** The treasury accepts a token at a fee and hands itself over, and every rent sweep pays it. Nothing else: each list is its owner's. Proofs against a closed list stay valid forever, and nothing deletes a list.
- **Recent roots.** A proof against any of a list's last 128 roots is accepted, so a proof made just before someone else joins still lands.
- **No removals.** Once a human is in a list, they stay. Removing an insert key removes no one. A duplicate that passes the face check cannot be undone in v1.
- **The rent sweep.** Anyone may send `sweep_rent`. It moves only what a registry account holds above its current rent-exempt minimum, and only to the treasury; it touches nothing else. Solana is cutting the rent rate in steps, and only the owning program can move the difference.
- **Size.** A registration is 832 bytes of the 1,232 limit (v0 transaction) and 9.5 to 9.7% of the compute limit: compressed proof points, a standard transaction, no address lookup table.
- **Sealed per version.** The upgrade key is removed after deploy. A v2 is a new program with new lists, so v1 must be right. First sellers use v1 on devnet before mainnet.
- **The completeness proof, later, from the same data.** Every code also goes into an append-only tree the program keeps (`docs/decisions/used-code-storage.md`). Later, a person can show "my badges, none hidden" with one small proof per market in the directory, each saying "my code is present" or "absent", all sharing one proving key. Absence is proven against a sorted list the verifier (a buyer's app or an index) rebuilds itself and checks against the program's tree, so nothing is trusted. That circuit and its ceremony come later; the registry does not wait for them.

## Escrow

A sealed Solana program that holds an amount of a classic token between two keys, buyer and seller, and releases it by rules the chain reads by itself: signatures and time, never events. One shape for every category: a category changes what the service time means and which evidence applies, never the program.

- **Parties are keys.** A profile's wallet is a key; any wallet is a key. The program never knows about DIDs. An optional arbiter key may be named at creation, and it may not be a party.
- **Terms.** An escrow is created from the offer's terms (see "Record shapes"): the auto-release days, up to four cancellation steps and an optional arbiter; plus the amount, the token and an optional service time. Per hour or per job is the app multiplying before creation. One escrow per payment.
- **Deposit address.** Each escrow has its own token account: the escrow address's standard account for its token. Money arrives by plain transfer from anywhere: the app, a pay link, a friend, an AI. The escrow counts as funded when the balance reaches the amount; anything above the amount goes back to the buyer at the end.
- **Refund address.** The buyer's standard token account for the escrow's token, fixed at creation by the buyer's key and the token. Every ending that returns money to the buyer pays it there and nowhere else, the ones anyone may send included. The two returns anyone may send (late money and the unaccepted timeout) make it first if it is missing; for any other ending, whoever sends it makes it first in the same transaction. The endings check the address, not who holds that account now, so a buyer who hands it to another key cannot block the seller's release.
- **Acceptance.** The seller accepts the escrow as it stands before anything but paying in full can happen. An escrow the seller opens is an invoice, accepted from creation. Before acceptance, a funded escrow ends only three ways: the buyer approves everything to the seller, the buyer withdraws everything, or, once it times out, anyone sends everything back to the buyer. It times out after its last cancellation deadline, or 30 days after its funding if it has no steps; its receipt then says "never accepted" and the deposit account's rent goes back to whoever paid it.
- **The clock** starts at the latest of the service time (if set), the funding and the seller's acceptance, and never before the last two have happened. Anyone may record the funding.
- **Release.** The buyer approves: all to the seller, or a split with the rest back to the buyer. Or auto-release: after the auto-release days from the clock start, anyone may release to the seller (the program calls it silence). Or agreement: both keys sign any split. Or the arbiter, if named, decides any split. The seller's share rounds down in every split.
- **Objection.** Before auto-release, the buyer may object: the escrow locks, and only agreement, the arbiter or the seller giving everything back can end it. An unresolved lock marks both, in the log.
- **Cancellation, by time only.** Up to four steps of (deadline, refund percent), deadlines rising. The buyer cancels alone before a deadline and gets at least that step's percent; after the last deadline, not alone. The seller cancels at any time after accepting and before release: the buyer gets everything back, and the log marks the seller.
- **Permanent receipts.** When an escrow that held the amount ends, its deposit account closes and that rent goes back to whoever paid it, but the escrow account stays for good, with its terms, times, outcome and what each party got. Its address is a permanent receipt and the deal id, and it never holds another deal. An escrow that never held the amount is closed, both rents returned, by the buyer or the seller at any time, or by the rent payer after its last deadline (at any time with no steps).
- **Late money.** A payment that lands at an ended escrow's deposit address goes back to the buyer's refund address. Anyone may send it; the receipt does not change. Pay links are one-time: the client builds one only for an escrow still waiting for its money.
- **Rent.** Whoever pays the creation rent is recorded. Anyone may sweep what the escrow account holds above its rent-exempt minimum back to that payer; the sweep never goes below the minimum or touches anything else.
- **Tokens.** Classic SPL Token mints only, and not wrapped SOL; both are checked at creation.
- **One tap.** Create, a plain transfer in and approve fit in one transaction, so "Pay" is one tap.
- **The log.** Every state change is emitted with its amounts: created, accepted, funded, approved, released by silence, objected, agreed, arbitrated, cancelled by buyer, cancelled by seller, withdrawn, never accepted, ended, and closed (never funded); and, outside any ending, late money returned and rent swept. The ending is in the account too.
- **Sealed per version.** No upgrade, no pause, no admin, no fee. New deals use the newest version; old deals finish on theirs.

## Wallets

A person has one central wallet and one wallet per profile. The central wallet is where money enters from a ramp and leaves to one; it never pays a seller and never receives from a buyer. Every deal touches only profile wallets, so receipts bind to profiles.

Moves between the central wallet and a profile wallet are where profiles could be linked on chain, going in and above all coming out, since every seller cashes out to one place. A privacy pool and a ramp are features an app offers and a user chooses; any app may offer any provider. Hinkal is the first pool candidate and Crossmint the first ramp. Nothing about either is built into the foundation: no code, no embed. An app that moves money through a pool moves round amounts after a random wait; a move the user makes without one is direct, and its button says it connects the two on chain.

## Deals and evidence

- **Every interaction is a deal** with a deal id: 32 random bytes chosen at creation. When an escrow exists, its address is the deal id.
- **A review is a signed claim** by one profile about another, usually about one deal. A review can be as thin as pointing at a person; what is missing weighs less; nothing is refused. Two reviews across one deal id are the two sides' receipts; no other record is needed for that.
- **Evidence** shows a deal happened beyond the parties' word. There is one evidence type so far: the escrow's permanent receipt. A market file lists the evidence types that apply. Evidence weighs, it never rejects: a review without it is valid and weighs near zero.
- **Indexes weigh, programs never interpret.** An index weighs a review by the reviewer's own trust and by the evidence under its deal, and decides which tokens it counts.
- **Who said yes.** An index weighs a deal by who agreed to it. Both (the buyer paid, and the seller accepted or invoiced) counts in full. A one-tap payment with no acceptance is a real payment but one-sided until the seller reviews the same deal id. An escrow nobody accepted and nobody paid in full counts for nothing.
- **No co-presence proof.** No evidence proves two people met in person: two people who agree to lie can relay their devices from anywhere, and no phone signs a physical measurement. Collusion is bounded by identity (one badge per human per market) and by reviewer trust.
- **Every payment can have a receipt.** A product may make every payment an escrow, even one released in the same second, so each payment has an address a review can point at. That is a product default, not a program rule.

## Reputation

- **Two scores per profile, never blended:** uniqueness (which issuers vouched) and trust (an open algorithm over reviews given and received, weighted by each reviewer's own trust). Everyone starts at zero; a badge means real and accountable, not good.
- **Three tiers across one person's profiles,** each the user's choice. Public linking: a signed record in each profile pointing at the others. Private disclosure to one buyer: the seller's app signs "these profiles are mine" with each profile key, encrypts it to the buyer's key, and shows, for every other market in the directory, either the badge or that no code of theirs exists there; the buyer checks the chain; disclosing to a buyer is disclosing. And later, a zero-knowledge aggregate.
- **Signatures ready for later.** The index signs every score with a ZK-friendly signature (EdDSA over Poseidon) alongside the normal one, so the later circuit never needs an expensive signature check.

## Record shapes

Four shapes, shared by every market, as AT Protocol lexicons in `shapes/`. Market files add fields, never new shapes.

- **Profile:** name, photo, contact, what I do, declared wallet. One per folder.
- **Post:** direction (offer or request), market, role, description, price (an amount, the token named by its mint, and per hour, day or job), terms, availability, remote or a location, and an optional expiry. The terms are the seller's, set per offer: the auto-release days, up to four cancellation steps (hours from the clock start, a refund percent) and an optional arbiter. An offer must carry them; an escrow is created from them.
- **Review:** about whom (a DID), the one required field; and, all optional, a rating from 1 to 5, text, and a deal id (`dealId`): the escrow's address when an escrow exists, else 32 random bytes as hex. A review can be as thin as pointing at a person; what is missing weighs less; nothing is refused.
- **Credential:** a W3C verifiable credential with its issuer's DID, one copy per profile. Nobody issues credentials yet; the shape exists so nothing changes when they arrive.

A market file holds its standard name, its category, its roles, extra fields, the evidence types that apply, suggested starting terms (auto-release days, cancellation steps) and the credential issuers it recognizes. Records are validated on the device before they are written.

## Markets

- A category is a deal shape: how money, time and evidence flow. Three at launch:
  - Home services: a visit. The seller comes to you. The service time is the appointment, and the clock runs from the visit.
  - Freelance work: a deliverable. Money waits for a thing to be delivered. The service time is the due date; early delivery is released by the buyer's approval.
  - Buy and sell: a handover or a shipment. Money waits for the thing to change hands. The service time is the meeting or the expected delivery; the buyer confirms at handover; shipment tracking is a later evidence type.

  Later shapes (rides, stays, property sales, tickets) are new category files, not code. Wellness and health are out.
- A market is a trade or a kind inside a category: plumbing, tutoring, used phones. A badge is per market.
- A market file describes the shape, lists the evidence types that apply, and suggests starting values (auto-release days, cancellation steps). It restricts nothing: the arbiter is always available, any accepted token works, and auto-release days and cancellation steps are set per offer by the seller. No code enforces a market file's values on a deal; the validator checks a file's structure only.
- Standard names live in the `markets` repo; only those count in indexes and badges. Anyone can write another file; it carries no weight.

## Names

- Names are a later feature, not core. A name is convenience, not identity: the DID is the identity.
- At creation the app gives a folder the random name the folder software requires, under the app's own domain (for Roots, Roots' own domain), and nobody sees it.
- Readable names under forest.foundation are a later paid feature, random or chosen, by auction, built after Roots, not before. A name is an AT Protocol handle: a domain name that resolves to the DID while the DID points back; the user can move it, and the DID never changes. Choosing the same word on two profiles links them: the user's choice, said in the copy. The foundation never judges disputes.

## Host, carrier, index, fee payer, issuer flow

**Host (built, tested locally).** Bluesky's reference PDS at a pinned commit plus five patches in `host/`. Every commit is signed on the device in two phases: the host prepares the unsigned commit, the device signs it with the profile's signing key, and the host checks the signature against the DID document before storing it. A folder is created by its first device-signed commit, from a DID made on the device. The host holds no signing key for any folder, needs no account, email or password (the device signs a short token per call), and keeps no address in its logs. A folder moves to another host by pointing the DID there and importing its export. It runs on plain SQLite files and a folder of photos.

**Carrier (planned).** An AT Protocol relay, configured: it subscribes to hosts, verifies every commit against its DID document, and carries only registered profiles and Forest record types.

**Index (planned).** Reads the carrier, scores with an open algorithm, and serves category pages (published once a category is dense enough), profile pages, the badge, the pay link and a machine endpoint. Reading is public HTTP with no keys: stable URLs, JSON, no session. The read skill, a plain text file teaching any AI where the endpoints are and how to read them, is published at forest.foundation and in `index/`. Writing needs the user's keys, so it goes through the door in Roots. It counts a badge only when the entry's wallet is the profile's declared wallet, weighs a badge by the list owner the entry names, weighs deals by who said yes, and decides which tokens it counts. The reading rules adversarial review 1 found (only log entries the programs themselves wrote, market names compared byte for byte, its own archive of the logs) are in `docs/decisions/adversarial-review-1.md`. The pay link is a one-time Solana Pay link naming the escrow's address, from which the wallet finds the deposit account.

**Fee payer (planned).** Kora, configured, with no custom code: a service that co-signs a person's transaction and charges their network fee in their dollar token, so people never need SOL. It holds none of the person's keys and decides nothing. In a registration it is the transaction's payer, of the network fee and the code account's storage deposit, while the profile's wallet pays the 25 cents and signs. Nothing it sees lets it take a badge. See `feepayer/README.md`.

**Issuer flow (planned).** The foundation runs the first issuer, on list 0, which it owns: Didit's face check (passive liveness and deduplication; Didit holds the faces), then the person's identity commitment into its list, inserted in batches. Nothing server-side holds a person next to a profile. Anyone may run another issuer on a list of their own.

## What Roots needs from the foundation

- The keys recipe as a library; the host fork; the fee payer's config; the record shapes and validator; the registry client (build a proof on the device, send it through a fee payer); the escrow client.
- Roots adds only its page, its host instance, its seed-file store, its instance of the fee payer, the ramp and pool it offers, and the door (MCP).
- At creation Roots gives each folder the random name the folder software requires, under Roots' own domain; nobody sees it.
- Money follows "Wallets": ramp links pay into and out of the central wallet only; every deal is paid from and to profile wallets only.
- Roots waits a random interval, minutes to hours, between a person joining the list and their first registration, and the issuer inserts identities in batches, so a badge cannot be matched to a face check by timing.
- A write from Roots needs only the seed unlocked for the session, never a passkey gesture per write.
- When a seller writes an offer, Roots starts its terms from the market file's suggested values; the seller sets them.

## Build status and order

How work splits: a chat with Carlos decides (stress tests, searches, anything that isn't code). Claude Code builds: one task per session, plan mode first; "should we" questions go to `docs/changes.md` as open items, not decisions. Carlos does what only he can: accounts, passwords, money, the entity, the first sellers. At the end of every session `docs/changes.md` gets three lists, built, learned and open; this file never marks design as done.

**Built and tested locally, nowhere else.** Nothing is deployed: no devnet, no mainnet, no Kora, no Railway, no real face check, no proof on a phone.

- `shapes/`: the four lexicons, the market template, the validator and its command line, one example of each.
- `keys/`: the recipe spec and library with pinned test vectors. A passkey-derived seed came out identical on iPhone and Mac; the library's tests on Apple, Android and Windows devices are not run.
- `registry/`: the program, the client, the pinned ceremony files; tests under LiteSVM and on a local validator, and a property test.
- `escrow/`: the program and the client; tests under LiteSVM and on a local validator, and a fuzzer.
- `host/`: the fork, with end-to-end tests against a local directory and two local hosts.
- `testsite/`: a static site for trying the keys page and a handover experiment on real phones; not online yet.
- Reports: `registry/FEASIBILITY.md` and `docs/decisions/` (used-code storage, the host, adversarial review 1 of both programs).

**Next, one session each, in order:**

1. Devnet deploy of both programs. First a real treasury key and the foundation's issuer key replace the registry's two placeholders, which anyone with this repo can sign for.
2. The issuer flow.
3. The fee payer's config.
4. The carrier's config.
5. The index, with the badge, the pay link and the read skill.
6. The `markets` repo: the market template and its validator, category files, the directory, the first market files.

Meeting points, in order: the issuer flow (face check to registry entry); the carrier and index with badge and link; escrow with auto-release; the door (in Roots).

**Then Roots.** Names come after Roots.

**Before mainnet.** The foundation entity (a UK company limited by guarantee; it forms before the first stranger's real face or the first grant application). One paid review of both programs and the key handling by someone who has shipped Solana programs. One lawyer pass over the escrow program, the fee payer, the ramp referral and biometric data responsibility. Three markets with sellers who ran the loop on devnet.

Done when one stranger, with their own USDC, completes verify, register, post, get found, get paid, get reviewed, alone.

## Open

- **Markets.** Which three markets launch first, and each standard market file's suggested auto-release days and cancellation steps. What a category file holds. Whether scopes are per market or per market and role. Whether a review also points at the post it is about. Whether the `markets` validator reuses `shapes/`' validator.
- **Money.** Whether one stablecoin holds for EU users. Which ramps accept a prefilled link with no partner account. Whether Crossmint or Onramper accepts a sole proprietor for production, and whether Crossmint's bank rails cover the first sellers' countries. Which wallet holds a pool's compliance attestation: on the central wallet it adds to what the ramp already knows; on a profile wallet it would put a person next to a profile. Whether an app offering a pool needs its own lawyer pass. Whether Kora's price counts the storage deposit the fee payer puts down inside a program call (a registration's code account, an escrow's accounts); if it does not, the fee payer pays that on the person's behalf. Who runs the fee payer: this file has Roots run an instance, since operations are paid in products.
- **Registry.** Confirm the wallet in the proof's message and the index rule on the declared wallet. Whether the Semaphore team publishes a transcript for the later artifacts. The per-market completeness circuit and its ceremony (the ceremony needs real independent contributors, so it waits for a public), and the proof that a sorted list matches the program's code tree, not built or costed. A later circuit proving the profile's key and the identity secret come from one seed, which closes badge selling entirely. When the foundation opens a second list of its own. A list's rent above its minimum sweeps to the treasury, though an outside issuer paid it (a code account's already does, though whoever registered paid it); sweeping to whoever paid would mean recording the payer, a program change possible only before deploy. A list's owner never changes: an issuer moving to a multisig opens a new list. How the index reads extra vouches from a folder, and how a market names the issuers it counts. Whether the registry also emits an attestation other Solana apps can read (parked). The treasury can accept a token it mints itself, a voucher by another name; only its own discipline, a multisig and a public policy stand against that. Whether a mainnet build should refuse to compile with the placeholder treasury and issuer key. How long Roots' random wait before a first registration is, sized from real joining rates.
- **Escrow** (each a program change, possible only before deploy). SOL sent to an escrow's address goes to the rent payer, not to whoever sent it. Tokens of another mint sent to an escrow's address are not recovered. An escrow funded after its own last deadline can be sent back at once, before the seller could accept. A frozen refund address (the token's freeze authority can freeze it) now blocks every ending that pays the buyer anything, not only the two anyone may send, until it is unfrozen; an ending that pays the buyer nothing still runs. `recover_late` and `close_unaccepted` also check who holds the refund address, so a buyer who hands it to another key blocks its own late money and the rent payer's deposit rent there, and nothing else. Whoever pays an escrow's rent waits out its last deadline, however far. Whether the wallets people use accept a program-derived address as a Solana Pay recipient (not tried on a phone).
- **Keys and host.** Whether a moved passkey keeps its PRF secret (the design assumes not). Whether a product also writes a seed file under the first passkey. Whether the host refuses an imported export whose root does not verify; whether it validates Forest records itself; how a move tells the old host and the carrier; whether an owner can deactivate or delete a folder without a session.
- **Names (later).** How the auction runs: its format, whether a name is held for good or renewed, and where the money goes.

## Don't resurrect

- **Protocol and storage:** chain posts; a Forest-written folder standard; the chain debate; a Forest-invented name system (names are AT Protocol handles under the foundation domain); user accounts anywhere; address logs.
- **Registry:** Semaphore's contracts deployed unchanged; the registry as a service for other apps; free registrations inside the program (ten free tokens, free-slot codes, vouchers or blind tokens); anything paid on someone's behalf built into the foundation; the treasury gating lists or issuers; numbered per-human codes; splitting the list on day one; depth 20; custom code inside Kora.
- **Identity and keys:** issuer-assisted recovery in v0; the face check as a product-side service; wallet infrastructure providers (Turnkey, Privy, Crossmint wallets) for keys; bring your own key (a seed from an existing wallet's signature); the 24 words as a login.
- **Reputation and evidence:** the cross-profile proof as v0; a per-human score that links profiles without the user choosing; a mutual-receipt evidence type; Bluetooth or NFC co-presence as evidence anyone can verify.
- **Escrow and markets:** escrow modes (fixed, per unit, capped; one shape only); market files that restrict a deal (an arbiter-allowed flag, a limiting token list); money entering each profile only from outside, with no central wallet.
- **Names:** a per-human handle market; one handle per human; names as core, or built before Roots.
- **Vendors:** Mercury; Bridge; Stripe Atlas; Ramp Network direct; Transak in v0; Meld; Commerce Kit; Private Channels; a UK Ltd in v0; Turso, Hetzner or any other host for v0 (Railway and plain SQLite files first; Hetzner once the host serves real photos).
- **Strategy:** recurring foundation revenue; manifesto-first; three long pages as the product; Mexico as a default for anything.

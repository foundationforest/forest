# Forest: foundation handoff (September 25, 2026)

The plan for the `forest` repo, as the design stands in the code today. Claude Code reads `CLAUDE.md` and this file before every session. Nothing is shipped: everything below is design, and "Build status and order" says what exists and where it has run. The reason behind each choice is in `docs/changes.md`. When something here turns out wrong, change it and say what changed there.

## What Forest is

Forest is an open environment where a person owns their profile, their offers and their reputation, and deals with strangers with no platform in the middle. Each person is checked once, by face, to be one real human. A profile is a free folder of signed records, and a person may hold many. A market is a name anyone can use. Any AI can read the records and, through one connection, act in them.

One sentence: one human, one record, any market, no one in between.

Why it works: accountability. You can't start over: one human gets one badge per market. Evidence exists: a verified human stakes their own reputation on a review, with the payment receipt underneath. Nobody can erase it: the records are signed, live in your own folder, and anyone can index them. The foundation supplies accountability; products get people paid.

Why now: four things became cheap in about three years, and Forest needs all four. Proof that someone is one unique human without a government (face liveness and deduplication as an API). Keys normal people can hold (passkeys). Money a program can hold at no cost per deal (stablecoins). A reader that needs no interface (AI agents). Global from day one; nothing is region-specific.

## The shape

A passkey on your phone unlocks a secret seed that never leaves the device. From the seed come all your keys: for each profile, the keys that sign its records and its own wallet, and for you as a person, one identity for the registry and one central wallet. Each profile is a folder of signed records kept by a host, which stores but never signs. A carrier passes the records to indexes; an index ranks them and serves pages that people and AIs read. On Solana, a registry gives one verified human one badge per market without saying who, and an escrow holds money between strangers and lets it out only when the two sides agree. The DID is the identity; readable names are a later feature. Products are thin apps on top; the first is Roots.

## Keys, profiles, badges

Three rungs of one ladder. There are no accounts anywhere.

1. **A key.** From a passkey, the one way in: the passkey makes the seed, and the 24 words are the only backup and the way to carry the seed anywhere. With a key you can pay, and pay into escrow.
2. **A profile.** A folder with a permanent name (a DID). Free, unlimited, nothing on chain. Needed before a badge. Reviews live in profiles, so a review needs one; an unbadged reviewer's review weighs near zero.
3. **A badge.** A face check once, then one registry entry per market. Reviews carry weight both ways.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Keys recipe | Passkey secret (WebAuthn PRF) to seed; seed to each profile's control key, signing key, wallet and DID, plus one identity secret and one central wallet per person. Seed file format for extra passkeys. The 24 words, the only backup | Ours: a spec and a small library from existing parts | The user's device |
| Folders | One per profile: profile, posts, reviews, credentials, photos, all signed on the device | AT Protocol lexicons and libraries, unchanged | The host |
| Host | Stores folders and serves the live feed; accepts only commits signed on the device; holds no signing key; keeps no address logs | Bluesky's reference PDS at a pinned commit, with its write path forked by five patches (`host/`) | Railway, plain SQLite files |
| Directory | Public cards: name, current key, current host | did:plc, run independently; the foundation keeps a replica | plc.directory |
| Carrier | Reads the Forest hosts an admin adds, checks every commit against its DID document, and serves the stream to indexes | Bluesky's relay, and Jetstream for indexes that want JSON, configured, no Forest code (`carrier/`) | Railway |
| Index | Reads the carrier; scores with an open ranking; serves the same data two ways on the same open pages, no login: pages for people, and for machines schema.org data on every page, a JSON twin of every page, a sitemap, `llms.txt` and the read skill; signs scores | Ours (`index/`) | Readers on Railway; pages on Railway or Vercel; one Postgres (Railway's or Supabase's); at forest.foundation |
| Registry | Sealed program: lists of verified humans that anyone may open and vouch for, one code per human per market, 25 cents per registration, the profile's wallet signing | Ours; Semaphore's circuit unchanged, groth16-solana, the Poseidon syscall | Solana |
| Fee payer | Co-signs a person's transaction as its payer and charges, in their dollar token, exactly what it spends: the network fee and any storage deposit it puts down, with no margin. So nobody needs SOL; it holds none of their keys and decides nothing | Kora 2.0.5, configured, no custom code (`feepayer/`) | Railway |
| Escrow | Sealed program: an amount of a classic token held between two keys, out only when they agree; any option is off unless the creator turns it on | Ours | Solana |
| Face check | Once: passive liveness plus deduplication. Didit holds the faces | Didit | Didit |
| Issuer flow | The foundation's issuer: it opens the face check, and turns a passed one into the person's identity commitment inserted into its own list, in batches; a request limit per address, its key from a sealed variable | Ours, small (`issuer/`) | Railway |
| Names (later) | Readable names under forest.foundation, paid, random or chosen by auction; built after Roots | Ours, small | Vercel and Supabase, with the index |
| Badge and pay link | On forest.foundation, so they outlive any product | Ours, in the index | With the index's pages |

## Foundation versus product

The rule: a piece that only works if everyone shares one is a public good and goes in the foundation; anything someone needs to compete with us is in the foundation; money flows and interfaces are products. Code is open in the foundation; operations are paid in products.

Four slots are open to anyone: issuers, indexes, evidence types and apps. The foundation runs the first of each; anyone may run another. Weights and interpretations live in indexes, never in programs.

- **Issuers** vouch that a person is one human. Issuers are an open slot: anyone may open a list in the registry, owning it and naming the keys that insert into it; the registry checks nothing about who an issuer is. The foundation runs the first, with Didit's face check, on the list `init` opens. One badge per market per issuer. Extra vouches ride in the folder. An index weighs which issuers count (see "Registry"). Any issuer can sign credentials.
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

Repos: `foundationforest/forest` (all foundation code, Apache 2.0) and `foundationforest/markets` (the directory: market files in category folders, CC0). The product org holds `roots`. Forest lives at forest.foundation; Roots at Roots' own domain (not bought yet).

## Keys

`keys/SPEC.md` is the recipe, exact enough that any product following it opens the same seed from the same passkey.

- **The recipe.** The passkey's PRF secret becomes a 32-byte seed by HKDF-SHA256. Every key is one more HKDF output from the seed under its own label, so knowing one key says nothing about another or about the seed. For each profile: a control key and a signing key (secp256k1; the DID's rotation key and its signing key) and a wallet (ed25519). The DID is made on the device from those keys.
- **The seed file.** A second passkey opens the same seed through a seed file: the seed encrypted under that passkey's secret, stored under a label derived from the same secret. A new device finds its file from nothing but its passkey; whoever stores the file learns nothing, and nothing in it names a person, a profile or a passkey. The first passkey needs no file.
- **The 24 words.** The seed as 24 English words: the only backup, and the way to carry the seed anywhere. A backup, not a login: they restore the seed onto a device, where a passkey then opens it. They open everything, so they are for paper only.
- **The passkey's domain.** The passkey belongs to forest.foundation. Products that use it are listed in `https://forest.foundation/.well-known/webauthn` (related origins), Roots first, so one passkey serves every product.
- **The identity secret.** One per person, with no profile index, so the registry holds one entry per human while profiles stay apart. Only its commitment leaves the device, once to each issuer that vouches for the person. Losing the seed loses it for good: the badges stay, and the same issuer's list does not take the person again, because its face check finds the face already there.
- **The central wallet.** One per person, with its own label and no profile index, so it links to no profile's keys. See "Wallets".
- **No recovery** without a passkey or the words. A passkey moved between providers is assumed to lose its PRF secret and needs its own seed file.
- **No gesture per write.** A write needs only the seed unlocked for the session; the signing key then signs from memory. A product may add a prompt; the host cannot tell.

## Registry

A sealed Solana program that gives one verified human one badge per market, without saying which human.

- **Lists.** Each verified human adds one identity commitment, made on their device, to a list: a Merkle tree of depth 32 that the list's insert keys can insert into, hashed exactly as Semaphore's circuit hashes (Poseidon, through Solana's syscall). Anyone may open a list: whoever opens it pays its rent and is recorded as its owner and its first insert key, and only the owner adds or removes its insert keys (up to eight), closes it, or hands it over. A handover is two steps, like the treasury's: the owner proposes a key, and nothing moves until that key signs to accept; then ownership moves and nothing else, the insert keys staying as they were. That is how an issuer moves to a multisig or away from a leaked key without a new list. The treasury has no say over any list. `init` opens the first, owned by the foundation's issuer key, a program constant. An issuer with more than one open list assigns its new joiners randomly across them, so a list never tells when someone joined. The first list is not split on day one. Issuers insert in batches.
- **Issuers are an open slot.** The registry checks nothing about who opens a list; every registration's entry names the list and its owner, so an index can weigh a badge by who vouched. One badge per market per issuer: a code comes from a person's secret and the market, whichever list the proof is made against, so a second badge in the same market needs a second secret on another issuer's list. Extra vouches ride in the folder: a profile may keep proofs of its secret against other issuers' lists, made with the badge's market as scope so they show the badge's code, and anyone checks them against those lists' fingerprints (their roots) on chain. That needs no program change and is not built. An index weighs which issuers count: the foundation's by its own issuer weights.
- **The proof.** Semaphore's circuit unchanged, with the artifacts of the public July 2024 ceremony (4.0.0, depth 32) and the matching library pinned; not the later artifacts, whose second phase has no published transcript. Forest writes only the Solana side: the verifier glue (groth16-solana; the first proof point is negated), the trees, the used codes and the rules.
- **A registration** is one transaction: the market name, the profile's DID, one proof whose scope is the market name, the list root the proof is made against, the code, and the fee. The code is the proof's nullifier: the same for one human in one market, unguessable for anyone else. An account at an address derived from the code is what makes it once per human per market.
- **The fee.** One rule: 25 cents in USDC, always; other accepted tokens at the fee set for them. USDC's address and its 0.25 fee are program constants that nothing can change or remove. The treasury may accept up to fifteen more classic tokens, each at a fee above zero set once in that token's own units and meant to be worth 25 cents; nothing changes a token's fee and nothing removes a token. There are no free slots, no numbered codes and no vouchers in the program.
- **The profile signs.** The profile's wallet signs every registration, whoever pays, and the proof's message names that wallet and the DID, so a proof counts for one market, one profile and one wallet. The entry in the log names the wallet; a badge counts for a profile only when its profile record declares that wallet. A human who holds another profile's wallet can still badge it; the later circuit under "Open" closes that.
- **Names are hashed.** The scope is a hash of the namespaced market name, and the message a hash of the wallet and the namespaced DID, so a name or a DID can be any length. The program recomputes both. It accepts any scope. The recommended scope is `market/role`, such as `plumbing/seller` (see "Markets").
- **Everyone pays.** The program charges everyone: the 25 cents come from the fee authority's tokens, and the network fee and the storage deposit from the transaction's payer, while the profile's wallet signs. Whoever signs to pay, pays. A payer may pay for someone else; the program cannot tell and never needs to. Nothing in the foundation is built to pay on anyone's behalf.
- **The treasury.** The first treasury is a program constant, and `init` writes only constants, whoever sends it. One treasury key receives every fee and every sweep but a list's, and turns every dial. It moves in two steps: the current treasury proposes a key, and nothing moves until that key signs to accept; until then the old key keeps everything and may change or clear the proposal. A treasury key, and a list owner's, holds a little SOL before it can receive a small sweep.
- **The dials.** The treasury accepts a token at a fee and hands itself over, and every rent sweep but a list's pays it. Nothing else: each list is its owner's. Proofs against a closed list stay valid forever, and nothing deletes a list.
- **Recent roots.** A proof against any of a list's last 128 roots is accepted, so a proof made just before someone else joins still lands.
- **No removals.** Once a human is in a list, they stay. Removing an insert key removes no one. A duplicate that passes the face check cannot be undone in v1.
- **The rent sweep.** Anyone may send `sweep_rent`. It moves only what a registry account holds above its current rent-exempt minimum: a list's to the list's owner, whoever paid its rent (whoever pays should get it back, and the program records the owner), and the config's, the code tree's and a code account's to the treasury; it touches nothing else. Solana is cutting the rent rate in steps, and only the owning program can move the difference.
- **Size.** A registration is 832 bytes of the 1,232 limit (v0 transaction) and 9.5 to 9.7% of the compute limit: compressed proof points, a standard transaction, no address lookup table.
- **Sealed per version.** The upgrade key is removed after deploy. A v2 is a new program with new lists, so v1 must be right. First sellers use v1 on devnet before mainnet.
- **The completeness proof, later, from the same data.** Every code also goes into an append-only tree the program keeps (`docs/decisions/used-code-storage.md`). Later, a person can show "my badges, none hidden" with one small proof per market in the directory, each saying "my code is present" or "absent", all sharing one proving key. Absence is proven against a sorted list the verifier (a buyer's app or an index) rebuilds itself and checks against the program's tree, so nothing is trusted. That circuit and its ceremony come later; the registry does not wait for them.

## Escrow

Money in, and out only when the two sides agree. Every option is off unless the creator turns it on.

- Either party creates the escrow and signs, naming both keys, the token and the amount. Its address comes from the creator's key and an id, so nobody can open an escrow at an address another key will use. A seller-created escrow is an invoice. Neither party may be the escrow's own address or its deposit address.
- Money arrives by plain transfer to the escrow's own deposit address. The escrow is funded while that address holds the amount: every way out checks the live balance. Anyone may mark the funding, which records the time for the timer and nothing else.
- Once funded, three ways out: the buyer releases everything to the seller; the seller releases everything to the buyer; or both sign a split. Receiving in full never needs a signature, so each side alone can give, and only together can they divide. Every way out pays out the whole balance, whatever it holds.
- Each side is paid only at its standard token account for the mint, on every way out.
- Optional, chosen at creation, off by default: an arbiter, any key the creator names, a party included, that may decide any split; a timer that N days after the marked funding lets anyone send everything to one named side. No other clock exists in the program.
- Cancellation and refund are not features: they are the seller releasing to the buyer, or a split. Anything about when or why lives in the offer, in the market's conventions, and in reviews.
- A finished escrow stays as a permanent receipt at its address. Money sent to it after the end can be forwarded to the buyer by anyone. An escrow that never held the amount can be closed by either party.
- Every rent refund goes to the creator, whoever fronted the rent: the deposit address's at every ending, both rents when a never-funded escrow closes, and whatever anyone sweeps above the current minimum. A fee payer that fronts the rent charges the person for it, so the refund reaches the person.
- A payment in the same transaction as `create` makes the deposit address first, as its own instruction, so a fee payer that checks every transfer's destination before it signs can sign "Pay". The escrow client builds every such payment that way, the one tap included (create, pay and release at once).
- Parties are keys; the program never knows about profiles. Classic SPL tokens only; wrapped SOL refused. Sealed per version; new deals use the newest.
- Every state change is emitted so indexes can read outcomes: `Created` (with who created it), `Funded`, `Ended` (with how and what each side got), `Closed`, `RecoveredLate`, `RentSwept`.

## Wallets

A person has one central wallet and one wallet per profile. The central wallet is where money enters from a ramp and leaves to one; it never pays a seller and never receives from a buyer. Every deal touches only profile wallets, so receipts bind to profiles.

Moves between the central wallet and a profile wallet are where profiles could be linked on chain, going in and above all coming out, since every seller cashes out to one place. A privacy pool and a ramp are features an app offers and a user chooses; any app may offer any provider. Hinkal is the first pool candidate and Crossmint the first ramp. Forest never builds either: no code, no embed. An app that moves money through a pool moves round amounts after a random wait; a move the user makes without one is direct, and its button says it connects the two on chain.

## Deals and evidence

- **Every interaction is a deal** with a deal id: 32 random bytes chosen at creation. When an escrow exists, its address is the deal id.
- **A review is a signed claim** by one profile about another, usually about one deal. A review can be as thin as pointing at a person; what is missing weighs less; nothing is refused. Two reviews across one deal id are the two sides' receipts; no other record is needed for that.
- **Evidence** shows a deal happened beyond the parties' word. There is one evidence type so far: the escrow's permanent receipt. A market file lists the evidence types that apply. Evidence weighs, it never rejects: a review without it is valid and weighs near zero.
- **Indexes weigh, programs never interpret.** An index weighs a review by the reviewer's own trust and by the evidence under its deal, and decides which tokens it counts.
- **Who said yes.** An index weighs a receipt by who agreed to the deal. It counts fully when the seller signed for it: created the escrow (an invoice), signed its ending (a split, or a release back to the buyer), or reviewed the deal. A payment the seller signed nothing for is a real receipt, but one-sided. Anything else weighs near zero.
- **No co-presence proof.** No evidence proves two people met in person: two people who agree to lie can relay their devices from anywhere, and no phone signs a physical measurement. Collusion is bounded by identity (one badge per human per market) and by reviewer trust.
- **Every payment can have a receipt.** A product may make every payment an escrow, even one released in the same second, so each payment has an address a review can point at. That is a product default, not a program rule.

## Reputation

- **Two scores per profile, never blended:** uniqueness (which issuers vouched) and trust (an open algorithm over the reviews a profile received, each weighted by its reviewer's own trust and by the evidence under its deal). Everyone starts at zero; a badge means real and accountable, not good.
- **Three tiers across one person's profiles,** each the user's choice. Public linking: a signed record in each profile pointing at the others. Private disclosure to one buyer: the seller's app signs "these profiles are mine" with each profile key, encrypts it to the buyer's key, and shows, for every other market in the directory, either the badge or that no code of theirs exists there; the buyer checks the chain; disclosing to a buyer is disclosing. And later, a zero-knowledge aggregate.
- **Signatures ready for later.** The index signs every score with a ZK-friendly signature (EdDSA over Poseidon) alongside the normal one, so the later circuit never needs an expensive signature check.

## Record shapes

Four shapes, shared by every market, as AT Protocol lexicons in `shapes/`. Market files add fields, never new shapes.

- **Profile:** name, photo, contact, what I do, declared wallet. One per folder.
- **Post:** direction (offer or request), market, role, description, price (an amount, the token named by its mint, and per hour, day or job), and optional terms, availability, remote, location and expiry. The terms hold only the escrow's two options, each off unless set: an arbiter key, and a timer (days from funding, and whether it pays the seller or the buyer).
- **Review:** about whom (a DID), the one required field; and, all optional, a rating from 1 to 5, text, and a deal id (`dealId`): the escrow's address when an escrow exists, else 32 random bytes as hex. A review can be as thin as pointing at a person; what is missing weighs less; nothing is refused.
- **Credential:** a W3C verifiable credential with its issuer's DID, one copy per profile. Nobody issues credentials yet; the shape exists so nothing changes when they arrive.

A market file holds its name, its category, an optional one-line description, its roles (seller and buyer unless it names others), extra fields, the evidence types that apply and the credential issuers it recognizes. It says nothing about money or time. Records are validated on the device before they are written.

## Markets

- Anyone can make any market. A market is a name; a badge is a code made from your secret and that name; the registry accepts any name. Nothing is excluded, prohibited or approved by the foundation.
- The `markets` repo is the foundation's directory: the spellings it recommends so one trade doesn't split into ten names, grouped in categories for reading, with a table of each market's other spellings (its aliases). An index reads the directory from that repo, never from a copy of it.
- The recommended scope for a badge is `market/role`, with a slash, for example `plumbing/seller` and `plumbing/buyer`, so a person can hold two profiles in one market, one per side.
- The foundation's index counts a badge only under `market/role`, the market a name in the directory byte for byte and the role one of that market's roles. A plain `market` badge, a badge under an alias and a badge under any other name carry no weight in it. It groups posts written under an alias with their market. Any other index weighs as it chooses.
- A market file names the market, its category, its description, the evidence types that apply, and the extra fields an offer in it usually carries. It suggests nothing about money or time; those are the seller's per offer.
- Categories are folders and pages, never a program concept. Later shapes are new folders.

## Names

- Names are a later feature, not core. A name is convenience, not identity: the DID is the identity.
- At creation the app gives a folder the random name the folder software requires, under the app's own domain (for Roots, Roots' own domain), and nobody sees it.
- Readable names under forest.foundation are a later paid feature, random or chosen, by auction, built after Roots, not before. A name is an AT Protocol handle: a domain name that resolves to the DID while the DID points back; the user can move it, and the DID never changes. Choosing the same word on two profiles links them: the user's choice, said in the copy. The foundation never judges disputes.

## Host, carrier, index, fee payer, issuer flow

All five are built and tested on one machine, and none is deployed.

**Host.** Bluesky's reference PDS at a pinned commit plus five patches in `host/`. Every commit is signed on the device in two phases: the host prepares the unsigned commit, the device signs it with the profile's signing key, and the host checks the signature against the DID document before storing it. A folder is created by its first device-signed commit, from a DID made on the device. The host holds no signing key for any folder, needs no account, email or password (the device signs a short token per call), and keeps no address in its logs. A folder moves to another host by pointing the DID there and importing its export. It runs on plain SQLite files and a folder of photos.

**Carrier.** Bluesky's relay and Jetstream, configured, with no Forest code (`carrier/`). The relay reads only the hosts an admin adds, checks every commit against its DID document, and serves every record on them as one stream. Jetstream turns that stream into JSON, and an index that wants JSON asks it for Forest's record types (`foundation.forest.*`), plus the account and identity events. Neither piece knows which profiles are registered, and neither drops a record outside Forest's types; each index does both.

**Index.** Two processes on one Postgres (`index/`). The readers take records from the relay's own stream with Bluesky's consumer, checking every commit's signature against its DID document themselves and keeping only Forest's record types, each checked against `shapes/`; and they take the registry's and escrow's events from the chain, only those the programs themselves wrote. They score every profile and sign each score twice, with Ed25519 and with EdDSA over Poseidon. They run on Railway, since they hold a websocket and a poll loop. The pages serve the same data two ways at the same open URLs with no login: pages for people (category, market, profile, deal, search), plain HTML with no JavaScript and no crypto words, and for machines schema.org data on every page, a JSON twin of every page (the same URL with `.json`), a sitemap, `llms.txt` and the read skill (`skill.md`). They run on Railway or Vercel. The index reads the market directory and its aliases from the `markets` repo at start. It counts a badge only under `market/role` in that directory and only when the entry's wallet is the profile's declared wallet, weighs a badge by the list owner the entry names, weighs deals by who said yes, and counts only the tokens its config names (USDC). The reading rules adversarial review 1 found (only log entries the programs themselves wrote, market names compared byte for byte, its own archive of the logs) are in `docs/decisions/adversarial-review-1.md`. Every offer has a Pay link: an https link at the index naming the offer's record and its content id, and its price and terms, with no seller key, so an app reads the seller from the profile and a forged link cannot redirect money (`index/PAYLINK.md`). Once an escrow exists, the escrow client's Solana Pay link names the escrow's address, from which the wallet finds the deposit address.

**Fee payer.** Kora 2.0.5, configured, with no custom code (`feepayer/`): it co-signs a person's transaction as its payer and charges, in their dollar token, exactly what it spends, the network fee plus every storage deposit it puts down, plus Kora's fixed 50 lamports for the payment instruction, and no margin. It allows five programs and no priority fee, and refuses to let its own key move SOL or tokens. It holds none of the person's keys and decides nothing. In a registration it is the transaction's payer, of the network fee and the code account's storage deposit, while the profile's wallet pays the 25 cents and signs; nothing it sees lets it take a badge. In an escrow it fronts the rent, which comes back to the person as the creator.

**Issuer flow.** The foundation runs the first issuer, on list 0, which it owns (`issuer/`). The app asks it to open a Didit face check (passive liveness and a duplicate-face search; Didit holds the faces), then sends the session and the person's identity commitment; the issuer accepts only an approved session on its workflow with every liveness step passed and no duplicate face, and a session once. It inserts the waiting commitments into its list in batches, hourly or at 50, shuffled, one transaction each. It keeps the used sessions hashed and the waiting commitments, never next to each other, and logs no address, session or commitment. A network address may open a few face checks an hour (five by default), counted in memory under keyed hashes. On Railway its key comes from a sealed variable, written at start to a private file that is deleted once the key is loaded. Nothing server-side holds a person next to a profile. A person who loses their seed cannot join the same issuer's list again: the face is already there. Anyone may run another issuer on a list of their own.

## What Roots needs from the foundation

- The keys recipe as a library; the host fork; the fee payer's config; the record shapes and validator; the issuer's three routes (open a face check, submit, status); the registry client (build a proof on the device, send it through a fee payer); the escrow client (every payment with the deposit address made first, and the check a person runs before working or paying); the index's pages, twins and Pay link.
- Roots adds only its page, its host instance, its seed-file store, its instance of the fee payer, the ramp and pool it offers, and the door (MCP).
- At creation Roots gives each folder the random name the folder software requires, under Roots' own domain; nobody sees it.
- Money follows "Wallets": ramp links pay into and out of the central wallet only; every deal is paid from and to profile wallets only.
- Roots waits a random interval, minutes to hours, between a person joining the list and their first registration, and the issuer inserts identities in batches, so a badge cannot be matched to a face check by timing.
- A write from Roots needs only the seed unlocked for the session, never a passkey gesture per write.

## Build status and order

How work splits: a chat with Carlos decides (stress tests, searches, anything that isn't code). Claude Code builds: one task per session, plan mode first; "should we" questions go to `docs/changes.md` as open items, not decisions. Carlos does what only he can: accounts, passwords, money, the entity, the first sellers. At the end of every session `docs/changes.md` gets three lists, built, learned and open; this file never marks design as done.

**Built and tested locally, nowhere else.** Nothing is deployed: no devnet, no mainnet, no Railway or Vercel service, no Kora in front of a real network, no real face check, no proof on a phone. Every package's checks and tests pass together on one machine, and `.github/workflows/checks.yml` runs them in GitHub Actions: each package's type-check and fast tests, and both programs' LiteSVM tests, on every pull request and on `main`; the validator tests, the fuzzers' long campaigns and the end-to-end runs (host, carrier, fee payer, index) nightly and by hand.

- `shapes/`: the four lexicons, the market template, the validator and its command line, one example of each.
- `keys/`: the recipe spec and library with pinned test vectors. A passkey-derived seed came out identical on iPhone and Mac; the library's tests on Apple, Android and Windows devices are not run.
- `registry/`: the program, the client, the pinned ceremony files; tests under LiteSVM and on a local validator, and a property test.
- `escrow/`: the program and the client, as "Escrow" above; tests under LiteSVM and on a local validator, a fuzzer, and the security checklist.
- `issuer/`: the service, against a stand-in Didit and a local validator.
- `feepayer/`: Kora's configuration, run in front of a local validator: a wallet with no SOL registers and pays for escrows in a test dollar, charged once for each deposit, every refund back to it.
- `carrier/`: the relay and Jetstream, configured, run against a local host.
- `index/`: the readers, the scores and their signatures, the pages and their twins, the read skill, `llms.txt` and the Pay link, end to end on a local host, validator and Postgres, with the directory read from the `markets` repo.
- `host/`: the fork, with end-to-end tests against a local directory and two local hosts.
- `devnet/`: the devnet build (keys put into a copy of the source), deploy script, key script (every key derived from one phrase), and the public record; the run itself is in the two clients' `scripts/devnet.ts`, with read-only smoke tests (`npm run test:devnet`). The deploy key holds 2.0 SOL; both deploys need about 3.2 at the escrow's present size, and the payer 0.2 more (estimated; `docs/devnet.md`, whose escrow numbers are stale).
- `testsite/`: a static site for trying the keys page on real phones; not online.
- The `markets` repo: the directory, 18 markets in three categories, each with its aliases.
- Reports: `registry/FEASIBILITY.md` and `docs/decisions/` (used-code storage, the host, adversarial review 1 of both programs).

**Next, in order.**

1. **Devnet.** Fund the deploy key, deploy both programs as they are, and run `docs/devnet.md`, rewritten for the escrow as it is.
2. **Services online.** The host, the carrier, the index (its pages at forest.foundation), the fee payer and the issuer, on Railway and Vercel, against devnet.
3. **The full loop on devnet, by script:** verify, register, post, get found, get paid, get reviewed, through the services.
4. **An independent AI attack pass on both programs.**
5. **Then Roots.** Names come after Roots.

**Before mainnet.**

- **Real keys, placeholders replaced.** A real treasury key and the foundation's issuer key replace the registry's two placeholders, which anyone with this repo can sign for, everywhere they are written (the program, its tests, the client, and the index's issuer weights); fresh program ids; the fee payer's, the issuer's and the index's own keys.
- **The newer program format.** Both programs build as SBPF v0, which deploys today. Once SIMD-0500 activates, a sealed v1 must be deployed first or rebuilt and tested for a later SBPF version.
- **The attack pass** above, and then one paid review of both programs and the key handling by someone who has shipped Solana programs.
- **One lawyer pass** over the escrow program, the fee payer, the ramp referral and biometric data responsibility.
- **Three markets** with sellers who ran the loop on devnet.
- **The foundation entity** (a UK company limited by guarantee; it forms before the first stranger's real face or the first grant application), owning the Didit account and the forest.foundation domain.
- **Sealing.** Each program's upgrade authority removed the day it deploys (`--final`), and "Authority: none" checked.

Done when one stranger, with their own USDC, completes verify, register, post, get found, get paid, get reviewed, alone.

## Building in parallel

- Sessions may run at once when they own different folders.
- Each such session writes its built, learned and open only to its own log, `docs/changes/<topic>.md`, and never edits `docs/handoff.md` or `docs/changes.md`. No parallel session owns `shapes/`, so none edits it; a change one needs goes in its log as an open question.
- Afterward, a consolidation session folds the logs into this file and `docs/changes.md`.
- Nothing is running in parallel.

## Open

One list. Each item says what it waits on: **needs Carlos** (a decision, an account, money or a person) or **mechanical** (work anyone can do without a decision). An escrow or registry item marked "program" can change only before that program deploys.

**Markets**

- Which three markets launch first. *Needs Carlos.*
- Whether a review also points at the post it is about. *Needs Carlos.*
- The registry takes a scope of at most 64 bytes, while a market file allows a name and a role of 64 characters each, so a long `market/role` can never be registered: the market validator refuses such a pair, or the registry's bound rises (program). *Needs Carlos.*
- Whether a market file keeps `credentialIssuers`. *Needs Carlos.*
- How a change to an existing market file is merged: renaming a market strands every badge under the old name. *Needs Carlos.*
- Whether the market page's count of verified real people counts sellers only; it counts every counted badge in the market, buyers' included. *Needs Carlos.*
- The `markets` repo recommends `market:role` with a colon (`directory.md`, `README.md`, `CLAUDE.md`), which the foundation's index does not count; it moves to the slash. *Mechanical.*
- The `markets` repo's `check.sh` does not check that every market file is listed in `directory.md`, which is what the index reads, and checks the alias table as it stands in the pull request, not against `main`; the repo runs no check on pull requests. *Mechanical.*
- The index reads the directory once, at start, so a change in the `markets` repo reaches it at its next restart; a refresh on a timer. *Mechanical.*

**Money and the fee payer**

- Whether one stablecoin holds for EU users. *Needs Carlos.*
- Which ramps accept a prefilled link with no partner account. *Mechanical.*
- Whether Crossmint or Onramper accepts a sole proprietor for production, and whether Crossmint's bank rails cover the first sellers' countries. *Needs Carlos.*
- Which wallet holds a pool's compliance attestation: on the central wallet it adds to what the ramp already knows; on a profile wallet it would put a person next to a profile. *Needs Carlos.*
- Whether an app offering a pool needs its own lawyer pass. *Needs Carlos.*
- Who runs the fee payer, and its operations loop: someone keeps SOL on its key and turns the dollars it collects back into SOL. With no margin it sells SOL at its price source's rate, with nothing for that source's error. This file has Roots run an instance. *Needs Carlos.*
- Refunds arrive as SOL in a wallet that otherwise holds none: left there, paid out at ramp-out, or taken by the fee payer as payment (Kora can accept SOL as a paid token); the copy never says "SOL". *Needs Carlos.*
- Priority fees: the fee payer allows no compute budget program, so no transaction carries one, and under congestion one may land late. Keep the five programs, or add the sixth and let the person pay for it. *Needs Carlos.*
- A payment address apart from the fee payer's key, so what it collects sits under a colder key. *Needs Carlos.*
- Kora 2.2, once stable: it hardens the fee payer against being drained, and it takes the key itself, not a path. *Mechanical.*
- Which tokens the index counts: USDC only; whether the treasury's other accepted tokens count too. *Needs Carlos.*

**Registry**

- Confirm the wallet in the proof's message, and the index rule on the declared wallet. *Needs Carlos.*
- A code account's rent above its minimum sweeps to the treasury, though whoever registered paid it; sweeping it to the payer means recording the payer (program). *Needs Carlos.*
- Whether a mainnet build refuses to compile with the placeholder treasury and issuer key (program). *Needs Carlos.*
- The treasury can accept a token it mints itself, a voucher by another name; only its discipline, a multisig and a public policy stand against that. *Needs Carlos.*
- Anyone can open lists without limit, each at its opener's rent, and an index grows with them. *Needs Carlos.*
- When the foundation opens a second list of its own. *Needs Carlos.*
- How an index reads extra vouches from a folder, and how a market names the issuers it counts. *Needs Carlos.*
- Whether the registry also emits an attestation other Solana apps can read (parked). *Needs Carlos.*
- The per-market completeness circuit and its ceremony, which needs real independent contributors and so waits for a public, and the proof that a sorted list matches the program's code tree: not built or costed. *Needs Carlos, later.*
- A later circuit proving the profile's key and the identity secret come from one seed, which closes badge selling entirely. *Needs Carlos, later.*
- How long Roots' random wait before a first registration is, sized from real joining rates. *Needs Carlos, later.*
- Whether the Semaphore team publishes a transcript for the later artifacts. *Mechanical.*
- A phone and the issuer find a list's members by reading every transaction that touched it: fine at thousands, not at millions. The issuer or an index publishes the members, checked against the root as the client already does. *Mechanical.*
- Both programs built for a later SBPF version (`cargo build-sbf --arch v3`) with Anchor 1.2, groth16-solana and the Poseidon syscall, which nobody has tried. *Mechanical.*
- Whether the devnet builds are byte for byte reproducible on another machine. *Mechanical.*
- `registry/program/trident-tests/` keeps a stale model and cannot run; `invariants.rs` is the one kept current. Update it or remove it. *Mechanical.*

**Escrow**

- Frozen accounts: a classic mint's freeze authority (USDC has one) can stop every way out by freezing the deposit address, and every way out that pays a party by freezing that party's standard account, with no way round (program). *Needs Carlos.*
- Whether a way out records the funding time when nobody marked it, so every receipt says when the money was there (program). *Needs Carlos.*
- `recover_late` checks who holds the buyer's standard account, so a buyer who hands it away blocks only its own late money (program). *Needs Carlos.*
- SOL sent to an escrow's address goes to the creator by `sweep_rent`, not back to whoever sent it, and tokens of another mint sent there are not recovered (program). *Needs Carlos.*
- Whether the wallets people use accept a program-derived address as a Solana Pay recipient; not tried on a phone. *Mechanical.*

**Issuer and face check**

- A passed face check that never reached the issuer, the device lost between the check and the submit, locks the person out: the face is Didit's, and the session is gone with the device. *Needs Carlos.*
- A manual approval in Didit's console keeps the duplicate warning, so the issuer still refuses a false duplicate a person has cleared: a path for a false positive. *Needs Carlos.*
- `/submit` has no limit: each one asks Didit for a decision, which spends Didit's rate limit. *Needs Carlos.*
- Whether two face checks by one person at the same moment see each other in Didit's duplicate search; ask Didit. *Mechanical.*
- The Didit client is tested against a stand-in built from Didit's documents; its first real run compares a real decision with `parseDecision`. *Mechanical.*
- The request limit: people behind one shared address share five face checks an hour, and its memory grows with the number of addresses in an hour; both for real traffic to size. *Mechanical.*

**Hosting and privacy**

- Address logs at the hosting platforms: Railway keeps every request's client address and path for 3 to 90 days, with no documented way to turn it off, and Vercel's request logs are not checked. That conflicts with "no address logs" for every service: accept it, find a host that does not log, or put something in front. *Needs Carlos.*
- Which apps open a Pay link: for an app to take the https link directly, the domain must list it in Apple's and Android's app-link files, like the passkey's related origins. Which apps, and on what rule. *Needs Carlos.*
- Where the index's signing seed lives: the deploy's secrets, or a key service. *Needs Carlos.*
- The index claims forest.foundation's root, so the passkey's `/.well-known/webauthn` and any app-link files are served by the same deployment or routed around it. *Mechanical.*

**Index**

- Collusion by real small deals: two real people who pay each other small escrows gain full evidence each time. A minimum amount per counted token, less weight for repeat deals between the same two, or both. *Needs Carlos.*
- An unbadged profile can declare someone else's wallet and be matched to that wallet's receipts, gaining at most the 0.05 floor. "A wallet counts only when a badge proves it" closes that, and makes an unbadged buyer's receipt count as none. *Needs Carlos.*
- A review with no rating counts as neutral; "what is missing weighs less" could also mean a thin review is a small positive vouch. *Needs Carlos.*
- The 1 to 5 rating machines get, made from trust alone as `3 + 2·t/(|t|+1)`: acceptable, or only the raw trust and its counts. *Needs Carlos.*
- Languages: the pages are in English only. Which languages, and whether a page follows the reader's browser or its own URL. *Needs Carlos.*
- Photos: showing a profile's photo means linking to its host, which then sees each visitor's address, or the index fetching and serving it. *Needs Carlos.*
- Escrow versions: the reader follows one escrow program id; new versions need a list of ids, each with its adapter. *Mechanical.*
- Backfill and moves: records come from the firehose from the index's cursor on; a folder imported on another host, or history older than the firehose keeps, needs `getRepo` and `verifyRepo`, and identity and account events are not acted on. *Mechanical.*
- Signing takes about 88 ms a score in JavaScript, inside one database transaction: a worker, batching outside it, or a faster library before real traffic. *Mechanical.*
- The index's log archive has only the RPC's word for what the logs say: a second RPC to cross-check, or reading the receipt accounts too. *Mechanical.*
- Scale: a profile page lists every review, the sitemap is one file, offers are ranked with correlated subqueries, every page is computed per request behind a 30-second cache, and the pool takes 10 connections where a serverless instance wants 1. *Mechanical.*
- The read skill's examples are the tests' data; they change to real ones once a real market has profiles. *Mechanical.*

**Carrier, host and keys**

- "Forest records only" is each index's filter, and "registered profiles only" is nobody's. The index filters both, reading the registry itself; or the host refuses records outside `foundation.forest.*`, which makes the relay's stream Forest-only at the source. *Needs Carlos.*
- The relay passes a commit on unchecked when a DID stops resolving: accept it, or have indexes that must be sure read the relay's own stream and check signatures themselves. *Needs Carlos.*
- Whether the carrier keeps Jetstream: the foundation's index reads the relay's own stream and checks every signature itself, so Jetstream serves only an index that wants JSON. *Needs Carlos.*
- Who decides what a Forest host is: an admin adds each one. A list the foundation keeps, or open `requestCrawl` with the rest left to the indexes' filters. *Needs Carlos.*
- Whether the host refuses an imported export whose root does not verify; whether it validates Forest records itself; how a move tells the old host and the carrier; whether an owner can deactivate or delete a folder without a session. *Needs Carlos.*
- Whether a product also writes a seed file under the first passkey. *Needs Carlos.*
- A relay admits 100 active folders per host by default: raise it per host, or list trusted hosts, before any host grows past that. *Mechanical.*
- jetstream-legacy has had no commit since April 2026; if Bluesky retires it, its rewrite or Tap per index replaces it. *Mechanical.*
- How the host's five patches rebase on a newer upstream. *Mechanical.*
- Whether a moved passkey keeps its PRF secret (the design assumes not). *Mechanical.*
- The keys library's tests on Apple, Android and Windows devices. *Mechanical.*
- The keys library and its test page call the 24 words a "paper export" (`keys/src/words.ts`, `keys/test-page`, `testsite/keys`); they are the backup. *Mechanical.*

**Devnet and checks**

- Funding the devnet deploy: about 1.4 SOL more on the deploy key (`2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A`), from faucet.solana.com signed in with GitHub, anyone holding devnet SOL, or a Helius or Ankr key given to the session. *Needs Carlos.*
- The checks' first runs: the pull-request jobs first ran on the pull request that added them, and the nightly jobs run first after it merges. Whether they pass on GitHub's machines as they do locally, and how long the programs job takes there. *Mechanical.*

## Don't resurrect

- **Protocol and storage:** chain posts; a Forest-written folder standard; the chain debate; a Forest-invented name system (names are AT Protocol handles under the foundation domain); user accounts anywhere; address logs.
- **Registry:** Semaphore's contracts deployed unchanged; the registry as a service for other apps; free registrations inside the program (ten free tokens, free-slot codes, vouchers or blind tokens); anything paid on someone's behalf built into the foundation; the treasury gating lists or issuers; numbered per-human codes; splitting the list on day one; depth 20; custom code inside Kora.
- **Identity and keys:** issuer-assisted recovery in v0; the face check as a product-side service; wallet infrastructure providers (Turnkey, Privy, Crossmint wallets) for keys; bring your own key (a seed from an existing wallet's signature); the 24 words as a login.
- **Reputation and evidence:** the cross-profile proof as v0; a per-human score that links profiles without the user choosing; a mutual-receipt evidence type; Bluetooth or NFC co-presence as evidence anyone can verify; the passkey handover experiment (two phones showing they were together).
- **Escrow and markets:** escrow modes (fixed, per unit, capped; one shape only); market files that restrict a deal (an arbiter-allowed flag, a limiting token list); money entering each profile only from outside, with no central wallet.
- **Names:** a per-human handle market; one handle per human; names as core, or built before Roots.
- **Vendors:** Mercury; Bridge; Stripe Atlas; Ramp Network direct; Transak in v0; Meld; Commerce Kit; Private Channels; a UK Ltd in v0; Turso, Hetzner or any other host for v0 (Railway and plain SQLite files first; Hetzner once the host serves real photos).
- **Strategy:** recurring foundation revenue; manifesto-first; three long pages as the product; Mexico as a default for anything.

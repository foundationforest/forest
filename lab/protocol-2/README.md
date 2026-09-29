# Protocol 2: where people's records live

A lab report, September 29, 2026. A design, a spec (`SPEC.md`), a prototype (`src/`), tests that
try to break it (`test/`, `CLAIMS.md`), and this session's log (`CHANGES.md`). Nothing here is
shipped, and nothing outside this folder was changed.

## Page one, in plain words

**What I recommend.** Replace the current data layer (the AT Protocol server with our five patches,
plus Bluesky's directory of names) with a much smaller protocol of our own shape, built entirely
from standard parts. In it, a profile is a signed diary: a list of entries, each signed by the
person's key and each pointing at the one before it. A host is a plain server that stores diaries
and checks them; it never signs and never has a key. Where a profile lives is a small signed note
that can sit on the same public network BitTorrent has used for fifteen years, on any host, or in
any index. The four record shapes, the passkey recipe, and both Solana programs stay as they are.

**Why.** Three of the eight things that must be true cannot be made true on the current layer
without rewriting it into something non-standard anyway:

1. An AI acting for you while your phone is off. The current design has exactly one key that may
   sign, and it lives on the phone. New design: you sign a grant, once, on your phone; the AI
   then writes with its own key, inside the limits you set, until you revoke it.
2. Private records. The current layer has none, and the people who run it are still designing
   theirs. New design: a private record rides the same diary, encrypted on your device; a host
   stores it without being able to read it.
3. No central directory. Today every profile is registered with one server run by one company.
   New design: the profile's name is its key; nothing to register anywhere.

Everything else the current layer does well, the new one does with a tenth of the code. The
whole protocol is about 1,300 lines; the current host alone sits on a 20,000-line server we route
around. A careful person can read the new one in a day. Every claim in the brief has a test with
its name on it, including tests that forge, tamper, replay, backdate, fork and plant records.

**What it costs.** Building it for real: the prototype does the whole job on one machine; making
it a service is hardening (rate limits by profile, size caps, a front that hides addresses, blob
storage, monitoring) and a proper outside review of the 280 lines of rules. My flagged guess is a
few engineer-weeks, less than the host fork took. Running it: a host is one small server and a
disk; the public network that carries the pointers is free and nobody's; an index costs what it
indexes. Per person: nothing. What is thrown away: the host fork, the relay configuration, the
directory replica, and the parts of the index that read the relay's stream, all of it working
code on devnet today.

**What could go wrong.**

- It is ours. A bug in the rules is our bug, with no upstream to fix it. The answer is the size
  (it fits in one reviewer's head), the vectors, and paying for one outside review before anything
  real. Every cryptographic piece is borrowed unchanged; only the rules are new.
- A profile's key cannot be changed. If a profile's key leaks, that profile is lost, and its badge
  with it. This sounds worse than it is: today every key comes from one seed, so a leak of one is a
  leak of all, and the current rotation feature protects against nothing that can actually
  happen. What it does cost is the far future: when today's signatures must be replaced by
  post-quantum ones, every profile needs a successor. That mechanism is sketched, not built.
- The public pointer network is not proven for billions of profiles. It does not need to be: a
  profile whose host is known needs no lookup, and hosts and indexes answer first. It is the
  fallback for when a host disappears.
- Private records hide their content, not their existence: a host sees that something was
  written, how big it was, and when. That is the same for every design that stores encrypted data.
- An AI's grant can expire only if hosts keep honest clocks; revocation works regardless. The
  brief said "at any time"; revocation is the answer to that, and it is proven.
- No accounts means no email to ban. A host under abuse must limit by profile and by size, and can
  gate storage on a badge. Not built.
- Nobody else's tools read it. The current layer comes with Bluesky's relay, its firehose and its
  clients. None of them serve Forest's purpose, and none would accept what Forest needs anyway,
  but the loss of a wider ecosystem is real.

**What I did not do.** Run it on anything but this machine; measure it under load; review it with
a second pair of eyes; change anything in the rest of the repo; touch the registry, the escrow,
or the keys package.

## The eight things that must be true

`CLAIMS.md` has the table. In short: seven are verified by named tests; "scales to billions" is
measured small and argued, not verified; "audited in a day" is verified as a size and believed as a
day. The live network test (`npm run test:net`) put a pointer through a public Pkarr relay and got
it back byte for byte.

## The design in one page

**A profile is a log.** Entries, each DAG-CBOR, each signed, each naming the previous entry's
content id. Five operations: put, delete, grant, revoke, keys. The current folder is what the log
says now. Anyone with the bytes can check all of it with nothing else.

**Identity is the key.** The profile's name is `did:key` of its signing key. No directory, no
registration, no cost. The seed gives each profile a signing key, a reader key (for private
records) and the same Solana wallet the recipe gives today.

**Whoever the person allows writes.** A grant is an entry: which key, which collections, put or
delete, private or not, until when, at most how many. A delegate's entry says `by` whom and `via`
which grant. Every host and every index applies the same limits. A revoke entry ends it; because
it is in the chain, nobody can slip a later write in before it.

**Private records are the same entries, encrypted.** The record is sealed under a fresh key on
the device; that key is wrapped to each reader (the person's own reader key, the AI's) with HPKE.
The host stores ciphertext under an opaque key. Updates, deletes, sync, moves and indexing are
the same code paths as for public records.

**The pointer says where the log lives.** A signed DNS record in the exact form BitTorrent's DHT
stores; the same bytes go to a Pkarr relay, to any host, and to any index; the newest valid one
wins. Readers try what they know first; the DHT is the neutral fallback.

**Hosts store and check; they never sign.** One HTTP server over one SQLite file, no accounts, no
addresses kept. Anyone may send any valid entry. A person's log is public bytes (or ciphertext),
so it can be copied out of any host, or out of any index, and put on another. A host can withhold
service; it cannot withhold, alter or forge the records.

**Indexes verify for themselves.** They follow hosts, apply the same rules, keep every entry, find
new profiles by following references, learn where each lives, and follow moves. Two indexes over
the same hosts hold the same state. A host that lies produces a named fault, not a record.

## What changes for Forest, and what does not

| Piece | Today | Protocol 2 |
|---|---|---|
| Keys recipe | passkey → seed → per profile: control (secp256k1), signing (secp256k1), wallet (ed25519) | passkey → seed unchanged; per profile: signing (ed25519, `…/signing/v2`), reader (X25519, `…/reader/v2`), wallet unchanged (`…/wallet/v1`). No control key. |
| Profile name | did:plc, registered with plc.directory | did:key of the signing key, 56 characters; fits the registry's 64-byte bound |
| Records | AT Protocol repo (MST, CAR, commit signed by the one key in the DID document) | a signed, chained log; per-entry signatures; delegates under grants |
| Shapes | four lexicons in `shapes/` | unchanged, checked by test |
| Host | reference PDS + five patches, 20k lines routed around | 270 lines over SQLite and HTTP |
| Carrier | Bluesky's relay and Jetstream, configured | none: indexes read hosts directly; a relay is just another index anyone may run |
| Index | reads the relay, resolves did:plc, scores | reads hosts, resolves pointers, scores unchanged |
| Directory | plc.directory plus a replica | none; the DHT, hosts and indexes carry pointers |
| Private data | none | in v1 |
| AI door | an MCP server forwarding signing to the phone | a grant; the agent writes with its own key |
| Registry, escrow | sealed Solana programs | unchanged; the DID string changes form |
| Names | AT handles under forest.foundation, later | a DNS TXT record from a name to a did:key, later, the same shape as before |

## Keeping AT Protocol instead: the honest comparison

What AT Protocol gives that this does not: fifteen thousand test cases and daily maintenance on
the server; a repo format with inclusion proofs (the Merkle Search Tree) that proves a record is
in the current state without the whole log; a relay that already aggregates millions of accounts;
libraries in four languages; and a growing ecosystem, including a directory that is being moved to
an independent body and "permissioned data" work under way (the AT Protocol Spring 2026 roadmap
names both).

What it would take to make the eight claims true on it: commits signed by keys the DID document
does not name (so every relay and consumer must learn Forest's delegation rules, which means
Forest's own carrier anyway), a private-data layer that does not exist yet and will arrive on
their timetable with their design, and either accepting plc.directory as the point of control or
writing a directory of our own. At that point the "unchanged pieces" are the MST library and the
lexicon validator; the rest is a fork of an account-centric server whose accounts we route around.

The MST inclusion proof is the one technical loss worth naming. A buyer's app that wants to check
one review without the reviewer's whole log gets, from the new design, the signed entry (which
proves who wrote it) and the host's word that it is current; from AT Protocol it gets a proof
against a signed commit. Logs are small (a profile has hundreds of records, not millions), every
index holds full copies, and the host's word is checkable against any index, so the practical
difference is small; it is stated here so it is not hidden.

If the decision is to stay: the host fork works, the loop runs on devnet, and the three missing
claims stay missing until a design for each exists on that layer. Delegation would need a second
signing key per profile in the DID document with limits enforced only by Forest's own readers.

## Costs in numbers

| What | Number | Basis |
|---|---|---|
| Protocol source | about 1,300 lines in ten files; the rules 280 | `8-audit` |
| Dependencies | 8, each one standard piece | `8-audit` |
| An entry | 230 to 660 bytes: 233 for a keys entry, 626 to 653 for the shapes' example records | vectors, measured |
| Sign, verify, apply | about 2.5 ms per entry in JavaScript on this machine | `7-scale` |
| Write through the host | 6 to 8 ms end to end, flat across 200 profiles and 1,000 entries | `7-scale` |
| Index intake | about 500 entries per second per core in JavaScript | `7-scale` |
| A private record | one HPKE seal per reader (32 + 48 bytes each) plus the ciphertext | `SPEC.md` §7 |
| A pointer | 187 bytes for one host; the DHT limit is 1,000 | vectors, `net/pkarr` |
| Per person, per year | 0 | no directory fee, no chain write, no rent |

Billions, by arithmetic (believed): a person with 1,000 records is under a megabyte; a billion
people is under a petabyte across all hosts, with no host needing more than its own people; a
host's cost is per entry, not per population; an index that must take a billion entries a day
needs about 25 JavaScript cores or a couple in Rust; nothing anywhere is a global structure.

## Risks and unknowns, for the record

- The rules have had one author and one day. They need a second reader.
- Not measured: a host under concurrent load, SQLite's write throughput at scale, blob storage
  beyond a test, the DHT's behaviour from phones (Pkarr relays exist for that).
- Time: `at` is the writer's word. Expiry is enforced by honest hosts; revocation by the chain.
- Metadata: sizes, counts, timing and the readers' key ids of private records are visible.
- Abuse: no accounts, so no bans; limits per profile and per size, and badge-gated storage, are
  the tools. Not built.
- Successor mechanism for a key that must change (post-quantum): not designed beyond "the old key
  signs a successor entry; indexes follow it; the registry v2 lets a code re-point".
- The brief says "one human, one face check, one badge per market" stays; it does. The registry
  binds a badge to a DID and a wallet; both survive, in the same bytes it already accepts.

## How to run

```
cd lab/protocol-2
npm install
npm test          # 33 tests, one process per file, about 15 seconds
npm run test:net  # one test against relay.pkarr.org over the network
npm run check     # type-check
node scripts/verify.ts <host url> <did>   # verify any log from any host, print its state
```

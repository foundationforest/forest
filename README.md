# forest

You own your seed. You make it accountable through stamps, and keep it private through profiles.

Because nothing of you lives inside any service, every host, index, app and AI must be good, cheap
and open, or people leave. Until there are others, the foundation runs the first of each, and
should want to lose each one.

Anyone can make a new seed, but it starts with no stamps and no reviews, and a keeper that checks
faces, such as the issuer, won't stamp the same face twice. Trust is the stamps and records on each
of a seed's profiles; indexes decide which stamps count.

Forest removes one thing: having to trust someone in the middle.

## How it works

Your seed is 24 random words. From it come your profiles, one per label such as `tutoring/seller`,
each with its own key that is its name and its wallet. An issuer checks once that you are one
human and puts your stamp on its list, and the registry pins that stamp to one of your profiles in
a market, without saying who you are. Your profiles write offers and reviews as signed records,
kept on open hosts anyone can read. A review is its writer's record: the one it's about can't erase
it; the one who wrote it can. Money between two people moves through an escrow, and leaves only
when both sides agree, or by an arbiter or a timer both saw at the start. An app makes all of this
easy; everything else is open code. The registry and the escrow run on devnet; nothing is on
mainnet.

## What if there were two of it?

Every piece of Forest is sorted by that question.

| | Two of it would mean | Pieces | Where |
|---|---|---|---|
| **Core** | two of you | the recipe that mixes every key from the seed; the registry | [`keys/`](keys/README.md), [`registry/`](registry/README.md) |
| **Standards Forest offers** | anyone can offer another | records, the host socket (the two requests every host answers), the permissions record, market shapes (the profile, offer and review shapes) | [`records/`](records/README.md); market names in [foundationforest/markets](https://github.com/foundationforest/markets) |
| **Services** | the foundation runs one to start; anyone can run another | hosts, the issuer, the index, the relayer, the escrow, connections (how an AI reads and drafts for a person) | [`escrow/`](escrow/README.md), a reference host in `records/`; the issuer, the index and the relayer in [foundationforest/services](https://github.com/foundationforest/services) |
| **Apps** | a person picks one | how a person keeps their words, backups, screens | roots, the first app, in its own repo |

- **The core does not change.** The registry is to be sealed the day it deploys on mainnet. The
  recipe stays as it is, since a new one would give every profile a new key and so a new name.
- **The escrow is a program the foundation offers; use any.** Each escrow version is to be sealed
  on mainnet the day it deploys, because it holds money. A new version comes as a new program, and
  the old ones keep working.

## The four folders

| Folder | What it is | In the sort | Runs |
|---|---|---|---|
| [`keys/`](keys/README.md) | The 24 words, the recipe that mixes every key from them, and the rules for apps that hold keys | core | on the person's device |
| [`records/`](records/README.md) | Signed records, the host socket, the permissions record, private records, the three record shapes, and a reference host | standards; the reference host is a service | a library and a reference host |
| [`registry/`](registry/README.md) | A program and its client: one row per market stamp, free | core | on devnet |
| [`escrow/`](escrow/README.md) | A program and its client: money out when both sides agree, or by an arbiter or timer set at the start | a service; use any | on devnet |

Each folder's README is its standard: what it is, how it works, its promises, its limits, and an
FAQ.

## On chain, and never on chain

- **On chain:** registry rows, escrows and their receipts, and money moving.
- **Never on chain:** seeds, private keys, records, keepers' lists, and the index.

## Promises

- **Your keys stay on your device.** No app stores the seed and no server holds a key. Nothing
  anywhere has user accounts: there are keys, records and rows.
- **Private by default off chain.** Nothing ties your profiles together unless you link them.
  Reputation is computed per profile, and nothing server-side holds a person next to a profile. On
  chain, moving money between your own profiles links them until a privacy pool is used.
- **Nothing inside charges anything.** The registry and the escrow take no fee. The only costs are
  Solana's own, paid by whoever sends the transaction, and anyone may pay for someone else. Fees
  exist only at the ramp in and out.
- **Only the deal decides where money goes.** The escrow has no admin and no custodian: only the
  two sides, and an arbiter or a timer both saw at the start, can move what it holds.
- **Anyone can take part.** Anyone can run a host, keep a list, name a market or build an app.
  Everything needed to compete with the foundation is open: here, in services and in markets.
- **The programs are built to be sealed.** On mainnet, the registry and the escrow are to be sealed
  the day they deploy, so a change is a new program at a new address. On devnet they are still
  upgradable.

## Limits

- **Devnet only.** Nothing is on mainnet and nothing is shipped. Both programs can still be
  upgraded by the devnet deploy key.
- **Not audited.** Each program keeps a security checklist next to it; no paid review has been done.
- **No recovery.** Lose the seed, and every profile and stamp it gives is gone. Nobody else has it.
- **A row is only as good as its keeper.** The registry checks no keeper; each reader decides which
  issuers it trusts.
- **A host can withhold.** It cannot forge or change a record, but it can stop serving one. The
  app's copies and the profile's other hosts cover for it.
- **Not here:** recovery through an issuer, a zero-knowledge proof across profiles, a privacy pool,
  video hosting, and an arbiter by default.

## FAQ

**Who decides which markets exist?**
Nobody. A label is free text, and the registry accepts any. The recommended shape is `market/role`,
and the markets directory recommends spellings so that one trade does not split into ten names. It
gates nothing: a market adds fields to records and restricts no deal, and nothing in the foundation
decides who may trade or on what terms.

**Why do the programs not judge evidence?**
A sealed program cannot learn new kinds of evidence, and an index can. So the programs never
interpret evidence; indexes weigh it.

**Can Forest take my money or my profile?**
No. Forest never holds your keys, the escrow has no admin, and Forest arbitrates nothing: an
arbiter is a key both sides saw at the start.

**Why is all of this open?**
A piece that only works if everyone shares it is a public good, so the shared pieces are open and
kept by the foundation. Apps, and the ramps in and out, are products.

**What is it built from?**
Existing pieces, used unchanged: Ed25519, RFC 8785 canonical JSON, age, Semaphore's circuit and its
public July 2024 setup files, groth16-solana, Anchor, and the SPL token programs. Forest writes only
what does not exist yet.

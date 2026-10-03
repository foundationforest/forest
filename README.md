# forest

You own your seed. You make it accountable through stamps, and keep it private through profiles.

Because nothing of you lives inside any service, every host, index, app and AI must be good, cheap
and open, or people leave. Until there are others, the foundation runs the first of each, and
should want to lose each one.

Anyone can make a new seed, but it starts with no stamps and no reviews, and an issuer that checks
faces won't stamp the same face twice. Trust is the stamps and records on each of a seed's
profiles; indexes decide which stamps count.

Forest removes one thing: having to trust someone in the middle.

## How it works

Your seed is 24 random words, kept in the app's secure slot on your device, unlocked by your face
or fingerprint and used only to derive keys. From it come your main keys, one per label such as
`tutoring/seller`. Each is a folder (everything it signs on a host), an address (its Solana
address) and, once registered, a profile. An issuer checks once that you are one human and puts
your stamp on its list, and registering writes a row in the registry that pins that stamp to one of
your main keys in a market, without saying who you are. Each main key writes offers and reviews as
signed records in its folder, on open hosts anyone can read; photos and other large files go beside
them as blobs. A review belongs to whoever wrote it: the one it's about can't erase it; the one who
wrote it can. Beside each folder is an inbox, where others leave messages for that main key. Money
between two people moves through an escrow, and leaves only when both sides agree, or by an arbiter
or a timer both saw at the start. An app makes this easy; everything else is open code. The
registry and the escrow run on devnet; nothing is on mainnet.

## What if there were two of it?

Every piece of Forest is sorted by that question.

| | Two of it would mean | Pieces | Where |
|---|---|---|---|
| **Core** | two of you | the recipe that mixes keys from the seed; the registry | [`keys/`](keys/README.md), [`registry/`](registry/README.md) |
| **Standards Forest offers** | anyone can offer another | records, the host socket (the six requests every host answers, for records, the inbox and blobs), the permissions record (which access keys may write in a folder), envelopes (how a record is made private), the inbox, the three shapes (profile, offer and review) | [`records/`](records/README.md); market names in [foundationforest/markets](https://github.com/foundationforest/markets) |
| **Services** | the foundation runs one to start; anyone can run another | hosts, issuers, indexes, fee payers (who pay Solana's fee for someone else), escrows, connections (how an AI reads and drafts for a person) | [`escrow/`](escrow/README.md) and a reference host in `records/` here; the rest in [foundationforest/services](https://github.com/foundationforest/services) |
| **Apps** | the person picks one | the secure slot that holds the seed, and the screens | the first, by Soil, in [foundationforest/app](https://github.com/foundationforest/app), its own repo |
| **The person** | up to them | the words, where they keep them, what they post | with them, in no repo |

- **The core does not change.** The registry is to be sealed the day it deploys on mainnet. The
  recipe stays as it is, since a new one would give every profile a new main key and so a new name.
- **The escrow is a program the foundation offers; use any.** Each escrow version is to be sealed
  on mainnet the day it deploys, because it holds money. A new version comes as a new program, and
  the old ones keep working.

## Who decides what

The standard holds only what two strangers' implementations must agree on; everything else is a
service's policy, an app's choice, or the person's.

- **The standard** is fixed: no service or app can change it.
- **A service** decides its own policy. The foundation's services publish theirs, each in its own
  README in [foundationforest/services](https://github.com/foundationforest/services).
- **An app** makes its choices with the person.
- **The person** decides the rest.

## The four pieces

| Where | What it is | In the sort | Runs |
|---|---|---|---|
| [`keys/`](keys/README.md) | The 24 words, the recipe that mixes keys from them, and the rules for apps that hold keys | core | on the person's device |
| [`records/`](records/README.md) | Signed records, the host socket, the permissions record, envelopes for private records, the inbox, blobs, the three record shapes, and a reference host | standards; the reference host is a service | a library and a reference host |
| [`registry/`](registry/README.md) | A program and its client: one row per market stamp, free | core | on devnet |
| [`escrow/`](escrow/README.md) | A program and its client: money out when both sides agree, or by an arbiter or timer set at the start | a service; use any | on devnet |

Each piece's README is its standard: what it is, how it works, its promises, its limits, who
decides what, and an FAQ.

## On chain, and never on chain

- **On chain:** registry rows, escrows and their receipts, and money moving.
- **Never on chain:** seeds, private keys, records, messages, blobs, issuers' lists, and the index.

## Promises

- **The seed and the main keys stay in the app's secure slot on your device,** unlocked by your
  face or fingerprint, and used only to derive and sign. Only access keys and signatures leave.
  Nothing anywhere has user accounts: there are keys, records and rows.
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
- **A row is only as good as its issuer.** The registry checks no issuer; each reader decides which
  issuers it trusts.
- **A host can withhold.** It cannot forge or change a record, but it can stop serving one, or a
  message or a blob. The app's copies and the main key's other hosts cover for it.
- **Not here:** recovery through an issuer, a proof across profiles, a privacy pool built by
  Forest, and an arbiter by default.

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
No. Forest never holds your seed or your main keys, the escrow has no admin, and Forest arbitrates
nothing: an arbiter is a key both sides saw at the start.

**Why is all of this open?**
A piece that only works if everyone shares it is a public good, so the shared pieces are open and
kept by the foundation. Apps, and the ramps in and out, are products.

**Why is the app in its own repo?**
An app is the person's choice, one of many, so the standard must not look like one app. The app
that holds the seed is open source so anyone can check that nothing leaks, and a repo is what
people check. It pins a version of forest, the way services does.

**What is it built from?**
Existing pieces, used unchanged: Ed25519, RFC 8785 canonical JSON, age, Semaphore's circuit and its
public July 2024 setup files, groth16-solana, Anchor, the SPL token programs, and Kora, in Soil's
fee payer, in services. Forest writes only what does not exist yet.

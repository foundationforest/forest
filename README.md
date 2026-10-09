# standard

Forest is a set of open standards for trading with strangers, and this repo holds them. Your keys,
your records and your money need no one in the middle: one seed of 24 words gives you a profile for
each thing you do, each profile signs its offers and reviews as records on open hosts, and an
escrow lets money out only when both sides agree. Two things keep a middle on purpose: proving you
are one person, which an issuer does by checking you once and signing you a note, and judging
reputation, which an index does by weighing records into scores. You choose which issuers and
indexes count, and can switch. Your seed, keys and records live with you; hosts only serve copies
of your records, and you can leave any of them.

## The pieces

Every piece is sorted by one question: what if there were two of it?

- **Core:** two would mean two of you, so it never changes.
- **Standard:** anyone can offer another.
- **Service:** anyone can run another. The foundation runs the first of each until there are
  others, and should want to lose each one.
- **App:** the person picks one.

| Piece | Layer | Folder | Where it runs |
|---|---|---|---|
| Keys: the seed, and the recipe that mixes every key from it | core | [`keys/`](keys/README.md) | on the person's device |
| Registry: one row per stamp (one person, one label, one issuer), proven without saying who | core | [`registry/`](registry/README.md) | a Solana program, on devnet (Solana's test network) |
| Records: signed records and the hosts that keep them, private records, the inbox, blobs (photos and other files), the three record shapes | standard | [`records/`](records/README.md) | a library, wherever an app, host or index runs |
| The reputation proof, and the tree an index publishes for it | standard | [`reputation/`](reputation/README.md) | made on the person's device, checked by anyone; its setup is for devnet |
| Market names: recommended spellings of labels | standard | [foundationforest/markets](https://github.com/foundationforest/markets) | nowhere: a directory to read |
| Escrow: money out when both sides agree, or by an arbiter or timer set at the start | service: a program the foundation offers; use any | [`escrow/`](escrow/README.md) | a Solana program, on devnet |
| Hosts, issuers, indexes and fee payers | service | a reference host in [`records/`](records/README.md); the rest in [foundationforest/services](https://github.com/foundationforest/services) | anywhere; the foundation's on devnet |
| The Forest app: the screens, and the secure slot that holds the seed | app | [foundationforest/app](https://github.com/foundationforest/app) | on the person's device |
| The CLI: Forest actions with access keys, for scripts and AI | app | [`cli/`](cli/README.md) | on the person's device, or hosted |
| The words, where they are kept, and what is posted | the person | none | with the person |

## Who decides what

The standard holds only what two strangers' programs must agree on; everything else is a service's
policy, an app's choice, or the person's.

- **The standard** is fixed: no service or app can change it.
- **A service** decides its own policy. The foundation's publish theirs, each in its own README in
  [foundationforest/services](https://github.com/foundationforest/services).
- **An app** makes its choices with the person.
- **The person** decides the rest.

## For builders

- **Find a profile's folder.** A profile's address is its name. Ask any host you know for the
  profile's records; its hosts record, signed by the profile, names every host that keeps them, so
  read those too. There is no directory ([records](records/README.md)).
- **Read a market.** Ask an index. Its answer is in that index's own format, not part of the
  standard; [cli](cli/README.md) reads the foundation's. You can also read the records yourself
  and weigh them your own way.
- **Pay Solana's fees for someone.** Whoever signs a transaction as payer pays its fee and any
  deposit a new account needs, and the programs do not care who that is. A fee payer is a service
  that pays for others; the foundation's is Kora, the Solana Foundation's open fee payer, and
  speaks its JSON-RPC ([services](https://github.com/foundationforest/services)).
- **Register a profile.** Get a note from an issuer, then send the registry a proof made on the
  device; it writes one row ([registry](registry/README.md)).
- **Let an AI act for someone.** The person's app hands it access keys, which act for a profile
  within limits, never the main key that is the profile. The AI works through the
  [CLI](cli/README.md), whose README gives the three setups.

## Privacy, honestly

What Forest does:
- Nothing in a person's keys ties their profiles together: each is its own mix of the seed
  ([keys](keys/README.md)).
- A registry row says which issuer signed the person's note, never who the person is
  ([registry](registry/README.md)).
- Private records and messages are encrypted to post-quantum keys; hosts keep them and cannot open
  them ([records](records/README.md)).
- Never on chain: seeds, private keys, records, messages, blobs, issuers' notes, and the index.

What others can still see:
- On chain, everything: rows, escrows and their receipts, and money moving. Paying between your
  own profiles links them.
- A ramp knows the profile it paid into.
- A host sees who wrote to whom and when, though not what, and the network address of whoever
  reads or writes.
- The face check keeps your face: an issuer that checks faces, or the provider it checks them
  with, holds it so it can refuse the same face a second time.
- At the start, with few people, a face check and the first profile registered right after it can
  be matched by their times. With many people this blends in, and you can always wait before
  registering.
- An AI model run in the cloud shows its maker what you tell it, and any key written into a call.

What you can add:
- A VPN, so hosts and indexes do not see your network address.
- A model on your own device, so nothing you tell your AI leaves it ([cli](cli/README.md)).

Planned, not built:
- A relay, so hosts and indexes do not see your network address, with no VPN.
- A privacy pool, so money moves between your own profiles without the chain linking them.

## Promises

- **Nothing in the standard needs the seed or a main key to leave your device.** Where they live
  is the app's choice ([keys](keys/README.md)). The standard has no user accounts: there are keys,
  records and rows; whether a service keeps any is its policy.
- **Private by default off chain.** Nothing ties your profiles together unless you link them.
  Reputation is computed per profile, and nothing in the standard holds a person next to a profile;
  whether a service does is its policy. On chain, moving money between your own profiles links them
  until a privacy pool is used.
- **Nothing inside charges anything.** The registry and the escrow take no fee. The only costs are
  Solana's own, paid by whoever sends the transaction, and anyone may pay for someone else.
  Services, apps and the ramps in and out set their own prices.
- **Only the deal decides where money goes.** The escrow has no admin and no custodian: only the
  two sides, and an arbiter or a timer both saw at the start, can move what it holds.
- **Anyone can take part.** Anyone can run a host, run an issuer, name a market or build an app.
  Everything needed to compete with the foundation is open: here, in services and in markets.
- **The programs are built to be sealed.** On mainnet, the registry and the escrow are to be sealed
  the day they deploy, so a change is a new program at a new address. On devnet they are still
  upgradable.

## Limits

- **Devnet only.** Nothing is on mainnet and nothing is shipped. Until mainnet the standard is a
  draft and can change; from mainnet, a change gets a new version number, and readers keep reading
  the old one. Both programs can still be upgraded by the devnet deploy key.
- **Not audited.** Each program keeps a security checklist next to it; no paid review has been
  done.
- **No recovery.** Lose the seed, and every profile and stamp it gives is gone. Nobody else has it
  ([keys](keys/README.md)). Losing the words also means your face cannot get a note again from the
  same issuer.
- **A host can withhold.** It cannot forge or change a record, but it can stop serving one, or a
  message or a blob. The app's copies and the profile's other hosts cover for it.
- **Not here:** recovery through an issuer, and an arbiter by default.

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
Not through the standard. Forest never holds your seed or your main keys, the escrow has no admin,
and Forest arbitrates nothing: an arbiter is a key both sides saw at the start. The app holding your
seed is the one thing you trust, Forest's own app included. A web app's code comes from its server
on each visit; an installed app's does not.

**Why is all of this open?**
A piece that only works if everyone shares it is a public good, so the shared pieces are open and
kept by the foundation. Apps, and the ramps in and out, are products.

**Why is the app in its own repo?**
An app is the person's choice, one of many, so the standard must not look like one app. The app
that holds the seed is open source so anyone can check that nothing leaks, and a repo is what
people check. It pins a version of this repo, the way services does.

**What is it built from?**
Existing pieces, used unchanged: Ed25519, RFC 8785 canonical JSON, age, Semaphore's lean Merkle
tree, circomlib's Poseidon and EdDSA verifier and zk-kit's Merkle circuit on PSE's Perpetual Powers
of Tau, zk-kit's EdDSA-Poseidon, snarkjs, groth16-solana, Anchor, the SPL token programs, and Kora,
in the foundation's fee payer. Forest writes only what does not exist yet.

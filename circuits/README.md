# circuits

Devnet only: the reputation circuit's setup was made by one party, for devnet; a public setup
ceremony comes before mainnet. Nothing is on mainnet.

Up: [the repo](../README.md). The reputation circuit, its setup and its client:
[reputation/](reputation/).

## What it is

The zero-knowledge proofs Forest offers. Each one shows a single thing about a person's profiles
and nothing else. The app makes it on the device, from the person's secret for one issuer
(`keys/`'s `issuerSecret`), so the secret never leaves the device. Whoever it is shown to checks it.

| Circuit | What it proves | Made by | Checked by | Engine | Status |
|---|---|---|---|---|---|
| **reputation** | These profiles are mine, and this is their count-weighted score in an index's tree, for one main key; which profiles stays hidden | the app, on the device | any reader, off chain | this directory: Circom 2.2.3, Groth16 on BN254, with Semaphore's Poseidon and Merkle pieces | devnet setup only, made by one party; a public setup ceremony comes before mainnet |

The person proof, which registering needs, lives with the registry
([its section](../registry/README.md#the-note-and-the-person-proof)), because the registry program
is to be sealed with it.

### What the reputation proof lets a person do

A profile's reviews are its own, and nothing public ties a person's profiles together. The
reputation proof lets a person carry a score from their profiles to another one, such as a new
profile, without naming any of them. An index publishes its scores as a tree; the person's app
finds their own profiles in it from their issuer secret, and proves the score on the device. It has
two uses:

- **Global:** the count-weighted score of the profiles the person picks, up to eight, naming none
  of them.
- **Single:** the score of one of their profiles in a named market, with its label shown and which
  profile hidden.

## How it works

### The tree an index publishes

A standard: any index may publish one, and a proof names the root it used.

- **A leaf** is `Poseidon(stamp, scope, score, count)`, circomlib's Poseidon with four inputs:
  - `stamp`: the profile's market stamp, its registry row's seed.
  - `scope`: the scope of the profile's label exactly as the registry computes it,
    `keccak256("forest.foundation/label/v1/" ‖ label) >> 8`.
  - `score`: the index's score for the profile times ten, an integer from 0 to 2^32 - 1.
  - `count`: how many reviews the score comes from, from 0 to 2^32 - 1.
- **One leaf per market stamp.**
- **The tree** is Semaphore's, the kind an issuer's list is: a lean incremental Merkle tree over
  Poseidon of pairs, with the leaves in the index's order. The circuit fixes its depth at 20, so a
  tree holds at most 1,048,576 leaves.
- **The index signs the root with a time:** ed25519 by the index's key over
  `0xff ‖ "forest/v1/reputation\n" ‖ root ‖ time`, the root as 32 big-endian bytes and the time as
  8 big-endian bytes of milliseconds since 1970. Like a record's signed bytes, they start with
  `0xff`, which starts no Solana message, then their own text, so the signature is never anything
  else.
- An index publishes every leaf's four fields, in order, with the root, the time and the signature,
  its own way.

### The reputation proof

[`reputation/reputation.circom`](reputation/reputation.circom), `Reputation(8, 20)`: eight slots,
each one profile, a leaf and its path to the root. The person fills the ones they want and leaves
the rest blank.

| | Signals |
|---|---|
| Private | `secret`, the person's secret for one issuer (the scalar `keys/`'s `issuerSecret` gives); for each slot, `used`, the leaf's stamp, scope, score and count, and its path's length, position and siblings |
| Public, in this order | `score`, the output; `root`; `message`; `scope`, the label shown, or 0 |

`message` is the main key the proof is shown for, as in registration:
`keccak256("forest.foundation/profile/v1/" ‖ main key) >> 8`. A proof counts for that main key
only.

Inside the proof:

1. Each used slot's stamp is `Poseidon(scope, secret)`, the registry's market stamp. Only the
   person who holds the issuer secret can count those profiles, and all of them come from one
   issuer.
2. Each used slot's leaf is in the tree with that root. The root is never 0.
3. A blank slot is all zeros, and every score and count is below 2^32.
4. No two used slots share a scope, so a profile counts once.
5. A shown scope is the scope of every used slot, so a shown label means exactly one profile.
6. The output is `floor(sum(score * count) / sum(count))`, over at least one review. With one
   profile, it is that profile's score.

Which leaves, and how many, stays hidden.

The Merkle piece is zk-kit's `binary-merkle-root` 2.0.0, the one Semaphore 4.13.0 uses: it takes the
path's position as one number and splits it into bits itself.

### The devnet setup

- **Phase 1** is public: PSE's Perpetual Powers of Tau, `ppot_0080_16.ptau`, pinned by SHA-256 in
  `reputation/devnet/setup.sh`.
- **Phase 2** is one contribution, made once by `reputation/devnet/setup.sh`: one party. Whoever
  made it could make false proofs, so it is for devnet only. A public setup ceremony, with many
  people contributing to phase 2 on the same phase 1, comes before mainnet.
- **What is committed:** `verification-key.json`, and `setup.json`, which records the toolchain,
  phase 1, the contribution's hash and every file's SHA-256.
- **What is not:** the proving key and the witness generator, used only to make a proof. They are
  in the GitHub release `reputation-devnet-1`, and `npm run fetch` refuses anything whose hash does
  not match.

| File | Bytes | SHA-256 |
|---|---|---|
| `verification-key.json` | 3,469 | `23710bab5211c73197c3ae149e7bd45ec01250a99195bd7db282c9838a2ea13f` |
| `reputation.zkey` | 28,241,035 | `1b18b394ce8f19984d09259b901f3116e831525f177f11c5026344b2978863c9` |
| `reputation.wasm` | 2,592,737 | `70b90c31b3769018ae1801431b6ac82c28e67aea3d1a6799fbbcf63665db7543` |

`reputation.circom` does not change after its setup. circom gives the same bytes every time, and
`npm run compile` checks the compiled circuit against `setup.json`. The witness generator carries
the source's line numbers, so even a line added to a comment fails that check. A change means a
new setup and a new release.

### Use it

`reputation/src/` talks to no network of its own. The market stamp, the scope and the message come
from the registry client, unchanged.

| Function | Gives |
|---|---|
| `buildTree(leaves)` | For an index: the root to sign. Refuses an empty tree, more than 2^20 leaves, a field out of range, or two leaves for one market stamp |
| `signedBytes(root, time)` | The bytes an index signs |
| `proveReputation({ secret, labels, leaves, profile, show?, artifacts })` | The proof, on the device: one to eight labels of the person's profiles from one issuer, found in the leaves by their market stamps; `show` shows the label, only with one |
| `verifyReputation({ proof, root, score, profile, label?, index, time, signature })` | Whether the index signed the root with that time, and the proof holds for that score, main key and shown label |
| `proofBytes(proof)`, `proofFromBytes(bytes)` | The proof as the 256 bytes a profile record carries ([records/](../records/README.md#proofs)), and back; `verifyReputation` takes either |
| `circuitInput({...})` | The circuit's input, for a caller that drives snarkjs itself |

```ts
import { issuerSecret } from '@forest/keys'
import { proveReputation, verifyReputation } from '@forest/reputation'

// On the device: three profiles' score, shown on a new profile.
const r = await proveReputation({
  secret: (await issuerSecret(seed, name)).secret,
  labels: ['tutoring/seller', 'tutoring/buyer', 'cleaning/seller'],
  leaves,                      // the index's published leaves, in its order
  profile,                     // the main key the proof is shown for
  artifacts: { wasm: 'devnet/reputation.wasm', zkey: 'devnet/reputation.zkey' },
})

// Any reader, with the index's key, and the time and signature it published with the root:
await verifyReputation({ proof: r.proof, root: r.root, score: r.score, profile, index, time, signature })
```

### Run it

The toolchain: Node 22.18 or later; circom 2.2.3, the Linux binary from its GitHub release
(SHA-256 `85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3`); and, from
`package-lock.json`, snarkjs 0.7.5, circomlib 2.0.5 and `@zk-kit/binary-merkle-root.circom` 2.0.0.

```
cd keys && npm ci                       # registry/client and the tests read it
cd registry/client && npm ci            # the market stamp, the scope and the message
cd circuits/reputation && npm ci
npm run fetch                           # the release's files, hash-checked
npm run compile                         # circom 2.2.3 on PATH or in CIRCOM; checks setup.json
npm run check && npm test               # the tree, two proofs, and every way one must fail
devnet/setup.sh                         # a new setup: new files, every hash new, a new release
```

The tests build a tree of made-up leaves around `keys/`'s test person, and prove with one profile
and with three. A wrong secret, a leaf not in the tree, a profile counted twice and a label shown
with two profiles are refused; a changed output, a changed message, a root the index did not sign
and a changed time fail to verify.

### What one proof costs

Measured in Node 22 on a 4-core machine, with 8 slots at depth 20:

| | |
|---|---|
| Constraints | 44,493 |
| Building the tree | 2.9 s for 5,008 leaves, about 0.6 ms a leaf |
| Making the proof | about 3.4 s more |
| Checking it | about 40 ms |
| The proof | 725 bytes as snarkjs writes it |

## Promises

- A proof counts only profiles whose market stamps come from the prover's own issuer secret.
- A profile counts at most once in a proof.
- A proof counts for one main key: its message names it.
- A shown label means exactly one profile, under that label.
- The score is the count-weighted score of the profiles counted, rounded down, and nothing else.
- Nothing else about those profiles is in the proof: not which leaves, nor how many.

## Limits

- **Devnet setup only, made by one party.** Whoever ran `devnet/setup.sh` could make false
  reputation proofs. A public setup ceremony comes before mainnet.
- **The person picks which profiles count.** Up to eight, all from one issuer. A proof says "these
  profiles of mine", never "all of them": a low-scored profile can be left out, and nothing public
  can tell which profiles are all of one person's.
- **One issuer per proof.** Profiles registered through different issuers have different secrets,
  and cannot be counted together.
- **A label and an exact score can point to one leaf.** The tree is public. In a market with few
  profiles, the leaves with that label and that score may be just one, and that names the profile.
  A hidden label narrows it too, when few leaves have that score. The app should say so before a
  proof is shown.
- **Building the tree takes time.** About ten minutes for a million leaves at the speed above. An
  app that asks the index for its path instead tells the index which profiles are its.
- **A score is only as good as its index.** The proof shows what the index's tree says. A reader
  decides which indexes it trusts and how old a time it accepts.
- **It trusts** circom 2.2.3, snarkjs 0.7.5, circomlib's Poseidon and zk-kit's Merkle circuit
  2.0.0, used unchanged.
- **Not audited.**

## Who decides what

- **The standard:** the leaf, the tree, what an index signs, and the circuit and its public
  signals.
- **An index, by its own policy:** its scores, which reviews count and how much, and when and where
  it publishes its tree.
- **A reader (an app, an index or a service), by its own policy:** which indexes it trusts, how old
  a time it accepts, and what a score means to it.
- **An app, with the person:** whether to show a proof, which profiles count, and whether to show
  the label.

## FAQ

**Why at most eight profiles?** Each slot costs about 5,500 constraints, most of them its path's
Poseidon hashes. Eight covers a profile on each side of four markets and keeps a proof to a few
seconds. More is a new circuit and a new setup.

**Why a depth of 20?** A million leaves per index tree is enough for now. A deeper tree is a new
circuit and a new setup.

**Why does the proof not say how many reviews?** The index's score is where the number of reviews
behind a profile should weigh. The counts only weigh one profile against another inside the proof,
and a second output would say more about the person than the score does.

**Why is it checked off chain?** Nothing on chain needs a reputation, and a sealed program could
not take a better circuit later. Whoever is shown a proof checks it.

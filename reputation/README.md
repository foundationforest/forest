# reputation

On devnet only: the reputation circuit's setup was made by one party; a public setup ceremony
comes before mainnet. Nothing is on mainnet.

Up: [the repo](../README.md).

## What it is

The reputation proof lets a person carry a score from their profiles to another one, such as a new
profile, without naming any of them. A profile's reviews are its own, and nothing public ties a
person's profiles together; the proof carries the score across without linking them. It has two
uses:

- **Global:** the count-weighted score of up to eight profiles the person picks, naming none of
  them: their average score, each weighted by its number of reviews.
- **Single:** the score of one of their profiles, with its label shown and which profile hidden.

It is a zero-knowledge proof: it shows that this is true and nothing else. The person's app makes
it on the device from their secret for one issuer ([keys](../keys/README.md#the-issuer-secret)),
so the secret never leaves the device, and any reader checks it, off chain. It is built with
circom 2.2.3, Groth16 on BN254, and the Poseidon and Merkle pieces Semaphore uses.

- `circuit/`: the circuit, its devnet setup, and the tests that make proofs.
- `client/`: the tree an index builds, the proof an app makes, and the check any reader makes.

## How it works

### The tree an index publishes

An index, a service that reads records from hosts and scores profiles by its own policy
([records](../records/README.md)), publishes its scores as a tree. The tree is a standard: any
index may publish one, and a proof names the root it used.

- **A leaf** is `Poseidon(stamp, scope, score, count)`, circomlib's Poseidon with four inputs:
  - `stamp`: the profile's stamp ([keys](../keys/README.md#stamps)), the number its registry row's
    address comes from.
  - `scope`: the profile's label as a number, exactly as the registry makes it
    ([registry](../registry/README.md#the-note-and-the-person-proof)).
  - `score`: the index's score for the profile times ten, as a whole number from 0 to 2^32 - 1
    (4.7 is 47).
  - `count`: how many reviews the score comes from, from 0 to 2^32 - 1.
- **One leaf per stamp.**
- **The tree** is Semaphore's lean incremental Merkle tree over Poseidon of pairs, with the leaves
  in the index's order: it hashes the leaves in pairs, level by level, up to one number, the root,
  so a short path shows that a leaf is in it. The circuit fixes its depth at 20, so a tree holds at
  most 1,048,576 leaves.
- **The index signs the root with a time:** ed25519 by the index's key over
  `0xff ‖ "forest/v1/reputation\n" ‖ root ‖ time`, the root as 32 big-endian bytes and the time as
  8 big-endian bytes of milliseconds since 1970. Like a record's signed bytes, they start with
  `0xff`, which starts no Solana message, then their own text, so the signature is never anything
  else.
- **How it publishes them is its own:** every leaf's four fields, in order, with the root, the time
  and the signature, in whatever format the index chooses.

### The reputation proof

[`circuit/reputation.circom`](circuit/reputation.circom), `Reputation(8, 20)`: eight slots,
each one profile, a leaf and its path to the root. The person fills the ones they want and leaves
the rest blank.

| | Signals |
|---|---|
| Private | `secret`, the scalar `keys/`'s `issuerSecret` gives; for each slot, `used`, the leaf's stamp, scope, score and count, and its path's length, position and siblings |
| Public, in this order | `score`, the output; `root`; `message`; `scope`, the label shown, or 0 |

`message` is the main key the proof is shown for, made a number as the registry makes it
([registry](../registry/README.md#the-note-and-the-person-proof)), so a proof counts for that main
key only.

Inside the proof:

1. Each used slot's stamp is `Poseidon(scope, secret)`. Only the person who holds the issuer
   secret can count those profiles, and all of them come from one issuer.
2. Each used slot's leaf is in the tree with that root. The root is never 0.
3. A blank slot is all zeros, and every score and count is below 2^32.
4. No two used slots share a scope, so a profile counts once.
5. A shown scope is the scope of every used slot, so a shown label means exactly one profile.
6. The output is `floor(sum(score * count) / sum(count))`, over at least one review. With one
   profile, it is that profile's score.

Which leaves, and how many, stays hidden. A path's position is one number: the Merkle piece,
zk-kit's `binary-merkle-root` 2.0.0, splits it into bits itself.

### The devnet setup

A Groth16 proof needs a setup, made once for its circuit: whoever knows all of the setup's secret
randomness could make false proofs, so it is made in public by many people, and one honest one is
enough.

- **Phase 1** is public: PSE's Perpetual Powers of Tau, `ppot_0080_16.ptau`, pinned by SHA-256.
- **Phase 2** is one contribution, made once by `circuit/devnet/setup.sh`: one party. Whoever
  made it could make false proofs, so it is for devnet only. A public setup ceremony, with many
  people contributing to phase 2 on the same phase 1, comes before mainnet.
- **What is committed:** `verification-key.json`, and
  [`setup.json`](circuit/devnet/setup.json), which records the toolchain, phase 1, the
  contribution's hash, and every file's size and SHA-256.
- **What is not:** the proving key and the witness generator, used only to make a proof. They are
  in the GitHub release `reputation-devnet-1`, and `npm run fetch` refuses anything whose hash does
  not match `setup.json`.
- **The circuit does not change after its setup.** circom gives the same bytes every time, and
  `npm run compile` checks the compiled circuit against `setup.json`. The witness generator carries
  the source's line numbers, so even a line added to a comment fails that check. A change means a
  new setup and a new release.

### Use it

`client/src/` talks to no network of its own. The stamp, the scope and the message come from
the registry client, unchanged.

| Function | Gives |
|---|---|
| `buildTree(leaves)` | For an index: the root to sign. Refuses an empty tree, more than 2^20 leaves, a field out of range, or two leaves for one stamp |
| `signedBytes(root, time)` | The bytes an index signs |
| `proveReputation({ secret, labels, leaves, profile, show?, artifacts })` | The proof, on the device: one to eight labels of the person's profiles from one issuer, found in the leaves by their stamps; `show` shows the label, only with one |
| `verifyReputation({ proof, root, score, profile, label?, index, time, signature })` | Whether the index signed the root with that time, and the proof holds for that score, main key and shown label |
| `proofBytes(proof)`, `proofFromBytes(bytes)` | The proof as the 256 bytes a profile record carries ([records](../records/README.md)), and back; `verifyReputation` takes either |
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
  artifacts: {
    wasm: 'reputation/circuit/devnet/reputation.wasm',
    zkey: 'reputation/circuit/devnet/reputation.zkey',
  },
})

// Any reader, with the index's key, and the time and signature it published with the root:
await verifyReputation({ proof: r.proof, root: r.root, score: r.score, profile, index, time, signature })
```

### Run it

The toolchain: Node 22.18 or later; circom 2.2.3, the Linux binary from its GitHub release, whose
SHA-256 `setup.json` records; and, from `package-lock.json`, snarkjs 0.7.5, circomlib 2.0.5 and
`@zk-kit/binary-merkle-root.circom` 2.0.0.

```
cd keys && npm ci                       # registry/client and the tests read it
cd registry/client && npm ci            # the stamp, the scope and the message
cd reputation/client && npm ci
npm run check && npm test               # the tree, what an index signs, what the client refuses
cd reputation/circuit && npm ci         # after reputation/client
npm run fetch                           # the release's files, hash-checked
npm run compile                         # circom 2.2.3 on PATH or in CIRCOM; checks setup.json
npm run check && npm test               # two proofs, and every way one must fail
devnet/setup.sh                         # a new setup: new files, every hash new, a new release
```

The client's tests check the tree, the bytes an index signs, and the inputs the client refuses.
The circuit's tests build a tree of made-up leaves around `keys/`'s test person, and prove with
one profile and with three. A wrong secret, a leaf not in the tree, a profile counted twice and a label shown
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

- A proof counts only profiles whose stamps come from the prover's own issuer secret.
- A profile counts at most once in a proof.
- A proof counts for one main key: its message names it.
- A shown label means exactly one profile, under that label.
- The score is the count-weighted score of the profiles counted, rounded down, and nothing else.
- Nothing else about those profiles is in the proof: not which leaves, nor how many.

## Limits

- **Devnet setup only, made by one party.** Whoever ran `circuit/devnet/setup.sh` could make false
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

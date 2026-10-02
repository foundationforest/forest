# registry

Devnet only: the program runs on devnet at `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`
([record](devnet/devnet.json)). Nothing is on mainnet.

Up: [the repo](../README.md). Down: [the setup files](artifacts/README.md), the
[security checklist](security-checklist.md).

A free public list of badges on Solana, and the client a device uses to add to it and read it. A
badge is one line: *this profile is one verified human under this label*, proven against one
issuer's list without saying which human. One human gets at most one line per label. A line is
written once and never changes. The program holds nothing else: no fee, no token, no treasury, no
admin, no list. The only costs are Solana's own, the network fee and the line's deposit, paid by
whoever sends the transaction.

## How it works

- **Keys.** A profile is one ed25519 key: its did:key name and its Solana wallet. A person also
  holds one identity secret, the same for all their profiles; only its commitment ever leaves the
  device, once to each issuer that vouches for them (but see Limits: keys/ now mixes one per list).
- **Issuers.** An issuer checks that someone is one real human, adds their commitment to its list,
  and publishes the list (every commitment, in order) and its root outside the registry. Anyone may
  be an issuer. The program never sees a list and checks no root.
- **Labels.** Free text of at most 128 bytes. The convention is `market/role`, such as
  `tutoring/seller`, with market names from the
  [markets directory](https://github.com/foundationforest/markets); the program does not care what
  the text says.
- **The code.** The device proves with Semaphore: "my commitment is in the list with this root",
  for one label (the proof's scope) and one profile (its message). The proof's nullifier is the
  line's code: the same for one human under one label, unguessable for anyone else. The line sits at
  the address derived from the code, so a second line for it cannot exist.
- **The proof is the consent.** Only the holder of the identity secret can make the proof, and it
  can create only its own profile's line under its own label. So the profile key signs nothing, and
  anyone may send the transaction: the person, an app, a relayer. Whoever signs as payer pays the
  deposit and is recorded.
- **More issuers, off chain.** A person on a second issuer's list proves membership in it for the
  same label and profile, and publishes that proof as a membership record in the profile
  (below). It costs nothing on chain.
- **Badged is the reader's call.** A profile is badged, for a reader, when it has a line whose root
  that reader trusts, or a membership record for that line that checks against the roots of an
  issuer it trusts. Each reader keeps its own list of trusted issuers.

## What it promises

- At most one line per code: one per identity secret per label.
- A proof counts for one label and one profile: the program derives the scope from the label and the
  message from the profile, and verifies against them.
- A line is never written again after `register`, and never closes.
- `refund` moves only what a line holds above its rent-exempt minimum, and only to the payer it
  records.

## What it trusts

- **Semaphore's circuit, unchanged,** with the depth-32 verification key of its public July 2024
  ceremony, baked into the program ([artifacts](artifacts/README.md)).
- **`groth16-solana` 0.2.0** and Solana's `alt_bn128` syscalls to verify; Anchor 1.2.
- **Issuers,** to put only real, distinct humans on their lists. The program cannot tell; readers
  choose whom to trust.
- **On the device:** `snarkjs` 0.7.5 and `@semaphore-protocol/*` 4.12.1 to make proofs.

## Instructions

| | What it does | Signs |
|---|---|---|
| `register(profile, label, code, proof)` | Verifies the proof with public inputs `[root, code, message(profile), scope(label)]`, then writes the line at `["code", code]`: profile, code, payer, time (the clock), root and label. A second line for the same code is refused | the payer |
| `refund(code)` | Moves what the line holds above its current rent-exempt minimum to the payer the line records. The line's data is untouched | nobody |

`refund` exists because Solana is cutting its rent rate in steps, and only the owning program can
move the difference out of its accounts. A line never closes: its existence is the
one-line-per-code rule. The program emits no events; readers read the lines.

## The line

At `["code", code]`. Every fixed field sits at a fixed offset; the label is last.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | discriminator, `sha256("account:Line")[..8]` |
| 8 | 32 | profile |
| 40 | 32 | code |
| 72 | 32 | payer |
| 104 | 8 | time, i64 unix seconds |
| 112 | 1 | bump |
| 113 | 32 | root |
| 145 | 4 + n | label: u32 length, then UTF-8 |

A line is `149 + label` bytes, and never more. The profile is first, so a reader finds every line
of one profile with one filter at offset 8 (`fetchLines`).

## Memberships

A membership is the body of a record at `proof/<id>`, signed by the profile like any other record.
[records/](../records/README.md) defines no shape for it:

```
{ "issuer": "did:key:z6Mk…",                 the issuer's key, which signs the roots it publishes
  "membership": {
    "label": "tutoring/seller",               the line's label
    "code":  "<64 hex>",                      the line's code
    "root":  "<64 hex>",                      the root of the issuer's list the proof was made against
    "proof": ["<64 hex>", … 8 in all] },      the proof's coordinates, in Semaphore's packed order
  "createdAt": "2026-09-30T12:00:00.000Z" }
```

`makeMembership` makes one. `verifyMembership` checks one the way a reader must:

1. the record names the issuer the reader is checking against;
2. the line (read from the chain at the record's code) is the profile's whose records hold it;
3. the record's label and code are the line's;
4. the root is one the issuer published;
5. the proof verifies for that root, the code, the profile and the label, against the verification
   key the program is sealed with (`artifacts/semaphore-32.json`).

Checking the issuer's signature on its roots comes before step 4, and is the reader's.

## Use it

The client (`client/src/`) talks to no network of its own: the caller passes the issuer's list, a
recent blockhash and a connection.

| Function | Gives |
|---|---|
| `commitmentOf(secret)` | The commitment an issuer puts in its list |
| `codeFor(secret, label)`, `lineAddress(code)` | A line's code and address, before any proof: an app can check whether the line exists |
| `buildRegistration({...})` | The proof, and the unsigned `register` transaction only the payer signs |
| `registerIx`, `refundIx` | The two instructions, by hand |
| `fetchLine(connection, code)`, `fetchLines(connection, { profile })`, `decodeLine(data)` | Lines read back and checked |
| `makeMembership({...})`, `verifyMembership(record, {...})` | Memberships, as above |

```ts
import { buildRegistration } from '@forest/registry-client'

const r = await buildRegistration({
  secret: (await listSecret(seed, issuer)).secret,                  // keys/, for this issuer's list
  profile: (await profileKey(seed, 'tutoring/seller')).publicKey,   // keys/
  label: 'tutoring/seller',
  commitments,                                        // the issuer's published list, in its order
  artifacts: { wasm: 'artifacts/semaphore-32.wasm', zkey: 'artifacts/semaphore-32.zkey' },
  payer, recentBlockhash,
})
// r.transaction: unsigned; the payer signs it, and anyone sends it. r.line: the line's address.
```

```
cd registry/artifacts && npm ci && npm run fetch         # the proving files, hash-checked
cd registry/program   && cargo build-sbf --arch v3       # Solana CLI 4.2.2 or later
cd registry/program/tests-litesvm && cargo test          # the rules, the attacks, the property test
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm ci && npm test              # no chain needed
cd registry/client    && npm run test:validator          # starts solana-test-validator itself
cd registry/client    && npm run test:devnet             # read-only, against devnet/devnet.json
cd registry/client    && npm run fixtures                # remake the real proofs the Rust tests use
```

The LiteSVM tests run against real proofs committed in
`program/tests-litesvm/fixtures/proofs.json`, which `npm run fixtures` makes, and check the wire
format against a second copy written by hand in `program/tests-litesvm/src/lib.rs`.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` builds a copy with the devnet
program id, deploys it (its exact cost checked first), and records it; then
`FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts` in `client/` writes a line, shows the refusal of a
second one and a refund, and checks a second issuer's membership against the line. The keys come
from [devnet/](../devnet/README.md).

## What one line costs

From the line on devnet (`devnet/devnet.json`), one signature, no compute-budget instruction:

| | Bytes of 1,232 | Compute units of 200,000 |
|---|---|---|
| `register`, a 16-byte label (v0 transaction) | 491 | 125,258 |
| `refund` | | 4,769 |

One proof is about 120,000 compute units to verify, and a second or two to make in Node. The
deposit is the rent-exempt minimum for the line's size: 1,488,440 lamports for that 165-byte line
at today's rate. The network fee is 5,000 lamports a signature. The program is 165,320 bytes.

## What is sealed

None of this can change after deploy; a change breaks every existing proof, code or line.

- **The circuit and the verification key.** Semaphore 4.0.0, depth 32. Public signals in the order
  root, nullifier, message, scope; `proof_a` negated in the program; points arriving compressed;
  every public input checked to be below BN254's scalar order.
- **The scope and the message.** `keccak256(namespace ‖ bytes) >> 8`, with the namespaces
  `forest.foundation/label/v1/` (the label's UTF-8) and `forest.foundation/profile/v1/` (the
  profile's 32-byte key). Memberships use the same.
- **The code and its address.** The code is the nullifier, `Poseidon(scope, secret)`; the line is at
  `["code", code]`.
- **The line's layout, the instruction bytes and the discriminators.** Written twice on purpose, in
  `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against each other and
  against what the program writes.
- **The rules.** One proof per `register`; one line per code; a label of at most 128 bytes; no
  signature but the payer's; a line never written again; a refund of exactly the excess, to the
  recorded payer only.
- **The identity on the device.** Semaphore's own, from the person's 32-byte identity secret.
  Not in the program, but a change makes every commitment unreachable.

On mainnet the program is sealed the day it deploys, and a later version is a new program at a new
address; its lines stay readable forever:

```
solana program deploy --program-id <keypair> target/deploy/forest_registry.so
solana program set-upgrade-authority <program id> --final
solana program show <program id>          # Authority: none
```

## Limits

- **A line is only as good as its issuer.** Roots are not checked, so anyone can make a list of
  their own and write lines against it. A reader that trusts no issuer finds no badge.
- **A line does not show who holds the profile's key.** The proof names the profile and the profile
  key signs nothing, so a verified human can put their one line per label on any profile, someone
  else's included.
- **One line per identity secret, not per face.** A person with two seeds on two issuers' lists can
  hold two lines under one label; a reader counting both issuers sees both.
- **[keys/](../keys/README.md) now mixes one secret per list, not one per person.** This client
  and its tests still assume one identity secret per person, the same on every issuer's list. With
  keys/'s `listSecret`, a person has another code under each issuer: a second issuer's membership
  no longer matches their line, and two issuers' lists give two lines under one label.
- **Roots can link lines.** Lines or memberships that carry the same root, or the same rare set of
  roots, can be matched by anyone reading.
- **Where issuers publish their lists and roots, and in what signed form, is not defined here.**
  `verifyMembership` takes the roots as given.
- **Refunds go to whoever paid.** When a relayer sends `register`, refunds go to the relayer. A
  refund to a payer holding no SOL is refused until it holds some again.
- **The source's program id is a placeholder** (`FoRBadgeLine…1111`) nobody holds a key for; every
  deploy substitutes its own.
- **Not audited.** The [security checklist](security-checklist.md) lists every rule and every known
  limit.

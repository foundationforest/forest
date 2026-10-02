# registry

Devnet only: the program runs on devnet at `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC`, still
upgradable ([record](devnet/devnet.json)). Nothing is on mainnet.

Up: [the repo](../README.md). Down: [the setup files](artifacts/README.md), the
[security checklist](security-checklist.md).

A free public list on Solana, and the client a device uses to add to it and read it. Each row says:
*this profile holds a stamp on this keeper's list, under this label*. It is proven without saying
which stamp, so without saying who. One person gets at most one row per keeper per label. A row is
written once and never changes. The program holds nothing else: no fee, no token, no treasury, no
admin and no list. The only costs are Solana's own: the network fee and the row's deposit, paid by
whoever sends the transaction.

## How it works

- **Keepers and lists.** A keeper is anyone who keeps a list of stamps. The issuer keeps the human
  list: it checks a face once and adds that person's stamp. A keeper publishes its list its own way
  (every stamp, in the order it took them) and signs each snapshot: an ed25519 signature over the
  list's root, as 32 big-endian bytes.
- **Stamps.** A person's device derives a secret for each list from their seed and the keeper's
  address (`keys/`: `listSecret(seed, keeper)`). Its Semaphore commitment is their stamp on that
  list. The stamp is the only thing that leaves the device, once, to that keeper. Stamps on two
  lists cannot be matched to each other.
- **Market stamps.** The proof's nullifier, with the label as its scope, is the person's market
  stamp. It is the same every time for one person on one list under one label, and nobody else can
  work it out.
- **The row.** To register, the device proves "my stamp is on the list with this root", for one
  label and one profile, and the profile's key signs the transaction. The program verifies the
  proof, requires that signature, and writes the row at the address derived from the market stamp.
  It stores the keeper's address and its signature on the root exactly as given.
- **One per keeper per market per human.** A second row at the same market stamp's address cannot
  exist. A second profile in the same market needs a stamp on a second keeper's list.
- **Readers decide.** The program checks no root and no keeper. A reader counts a row when it trusts
  the row's keeper and the keeper's signature on the root checks (`keeperSigned`). Each reader keeps
  its own list of keepers it trusts.
- **Labels.** Free text of at most 128 bytes. The recommended shape is `market/role`, such as
  `tutoring/seller`, with names from the
  [markets directory](https://github.com/foundationforest/markets). The program does not care what
  the text says.
- **Anyone pays.** Whoever signs as payer (the person, an app, a relayer) pays the deposit and is
  recorded, so a refund can find them.

## The row

At `["row", market stamp]`. Every fixed field sits at a fixed offset; the label is last.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | discriminator, `sha256("account:Row")[..8]` |
| 8 | 32 | profile: its ed25519 key, which signed |
| 40 | 32 | keeper: its ed25519 key, as given |
| 72 | 32 | root of the keeper's list the proof was made against |
| 104 | 64 | keeper's signature over the root, as given |
| 168 | 32 | payer |
| 200 | 1 | bump |
| 201 | 4 + n | label: u32 length, then UTF-8 |

A row is `205 + label` bytes, and never more. A reader finds every row of one profile with a filter
at offset 8, of one keeper at offset 40, and of one label at offset 201 (`fetchRows`).

## Instructions

| | What it does | Signs |
|---|---|---|
| `register(market stamp, keeper, root, keeper signature, proof, label)` | Verifies the proof with public inputs `[root, market stamp, message(profile), scope(label)]`, then writes the row. A second row for the same market stamp is refused | the profile and the payer (one key may be both) |
| `refund()` | Moves what a row holds above its current rent-exempt minimum to the payer the row records. The row's data is untouched | nobody |

The scope is `keccak256("forest.foundation/label/v1/" ‖ label) >> 8`, and the message
`keccak256("forest.foundation/profile/v1/" ‖ profile key) >> 8`. The program derives both, so a
proof counts for one label and one profile and no other. The program emits no events; readers read
the rows.

## Use it

The client (`client/src/`) talks to no network of its own: the caller passes the keeper's list and
signature, a recent blockhash and a connection.

| Function | Gives |
|---|---|
| `stampOf(secret)` | The person's stamp, what the keeper puts in its list |
| `marketStampOf(secret, label)`, `rowAddress(marketStamp)` | A row's market stamp and address, before any proof: an app can check whether the row exists |
| `buildRegistration({...})` | Checks the keeper's signature, makes the proof, and returns the unsigned `register` transaction |
| `registerIx`, `refundIx` | The two instructions, by hand |
| `fetchRow(connection, marketStamp)`, `fetchRows(connection, { profile, keeper, label })`, `decodeRow(data)` | Rows read back and checked |
| `keeperSigned(row)` | Whether the row's keeper signed its root |

```ts
import { listSecret } from '@forest/keys'
import { buildRegistration } from '@forest/registry-client'

const r = await buildRegistration({
  secret: await listSecret(seed, keeper.toBase58()),
  label: 'tutoring/seller',
  profile,                      // the profile's key; it signs
  keeper,                       // the keeper's key
  stamps,                       // the keeper's published list, in its order
  keeperSignature,              // the keeper's signature over that list's root
  artifacts: { wasm: 'artifacts/semaphore-32.wasm', zkey: 'artifacts/semaphore-32.zkey' },
  payer, recentBlockhash,
})
// r.transaction: unsigned; the profile and the payer sign it, and anyone sends it. r.row: its address.
```

```
cd registry/artifacts && npm ci && npm run fetch         # the proving files, hash-checked
cd registry/program   && cargo build-sbf --arch v3       # Solana CLI 4.2.2 or later
cd registry/program/tests-litesvm && cargo test          # the rules, the attacks, the property test
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm ci && npm test              # no chain needed (install keys/ first)
cd registry/client    && npm run test:validator          # starts solana-test-validator itself
cd registry/client    && npm run test:devnet             # read-only, against devnet/devnet.json
cd registry/client    && npm run fixtures                # remake the real proofs the Rust tests use
```

The LiteSVM tests run against real proofs committed in
`program/tests-litesvm/fixtures/proofs.json`, which `npm run fixtures` makes. They check the wire
format against a second copy written by hand in `program/tests-litesvm/src/lib.rs`.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` builds a copy with the devnet
program id, deploys it (its exact cost checked first) and records it. Then
`FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts` in `client/` writes one row, shows the refusal of
a second profile's row for the same market stamp, and a refund. The person is the keys recipe's test
seed; the keeper and the profiles are stand-ins. The keys come from [devnet/](../devnet/README.md).

## What one row costs

From the row on devnet (`devnet/devnet.json`): a v0 transaction, two signatures, no compute-budget
instruction.

| | Bytes of 1,232 | Compute units of 200,000 |
|---|---|---|
| `register`, a 16-byte label | 652 | 124,158 |
| `refund` | | 3,194 |

One proof is about 120,000 compute units to verify, and a second or two to make in Node. The
deposit is the rent-exempt minimum for the row's size: 1,772,920 lamports for that 221-byte row at
today's rate. The network fee is 5,000 lamports a signature. The program is 164,288 bytes.

## What it promises

- At most one row per market stamp: one per person per keeper per label.
- Only the profile's key can put a row on a profile.
- A proof counts for one label and one profile: the program derives the scope from the label and
  the message from the profile, and verifies against them.
- A row is never written again after `register`, and never closes.
- `refund` moves only what a row holds above its rent-exempt minimum, and only to the payer it
  records.

## What it trusts

- **Semaphore's circuit, unchanged,** with the depth-32 verification key of its public July 2024
  setup, baked into the program ([artifacts](artifacts/README.md)).
- **`groth16-solana` 0.2.0** and Solana's `alt_bn128` syscalls to verify; Anchor 1.2.
- **Keepers,** to put on their lists only the stamps they say they do (the issuer: one per real,
  distinct human). The program cannot tell; readers choose whom to trust.
- **On the device:** `snarkjs` 0.7.5 and `@semaphore-protocol/*` 4.12.1 to make proofs.

## Sealed on mainnet

On mainnet the program is sealed the day it deploys: nothing in it can change, and a later version
is a new program at a new address whose rows start empty. On devnet it stays upgradable, for
testing. What a mainnet deploy seals:

- **The circuit and the verification key.** Semaphore 4.0.0, depth 32. Public signals in the order
  root, nullifier, message, scope; `proof_a` negated in the program; points arriving compressed;
  every public input checked to be below BN254's scalar order.
- **The scope and the message,** as above.
- **The row's address and layout, the instruction bytes and the discriminators.** Written twice on
  purpose, in `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against
  each other and against what the program writes.
- **The rules.** One proof per `register`; one row per market stamp; a label of at most 128 bytes;
  the profile's signature; a row never written again; a refund of exactly the excess, to the
  recorded payer only.

```
solana program deploy --program-id <keypair> target/deploy/forest_registry.so
solana program set-upgrade-authority <program id> --final
solana program show <program id>          # Authority: none
```

## Limits

- **A row is only as good as its keeper.** Roots and keepers are not checked, so anyone can keep a
  list of their own and write rows against it. A reader that trusts no keeper counts no row.
- **The keeper's signature is checked by readers, not the program.** A row whose signature does not
  check is stored for good and holds that market stamp. `buildRegistration` checks the signature
  before it proves anything.
- **One row per list, not per face.** A person on two keepers' lists can hold two rows under one
  label, for two profiles. A reader that trusts both keepers counts both.
- **Roots can link rows.** Two rows carrying the same root came from one snapshot. When few people
  are on a snapshot, that narrows who they could be. Apps prove against a keeper's newest list.
- **Whoever pays is recorded.** When a relayer pays, refunds go to the relayer. A refund to a payer
  holding no SOL is refused until it holds some again.
- **A row's address funded first, below the row's minimum, cannot be registered through the
  relayer.** Anchor's `init` then tops the address up with a transfer from the payer, which the
  relayer's configuration does not allow. Any other payer still registers it.
- **The source's program id is a placeholder** (`FoRRegistryRows…1111`) nobody holds a key for;
  every deploy substitutes its own.
- **Not audited.** The [security checklist](security-checklist.md) lists every rule and every known
  limit.

## FAQ

**Why does a row carry a snapshot's root and the keeper's signature?** A keeper's list keeps
growing; a proof is made against the list as it was at one moment. The keeper's signature on that
moment's root lets any reader check, forever and without asking the keeper, that the list was the
keeper's. The program never needs to know who the keepers are, so anyone can be one.

**Can I have two profiles in one market?** Yes, through two keepers. Each list gives you its own
market stamp, so the issuer's list gives you one row per market. A second row needs a stamp on a
second keeper's list, and a second keeper that checks faces means a second face check. Nothing on
chain ties the two rows to each other.

**Can a stranger register my profile?** No. `register` needs the profile's signature, and the proof
names the profile, so a proof seen in flight cannot be landed under anyone else's profile either.

**What is `refund` for?** Solana is cutting its rent rate in steps, and only the owning program can
move the difference out of its accounts. `refund` sends what a row holds above the new minimum back
to whoever paid for it. Anyone may send it: the amount and the destination are read from the chain.

**Why does a row never change or close?** Its existence is the one-row-per-market-stamp rule:
closing it would free the market stamp for a second row.

**What if I lose my seed?** The rows stay on the chain and nobody else can use them, but your list
secrets are gone, and the issuer's face check will not take you again. The 24 words are the only
backup.

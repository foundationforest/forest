# registry

Devnet only: the program runs on devnet at `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC`, still upgradable ([record](devnet/devnet.json)); nothing is on mainnet.

Up: [the repo](../README.md). Down: the [security checklist](security-checklist.md).

## What it is

A free public list on Solana, and the client a device uses to add to it and read it. Each row says:
*this profile holds a stamp on this issuer's list, under this label*. It is proven without saying
which stamp, so without saying who. One stamp gets at most one row per label; whether that is one
per person is the issuer's policy. A row is written once and never changes. The program holds
nothing else: no fee, no token, no treasury, no admin and no list. The only costs are Solana's own:
the network fee and the row's deposit, paid by whoever sends the transaction.

- `program/`: the program (Anchor 1.2) and its LiteSVM tests, the property test among them.
- `client/`: stamps, proofs and their check off chain, the two instructions, and rows read back.
  It talks to no network of its own.
- `artifacts/`: Semaphore's setup files the program is sealed against.
- `circuit/`: the person proof, which the program takes next: the circuit, its devnet setup and its
  tests.
- `devnet/`: the deploy script and the public record of what runs on devnet.

## How it works

- **Issuers and lists.** An issuer is anyone who keeps a list of stamps. An issuer that checks faces
  keeps a human list: it checks a face once and adds that person's stamp. An issuer publishes its
  list its own way (every stamp, in the order it took them) and signs each snapshot: an ed25519
  signature over the list's root, as 32 big-endian bytes.
- **Stamps.** A person's device derives a secret for each list from their seed and the issuer's
  name (`keys/`: `issuerSecret(seed, name)`). Its Semaphore commitment is their stamp on that
  list. The stamp is the only thing that leaves the device, once, to that issuer. Stamps on two
  lists cannot be matched to each other.
- **Market stamps.** The proof's nullifier, with the label as its scope, is the person's market
  stamp. It is the same every time for one person on one list under one label, and nobody else can
  work it out.
- **The row.** To register, the device proves "my stamp is on the list with this root", for one
  label and one main key, and the main key signs the transaction; registered, it is that profile.
  The program verifies the proof, requires that signature, and writes the row at the address
  derived from the market stamp. It stores the issuer's address and its signature on the root
  exactly as given.
- **One per market stamp.** A second row at the same market stamp's address cannot exist, so a
  second profile in the same market needs a second stamp. How many stamps an issuer gives one
  person is its policy; one that checks faces gives one.
- **Readers decide.** The program checks no root and no issuer. A reader counts a row when it trusts
  the row's issuer and the issuer's signature on the root checks (`issuerSigned`). Each reader keeps
  its own list of issuers it trusts.
- **Labels.** Free text of at most 128 bytes. The recommended shape is `market/role`, such as
  `tutoring/seller`, with names from the
  [markets directory](https://github.com/foundationforest/markets). The program does not care what
  the text says.
- **Anyone pays.** Whoever signs as payer (the person, an app or a fee payer) pays the deposit and
  is recorded, so a refund can find them.

### The row

At `["row", market stamp]`. Every fixed field sits at a fixed offset; the label is last.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | discriminator, `sha256("account:Row")[..8]` |
| 8 | 32 | profile: the main key, which signed |
| 40 | 32 | issuer: its ed25519 key, as given |
| 72 | 32 | root of the issuer's list the proof was made against |
| 104 | 64 | issuer's signature over the root, as given |
| 168 | 32 | payer |
| 200 | 1 | bump |
| 201 | 4 + n | label: u32 length, then UTF-8 |

A row is `205 + label` bytes, and never more. A reader finds every row of one profile with a filter
at offset 8, of one issuer at offset 40, and of one label at offset 201 (`fetchRows`).

### Instructions

| | What it does | Signs |
|---|---|---|
| `register(market stamp, issuer, root, issuer signature, proof, label)` | Verifies the proof with public inputs `[root, market stamp, message(profile), scope(label)]`, then writes the row. A second row for the same market stamp is refused | the main key and the payer (one key may be both) |
| `refund()` | Moves what a row holds above its current rent-exempt minimum to the payer the row records. The row's data is untouched | nobody |

The scope is `keccak256("forest.foundation/label/v1/" ‖ label) >> 8`, and the message
`keccak256("forest.foundation/profile/v1/" ‖ main key) >> 8`. The program derives both, so a
proof counts for one label and one profile and no other. The program emits no events; readers read
the rows.

### The setup files

Semaphore's circuit and its published setup files, in `artifacts/`, used unchanged. Forest wrote
none of this.

- **Which ones.** The `4.13.0` files at depth 32, from PSE's second public Semaphore V4 setup
  (p0tion, July 23 to August 2025). It was run for the fixed circuit: from 4.13.0 the circuit takes
  a stamp's place in the list as one number and splits it into bits that must each be 0 or 1
  (zk-kit's `BinaryMerkleRoot` 2.0.0). The `4.0.0` circuit before it did not force those bits, so a
  proof could be made for a secret on no list. The proving key carries the setup's own record: 319
  contributions and a final beacon. `client/` and `keys/` keep `@semaphore-protocol/identity` and
  `group` at 4.12.1, whose code 4.13.0 does not change; the client hands the circuit its inputs
  itself.
- **What is committed.** `semaphore-32.json`, the verification key. The program has it baked in as
  `program/src/verifying_key.rs`, and the client carries it as `client/src/verification-key.ts` for
  `verifyStamp`, which a test checks is the same key.
- **What is not.** `semaphore-32.zkey` and `semaphore-32.wasm`, used only to make a proof on a
  device, and the circuit's two Semaphore sources, for reading. `manifest.json` pins them by URL
  and SHA-256, and `npm run fetch` refuses anything whose hash does not match.

```
cd registry/artifacts
npm ci
npm run fetch      # the proving files and the circuit's sources, hash-checked
npm run vk         # rewrite ../program/src/verifying_key.rs from semaphore-32.json
```

`parse_vk_to_rust.cjs` is `groth16-solana` 0.2.0's own converter, copied unchanged. `npm run vk` on
an unchanged `semaphore-32.json` must leave `verifying_key.rs` byte for byte the same; if it does
not, the program is no longer sealed against this ceremony.

| File | Bytes | SHA-256 |
|---|---|---|
| `semaphore-32.json` | 3,746 | `3c0fd8c30c15df4db6970c0dfac35a3ac8d566ed5924072c9852ee566d4a90ae` |
| `semaphore-32.zkey` | 5,850,470 | `2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650` |
| `semaphore-32.wasm` | 1,859,813 | `528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5` |
| `semaphore.circom` | 3,888 | `d67fbae4504476569c03ce7beb23bacf4c4ebb9cbd8f49888f57ed14b288e486` |
| `binary-merkle-root.circom` | 1,823 | `39adb3f24849775325b322ca53b5a114a5e4e175501a8cb5f4f9c4235e5fe835` |

### Use it

The client (`client/src/`) talks to no network of its own: the caller passes the issuer's list and
signature, a recent blockhash and a connection.

| Function | Gives |
|---|---|
| `stampOf(secret)` | The person's stamp, what the issuer puts in its list |
| `marketStampOf(secret, label)`, `rowAddress(marketStamp)` | A row's market stamp and address, before any proof: an app can check whether the row exists |
| `buildRegistration({...})` | Checks the issuer's signature, makes the proof, and returns the unsigned `register` transaction |
| `registerIx`, `refundIx` | The two instructions, by hand |
| `fetchRow(connection, marketStamp)`, `fetchRows(connection, { profile, issuer, label })`, `decodeRow(data)` | Rows read back and checked |
| `issuerSigned(row)` | Whether the row's issuer signed its root |
| `verifyStamp({ proof, root, marketStamp, label, profile })` | Whether a proof (`proveStamp`'s `raw`) holds for that root, market stamp, label and main key: check a proof without the chain. A service that sponsors rows checks a second proof this way |

```ts
import { issuerSecret } from '@forest/keys'
import { buildRegistration } from '@forest/registry-client'

const r = await buildRegistration({
  secret: (await issuerSecret(seed, name)).secret,
  label: 'tutoring/seller',
  profile,                      // the main key; it signs
  issuer,                       // the issuer's key
  stamps,                       // the issuer's published list, in its order
  issuerSignature,              // the issuer's signature over that list's root
  artifacts: { wasm: 'artifacts/semaphore-32.wasm', zkey: 'artifacts/semaphore-32.zkey' },
  payer, recentBlockhash,
})
// r.transaction: unsigned; the main key and the payer sign it, anyone sends it. r.row: its address.
```

```
cd registry/artifacts && npm ci && npm run fetch         # the proving files, hash-checked
cd registry/program   && cargo build-sbf --arch v3       # Solana CLI 4.2.2 or later
cd registry/program/tests-litesvm && cargo test          # the rules, the attacks, the property test
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm ci && npm test              # no chain; fetches the proving files (install keys/ first)
cd registry/client    && npm run test:validator          # starts solana-test-validator itself
cd registry/client    && npm run test:devnet             # read-only, against registry/devnet/devnet.json
cd registry/client    && npm run fixtures                # remake the real proofs the Rust tests use
```

The LiteSVM tests run against real proofs committed in
`program/tests-litesvm/fixtures/proofs.json`, which `npm run fixtures` makes. Their test person is
keys/'s: two profiles from its test seed, and secrets mixed from it by `keys/`'s `hkdf` under the
string the fixtures were made with, `forest/v1/list/<issuer address>`. They check the wire
format against a second copy written by hand in `program/tests-litesvm/src/lib.rs`. One proof made
with the earlier 4.0.0 files is kept in `fixtures/proof-4.0.0.json`, to show the program refuses it.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` builds a copy with the devnet
program id, deploys it, or upgrades it in place when it holds other bytes (the exact cost checked
first), and records it in `devnet/devnet.json`; the script's header holds the recipe for every
devnet key it needs. Then
`FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts` in `client/` writes one row, shows the refusal of
a second profile's row for the same market stamp, and a refund. The person is keys/'s test person:
its test seed, and two of its profiles, all through `keys/`. The issuer is a stand-in. A row an
earlier test person left stays on chain (rows never close), and the record keeps it under
`earlierRows`; the closed registries before this one are under `earlier`.

### What one row costs

Measured on devnet, from the row in `devnet/devnet.json` (`row`): a v0 transaction, two signatures,
no compute-budget instruction.

| | Bytes of 1,232 | Compute units of 200,000 |
|---|---|---|
| `register`, a 16-byte label | 652 | 121,158 |
| `refund` | | 3,194 |

One proof is about 120,000 compute units to verify, and a second or two to make in Node. The
deposit is the rent-exempt minimum for the row's size: 1,772,920 lamports for that 221-byte row at
today's rate. The network fee is 5,000 lamports a signature. The program is 164,288 bytes.

### The note and the person proof

This is the proof registering takes next. The program switches to it in the next pull request;
until then `register` takes the membership proof above. The circuit, its devnet setup and the client run
now, off chain.

- **The note.** Instead of keeping a list, an issuer signs a note for each person it checks:
  *note number, face embedding, model name, tier*.
  - The note number is Poseidon of the person's secret for that issuer (`keys/`:
    `issuerSecret(seed, name)`). The device sends it to the issuer once; the issuer never learns
    the secret.
  - The embedding is the bytes the issuer's model gives for the face, the model name says which
    model, and the tier is a number whose meaning is the issuer's.
  - The issuer signs `Poseidon(tag, note number, keccak256(embedding) >> 8, keccak256(model) >> 8,
    tier)` with its EdDSA key on Baby Jubjub, over Poseidon (circomlib's). The tag is
    `keccak256("forest/v1/note") >> 8`, always the same, so nothing an issuer signs for another
    purpose can be turned into a note. The embedding and the model enter the signed message only
    as their hashes. The person keeps the note.
- **The person proof.** To register, the device proves, showing neither the secret nor the note:
  *I know an issuer secret and a note this issuer signed whose note number is the hash of that
  secret; my stamp for this label is the hash of that secret and the label; this proof is for this
  main key.*
  - Public: the issuer's key (two numbers), the label (as its scope), the main key (as its
    message), the stamp and the tier.
  - The stamp is `Poseidon(scope, secret)`, the number a row's address comes from today (its
    market stamp). It depends on the secret and the label, not on the note, so a new note, with
    a new tier or under a new key, keeps the same stamp.
  - The same proof, attached to a profile later, shows that profile's tier.
- **The issuer's key is the issuer's to keep.** Whoever holds it can sign notes for people who do
  not exist, and so can anyone it signs a number for without knowing what that number is. Rows name
  the issuer, so readers can stop trusting a key. The person's secret comes from the issuer's name,
  not its key, so a new key changes no one's stamps.
- **The setup is single-party.** One party made it, so until a public setup ceremony, whoever ran
  `circuit/devnet/setup.sh` could forge a proof. Devnet only.

[`circuit/person.circom`](circuit/person.circom):

| | Signals |
|---|---|
| Private | `secret`, the scalar `keys/`'s `issuerSecret` gives; the note's embedding hash and model hash; the issuer's signature, `R8x`, `R8y` and `S` |
| Public, in this order | `stamp`, the output; `issuerX`, `issuerY`; `scope`; `message`; `tier` |

Inside the proof: the note number is `Poseidon(secret)`; circomlib's `EdDSAPoseidonVerifier`,
unchanged, checks that the issuer's key signed `Poseidon(tag, note number, embedding, model, tier)`,
with the tag fixed in the circuit; the stamp is `Poseidon(scope, secret)`; and the message is
squared, as Semaphore does, so it cannot be changed in a proof. The scope and the message are the
ones `register` derives.

The setup's phase 1 is the reputation circuit's: PSE's Perpetual Powers of Tau,
`ppot_0080_16.ptau`, pinned by SHA-256 in `circuit/devnet/setup.sh`. Phase 2 is one contribution.
Every file is small, so all are committed in `circuit/devnet/`, pinned in `setup.json`;
`npm run fetch` checks their hashes, and `npm run compile` checks the compiled circuit against
`setup.json`. `person.circom` does not change after its setup: a change means a new setup.

| File | Bytes | SHA-256 |
|---|---|---|
| `verification-key.json` | 3,838 | `5d0f0b9c62e6b0013e8c19e86bb00628dbe3bcb39d35bebaac8ac64c5faaaaa4` |
| `person.zkey` | 3,396,483 | `90632ee12c389127007c2c5e29a1974fad42bc080e47b127a1f6426ad6c94dd3` |
| `person.wasm` | 2,815,205 | `063882b8f5a8208d16485c609494b53b1b0fd84da234f5207b63f80bd8e56c99` |

| Function | Gives |
|---|---|
| `signNote(privateKey, note)`, `issuerKeyOf(privateKey)` | For an issuer: the signed note, and its key |
| `noteNumberOf(secret)`, `noteHash(note)`, `noteSigned(note)` | The note number, what an issuer signs, and whether its issuer signed it |
| `provePerson({ secret, note, label, profile, artifacts })` | The proof, on the device. Refuses a note for another secret, or one its issuer did not sign |
| `verifyPerson({ proof, issuer, label, profile, stamp, tier })` | Whether the proof holds for that issuer, label, main key, stamp and tier |
| `personInput({...})` | The circuit's input, for a caller that drives snarkjs itself |

```
cd keys && npm ci && cd ../registry/client && npm ci     # the circuit's tests read both
cd registry/circuit && npm ci
npm run fetch                     # the committed setup files, hash-checked
npm run compile                   # circom 2.2.3 on PATH or in CIRCOM; checks setup.json
npm run check && npm test         # a proof, and every way one must fail
devnet/setup.sh                   # a new setup: new files, every hash new
```

The tests make a proof for `keys/`'s test person and check that a wrong issuer key, a forged
signature, the issuer's signature without the tag, a tier the issuer did not sign, another person's
secret, a stamp for another label and a proof replayed for another main key all fail.

Measured in Node 22 on a 4-core machine: 4,979 constraints; a proof takes about 0.7 s to make and
50 ms to check, and is 725 bytes as snarkjs writes it. It trusts circom 2.2.3, snarkjs 0.7.5,
circomlib 2.0.5's EdDSA verifier and Poseidon, and zk-kit's `@zk-kit/eddsa-poseidon` 1.0.4 to sign,
used unchanged.

### Sealed on mainnet

On mainnet the program is sealed the day it deploys: nothing in it can change, and a later version
is a new program at a new address whose rows start empty. On devnet it stays upgradable, for
testing. What a mainnet deploy seals:

- **The circuit and the verification key.** Semaphore 4.13.0, depth 32 (the setup files above).
  Public signals in the order root, nullifier, message, scope; `proof_a` negated in the program;
  points arriving compressed; every public input checked to be below BN254's scalar order.
- **The scope and the message,** as above. Their strings, `forest.foundation/label/v1/` and
  `forest.foundation/profile/v1/`, never change: the label's is in every row's address, through the
  market stamp, and the profile's is in every proof.
- **The row's address and layout, the instruction bytes and the discriminators.** Written twice on
  purpose, in `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against
  each other and against what the program writes.
- **The rules.** One proof per `register`; one row per market stamp; a label of at most 128 bytes;
  the main key's signature; a row never written again; a refund of exactly the excess, to the
  recorded payer only.

```
solana program deploy --program-id <keypair> target/deploy/forest_registry.so
solana program set-upgrade-authority <program id> --final
solana program show <program id>          # Authority: none
```

## Promises

- At most one row per market stamp: one per stamp per label.
- Only the main key can put a row on its profile.
- A proof counts for one label and one profile: the program derives the scope from the label and
  the message from the profile, and verifies against them.
- A row is never written again after `register`, and never closes.
- `refund` moves only what a row holds above its rent-exempt minimum, and only to the payer it
  records.

## Limits

- **It trusts Semaphore's circuit, unchanged,** with the depth-32 verification key of its public
  2025 setup, baked into the program (the setup files, above).
- **The earlier pin could be forged.** Until the upgrade at slot 507,437,633 on devnet, the program
  checked proofs with Semaphore 4.0.0's key, whose circuit let a proof be made for a secret on no
  list. The rows written before it stay, and the program never checks a row again.
- **It trusts `groth16-solana` 0.2.0** and Solana's `alt_bn128` syscalls to verify, and Anchor 1.2.
- **It trusts issuers** to put on their lists only the stamps they say they do (one that checks
  faces: one per real, distinct human). The program cannot tell; readers choose whom to trust.
- **On the device, it trusts** `snarkjs` 0.7.5 and `@semaphore-protocol/identity` and `group`
  4.12.1 to make proofs; `verifyStamp` trusts `snarkjs` to check them.
- **A row is only as good as its issuer.** Roots and issuers are not checked, so anyone can keep a
  list of their own and write rows against it. A reader that trusts no issuer counts no row.
- **The issuer's signature is checked by readers, not the program.** A row whose signature does not
  check is stored for good and holds that market stamp. `buildRegistration` checks the signature
  before it proves anything.
- **One row per list, not per face.** A person on two issuers' lists can hold two rows under one
  label, for two profiles. A reader that trusts both issuers counts both.
- **Roots can link rows.** Two rows carrying the same root came from one snapshot. When few people
  are on a snapshot, that narrows who they could be. Which snapshot to prove against is the app's
  choice; the newest holds the most people.
- **Whoever pays is recorded.** A fee payer that pays gets the refund. A refund to a payer holding
  no SOL is refused until it holds some again.
- **The source's program id is a placeholder** (`FoRRegistryRows…1111`) nobody holds a key for;
  every deploy substitutes its own.
- **Not audited.** The [security checklist](security-checklist.md) lists every rule and every known
  limit.

## Who decides what

- **The standard:** the row, the proof, and one row per market stamp; to be sealed on mainnet.
- **An issuer, by its own policy:** how it checks who goes on its list, and how it publishes it.
- **Other services, by their own policy:** which rows a fee payer pays for; which issuers an index
  counts.
- **An app, with the person:** when to register, and making the proof on the device.

## FAQ

**Why does a row carry a snapshot's root and the issuer's signature?** An issuer's list keeps
growing; a proof is made against the list as it was at one moment. The issuer's signature on that
moment's root lets any reader check, forever and without asking the issuer, that the list was the
issuer's. The program never needs to know who the issuers are, so anyone can be one.

**Can I have two profiles in one market?** Yes, with a second stamp. Each stamp gives its own
market stamp, so one stamp gives one row per market. How many stamps one issuer gives a person is
its policy: one that checks faces gives one, so a second row needs a second issuer's list, and a
second face check. Nothing on chain ties the two rows to each other, but moving money between your
own profiles links them until a privacy pool is used.

**Why are rows not numbered?** A number shared across registrations would link a person's profiles.
A row's address comes from its market stamp alone: one per stamp, per label. Whether that is one per
person is the issuer's policy.

**Why does the program not check the issuer or the root?** Anyone must be able to keep a list, so
lists stay off chain and the program knows no issuer. Each reader weighs whose lists it trusts.

**Who pays for a row?** Whoever signs as payer: the person, an app or a fee payer. The program pays
for no one and cannot tell who the payer is, so paying for someone else needs nothing in it. There
is no fee: only Solana's network fee and the row's deposit.

**Can a stranger register my profile?** No. `register` needs the main key's signature, and the proof
names the main key, so a proof seen in flight cannot be landed under anyone else's profile either.

**What is `refund` for?** Solana is cutting its rent rate in steps, and only the owning program can
move the difference out of its accounts. `refund` sends what a row holds above the new minimum, or
anything someone sent the row, back to whoever paid for it. Anyone may send it: the amount and the
destination are read from the chain, never from the caller.

**Why does a row never change or close?** Its existence is the one-row-per-market-stamp rule:
closing it would free the market stamp for a second row.

**What if I lose my seed?** The rows stay on the chain and nobody else can use them, but your issuer
secrets are gone, and the issuer's face check will not take you again. The 24 words are the only
backup.

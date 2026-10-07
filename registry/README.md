# registry

Devnet only: the program runs on devnet at `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4`, still
upgradable ([record](devnet/devnet.json)). The version before it, which took Semaphore's membership
proof, is left behind at `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC`. Nothing is on mainnet.

Up: [the repo](../README.md). Down: the [security checklist](security-checklist.md).

## What it is

A free public list on Solana, and the client a device uses to add to it and read it. Each row says:
*this profile holds a note this issuer signed, under this label*. It is proven without showing the
note, so without saying who. A stamp gets at most one row: a stamp is one person's, for one label,
at one issuer. A row is written once and never changes. The program holds nothing else: no fee, no
token, no treasury, no admin and no list. The only costs are Solana's own: the network fee and the
row's deposit, paid by whoever sends the transaction.

- `program/`: the program (Anchor 1.2) and its LiteSVM tests, the property test among them.
- `client/`: stamps, the person proof and its check off chain, the two instructions, rows read
  back, and a tier checked against its row. It talks to no network of its own.
- `circuit/`: the person proof the program checks: the circuit, its devnet setup and its tests.
- `devnet/`: the deploy script and the public record of what runs on devnet.

## How it works

- **Issuers and notes.** An issuer is anyone who signs notes for people. An issuer that checks
  faces checks a face once and signs that person a note. A note holds the person's note number,
  which comes from their secret, and a tier; the person keeps it (the note and the person proof,
  below).
- **Stamps.** A person's device derives a secret for each issuer from their seed and the issuer's
  name (`keys/`: `issuerSecret(seed, name)`). Their stamp for a label is `Poseidon(scope, secret)`:
  the same every time for one person at one issuer under one label, and nobody else can work it
  out. Stamps for two issuers or two labels cannot be matched to each other.
- **The row.** To register, the device proves, showing neither the secret nor the note, *this
  issuer's key signed a note for my secret; my stamp for this label is this one; this proof is for
  this main key*, and the main key signs the transaction; registered, it is that profile. The
  program verifies the proof, requires that signature, and writes the row at the address derived
  from the stamp. The row holds the main key, the stamp, the issuer's key, who paid, when it was
  made (the chain's clock, never the sender's) and the label.
- **The tier is not in the row.** The proof shows the tier the issuer signed, and the program
  checks it, but keeps nothing of it: a profile shows its tier with the same proof attached to it,
  and a reader checks that proof against the row (`verifyTier`).
- **One per stamp.** A second row at the same stamp's address cannot exist. A new note from the
  same issuer, with a new tier or under a new key, gives the same stamp, so a second profile in the
  same market needs a second issuer.
- **Readers decide.** The program checks no issuer: anyone can sign notes. A reader counts a row
  when it trusts the row's issuer key, and each reader keeps its own list of keys it trusts. If an
  issuer's key leaks, readers stop counting its rows from that date on.
- **Labels.** Free text of at most 128 bytes. The recommended shape is `market/role`, such as
  `tutoring/seller`, with names from the
  [markets directory](https://github.com/foundationforest/markets). The program does not care what
  the text says.
- **Anyone pays.** Whoever signs as payer (the person, an app or a fee payer) pays the deposit and
  is recorded, so a refund can find them.

### The row

At `["row", stamp]`. Every fixed field sits at a fixed offset; the label is last.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | discriminator, `sha256("account:Row")[..8]` |
| 8 | 32 | profile: the main key, which signed |
| 40 | 32 | stamp: the proof's output, which the address comes from; an index reads it here |
| 72 | 64 | issuer: its key on Baby Jubjub, x then y, each 32 bytes big-endian |
| 136 | 32 | payer |
| 168 | 8 | made: the chain's clock when the row was written, Unix seconds, i64 little-endian |
| 176 | 4 + n | label: u32 length, then UTF-8 |

A row is `180 + label` bytes, and never more. A reader finds every row of one profile with a filter
at offset 8, of one issuer at offset 72, and of one label at offset 176 (`fetchRows`).

### Instructions

| | What it does | Signs |
|---|---|---|
| `register(stamp, issuer, tier, proof, label)` | Verifies the proof with public inputs `[stamp, issuer x, issuer y, scope(label), message(profile), tier]`, then writes the row with the clock's time. A second row for the same stamp is refused | the main key and the payer (one key may be both) |
| `refund()` | Moves what a row holds above its current rent-exempt minimum to the payer the row records. The row's data is untouched | nobody |

The scope is `keccak256("forest.foundation/label/v1/" ‖ label) >> 8`, and the message
`keccak256("forest.foundation/profile/v1/" ‖ main key) >> 8`. The program derives both, so a
proof counts for one label and one profile and no other. The tier is checked and not kept. The
program emits no events; readers read the rows.

### Use it

The client (`client/src/`) talks to no network of its own: the caller passes the note, a recent
blockhash and a connection.

| Function | Gives |
|---|---|
| `stampOf(secret, label)`, `rowAddress(stamp)` | A row's stamp and address, before any proof: an app can check whether the row exists |
| `buildRegistration({...})` | Makes the person proof from the note, and returns the unsigned `register` transaction |
| `registerIx`, `refundIx` | The two instructions, by hand |
| `fetchRow(connection, stamp)`, `fetchRows(connection, { profile, issuer, label })`, `decodeRow(data)` | Rows read back and checked |
| `verifyTier(connection, { profile, stamp, tier, proof })` | The tier a profile shows: its person proof checked against its row. Gives the row, so the reader weighs its issuer and when it was made |

```ts
import { issuerSecret } from '@forest/keys'
import { buildRegistration } from '@forest/registry-client'

const r = await buildRegistration({
  secret: (await issuerSecret(seed, name)).secret,
  note,                         // the note the issuer signed for this person
  label: 'tutoring/seller',
  profile,                      // the main key; it signs
  artifacts: { wasm: 'registry/circuit/devnet/person.wasm', zkey: 'registry/circuit/devnet/person.zkey' },
  payer, recentBlockhash,
})
// r.transaction: unsigned; the main key and the payer sign it, anyone sends it. r.row: its address.
// r.proof, r.stamp and r.tier: what the profile shows for its tier.
```

```
cd registry/program   && cargo build-sbf --arch v3       # Solana CLI 4.2.2 or later
cd registry/program/tests-litesvm && cargo test          # the rules, the attacks, the property test
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm ci && npm test              # no chain (install keys/ first)
cd registry/client    && npm run test:validator          # starts solana-test-validator itself
cd registry/client    && npm run test:devnet             # read-only, against registry/devnet/devnet.json
cd registry/client    && npm run fixtures                # remake the real proofs the Rust tests use
```

The LiteSVM tests run against real person proofs committed in
`program/tests-litesvm/fixtures/proofs.json`, which `npm run fixtures` makes with the committed
devnet setup. Their test person is keys/'s: two profiles from its test seed, and its secrets for
keys/'s two test issuers. They check the wire format against a second copy written by hand in
`program/tests-litesvm/src/lib.rs`.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` builds a copy with the devnet
program id, deploys it, or upgrades it in place when it holds other bytes (the exact cost checked
first), and records it in `devnet/devnet.json`; the script's header holds the recipe for every
devnet key it needs. Then `FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts` in `client/` has a
stand-in issuer sign a note for keys/'s test person, writes one row, shows the refusal of a second
profile's row for the same stamp, and a refund, and checks the tier the profile shows against its
row; the record keeps that proof. The registries before this one are under `earlier`.

### What one row costs

Measured on devnet, from the row in `devnet/devnet.json` (`row`): a v0 transaction, two
signatures, no compute-budget instruction.

| | Bytes of 1,232 | Compute units of 200,000 |
|---|---|---|
| `register`, a 16-byte label | 620 | 132,511 |
| `refund` | | 3,164 |

One proof is about 130,000 compute units to verify, and about a second to make in Node. The deposit
is the rent-exempt minimum for the row's size: 1,645,920 lamports for that 196-byte row at today's
rate of 5,080 lamports a byte, and 225,504 once the rate reaches 696. The network fee is 5,000
lamports a signature. The program is 163,136 bytes.

### The note and the person proof

This is the proof registering takes.

- **The note.** An issuer signs a note for each person it checks: *note number, face embedding,
  model name, tier*.
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
  - The stamp is `Poseidon(scope, secret)`, the number a row's address comes from. It depends on
    the secret and the label, not on the note, so a new note, with a new tier or under a new key,
    keeps the same stamp.
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
`setup.json`. `person.circom` does not change after its setup: a change means a new setup, and a
new program. The program has the verification key baked in as `program/src/verifying_key.rs`,
written by `groth16-solana` 0.2.0's own converter (`circuit/scripts/parse_vk_to_rust.cjs`, copied
unchanged, `npm run vk`); a test checks it is the converter's output for the committed key.

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
npm run vk                        # rewrite ../program/src/verifying_key.rs from the committed key
devnet/setup.sh                   # a new setup: new files, every hash new, a new program key
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

- **The circuit and the verification key.** The person circuit, with the key of a public setup
  ceremony that comes before mainnet; on devnet, the single-party setup in `circuit/devnet/`.
  Public signals in the order stamp, issuer x, issuer y, scope, message, tier; `proof_a` negated in
  the program; points arriving compressed; every public input checked to be below BN254's scalar
  order.
- **The scope and the message,** as above. Their strings, `forest.foundation/label/v1/` and
  `forest.foundation/profile/v1/`, never change: the label's is in every row's address, through the
  stamp, and the profile's is in every proof.
- **The row's address and layout, the instruction bytes and the discriminators.** Written twice on
  purpose, in `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against
  each other and against what the program writes.
- **The rules.** One proof per `register`; one row per stamp; a label of at most 128 bytes; the
  main key's signature; the time from the clock; a row never written again; a refund of exactly
  the excess, to the recorded payer only.

```
solana program deploy --program-id <keypair> target/deploy/forest_registry.so
solana program set-upgrade-authority <program id> --final
solana program show <program id>          # Authority: none
```

## Promises

- At most one row per stamp. A stamp is one person's, for one label, at one issuer.
- Only the main key can put a row on its profile.
- A proof counts for one label and one profile: the program derives the scope from the label and
  the message from the profile, and verifies against them.
- A row is never written again after `register`, and never closes.
- `refund` moves only what a row holds above its rent-exempt minimum, and only to the payer it
  records.

## Limits

- **It trusts the person circuit's single-party setup.** Its verification key is baked into the
  program, and whoever ran `circuit/devnet/setup.sh` could forge a proof. Devnet only; a public
  setup ceremony comes before mainnet.
- **It trusts `groth16-solana` 0.2.0** and Solana's `alt_bn128` syscalls to verify, and Anchor 1.2.
- **It trusts issuers** to sign notes only for the people they say they do (one that checks faces:
  one per real, distinct human). The program cannot tell; readers choose whom to trust.
- **On the device, it trusts** `snarkjs` 0.7.5 to make proofs and check them (`verifyPerson`,
  `verifyTier`), and zk-kit's `@zk-kit/eddsa-poseidon` 1.0.4 to sign notes.
- **A row is only as good as its issuer.** Issuer keys are not checked, so anyone can sign notes
  with a key of their own and write rows with them. A reader that trusts no issuer counts no row.
- **A row made after its issuer's key leaked stays uncounted.** Its stamp is taken, and a note
  under the issuer's new key gives the same stamp, so that person cannot write a second row.
- **One row per issuer, not per face.** A person with notes from two issuers can hold two rows
  under one label, for two profiles. A reader that trusts both issuers counts both.
- **Whoever pays is recorded.** A fee payer that pays gets the refund. A refund to a payer holding
  no SOL is refused until it holds some again.
- **The source's program id is a placeholder** (`FoRRegistryRows…1111`) nobody holds a key for;
  every deploy substitutes its own.
- **Not audited.** The [security checklist](security-checklist.md) lists every rule and every known
  limit.

## Who decides what

- **The standard:** the row, the proof, and one row per stamp; to be sealed on mainnet.
- **An issuer, by its own policy:** whom it signs notes for and how it checks them, and what its
  tiers mean.
- **Other services, by their own policy:** which rows a fee payer pays for; which issuers an index
  counts, and from when.
- **An app, with the person:** when to register, making the proof on the device, and showing the
  tier.

## FAQ

**Can I have two profiles in one market?** Yes, through a second issuer. Your stamp for a market
comes from your secret for one issuer, so one issuer gives one row per market, whatever notes it
signs you. A second row needs a second issuer's note, and a second face check. Nothing on chain ties
the two rows to each other, but moving money between your own profiles links them until a privacy
pool is used.

**Why are rows not numbered?** A number shared across registrations would link a person's profiles.
A row's address comes from its stamp alone: one per stamp.

**Why does the program not check the issuer?** Anyone must be able to sign notes, so the program
knows no issuer. Each reader weighs whose keys it trusts.

**Who pays for a row?** Whoever signs as payer: the person, an app or a fee payer. The program pays
for no one and cannot tell who the payer is, so paying for someone else needs nothing in it. There
is no fee: only Solana's network fee and the row's deposit.

**Can a stranger register my profile?** No. `register` needs the main key's signature, and the proof
names the main key, so a proof seen in flight cannot be landed under anyone else's profile either.

**What is `refund` for?** Solana is cutting its rent rate in steps, and only the owning program can
move the difference out of its accounts. `refund` sends what a row holds above the new minimum, or
anything someone sent the row, back to whoever paid for it. Anyone may send it: the amount and the
destination are read from the chain, never from the caller.

**Why does a row never change or close?** Its existence is the one-row-per-stamp rule: closing it
would free the stamp for a second row.

**What if I lose my seed?** The rows stay on the chain and nobody else can use them, but your issuer
secrets are gone, and the issuer's face check will not take you again. The 24 words are the only
backup.

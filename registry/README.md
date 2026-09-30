# registry

A free public list of badges on Solana, and the client a device uses to add to it and read it.

**Nothing here is shipped.** It runs on devnet at `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`
(`devnet/devnet.json`). Nothing is on mainnet.

A badge is one line: this profile is one verified human under this label, proven against one
issuer's list. A line is written once and never grows and never changes. Nothing else lives in the
program: no fee, no token, no treasury, no admin, no list. The only costs are Solana's own, paid by
whoever sends the transaction. More issuers live off chain, as records in the profile's folder.

| | |
|---|---|
| `program/` | the program. Anchor 1.2, Rust, `cargo build-sbf --arch v3`. |
| `program/tests-litesvm/` | LiteSVM tests against real proofs, with the wire format written out a second time by hand: `registry.rs` (the rules), `adversarial.rs` (the attacks) and `invariants.rs` (the property test). |
| `client/` | TypeScript, browser and Node: the code, the proof against an issuer's list, the compressed points, the transaction, reading lines back, and making and checking memberships. |
| `artifacts/` | Semaphore's setup files, pinned. The verification key is committed; the 7.7 MB of proving files are pinned by hash. |
| `devnet/` | the devnet deploy script and its public record. |
| `security-checklist.md` | the safe-solana-builder checklist: every rule, how it applies here, and every known limit. |
| `changes.md` | the sessions' built, learned and open. |
| `FEASIBILITY.md` | session 3's report on the earlier design. |

## How it works

**Keys.** A profile is one ed25519 key: its did:key name, its signature on everything it says, and
its Solana wallet (`records/SPEC.md` §1, `keys/SPEC.md` §3). A person also holds one identity secret,
the same for all their profiles; only its commitment ever leaves the device, once to each issuer
that vouches for them.

**Issuers.** An issuer checks that someone is one real human (the foundation's with Didit's face
check), keeps a list of their identity commitments, and publishes it outside the registry: every
commitment in order, and the list's root, signed, on a schedule. Anyone may be an issuer. The
registry never sees a list and checks no root.

**A line.** The device makes a Semaphore proof against an issuer's list: "my commitment is in the
list with this root", for one label and one profile. The proof's scope is a hash of the label, its
message a hash of the profile key, and its nullifier, the code, is the same for one human under one
label and unguessable for anyone else. `register` verifies the proof and writes one line at the
address derived from the code, so a human has at most one line per label. The line holds the
profile, the code, the label, the root it was proven against, the time and the payer, and nothing
writes to it again. Apps prove against the issuer's newest root.

**More issuers, off chain.** A person on a second issuer's list proves membership in it for the same
label and profile, with the same circuit, and publishes the proof as a `proof/<id>` record of the
membership kind in the profile's folder (below). It costs nothing on chain.

**The proof is the consent.** Only the holder of the identity secret can make a proof, and a proof
can only ever create its own profile's line under its own label. So the profile key signs nothing
on chain, and anyone may send either instruction: the person, an app, a relayer. Whoever signs as
payer pays the line's deposit and is recorded in it.

**Reading.** A line names its profile by key, so a reader asks for every line of a profile with one
filter. **Badged** means a profile has a line whose root the reader trusts, or a membership record
for that line that checks against the roots of an issuer the reader trusts. Each reader keeps its
own list of trusted issuers and their published roots; the registry holds no opinion on any.

## Instructions

| | What it does | Signs |
|---|---|---|
| `register(profile, label, code, proof)` | Verifies the proof with public inputs `[root, code, message(profile), scope(label)]` and writes the line at `["code", code]`: profile, code, payer, time (the clock sysvar), the proof's root, and the label. A second line for the same code is refused. The label is free text up to 128 bytes; our convention is `market/role`. | the payer |
| `refund(code)` | Moves whatever the line holds above its current rent-exempt minimum to the payer the line records. The line's data is untouched. | nobody |

Why `refund`: Solana is cutting its rent rate in steps, and only the owning program can move the
difference out of its accounts. A line never closes: its existence is the one-line-per-code rule.

## Memberships

A membership is the body of a `proof/<id>` record (`records/schemas/proof.json`, the membership
kind), published and signed by the profile like any other record:

```
{ "issuer": "did:key:z6Mk…",                 the issuer's key, which signs the roots it publishes
  "membership": {
    "label": "tutoring/seller",               the line's label
    "code":  "<64 hex>",                      the line's code
    "root":  "<64 hex>",                      the root of the issuer's list the proof was made against
    "proof": ["<64 hex>", … 8 in all] },      the proof's coordinates, in Semaphore's packed order
  "createdAt": "2026-09-30T12:00:00.000Z" }
```

`makeMembership` in the client makes one. `verifyMembership` checks one the way a reader must:

1. the record names the issuer the reader is checking against;
2. the line (read from the chain at the record's code) is the profile's whose folder holds the record;
3. the record's label and code are the line's;
4. the root is one the issuer published;
5. the proof verifies for that root, the code, the profile and the label, against the verification
   key the program is sealed with (`artifacts/semaphore-32.json`).

Checking the issuer's signature on its roots is the reader's, before step 4: where issuers publish
their roots, and in what signed form, is open. A membership adds no line and no code: it is the same
human's same code, vouched for by one more issuer.

## Running it

```
cd registry/artifacts && npm install && npm run fetch     # the proving key, hash-checked
cd registry/program   && cargo build-sbf --arch v3        # needs Solana CLI 4.2.2 or later
cd registry/program/tests-litesvm && cargo test -- --nocapture
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm install && npm test          # no chain needed
cd registry/client    && npm run test:validator           # starts solana-test-validator itself
cd registry/client    && npm run test:devnet              # read-only, against devnet/devnet.json
```

`npm run fixtures` in `client/` makes the real proofs the Rust tests run against (6 of them, about
1.5 to 2.4 seconds each), the wire vectors, and one membership made by `makeMembership`, and writes
`program/tests-litesvm/fixtures/proofs.json`. The file is committed, so `cargo test` needs nothing
but Rust; the script is what shows it was not written by hand. Alice is the keys recipe's test seed:
her profile 0 key and her identity secret.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` derives the keys, builds a copy with
the devnet program id, deploys it with its exact cost checked first, and records it; then
`FOREST_DEVNET_KEYS=~/.forest-devnet/keys node scripts/devnet.ts` in `client/` writes one line, shows
the refusal and a refund, and makes a second issuer's membership and checks it against the line.

## What one line costs

Measured under LiteSVM and on devnet, one signature, no compute-budget instruction:

| | Bytes of 1,232 | Compute units of 200,000 (the default for one instruction) |
|---|---|---|
| `register`, a 15-byte label | 488 (491 as a v0 transaction on devnet) | 124,056 (125,258 on devnet) |
| `register`, a 128-byte label | 601 | 122,438 |
| `refund` | 243 | 4,921 (4,769 on devnet) |

One proof is about 120,000 units. Making a proof takes about 1.5 to 2.4 seconds in Node.

The deposit is the only cost besides the network fee (5,000 lamports a signature). A line is
`149 + label` bytes, and never more. Rent is 5,080 lamports a byte today, on mainnet and devnet
alike, and 696 after the cuts:

| | Bytes | Today (5,080 lamports a byte) | After the rent cuts (696) |
|---|---|---|---|
| a line, 15-byte label | 164 | 1,483,360 lamports (0.0015 SOL) | 203,232 |
| a line, 128-byte label | 277 | 2,057,400 | 281,880 |
| a membership | none on chain | 0 | 0 |

`refund` returns the difference to whoever paid, as the cuts land. The program itself is 165,320
bytes; its devnet deploy cost 0.842 SOL.

**Through the relayer.** A `register` goes through the relayer's current `kora.toml`
(`foundationforest/services`, `relayer/`) unchanged. It passes because that file names the program
by the id in the source, `FoRBadgeLine…1111`. On a local validator, Kora 2.0.5:
- charged a person with no SOL exactly the network fee (two signatures) and the line's deposit, in a
  test dollar;
- refused the same transaction paying the fee alone.

A line never grows, so nothing a line needs after `register` asks the relayer for SOL.

## What is sealed

These cannot change after deploy. A change breaks every existing proof, code or line.

- **The circuit and the verification key.** Semaphore 4.0.0 at depth 32, from the public July 2024
  ceremony (`artifacts/`). Public signals in the order root, nullifier, message, scope; `proof_a`
  negated in the program; points arriving compressed; every public input checked to be below BN254's
  scalar order.
- **How a scope and a message are derived.** `keccak256(namespace ‖ bytes) >> 8`, with the
  namespaces `forest.foundation/label/v1/` (the label's UTF-8) and `forest.foundation/profile/v1/`
  (the profile's 32-byte key). Memberships use the same, so they stay checkable for as long as the
  lines do.
- **The code and its address.** The code is the proof's nullifier, `Poseidon(scope, secret)`; a
  line sits at `["code", code]`.
- **The line's layout, the instruction bytes and the discriminators.** Written out twice on purpose,
  in `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against each other
  and against the line the program writes (`the_wire_format_written_twice_still_matches`). Every
  fixed field sits at a fixed offset; the label is last.

  | offset | bytes | field |
  |---|---|---|
  | 0 | 8 | discriminator, `sha256("account:Line")[..8]` |
  | 8 | 32 | profile |
  | 40 | 32 | code |
  | 72 | 32 | payer |
  | 104 | 8 | time, i64 unix seconds |
  | 112 | 1 | bump |
  | 113 | 32 | root |
  | 145 | 4 + n | label, UTF-8 |

- **The rules.** One proof per `register`; one line per code; a label of at most 128 bytes; no
  signature but the payer's; a line never written again after `register`; a refund of exactly the
  excess, to the recorded payer only.
- **The identity derivation on the device.** Semaphore's own, from the 32 bytes `keys/`'s
  `identitySecret(seed)` returns. Not in the program, but a change makes every commitment
  unreachable.

## The upgrade authority, and how it is removed

On devnet it stays on the devnet deploy key. On mainnet the program is deployed and then sealed in
the same session:

```
solana program deploy --program-id <keypair> target/deploy/forest_registry.so
solana program set-upgrade-authority <program id> --final
solana program show <program id>          # "Authority: none"
```

A later version is a new program at a new address; lines in this one stay readable forever.

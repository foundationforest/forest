# registry

A free public list of badges on Solana, and the client a device uses to add to it and read it.

**Nothing here is shipped.** It runs on devnet at `GWyKGgoRg2g3kpKNgsXBWS1ayHTHHzwbtLJW4XGVP2RW`
(`devnet/devnet.json`). Nothing is on mainnet.

A badge is one line: this profile is one verified human under this label, backed by these issuers'
lists. Nothing else lives in the program: no fee, no token, no treasury, no admin, no list. The only
costs are Solana's own, paid by whoever sends the transaction.

| | |
|---|---|
| `program/` | the program. Anchor 1.2, Rust, `cargo build-sbf --arch v3`. |
| `program/tests-litesvm/` | LiteSVM tests against real proofs, with the wire format written out a second time by hand: `registry.rs` (the rules), `adversarial.rs` (the attacks) and `invariants.rs` (the property test). |
| `client/` | TypeScript, browser and Node: the code, the proof against an issuer's list, the compressed points, the transactions, and reading lines back. |
| `artifacts/` | Semaphore's setup files, pinned. The verification key is committed; the 7.7 MB of proving files are pinned by hash. |
| `devnet/` | the devnet deploy script and its public record. |
| `security-checklist.md` | the safe-solana-builder checklist: every rule, how it applies here, and every known limit. |
| `changes.md` | this rewrite's built, learned and open. |
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
address derived from the code, so a human has at most one line per label. `add_proof` appends
another issuer's root to the same line, one proof per transaction. Apps prove against each issuer's
newest root.

**The proof is the consent.** Only the holder of the identity secret can make a proof, and a proof
can only ever create or extend its own profile's line under its own label. So the profile key signs
nothing, and anyone may send any instruction: the person, an app, a relayer. Whoever signs as payer
pays the line's deposit and is recorded in it.

**Reading.** A line names its profile by key, so a reader asks for every line of a profile with one
filter. **Badged** means a profile has a line backed by a root the reader trusts. Each reader keeps
its own list of trusted issuers and their published roots; the registry holds no opinion on any.

## Instructions

| | What it does | Signs |
|---|---|---|
| `register(profile, label, code, proof)` | Verifies the proof with public inputs `[root, code, message(profile), scope(label)]` and writes the line at `["code", code]`: profile, code, payer, time (the clock sysvar), label, and the proof's root. A second line for the same code is refused. The label is free text up to 128 bytes; our convention is `market/role`. | the payer |
| `add_proof(code, proof)` | Verifies the proof against the line's own code, label and profile, and appends its root. Refuses a root the line already holds, and a seventeenth. The line grows by 32 bytes, paid by the payer. | the payer |
| `refund(code)` | Moves whatever the line holds above its current rent-exempt minimum to the payer the line records. | nobody |

Why no root twice: a proof is public once sent and anyone may send `add_proof`, so without the rule a
stranger could replay one proof until the line was full, and no other issuer could ever be added.

Why `refund`: Solana is cutting its rent rate in steps, and only the owning program can move the
difference out of its accounts. A line never closes: its existence is the one-line-per-code rule.

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

`npm run fixtures` in `client/` makes the real proofs the Rust tests run against (21 of them, about
1.1 seconds each) and the wire vectors, and writes `program/tests-litesvm/fixtures/proofs.json`. The
file is committed, so `cargo test` needs nothing but Rust; the script is what shows it was not
written by hand. Alice is the keys recipe's test seed: her profile 0 key and her identity secret.

Devnet: `FOREST_DEVNET_SEED=<phrase> registry/devnet/deploy.sh` derives the keys, builds a copy with
the devnet program id, deploys it with its exact cost checked first, and records it; then
`FOREST_DEVNET_KEYS=~/.forest-devnet/keys node scripts/devnet.ts` in `client/` writes one line and
shows the refusals and a refund.

## What one line costs

Measured under LiteSVM and on devnet, one signature, no compute-budget instruction:

| | Bytes of 1,232 | Compute units of 200,000 (the default for one instruction) |
|---|---|---|
| `register`, a 15-byte label | 488 (491 as a v0 transaction on devnet) | 124,218 (120,920 on devnet) |
| `register`, a 128-byte label | 601 | 122,602 |
| `add_proof` | 437 (439 on devnet) | 120,421 (120,267 on devnet) |
| `refund` | 243 | 5,152 |

One proof is about 120,000 units, so two would not fit under the default limit: that is why each
transaction carries one. Making a proof takes about 1.1 to 1.9 seconds in Node.

The deposit is the only cost besides the network fee (5,000 lamports a signature). A line is
`8 + 105 + 4 + label + 4 + 32 × roots` bytes; a 15-byte label with one root is 168 bytes:

| | Today (5,080 lamports a byte) | After the rent cuts (696) |
|---|---|---|
| a line, 15-byte label, one root | 1,503,680 lamports (0.0015 SOL) | 206,016 |
| each more root | 162,560 | 22,272 |

`refund` returns the difference to whoever paid, as the cuts land. The program itself is 188,680
bytes; its devnet deploy cost 0.961 SOL.

## What is sealed

These cannot change after deploy. A change breaks every existing proof, code or line.

- **The circuit and the verification key.** Semaphore 4.0.0 at depth 32, from the public July 2024
  ceremony (`artifacts/`). Public signals in the order root, nullifier, message, scope; `proof_a`
  negated in the program; points arriving compressed; every public input checked to be below BN254's
  scalar order.
- **How a scope and a message are derived.** `keccak256(namespace ‖ bytes) >> 8`, with the
  namespaces `forest.foundation/label/v1/` (the label's UTF-8) and `forest.foundation/profile/v1/`
  (the profile's 32-byte key).
- **The code and its address.** The code is the proof's nullifier, `Poseidon(scope, secret)`; a
  line sits at `["code", code]`.
- **The line's layout, the instruction bytes and the discriminators.** Written out twice on purpose,
  in `client/src/program.ts` and `program/tests-litesvm/src/lib.rs`, and checked against each other
  and against the line the program writes (`the_wire_format_written_twice_still_matches`).

  | offset | bytes | field |
  |---|---|---|
  | 0 | 8 | discriminator, `sha256("account:Line")[..8]` |
  | 8 | 32 | profile |
  | 40 | 32 | code |
  | 72 | 32 | payer |
  | 104 | 8 | time, i64 unix seconds |
  | 112 | 1 | bump |
  | 113 | 4 + n | label, UTF-8 |
  | 117 + n | 4 + 32k | roots |

- **The rules.** One proof per transaction; one line per code; a label of at most 128 bytes; at most
  16 roots, each once; no signature but the payer's; a refund of exactly the excess, to the recorded
  payer only.
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

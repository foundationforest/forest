# registry

The sealed Solana program that gives one verified human one badge per market without saying who,
and the client a device uses to get one.

**Nothing here is shipped.** It has run on a local validator and under LiteSVM, and nowhere else.
No devnet, no mainnet, no Kora.

A registration is one transaction. It carries the market name, the profile's DID, one Semaphore
proof with its points compressed, the list root the proof was made against, and the code. The
program derives the scope and the message itself, verifies the proof against a verification key
baked in from the July 2024 ceremony, creates one account whose address is a hash of the code,
appends that code to a running tree, and moves 0.25 of an accepted dollar token, in that token's own
decimals, to the treasury. Any failure reverts all of it.

| | |
|---|---|
| `program/` | the program. Anchor, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | LiteSVM tests against real proofs, with the wire format written out a second time by hand. |
| `client/` | TypeScript, browser and Node: the code, the Merkle path, the proof, the compressed points, the transaction. |
| `artifacts/` | Semaphore's setup files, pinned. The verification key is committed; the 7.7 MB of proving artifacts are pinned by hash. |
| `FEASIBILITY.md` | session 3's report: whether any of this was possible, and at what cost. |
| `scratch/` | what produced session 3's numbers. Not a library. |

## Running it

```
cd registry/artifacts && npm install && npm run fetch     # the proving key, hash-checked
cd registry/program   && cargo build-sbf                  # needs Solana CLI 4.2.2 or later; mainnet USDC
cd registry/program   && cargo build-sbf --features devnet   # the same program naming devnet's USDC
cd registry/program/tests-litesvm && cargo test -- --nocapture
cd registry/client    && npm install && npm test          # no chain needed
cd registry/client    && npm run test:validator           # starts solana-test-validator itself
```

`registry/client` also writes the test fixtures: `npm run fixtures` makes five real proofs with the
pinned artifacts and writes `program/tests-litesvm/fixtures/proofs.json`. That file is committed, so
`cargo test` alone needs nothing but Rust; the script is what shows it was not written by hand.

## What one registration costs

Measured this session, one proof, compressed points, on the program in `program/`:

| | |
|---|---|
| Transaction on the wire | **829 bytes** of the 1,232 limit, 67% (legacy, with a compute-budget instruction; the client's v0 form is 831) |
| Compute units | **133,072** of the 1,400,000 limit, **9.5%** (session 5 measured 132,302 before the fee was looked up per mint) |
| Instruction data | 257 bytes, 10 accounts |
| Proof on this machine | about 0.8 to 1.5 seconds in Node at depth 32 |

No address lookup table, and no need for one. Session 3's figures were for a registration carrying
two proofs; with the numbered code gone there is one, and it fits with room to spare.

Rent, at the 5,080 lamports per byte session 3 read from mainnet, and at the 696 the current cut
ends at (SOL at $100.24):

| Account | Bytes | Today | After the cuts | How many |
|---|---|---|---|---|
| used code | 9 | $0.0698 | $0.0096 | one per badge, forever |
| identity list | 5,464 | $2.85 | $0.39 | one per list |
| code tree | 1,112 | $0.63 | $0.087 | one, ever |
| config | 574 | $0.36 | $0.049 | one, ever |

The transaction's fee payer pays the code account's rent. Rent is never returned, because a code
account must never close: closing it would make the code reusable.

## What is sealed

These cannot change after v1 deploys. A change breaks every existing proof, code or account.

- **The hash.** Poseidon over BN254 with circomlib's parameters, big-endian field elements,
  through the `sol_poseidon` syscall.
- **The tree.** Semaphore's LeanIMT: append only, a node with no right sibling copied up unhashed,
  depth `ceil(log2(size))`, maximum depth 32, the frontier of one node per level, a root of zero
  never valid. Both trees, the humans and the codes.
- **The circuit and the verification key.** Semaphore 4.0.0 at depth 32, from the public July 2024
  ceremony. Public signals in the order root, nullifier, message, scope; `proof_a` negated; points
  arriving compressed; every public input checked to be below BN254's scalar order.
- **How a scope and a message are derived.** `keccak256(namespace ‖ bytes) >> 8`, with the
  namespaces `forest.foundation/market/v1/` and `forest.foundation/profile/v1/`. Because the name
  is hashed rather than padded into 32 bytes, a market name or a DID can be any length.
- **The code.** A code is the circuit's nullifier, `Poseidon(scope, secret)`. The rule is "the
  account at the address derived from this code must not already exist".
- **The account layouts, the seed strings and the instruction bytes.** Clients and indexes read
  them forever. They are written out twice on purpose, in `client/src/program.ts` and in
  `program/tests-litesvm/src/lib.rs`, so a drift on either side fails a test.
- **The rules.** 0.25, always, in the mint's own decimals: `25 × 10^(decimals − 2)` base units,
  from the decimals read off the mint when it was accepted. USDC, at the one address the program
  names, accepted from `init` and never removable. The order of checks in `register`. One entry
  per registration, in the transaction log and in no account.
- **What `init` writes.** The treasury is a program constant and the first mint is a program
  constant; `init` takes no argument and no treasury signer, so whoever sends it, once, writes the
  same bytes. A deploy race has nothing to win.
- **The identity derivation on the device.** Semaphore's own BLAKE-512, pruning and shift, from
  the 32 bytes `keys/`'s `identitySecret(seed)` returns. Not in the program, but a change makes
  every existing commitment unreachable.

## What is a dial

The treasury can turn these. Nothing else can.

- Which mints are accepted beyond USDC (`add_token`). Only classic SPL Token mints whose decimals
  let 0.25 be a whole number of base units (two to nineteen). The mint's decimals are read then
  and stored next to it; `register` charges 25 cents in those units. Nothing removes a mint.
- Which issuer keys may insert into which list (`add_issuer`, `remove_issuer`). Removing an issuer
  never removes an identity: nobody is ever taken out of a list.
- How many identity lists are open (`open_list`).
- Who the treasury is (`set_treasury`). The current treasury signs, and everything moves at once:
  where the 0.25 lands, where swept rent goes, and who signs the dials. That is how the treasury
  moves to a multisig later. There is no second step and no undo: a wrong address freezes every
  dial and sends every fee to nobody, forever. After a handover the old key signs nothing, is paid
  nothing, and is swept nothing.

Two things are deliberately nobody's dial. `sweep_rent` takes no key at all, because there is no
key behind a program-derived address, the only possible destination is the sealed treasury, and the
foundation must not be a liveness dependency for its own money. And there is no pause, no upgrade
and no way for anyone, treasury included, to undo, override or take back a registration.

## The upgrade authority, and how it is removed

The program must be sealed on the day it deploys to mainnet. After

```
solana program deploy --program-id <program-keypair.json> target/deploy/forest_registry.so
```

the deployer runs, once, from the machine holding the upgrade authority:

```
solana program set-upgrade-authority <PROGRAM_ID> --final
solana program show <PROGRAM_ID>        # "Authority: none"
```

`--final` is not reversible. After it, no key on earth can change the bytes, and the only way to a
v2 is a new program at a new address with a fresh list. That is the point: a registry that one key
could rewrite is not a registry anyone should stake a name on.

Two constants must be right before that command, because nothing can change them after it:

- `TREASURY` in `program/src/lib.rs` is a **placeholder**, derived from the public seed
  `REPLACE-BEFORE-DEPLOY-treasury-0` so the tests can sign for it. Anyone with this repo can sign
  for it too. Replace it with the charter's treasury address before the first deploy; a program
  deployed with the placeholder has no treasury. The same constant is repeated by hand in
  `program/tests-litesvm/src/lib.rs` and `client/src/program.ts`, and a client test fails if the
  three disagree.
- `USDC_MINT` is mainnet's USDC by default and devnet's under `--features devnet`.

With both baked in, `init` can be sent by anyone after the deploy, and it does not matter who:
it writes the constants and nothing else, and a second `init` fails.

`FEASIBILITY.md` says the same thing about the alternatives: compressed accounts would have put the
registry's storage inside four programs that share one plain-key upgrade authority, which is not
sealed whatever this program does.

## The code tree, and what it is for

Every code goes into an append-only tree as well as its own account. The account is the rule; the
tree is a promise being kept open. This is option 3 of `docs/decisions/used-code-storage.md`.

An append-only tree does not prove a code is *absent*: its leaves are in arrival order, not sorted.
What it does is commit, from inside the sealed program, to the exact set and order of every code
ever written. With that on the chain, the sorted structure that does prove absence can be rebuilt
by anyone off the chain and *checked* against it, instead of trusted. Without it — and Solana no
longer commits its accounts in a Merkle tree at all — "here are all my badges, none hidden" would
rest forever on trusting whoever publishes the code list.

The expensive half of that, a proof that a sorted tree holds the same values as this one, is not
built and not costed. It lives entirely outside the sealed program, so it can be designed and
replaced at any time. The cheap, irreversible half is here, because after deploy it cannot be.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible until something
ships, and each is logged in `docs/changes.md`.

1. **The DID is hashed with a namespace too**, not padded into 32 bytes. The handoff says the scope
   is a hash of a namespaced market name; doing the same for the message removes a second length
   cap from a sealed program at the cost of one keccak.
2. **"A dollar stablecoin" is enforced as far as a program can enforce it**: a classic SPL Token
   mint, initialized, with decimals in which 0.25 is a whole number of base units. No program can
   know what a mint is worth. The rest is the treasury's judgement. The decimals are not a sealed
   constant (session 6 undid that): they are read off each mint at `add_token` and stored next to
   it, so a future dollar token with eight decimals is charged 25,000,000 base units and USDC
   250,000, both 0.25. The mint is not read again at `register`: a classic SPL Token mint has no
   instruction that changes its decimals and none that closes it, so the byte recorded at
   `add_token` is the byte the mint holds, and re-reading would cost every registration one more
   account for a change the token program cannot make.
3. **The fee payer pays the rent**, not the 0.25. That is the Kora path and it keeps the fee one
   number forever.
4. **`sweep_rent` also covers the config and the code tree**, not only code accounts and lists.
   Same check, same safety argument, and otherwise their deposits would be locked forever, which is
   the exact failure the feasibility report warns about.
5. **The code tree's depth is 32**, like the list of humans.
6. **Names and DIDs are bounded at 64 bytes each** in the instruction. Not a limit on what a scope
   can be — both are hashed — only on what one transaction and one log entry carry.
7. **Sixteen accepted mints and eight issuer keys per list**, fixed, so no account ever changes
   size and the rent sweep always measures against a size that cannot move.
8. **Zero-copy for the two big accounts** (the list and the code tree), plain Anchor accounts for
   the small ones, so a registration never deserializes 5 kB it does not read.
9. **Anchor 1.2**, built with `cargo build-sbf` rather than the Anchor CLI, and no IDL. The client
   and the Rust tests both write the bytes by hand, which is the check that matters for a format
   that can never change.
10. **One treasury, not two.** Session 5 kept a fee destination and a signing key as separate
    fields. A handover to a multisig has to move both or it moves nothing, so session 6 merged
    them: one `treasury` field, one constant, one `set_treasury`. A multisig's vault address is
    one key that both owns token accounts and signs, so nothing is lost. If a cold destination
    separate from the dial key is wanted back, that is a one-field change before deploy.

## What this does not do

No devnet, no mainnet, no Kora, no address lookup table, no proof on a phone. The 4.0.0 ceremony
is pinned but nothing has been confirmed with PSE. The permutation proof the code tree exists for
has not been built. No paid review has happened, and `docs/handoff.md`'s "Before mainnet" list
still stands in full.

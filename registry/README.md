# registry

The sealed Solana program that gives one verified human one badge per market without saying who,
and the client a device uses to get one.

**Nothing here is shipped.** It has run on a local validator and under LiteSVM, and nowhere else.
No devnet, no mainnet, no Kora. Its devnet run is built, scripted and rehearsed, and stopped at the
deploy for lack of test SOL (session 15, `docs/devnet.md`).

A registration is one transaction. It carries the market name, the profile's DID, one Semaphore
proof with its points compressed, the list root the proof was made against, and the code, and the
profile's own wallet signs it, whoever pays. The program derives the scope from the market name
and the message from the signing wallet and the DID, so a proof counts for one market, one profile
and one wallet and no other; verifies the proof against a verification key baked in from the July
2024 ceremony; creates one account whose address is a hash of the code; appends that code to a
running tree; and moves the fee to the treasury: 0.25 USDC, a program constant, or, in any other
accepted token, the amount the treasury set when it accepted that token. Any failure reverts all
of it.

| | |
|---|---|
| `program/` | the program. Anchor, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 47 LiteSVM tests against real proofs, with the wire format written out a second time by hand: `registry.rs` (30), `adversarial.rs` (16, session 10's attacks as sessions 11, 14 and 15 left them) and `invariants.rs` (the property test) (`docs/decisions/adversarial-review-1.md`). |
| `program/trident-tests/` | the Trident fuzzer, kept as the record of why it cannot run: Trident 0.12 never registers the Poseidon and alt_bn128 syscalls. Its model is still session 10's wire format; `invariants.rs` runs the same model under LiteSVM and is the one kept current. |
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
cd registry/program/tests-litesvm && FOREST_FUZZ_ITERATIONS=1000 cargo test --release --test invariants -- --nocapture
cd registry/client    && npm install && npm test          # no chain needed
cd registry/client    && npm run test:validator           # starts solana-test-validator itself
cd registry/client    && npm run test:devnet              # read-only, against devnet/devnet.json's deploy
```

Devnet has its own build, deploy and run scripts, with keys substituted into a copy of the source
at build time: `docs/devnet.md`.

`registry/client` also writes the test fixtures: `npm run fixtures` makes five real proofs with the
pinned artifacts and writes `program/tests-litesvm/fixtures/proofs.json`, each with its profile's
wallet and that wallet's seed so the tests can sign as it (Alice's is her profile 0 wallet from the
keys recipe's test seed). That file is committed, so `cargo test` alone needs nothing but Rust; the
script is what shows it was not written by hand.

## What one registration costs

Measured in session 11, one proof, compressed points, on the program in `program/`:

| | |
|---|---|
| Transaction on the wire | **830 bytes** of the 1,232 limit, 67%, on both paths, each with two signers: the profile paying the fee while a separate fee payer covers the network fee and the code account's rent, or one other key paying everything (legacy, with a compute-budget instruction; the client's v0 form is 832 on a local validator) |
| Compute units | **133,093** (the profile paying the fee) and **135,534** (another key paying everything) of the 1,400,000 limit, **9.5 to 9.7%**, under LiteSVM in session 15; 139,075 on a local validator at the devnet build's program id, where the address derivations take other bump seeds |
| Instruction data | 257 bytes, 11 accounts |
| Proof on this machine | about 1.8 to 2.8 seconds in Node at depth 32 |

Session 5 measured 829 bytes and 132,302 units before the fee was looked up per mint; session 6,
133,072 before the config grew a pending-treasury slot; session 11, 133,033 before the entry named
the list's owner (session 14, 54 units); session 14, 133,087 before the list account grew a
pending-owner slot (session 15, 6 units; nothing else `register` touches changed). Before session 11 a registration another key paid for
carried one signature fewer: the profile's wallet did not have to sign.

No address lookup table, and no need for one. Session 3's figures were for a registration carrying
two proofs; with the numbered code gone there is one, and it fits with room to spare.

Rent, at the 5,080 lamports per byte session 3 read from mainnet, and at the 696 the current cut
ends at (SOL at $100.24):

| Account | Bytes | Today | After the cuts | How many |
|---|---|---|---|---|
| used code | 9 | $0.0698 | $0.0096 | one per badge, forever |
| identity list | 5,528 | $2.88 | $0.39 | one per list, paid by whoever opens it; what the cuts free goes back to its owner |
| code tree | 1,112 | $0.63 | $0.087 | one, ever |
| config | 718 | $0.43 | $0.059 | one, ever |

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
  namespaces `forest.foundation/market/v1/` and `forest.foundation/profile/v1/`. The scope hashes
  the market name. The message hashes the profile's wallet, its 32 bytes, then the DID: the wallet
  that must sign `register` (session 11). Because names are hashed rather than padded into 32 bytes,
  a market name or a DID can be any length.
- **The code.** A code is the circuit's nullifier, `Poseidon(scope, secret)`. The rule is "the
  account at the address derived from this code must not already exist".
- **The account layouts, the seed strings and the instruction bytes.** Clients and indexes read
  them forever. They are written out twice on purpose, in `client/src/program.ts` and in
  `program/tests-litesvm/src/lib.rs`, so a drift on either side fails a test.
- **The rules.** The profile's wallet signs every registration, whoever pays, and the proof names
  it. The fee: USDC, at the one address the program names, pays
  `USDC_FEE`, 250,000 base units, 0.25 at USDC's six decimals, a program constant that nothing can
  change or remove; any other accepted mint pays the fee the treasury set when it accepted that
  mint, in its own base units, which nothing changes afterwards. The fee comes from a token account
  the fee authority owns (usually the profile's wallet; any key may pay for it) and goes to one the
  treasury owns. The order of checks in `register`. Anyone opens a list; its owner, written when it
  opens, is its first insert key and the only key that adds or removes its insert keys, closes it or
  hands it over, and it moves only in two steps, the second signed by the key it moves to. A
  closed list takes no member and every proof against it stays valid; nothing reopens or deletes a
  list. A list's swept rent goes to its owner; the config's, the code tree's and a code account's
  to the treasury. One entry per registration, naming the market, the DID, the profile's
  wallet, the code, the list and the list's owner, in the transaction log and in no account.
- **What `init` writes.** The treasury is a program constant, the first mint is a program
  constant and its fee is a program constant, and list 0's owner and first insert key is a program
  constant, the foundation's issuer key; `init` takes no argument and no treasury signer, so
  whoever sends it, once, writes the same bytes, with an empty pending-treasury slot. It refuses a
  USDC mint that does not count in six decimals, since 250,000 is 0.25 only at six. A deploy race has
  nothing to win.
- **The identity derivation on the device.** Semaphore's own BLAKE-512, pruning and shift, from
  the 32 bytes `keys/`'s `identitySecret(seed)` returns. Not in the program, but a change makes
  every existing commitment unreachable.

## What is a dial

The treasury can turn these, and every rent sweep but a list's pays it. Nothing else is a dial:
each list is its owner's (below).

- Which mints are accepted beyond USDC, and at what fee (`add_token`). Only classic SPL Token
  mints, each at a fee above zero in its own base units, meant to be worth 25 cents and set once:
  nothing changes a mint's fee and nothing removes a mint. Any decimals. Because if the dollar ever
  fails, the treasury accepts another token at a sensible amount and registration continues, and a
  fee derived from a single 25-cent constant could not follow it. What the fee is worth is the
  treasury's judgement, like what the mint is worth; the program checks neither.
- Who the treasury is, in two steps (`propose_treasury`, then `accept_treasury`). The current
  treasury proposes a key, and nothing moves: it still signs every dial, is still paid the 0.25
  and still receives swept rent. A later proposal overwrites the pending key, and proposing
  nothing clears it. When the pending key signs `accept_treasury`, everything moves at once:
  where the 0.25 lands, where swept rent goes, and who signs the dials. That is how the treasury
  moves to a multisig later, and the multisig's own signature on the second step is the proof it
  can sign at all. After that the old key signs nothing, is paid nothing, and is swept nothing.
  Two steps because a one-step handover has no undo: a typo in the new address would have frozen
  every dial and sent every fee to nobody, forever. Now a key nobody holds can be proposed but
  never accepted, and the treasury stays where it was. The zero key and the current key are
  refused as proposals. A new treasury key must hold a little SOL before it can receive a small
  sweep; see the deploy checklist.
- Where `sweep_rent` pays for the config, the code tree and every code account: the treasury,
  whoever sends it. A list's excess goes to the list's owner instead (below).

## Lists and their owners

Issuers are open (session 14). Anyone opens a list (`open_list`): the payer pays its rent, and the
owner, who signs, is recorded in the list and becomes its first insert key; the two may be one key.
Only a list's owner adds or removes its insert keys, up to eight (`add_issuer`, `remove_issuer`), or
closes it to new members for good (`close_list`). The owner may remove its own insert key and stay
the owner. Removing an insert key never removes an identity: nobody is ever taken out of a list. A
closed list keeps its members, its root and its last 128 roots, so every proof against it stays
valid forever; nothing reopens a list and no instruction deletes one. `init` opens list 0, owned by
`FOUNDATION_ISSUER`, the foundation's issuer key.

**A list's rent goes to its owner** (session 15, Carlos's decision). `sweep_rent` on a list pays
what it holds above its rent-exempt minimum to the list's owner, read from the list at the moment
of the sweep, and to no other key; the config, the code tree and code accounts still pay the
treasury. Because whoever paid the rent should get it back, and the issuer opening a list is the
one paying for it, directly or through a fee payer it pays. The program records the owner, not the
payer, so where the two are different keys the owner gets it: list 0's rent is paid by whoever
sends `init` and goes to `FOUNDATION_ISSUER`. A list owner's key must hold a little SOL before it
can take a small sweep, like the treasury's (deploy checklist, step 4).

**A list's owner can hand over** (session 15, Carlos's decision), in two steps like the treasury.
The owner proposes a key (`propose_list_owner`), and nothing moves: it still manages the insert
keys, may close the list, is swept its rent, and may change the proposal. A later proposal
overwrites the pending key; proposing nothing clears it; the zero key and the current owner are
refused. When the proposed key signs `accept_list_owner`, it is the owner, and the old key has no
say over the list at all. Ownership moves and nothing else does: the insert keys stay as they were,
the old owner's included, so a new owner that means to drop the old key removes it itself
(`remove_issuer`), in the same transaction if it likes. A closed list can be handed over too; it
still has an owner, whose key its rent pays. This is how an issuer moves a list to a multisig, or
away from a key that leaked, without opening a new list its members would have to join again. With
both keys at hand, propose and accept fit in one transaction, which leaves no moment between them
for anyone else holding a leaked key; a leaked owner key can otherwise race the handover, since
until the accept it is still the owner.

The program checks nothing about who an owner is. Every `Registered` entry names the list the proof
was made against and that list's owner, so an index weighs a badge by who vouched, and a market
decides which issuers count. A code is `Poseidon(scope, secret)`, the same whichever list the proof
is against, so one secret gets one badge per market however many lists it is on; a person who wants
a second badge in a market needs a second secret on another issuer's list. Extra vouches need no
program change: a profile may keep, in its folder, proofs of its secret against other issuers'
lists, made with the badge's market as scope so they show the badge's code, and anyone verifies
them against those lists' roots (not built).

Two things are deliberately nobody's dial. `sweep_rent` takes no key at all, because there is no
key behind a program-derived address, the only possible destination is the one the program reads
for itself (the list's owner, or else the treasury), and nobody must be a liveness dependency for
anyone else's money. And there is no pause, no upgrade
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

## Deploy checklist

In this order, for mainnet. Nothing here has been done there, and nothing is deployed anywhere.
Devnet rehearses steps 1 to 5 with throwaway keys put into a copy of the source at build time
(`devnet/build.sh`), and leaves out step 6 on purpose: a devnet program stays upgradeable. How to
build, deploy and run it there, and what session 15 got done (everything but the deploy, which ran
out of test SOL), is in `docs/devnet.md`.

1. **Replace the placeholder treasury.** `TREASURY` in `program/src/lib.rs` is derived from the
   public seed `REPLACE-BEFORE-DEPLOY-treasury-0` so the tests can sign for it, which means anyone
   with this repo can sign for it too: deployed as it is, a stranger takes every fee and every
   dial (`finding_the_placeholder_treasury_is_anyones_key`). Replace it with the charter's treasury
   address, and the same constant where it is repeated by hand, in
   `program/tests-litesvm/src/lib.rs` and `client/src/program.ts`; a client test fails if the three
   disagree. The tests that sign as the treasury then need a treasury key they can sign with.
2. **Replace the placeholder issuer key.** `FOUNDATION_ISSUER`, list 0's owner, is derived the same
   way from `REPLACE-BEFORE-DEPLOY-issuer-000`: deployed as it is, a stranger owns list 0, names its
   own insert key and adds humans who do not exist, whose badges every index would read as vouched
   for by the foundation (`finding_the_placeholder_issuer_key_is_anyones_key`). Replace it with the
   foundation's issuer key, in the same three places; a client test fails if they disagree.
3. **Build for the right cluster.** `USDC_MINT` is mainnet's USDC by default and devnet's under
   `--features devnet`. `init` will refuse a USDC mint that does not count in six decimals.
4. **Fund the treasury address with a little SOL before the first sweep.** About 0.001 SOL. The
   runtime refuses any transaction that leaves an account it credits below its rent-exempt
   minimum, so a sweep into a treasury holding no SOL fails whole unless the swept excess alone
   covers an empty account's rent (890,880 lamports at the old rate, 650,240 today, 89,088 after
   the cuts). Nothing is lost; the sweep can be sent again once the treasury holds SOL. Do the same
   for every key the treasury is handed over to, before it accepts, and for `FOUNDATION_ISSUER`
   and every list owner, whose key a list's sweep pays (session 15). No one-line program change
   fixes this: the rule is the runtime's, not the program's
   (`finding_a_sweep_into_a_treasury_holding_no_sol_fails_until_someone_funds_it`).
5. **Deploy, then send `init`**, from anyone. It writes the constants and nothing else, and a
   second `init` fails. Check the config: the treasury, USDC as `mints[0]` at 250,000, and list 0
   open, owned by the foundation's issuer key.
6. **Seal it**, with the two commands above, and check "Authority: none".
7. **Only then** accept other tokens. List 0's owner adds its insert keys; anyone opens other lists.

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
2. **"A dollar stablecoin at 25 cents" is enforced as far as a program can enforce it**: a
   classic SPL Token mint, initialized, at a fee above zero. No program can know what a mint or an
   amount is worth; that is the treasury's judgement. Session 11 replaced session 6's rule (the
   fee derived from the mint's decimals) with a fee stored per mint at `add_token`, as Carlos
   decided, so a token that is not a dollar can be accepted at a sensible amount. The fee is stored
   in place of the decimals, in the same slot of the config, and the mint is not read at
   `register`.
3. **The fee payer pays the rent and the network fee; the fee authority pays the fee; the profile's
   wallet signs for consent.** Three roles in three account slots, which may be the same key: on
   the Kora path the fee payer is the payer and charges the person for it outside the program,
   and the profile's wallet pays the 25 cents and signs. It keeps the fee one number per mint.
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
    them: one `treasury` field, one constant, one handover. A multisig's vault address is one
    key that both owns token accounts and signs, so nothing is lost. Session 7 closed this as
    decided: the two stay one field, because a multisig holds both.
11. **The pending slot is appended, and a proposal is an `Option`.** `pending_treasury` sits
    after `bump` in the config so every offset the two hand-written decoders pinned in sessions
    5 and 6 stays where it was. `propose_treasury` takes `Option<Pubkey>`: `None` clears a
    pending proposal, so clearing needs no third instruction, and the zero key stays an error
    rather than a meaning. (Session 11's fees moved those offsets by 112 bytes anyway; nothing is
    deployed.)
12. **The profile's wallet goes into the proof's message, not only into the signer list**
    (session 11). A signature alone would not stop a relay, a fee payer, or anyone who saw a proof
    before it landed from sending it again with its own key as the profile's wallet: the code would
    be spent under a wallet the profile does not declare, and an index that checks the declared
    wallet would never count it, so the human would lose that market's badge for good. With the
    wallet in the message the proof verifies for one wallet only, and the DID is bound twice over,
    by the proof and by that wallet's signature on the transaction.
13. **The entry names the wallet** (session 11), so an index can check it against the wallet the
    profile record declares without reading the transaction's accounts. A badge counts for a
    profile only when they match: that is what makes "the profile signs" mean "nobody puts a badge
    on a profile they do not control", since no program can read a DID's records.
14. **A closed list is closed for good, in a byte that was padding** (session 11). No instruction
    reopens one, so closing is one dial with one direction; a list closed by mistake is replaced by
    opening another. The flag sits in the list account's two spare bytes, so its size and every
    offset stay.
15. **`init` checks that USDC counts in six decimals** (session 11), since the constant fee means
    0.25 only then. Mainnet's and devnet's USDC both do.
16. **Zero is the only fee refused.** A treasury could still set a fee worth almost nothing, which is
    the voucher finding of session 10 in another form; only the treasury's discipline, its multisig
    and a public policy stand against it.
17. **The payer and the owner of a new list are two account slots, and the owner signs** (session 14;
    Carlos decided issuers are open). They may be one key, like `register`'s roles. The signature
    means no list is recorded as owned by a key that did not agree to it, or that nobody holds.
18. **A list's owner is also its first insert key** (session 14, Carlos's choice in planning), so an
    opener inserts at once; it may remove its own key and insert with others.
19. **List 0's owner is a second program constant, `FOUNDATION_ISSUER`, not the treasury**
    (session 14, Carlos's choice in planning), so the treasury touches no list at all.
20. **The owner is appended** (session 14): to the list account (5,456 bytes after the discriminator
    become 5,488), to `ListOpened` (`owner`) and to `Registered` (`list_owner`), so every offset and
    field before it stays. `add_issuer`, `remove_issuer` and `close_list` no longer take the config,
    and check the owner in the handler (`NotTheListOwner`, appended). `init` logs `ListOpened` for
    list 0 too, so every list's opening and owner is in the log.
21. **A list's owner can hand over, and a list's rent goes to its owner** (session 15; Carlos
    decided both, replacing session 14's "a list's owner never changes" and a list's rent swept to
    the treasury). Chosen here: `pending_owner` is appended to the list account (5,488 bytes after
    the discriminator become 5,520), so every offset before it stays; `propose_list_owner` reuses
    `add_issuer`'s accounts and checks the owner in the handler; the new events and errors are
    appended (`ListOwnerProposed`, `ListOwnerChanged`; `ListOwnerEmpty`, `ListOwnerUnchanged`,
    `NoPendingListOwner`, `NotThePendingListOwner`, `WrongSweepRecipient`). Decided in planning by
    Carlos: the handover moves ownership only, never the insert keys. Chosen: a closed list can be
    handed over, since its rent still pays its owner.
22. **`sweep_rent`'s third account is the recipient, checked in the handler** (session 15), since it
    is one of two keys depending on the target: the list's owner, read from the list's own bytes
    after the address and program checks, or the config's treasury. A wrong one fails with
    `WrongSweepRecipient` where it used to fail with Anchor's `ConstraintAddress`. `RentSwept` is
    unchanged: the recipient is in the transaction, and the rule decides it.

## What this does not do

No devnet deploy yet (`docs/devnet.md`), no mainnet, no Kora, no address lookup table, no proof on
a phone. The 4.0.0 ceremony
is pinned but nothing has been confirmed with PSE. The permutation proof the code tree exists for
has not been built. No paid review has happened, and `docs/handoff.md`'s "Before mainnet" list
still stands in full.

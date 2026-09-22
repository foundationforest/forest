# escrow

The sealed Solana program that holds an amount of a classic SPL token between two keys, buyer
and seller, and releases it by rules the chain reads by itself, signatures and time, and the
client an app uses to open, fund, watch and end one.

**Nothing here is shipped.** It has run under LiteSVM and on a local validator, and nowhere else.
No devnet, no mainnet.

An escrow is one account and one deposit account. The buyer opens it naming the seller, the
mint, the amount, an optional arbiter, an optional service time, the silence days and up to four
cancellation steps. Money arrives at the deposit account by a plain transfer from anywhere; the
escrow counts as funded when that account holds at least the amount. It ends by the buyer's
approval, by silence, by both keys agreeing a split, by the arbiter, by the buyer cancelling on a
step, or by the seller cancelling. Every ending pays out, returns anything above the amount to the
buyer, closes both accounts, returns their rent to whoever paid it, and writes what happened to
the log. Nothing in the program is anyone's dial: there is no admin, no config account, no pause
and no fee.

| | |
|---|---|
| `program/` | the program. Anchor, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 22 LiteSVM tests with the clock moved by hand, and the wire format written out a second time. |
| `client/` | TypeScript, browser and Node: every instruction, the clock and the deadlines from a market file, the deposit address and its pay link, the account and the events decoded. |

## Running it

```
cd escrow/program   && cargo build-sbf                    # needs Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test -- --nocapture
cd escrow/client    && npm install && npm test            # no chain needed
cd escrow/client    && npm run test:validator             # starts solana-test-validator itself
```

## What one escrow costs

Measured this session under LiteSVM, legacy transactions with a compute-budget instruction:

| | Compute units | Of 1,400,000 | Bytes on the wire | Of 1,232 |
|---|---|---|---|---|
| `create`, fullest terms (arbiter, service time, four steps) | 31,000 to 46,000 | 2 to 3% | 650 | 53% |
| `approve`, split | 14,037 | 1.0% | 482 | 39% |
| `release_by_silence` | 12,008 | 0.9% | 383 | 31% |
| `cancel_buyer` | 14,247 | 1.0% | 480 | 39% |

`create` varies because it derives two addresses, the escrow's and the deposit account's, and a
derivation tries bump seeds until one lands off the curve at 1,500 units a try; the keys decide
how many tries. The endings derive nothing (they check the recorded addresses) and are fixed.

Rent, for the two accounts one escrow holds, all of it returned at the end. At the 5,080 lamports
per byte session 3 read from mainnet and the 696 the current cuts end at (SOL at $100.24):

| Account | Bytes | Today | After the cuts |
|---|---|---|---|
| escrow | 286 | $0.21 | $0.029 |
| deposit account | 165 | $0.15 | $0.020 |

The tests measure 4,920,720 lamports out at creation and the same back at every one of the seven
endings, at LiteSVM's default rate.

## What is sealed

These cannot change after v1 deploys.

- **The state.** One account per escrow, 278 bytes after the discriminator, the layout in
  `program/src/state.rs` and repeated by hand in `program/tests-litesvm/src/lib.rs` and
  `client/src/program.ts`. `version` is 1. The zero key means no arbiter; a zero time means no
  service time, or funding not yet observed.
- **The addresses.** The escrow is `["escrow", buyer, id]` under the program; the deposit account
  is the escrow's associated token account for the mint, the standard derivation, so any wallet
  that sends the token "to the escrow's address" lands it there. Both are recorded in the account
  and the `Created` event as well as derivable.
- **The rules.** Funded means the deposit account holds at least the amount, checked by every
  instruction that needs it, never taken from a flag alone. The clock starts at the service time
  if one is set, else at the moment the funding was first observed (`mark_funded`, `object`, or
  `create` over a deposit account that already held the amount). Silence releases when now is
  past the clock start plus the silence days. A step is in force while now is before its deadline,
  the clock start plus its offset; the first such step is the one that applies. A payout to the
  seller is `amount × bps / 10,000` rounded down; the buyer gets the rest of the deposit
  account's balance. Locked means only agreement, the arbiter, or the seller giving everything
  back can end it. The order of checks in each instruction.
- **The instruction bytes and the account lists.** Ten instructions; the ten events and their
  fields. Clients and indexes read them forever.
- **What a Token-2022 mint gets.** Refused at `create`: the mint account must be owned by the
  classic token program. A transfer fee, a permanent delegate or a transfer hook would change
  what "hold X, release X" means, and this cannot be patched.
- **What is not there.** No admin key, no config account, no upgrade, no pause, no fee, no way
  for anyone to move money except the rules above.

## What the app decides

Everything the program does not know. The market file carries the defaults (`silenceDays`,
`arbiterAllowed`, the accepted `tokens`, and cancellation steps as hours from the clock start and
a refund percent, a field the market template does not have yet, see "Open"); the parties choose
the rest; `termsFor` in the client puts them together and refuses what the market forbids.

- **The amount.** Per hour, per session or per job is the app multiplying before creation. One
  escrow per payment.
- **The id.** Any 64-bit number the buyer has not used; `randomId()` picks one. A buyer who
  reuses an id after that escrow closed reuses its address.
- **When to send `mark_funded`.** The app watches the deposit address and sends it when the
  balance reaches the amount, because that moment is the clock start when there is no service
  time. Nobody needs to sign it. Skipping it blocks nothing except silence and a buyer's
  cancellation, which both need a clock; the app can put `mark_funded` in the same transaction.
- **Which token accounts get paid.** Every ending names a token account the buyer owns and one
  the seller owns, for the mint. The program checks the owner and the mint and nothing else, so
  the caller of `release_by_silence`, who can be anyone, can only send the seller's money to the
  seller.
- **Who pays the rent.** Whoever signs `create` as the payer: a sponsor, or the buyer. The same
  key gets both rents back at the end, whoever sends the ending.
- **The pay link.** `solanaPayUrl` names the escrow's address as the recipient with the mint and
  the amount, and the escrow's address as the reference, so the funding transfer can be found by
  looking up that address. Whatever arrives counts, link or not.

## The state machine

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | buyer, payer | terms valid; classic SPL Token mint; buyer and seller differ | open, or funded if the deposit account already held the amount |
| open | `mark_funded` | nobody | balance at least the amount | funded |
| open, funded | `approve` | buyer | balance at least the amount | ended, approved |
| open, funded | `release_by_silence` | nobody | balance at least the amount; clock started; now past start plus silence days | ended, released by silence |
| open, funded | `object` | buyer | balance at least the amount; now not past start plus silence days | locked (from open, this is the observation of funding) |
| open, funded, locked | `agree` | buyer and seller | balance at least the amount | ended, agreed |
| open, funded, locked | `arbitrate` | arbiter | an arbiter was named; balance at least the amount | ended, arbitrated |
| open, funded | `cancel_buyer` | buyer | balance at least the amount; clock started; a step's deadline still ahead | ended, cancelled by buyer |
| open, funded, locked | `cancel_seller` | seller | balance at least the amount | ended, cancelled by seller |
| open | `close` | seller | balance below the amount | ended, never funded |
| open | `close` | buyer | balance below the amount; no steps, or now past the last deadline measured from the service time, else from creation | ended, never funded |

"Ended" is not a stored state: both accounts are closed and the `Closed` event, with the outcome
and every amount, is the record. Each ending also emits its own event first (`Approved`,
`ReleasedBySilence`, `Agreed`, `Arbitrated`, `CancelledByBuyer`, `CancelledBySeller`); `close`
emits only `Closed` with outcome `NeverFunded`. An unresolved lock is an `Objected` with no
`Closed` after it: that is the mark on both parties, and an index reads it as such.

## How a review points at an escrow

A review's `escrow` field is the escrow account's address, base58. The account is closed when the
escrow ends, so the address does not resolve to an account afterwards; it resolves to a history.
An index looks up the transactions that touched that address and reads the events: `Created`
(the parties, the mint, the amount, the terms), `Funded`, then whatever ended it and `Closed`. The
review's `subject` and the reviewer's wallet should match the escrow's seller and buyer, or the
other way round, and the amount and outcome are what the review is evidence of.

The address is `["escrow", buyer, id]`, so a buyer can reuse it by reusing an id after the first
escrow closed. The client picks a random 64-bit id, so that is a deliberate act; an index that
finds two `Created` events at one address takes the one before the review's time. Whether a
review should carry the closing transaction's signature too, which cannot be reused, is open.

## The upgrade authority, and how it is removed

The program must be sealed on the day it deploys to mainnet. After

```
solana program deploy --program-id <program-keypair.json> target/deploy/forest_escrow.so
```

the deployer runs, once, from the machine holding the upgrade authority:

```
solana program set-upgrade-authority <PROGRAM_ID> --final
solana program show <PROGRAM_ID>        # "Authority: none"
```

`--final` is not reversible. After it, no key on earth can change the bytes, and the only way to
a v2 is a new program at a new address. New deals use the newest version; old deals finish on
theirs, and the client carries a program id per version for that.

Unlike the registry, nothing has to be replaced before that command: the program has no treasury,
no first mint and no constant that names anyone. The program id for local work is
`FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT`; no keypair for it is committed and none is
needed, since LiteSVM loads a program at any address and the test validator takes
`--bpf-program`. Mainnet gets a fresh one.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible until something
ships, and each is logged in `docs/changes.md`.

1. **The escrow is a program-derived address of the buyer and a random id**, and the deposit
   account is its associated token account. Because that is the one address every wallet derives
   for "send this token to that address", so a plain transfer from anywhere lands in the deposit
   account by construction, and a Squads vault, which people fund the same way every day, is the
   same shape.
2. **`create` adopts a deposit account that already exists**, and counts the escrow funded from
   that moment if it already holds the amount. Only the escrow's own address can own that account,
   so there is nothing to check but the mint. Money that arrives before the escrow does is not
   stranded.
3. **A step's deadline is a signed offset in seconds from the clock start**, so a market can say
   "until a day before the session, everything back" (negative) or "within a day of funding"
   (positive), and the same steps mean the same thing whether or not a service time is set.
   Offsets must strictly rise; refunds may go in any order.
4. **The seller's share rounds down**, in every split and in a cancellation's remainder, and the
   buyer gets the rest of the balance. Rounding favours the buyer by at most one base unit.
5. **A never-funded escrow's deadlines are measured from the service time if set, else from
   creation**, because there is no funding time to measure from. That decides only when the buyer
   may `close` an escrow that never held the amount; the seller may at any time.
6. **The seller may cancel while locked.** The buyer gets everything, so it can only be a
   concession, and it gives a lock with no arbiter one exit that needs no cooperation.
7. **Approving while locked is refused**, as the handoff says: only agreement or the arbiter ends
   a lock from the buyer's side.
8. **The arbiter may not be a party**, and the seller may not be the buyer or the zero key. A
   buyer who arbitrated their own deal would have written the split alone from inside a lock.
9. **A service time is any positive unix time**, including one already past, in which case the
   clock has already started. Zero is refused so it cannot be mistaken for none.
10. **Silence days fit in sixteen bits** (up to 179 years) and there are at most four steps, so
    the account never changes size.
11. **Every ending takes both parties' token accounts**, even when one receives nothing, so the
    seven endings share one account list and one hand-written encoder.
12. **The market file's steps are `{ hours, refundPercent }`**, converted by the client. The
    market template does not have the field yet; the client treats its absence as no steps.
13. **Anchor 1.2, `cargo build-sbf`, no IDL**, as in the registry: the client and the Rust tests
    both write the bytes by hand.

## What this does not do

No devnet, no mainnet, no Kora. No paid review has happened, and `docs/handoff.md`'s "Before
mainnet" list still stands in full. The market template does not yet carry cancellation steps.
Whether the wallets people use accept a program-derived address as a Solana Pay recipient has not
been tried on a phone; if one does not, the app sends to the deposit address directly, which the
client also gives.

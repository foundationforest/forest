# escrow

The sealed Solana program that holds an amount of a classic SPL token between two keys, buyer
and seller, and releases it by rules the chain reads by itself, signatures and time, and the
client an app uses to open, fund, watch and end one.

**Nothing here is shipped.** It has run under LiteSVM and on a local validator, and nowhere else.
No devnet, no mainnet.

An escrow is one account and one deposit account. The buyer opens it naming the seller, the
mint, the amount, an optional arbiter, an optional service time, the silence days and up to four
cancellation steps; or the seller opens it naming the buyer, as an invoice. Money arrives at the
deposit account by a plain transfer from anywhere; the escrow counts as funded when that account
holds at least the amount.

The seller accepts before anything but paying in full can happen. Until then a funded escrow can
only be approved in full (paying in full never needs the seller's consent) or withdrawn by the
buyer, everything back. An invoice is accepted from creation. Once accepted, it ends by the
buyer's approval, by silence, by both keys agreeing a split, by the arbiter, by the buyer
cancelling on a step, or by the seller cancelling.

Every ending pays out, returns anything above the amount to the buyer, closes the deposit account,
returns its rent to whoever paid it, and writes what happened to the log. The escrow account is
never closed once it has held the amount: it stays, with its final state, amounts and outcome, so
its address is a permanent receipt and can never hold another deal. Only an escrow that never held
the amount is closed, both accounts and both rents (`close_unfunded`). Nothing in the program is
anyone's dial: there is no admin, no config account, no pause and no fee.

| | |
|---|---|
| `program/` | the program. Anchor, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 51 LiteSVM tests with the clock moved by hand, and the wire format written out a second time: `escrow.rs` (25), `adversarial.rs` (24, session 10's attacks as session 11 left them) and `one_tap.rs` (2, the one-tap payment and its receipt) (`docs/decisions/adversarial-review-1.md`). |
| `program/trident-tests/` | a Trident fuzzer: random flows against the built program, a model of every escrow beside it, eight invariants checked after every step. |
| `client/` | TypeScript, browser and Node: every instruction, the terms checked before signing, the invoice, the clock and the deadlines from a market file, the deposit address and its pay link, the account and the events decoded. |

## Running it

```
cd escrow/program   && cargo build-sbf                    # needs Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test -- --nocapture
cd escrow/program/trident-tests && TRIDENT_WITH_EXIT_CODE=1 cargo run --release --bin fuzz_escrow   # exit 99 if an invariant broke
cd escrow/client    && npm install && npm test            # no chain needed
cd escrow/client    && npm run test:validator             # starts solana-test-validator itself
```

## What one escrow costs

Measured in session 11 under LiteSVM, legacy transactions with a compute-budget instruction:

| | Compute units | Of 1,400,000 | Bytes on the wire | Of 1,232 |
|---|---|---|---|---|
| `create`, fullest terms (arbiter, service time, four steps) | 31,400 to 41,900 | 2 to 3% | 682 | 55% |
| `accept` | 4,923 | 0.4% | 380 | 31% |
| `approve`, split | 15,331 | 1.1% | 482 | 39% |
| `release_by_silence` | 13,302 | 1.0% | 383 | 31% |
| `cancel_buyer` | 15,558 | 1.1% | 480 | 39% |
| `withdraw` | 10,840 | 0.8% | 447 | 36% |
| `close_unfunded` | 7,594 | 0.5% | 447 | 36% |
| one tap: `create`, a plain transfer in, `approve`, in one transaction | 45,800 to 71,400 | 3 to 5% | 700 | 57% |
| the same, the seller's token account made first in it | 57,900 to 72,900 | 4 to 5% | 742 | 60% |
| the same, fullest terms | 44,900 to 49,400 | 3 to 4% | 781 | 63% |

`create` varies because it derives two addresses, the escrow's and the deposit account's, and a
derivation tries bump seeds until one lands off the curve at 1,500 units a try; the keys decide
how many tries, and a one-tap transaction derives the deposit account several times over (the
associated token program's own checks included), so its spread is wider. The endings derive
nothing (they check the recorded addresses) and are fixed.

Rent, at the 5,080 lamports per byte session 3 read from mainnet and the 696 the current cuts end
at (SOL at $100.24). The deposit account's rent comes back at every ending. The escrow account's
comes back only if it never held the amount; otherwise the account is the receipt and keeps it:

| Account | Bytes | Today | After the cuts | Returned |
|---|---|---|---|---|
| escrow | 319 | 2,270,760 lamports, $0.23 | 311,112 lamports, $0.031 | only if never funded |
| deposit account | 165 | 1,488,440 lamports, $0.15 | 203,928 lamports, $0.020 | at every ending |

The tests measure the escrow account's 3,111,120 and the deposit account's 2,039,280 lamports at
LiteSVM's default rate (6,960 a byte): both out at creation, the deposit account's back at every one
of the eight endings, and the escrow account's back only from `close_unfunded`. One-tap Pay therefore
costs its payer the receipt's rent, for good: 2,270,760 lamports ($0.23) at today's rate and 311,112
($0.031) at the final one, measured with the Rent sysvar at each rate (`one_tap.rs`).

## What is sealed

These cannot change after v1 deploys.

- **The state.** One account per escrow, 311 bytes after the discriminator, the layout in
  `program/src/state.rs` and repeated by hand in `program/tests-litesvm/src/lib.rs` and
  `client/src/program.ts`. `version` is 1. The zero key means no arbiter; a zero time means no
  service time, funding not yet observed, not yet accepted, or not yet ended. The status is one of
  open, accepted, funded, locked and ended, stored as 0 to 4; the outcome byte means something only
  once the status is ended. After an ending the account holds, for good, the parties, the mint,
  the amount and the terms, when it was created, funded, accepted and ended, how it ended, and what
  each party was paid.
- **The addresses.** The escrow is `["escrow", buyer, id]` under the program, whichever party opens
  it; the deposit account is the escrow's associated token account for the mint, the standard
  derivation, so any wallet that sends the token "to the escrow's address" lands it there. Both are
  recorded in the account and the `Created` event as well as derivable. An address that ever held a
  funded escrow is taken for good: `create` there fails, because the receipt is still there.
- **The rules.** An ended escrow accepts nothing, checked first by every instruction, so a payment
  that arrives after the end and re-creates the deposit account cannot be paid out a second time.
  Before the seller accepts, only a full approval and the buyer's withdrawal run. Funded means the
  deposit account holds at least the amount, checked by every instruction that needs it, never
  taken from a flag alone. The clock starts at the service time if one is set, else at the moment
  the funding was first observed (`accept` or `mark_funded` or `object`, or `create` over a deposit
  account that already held the amount, for an invoice), but never before the seller accepted: if
  the acceptance came later, the clock starts there. Silence releases when now is past the clock
  start plus the silence days. A step is in force while now is before its deadline,
  the clock start plus its offset; the first such step is the one that applies. A payout to the
  seller is `amount × bps / 10,000` rounded down; the buyer gets the rest of the deposit
  account's balance. In a buyer's cancellation `bps` is 10,000 minus the step's refund, so the
  buyer gets at least the step's percent (session 10 fixed the program, which had rounded the
  refund down instead). Locked means only agreement, the arbiter, or the seller giving everything
  back can end it. The order of checks in each instruction.
- **The instruction bytes and the account lists.** Twelve instructions; the thirteen events and
  their fields. Clients and indexes read them forever. `create` carries the buyer in its arguments
  and the creator in its signer slot. `withdraw` and `close_unfunded` name no seller token account.
- **What a Token-2022 mint gets.** Refused at `create`: the mint account must be owned by the
  classic token program. A transfer fee, a permanent delegate or a transfer hook would change
  what "hold X, release X" means, and this cannot be patched.
- **What wrapped SOL gets.** Refused at `create` by its address (`NATIVE_MINT`). SOL sent to its
  deposit account by a plain transfer counts only after a sync, and whatever arrived after the
  last sync would have left with the rent rather than gone to the buyer.
- **What is not there.** No admin key, no config account, no upgrade, no pause, no fee, no way
  for anyone to move money except the rules above.

## What the app decides

Everything the program does not know. The market file carries the defaults (`silenceDays`,
`arbiterAllowed`, the accepted `tokens`, and cancellation steps as hours from the clock start and
a refund percent, a field the market template does not have yet, see "Open"); the parties choose
the rest; `termsFor` in the client puts them together and refuses what the market forbids.

- **Whether the terms make sense.** The program accepts terms nobody means. Before a party signs
  anything that commits it to them (`create`, `accept`, or paying an invoice), the client's
  `checkTerms` refuses them unless: a service time is unix seconds (below 10^10, so a
  millisecond timestamp is caught) and not already past; there are at most four steps, rising,
  refunds 0 to 100%, and no step outlasts silence (or the buyer's cancellation and the seller's
  release race); and the escrow's arbiter is the one the signer agreed to, and none if it agreed to
  none. `termsFor` and `createIx` run it; `acceptIx` is built only from the escrow account as read
  from the chain, and runs it against the arbiter the seller agreed to.
- **The amount.** Per hour, per session or per job is the app multiplying before creation. One
  escrow per payment.
- **The id.** Any 64-bit number the buyer has not used; `randomId()` picks one. An address that
  ever held a funded escrow cannot be opened again; one that was closed without ever holding the
  amount can, by the same buyer and id.
- **Who opens it.** The buyer, proposing (`createIx`), which the seller then accepts (`acceptIx`);
  or the seller, invoicing (`invoice`, which gives the seller's `create` and the pay link to send
  the buyer), accepted from the start. For an invoice the buyer's app reads the escrow off the
  chain, runs `checkTerms`, and pays by a plain transfer, then approves when the work is done, or
  in the same transaction.
- **When to send `mark_funded`.** The app watches the deposit address and sends it when the
  balance reaches the amount after the seller has accepted, because that moment is the clock start
  when there is no service time. Nobody needs to sign it. Skipping it blocks nothing except silence
  and a buyer's cancellation, which both need a clock; the app can put `mark_funded` in the same
  transaction. If the money is already there when the seller accepts, `accept` is the observation.
- **Which token accounts get paid.** Every ending that can pay the seller names a token account
  the buyer owns and one the seller owns, for the mint. The program checks the owner and the mint
  and nothing else, so the caller of `release_by_silence`, who can be anyone, can only send the
  seller's money to the seller. `withdraw` and `close_unfunded` pay the seller nothing and name no
  seller account, so nobody has to make one to get the buyer's money back.
- **Who pays the rent.** Whoever signs `create` as the payer: a sponsor, or either party. The same
  key gets the deposit account's rent back at the end, whoever sends the ending. The escrow
  account's rent stays in the receipt, unless the escrow never held the amount, in which case
  `close_unfunded` returns both. A sponsor's policy has to live with that: every funded escrow it
  sponsors keeps one receipt's rent for good.
- **The pay link.** `solanaPayUrl` names the escrow's address as the recipient with the mint and
  the amount, and the escrow's address as the reference, so the funding transfer can be found by
  looking up that address. Whatever arrives counts, link or not. A payment that arrives after the
  escrow ended is stranded: the program pays out nothing from an ended escrow, and its address never
  opens again (see "Open" in `docs/changes.md`).

## The state machine

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | buyer, payer | terms valid; classic SPL Token mint, not wrapped SOL; buyer and seller differ; the address never held an escrow that is still there | open |
| nothing | `create` | seller, payer | the same | accepted, or funded if the deposit account already held the amount (an invoice) |
| open | `accept` | seller | | accepted, or funded if the deposit account holds the amount |
| open | `approve`, 10,000 basis points only | buyer | balance at least the amount | ended, approved |
| open | `withdraw` | buyer | balance at least the amount | ended, withdrawn |
| accepted | `mark_funded` | nobody | balance at least the amount | funded |
| accepted, funded | `approve` | buyer | balance at least the amount | ended, approved |
| accepted, funded | `release_by_silence` | nobody | balance at least the amount; clock started; now past start plus silence days | ended, released by silence |
| accepted, funded | `object` | buyer | balance at least the amount; now not past start plus silence days | locked (from accepted, this is the observation of funding) |
| accepted, funded, locked | `agree` | buyer and seller | balance at least the amount | ended, agreed |
| accepted, funded, locked | `arbitrate` | arbiter | an arbiter was named; balance at least the amount | ended, arbitrated |
| accepted, funded | `cancel_buyer` | buyer | balance at least the amount; clock started; a step's deadline still ahead | ended, cancelled by buyer |
| accepted, funded, locked | `cancel_seller` | seller | balance at least the amount | ended, cancelled by seller |
| open, accepted | `close_unfunded` | buyer or seller | balance below the amount | gone: both accounts closed |
| open, accepted | `close_unfunded` | rent payer | balance below the amount; no steps, or now past the last deadline measured from the service time, else from creation | gone: both accounts closed |
| ended | anything | | | refused: `Ended` |

Before the seller accepts, everything but a full `approve` and `withdraw` is refused with
`NotAccepted`: `mark_funded`, `object`, `release_by_silence`, `agree`, `arbitrate`, `cancel_buyer`,
`cancel_seller`, and `approve` with a split.

"Ended" is a stored state now. The escrow account stays: its status, its outcome, when it ended and
what each party got are in it for good, and its deposit account is closed. Each ending emits its
own event first (`Approved`, `ReleasedBySilence`, `Agreed`, `Arbitrated`, `CancelledByBuyer`,
`CancelledBySeller`, `Withdrawn`), then `Ended` with the outcome, every amount and whether the
seller had accepted. `close_unfunded` emits only `Closed`: nothing was dealt, so there is no
receipt. An unresolved lock is an account whose status is still `Locked`, an `Objected` with no
`Ended` after it: that is the mark on both parties, and an index reads it as such.

## How a review points at an escrow

A review's `escrow` field is the escrow account's address, base58. Once the escrow has held the
amount, that address is a permanent receipt: the account is never closed, and it holds the
parties, the mint, the amount, the terms, when it was created, funded, accepted and ended, how it
ended, and what each party was paid. An index reads the account; the events (`Created`,
`Accepted`, `Funded`, then whatever ended it and `Ended`) give the same numbers with their
transactions. The review's `subject` and the reviewer's wallet should match the escrow's seller and
buyer, or the other way round, and the amount and outcome are what the review is evidence of.

`accepted_at` says whether the seller ever accepted. A full approval before acceptance, the
one-tap Pay among them, leaves a receipt with `accepted_at` of zero: money went to the seller, but
the seller never agreed to anything, and a stranger can make one for a single base unit. An index
should weigh such a receipt accordingly. An invoice paid in one tap leaves an accepted one.

Only events the escrow program itself wrote count: any program can write a `Program data:` line
with the same bytes, so `decodeEvents` reads the runtime's own invoke lines to see who wrote each
one. Accounts cannot be forged that way: only this program can own an account at the address it
derives.

The address is single-use once funded: session 10's finding that a buyer could reopen an ended
escrow's address for a second deal is closed, because the receipt occupies it for good. So the
address is the deal id.

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

1. **The escrow is a program-derived address of the buyer and a random id**, whichever party opens
   it, and the deposit account is its associated token account. Because that is the one address
   every wallet derives for "send this token to that address", so a plain transfer from anywhere
   lands in the deposit account by construction, and a Squads vault, which people fund the same way
   every day, is the same shape.
2. **`create` adopts a deposit account that already exists**, and, for an invoice, counts the
   escrow funded from that moment if it already holds the amount; for a buyer's proposal the
   seller's acceptance is that observation. Only the escrow's own address can own that account,
   so there is nothing to check but the mint. Money that arrives before the escrow does is not
   stranded.
3. **A step's deadline is a signed offset in seconds from the clock start**, so a market can say
   "until a day before the session, everything back" (negative) or "within a day of funding"
   (positive), and the same steps mean the same thing whether or not a service time is set.
   Offsets must strictly rise; refunds may go in any order.
4. **The seller's share rounds down**, in every split and in a cancellation's remainder, and the
   buyer gets the rest of the balance. Rounding favours the buyer by at most one base unit.
5. **A never-funded escrow's deadlines are measured from the service time if set, else from
   creation**, because there is no funding time to measure from. That decides only when the rent
   payer may `close_unfunded`; the buyer and the seller may at any time.
6. **The seller may cancel while locked.** The buyer gets everything, so it can only be a
   concession, and it gives a lock with no arbiter one exit that needs no cooperation.
7. **Approving while locked is refused**, as the handoff says: only agreement or the arbiter ends
   a lock from the buyer's side.
8. **The arbiter may not be a party**, and the seller may not be the buyer or the zero key; nor may
   the buyer be the zero key. A buyer who arbitrated their own deal would have written the split
   alone from inside a lock.
9. **A service time is any positive unix time**, including one already past. Zero is refused so it
   cannot be mistaken for none. The client refuses a past one and a millisecond one before signing.
10. **Silence days fit in sixteen bits** (up to 179 years) and there are at most four steps, so
    the account never changes size.
11. **Every ending that can pay the seller takes both parties' token accounts**, even when one
    receives nothing, so those seven share one account list and one hand-written encoder.
    `withdraw` and `close_unfunded`, which never pay the seller, take the buyer's only.
12. **The market file's steps are `{ hours, refundPercent }`**, converted by the client. The
    market template does not have the field yet; the client treats its absence as no steps.
13. **Anchor 1.2, `cargo build-sbf`, no IDL**, as in the registry: the client and the Rust tests
    both write the bytes by hand.
14. **The clock never starts before the seller accepts** (session 11). It starts at the later of
    the acceptance and the service time, or, with no service time, the funding. Because a seller
    who could accept after silence had run out could accept and release in one transaction, and the
    buyer would never have had a moment to object after the seller committed.
15. **`mark_funded` waits for acceptance too, and `accept` observes funding** (session 11), so the
    funding observation and the acceptance never disagree about when the clock starts.
16. **The buyer's exit before acceptance is its own instruction and outcome, `withdraw`**, not a
    cancellation step, so an index can tell "nobody dealt" from "a deal was cancelled on its terms".
17. **The new fields sit after `bump`** (accepted_at, ended_at, outcome, to_seller, to_buyer), so
    every offset session 8 pinned stays where it was; the status values were renumbered in order
    (open, accepted, funded, locked, ended), since nothing is deployed.
18. **The ending event is `Ended`, and `Closed` is kept for the one case where the account really
    closes**, a never-funded escrow, with its own fields. Because a `Closed` on an account that stays
    open would mislead every index written against it.

## What this does not do

No devnet, no mainnet, no Kora. No paid review has happened, and `docs/handoff.md`'s "Before
mainnet" list still stands in full. The market template does not yet carry cancellation steps.
Whether the wallets people use accept a program-derived address as a Solana Pay recipient has not
been tried on a phone; if one does not, the app sends to the deposit address directly, which the
client also gives. Nothing returns a payment that arrives after an escrow ended, nothing moves the
rent the cuts will leave in receipts, and nothing lets a sponsor end a funded escrow its seller
never accepted: each is an open question in `docs/changes.md`.

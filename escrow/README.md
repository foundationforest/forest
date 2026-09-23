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
buyer, everything back; and once its timeout has passed, anyone may send everything back to the
buyer, so a sponsor's rent never waits on the buyer coming back. An invoice is accepted from
creation. Once accepted, it ends by the buyer's approval, by silence, by both keys agreeing a
split, by the arbiter, by the buyer cancelling on a step, or by the seller cancelling.

Every ending pays out, returns anything above the amount to the buyer, closes the deposit account,
returns its rent to whoever paid it, and writes what happened to the log. The escrow account is
never closed once it has held the amount: it stays, with its final state, amounts and outcome, so
its address is a permanent receipt and can never hold another deal. Only an escrow that never held
the amount is closed, both accounts and both rents (`close_unfunded`). Two things still happen at
a receipt, and neither changes it: money a later payment leaves at its deposit address goes back to
the buyer (`recover_late`), and rent above the account's current minimum goes back to whoever paid
it (`sweep_rent`). Anyone may send either. Nothing in the program is anyone's dial: there is no
admin, no config account, no pause and no fee.

| | |
|---|---|
| `program/` | the program. Anchor, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 64 LiteSVM tests with the clock moved by hand, and the wire format written out a second time: `escrow.rs` (32), `adversarial.rs` (30, session 10's attacks as sessions 11 and 12 left them, and session 12's) and `one_tap.rs` (2, the one-tap payment, its receipt, and a second payment to its link) (`docs/decisions/adversarial-review-1.md`). |
| `program/trident-tests/` | a Trident fuzzer: random flows against the built program, a model of every escrow beside it, eleven invariants checked after every step and at the end of every run. |
| `client/` | TypeScript, browser and Node: every instruction, the terms checked before signing, the invoice, the terms from an offer, the clock and the deadlines, the deposit address and its pay link, the account and the events decoded. |

## Running it

```
cd escrow/program   && cargo build-sbf                    # needs Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test -- --nocapture
cd escrow/program/trident-tests && TRIDENT_WITH_EXIT_CODE=1 cargo run --release --bin fuzz_escrow   # exit 99 if an invariant broke
cd escrow/client    && npm install && npm test            # no chain needed
cd escrow/client    && npm run test:validator             # starts solana-test-validator itself
```

## What one escrow costs

Measured in session 12 under LiteSVM, legacy transactions with a compute-budget instruction:

| | Compute units | Of 1,400,000 | Bytes on the wire | Of 1,232 |
|---|---|---|---|---|
| `create`, fullest terms (arbiter, service time, four steps) | 31,400 to 41,900 | 2 to 3% | 682 | 55% |
| `accept` | 4,944 | 0.4% | 380 | 31% |
| `approve`, split | 15,331 | 1.1% | 482 | 39% |
| `release_by_silence` | 13,306 | 1.0% | 383 | 31% |
| `cancel_buyer` | 15,560 | 1.1% | 480 | 39% |
| `withdraw` | 10,840 | 0.8% | 447 | 36% |
| `close_unfunded` | 7,594 | 0.5% | 447 | 36% |
| `close_unaccepted`, making the buyer's refund address | 31,500 to 45,100 | 2 to 3% | 579 | 47% |
| `recover_late`, the refund address already there | 11,700 to 16,200 | 0.8 to 1.2% | 578 | 47% |
| `sweep_rent` | 4,290 | 0.3% | 251 | 20% |
| one tap: `create`, a plain transfer in, `approve`, in one transaction | 45,800 to 71,400 | 3 to 5% | 700 | 57% |
| the same, the seller's token account made first in it | 57,900 to 72,900 | 4 to 5% | 742 | 60% |
| the same, fullest terms | 44,900 to 49,400 | 3 to 4% | 781 | 63% |

`create` varies because it derives two addresses, the escrow's and the deposit account's, and a
derivation tries bump seeds until one lands off the curve at 1,500 units a try; the keys decide
how many tries, and a one-tap transaction derives the deposit account several times over (the
associated token program's own checks included), so its spread is wider. The endings that pay the
recorded accounts derive nothing and are fixed; `close_unaccepted` and `recover_late` derive the
buyer's refund address, so they vary the same way.

Rent, at the 5,080 lamports per byte session 3 read from mainnet and the 696 the current cuts end
at (SOL at $100.24). The deposit account's rent comes back at every ending. The escrow account's
comes back whole only if it never held the amount; otherwise the account is the receipt and keeps
its rent-exempt minimum, and `sweep_rent` returns whatever is above that minimum as the cuts land:

| Account | Bytes | Today | After the cuts | Returned |
|---|---|---|---|---|
| escrow | 319 | 2,270,760 lamports, $0.23 | 311,112 lamports, $0.031 | whole only if never funded; above the minimum by `sweep_rent` |
| deposit account | 165 | 1,488,440 lamports, $0.15 | 203,928 lamports, $0.020 | at every ending |

The tests measure the escrow account's 3,111,120 and the deposit account's 2,039,280 lamports at
LiteSVM's default rate (6,960 a byte): both out at creation, the deposit account's back at every one
of the nine endings, and the escrow account's back whole only from `close_unfunded`. One-tap Pay
therefore costs its payer the receipt's rent: 2,270,760 lamports ($0.23) at today's rate and 311,112
($0.031) at the final one, measured with the Rent sysvar at each rate (`one_tap.rs`). Once the cuts
land, `sweep_rent` returns the difference, 1,959,648 lamports a receipt made today; the final 311,112
stays for good. `escrow.rs` measures a sweep at 696 a byte.

## What is sealed

These cannot change after v1 deploys.

- **The state.** One account per escrow, 311 bytes after the discriminator, the layout in
  `program/src/state.rs` and repeated by hand in `program/tests-litesvm/src/lib.rs` and
  `client/src/program.ts`. `version` is 1. The zero key means no arbiter; a zero time means no
  service time, funding not yet observed, not yet accepted, or not yet ended. The status is one of
  open, accepted, funded, locked and ended, stored as 0 to 4; the outcome byte means something only
  once the status is ended, and is one of approved, released by silence, agreed, arbitrated,
  cancelled by buyer, cancelled by seller, withdrawn and never accepted, stored as 0 to 7. After an ending the account holds, for good, the parties, the mint,
  the amount and the terms, when it was created, funded, accepted and ended, how it ended, and what
  each party was paid.
- **The addresses.** The escrow is `["escrow", buyer, id]` under the program, whichever party opens
  it; the deposit account is the escrow's associated token account for the mint, the standard
  derivation, so any wallet that sends the token "to the escrow's address" lands it there. Both are
  recorded in the account and the `Created` event as well as derivable. An address that ever held a
  funded escrow is taken for good: `create` there fails, because the receipt is still there.
- **The rules.** An ended escrow accepts nothing but `recover_late` and `sweep_rent`, and neither
  changes its bytes; every other instruction checks `Ended` first, so a payment that arrives after
  the end and re-creates the deposit account cannot be paid out as part of the deal. It goes back
  to the buyer instead: `recover_late`, anyone, pays whatever the re-created deposit account holds
  to the buyer's refund address and closes it, its rent to the buyer. Before the seller accepts,
  only a full approval, the buyer's withdrawal and, after the timeout, `close_unaccepted` end a
  funded escrow; `mark_funded` may run too, and records the time and nothing else. Funded means the
  deposit account holds at least the amount, checked by every instruction that needs it, never
  taken from a flag alone. The funding is observed once, the first time `create` (for an invoice),
  `accept`, `mark_funded` or `object` sees the amount there, before or after the acceptance. The
  clock starts at the latest of the service time (if set), that observation and the seller's
  acceptance, and not before the last two have happened (session 12): funding always counts, so an
  old invoice paid late cannot be released at once, and a late acceptance cannot find silence over.
  Silence releases when now is past the clock start plus the silence days. A step is in force
  while now is before its deadline, the clock start plus its offset; the first such step is the one
  that applies. An escrow the seller never accepted may be sent back by anyone once now is past its
  timeout: its last deadline counted from the later of the service time and the observed funding,
  or 30 days after the observed funding when it has no steps. `sweep_rent` moves only what the
  escrow account holds above the current rent-exempt minimum, only to the recorded rent payer, and
  leaves exactly the minimum. A payout to the
  seller is `amount × bps / 10,000` rounded down; the buyer gets the rest of the deposit
  account's balance. In a buyer's cancellation `bps` is 10,000 minus the step's refund, so the
  buyer gets at least the step's percent (session 10 fixed the program, which had rounded the
  refund down instead). Locked means only agreement, the arbiter, or the seller giving everything
  back can end it. The order of checks in each instruction.
- **The instruction bytes and the account lists.** Fifteen instructions; the sixteen events and
  their fields. Clients and indexes read them forever. `create` carries the buyer in its arguments
  and the creator in its signer slot. `withdraw`, `close_unfunded` and `close_unaccepted` name no
  seller token account.
- **The buyer's refund address.** The buyer's associated token account for the mint, computed from
  the buyer and the mint, both fixed at creation, so nothing more is stored. `recover_late` and
  `close_unaccepted`, which anyone may send, pay the buyer there and at no other account, and the
  sender makes it first, at its own cost, inside the same instruction, if it does not exist. The
  endings a party signs take any token account the buyer owns, as before.
- **What a Token-2022 mint gets.** Refused at `create`: the mint account must be owned by the
  classic token program. A transfer fee, a permanent delegate or a transfer hook would change
  what "hold X, release X" means, and this cannot be patched.
- **What wrapped SOL gets.** Refused at `create` by its address (`NATIVE_MINT`). SOL sent to its
  deposit account by a plain transfer counts only after a sync, and whatever arrived after the
  last sync would have left with the rent rather than gone to the buyer.
- **What is not there.** No admin key, no config account, no upgrade, no pause, no fee, no way
  for anyone to move money except the rules above.

## What the app decides

Everything the program does not know. An escrow is created from the offer's terms: the post's
`terms` block, which the seller sets per offer (the auto-release days, which the program calls
silence days; up to four cancellation steps as hours from the clock start and a refund percent;
an optional arbiter). The deal adds its own seller, amount, mint, service time and id. `termsFor`
in the client puts the two together. A market file only suggests starting values for an offer's
terms (`suggestedTerms`); it restricts nothing, so any mint the program accepts and any arbiter
work, and no market file is read when an escrow is made.

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
  balance reaches the amount, before or after the seller accepts: the clock never starts before
  that moment, and an escrow nobody accepts counts its timeout from it. Nobody needs to sign it.
  Skipping it blocks nothing except silence, a buyer's cancellation and `close_unaccepted`, which
  all need that moment; the app can put `mark_funded` in the same transaction. If the money is
  already there when the seller accepts, `accept` is the observation. A sponsor that wants its rent
  back from an escrow nobody accepted sends `mark_funded` itself, then waits out the timeout.
- **Which token accounts get paid.** Every ending that can pay the seller names a token account
  the buyer owns and one the seller owns, for the mint. The program checks the owner and the mint
  and nothing else, so the caller of `release_by_silence`, who can be anyone, can only send the
  seller's money to the seller. `withdraw` and `close_unfunded` pay the seller nothing and name no
  seller account, so nobody has to make one to get the buyer's money back. `recover_late` and
  `close_unaccepted` pay the buyer only at the refund address (`refundAddress` in the client), and
  whoever sends them pays to make it if the buyer has none: about the same rent as the deposit
  account's that `close_unaccepted` returns, so a sponsor ending such an escrow for a buyer with no
  standard token account gets nothing back net.
- **Who pays the rent.** Whoever signs `create` as the payer: a sponsor, or either party. The same
  key gets the deposit account's rent back at the end, whoever sends the ending. The escrow
  account's rent stays in the receipt, unless the escrow never held the amount, in which case
  `close_unfunded` returns both. A sponsor's policy has to live with that: every funded escrow it
  sponsors keeps one receipt's rent-exempt minimum for good, and `sweep_rent` returns what the cuts
  free above it. A funded escrow nobody accepts no longer waits on the buyer (`close_unaccepted`),
  but its timeout is its terms: a last deadline a century away is a century's wait, so the policy
  should cap the deadlines it sponsors.
- **The pay link.** `solanaPayUrl` names the escrow's address as the recipient with the mint and
  the amount, and the escrow's address as the reference, so the funding transfer can be found by
  looking up that address. Whatever arrives counts, link or not. A pay link is one-time: the client
  builds it only from the escrow account read off the chain, and refuses unless the escrow is open
  or accepted with its funding not yet observed (`awaitingPayment`). A payment that arrives after
  the end anyway, from a copied address or an old link, is not lost: `recover_late` sends it back to
  the buyer, and anyone may send that.

## The state machine

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | buyer, payer | terms valid; classic SPL Token mint, not wrapped SOL; buyer and seller differ; the address never held an escrow that is still there | open |
| nothing | `create` | seller, payer | the same | accepted, or funded if the deposit account already held the amount (an invoice) |
| open | `accept` | seller | | accepted, or funded if the deposit account holds the amount |
| open | `approve`, 10,000 basis points only | buyer | balance at least the amount | ended, approved |
| open | `withdraw` | buyer | balance at least the amount | ended, withdrawn |
| open | `mark_funded` | nobody | balance at least the amount; not observed yet | open, the funding observed |
| accepted | `mark_funded` | nobody | balance at least the amount; not observed yet | funded |
| accepted, funded | `approve` | buyer | balance at least the amount | ended, approved |
| accepted, funded | `release_by_silence` | nobody | balance at least the amount; clock started; now past start plus silence days | ended, released by silence |
| accepted, funded | `object` | buyer | balance at least the amount; now not past start plus silence days | locked (from accepted, this is the observation of funding) |
| accepted, funded, locked | `agree` | buyer and seller | balance at least the amount | ended, agreed |
| accepted, funded, locked | `arbitrate` | arbiter | an arbiter was named; balance at least the amount | ended, arbitrated |
| accepted, funded | `cancel_buyer` | buyer | balance at least the amount; clock started; a step's deadline still ahead | ended, cancelled by buyer |
| accepted, funded, locked | `cancel_seller` | seller | balance at least the amount | ended, cancelled by seller |
| open, accepted | `close_unfunded` | buyer or seller | balance below the amount | gone: both accounts closed |
| open, accepted | `close_unfunded` | rent payer | balance below the amount; no steps, or now past the last deadline measured from the service time, else from creation | gone: both accounts closed |
| open | `close_unaccepted` | anyone, who makes the buyer's refund address if it is missing | balance at least the amount; the funding observed; now past the last deadline from the later of the service time and the funding, or 30 days after the funding with no steps | ended, never accepted |
| ended | `recover_late` | anyone, who makes the buyer's refund address if it is missing | its deposit account made again by a later payment | ended, unchanged: the late money to the buyer's refund address, that account's rent to the buyer |
| anything but gone | `sweep_rent` | nobody | the escrow account holds more than its rent-exempt minimum | unchanged: the excess to the rent payer |
| ended | anything else | | | refused: `Ended` |

Before the seller accepts, `object`, `release_by_silence`, `agree`, `arbitrate`, `cancel_buyer`,
`cancel_seller` and `approve` with a split are refused with `NotAccepted`. A full `approve`,
`withdraw`, `mark_funded` and, after the timeout, `close_unaccepted` run.

"Ended" is a stored state now. The escrow account stays: its status, its outcome, when it ended and
what each party got are in it for good, and its deposit account is closed. Each ending emits its
own event first (`Approved`, `ReleasedBySilence`, `Agreed`, `Arbitrated`, `CancelledByBuyer`,
`CancelledBySeller`, `Withdrawn`, `NeverAccepted`), then `Ended` with the outcome, every amount and
whether the seller had accepted. `close_unfunded` emits only `Closed`: nothing was dealt, so there
is no receipt. `recover_late` emits `RecoveredLate` and `sweep_rent` emits `RentSwept`; neither is
an ending, and neither changes the receipt. An unresolved lock is an account whose status is still `Locked`, an `Objected` with no
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
the seller never agreed to anything, and a stranger can make one for a single base unit. An invoice
paid in one tap leaves an accepted one. The handoff's rule (Deals and evidence): an index weighs a
deal by who said yes. Both (paid, and accepted or invoiced) counts in full; a one-tap payment with
no acceptance is a real payment but one-sided until the seller reviews the same deal id; a receipt
nobody accepted and nobody paid in full (`withdrawn`, `neverAccepted`) counts for nothing.

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
3. **A step's deadline is a signed offset in seconds from the clock start**, so an offer can say
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
12. **An offer's steps are `{ hours, refundPercent }`**, as the post's `terms` and a market file's
    `suggested` block write them, converted by the client (`stepFromOffer`). Absent means no
    steps.
13. **Anchor 1.2, `cargo build-sbf`, no IDL**, as in the registry: the client and the Rust tests
    both write the bytes by hand.
14. **The clock never starts before the seller accepts** (session 11), now decided by Carlos with
    the funding added (session 12): it starts at the latest of the service time, the observed
    funding and the acceptance. Because a seller who could accept after silence had run out could
    accept and release in one transaction, and an old invoice paid late would release the moment
    the money landed.
15. **`accept` observes funding** (session 11), and **`mark_funded` may run before acceptance**
    (session 12, settled with Carlos): it records the time and nothing else. Session 11 had it wait
    for acceptance so the two could not disagree about the clock start; the clock now takes the
    later of them anyway, and `close_unaccepted` needs a funding time for an escrow nobody accepted.
16. **The buyer's exit before acceptance is its own instruction and outcome, `withdraw`**, not a
    cancellation step, so an index can tell "nobody dealt" from "a deal was cancelled on its terms".
17. **The new fields sit after `bump`** (accepted_at, ended_at, outcome, to_seller, to_buyer), so
    every offset session 8 pinned stays where it was; the status values were renumbered in order
    (open, accepted, funded, locked, ended), since nothing is deployed.
18. **The ending event is `Ended`, and `Closed` is kept for the one case where the account really
    closes**, a never-funded escrow, with its own fields. Because a `Closed` on an account that stays
    open would mislead every index written against it. So `close_unaccepted`, whose receipt stays,
    emits `NeverAccepted` and `Ended`, not `Closed`, despite its name.
19. **`recover_late` closes the re-created deposit account and sends its rent to the buyer**
    (session 12), not to the caller, who could otherwise front-run to take rent the buyer's own
    wallet paid, and not to the escrow's rent payer, who did not pay it. It runs with no tokens
    there too, so an empty re-created account's rent is not locked forever.
20. **An unaccepted escrow's last deadline counts from the later of the service time and the
    observed funding** (session 12): the clock as it would stand without the acceptance. Carlos
    decided "after its last cancellation deadline"; the steps are offsets from a clock start, and
    without an acceptance this is the only one there is.
21. **`sweep_rent` runs on an escrow in any state**, like the registry's on any of its accounts. A
    live escrow's lamports are the rent payer's either way: `close_unfunded` returns them all, and a
    receipt keeps only the minimum.
22. **New names are appended** (session 12): the outcome `NeverAccepted` as 7, the errors `NotEnded`,
    `NothingToSweep`, `FundingNotObserved` and `BeforeTimeout` after the old ones, so every earlier
    byte and code keeps its value. The account's size and every offset are unchanged.
23. **"Open" for a pay link means open or accepted, with the funding not yet observed** (session 12,
    the client's rule). Status `open` alone would have refused the invoice, which is accepted from
    creation and still waiting for its money.

## What this does not do

No devnet, no mainnet, no Kora. No paid review has happened, and `docs/handoff.md`'s "Before
mainnet" list still stands in full. Whether the wallets people use accept a program-derived address as a Solana Pay recipient has not
been tried on a phone; if one does not, the app sends to the deposit address directly, which the
client also gives. Tokens of another mint sent to an escrow's address are not recovered: its
associated token account for that mint is a different address, and nothing here signs for it. SOL
sent to an escrow's address goes to the rent payer by `sweep_rent`, not back to whoever sent it.
Each is in "Open" in `docs/changes.md`.

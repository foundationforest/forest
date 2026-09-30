# escrow, v2

The second version of the sealed escrow program, and its client. v1 (`../program`, `../client`)
stays as it is, deployed at its own address; people choose which to use, and each escrow follows
the program it was opened in. New deals are meant to use v2.

**Nothing here is shipped.** It runs on devnet (`devnet/devnet.json`) and under LiteSVM. Nothing
is on mainnet.

## What changed from v1

Three things, and nothing else.

1. **An objection.** Either party may object, once per escrow, at any time before the timer is
   due. It moves no money. After it the timer never runs: the money moves only by the parties
   agreeing (a release or a split) or by the arbiter, if one was named at creation. The receipt
   records which side objected and when, and `Objected` is emitted.
2. **The receipt says when the money was there.** `funded_at` is the mark's time, or, if nobody
   marked it, the ending's: the first time the program saw the amount. So every receipt has a
   funding time, the one tap and the invoice paid in one tap included. `ended_at` is unchanged.
3. **Rent above the minimum goes back to whoever fronted it.** `create` records its payer.
   `sweep_rent` sends what the escrow account holds above its rent-exempt minimum (what Solana's
   rent cuts free, and any SOL sent there) to that payer; anyone may send it, and the receipt stays.
   The deposit account's rent at every ending, and both rents at `close_unfunded`, still go to the
   creator.

Everything else is v1's: any classic SPL token, release or split by both, the optional arbiter and
timer fixed at creation, anyone may fund, `mark_funded`, `close_unfunded`, `recover_late`, the
addresses, the standard-account rule for payouts. The account keeps v1's 256 bytes at the same
offsets and appends 41; the version byte is 2; v1's 25 error codes keep their numbers and four
follow them. The client drops the Solana Pay link: pay links are the app's.

| | |
|---|---|
| `program/` | the program. Anchor 1.2, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 64 LiteSVM tests with the clock moved by hand and the wire format written out a second time: `escrow.rs` (23), `adversarial.rs` (31), `one_tap.rs` (3) and `objection.rs` (7). |
| `client/` | TypeScript, browser and Node: a builder for every instruction, the terms from a post's optional terms block, the check a person runs before working or paying, the timer and until when an objection lands, the account and the events decoded. |
| `devnet/` | `deploy.sh`, which builds and deploys v2 at its own devnet address, and `devnet.json`, what it and `client/scripts/devnet.ts` did there. |
| `security-checklist.md` | the safe-solana-builder checklist for v2. |

## Running it

```
cd escrow/v2/program && cargo build-sbf --arch v3                 # Solana CLI 4.2.2 or later
cd escrow/v2/program/tests-litesvm && cargo test -- --nocapture
cd escrow/v2/client  && npm ci && npm run check && npm test       # no chain needed
FOREST_DEVNET_SEED=<phrase> escrow/v2/devnet/deploy.sh            # devnet only
cd escrow/v2/client  && FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts
```

## The state table

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | the buyer or the seller as creator, and whoever fronts the rent | as v1: the address is `["escrow", creator, id]`; buyer and seller differ; no zero keys; neither party the escrow or its deposit address; amount above zero; a timer, if any, of at least one day; a classic mint, not wrapped SOL | open, the creator recorded as rent recipient, the rent's payer recorded as payer |
| open | `mark_funded` | nobody | the deposit account holds at least the amount | funded, `funded_at` = now |
| open, funded | `object` | the buyer or the seller | nobody objected yet; the timer, if it runs, not yet due (`now < funded_at + days × 86,400`, read only once the funding is marked) | unchanged, the objection and its time recorded |
| open, funded | `release_to_seller` | the buyer | the deposit account holds at least the amount | ended: the whole balance to the seller's standard account |
| open, funded | `release_to_buyer` | the seller | the same | ended: the whole balance to the buyer's standard account |
| open, funded | `split(seller_bps)` | the buyer and the seller | the same; `seller_bps` at most 10,000 | ended: `⌊balance × seller_bps / 10,000⌋` to the seller, the rest to the buyer |
| open, funded | `arbitrate(seller_bps)` | the arbiter | an arbiter was named at creation; the same | ended: the same split |
| funded | `timer_release` | nobody | a timer was set at creation; **nobody objected**; now is at least `funded_at` + days × 86,400 | ended: the whole balance to the side the timer names |
| open, funded | `close_unfunded` | the buyer or the seller | the deposit account holds less than the amount | gone: whatever it held to the buyer, both rents to the creator |
| ended | `recover_late` | anyone, who makes the buyer's standard account if it is missing | its deposit account made again by a later payment | ended, unchanged: the late money to the buyer's standard account, that account's rent to the buyer |
| anything but gone | `sweep_rent` | nobody | the escrow account holds more than its rent-exempt minimum | unchanged: the excess to **the payer** |
| ended | anything else | | | refused: `Ended` |

Every ending that runs from open (nobody marked the funding) writes its own time into `funded_at`
before it writes `ended_at`; an ending from funded leaves the mark's time. The objection is not a
status: an objected escrow is open or funded like any other, and ends by any way out but the
timer. `timer_due` is the one deadline: before it only `object` can land, from it on only
`timer_release`, so the two never race. A timer whose funding nobody marked is never due, so an
objection to it is never too late; an escrow with no timer takes an objection too, which then
changes nothing but the receipt.

The seven events are v1's six and `Objected`: `Created` (now with the payer), `Funded`, `Ended`
(now with `funded_at`), `Closed`, `RecoveredLate`, `RentSwept` (now with the payer), `Objected`
(the side and the time).

## What is sealed

As v1's README says, with these differences:

- **The state.** One account per escrow, 297 bytes after the discriminator: v1's 256, field for
  field and offset for offset (`version` now 2), then `payer` (256..288), `objection` (288: none 0,
  the buyer 1, the seller 2) and `objected_at` (289..297, 0 unless objected). Written out three
  times: `program/src/state.rs`, `program/tests-litesvm/src/lib.rs`, `client/src/program.ts`. The
  objection has its own byte: a zero clock never reads as "nobody objected".
- **The instructions.** Eleven: v1's ten, whose bytes and account lists are unchanged but for
  `sweep_rent`, whose second account is now the payer; and `object` (escrow, the party signing; no
  arguments).
- **Where rent goes back.** The deposit account's at every ending and both at `close_unfunded`: to
  the creator. Above the escrow account's minimum, by `sweep_rent`: to the payer. Each recorded at
  creation; no one who sends an instruction can name another.
- **The addresses** are v1's seeds under v2's program id, so a v1 escrow and a v2 escrow never
  share an address.

## What one escrow costs

Measured under LiteSVM, one run with the harness's keys, legacy transactions with a compute-budget
instruction (`what_each_way_out_costs` and `one_tap.rs`). v1's README gives ranges over twelve runs;
the address derivations make each figure vary by up to about 20,000 units with the keys.

| | Compute units | Bytes on the wire |
|---|---|---|
| `create`, no options | 31,932 | 595 |
| `create`, an arbiter and a timer | 41,055 | 630 |
| `mark_funded` | 4,389 | 283 |
| `object` | 4,049 | 347 |
| `release_to_seller` | 13,104 | 447 |
| `release_to_buyer` | 11,821 | 479 |
| `split` | 17,416 | 579 |
| `arbitrate` | 17,285 | 514 |
| `timer_release`, to the seller / the buyer | 13,130 / 11,630 | 382 |
| `close_unfunded`, nothing paid | 9,023 | 479 |
| `recover_late`, making the buyer's account | 29,709 | 578 |
| `sweep_rent` | 4,520 | 251 |
| one tap: the deposit address made, `create`, a transfer in, `release_to_seller` | 42,984 | 701 |
| the same, the seller's account made first | 55,009 | 743 |
| an invoice paid in one tap | 14,897 | 526 |

Rent, at 5,080 lamports a byte (today's mainnet rate) and 696 (where the cuts end), SOL at $100.24:

| Account | Bytes | Today | After the cuts | Returned |
|---|---|---|---|---|
| escrow | 305 | 2,199,640 lamports, $0.22 | 301,368 lamports, $0.030 | whole to the creator only if never funded; above the minimum to the payer by `sweep_rent` |
| deposit account | 165 | 1,488,440 lamports, $0.15 | 203,928 lamports, $0.020 | to the creator at every ending |

A receipt is 41 bytes longer than v1's: 208,280 lamports more today, 28,536 after the cuts.

## What the app decides

As v1's README says, with these differences:

- **Objecting.** The program takes an objection from either party until the timer is due and
  records nothing about why. When to offer the button, and what to say, is the app's. `canObject`
  says whether one would land now; the chain's clock decides, so an objection sent in the last
  seconds before the timer is due may land after them and be refused.
- **What a timer means now.** Either side can turn it off before it is due. It pays the side it
  names only if the other side stays silent. An app shows the timer as that.
- **The funding time.** `mark_funded` is still needed only by the timer. A receipt nobody marked
  says the money was there when it ended.
- **Pay links.** Not in the client. The deposit address is `vaultAddress(escrow, mint)`, a
  Solana Pay recipient is the escrow's own address, and an invoice's escrow is
  `escrowAddress(seller, id)`. Before paying an invoice in one tap, the app reads the deposit
  address's balance: every way out pays the whole balance.
- **Who fronts the rent.** Whoever signs `create` as payer is recorded and gets the sweep. A fee
  payer that fronts the rent and charges the person for it gets back what the rent cuts free
  later; the deposit account's rent still comes back to the creator.

## The upgrade authority

As for v1: on the day it deploys to mainnet, `solana program set-upgrade-authority <PROGRAM_ID>
--final`, and `solana program show` says "Authority: none". The program id for local work is
`FoRE2EscrowV2objectsTimerFundedAtPayer222222`; no keypair for it exists. Mainnet gets a fresh one.

## Chosen, not decided

Where the request was silent, the option that adds no rule and no text a person reads was taken.
Each is reversible until v2 is sealed on mainnet.

1. **One objection per escrow**, not one per side. After the first, the timer is off, so a second
   would change nothing but the record; it is refused (`AlreadyObjected`).
2. **"Before the timer fires" is before it is due,** not before someone sends `timer_release`. The
   same deadline then gates both, so they never race; the side a timer favours is sure of it from
   the due second on.
3. **An objection needs no timer and no money.** Refusing it without a timer, or before the money
   arrives, would add rules; it is recorded either way. A buyer can object to an invoice's timer
   before paying it.
4. **`close_unfunded` still runs after an objection.** It is not the timer, and a part payment
   would otherwise have no way out.
5. **The receipt does not say whether the funding was marked.** "Whether or not anyone marked it"
   is read as: the funding time is recorded either way. The `Funded` event exists only if it was
   marked.
6. **`Ended` carries `funded_at`, and `RentSwept` the payer,** so an index reads both from the log
   without reading the account.
7. **Only the sweep goes to the payer.** The deposit account's rent and a close's rents stay with
   the creator, as "everything else unchanged" says.
8. **The layout appends,** so v1's offsets hold in v2's first 256 bytes.
9. **The v2 devnet program id** is derived from the devnet phrase under a new label,
   `escrow-v2-program`, with the recipe in `devnet/keys.sh`; the deploy key is v1's.

## What this does not do

Nothing on mainnet. The Trident fuzzer and the local-validator test were not carried over; the
devnet run is the client's only test against a real runtime. `.github/workflows/checks.yml` does
not build or test v2 yet. The fee payer's configuration (`feepayer/`) allows v1's program id, not
v2's, and the index reads v1's escrow only. `security-checklist.md` lists every known limit.

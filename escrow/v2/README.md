# escrow, v2

The second version of the sealed escrow program, and its client. v1 (`../program`, `../client`)
stays as it is, deployed at its own address; people choose which to use, and each escrow follows
the program it was opened in. New deals are meant to use v2.

**Nothing here is shipped.** It runs on devnet (`devnet/devnet.json`) and under LiteSVM. Nothing
is on mainnet.

## What changed from v1

Four things, and nothing else.

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
4. **Both token programs.** A mint of the classic SPL Token program or of Token-2022, whichever
   owns it named as the token program in every instruction. Refused at `create`: wrapped SOL of
   either program, and a Token-2022 mint with a transfer fee (any rate, zero included: the rate
   can be raised later). Every payment out is a `transfer_checked`, carrying the mint and its
   decimals, so every way out now names the mint. A transfer hook's accounts, which the client
   resolves, follow the instruction's own and are forwarded to every transfer, so an escrow keeps
   working if an issuer switches a hook on after it is funded; they reach the token program as
   plain accounts, never signing. The deposit account is made under the mint's token program by
   the associated token program, with whatever account extensions the mint requires, and each
   party is paid only at its standard account under that program. What the issuer can do with
   its dollar is listed below ("What a person accepts by choosing a dollar").

Everything else is v1's: release or split by both, the optional arbiter and timer fixed at
creation, anyone may fund, `mark_funded`, `close_unfunded`, `recover_late`, the addresses, the
standard-account rule for payouts. The account keeps v1's 256 bytes at the same offsets and
appends 41; the version byte is 2; v1's 25 error codes keep their numbers and five follow them.
The client drops the Solana Pay link: pay links are the app's.

## What a person accepts by choosing a dollar

Whoever issues a dollar keeps powers over it that the escrow cannot take away or route around.
Choosing the dollar a deal is in means accepting them. Which a dollar has is on its mint, for
anyone to read; Open USD (`ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB`) has every one below, and
USDC has the first.

- **Freeze.** The issuer can freeze any account of its dollar. A frozen deposit account stops
  every way out; a party's frozen account stops every payment to that party, though the other
  side can still give everything back. Nothing moves until the issuer thaws it.
- **Pause.** The issuer can stop every transfer of its dollar at once: nothing is paid in and no
  escrow ends, until it resumes them. An objection and the mark still land; they move nothing.
- **Take the money.** A permanent delegate can move or burn any amount from any account of its
  dollar, a deposit account included, with no party signing. An escrow left holding less than
  its amount can no longer be released, split or paid by the timer; it ends by `close_unfunded`,
  what is left going back to the buyer, or once the amount is back.
- **A check on every transfer.** The issuer can name a program (a transfer hook) that every
  transfer of its dollar calls, and change it at any time. It can refuse any transfer, a
  deposit's or a payout's, and it can ask for accounts the app must pass, which the client finds.
  It is never handed a signature through the escrow. Open USD's names no program today.
- **New accounts start frozen.** The issuer can make every new account of its dollar start
  frozen, a new deposit account included: then nothing can be paid into a new escrow until the
  issuer thaws its deposit account.
- **Close the dollar.** When nobody holds any of it, the issuer can close its mint. An escrow in
  that dollar that never held money then cannot be closed, and its rent stays.
- **Rename it.** The issuer can change its dollar's name, symbol and picture. The escrow reads
  none of them; an app knows a dollar by its mint's address.

Confidential transfers, which Open USD allows, never reach a deposit account: turning them on
needs a signature the escrow never gives, so a confidential payment to one is refused and nothing
is lost; money arrives by plain transfer only.

Refused outright, at `create`: a transfer fee, which would take part of every payment in and out
while every way out pays the whole balance, and wrapped SOL, which a plain SOL transfer to its
deposit account would not fund.

| | |
|---|---|
| `program/` | the program. Anchor 1.2, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 86 LiteSVM tests with the clock moved by hand and the wire format written out a second time: `escrow.rs` (23), `adversarial.rs` (31), `one_tap.rs` (3) and `objection.rs` (7) on a classic mint; `token_2022.rs` (22) on a Token-2022 mint made with Open USD's extensions, its hook naming no program and naming a test hook, and the issuer's powers used. |
| `client/` | TypeScript, browser and Node: a builder for every instruction under either token program, the mint read (`tokenOf`), a transfer hook's accounts resolved by `@solana/spl-token`'s resolver (`hookAccounts`), the terms from a post's optional terms block, the check a person runs before working or paying, the timer and until when an objection lands, the account and the events decoded. |
| `devnet/` | `deploy.sh`, which builds and deploys v2 at its own devnet address, and `devnet.json`, what it and `client/scripts/devnet.ts` did there, the first v2 deploy's record kept under `earlier`. |
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
| nothing | `create` | the buyer or the seller as creator, and whoever fronts the rent | as v1: the address is `["escrow", creator, id]`; buyer and seller differ; no zero keys; neither party the escrow or its deposit address; amount above zero; a timer, if any, of at least one day; a mint of either token program, owned by the token program named, not wrapped SOL, no transfer fee | open, the creator recorded as rent recipient, the rent's payer recorded as payer |
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
- **The instructions.** Eleven: v1's ten, whose bytes are unchanged; and `object` (escrow, the
  party signing; no arguments). Account lists: `sweep_rent`'s second account is now the payer;
  every way out (`release_to_seller`, `release_to_buyer`, `split`, `arbitrate`, `timer_release`,
  `close_unfunded`) names the mint right after the deposit account; the token program slot, in
  every instruction that has one, takes either program; and every instruction that pays out
  (those six and `recover_late`) forwards any accounts after its own to each transfer, for a
  transfer hook, without a signature.
- **Where rent goes back.** The deposit account's at every ending and both at `close_unfunded`: to
  the creator. Above the escrow account's minimum, by `sweep_rent`: to the payer. Each recorded at
  creation; no one who sends an instruction can name another.
- **The addresses** are v1's seeds under v2's program id, so a v1 escrow and a v2 escrow never
  share an address. The deposit account and each party's standard account are associated token
  accounts under the mint's token program, so a Token-2022 mint's differ from what the classic
  program's would be.
- **Refused mints.** Wrapped SOL of either program, by address; a Token-2022 mint with the
  transfer fee extension or the confidential transfer fee extension, by its extensions
  (`TransferFee`, error 6029). A mint's extensions are fixed when it is made, so `create` checks
  once.

## What one escrow costs

Measured under LiteSVM, one run with the harness's keys, legacy transactions with a compute-budget
instruction (`what_each_way_out_costs`, `one_tap.rs`, and `token_2022.rs`'s
`what_each_way_out_costs_under_token_2022` and one taps). The address derivations make each figure
vary by up to about 20,000 units with the keys. Taking both token programs added about 800 to
2,800 units and 33 bytes (the mint) to each classic way out.

| Classic mint | Compute units | Bytes on the wire |
|---|---|---|
| `create`, no options | 33,631 | 595 |
| `create`, an arbiter and a timer | 32,256 | 630 |
| `mark_funded` | 4,457 | 283 |
| `object` | 4,049 | 347 |
| `release_to_seller` | 15,633 | 480 |
| `release_to_buyer` | 12,850 | 512 |
| `split` | 20,214 | 612 |
| `arbitrate` | 20,065 | 547 |
| `timer_release`, to the seller / the buyer | 15,634 / 12,634 | 415 |
| `close_unfunded`, nothing paid | 9,810 | 512 |
| `recover_late`, making the buyer's account | 30,206 | 578 |
| `sweep_rent` | 4,520 | 251 |
| one tap: the deposit address made, `create`, a transfer in, `release_to_seller` | 48,712 | 702 |
| the same, the seller's account made first | 63,737 | 744 |
| an invoice paid in one tap | 15,926 | 559 |

| Token-2022, Open USD's extensions | Compute units | Bytes on the wire |
|---|---|---|
| `create`, its hook naming no program | 42,095 | 595 |
| `release_to_seller`, no hook program | 18,328 | 480 |
| `split`, no hook program | 26,599 | 612 |
| one tap, no hook program | 64,979 | 704 |
| an invoice paid in one tap, no hook program | 26,687 | 635 |
| `release_to_seller`, a hook with two accounts | 37,455 | 612 |
| `split`, the same hook | 77,199 | 780 |
| one tap, the same hook | 101,111 | 872 |
| an invoice paid in one tap, the same hook | 73,318 | 803 |

The hook's figures include the test hook's own cost, a builtin charging 500 units a call; a real
hook's program costs what it costs. Each hook account adds 32 bytes to a transaction once, however
many transfers need it.

Rent, at 5,080 lamports a byte (today's mainnet rate) and 696 (where the cuts end), SOL at $100.24:

| Account | Bytes | Today | After the cuts | Returned |
|---|---|---|---|---|
| escrow | 305 | 2,199,640 lamports, $0.22 | 301,368 lamports, $0.030 | whole to the creator only if never funded; above the minimum to the payer by `sweep_rent` |
| deposit account, classic mint | 165 | 1,488,440 lamports, $0.15 | 203,928 lamports, $0.020 | to the creator at every ending |
| deposit account, Open USD's extensions | 179 | 1,559,560 lamports, $0.16 | 213,672 lamports, $0.021 | to the creator at every ending |

A receipt is 41 bytes longer than v1's: 208,280 lamports more today, 28,536 after the cuts. A
Token-2022 deposit account's size follows its mint: 179 bytes for Open USD's (the base account, its
type, and the immutable-owner, hook and pause account extensions).

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
- **Pay links.** Not in the client. The deposit address is `vaultAddress(escrow, mint,
  tokenProgram)`, a Solana Pay recipient is the escrow's own address, and an invoice's escrow is
  `escrowAddress(seller, id)`. Before paying an invoice in one tap, the app reads the deposit
  address's balance: every way out pays the whole balance.
- **Which dollars.** The program takes any mint of either token program but those it refuses. Which
  dollars an app offers, and what it says about an issuer's powers, are the app's; the list above
  is what a person accepts by choosing one. An app knows a dollar by its mint's address, never by
  its name.
- **A hook's accounts.** For a mint whose transfer hook names a program, the app resolves the
  hook's accounts before each transaction (`hookAccounts`), since an issuer can name or change the
  program at any time, and passes them to each way out and to the wallet's own payment in. For a
  deposit address the same transaction makes, it passes that address as planned: the resolver
  reads it as a fresh account of the escrow. A wallet paying a Token-2022 dollar in must send a
  `transfer_checked`: Token-2022 refuses a plain transfer from an account with a hook extension,
  as Open USD's accounts have.
- **Who fronts the rent.** Whoever signs `create` as payer is recorded and gets the sweep. A fee
  payer that fronts the rent and charges the person for it keeps what the rent cuts free later, by
  decision, and says so plainly to the people it serves; the deposit account's rent still comes
  back to the creator.

## The upgrade authority

As for v1: on the day it deploys to mainnet, `solana program set-upgrade-authority <PROGRAM_ID>
--final`, and `solana program show` says "Authority: none". The program id for local work is
`FoRE2EscrowV2objectsTimerFundedAtPayer222222`; no keypair for it exists. Mainnet gets a fresh one.

On devnet, v2 as it is here runs at `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (label
`escrow-v2-program-2`). The first v2 deploy, classic tokens only, stays at
`B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7`, never upgraded; its ways out lack the mint, so
this client does not build them. Both keep their upgrade authority on the devnet deploy key.

## Decided

Carlos's answers, 2026-09-30, to what the request left open.

1. **One objection per escrow**, not one per side. After the first, the timer is off, so a second
   would change nothing but the record; it is refused (`AlreadyObjected`).
2. **"Before the timer fires" is before it is due,** not before someone sends `timer_release`. The
   same deadline then gates both, so they never race; the side a timer favours is sure of it from
   the due second on.
3. **An objection needs no timer and no money.** It is recorded either way. A buyer can object to
   an invoice's timer before paying it.
4. **`close_unfunded` still runs after an objection.** It is not the timer, and a part payment
   would otherwise have no way out.
5. **The sweep goes to the payer, a fee payer included.** A fee payer that fronted the rent keeps
   what Solana's rent cuts free, and says so plainly to people; its own description changes to
   match, in the services' repo.
6. **Both token programs, before sealing.** Classic and Token-2022 mints; a transfer fee refused
   at `create`; `transfer_checked` everywhere; a hook's accounts forwarded on every transfer, the
   client resolving them; deposit accounts made under the mint's own token program with the
   extensions it requires; the issuer's powers the issuer's, listed above. Redeployed on devnet at
   a new address, the earlier ids untouched.

## Chosen, not decided

Where the request was silent, the option that adds no rule and no text a person reads was taken.
Each is reversible until v2 is sealed on mainnet.

1. **The receipt does not say whether the funding was marked.** "Whether or not anyone marked it"
   is read as: the funding time is recorded either way. The `Funded` event exists only if it was
   marked.
2. **`Ended` carries `funded_at`, and `RentSwept` the payer,** so an index reads both from the log
   without reading the account.
3. **Only the sweep goes to the payer.** The deposit account's rent and a close's rents stay with
   the creator, as "everything else unchanged" says.
4. **The layout appends,** so v1's offsets hold in v2's first 256 bytes.
5. **The v2 devnet program id** is derived from the devnet phrase under a new label,
   `escrow-v2-program`, with the recipe in `devnet/keys.sh`; the deploy key is v1's. The second
   deploy, both token programs, uses `escrow-v2-program-2`.

Chosen when v2 took both token programs (2026-09-30):

6. **The token program is not stored.** The mint's owner never changes, so every instruction names
   it and the program checks it against the mint; the layout stays as it was.
7. **The mint goes right after the deposit account** in every way out, as `transfer_checked`
   orders them.
8. **Hook accounts are unchecked and never signing.** The program forwards whatever follows its own
   accounts to every transfer, writable as it came and never as a signer, and Token-2022 picks the
   hook's by address from its list. So a hook never receives any signature but the escrow's, and
   the escrow's only as a plain account (Token-2022 passes it on that way).
9. **The transfer-fee refusal covers the confidential transfer fee too,** which only exists beside
   a transfer fee; and Token-2022's wrapped SOL is refused as the classic one is.
10. **Only the transfer fee is refused.** Every other extension (a permanent delegate, a freeze
    authority, pause, a hook, confidential transfers, a close authority, and those Open USD does not
    have) is accepted, as the request asked for the issuer's powers; see Known limits in
    `security-checklist.md` for the ones Open USD does not have.

## What this does not do

Nothing on mainnet. The Trident fuzzer and the local-validator test were not carried over; the
devnet run is the client's only test against a real runtime, and on devnet no dollar names a hook
program: a hook's program runs only under LiteSVM, as a builtin. Left to later sessions:
`.github/workflows/checks.yml` builds v2 and runs its LiteSVM tests but not its client's tests;
the fee payer's configuration (`feepayer/`) allows v1's program id, not v2's, nor Token-2022; and
the index reads v1's escrow only. `security-checklist.md` lists every known limit.

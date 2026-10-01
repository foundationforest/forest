# escrow

Devnet only: v1 runs on devnet at `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR`
([record](../devnet/devnet.json)), v2 at its own address ([v2](v2/README.md)). Nothing is on
mainnet.

Up: [the repo](../README.md). Down: [v2](v2/README.md), the
[security checklist](security-checklist.md).

The escrow holds an amount of one token between two keys, a buyer and a seller, and lets it out only
when the two sides agree. It is a sealed Solana program in two versions, each at its own address,
and each escrow follows the program it was opened in:

- **v1**, here (`program/`, `client/`): classic SPL tokens.
- **[v2](v2/README.md)**: v1 plus an objection, the funding time on every receipt, swept rent back to
  whoever fronted it, and Token-2022 dollars. New deals are meant to use v2.

This README is the shape both share, and v1's details.

## How it works

- **Opening.** Either party opens an escrow and signs, naming both keys, the token and the amount.
  One the seller opens is an invoice. Its address is `["escrow", creator, id]`, so nobody can open an
  escrow at an address another key will use.
- **Funding.** Money arrives by a plain transfer, from anywhere, to the escrow's deposit address: its
  associated token account for the mint, so a wallet sending "to the escrow's address" lands there.
  The escrow is funded while that account holds at least the amount: every way out checks the live
  balance, and nothing needs to mark it first.
- **Three ways out.** The buyer releases everything to the seller; the seller releases everything
  to the buyer; or both sign a split. Receiving in full never needs the receiver's signature, so each
  side alone can give, and only together can they divide. Every way out pays out the whole balance,
  and pays each side only at its standard token account for the mint.
- **Two options, off unless the creator sets them at creation.** An arbiter, any key (a party
  included), that may sign any split. A timer that, a number of days after the funding is marked
  (`mark_funded`), lets anyone send everything to the side it names. There is no other clock.
- **After the end.** The escrow account stays at its address as a permanent receipt. Money sent to
  it later goes back to the buyer, and rent above the minimum goes back to the creator; anyone may
  send either. An escrow that never held the amount is closed instead, by either party, at any time.
- **Nothing else.** No admin, no config account, no pause, no fee. Cancelling and refunding are the
  seller releasing to the buyer, or a split.

## What it promises

- Money leaves a funded escrow only by: a release from the side giving it up, a split both sign, the
  arbiter named at creation, or the timer set at creation once due.
- Every way out pays the whole balance, to the parties' standard token accounts and nowhere else.
- A receipt, once its escrow has ended, never closes and never changes; its address never holds a
  second deal.
- Every rent refund goes to the creator, whoever fronted the rent; only a deposit account that a late
  payment made again returns its rent to the buyer.
- Every state change is emitted, so an index can read outcomes from the log: `Created`, `Funded`,
  `Ended`, `Closed`, `RecoveredLate`, `RentSwept`.

## What it trusts

- The SPL Token and associated token programs, and Anchor 1.2.
- **The token's issuer.** A mint's freeze authority (USDC has one) can freeze the deposit account,
  which stops every way out, or a party's account, which stops every payment to that party.
- **The app,** to show a person every option they did not agree to before they work or pay: the
  program runs whatever options the creator chose (`optionsNotAgreed`, below).

## The state table

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | the buyer or the seller as creator, and whoever fronts the rent | address `["escrow", creator, id]`; buyer and seller differ; no zero keys; neither party the escrow's own address or its deposit address; amount above zero; a timer, if any, of at least one day; a classic SPL Token mint, not wrapped SOL; no escrow already at the address | open; the creator recorded as rent recipient |
| open | `mark_funded` | nobody | the deposit account holds at least the amount | funded, `funded_at` = now |
| open, funded | `release_to_seller` | the buyer | the deposit account holds at least the amount | ended: the whole balance to the seller |
| open, funded | `release_to_buyer` | the seller | the same | ended: the whole balance to the buyer |
| open, funded | `split(seller_bps)` | the buyer and the seller | the same; `seller_bps` ≤ 10,000 | ended: `⌊balance × seller_bps / 10,000⌋` to the seller, the rest to the buyer |
| open, funded | `arbitrate(seller_bps)` | the arbiter | an arbiter was named; the same | ended: the same split |
| funded | `timer_release` | nobody | a timer was set; now ≥ `funded_at` + days × 86,400 | ended: the whole balance to the side the timer names |
| open, funded | `close_unfunded` | the buyer or the seller | the deposit account holds less than the amount | gone: what it held to the buyer, both accounts closed, both rents to the creator |
| ended | `recover_late` | anyone; the sender makes the buyer's standard account if missing | a later payment made the deposit account again | unchanged: the late money to the buyer, that account's rent to the buyer |
| anything but gone | `sweep_rent` | nobody | the escrow account holds more than its rent-exempt minimum | unchanged: the excess to the creator |
| ended | anything else | | | refused: `Ended` |

"Funded" in the Needs column is the live balance, never the status. Only this program moves money
out of a deposit account, and only by ending the escrow, so once it holds the amount it holds it
until the end, and `close_unfunded` can never run on an escrow that was funded. Every ending closes
the deposit account, its rent to the creator, and writes into the receipt how it ended
(`ReleasedToSeller`, `ReleasedToBuyer`, `Split`, `Arbitrated`, `TimerReleased`), when, the balance,
and what each side got.

## Use it

The client (`client/src/`) builds every instruction and reads every account and event; it talks to
no network of its own.

| Function | Gives |
|---|---|
| `termsFor(postTerms, deal)`, `optionsFromPost(postTerms)` | An escrow's terms from an offer's optional `terms` block ([offer schema](../records/schemas/offer.json)) and the deal |
| `createIx`, `invoice`, `createAndFund`, `payInOneTap`, `payInvoiceInOneTap` | Opening; opening and funding; paying and releasing in one transaction |
| `markFundedIx`, `releaseToSellerIx`, `releaseToBuyerIx`, `splitIx`, `arbitrateIx`, `timerReleaseIx`, `closeUnfundedIx`, `recoverLateIx`, `sweepRentIx` | Every other instruction |
| `optionsNotAgreed`, `assertOptionsAgreed` | Every arbiter and timer a person did not set, whose key an arbiter is, and which side a timer favours |
| `timerDueAt`, `timerDue` | When the timer is due |
| `escrowAddress`, `vaultAddress`, `depositAddress`, `makeDepositAddressIx`, `makeStandardAccountIx`, `makeRefundAddressIx` | Addresses, and the accounts a payment needs made first |
| `solanaPayUrl`, `awaitingPayment` | A pay link for what is still missing, and only while it is missing |
| `decodeEscrow`, `decodeEvents` | The receipt and the events. `decodeEvents` reads only events this program wrote, by the runtime's own invoke lines |

What the app decides, because the program does not know:

- **Check the options before anyone works or pays.** Read the escrow off the chain and run
  `optionsNotAgreed` against what the person set or accepted; before paying an invoice, also check
  that it names the person's own key as buyer.
- **The amount** is the app multiplying per hour, per day or per job before creation: one escrow per
  payment. **The id** is any 64-bit number the creator has not used (`randomId()`).
- **Make the deposit address first** when paying in the same transaction as `create`
  (`createAndFund` and the one-tap builders do), so a relayer that checks every transfer's
  destination before it signs finds it made. Make the seller's standard account first if the seller
  may not hold the token yet.
- **Mark the funding** only if there is a timer: it counts from the mark, and only the side it
  favours has a reason to send it.

```
cd escrow/program   && cargo build-sbf --arch v3              # Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test                 # the rules, the attacks, the one tap
cd escrow/program && cargo build-sbf --arch v0 && cd trident-tests \
  && TRIDENT_WITH_EXIT_CODE=1 cargo run --release --bin fuzz_escrow   # exit 99 if an invariant broke
cd escrow/client    && npm ci && npm test                     # no chain needed
cd escrow/client    && npm run test:validator                 # starts solana-test-validator itself
cd escrow/client    && npm run test:devnet                    # read-only, against devnet/devnet.json
```

The LiteSVM tests move the clock by hand and check the wire format against a second copy written in
`program/tests-litesvm/src/lib.rs`. The fuzzer sends random flows against a model of every escrow and
checks fourteen invariants after every step; `FOREST_FUZZ_ITERATIONS` sets its size.

## What one escrow costs

Bytes on the wire, of Solana's 1,232: `create` 595 (630 with both options), `release_to_seller` 447,
`split` 579, one tap (deposit address, `create`, transfer, release) 701, an invoice paid in one tap
526. Compute is 0.3 to 6 percent of the 1,400,000 limit per transaction, measured under LiteSVM on an
SBPF v0 build; devnet runs v3, which differs slightly.

Rent, at today's 5,080 lamports a byte, comes back to the creator:

| Account | Bytes | Rent | Comes back |
|---|---|---|---|
| escrow | 264 | 1,991,360 lamports | whole only if it never held the amount; otherwise the receipt keeps its minimum, and `sweep_rent` returns what Solana's rent cuts free above it |
| deposit account | 165 | 1,488,440 lamports | at every ending |

## What is sealed

None of this can change after deploy; a v2 is a new program at a new address.

- **The account.** 256 bytes after the discriminator, laid out in `program/src/state.rs` (and written
  again in `program/tests-litesvm/src/lib.rs` and `client/src/program.ts`): version, id, buyer,
  seller, arbiter, mint, deposit account, rent recipient (the creator), amount, creator, timer days,
  timer side, created, funded, status, bump, ended, outcome, what the seller got, what the buyer got.
  `version` is 1. The zero key means no arbiter; zero days, no timer; a zero time, not marked or not
  ended.
- **The addresses.** The escrow at `["escrow", creator, id]`; the deposit account its associated
  token account for the mint; each party paid only at its own associated token account, checked by
  address alone, so handing that account to another key blocks no way out.
- **The rules,** as the table says, and the order of checks in each handler, which decides the error
  a refused instruction returns. Every handler that needs a live escrow checks that first, as an
  allowlist of the live states (open, funded).
- **The instructions and events.** Ten instructions and six events, their bytes and account lists.
  Each way out names only the accounts it pays.
- **Classic tokens only.** A Token-2022 mint is refused (the mint must be owned by the classic token
  program), and so is wrapped SOL, by address.

On mainnet the program is sealed the day it deploys:

```
solana program deploy --program-id <program-keypair.json> target/deploy/forest_escrow.so
solana program set-upgrade-authority <PROGRAM_ID> --final
solana program show <PROGRAM_ID>        # Authority: none
```

The source's program id, `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT`, is for local work; no
keypair for it exists. Each deploy uses its own.

## Limits

The [security checklist](security-checklist.md) lists every known limit; the ones an app meets:

- **Frozen accounts.** A frozen deposit account stops every way out; a frozen party account stops
  every payment to that party. Nothing moves until the issuer thaws it.
- **Options nobody checked.** A one-day timer to the creator's own side runs if the other side never
  read the escrow.
- **A deposit address belongs to a creator and an id, not a buyer.** Money sent to it before an
  escrow exists there, or after a close, joins whatever deal next holds that id.
- **A party's standard account must exist to be paid;** whoever sends the way out makes it first.
- **`recover_late` checks who holds the buyer's standard account,** so a buyer who handed it away
  blocks only its own late money.
- **SOL sent to an escrow's address** goes to the creator by `sweep_rent`. **Tokens of another mint**
  sent there are lost to everyone.
- **Refunds arrive in SOL,** in a wallet that may hold none otherwise.
- **A one-sided receipt is cheap:** a buyer can release one base unit to a seller who signed
  nothing. The receipt records who created it.
- **Untried:** a program-derived address as a Solana Pay recipient, in a wallet on a phone. **The
  fuzzer runs a v0 build,** since its runtime runs no v3 program. **Not audited.**

# escrow, v2

Devnet only: v2 runs on devnet at `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`
([record](devnet/devnet.json)). Nothing is on mainnet.

Up: [escrow](../README.md), which describes the shape v1 and v2 share. Down: the
[security checklist](security-checklist.md).

v2 is a second sealed program beside v1, at its own address; v1 stays as it is. New deals are meant
to use v2. Everything the escrow README says holds for v2, except what follows.

## What v2 changes

1. **An objection.** Either party may object, once per escrow, before the timer is due. It moves no
   money. After it the timer never runs: the money moves only by a release, a split, or the arbiter
   if one was named. The receipt records which side objected and when.
2. **Every receipt says when the money was there.** `funded_at` is the mark's time or, if nobody
   marked it, the ending's: the first time the program saw the amount.
3. **Rent above the receipt's minimum goes back to whoever fronted it.** `create` records its payer,
   and `sweep_rent` pays that payer. The deposit account's rent at every ending, and both rents at
   `close_unfunded`, still go to the creator.
4. **Both token programs.** A mint of the classic SPL Token program or of Token-2022, whichever owns
   it named as the token program in every instruction. Every payment out is a `transfer_checked`,
   so every way out names the mint. A transfer hook's accounts, which the client resolves, follow
   the instruction's own accounts and reach every transfer, never signing. Refused at `create`:
   wrapped SOL of either program, and a Token-2022 mint with a transfer fee (`TransferFee`, 6029) or
   that cannot be transferred (`NonTransferable`, 6030).

## What a person accepts by choosing a dollar

Whoever issues a dollar keeps powers over it that the escrow cannot take away or route around.
Which a dollar has is on its mint, for anyone to read. Open USD
(`ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB`) has every one below; USDC has the first.

- **Freeze.** A frozen deposit account stops every way out; a frozen party account stops every
  payment to that party.
- **Pause.** Every transfer of the dollar stops: nothing is paid in and no escrow ends. An objection
  and the mark still land; they move nothing.
- **Take the money.** A permanent delegate can move or burn any amount from any account, a deposit
  account included. An escrow left holding less than its amount ends only by `close_unfunded`,
  what is left going back to the buyer, or once the amount is back.
- **A check on every transfer.** A transfer hook can refuse any transfer and ask for accounts the
  app must pass. It never receives a signature through the escrow.
- **New accounts start frozen,** a new deposit account included, until the issuer thaws it.
- **Close the dollar.** Once nobody holds any, the issuer can close the mint; an escrow in it that
  never held money then cannot be closed, and its rent stays.
- **Rename it.** The escrow reads no name; an app knows a dollar by its mint's address.

Confidential transfers never reach a deposit account: turning them on needs a signature the escrow
never gives, so money arrives by plain transfer only. Interest-bearing and scaled dollars work: the
escrow holds and pays raw base units, fixed at creation, and only what they display drifts.

## The state table, where it differs

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | as v1 | as v1, but a mint of either token program, owned by the token program named; not wrapped SOL of either; no transfer fee; transferable | as v1, and the payer recorded |
| open, funded | `object` | the buyer or the seller | nobody objected yet; the timer, if it runs, not yet due | unchanged: the objection and its time recorded |
| funded | `timer_release` | nobody | as v1, and nobody objected | as v1 |
| anything but gone | `sweep_rent` | nobody | as v1 | unchanged: the excess to the payer |

Every ending from open (nobody marked the funding) writes its own time into `funded_at`. The
objection is not a status: an objected escrow is open or funded, and ends by any way out but the
timer. The timer's due time is the one deadline: before it only `object` lands, from it only
`timer_release`, so the two never race. A timer nobody marked is never due, so an objection to it is
never late; an escrow with no timer takes an objection too, which then changes only the receipt.

Events: v1's six, with `Created` and `RentSwept` naming the payer and `Ended` carrying `funded_at`,
and `Objected` (the side and the time).

## Use it

The client (`client/src/`) has v1's builders and checks, each taking the token program, and:

| Function | Gives |
|---|---|
| `tokenOf(mint, account)` | The mint's token program and decimals, read from its account; refuses what `create` refuses |
| `hookAccounts({ reader, mint, transfers, planned })` | A transfer hook's accounts, through `@solana/spl-token`'s resolver |
| `objectIx`, `canObject` | The objection, and whether one would land now |
| `vaultAddress(escrow, mint, tokenProgram)` | The deposit address under the mint's own token program |

It builds no pay link: a Solana Pay recipient is the escrow's own address, and an invoice's escrow
is `escrowAddress(seller, id)`.

What the app decides, beyond v1:

- **When to offer the objection, and what to say.** The program records nothing about why.
  `canObject` reads the device's clock; the chain's decides, so one sent in the last seconds may be
  refused.
- **What a timer means.** Either side can turn it off before it is due, so it pays the side it
  names only if the other side stays silent.
- **Which dollars to offer,** and what to say about each issuer's powers. Know a dollar by its
  mint's address, never its name.
- **A hook's accounts.** For a mint whose hook names a program, resolve them before each
  transaction (`hookAccounts`), since the issuer can change the program at any time, and pass them
  to each way out and to the payment in. A wallet paying a Token-2022 dollar in must send a
  `transfer_checked`.
- **Who fronts the rent.** Whoever signs `create` as payer is recorded and gets the sweep. A
  relayer that fronts it keeps what Solana's rent cuts free later.

```
cd escrow/v2/program && cargo build-sbf --arch v3                 # Solana CLI 4.2.2 or later
cd escrow/v2/program/tests-litesvm && cargo test                  # classic and Token-2022 mints
cd escrow/v2/client  && npm ci && npm run check && npm test       # no chain needed
FOREST_DEVNET_SEED=<phrase> escrow/v2/devnet/deploy.sh            # devnet: deploy, or upgrade in place
cd escrow/v2/client  && FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts
```

The LiteSVM tests run every classic case on a classic mint, and a Token-2022 mint made with Open
USD's extensions: its hook naming no program and naming a test hook, each issuer power used, and
mints with one other extension each. `deploy.sh` deploys a fresh id, leaves one holding the same
bytes as it is, and upgrades one holding other bytes in place; its keys come from
[devnet/](../../devnet/README.md).

## What one escrow costs

Measured under LiteSVM with the harness's keys; address derivations make each figure vary by up to
about 20,000 compute units with the keys.

| | Compute units | Bytes of 1,232 |
|---|---|---|
| `create`, classic mint | 33,631 | 595 |
| `object` | 4,049 | 347 |
| `release_to_seller`, classic | 15,633 | 480 |
| `split`, classic | 20,214 | 612 |
| one tap, classic | 48,712 | 702 |
| an invoice paid in one tap, classic | 15,926 | 559 |
| `create`, Open USD's extensions, no hook program | 42,095 | 595 |
| one tap, the same | 64,979 | 704 |
| one tap, a hook with two accounts | 101,111 | 872 |

The escrow account is 305 bytes (2,199,640 lamports at today's 5,080 a byte). A classic deposit
account is 165 bytes; one for Open USD's extensions, 179 (1,559,560 lamports).

## What is sealed, where it differs

- **The account.** 297 bytes after the discriminator: v1's 256, field for field and offset for
  offset (`version` 2), then `payer` (256..288), `objection` (288: none 0, the buyer 1, the seller
  2) and `objected_at` (289..297).
- **The instructions.** Eleven: v1's ten, with unchanged data bytes, and `object` (the escrow and the
  party signing; no arguments). `sweep_rent`'s second account is the payer; every way out names the
  mint right after the deposit account; the token program slot takes either program; every
  instruction that pays out forwards the accounts after its own to each transfer, never signing.
- **The addresses** are v1's seeds under v2's program id, so a v1 and a v2 escrow never share an
  address. The deposit account and each party's standard account are associated token accounts
  under the mint's own token program.
- **Errors.** v1's 25 keep their numbers; six follow them.

The source's program id, `FoRE2EscrowV2objectsTimerFundedAtPayer222222`, is for local work; no
keypair for it exists. Sealing on mainnet is as for v1.

## Limits

v1's limits hold, but SOL sent to an escrow's address goes to the payer, and the client makes no pay
link. Beyond them ([security checklist](security-checklist.md)):

- **An objection makes the timer a default, not a promise:** either side can turn it off the day
  before it is due.
- **A deadlock holds the money.** After an objection, with no arbiter, if neither side gives and
  they do not agree, the money stays for good.
- **The issuer's powers,** listed above. With a permanent delegate, "once funded, funded until the
  end" no longer holds.
- **A party can block its own payouts** with a standard account that requires a memo: the escrow
  sends none.
- **Hook accounts are the client's to find;** a missing one fails the transfer and nothing moves. No
  dollar on devnet names a hook program: a hook program runs only under LiteSVM, as a builtin.
- **No fuzzer and no local-validator test;** the devnet run is the client's only run against a real
  runtime. **Not audited.**

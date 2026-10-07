# escrow

Devnet only: the program runs on devnet at `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, still upgradable ([record](devnet/devnet.json)); nothing is on mainnet.

Up: [the repo](../README.md). Down: the [security checklist](security-checklist.md).

## What it is

A program Forest offers, and its client; use any escrow. Forest offers one per chain, on Solana only
for now. An escrow holds an amount of one token between two keys, a buyer and a seller, and lets it
out only when both sides agree, or by an arbiter or a timer that was in the escrow from the start.
Either side can object, which turns the timer off. Every escrow that held the money leaves a receipt
at its address, for good.

Each version is to be sealed on mainnet the day it deploys, because it holds money. There, a new
version comes as a new program at a new address, never an upgrade, and the old ones keep working.

- `program/`: the program (Anchor 1.2), its LiteSVM tests and its fuzzer.
- `client/`: builds every instruction and reads every account and event. It talks to no network of
  its own.
- `devnet/`: the deploy script and the public record of what runs on devnet.

Every escrow it opens carries version 2 (see the FAQ).

## How it works

### Opening and paying in

- **Opening.** Either party opens an escrow and signs, naming both keys, the token and the amount.
  One the seller opens is an invoice. Its address is made from a hash of all its terms: the buyer,
  the seller, the token, the amount, the arbiter, the timer and an id. So a payment sent to it
  counts only toward a deal with exactly those terms, and only the buyer or the seller can open
  it; who opens it is not a term, so either lands at the same address. Whoever fronts the rent
  signs too, and is recorded as the payer: every rent goes back to it.
- **The token.** A mint of the classic SPL Token program or of Token-2022. Refused: wrapped SOL of
  either program, and a Token-2022 mint with a transfer fee or that cannot be transferred.
- **Paying in.** Money arrives by a plain transfer, from anywhere, to the escrow's deposit address:
  its associated token account for the mint, so a payment sent "to the escrow's address" lands
  there. The escrow is funded while that account holds at least the amount. Every way out checks
  the live balance; nothing needs to mark it first.
- **Marking.** `mark_funded`, sent by anyone, records the time the amount was there. Only the timer
  needs it: the timer counts from the mark.

### The pay link

The one format for paying for an offer from any app. An index shows it on every live offer with a
price. It never pays and never holds money: it links.

    https://forest.foundation/pay?v=2
      &offer=<profile address>/offer/<id>
      &record=<the id of the record that holds the offer>
      &price.amount=<whole units, decimal text>&price.mint=<mint>&price.per=<hour | day | job>
      [&terms.arbiter=<key>][&terms.timer.days=<1..65535>&terms.timer.to=<seller | buyer>]

Parameters come in exactly this order, so two apps write the same link. Every parameter after
`record` is the offer record's own field, named by its path. The seller is the profile the offer
address names, paid at its address: the link carries no other key, so a forged link cannot send
money anywhere else. An app reads the offer at `offer` (from its hosts, or an index), shows the
record's terms if its id is not `record`, agrees the amount, and pays with this client: `termsFor`,
then `createAndFund` or `payInOneTap`, the buyer opening the escrow. The client builds and reads no
link. Version 1 named profiles by did:key.

### How money leaves

Two ways out, and one brake.

1. **Both agree.** The buyer releases everything to the seller, the seller releases everything
   back to the buyer, or both sign a split at any percentage. Receiving in full never needs the
   receiver's signature, so each side alone can give, and only together can they divide.
2. **An arbiter or a timer, set at the start.** Both are off unless the creator sets them in
   `create`. From then on they are in the escrow, for both sides to read before anyone works or
   pays, and they never change.
   - **Arbiter:** any key but the buyer's or the seller's, that may sign any split. A party as
     arbiter could take everything alone. Who holds any other key, the program cannot tell.
   - **Timer:** a number of whole days after the funding is marked, anyone may send everything to
     the side the timer names.

   The program cannot tell whether the other side read them. The app shows them before anyone works
   or pays (`optionsNotAgreed`); working or paying after that is the agreement.
3. **An objection.** Either side may object, once, before the timer is due. It moves no money. It
   turns the timer off for good: after it, money leaves only by the two sides agreeing, or by the
   arbiter if one was named. The timer's due time is the one deadline: before it only the objection
   can land, from it on only the timer, so the two never race.

Every way out pays the whole balance, and pays each side only at its standard token account for the
mint (its associated token account).

Three more instructions move money that is not the deal's:

- **`close_unfunded`:** an escrow that never held the amount is closed by either party, at any time.
  Whatever arrived goes back to the buyer, and both rents to the payer. No receipt is kept: nothing
  was dealt.
- **`recover_late`:** money sent after the end goes back to the buyer. Anyone may send it.
- **`sweep_rent`:** lamports above the receipt's rent-exempt minimum (SOL sent to the escrow's
  address, or what a cut in Solana's rent frees) go to the payer. Anyone may send it.

### Receipts

When an escrow ends, its deposit account closes and its rent goes to the payer. The escrow account
stays at its address as the receipt: the buyer, the seller, who opened it, the token, the amount,
the arbiter and the timer, who fronted the rent, when the money was there (the mark's time, or the
ending's if nobody marked it), whether a side objected and when, how it ended, when, and what each
side got. A receipt never closes and never changes, and its address never holds a second deal, so
the address is the deal's id that reviews name.

Every change is also an event, so an index can read outcomes from the log: `Created`, `Funded`,
`Objected`, `Ended`, `Closed`, `RecoveredLate`, `RentSwept`.

### The state table

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | the buyer or the seller as creator, and whoever fronts the rent as payer | address `["escrow", sha256(terms)]`; buyer and seller differ; no zero keys; the arbiter, if any, neither party; neither party the escrow's own address or its deposit address; amount above zero; a timer, if any, of at least one day; a mint owned by the token program named, not wrapped SOL, no transfer fee, transferable; no escrow already at the address | open; the creator recorded, and the payer as rent recipient |
| open | `mark_funded` | nobody | the deposit account holds at least the amount | funded, `funded_at` = now |
| open, funded | `object` | the buyer or the seller | nobody objected yet; the timer, if it runs, not yet due | unchanged: the objection and its time recorded |
| open, funded | `release_to_seller` | the buyer | the deposit account holds at least the amount | ended: the whole balance to the seller |
| open, funded | `release_to_buyer` | the seller | the same | ended: the whole balance to the buyer |
| open, funded | `split(seller_bps)` | the buyer and the seller | the same; `seller_bps` ≤ 10,000 | ended: `⌊balance × seller_bps / 10,000⌋` to the seller, the rest to the buyer |
| open, funded | `arbitrate(seller_bps)` | the arbiter | an arbiter was named; the same | ended: the same split |
| funded | `timer_release` | nobody | a timer was set; nobody objected; now ≥ `funded_at` + days × 86,400 | ended: the whole balance to the side the timer names |
| open, funded | `close_unfunded` | the buyer or the seller | the deposit account holds less than the amount | gone: what it held to the buyer, both accounts closed, both rents to the payer |
| ended | `recover_late` | anyone; the sender makes the buyer's standard account if missing | a later payment made the deposit account again | unchanged: the late money to the buyer, that account's rent to the buyer |
| anything but gone | `sweep_rent` | nobody | the escrow account holds more than its rent-exempt minimum | unchanged: the excess to the payer |
| ended | anything else | | | refused: `Ended` |

"Funded" in the Needs column is the live balance, never the status. Every ending from open (nobody
marked the funding) writes its own time into `funded_at`. The objection is not a status: an
objected escrow is open or funded, and ends by any way out but the timer. A timer nobody marked is
never due, so an objection to it is never late; an escrow with no timer takes an objection too,
which then changes only the receipt.

### Use it

| Function | Gives |
|---|---|
| `termsFor(postTerms, deal)`, `optionsFromPost(postTerms)` | An escrow's terms from an offer's optional `terms` block ([offer schema](../records/schemas/offer.json)) and the deal |
| `tokenOf(mint, account)` | The mint's token program and decimals, read from its account; refuses what `create` refuses |
| `createIx`, `invoiceIx`, `createAndFund`, `payInOneTap`, `payInvoiceInOneTap` | Opening; opening and funding; paying and releasing in one transaction |
| `markFundedIx`, `objectIx`, `releaseToSellerIx`, `releaseToBuyerIx`, `splitIx`, `arbitrateIx`, `timerReleaseIx`, `closeUnfundedIx`, `recoverLateIx`, `sweepRentIx` | Every other instruction |
| `keysFor`, `keysOf` | Every account a way out names, from the terms or from the escrow read off the chain |
| `optionsNotAgreed`, `assertOptionsAgreed` | Every arbiter and timer a person did not set, and which side a timer favours |
| `timerDueAt`, `timerDue`, `canObject` | When the timer is due, and whether an objection would land now |
| `escrowAddress`, `termsHash`, `termsOf`, `vaultAddress`, `refundAddress`, `payoutAddress`, `makeDepositAddressIx`, `makeStandardAccountIx`, `makeRefundAddressIx` | Addresses (an escrow's from its terms), and the accounts a payment needs made first |
| `hookAccounts`, `payoutTransfers` | A transfer hook's accounts, through `@solana/spl-token`'s resolver |
| `decodeEscrow`, `decodeEvents` | The receipt and the events. `decodeEvents` reads only events this program wrote, by the runtime's own invoke lines |

What the app decides, because the program does not know:

- **Check the options before anyone works or pays.** Read the escrow off the chain and run
  `optionsNotAgreed` against what the person set or accepted; before paying an invoice, also check
  that it names the person's own key as buyer.
- **What a timer means.** Either side can turn it off before it is due, so it pays the side it names
  only if the other side stays silent.
- **When to offer the objection, and what to say.** The program records nothing about why.
  `canObject` reads the device's clock; the chain's decides, so one sent in the last seconds may be
  refused.
- **The amount** is the app multiplying per hour, per day or per job before creation: one escrow per
  payment. **The id** tells apart two deals with the same terms: a fresh 64-bit number for each
  (`randomId()`).
- **Make the deposit address first** when paying in the same transaction as `create`
  (`createAndFund` and the one-tap builders do), so a fee payer that checks every transfer's
  destination before it signs finds it made. Make the seller's standard account first if the seller
  may not hold the token yet.
- **Mark the funding** only if there is a timer: it counts from the mark, and only the side it
  favours has a reason to send it.
- **Which dollars to offer,** and what to say about each one's maker (Limits). Know a dollar by its
  mint's address, never its name.
- **A hook's accounts.** For a mint whose hook names a program, resolve them before each
  transaction (`hookAccounts`), since the dollar's maker can change the program at any time, and
  pass them to each way out and to the payment in. A payment in a Token-2022 dollar must be a
  `transfer_checked`.
- **Who fronts the rent.** Whoever fronts the rent signs as payer and gets every rent back, what
  Solana's rent cuts free later included; what a fee payer charges for fronting it is its own
  policy. Registry rows follow the same rule.

```
cd escrow/program && cargo build-sbf --arch v3                    # Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test                     # classic and Token-2022 mints
cd escrow/program && cargo build-sbf --arch v0 && cd trident-tests \
  && TRIDENT_WITH_EXIT_CODE=1 cargo run --release --bin fuzz_escrow   # exit 99 if an invariant broke
cd escrow/client  && npm ci && npm run check && npm test          # no chain needed
FOREST_DEVNET_SEED=<phrase> escrow/devnet/deploy.sh               # devnet: deploy, or upgrade in place
cd escrow/client  && FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts
```

The LiteSVM tests run every case on a classic mint, and on a Token-2022 mint made with Open USD's
extensions: its hook naming no program and naming a test hook, each power its maker holds used,
and mints with one other extension each. They move the clock by hand and check the wire format
against a second copy written in `program/tests-litesvm/src/lib.rs`.

The fuzzer sends random flows against a model of every escrow and checks fifteen invariants after
every step (`program/trident-tests/fuzz_escrow/test_fuzz.rs` lists them); `FOREST_FUZZ_ITERATIONS`
sets its size. It needs the old program format, so it runs a v0 build. Before the LiteSVM tests
again, delete `program/target/deploy/forest_escrow.so` and build v3: `cargo build-sbf` does not
copy a build it already holds over the v0 one.

### What one escrow costs

Measured under LiteSVM with the harness's keys; address derivations make each figure vary by up to
about 20,000 compute units with the keys.

| | Compute units | Bytes of 1,232 |
|---|---|---|
| `create`, classic mint | 32,646 | 595 |
| `object` | 4,049 | 347 |
| `release_to_seller`, classic | 14,566 | 480 |
| `split`, classic | 19,146 | 612 |
| one tap, classic | 48,161 | 702 |
| an invoice paid in one tap, classic | 13,140 | 527 |
| `create`, Open USD's extensions, no hook program | 53,150 | 595 |
| one tap, the same | 62,969 | 704 |
| one tap, a hook with two accounts | 99,100 | 872 |

Rent, at today's 5,080 lamports a byte: the escrow account is 305 bytes (2,199,640 lamports), and
comes back whole only if it never held the amount; otherwise the receipt keeps its minimum, and
`sweep_rent` returns what Solana's rent cuts free above it. A classic deposit account is 165 bytes;
one for Open USD's extensions, 179 (1,559,560 lamports). It comes back to the payer at every ending.

### What is sealed

None of this can change after deploy; a change is a new program at a new address.

- **The account.** 297 bytes after the discriminator, laid out in `program/src/state.rs` (and
  written again in `program/tests-litesvm/src/lib.rs` and `client/src/program.ts`): version, id,
  buyer, seller, arbiter, mint, deposit account, rent recipient (the payer), amount, creator,
  timer days, timer side, created, funded, status, bump, ended, outcome, what the seller got, what
  the buyer got, payer, objection, objected at. `version` is 2. The zero key means no arbiter; zero
  days, no timer; a zero time, not yet.
- **The addresses.** The escrow at `["escrow", sha256(terms)]`, the terms at fixed lengths in the
  receipt's order (`terms_hash` in `program/src/state.rs`); the deposit account its associated
  token account for the mint, under the mint's own token program; each party paid only at its own
  associated token account, checked by address alone, so handing that account to another key
  blocks no way out.
- **The rules,** as the table says, and the order of checks in each handler, which decides the error
  a refused instruction returns. Every handler that needs a live escrow checks that first, as an
  allowlist of the live states (open, funded).
- **The instructions, events and errors.** Eleven instructions, seven events and 32 errors, their
  bytes and account lists. Every way out names the mint right after the deposit account, names only
  the accounts it pays, and forwards the accounts after its own to each transfer, for a transfer
  hook, never signing.

On mainnet the program is sealed the day it deploys:

```
solana program deploy --program-id <program-keypair.json> target/deploy/forest_escrow.so
solana program set-upgrade-authority <PROGRAM_ID> --final
solana program show <PROGRAM_ID>        # Authority: none
```

The source's program id, `FoRE2EscrowV2objectsTimerFundedAtPayer222222`, is for local work; no
keypair for it exists. Each deploy uses its own.

### Devnet

On devnet the program is built as SBPF v3 and not sealed: its upgrade authority is the devnet
deploy key. `devnet/deploy.sh` builds a copy of the source with the devnet id put in, deploys a
fresh id or upgrades it in place, checks the deployed bytes against the build, and records
everything public in [`devnet/devnet.json`](devnet/devnet.json); its header holds the recipe for
every devnet key it needs. `client/scripts/devnet.ts` runs five deals there, recorded in the same
file: in the classic test dollar, an invoice paid in one tap and an escrow with a timer the buyer
objected to, then split; the same two in a Token-2022 dollar made with Open USD's extensions, and
one more invoice in it. The record names the test dollar (`testDollar`), keeps the escrow's
earlier programs on devnet under `earlier` (the first deploy of this program, closed, and v1, still
deployed and to be closed), and keeps the deals made before each escrow's address held its terms
under `beforeTermsInTheAddress`. There is no smoke test: read a receipt with `solana account <address>
--url devnet`, and decode it with `decodeEscrow`.

## Promises

- **Money leaves a funded escrow only** by a release from the side giving it up, a split both sign,
  the arbiter named at creation, or the timer set at creation once due and while nobody has
  objected. The one exception is a Token-2022 dollar whose maker holds a permanent delegate
  (Limits).
- **Every way out pays the whole balance,** to the parties' standard token accounts and nowhere else.
- **An address holds only its own terms.** A payment to an escrow's address counts only toward a
  deal with exactly the terms the address was made from.
- **Each side alone can always give.** Nothing in the escrow stops it: while an escrow is live, the
  buyer can release to the seller and the seller back to the buyer, whatever the options and
  whether or not anyone objected.
- **An objection moves no money,** lands once per escrow, and only before the timer is due; after it
  the timer never pays.
- **A receipt never closes and never changes,** and its address never holds a second deal.
- **Rent goes back to whoever fronted it:** every rent to the payer, at every ending, at
  `close_unfunded` and by `sweep_rent`; a deposit account a late payment made again, to the buyer.
- **Nothing inside charges anything.** No admin, no config account, no pause, no fee.

## Limits

- **It trusts** the SPL Token and Token-2022 programs, the associated token program, and Anchor 1.2;
  the dollar's maker, for the powers listed below; and the app, to show a person every option they
  did not agree to before they work or pay.
- **A deadlock holds the money.** With no arbiter, if neither side gives and they do not agree, the
  money stays in the escrow for good: after an objection, or with no timer at all. Nothing in the
  program can break it. A deal that may need a third view names an arbiter at the start.
- **Options nobody checked.** The program runs whatever options the creator set. A one-day timer to
  the creator's own side runs if the other side never read the escrow and never objected.
- **A timer is a default, not a promise.** Either side can turn it off the day before it is due.
- **What a person accepts by choosing a dollar.** Whoever makes a dollar keeps powers over it that
  the escrow cannot take away or route around; which a dollar has is on its mint, for anyone to
  read. Open USD (`ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB`) has every one below.
  - **Take the money.** A permanent delegate can move or burn any amount from any account, a deposit
    account included. An escrow left holding less than its amount ends only by `close_unfunded`,
    what is left going back to the buyer, or once the amount is back.
  - **A check on every transfer.** A transfer hook can refuse any transfer and ask for accounts the
    app must pass. It never receives a signature through the escrow.
  - **Close the dollar.** Once nobody holds any, its maker can close the mint; an escrow in it that
    never held money then cannot be closed, and its rent stays.
  - **Rename it.** The escrow reads no name; an app knows a dollar by its mint's address.

  Confidential transfers never reach a deposit account: turning them on needs a signature the
  escrow never gives, so money arrives by plain transfer only. Interest-bearing and scaled dollars
  work: the escrow holds and pays raw base units, fixed at creation, and only what they display
  drifts.
- **Money sent to an address before its escrow opens, or after a close,** waits there, and counts
  only toward an escrow opened with exactly those terms. Either party can open one, and close it
  if it holds less than the amount, which sends the money back to the buyer.
- **A party's standard account must exist to be paid;** whoever sends the way out makes it first.
  A party whose standard account requires a memo blocks its own payouts: the escrow sends none.
- **`recover_late` checks who holds the buyer's standard account,** so a buyer who handed it away
  blocks only its own late money.
- **SOL sent to an escrow's address** goes to the payer by `sweep_rent`. **Tokens of another mint**
  sent there are lost to everyone.
- **Refunds arrive in SOL,** to the key that fronted the rent.
- **A one-sided receipt is cheap:** a buyer can release one base unit to a seller who signed
  nothing. The receipt records who created it.
- **Hook accounts are the client's to find;** a missing one fails the transfer and nothing moves.
  No dollar on devnet names a hook program: a hook program runs only under LiteSVM, as a builtin.
- **Tested, not audited.** The fuzzer runs an SBPF v0 build, since its runtime runs no v3 program,
  on a classic mint only, and its runtime checks no signatures. There is no local-validator test:
  the devnet run is the client's only run against a real runtime. A Solana Pay link to an escrow's
  address is untried on a phone. No paid review.

The [security checklist](security-checklist.md) lists every known limit, with the test that pins
each.

## Who decides what

- **The standard:** the program's rules and the receipt; to be sealed on mainnet.
- **An app, with the person:** the terms, the arbiter, the timer's default, and which escrow to use.
- **A fee payer, by its own policy:** which transactions it pays for.

## FAQ

**Can one side take the money alone?** No. Each side alone can only give: the buyer to the seller,
the seller back to the buyer. Taking needs the other side, the arbiter, or a timer nobody objected
to.

**We disagree and there is no arbiter. Why does the money stay?** Nobody else can move it, Forest
included: it stays until the two of you agree, or one of you gives. A timer that ended the hold
would reward whoever waits. If you want someone to decide, choose an arbiter at the start.

**Does a timer guarantee I get paid?** No. It pays the side it names only if the other side does
not object before it is due.

**Why can the arbiter and the timer only be set at the start?** So both sides can read every way
out before anyone works or pays, and nothing changes it later.

**Why can an objection only land before the timer is due?** The due time is the one deadline for
both sides: before it only the objection can land, from it on only the timer. They never race.

**Why can someone open an escrow without the other side signing?** Asking the seller to sign
`create` would stop anyone paying a seller who is offline, and break paying in one tap. The receipt
records who created it instead.

**Why is each side paid only at its standard token account?** So no ending can send money anywhere
else. It is checked by address alone, so a side that hands that account to another key blocks no
way out.

**Can Forest, an app or a fee payer move the money?** No. There is no admin and no fee, and on
mainnet the program will be sealed the day it deploys. On devnet the deploy key can still upgrade
it.

**Who gets the rent back?** Whoever fronted it, recorded as the payer: the deposit account's at
every ending, both rents of an escrow that never held the money, and what the receipt holds above
its minimum. A fee payer that fronts it gets it back.

**Why does a receipt never close?** A review points at it: the escrow's address is the deal's id.

**Which tokens work?** Any mint of either token program but wrapped SOL, one with a transfer fee (it
would take part of every payment, while every way out pays the whole balance), and one that cannot
be transferred (it could never leave).

**What happened to version 1?** It was a separate program: classic tokens only, no objection, and
the sweep to the creator. It left this repo so that there is one escrow: one set of rules for an
app to show and for anyone to check. Its source, client and checklist are in git history. It is
still deployed on devnet at `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR`, to be closed; its
record is in [`devnet/devnet.json`](devnet/devnet.json) under `earlier`. Each escrow follows the
program it was opened in.

**Why does every escrow say version 2?** The version says which program's rules an escrow
followed: version 1 was the earlier program above. There is one escrow program here, and a later
one would be a new program at a new address.

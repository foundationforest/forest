# escrow

The sealed Solana program that holds an amount of a classic SPL token between two keys, buyer
and seller, and lets it out only when the two sides agree; and the client an app uses to open,
fund, check, end and read one.

**Nothing here is shipped.** It has run under LiteSVM, under a fuzzer and on a local validator,
and nowhere else. No devnet, no mainnet. The devnet run is built and scripted (`docs/devnet.md`),
and stopped at the deploy for lack of test SOL in sessions 15 and 18; it has not been tried with
this version.

Money in, and out only when the two sides agree. Either party opens an escrow, naming both keys,
the token and the amount; one the seller opens is an invoice. The escrow's address comes from the
key of whoever opens it, who signs, so nobody can open an escrow at an address another key will
use. Money arrives at its own deposit
address by a plain transfer from anywhere, and the escrow is funded once that address holds the
amount. Then there are three ways out: the buyer releases everything to the seller, the seller
releases everything to the buyer, or both sign a split. Receiving in full never needs the
receiver's signature, so each side alone can give, and only together can they divide. Every way
out pays out the whole balance, whatever it is, and pays each side only at its standard token
account for the mint.

Two options exist, each off unless the creator turns it on at creation: an arbiter key that may
sign any split, and a timer that, a number of days after the funding is marked, lets anyone send
everything to the side it names. There is no other clock. Cancellation and refund are not
features: they are the seller releasing to the buyer, or a split.

A finished escrow stays at its address as a permanent receipt. Money sent to it after the end
goes back to the buyer, and rent above the minimum goes back to the creator; anyone may send
either. An escrow that never held the amount is closed instead, by either party, at any time. Every
rent refund goes to the creator, whoever fronted the rent: a fee payer that fronts it charges the
person for it, so the refund has to reach the person. Nothing in the program is anyone's dial:
there is no admin, no config account, no pause and no fee.

| | |
|---|---|
| `program/` | the program. Anchor 1.2, Rust, `cargo build-sbf`. |
| `program/tests-litesvm/` | 52 LiteSVM tests with the clock moved by hand, and the wire format written out a second time: `escrow.rs` (23: every way out with exact balances, every rejection, whose the address is, who may not be a party, where rent goes, the costs), `adversarial.rs` (27: the attacks, and the `finding_…` tests that pin what the program accepts by design) and `one_tap.rs` (2: the one-tap payment, its receipt and its rent, and a second payment to its link). |
| `program/trident-tests/` | a Trident fuzzer: random flows against the built program, a model of every escrow beside it, fourteen invariants checked after every step and at the end of every run. |
| `client/` | TypeScript, browser and Node: a builder for every instruction, the terms from a post's optional terms block, the check a person runs before working or paying, the timer, the deposit address and its pay link, the account and the events decoded. |
| `security-checklist.md` | the safe-solana-builder checklist: every rule, how it is applied here, and every known limit. |

## Running it

```
cd escrow/program   && cargo build-sbf                    # needs Solana CLI 4.2.2 or later
cd escrow/program/tests-litesvm && cargo test -- --nocapture
cd escrow/program/trident-tests && TRIDENT_WITH_EXIT_CODE=1 cargo run --release --bin fuzz_escrow   # exit 99 if an invariant broke
cd escrow/client    && npm install && npm test            # no chain needed
cd escrow/client    && npm run test:validator             # starts solana-test-validator itself
cd escrow/client    && npm run test:devnet                # read-only, against devnet/devnet.json's deploy, once there is one
```

## The state table

| From | Instruction | Signs | Needs | To |
|---|---|---|---|---|
| nothing | `create` | the buyer or the seller as creator, and whoever fronts the rent | the address is `["escrow", creator, id]`; buyer and seller differ; no zero keys; neither party is the escrow's own address or its deposit address; amount above zero; a timer, if any, of at least one day; a classic SPL Token mint, not wrapped SOL; the address never held an escrow that is still there | open, the creator recorded as where rent goes back |
| open | `mark_funded` | nobody | the deposit account holds at least the amount | funded, `funded_at` = now |
| open, funded | `release_to_seller` | the buyer | the deposit account holds at least the amount | ended: the whole balance to the seller's standard account |
| open, funded | `release_to_buyer` | the seller | the same | ended: the whole balance to the buyer's standard account |
| open, funded | `split(seller_bps)` | the buyer and the seller | the same; `seller_bps` at most 10,000 | ended: `⌊balance × seller_bps / 10,000⌋` to the seller, the rest to the buyer |
| open, funded | `arbitrate(seller_bps)` | the arbiter | an arbiter was named at creation; the same | ended: the same split |
| funded | `timer_release` | nobody | a timer was set at creation; now is at least `funded_at` + days × 86,400 | ended: the whole balance to the side the timer names |
| open, funded | `close_unfunded` | the buyer or the seller | the deposit account holds less than the amount | gone: whatever it held to the buyer, both accounts closed, both rents to the creator |
| ended | `recover_late` | anyone, who makes the buyer's standard account if it is missing | its deposit account made again by a later payment | ended, unchanged: the late money to the buyer's standard account, that account's rent to the buyer |
| anything but gone | `sweep_rent` | nobody | the escrow account holds more than its rent-exempt minimum | unchanged: the excess to the creator |
| ended | anything else | | | refused: `Ended` |

"Funded" in the Needs column is the live balance, never the `funded` status: the ways out check
the deposit account themselves, so one-tap Pay needs no `mark_funded`. The status says only
whether the funding was marked, and the timer is the one thing that needs that. Money can only be
added to a deposit account (only this program moves it out, and only by ending the escrow), so
once it holds the amount it holds it until the end, and `close_unfunded` can never run on an
escrow that was funded.

Every ending closes the deposit account, its rent to the creator. Every ending writes its outcome into the escrow account and emits one `Ended` event: the outcome
(`ReleasedToSeller`, `ReleasedToBuyer`, `Split`, `Arbitrated`, `TimerReleased`), the agreed amount,
the balance paid out, what each side got, when, and the deposit account's rent returned.
`close_unfunded` emits `Closed`: nothing was dealt, so there is no receipt. The six events are
`Created`, `Funded`, `Ended`, `Closed`, `RecoveredLate` and `RentSwept`.

## What one escrow costs

Measured under LiteSVM, twelve runs with fresh keys, legacy transactions with a compute-budget
instruction (`what_each_way_out_costs` and `one_tap.rs`):

| | Compute units | Of 1,400,000 | Bytes on the wire | Of 1,232 |
|---|---|---|---|---|
| `create`, no options | 31,700 to 48,200 | 2 to 3% | 595 | 48% |
| `create`, an arbiter and a timer | 33,300 to 51,300 | 2 to 4% | 630 | 51% |
| `mark_funded` | 4,154 | 0.3% | 283 | 23% |
| `release_to_seller` | 11,400 to 15,900 | 0.8 to 1.1% | 447 | 36% |
| `release_to_buyer` | 11,600 to 19,100 | 0.8 to 1.4% | 479 | 39% |
| `split` | 15,700 to 23,200 | 1.1 to 1.7% | 579 | 47% |
| `arbitrate` | 15,600 to 23,100 | 1.1 to 1.6% | 514 | 42% |
| `timer_release`, to the seller | 11,400 to 15,900 | 0.8 to 1.1% | 382 | 31% |
| `timer_release`, to the buyer | 11,400 to 18,900 | 0.8 to 1.3% | 382 | 31% |
| `close_unfunded`, nothing paid | 8,900 to 16,400 | 0.6 to 1.2% | 479 | 39% |
| `recover_late`, making the buyer's account | 29,600 to 52,100 | 2 to 4% | 578 | 47% |
| `sweep_rent` | 4,230 | 0.3% | 283 | 23% |
| one tap: the deposit address made, `create`, a plain transfer in, `release_to_seller` | 39,500 to 62,000 | 3 to 4% | 701 | 57% |
| the same, the seller's account made first in it | 53,000 to 77,000 | 4 to 6% | 743 | 60% |
| the same, an arbiter and a timer | 41,100 to 53,100 | 3 to 4% | 736 | 60% |
| an invoice paid in one tap: the transfer and `release_to_seller` | 11,700 to 22,200 | 0.8 to 1.6% | 526 | 43% |

Most rows vary because they derive an address, and a derivation tries bump seeds until one lands
off the curve at 1,500 units a try; the keys decide how many tries. `create` derives the escrow's
address and its deposit account; every instruction that pays a party checks that party's standard
account by address, which is one derivation. `create`'s check that neither party is the escrow or
its deposit address costs about 40 units (its least, 31,613 before, is 31,652).

Some rows are 32 bytes longer than the last version's: the rent recipient is now the creator, a key
the transaction does not otherwise carry when someone else signs (the seller releasing the buyer's
escrow, the arbiter, a timer, a sweep, the buyer paying an invoice), where it used to be the payer,
which every transaction carries. The one tap's top-level deposit address adds 10 bytes; its compute
came out lower than the last version's, since `create` finds the account made rather than making it
through a call into the associated token program.

Rent, at the 5,080 lamports per byte session 3 read from mainnet and the 696 the current cuts end
at (SOL at $100.24). Whoever fronts it, it comes back to the creator. The deposit account's rent
comes back at every ending. The escrow account's comes back whole only if it never held the
amount; otherwise the account is the receipt and keeps its rent-exempt minimum, and `sweep_rent`
returns whatever is above that minimum as the cuts land:

| Account | Bytes | Today | After the cuts | Returned |
|---|---|---|---|---|
| escrow | 264 | 1,991,360 lamports, $0.20 | 272,832 lamports, $0.027 | whole only if never funded; above the minimum by `sweep_rent` |
| deposit account | 165 | 1,488,440 lamports, $0.15 | 203,928 lamports, $0.020 | at every ending |

`one_tap.rs` measures the one tap with the Rent sysvar at each rate: the payer fronts 3,479,800 and
476,760 lamports, the deposit account's 1,488,440 and 203,928 go to the buyer in the same
transaction, and the receipt keeps 1,991,360 and 272,832. `feepayer/`'s local test runs the same
flows through Kora: each storage deposit is charged to the person once, in the dollar token, and
every one that comes back comes back to the person.

## What is sealed

These cannot change after v1 deploys.

- **The state.** One account per escrow, 256 bytes after the discriminator, the layout in
  `program/src/state.rs` and written out again by hand in `program/tests-litesvm/src/lib.rs` and
  `client/src/program.ts`: version, id, buyer, seller, arbiter, mint, deposit account, rent
  recipient (always the creator's key), amount, creator, timer days, timer side, created, funded (marked), status, bump, ended, outcome,
  what the seller got, what the buyer got. `version` is 1. The zero key means no arbiter; zero
  timer days mean no timer; a zero time means not marked or not ended. The status is open, funded
  or ended (0 to 2); the outcome byte means something only once ended (0 to 4, in the order
  above); a side is buyer 0, seller 1.
- **The addresses.** The escrow is `["escrow", creator, id]` under the program: the key of the party
  who opens it (the buyer, or the seller for an invoice), who signs `create`. Nobody can open an
  escrow at an address another key will use. The deposit account is the escrow's associated token
  account for the mint, the standard derivation, so any wallet that sends the token "to the
  escrow's address" lands it there. An address that ever held a funded escrow is taken for good:
  `create` there fails, because the receipt is still there.
- **The rules,** as the state table says, and the order of checks in each handler, which decides
  the error a refused instruction returns. Every one checks "ended" first, as an allowlist of the
  live states (open, funded).
- **The instruction bytes and the account lists.** Ten instructions and six events; clients and
  indexes read them forever. `create` carries the buyer in its arguments and the creator in its
  signer slot. Each way out names only the accounts it pays: `release_to_seller` names no buyer
  account, `release_to_buyer` and `close_unfunded` no seller account, `timer_release` one account,
  checked against the side its timer names.
- **Where the buyer is paid.** At the buyer's standard token account for the mint, and no other
  account, by every instruction that pays the buyer anything. Checked by address alone, not by who
  holds that account now: a buyer who hands it to another key cannot block a way out. It needs to
  exist only when the buyer is paid something; whoever sends the way out makes it first in the same
  transaction if it might be missing (`makeRefundAddressIx`), and `recover_late` makes it itself.
- **Where the seller is paid.** The same rule: at the seller's standard token account for the mint,
  and no other account, on every way out, the timer included. Checked by address alone. It needs to
  exist only when the seller is paid something; whoever sends the way out makes it first if it might
  be missing (`makeStandardAccountIx`).
- **Where rent goes back.** To the creator, recorded at creation: the deposit account's at every
  ending, both rents from `close_unfunded`, and everything `sweep_rent` moves. Whoever fronted the
  rent gets nothing back, and has no say over an escrow it paid for.
- **What a Token-2022 mint gets.** Refused at `create`: the mint account must be owned by the
  classic token program. A transfer fee, a permanent delegate or a transfer hook would change
  what "hold X, release X" means, and this cannot be patched.
- **What wrapped SOL gets.** Refused at `create` by its address. SOL sent to its deposit account by
  a plain transfer counts only after a sync.
- **What is not there.** No admin key, no config account, no upgrade, no pause, no fee, no deadline
  but the optional timer, and no way for anyone to move money but the rules above.

## What the app decides

Everything the program does not know.

- **The options.** An escrow is created from the post's optional `terms` block (`shapes/`, the
  post's `#terms`): `arbiter` and `timer { days, to }`, each off unless set. `termsFor` puts a post's
  options together with the deal's seller, amount and id; `optionsFromPost` reads them and refuses a
  malformed one. The program accepts any option its creator chose, including an arbiter who is one
  of the parties and a one-day timer to the creator's own side. So **before a person works or
  pays**, the app reads the escrow off the chain and runs `optionsNotAgreed` against what that
  person set or accepted. It lists every arbiter and every timer they did not set, whose key an
  arbiter is (theirs, the other party's, a stranger's), and which side a timer favours. The app
  puts that in words; `assertOptionsAgreed` throws instead.
- **The amount.** Per hour, per session or per job is the app multiplying before creation. One
  escrow per payment.
- **The id.** Any 64-bit number the creator has not used; `randomId()` picks one. An address that
  ever held a funded escrow cannot be opened again; one closed without ever holding the amount can,
  by the same creator and id, and adopts whatever arrived there since.
- **Who opens it.** The buyer (`createIx`), or the seller as an invoice (`invoice`, which gives the
  seller's `create`, at the seller's address, and the pay link to send the buyer). The receipt
  records which: an index weighs a receipt by who agreed, and a seller who created the escrow
  agreed. Before paying an invoice, the buyer's app checks it names the buyer's own key as buyer:
  every refund goes there.
- **When to send `mark_funded`.** Only the timer needs it, and it counts from the moment
  `mark_funded` runs, not from when the money arrived. The side a timer favours marks as soon as the
  money lands; nobody can mark before the amount is there, or date a mark earlier.
- **The pay link.** `solanaPayUrl` names the escrow's address as the recipient and the reference,
  with the mint and the amount still missing: it takes the deposit account's balance and refuses
  once the amount is there, or the escrow is marked or ended. Every way out pays the whole
  balance, so a second payment before the end goes wherever the rest goes (to the seller, on a
  release); the link does not invite one. A payment that arrives after the end anyway is not lost:
  `recover_late` sends it back to the buyer, and anyone may send that.
- **Funding in the same transaction.** `createAndFund` gives the deposit address made first (the
  associated token program's idempotent create, `makeDepositAddressIx`), `create` and a plain
  transfer of the amount; `payInOneTap` adds `release_to_seller`. The deposit address is made at the
  top of the transaction, not only inside `create`, so a fee payer that checks every transfer's
  destination before it signs (Kora does) finds it made, and can sign "Pay". Put
  `makeStandardAccountIx` for the seller first if the seller may not hold the token yet.
- **Who fronts the rent.** Whoever signs `create` as the payer: either party, or any key paying for
  them, such as a fee payer that charges the person for it. The program cannot tell and never needs
  to: the rent always comes back to the creator. Every funded escrow keeps one receipt's
  rent-exempt minimum for good, and `sweep_rent` returns what the cuts free above it. A refund
  arrives in SOL in the creator's wallet, which in a fee payer's app may otherwise hold none; what
  the app does with it is the app's choice, and the copy never says "SOL".

## How a review points at an escrow

A review's `dealId` is the escrow account's address, base58. Once the escrow has held the amount,
that address is a permanent receipt: the account is never closed, and it holds the parties, who
created it, the options, the mint, the agreed amount, when it was created, marked and ended, how it
ended, and what each party was paid. An index reads the account; the events (`Created`, `Funded`
if marked, `Ended`) give the same numbers with their transactions.

The handoff's rule (Deals and evidence): a receipt counts fully when the seller created the escrow
(`creator` is the seller) or reviewed the deal. A one-sided payment, the buyer's escrow released to
a seller who never signed anything, is a real receipt but one-sided: a stranger can make one for a
single base unit. Only events the escrow program itself wrote count: any program can write a
`Program data:` line with the same bytes, so `decodeEvents` reads the runtime's own invoke lines to
see who wrote each one. Accounts cannot be forged that way: only this program can own an account at
the address it derives.

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
`--bpf-program`. Mainnet gets a fresh one. Devnet gets a test one, derived from one phrase with
every other devnet key (`devnet/keys.sh`, `docs/devnet.md`).

## Chosen, not decided

Where the handoff and Carlos's answers were silent, the simplest option was taken. Each is
reversible until something ships, and each is in `docs/changes/escrow.md`.

1. **Funded means the live balance covers the amount**, checked by every way out, and below it the
   only exit is `close_unfunded`. So a receipt always means the amount was really held, and the
   one tap needs no `mark_funded`.
2. **`mark_funded` records a time and nothing else**, and only the timer reads it. No ending
   records the funding time, so a receipt nobody marked says `funded_at` 0.
3. **A split is in basis points**, `u16` up to 10,000, the seller's share rounded down; a
   "percentage" to two decimals.
4. **The timer is due from the second**: `now ≥ funded_at + days × 86,400`. Days are sixteen bits
   (up to 179 years), as the post's lexicon already says.
5. **The buyer's account must exist only when the buyer is paid**, and it is checked by address,
   with the token program checking the rest when it pays. So a never-paid escrow closes, and a
   split of everything to the seller runs, with no buyer account at all.
6. **One `Ended` event for every way out**, with the outcome inside, rather than one event per
   outcome; `seller_bps` is not in it, since what each side got is.
7. **The escrow records who created it** (`creator`), for the index's "who said yes".
8. **`timer_release` names one account**, the side's the timer names, checked in the handler by
   address: that side's standard account.
9. **The buyer and the seller must differ, and no key may be the zero key**, the arbiter's
   included, since the zero key means "no arbiter".
10. **`close_unfunded` has no wait for either party**: no deadline exists. Only the parties may send
    it; whoever fronted the rent may not, since the rent is not its own.
11. **The pay link takes the balance and asks for what is missing**, because an overpayment is no
    longer returned by the program.
12. **`recover_late` is unchanged** from the last version, known limits included: the re-made
    deposit account's rent goes to the buyer, whose wallet almost always made it, not to the
    creator, since it was not fronted at creation. `sweep_rent` pays the creator.
13. **`whatDiffers` is gone.** It guarded against someone opening the buyer's address first, which
    the program now refuses.
14. **Anchor 1.2, `cargo build-sbf`, no IDL**, as in the registry: the client and the Rust tests
    both write the bytes by hand. Classic `token::transfer`, not `transfer_checked`, since
    Token-2022 is refused at `create`.

## What this does not do

No devnet deploy of this version, no mainnet; Kora only on a local validator, in `feepayer/`'s
local test. No paid review has happened, and
`docs/handoff.md`'s "Before mainnet" list still stands in full. Whether the wallets people use accept
a program-derived address as a Solana Pay recipient has not been tried on a phone; if one does not,
the app sends to the deposit address directly, which the client also gives. Tokens of another mint
sent to an escrow's address are not recovered: its associated token account for that mint is a
different address, and nothing here signs for it. SOL sent to an escrow's address goes to the
creator by `sweep_rent`, not back to whoever sent it. `security-checklist.md` lists every known limit.

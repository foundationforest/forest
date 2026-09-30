# Security checklist: the Forest escrow, v2

Written with the safe-solana-builder skill (`.claude/skills/safe-solana-builder/`): every rule in
its `references/shared-base.md` (sections 1 to 31), `references/anchor.md` and
`references/litesvm.md`, how v2 applies it or why it does not apply, and every limit known today.
v2 is v1 (`../security-checklist.md`) plus an objection, a funding time on every receipt, and the
sweep to the recorded payer; where a rule applies to v2 exactly as to v1, this says so and names the
v2 test. The program is `program/src/`; the tests are in `program/tests-litesvm/tests/`. Nothing
here is shipped, and no paid review has happened.

| | |
|---|---|
| Program | `forest_escrow_v2`, version byte 2, `FoRE2EscrowV2objectsTimerFundedAtPayer222222` for local work, `B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7` on devnet |
| Framework | Anchor 1.2, `cargo build-sbf --arch v3` (Solana CLI 4.2.2), no IDL, no build warning |
| Testing | LiteSVM, 64 tests; a mutation check of each new rule (removing it fails at least one test); two deals on devnet through the client. **Not carried over from v1:** the Trident fuzzer and the local-validator test |
| Risk level | 🟡 Medium by the skill's table; treated as 🔴 **Critical**: sealed at deploy, holding other people's money |
| Upgrade authority | Removed at mainnet deploy (`--final`, `README.md`). No admin key, no config, no pause, no fee. On devnet it stays on the deploy key |

## High-risk decisions

Each is Carlos's, on purpose, and none can be changed after deploy. 1 to 6 are v1's, unchanged
(`../security-checklist.md`): sealed; the creator sets a release gate (the timer); the arbiter may
be anyone, a party included; every way out pays the whole balance; anyone may send `mark_funded`,
`timer_release`, `recover_late` and `sweep_rent`; any classic mint.

7. **Either party can turn the timer off, alone.** An objection before the timer is due ends it for
   good. So a timer no longer guarantees the side it names anything: it pays that side only if the
   other side stays silent until it is due. After an objection with no arbiter named, the money
   moves only when the parties agree; each side alone can still give (release everything to the
   other), so the program never strands it, but neither side can take it.
8. **The sweep pays whoever fronted the rent, not the person who opened the escrow.** When a fee
   payer fronts the rent and charges the person for it (Kora, as `feepayer/` runs it), what the
   rent cuts free later goes to the fee payer's key, which was already paid for it. Intended
   (Carlos, 2026-09-30): the fee payer keeps it and says so plainly to people. See Known limit 3.

## Shared base, sections 1 to 31

### 1. Account and identity validation

- **1.1 Signer checks. Applied.** As v1, and `object`'s party is an Anchor `Signer`, then compared
  to the recorded buyer and seller in the handler (`NotAnObjector`). `object` by a stranger, the
  arbiter, the fee payer, and the buyer's key unsigned are refused
  (`the_wrong_signer_is_refused_for_every_instruction`,
  `a_stranger_or_the_arbiter_cannot_object_but_an_arbiter_who_is_a_party_objects_as_that_party`).
- **1.2 Ownership checks. Applied**, as v1: `Account<Escrow>` everywhere, `object` included.
  `substitution_an_escrow_shaped_account_owned_by_another_program_is_refused`.
- **1.3 Account data matching. Applied.** v1's constraints, and `sweep_rent` now `has_one = payer`:
  a sweep to the creator, the seller or a thief is refused
  (`sweep_pays_only_the_recorded_payer_and_only_from_an_escrow`,
  `a_sweep_returns_rent_above_the_minimum_to_the_payer_and_never_goes_below_it`). The deposit
  account's rent still takes `has_one = rent_recipient` (the creator)
  (`rent_goes_back_to_the_creator_and_a_sweep_to_the_payer`).
- **1.4 Type cosplay. Applied**, as v1. v2's account has v1's discriminator (`account:Escrow`) and
  another size; each program accepts only accounts it owns, so neither can read the other's.
- **1.5 Reinitialization. Applied**, as v1 (`reinit_…`).
- **1.6 Writable checks. Applied.** `object` writes only the escrow; the party is read-only.

### 2. PDAs

**Applied, as v1.** One PDA type, `["escrow", creator, id]`, canonical bump stored at `init`. v2's
program id differs from v1's, so the same seeds land at different addresses under the two.

### 3. Arithmetic and logic

- **3.1 Checked math. Applied**, as v1. `object` adds no arithmetic: it compares `now` with
  `timer_due`, whose `checked_add` is v1's.
- **3.2 Multiply before divide. Applied**, as v1.
- **3.3 Slippage. Does not apply.**
- **3.4 Lamport balance. Applied.** The deposit account's rent to the creator at every ending, both
  rents to the creator at `close_unfunded`, the excess above the escrow account's minimum to the
  recorded payer at `sweep_rent`, a re-created deposit account's to the buyer. Each destination is
  recorded at creation. The sweep subtracts from the escrow and adds to the payer, then asserts the
  escrow holds exactly its minimum. Tested with a sponsor that is neither party nor the transaction's
  fee payer, to the lamport, and by `close_unfunded_after_a_sweep_returns_the_excess_to_the_payer_and_the_rest_to_the_creator`.

### 4. Duplicate mutable accounts

**Applied.** v1's reasoning for every way out. New: in `sweep_rent` the payer cannot be the escrow
(the payer signed `create`; the escrow is a program-derived address and cannot sign). The payer may
be the creator, or the transaction's fee payer; it only receives lamports.

### 5. CPIs

**Applied, as v1.** `object` makes no CPI.

### 6. Storage and lifecycle

- **6.1 Sizing. Applied.** `Escrow::LEN` = 297 (v1's 256, then 32 + 1 + 8), written field by field
  with a compile-time assertion; the harness asserts the account is `8 + 297` bytes on every read.
- **6.2 Rent exemption. Applied**, as v1; the sweep leaves exactly the minimum.
- **6.3 Closing. Applied**, as v1.
- **6.4 Sysvars. Applied:** `Clock::get()`, `Rent::get()`.

### 7. Token-2022

**Refused entirely**, as v1, with the same deviation (`token::transfer`), for the same reason.

### 8. Transaction model

- **8.1 Atomicity. Applied.** An objection and the timer in one transaction, in either order, revert
  together (`an_objection_from_the_moment_the_timer_is_due_is_refused`); two objections in one
  transaction too (`an_escrow_takes_one_objection`).
- **8.2 Compute. Applied.** `object` is about 4,000 units; the heaviest instruction and the one tap
  are v1's (`README.md`).
- **8.3, 8.4. Do not apply.**

### 9. Safe Rust

**Applied, as v1.** No `unsafe`, no `unwrap`, no `remaining_accounts`.

### 10. The curiosity principle

**Applied** as `adversarial.rs` and `objection.rs`: an objection at the due second and after it,
beside the timer in one transaction in both orders, twice in one transaction, by a key that is both
arbiter and seller, before any money, on an escrow with no timer, on one whose funding nobody marked.

### 11, 12. Oracles, fees. Do not apply.

### 13. Dust and time-limited accounts

**Applied, as v1.** An objection blocks no close: `close_unfunded` runs on an objected, part-paid
escrow (`an_objection_before_the_money_or_the_mark_turns_the_timer_off_all_the_same`).

### 14. Coupled fields. Applied.

`end` writes status, `ended_at`, outcome, both amounts, and `funded_at` when nobody marked it,
together, for every way out. `object` writes the objection and its time together.

### 15. Shared positions. Does not apply.

### 16. Clock. Applied.

One unit, unix seconds; days are `× 86,400` in one place (`Escrow::timer_due`), which both `object`
and `timer_release` read.

### 17. Mint integrity. As v1.

### 18. Input validation. As v1.

`object` takes no arguments.

### 19. Type narrowing. Applied.

`objected_at` is `i64` in the account and the event, like every time.

### 20. Events. Applied.

Seven fixed-size events. `Ended` carries `funded_at`, `RentSwept` the payer, `Objected` the side
and the time; the account holds the same numbers. The client counts an event only when the
runtime's own log lines say the escrow program wrote it, as v1's.

### 21. Reward accounting. Does not apply.

### 22. Withdrawal paths. Applied.

As v1. An objection removes one way out (the timer) and no other: after one, each party alone can
still end a funded escrow by giving, both can split, the arbiter can decide, and an unfunded one
still closes (`after_an_objection_the_parties_agreeing_or_the_arbiter_end_it`).

### 23. Token-2022 extensions. Does not apply.

### 24. Access control

- **24.1 Lockups. Does not apply.**
- **24.2 Admin rotation. Does not apply:** no admin key.

### 25. Stack frames. Applied.

No stack-offset warning from `cargo build-sbf`; every instruction runs under LiteSVM and on devnet.

### 26. State machine and lifecycle

- **26.1 Sentinel timestamps. Applied.** Neither a zero `funded_at` nor a zero `objected_at` is ever
  read to decide anything: the timer reads the `Funded` status, the ending reads the status to
  decide whether to write the funding time, and the objection has its own byte (`Objection`), so
  an objection made at a zero clock still counts.
- **26.2 One cleanup for every terminal path. Applied:** `pay_out` then `end`, for all five ways
  out; `end` now also writes the funding time, once, for all of them.
- **26.3 Zero after draining. Applied**, as v1.
- **26.4 Allowlists. Applied:** `object` needs `live()` (open or funded); the timer needs funded and
  no objection.
- **26.5 Sub-state. Applied.** The objection is kept apart from the status, and no transition
  resets it: it survives the mark and the ending, and is on the receipt
  (`after_an_objection_…`, `an_objection_before_the_money_…`).
- **26.6 One deadline source. Applied:** `timer_due` is the single deadline. `object` requires
  `now < due`; `timer_release` requires `now >= due`. At no second can both land, and at every
  second after the mark one of them can, until an objection lands
  (`either_side_objects_before_the_timer_is_due_and_then_the_timer_never_runs`,
  `an_objection_from_the_moment_the_timer_is_due_is_refused`).
- **26.7 Absorbing terminal state. Applied.** An ended escrow refuses `object` as it refuses every
  way out (`an_escrow_ends_once`).

### 27, 28. Slippage, bonding curves. Do not apply.

### 29. Permissionless initialization and user parameters

- **29.1 Front-runnable initialization. Applied**, as v1.
- **29.2 User-controlled parameters. Applies, by decision:** High-risk decisions 2 and 7.
  Reachability holds: while an escrow is live, each party alone can always end it by giving,
  whatever the options and whether or not anyone objected.
- **29.3, 29.4 Config. Do not apply.**

### 30. Withdraw and drain. Applied, as v1.

### 31. Miscellaneous

- **31.3 Unclosed accounts lock rent. Applied as designed:** the receipt stays; `sweep_rent`
  returns what the cuts free, to the payer.
- **31.4 Recipients. Applied**, as v1. The payer receives only lamports; see Known limit 4.
- **31.7 Repeated actions resetting time. Applied:** `mark_funded` runs once; `object` runs once
  (`AlreadyObjected`) and never moves the mark, so neither can restart or delay anything.
- **31.1, 31.2, 31.5, 31.6.** As v1.

## anchor.md

- **§1.1 Account types.** v1's unchecked accounts, with the same `/// CHECK:` reasons, and one
  renamed: `sweep_rent`'s recipient is `payer`, the key recorded at creation, by `has_one`; it only
  receives lamports. `object` has none.
- **§2.4 `init_if_needed`.** Used twice, as v1, each checked.
- **§2.5 `close`.** `close_unfunded`, to the creator, as v1.
- **§6 Errors.** `#[error_code]`, 29 errors: v1's 25 at their numbers, then `NotAnObjector`,
  `AlreadyObjected`, `TimerDue`, `Objected`.
- **§8 Tooling.** Anchor 1.2; `overflow-checks = true`; no warning.

## LiteSVM checklist (litesvm.md §9)

- **Happy path with full state. Done:** every way out, the objection, the sweep to the payer, the
  funding time in the one tap and in the invoice paid in one tap and in a marked invoice.
- **Wrong signer. Done**, `object` included.
- **Re-initialization. Done**, as v1.
- **Before and after a deadline. Done:** the objection a second before the timer is due, at due, a
  second after; the timer a thousand days after an objection.
- **Over-limit arithmetic. Done**, as v1.
- **Closure verified. Done.**
- **Compute units logged. Done** (`README.md`); each measuring test prints its own table, as v1.

## Known limits

v1's limits 1 to 7, 9 to 11, 14 and 15 hold for v2 unchanged (`../security-checklist.md`): frozen
token accounts; options nobody checked; a party key nobody controls; a part payment closed under the
buyer and a reused deposit address; an overpayment follows the balance; a party's standard account
must exist to be paid; `recover_late` checks who holds the buyer's standard account; tokens of
another mint are lost; self-minted tokens; a one-sided receipt; unaudited; refunds in SOL. Limit 8
(SOL sent to an escrow's address) now goes to the payer, not the creator: 4 below. Limit 12 (Solana
Pay to a program-derived address) is now the app's: the client builds no pay link. Limit 13 (the
fuzzer's SBPF v0 build) does not apply: v2 has no fuzzer yet (6 below). New in v2:

1. **An objection makes the timer a default, not a promise** (High-risk decision 7). A seller who
   works under a timer to itself can have it turned off the day before it is due; a buyer who pays
   under a refund timer to itself can too. The client's `optionsNotAgreed` still reports the timer;
   what an app says about it is the app's.
2. **A deadlock holds the money.** After an objection, with no arbiter, if neither side gives and
   they do not agree, the money stays in the deposit account for good. v1 had the same with no
   timer; v2 has it whenever someone objects. Nothing in the program can break it.
3. **The fee payer gets the sweep, by decision.** With Kora as the payer, the rent excess goes to
   Kora's key, which already charged the person, in dollars, for the whole deposit at the old rate.
   Intended: the fee payer keeps refunds from Solana's rent cuts and says so to people; the line
   "charges exactly what it spends" is updated to match in the services' repo. A product that wants
   the person to get it back makes the person's own key the payer, which then needs SOL.
4. **A sweep into a closed payer account can fail.** If the payer's account holds nothing (a
   one-time sponsor key emptied), a sweep that would leave it below an empty account's rent-exempt
   minimum fails, and can be sent again once more has built up (v1's limit 8, now the payer's).
5. **An objection sent late may land after the deadline.** The chain's clock decides; the client's
   `canObject` reads the local clock.
6. **Not carried over:** the Trident fuzzer and the local-validator test. Left to later sessions,
   as decided: the CI workflow does not build or test v2 (`.github/workflows/checks.yml`), and the
   fee payer's configuration and the index do not know v2's program id yet.

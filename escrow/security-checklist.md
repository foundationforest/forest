# Security checklist: the Forest escrow, v1

Written with the safe-solana-builder skill (Frank Castle's, copied unchanged into
`.claude/skills/safe-solana-builder/` by the plan-update session): every rule in its
`references/shared-base.md` (sections 1 to 31), `references/anchor.md` and `references/litesvm.md`,
how this program applies it or why it does not apply, and every limit known today. The program is
`program/src/`; the tests named here are in `program/tests-litesvm/tests/` and
`program/trident-tests/`. Nothing here is shipped, and no paid review has happened.

| | |
|---|---|
| Program | `forest_escrow`, v1, `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT` for local work |
| Framework | Anchor 1.2, `cargo build-sbf` (Solana CLI 4.2.2, platform-tools v1.54), no IDL |
| Testing | LiteSVM (51 tests), a local validator (the client's `test:validator`, and `feepayer/`'s local test through Kora), a Trident fuzzer (thirteen invariants) |
| Risk level | 🟡 Medium by the skill's table (a simple escrow: token transfers, basic CPI, PDAs, no admin). Treated as 🔴 **Critical**, because it is sealed at deploy and holds other people's money, so this checklist carries a High-Risk Decisions section. |
| Upgrade authority | Removed at mainnet deploy with `solana program set-upgrade-authority --final` (`README.md`). No admin key, no config, no pause, no fee. A v2 is a new program at a new address. |

## High-risk decisions

Each is Carlos's, on purpose, and none can be changed after deploy.

1. **Sealed.** No upgrade, no pause, no admin. A bug found after deploy stays in every escrow made
   on this version; the only remedy is a new program for new deals.
2. **The creator sets a release gate** (skill §29.2 says release gates should be protocol-defined).
   The timer is chosen at creation by whichever party opens the escrow: any number of whole days
   from 1 to 65,535, to either side. It is off by default, it is in the account and the `Created`
   event, and the other side sees it before working or paying (the client's `optionsNotAgreed`).
   Once the funding is marked it cannot be moved: `mark_funded` runs once, and the timer counts
   from that moment only (§31.7).
3. **The arbiter may be anyone, a party included.** A buyer who names itself arbiter can split any
   way it likes, alone. The seller sees it before working (`optionsNotAgreed` reports the arbiter as
   the other party's key). Pinned by `the_arbiter_signs_any_split_and_may_be_anyone_a_party_included`.
4. **Every way out pays the whole balance.** No excess rule: a payment above the amount goes where
   the rest goes. The client's pay link asks only for what is missing and refuses once it is there.
   Pinned by `finding_an_overpayment_goes_wherever_the_way_out_sends_the_balance`.
5. **Anyone may send `mark_funded`, `timer_release`, `recover_late` and `sweep_rent`.** Each moves
   money or lamports only to destinations fixed at creation (the standard account of the side the
   timer names, the buyer's standard account, the creator), and needs no signature.
6. **Any classic SPL Token mint is accepted,** including one the buyer minted itself; which tokens
   count is the index's call. Pinned by `finding_a_self_minted_token_makes_a_receipt_that_looks_like_real_money`.

## Shared base, sections 1 to 31

### 1. Account and identity validation

- **1.1 Signer checks. Applied.** Every authority is an Anchor `Signer`: the creator, whose key
  the escrow's address is derived from, and the payer (`create`), the buyer (`release_to_seller`, `split`), the seller (`release_to_buyer`, `split`),
  the arbiter (`arbitrate`), the closer (`close_unfunded`), the caller (`recover_late`, who pays for
  an account). Each is then compared to the key recorded at creation, in the handler, with its own
  error (`NotTheBuyer`, `NotTheSeller`, `NotTheArbiter`, `NotACloser`, `NotAParty`). `mark_funded`,
  `timer_release` and `sweep_rent` take no signer by design. Tested for every instruction by
  `the_wrong_signer_is_refused_for_every_instruction` and, in the fuzzer, I5 and I7; the creator's
  signature at `create` by `the_escrow_address_is_the_creators_and_nobody_can_open_someone_elses`
  and fuzzer I13.
- **1.2 Ownership checks. Applied.** The escrow is `Account<Escrow>` (owned by this program),
  token accounts and the mint are `anchor_spl::token` types (owned by the classic token program),
  programs are `Program<…>`. The unchecked accounts are listed under anchor.md §1.1 below, each with
  why it is safe. Tested by `substitution_an_escrow_shaped_account_owned_by_another_program_is_refused`
  and `substitution_payout_accounts_of_the_wrong_mint_owner_or_program_are_refused`.
- **1.3 Account data matching. Applied.** `has_one = vault` and `has_one = rent_recipient` on every
  way out, `close_unfunded` and `sweep_rent`; `has_one = buyer` and `has_one = mint` in
  `recover_late`; the buyer's account by `address = escrow.refund_address()`, the seller's by
  `address = escrow.payout_address()`; the timer's one account by the same two addresses, by side,
  in the handler. Tested by the `substitution_…` tests,
  `a_payout_lands_only_at_the_receiving_partys_standard_account` and
  `rent_goes_back_to_the_creator_never_to_whoever_fronted_it`.
- **1.4 Type cosplay. Applied.** Anchor's eight-byte discriminator on `Escrow`; token accounts by
  owner, length and initialized state (`spl_token` unpack).
- **1.5 Reinitialization. Applied.** `init` on the escrow account. An escrow that held the amount is
  never closed, so its address can never be opened again; one that never held it is closed whole.
  `init_if_needed` is used twice, both justified under anchor.md §2.4. Tested by
  `reinit_create_on_a_live_escrow_is_refused` and `reinit_an_ended_escrows_address_never_holds_a_second_deal`.
- **1.6 Writable checks. Applied.** Every account the program writes is `mut`; the deposit account
  is read-only in `mark_funded`, the escrow read-only in `recover_late`.

### 2. PDAs

- **2.1 Canonical bumps. Applied.** `seeds` and `bump` at `init` find the canonical bump; it is
  stored in `bump` and used for every signature after. The escrow account is trusted afterwards by
  owner and discriminator, which only this program can produce at an address it derives.
- **2.2 PDA sharing. Applied.** One escrow per `["escrow", creator, id]`, the creator signing; its
  deposit account is its own associated token account. No shared vault. Every signature the escrow
  makes uses the same seeds, the creator's key read back from the stored side (`creator_key`).
- **2.3 Seed collisions. Applied.** The seeds are a fixed tag and two fixed-length parts (32 and 8
  bytes), so no two (creator, id) pairs concatenate alike. A key that is a buyer in one escrow and a
  seller in another opens both from one id space. Tested by `pda_the_two_programs_cannot_share_an_address`.
- **2.4 Purpose isolation. Applied.** One PDA type.

### 3. Arithmetic and logic

- **3.1 Checked math. Applied.** A split is computed in 128 bits (`share`: a 64-bit balance times at
  most 10,000 cannot overflow), the buyer's part by `checked_sub`, the timer by `checked_add`
  (`TimeOverflow`). `Closed`'s rent sum uses `saturating_add`: two accounts' lamports cannot reach
  `u64::MAX`. `sweep_rent` uses `saturating_sub`, where a floor of zero is the rule (nothing to
  sweep). `overflow-checks = true` in the release profile.
  Tested at 1 base unit and at `u64::MAX` by `arithmetic_splits_at_the_edges_add_up_and_never_overflow`.
- **3.2 Multiply before divide. Applied** in `share`.
- **3.3 Slippage. Does not apply:** nothing is priced or swapped. The nearest thing, a split's
  percentage, is signed by the parties or the arbiter named at creation.
- **3.4 Lamport balance. Applied.** Rent goes only to the creator, recorded at creation as the rent
  recipient (the deposit account's at every ending, both rents at `close_unfunded`, the excess at
  `sweep_rent`), never to whoever fronted it; a re-created deposit account's goes to the buyer.
  Tested by `rent_goes_back_to_the_creator_never_to_whoever_fronted_it`; fuzzer I3, which names the
  payer in the rent slot now and then and expects a refusal.

### 4. Duplicate mutable accounts

**Applied.** Anchor 1.2 refuses duplicate mutable `Account` fields, and skips `UncheckedAccount`.
The unchecked ones are pinned by address or by `has_one`, and no two of them can be the same
account: the buyer's and the seller's standard accounts are two different derivations (buyer and
seller differ), the rent recipient is a key that signed `create` and so is not either of those
program-derived addresses, nor the escrow, nor its deposit account. The last version's one case (a
buyer's standard account handed to the seller, named in both payout slots) is gone: the seller's
slot now takes only the seller's own standard address. The rent recipient may be the same key as a
signer (the buyer releasing its own escrow); the runtime passes one account for both, and it only
receives lamports.

### 5. CPIs

- **5.1 Program ids. Applied.** `Program<Token>`, `Program<AssociatedToken>`, `Program<System>`.
  Token-2022 passed as the token program is refused (`InvalidProgramId`), tested.
- **5.2 Reload after CPI. Applied:** no decision reads an account a CPI changed. The deposit
  account's lamports are read before its close, and token transfers do not change lamports.
- **5.3 Signer pass-through. Applied.** The token-program CPIs pass only the deposit account, the
  destination and the escrow as authority; no party's signature is forwarded.
- **5.4 SOL around CPIs. Does not apply:** the only CPIs are to fixed programs that take no SOL
  from a signer, apart from Anchor's own rent transfers at `init`.
- **5.5 Ownership after CPI. Does not apply:** no CPI can reassign an account this program trusts.
- **5.6 Errors propagate. Applied:** every CPI ends in `?`.
- **5.7 `invoke_signed` only for PDAs. Applied:** only the escrow signs, for its own deposit account.
- **5.8 Isolation. Applied:** a deposit account per escrow; an exploit of one escrow reaches no other.

### 6. Storage and lifecycle

- **6.1 Sizing. Applied.** `Escrow::LEN` = 256, written out field by field, with a compile-time
  assertion; the space is `8 + LEN`.
- **6.2 Rent exemption. Applied.** `init` funds the minimum; `sweep_rent` leaves exactly it, and
  refuses when the account is at or below it (`NothingToSweep`). Tested by
  `a_sweep_returns_rent_above_the_minimum_and_never_goes_below_it`; fuzzer I10.
- **6.3 Closing. Applied.** `close = rent_recipient` (the creator) for the escrow account in `close_unfunded`
  (zeroed, drained, reassigned); the deposit account by the token program's `close_account`. A
  receipt is never closed, by design. Tested with `assert_closed` (no lamports, no data, owned by
  the system program).
- **6.4 Sysvars. Applied:** `Clock::get()` and `Rent::get()`, never an account passed in.

### 7. Token-2022

**Refused entirely,** which the skill allows for a program that never meets it. The mint is
`anchor_spl::token::Mint` (owned by the classic token program), refused otherwise with
`AccountOwnedByWrongProgram`; the token program is `Program<Token>`. **Deviation:** `token::transfer`
rather than `transfer_checked`. `transfer_checked` would add the mint to every way out, and it
checks nothing the classic program does not already check here: that the source and destination
hold the same mint. Tested by `a_token_2022_mint_and_wrapped_sol_are_refused`.

### 8. Transaction model

- **8.1 Atomicity. Applied.** One-tap Pay is the deposit address made, `create`, a transfer and
  `release_to_seller` in one transaction; two ways out in one transaction revert together
  (`an_escrow_ends_once`).
- **8.2 Compute. Applied.** No loop over input beyond the two payouts. The heaviest single
  instruction measured is 49,736 units, the one tap 70,950 (`README.md`).
- **8.3 Address lookup tables. Does not apply.**
- **8.4 Durable nonces. Does not apply.**

### 9. Safe Rust

- **9.1 `vec![0; N]`. Does not apply** to the program.
- **9.2 No `unsafe`. Applied.**
- **9.3 `remaining_accounts`. Not used.**
- **9.4 No `unwrap` or `expect` on input. Applied:** none in the program. The one cast is
  `share`'s 128-to-64-bit narrowing of a value no greater than the balance.

### 10. The curiosity principle

**Applied** as `adversarial.rs`: the same account twice, another program's account, a Token-2022
mint and program, a look-alike deposit account, another escrow's deposit account, a replayed
signature, a timer marked and fired together, a front-run address.

### 11. Oracles. Does not apply.

### 12. Fees. Does not apply: the escrow charges nothing.

### 13. Dust and time-limited accounts

**Applied.** Dust cannot block a close: every way out pays the whole balance before the deposit
account closes, and `close_unfunded` returns whatever is there. Money sent to a closed never-funded
escrow's address waits for the same creator to reopen the id, which adopts it. Nothing expires, so
nothing needs closing by a stranger: a never-funded escrow can be closed by either party at any
time; a funded one is the parties' money and ends only by their ways out. Whoever fronted the rent
cannot close anything: the rent is the creator's.
`init_if_needed` is justified under anchor.md §2.4.

### 14. Coupled fields. Applied.

One helper, `end`, writes status, time, outcome and both amounts together for every way out;
`mark_funded` writes the status and the time together.

### 15. Shared positions and pools. Does not apply.

### 16. Clock. Applied.

One unit, unix seconds; days are `× 86,400` in one place (`Escrow::timer_due`).

### 17. Mint integrity

**Applied as far as it goes.** A classic mint cannot be closed and reopened (only Token-2022 has a
close authority), and the program uses no decimals. **Not applied:** the mint's freeze authority,
which is under "Known limits".

### 18. Input validation

**Applied:** amount above zero, timer days above zero (the `u16` bounds the top), no zero keys,
buyer and seller different, creator a party and the signer the address is derived from, mint
classic and not wrapped SOL. No strings. Any
classic mint is accepted by decision (High-risk decision 6). Tested by `bad_terms_are_refused_at_creation`.

### 19. Type narrowing. Applied.

Instruction arguments, state and events use the same types (u64 amounts, u16 days and basis
points, i64 times); the one narrowing is bounded (9.4).

### 20. Events. Applied.

Six fixed-size events with every amount; the receipt keeps the same numbers in the account, so
nothing depends on logs alone. The client counts an event only when the runtime's own log lines
say the escrow program wrote it.

### 21. Reward accounting. Does not apply.

### 22. Withdrawal paths. Applied.

Every token that enters a deposit account has a way out: a funded one by the ways out, an
unfunded one by `close_unfunded`, a late one by `recover_late`. Fuzzer I11 ends every live escrow
with the parties' signatures alone at the end of every run, and I9 returns every late payment.
**Not covered:** tokens of another mint sent to the escrow's address (see "Known limits").

### 23. Token-2022 extensions. Does not apply: Token-2022 is refused (7).

### 24. Access control

- **24.1 Lockups. Does not apply.**
- **24.2 Admin rotation. Does not apply:** there is no admin key, on purpose.

### 25. Stack frames. Applied.

`cargo build-sbf` reports no stack-offset warning, and every instruction runs under LiteSVM.

### 26. State machine and lifecycle

- **26.1 Sentinel timestamps. Applied.** A zero `funded_at` never enters arithmetic: the timer
  reads the `Funded` status, and only then the time.
- **26.2 One cleanup for every terminal path. Applied:** `pay_out` then `end`, for all five ways out.
- **26.3 Zero after draining. Applied:** the deposit account is closed after the payout, and the
  token program refuses to close it while anything is left, so an ending that does not pay the
  exact balance reverts whole.
- **26.4 Allowlists. Applied:** `live()` is open or funded; `mark_funded` needs open; the timer
  needs funded; `recover_late` needs ended.
- **26.5 Sub-state. Does not apply.**
- **26.6 One deadline source. Applied:** there is one time gate, `timer_due`.
- **26.7 Absorbing terminal state. Applied.** An ended escrow accepts only `recover_late` and
  `sweep_rent`, and neither changes its bytes. Tested by `an_escrow_ends_once`; fuzzer I4 and I8.

### 27. Slippage and fee ordering. Does not apply.

### 28. Bonding curves and AMMs. Does not apply.

### 29. Permissionless initialization and user parameters

- **29.1 Front-runnable initialization. Applied.** The escrow's address is
  `["escrow", creator, id]`, and the creator signs `create`. So nobody can open an escrow at an
  address another key will use: a front-runner's `create` lands at the front-runner's own address,
  or is refused (`ConstraintSeeds` aimed at someone else's, `AccountNotSigner` without the key).
  Tested by `nobody_can_open_the_address_a_buyer_is_about_to_use`,
  `the_escrow_address_is_the_creators_and_nobody_can_open_someone_elses` and fuzzer I13. Anyone can
  still make the escrow's deposit account first (the associated token program lets anyone), or pay
  into it early: `create` adopts it, and the one who did pays for nothing that is theirs.
- **29.2 User-controlled parameters. Applies, by decision:** see High-risk decision 2. Reachability
  holds: while an escrow is live, each party alone can always end it (the buyer by giving, the
  seller by giving back), whatever the options; fuzzer I11.
- **29.3 and 29.4, config. Do not apply:** there is no config.

### 30. Withdraw and drain. Applied.

Every way out drains the whole balance and closes the deposit account; nothing is reserved.

### 31. Miscellaneous

- **31.1 Shared config. Does not apply.**
- **31.2 Stack. See 25.**
- **31.3 Unclosed accounts lock rent. Applied as designed:** the deposit account closes at every
  ending; the receipt stays on purpose, and `sweep_rent` returns what the rent cuts free.
- **31.4 Recipients that can receive and move tokens. Applied:** each party is paid at its
  standard account for the mint; each holder can move what it gets. A party who has handed that
  account to another key sends its own payouts there, and blocks nothing
  (`a_party_who_hands_its_standard_account_away_blocks_no_way_out`).
- **31.5 Token-2022 mint space. Does not apply.**
- **31.6 Signer-as-new-account. Does not apply:** PDAs only. The PDA analogue is 29.1, now applied.
- **31.7 Repeated actions resetting time. Applied:** `mark_funded` runs once (`AlreadyFunded`), so
  the timer can be neither restarted nor delayed.

## anchor.md

- **§1.1 Account types.** Every unchecked account has a `/// CHECK:` comment:
  - `rent_recipient` (every way out, `close_unfunded`, `sweep_rent`): the creator's key, recorded
    at creation, by `has_one`; it only receives lamports.
  - `buyer_tokens` (`release_to_buyer`, `split`, `arbitrate`, `close_unfunded`): the buyer's
    standard account, by address; the token program checks it when it pays it. Unchecked so it
    must exist only when the buyer is paid.
  - `seller_tokens` (`release_to_seller`, `split`, `arbitrate`): the seller's standard account, by
    address, the same way.
  - `to` (`timer_release`): checked in the handler, by address, against the standard account of the
    side the timer names.
  - `buyer` (`recover_late`): the recorded key, by `has_one`; it receives the re-created deposit
    account's rent.
- **§2.1 to 2.3 Constraints.** `has_one`, `token::`, `associated_token::`, `address`, and `seeds` with
  `bump` at `init`.
- **§2.4 `init_if_needed`.** Used twice, each checked:
  - the deposit account at `create`: only the associated token program can make an account at that
    address, and only as a token account of this mint held by the escrow, whose authority only this
    program uses. So a pre-existing one can differ only in its balance, which is part of the deal;
  - the buyer's standard account at `recover_late`: Anchor checks its mint and holder when it exists.
- **§2.5 `close`.** Used in `close_unfunded`, to the creator, recorded as the rent recipient.
- **§2.6 `realloc`. Not used.**
- **§3 State.** No reload needed (5.2); `init` once; checks in handlers rather than `access_control`,
  so each rule and its error sit in the instruction's own text.
- **§4 Tokens.** Classic only; `transfer`, not `transfer_checked` (7). Decimals unused.
- **§5 CPI.** `Program<Token>`; seeds from the stored bump.
- **§6 Errors.** `#[error_code]` with a message on each of 24 errors; the `require!` family throughout.
- **§8 Tooling.** Anchor 1.2 against platform-tools v1.54; `overflow-checks = true`; the features
  Anchor's macros test for (`custom-heap`, `custom-panic`, `anchor-debug`) are declared, so the
  build has no warnings.

## LiteSVM checklist (litesvm.md §9)

- **Happy path, with full state verified. Done:** every way out with exact token balances, rent,
  the receipt's fields and the event.
- **Wrong signer. Done:** for every instruction that takes a signer.
- **Re-initialization. Done:** over a live escrow and over an ended one's address.
- **Before and after a deadline. Done:** the timer is refused a second early and runs at due, for
  both sides and at 65,535 days.
- **Over-limit arithmetic. Done:** `BadSplit` at 10,001 and 65,535, splits at 1 unit and at `u64::MAX`.
- **Closure verified. Done:** no lamports, no data, owned by the system program.
- **Token balances after every transfer. Done.**
- **PDA seeds written down. Done,** in the harness beside each derivation.
- **`expire_blockhash` after every transaction. Done** (`Harness::send_tx`).
- **Failures asserted without `unwrap`. Done** (`expect_err` and the error name).
- **Compute units logged. Done** for every instruction and the one tap. **Deviation:** each
  measuring test prints its own table rather than a `zz_cu_summary` test, so the table does not
  depend on the order tests run in.

What LiteSVM does not show is covered by the local-validator test (`client/test/validator.test.ts`:
three deals built by the client and sent through `solana-test-validator`, the buyer and the seller
holding no SOL) and by `feepayer/`'s local test (the same builders through Kora, which co-signs and
charges each storage deposit to the person once). Trident's runtime checks
no signatures, so the fuzzer's signer rules hold on key comparisons alone; LiteSVM checks the real
signatures.

## Known limits

Each is reported, not fixed, because fixing it would change a rule Carlos decided or add one. The
ones marked open are questions in `docs/changes/escrow.md`.

1. **A frozen token account.** A classic mint's freeze authority (USDC has one) can freeze:
   - the deposit account, which stops every way out until it is thawed, since each moves tokens out
     of it (a `close_unfunded` that returns something too; one with nothing to return was not tried);
   - the buyer's standard account, which stops every way out that pays the buyer anything; the ones
     that pay the buyer nothing still run (`finding_a_frozen_buyer_account_blocks_only_the_ways_out_that_pay_the_buyer`);
   - the seller's standard account, which, by the same rule, stops every way out that pays the
     seller anything (tested for the buyer; the seller's slot is checked the same way). The last
     version let the seller name another account; this one does not.
2. **Options nobody checked.** The program runs any option its creator set. A seller who works
   without reading the escrow can lose to a buyer's one-day timer to itself, and a buyer who pays
   without reading an invoice can lose to a one-day timer to the seller. `optionsNotAgreed` exists
   for this; the program cannot know what was agreed (`finding_an_invoice_with_a_short_timer…`,
   `finding_a_buyers_short_timer…`).
3. **A party named as the escrow itself.** Nothing stops a creator naming the escrow's own address
   as the other party. That party's standard account is then the deposit account, so every way out
   that pays it anything fails, and money paid in leaves only by one that pays it nothing (an
   arbiter's split to the other side, or a timer to the other side, if the creator set either).
   A buyer who does this locks its own money. An invoice naming the escrow as its buyer locks the
   money of whoever pays it without checking it names them, which the app checks before paying.
   The last version had the same gap. Found in this round's review; not tested; open.
4. **A part payment can be closed under the buyer** by the seller, at any time. The part comes
   back; a second part sent to the closed address waits for the creator to reopen the id
   (`finding_a_part_payment_can_be_closed_under_the_buyer_by_the_seller`).
5. **An overpayment follows the balance** (High-risk decision 4).
6. **A party's standard account must exist to be paid.** A seller who has never held the token has
   none: whoever sends the way out makes it first, at their own cost
   (`makeStandardAccountIx`; anyone may). A timer to that seller waits until someone does.
7. **`recover_late` checks who holds the buyer's standard account** (Anchor's create-if-missing
   does), so a buyer who hands that account away blocks its own late money there, and nothing else
   (`finding_a_buyer_who_hands_its_standard_account_away_blocks_its_own_late_money`). Unchanged from
   the last version, as asked.
8. **SOL sent to an escrow's address** goes to the creator by `sweep_rent`, not to whoever sent
   it; the program cannot tell it from rent. A sweep into a wallet that holds no SOL fails unless it
   leaves that wallet at least at the rent-exempt minimum of an empty account (128 bytes' worth);
   it can be sent again once more has built up. Every other refund is larger than that minimum at
   any rate, since the deposit account is 165 bytes and the escrow 256.
9. **Tokens of another mint sent to an escrow's address** are lost to everyone: the escrow's
   associated token account for that mint has no way out, since nothing here signs for it.
10. **Self-minted tokens** make receipts of any size (High-risk decision 6).
11. **A one-sided receipt.** A buyer can release money to a seller who never signed anything, for one
    base unit. The receipt says the buyer created it; an index weighs it as one-sided.
12. **Solana Pay to a program-derived address** has not been tried in a wallet on a phone.
13. **SBPF v0.** The program builds as SBPF v0. Once SIMD-0500 activates (no more v0 deploys), a
    sealed v1 must already be deployed, or be rebuilt for a later SBPF version, which nobody has
    tried with this program.
14. **Unaudited.** No paid review, no lawyer pass; `docs/handoff.md`'s "Before mainnet" stands.
15. **Refunds arrive in SOL.** In a fee payer's app the creator's wallet may hold no SOL, and pays
    for each storage deposit in dollars. The refund comes back as SOL in that wallet. How the app
    shows or uses it, without saying "SOL", is the app's choice and open.

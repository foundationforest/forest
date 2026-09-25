# Escrow: money out only when both agree

The parallel escrow session's log (see "Building in parallel" in the handoff), for the
consolidation session to fold into `docs/changes.md` and `docs/handoff.md`.

## 2026-09-25: the escrow rewritten to "Escrow" in the handoff

- **Task,** from Carlos: rewrite the escrow program, its client, tests and fuzzer to the handoff's
  new Escrow section (money in, and out only when the two sides agree; every option off by
  default), using the safe-solana-builder skill, and write its security checklist. One pull
  request. No deploy.
- **Base.** This branch starts from `main` at `77dfeed`. The spec (the handoff's new "Escrow"), the
  skill (`.claude/skills/safe-solana-builder/`) and the post lexicon's new `#terms` are on the
  unmerged `claude/wonderful-dirac-2b7ysa` ("Plan update: no-clock escrow…"), read from there. The
  pull request touches only `escrow/` and this file.
- **Decided (by Carlos, given in the task; written here):**
  - The ways out once funded: `release_to_seller` (the buyer signs), `release_to_buyer` (the
    seller signs), `split` (both sign, any split), `arbitrate` (only if an arbiter was named; it
    signs any split), `timer_release` (only if a timer was set; anyone, once N days have passed
    since funding; everything to the side it names), and `close_unfunded` for a never-funded escrow
    (either party or the rent payer, any time, rent to the rent payer). Everything else is removed:
    acceptance, invoices-as-acceptance, service time, the silence clock, objection and locks,
    cancellation steps, withdraw-before-accept, the unaccepted timeout.
  - Kept: create by either party (a seller-created escrow is an invoice), the deposit address,
    `mark_funded` by anyone, the permanent receipt, `recover_late` to the buyer's standard account,
    `sweep_rent` to the rent payer, classic SPL tokens only, wrapped SOL refused.
  - Carlos's four answers, all toward the fewest rules: money to the buyer always lands in the
    buyer's standard token account for the mint; the arbiter can be anyone, a party included; the
    escrow records an agreed amount for the receipt, but every way out pays out the whole balance
    (releases send all of it, `split` and `arbitrate` divide it by percentage; no amount limits, no
    excess rule); once a timer is due, anyone may trigger it.
  - These answer four of the escrow questions in the handoff's Open (where money to the buyer lands,
    whether the arbiter may be a party, where money above the amount goes, who may send the timer).
- **Chosen, not decided** (the simplest option; each reversible before deploy, each in
  `escrow/README.md`):
  1. **Funded means the live balance covers the amount,** checked by every way out; below it the
     only exit is `close_unfunded`. So a receipt always means the amount was held, and one-tap Pay
     needs no `mark_funded`.
  2. **`mark_funded` records a time and nothing else,** and only the timer reads it. No way out
     records the funding time, so a receipt nobody marked (every one-tap payment) says
     `funded_at` 0.
  3. **A split is in basis points** (`u16`, at most 10,000), the seller's share rounded down.
  4. **The timer is due from the second:** `now ≥ funded_at + days × 86,400`. Days are sixteen bits,
     1 to 65,535, matching the lexicon.
  5. **The buyer's account must exist only when the buyer is paid.** It is checked by address, and
     the token program checks the rest when it pays. So a never-paid escrow closes, and a split of
     everything to the seller runs, with no buyer account at all.
  6. **One `Ended` event for every way out,** with the outcome inside. Six events in all: `Created`,
     `Funded`, `Ended`, `Closed`, `RecoveredLate`, `RentSwept`.
  7. **The escrow records its creator** (buyer or seller), in the account and in `Created`, for the
     index's rule that a receipt counts fully when the seller created the escrow. It replaces
     `accepted_at`.
  8. **`timer_release` names one account,** the named side's: the buyer's by address, a seller's by
     holder and mint, checked in the handler.
  9. **Buyer and seller must differ; no key may be the zero key,** the arbiter's included (the zero
     key means "no arbiter" in the account).
  10. **`close_unfunded` has no wait for anyone.** No deadline exists.
  11. **The pay link takes the deposit account's balance and asks only for what is missing,** and
      refuses once the amount is there: an overpayment is no longer sent back by the program.
  12. **`recover_late` and `sweep_rent` are unchanged** from the last version, with their known limits.
  13. **Seller payouts stay as before:** any token account the seller holds for the mint. Only the
      buyer's rule was decided.
  14. **A fresh layout,** 256 bytes after the discriminator (was 311), fields in a new order, errors
      renumbered: nothing is deployed.
  15. **`overflow-checks = true`** in the program's release profile, and the three features
      Anchor's macros test for are declared, so the build has no warnings.
- **Built:**
  - **`escrow/program/`:** ten instructions (`create`, `mark_funded`, `release_to_seller`,
    `release_to_buyer`, `split`, `arbitrate`, `timer_release`, `close_unfunded`, `recover_late`,
    `sweep_rent`), 24 errors, six events, one `pay_out` and one `end` helper shared by all five ways
    out. The skill's header block. The build is 311,680 bytes (sha256 `88cbc548…e8cf1e` here), with
    no warnings and no stack-frame report.
  - **`escrow/program/tests-litesvm/`:** the harness and the wire format rewritten by hand; 49 tests.
    - `escrow.rs` (20): every way out with exact balances (an overpaid balance, splits at 0, 1,
      5,000, 9,999 and 10,000 basis points, the arbiter as a third key and as either party, the timer
      a second early and at due to each side and at 65,535 days, `close_unfunded` by each allowed
      closer). Every rejection asked for: the wrong signer on each instruction, `arbitrate` with no
      arbiter, `timer_release` with no timer, unmarked, early, or marked in the same transaction, a
      payout to anything but the buyer's standard account (five ways out), a Token-2022 mint,
      wrapped SOL, a double ending (in one transaction and later, with late money there), late money
      forwarded, a sweep never below the minimum. Plus the costs.
    - `adversarial.rs` (27): the attacks from adversarial review 1 that still apply, and new
      `finding_…` tests pinning what the program accepts by design (a short timer the other side
      did not set, each way; an overpayment going to the seller; a part payment closed under the
      buyer; a frozen buyer account; the timer's sender choosing the seller's account; a front-run
      address).
    - `one_tap.rs` (2): create, fund and `release_to_seller` in one transaction, measured, with its
      receipt and rent; a second payment to its link sent back.
  - **`escrow/program/trident-tests/`:** the model and flows rewritten; twelve invariants (I5, money
    leaves only with an authority named at creation, checked apart from the model's own verdict;
    I11, nothing is stuck: every live escrow ends by its parties' signatures at the end of each run;
    I12, a timer never pays early).
  - **`escrow/client/`:**
    - a builder per instruction, plus `payInOneTap`, `transferIx`, `makeStandardAccountIx` and
      `keysOf` / `keysFor`;
    - `optionsFromPost` and `termsFor` from a post's optional `terms` block;
    - `optionsNotAgreed` and `assertOptionsAgreed`, the check before a person works or pays: every
      arbiter or timer they did not set, whose key an arbiter is, and which side a timer favours;
    - `whatDiffers`, the check that an escrow is the one meant;
    - `timerDueAt`, `timerDue`, `payout`;
    - the pay link takes the balance;
    - decoding for the new account and events.
    - Tests: 17 unit tests, and the validator test running three deals (a 70/30 split of an
      overpaid balance, an invoice paid in one tap, a refund before a timer is due) plus late money
      and a sweep. `scripts/devnet.ts` and `test/devnet.test.ts` move to the new deals (an invoice
      paid in one tap; a proposal marked and split 60/40); type-checked, not run.
  - **`escrow/README.md`** rewritten: the state table, costs, what is sealed, what the app decides.
    **`escrow/security-checklist.md`:** every rule in the skill's shared base, anchor and LiteSVM
    references, the high-risk decisions, and fourteen known limits.
- **Measured** (LiteSVM, twelve runs with fresh keys):
  - one tap 42,300 to 63,300 compute units and 691 bytes; 55,800 to 84,300 and 733 bytes with the
    seller's account made in it;
  - `release_to_seller` 10,782 to 10,799; `split` 15,200 to 21,200; `create` 31,600 to 57,200;
  - a receipt's rent 1,991,360 lamports ($0.20) at 5,080 a byte and 272,832 ($0.027) at 696, 279,400
    less than before at today's rate.
- **Verified:**
  - all 49 LiteSVM tests, 17 client tests and the validator test pass;
  - the fuzzer ran 50,000 iterations of 80 flows (4,000,000 flows) in 98 seconds, exit 0, every
    instruction both accepted and refused thousands of times (`timer_release` accepted 2,753 times).
    That binary differed from the final one only in how `Closed` adds its two rents (a checked add
    became a saturating one); 10,000 iterations (800,000 flows) on the final binary, exit 0;
  - mutation checks: dropping the buyer check on `release_to_seller` and moving the timer a day
    early, applied together, failed four LiteSVM tests across two files (the wrong-signer test for
    the first, three timer tests for the second). The early timer alone made the fuzzer exit 99.
    The program was restored and rebuilt after each check.
- **Learned:**
  1. **Anyone can open the address a buyer is about to use.** The address is `["escrow", buyer,
     id]`, and whoever opens it names the seller, so a front-runner can open it as an invoice to
     itself with its own options. No money moves (one tap fails whole, the squatted escrow never held
     anything and the buyer can close it), but an app that pays apart from its own `create` must
     check `whatDiffers` first. The last version had the same address scheme.
  2. **Whole-balance payouts turn the pay link into a money question.** A second tap before the end
     now pays the seller, not the buyer back, so the link asks only for what is missing.
  3. **Anchor 1.2's duplicate-mutable-account check skips `UncheckedAccount`,** so the buyer's
     address-checked account can coincide with the seller's if the buyer handed it to the seller;
     both shares land there, nothing is corrupted. Documented in the checklist (§4), not refused:
     refusing would let a buyer block the arbiter.
  4. **The token program refuses to pay an account that does not exist with `InvalidAccountData`**:
     that is the refusal when a way out pays the buyer and its standard account is missing.
  5. **The program is smaller:** 311,680 bytes against the old devnet build's 363,120. By session
     15's own ratio, its devnet deploy costs about 1.58 SOL rather than 1.8455 (estimated, not
     measured), and `docs/devnet.md`'s escrow size, hash and cost are stale. A clean rebuild here
     gave the same bytes as the build before it.
  6. **The skill asks for a framework and a test tool first;** here both are settled (Anchor 1.2,
     LiteSVM). It asks for a `zz_cu_summary` test; each measuring test prints its own table instead,
     so the numbers do not depend on test order.
- **Open** (each a program change, possible only before deploy, unless it says otherwise):
  1. **Where the seller is paid.** Any token account the seller holds, and for `timer_release` the
     sender chooses which. Should the seller, like the buyer, be paid only at its standard account?
  2. **Whether a way out should record the funding time** when nobody marked it, so every receipt
     says when the money was there.
  3. **The front-run address** (learned 1). Keep the scheme, or derive the address from both parties
     and the id? The second would change every client and index.
  4. **`recover_late` still checks who holds the buyer's standard account** (kept unchanged, as
     asked), so a buyer who hands it away blocks only its own late money.
  5. **Frozen accounts:** a classic mint's freeze authority (USDC has one) can stop every way out by
     freezing the deposit account, or the ways out that pay the buyer by freezing the buyer's.
  6. **SOL and other-mint tokens sent to an escrow's address,** unchanged from before.
  7. **For the consolidation session** (not this session's folders):
     - the handoff's Open has four escrow questions Carlos answered here, and still lists the frozen
       account, SOL and other-mint items;
     - `docs/devnet.md` describes the old deals (accept, object, agree), size, hash and cost;
     - `docs/decisions/adversarial-review-1.md` describes the old escrow;
     - an index reads `creator` where it read `accepted_at`;
     - the handoff's build status still calls `escrow/` "the design before 'Escrow' above was
       rewritten".
  8. **`shapes/` needs nothing:** the client reads the post's `#terms` as the plan update defined it,
     and the lexicon's `timer.days` bound matches the program's sixteen bits.
- **Still standing:** as the plan update listed, with the devnet deploy and run still not done; the
  escrow half of it would now deploy this version.

## 2026-09-25, round 2: whose address, where the seller is paid, where rent goes, "Pay" through a fee payer

- **Task,** from Carlos, after the first pull request merged: four changes to the escrow, each with a
  test that fails before and passes after, every suite kept green; the fuzzer's long campaign on
  the final binary; the costs measured again; the README and checklist updated; `feepayer/`'s local
  test run end to end against the new escrow ("each deposit charged to the person once, every
  refund back to them"), editing that test only where the escrow change broke it. No deploy.
- **Base.** `main` at `6423919` (the plan update, the fee payer and carrier, and the issuer's
  request limit all merged). The pull request touches `escrow/`, this file and
  `feepayer/test/feepayer.test.ts`.
- **Decided (by Carlos, given in the task; written here):**
  1. **Nobody can take someone else's escrow address.** The address is `["escrow", creator, id]`,
     from the key of whoever opens it, and the creator signs `create`. `whatDiffers` goes, since its
     only purpose was that squatting.
  2. **The seller is paid only at its standard token account for the mint,** like the buyer, on
     every way out, the timer included.
  3. **Rent goes back to the person, never to whoever fronted it.** The creator is recorded as the
     rent recipient at creation; the deposit account's rent at every ending, both rents at
     `close_unfunded` and every `sweep_rent` go to that key. The reason: a fee payer fronts the
     deposit in SOL and charges the person for it in dollars.
  4. **The fee payer can sign "Pay":** every client builder that funds in the same transaction
     makes the deposit address first, as its own instruction (the associated token program's
     idempotent create), before `create`. One tap included.
  - These close round 1's open 1 (where the seller is paid) and open 3 (the front-run address), and
    `docs/changes/services.md`'s open 1 (option a) and open 2.
- **Chosen, not decided** (each reversible before deploy):
  1. **The field keeps its offset and changes its name:** bytes 169..201 are `rent_recipient`, always
     the creator's key, where they were `rent_payer`. It is redundant with `creator` plus the two
     party keys, and kept so `has_one` pins it and a reader need not work it out. Whoever fronted
     the rent is recorded nowhere, the `Created` event included.
  2. **`close_unfunded` is the parties' only.** The rent payer lost its right to close, since the rent
     is no longer its own (`NotACloser` for anyone else, the payer included).
  3. **`recover_late` keeps sending the re-made deposit account's rent to the buyer,** not the
     creator: that rent was fronted after the end by whoever paid late, almost always the buyer's
     wallet, not at creation.
  4. **The seller's slot is checked by address alone,** as the buyer's is: `UncheckedAccount` with
     `address = escrow.payout_address()`, the token program checking the rest when it pays. So it
     must exist only when the seller is paid something, and a split of everything to the buyer runs
     with no seller account.
  5. **Two error messages changed** (`NotACloser`, `NotTheSellersAccount`); their codes did not.
  6. **The client:** `escrowAddress(creator, id)`; `creatorKey`, `payoutAddress`,
     `makeDepositAddressIx` and `createAndFund` (the deposit address, `create`, the transfer) added;
     `payInOneTap` is `createAndFund` plus the release; `keysFor` takes an optional creator, not a
     payer; no builder takes a seller account any more; `closeUnfundedIx` refuses a closer who is
     not a party; `rentPayer` is `rentRecipient` in the account and the events. `invoice()` still
     sends `create` alone: it funds nothing.
- **Built:**
  - **The program:** the seeds, the recorded recipient, `has_one = rent_recipient` and
    `close = rent_recipient` everywhere, the seller's slot by address in `release_to_seller`, `split`
    and `arbitrate`, the timer's `to` by address for either side, `check_sellers_account` removed,
    every signature made with the creator's key (`creator_key`). 303,432 bytes, sha256
    `46ea84c2…45cc76`, no warnings.
  - **Tests first.** The harness and the three LiteSVM files were changed before the program. Against
    the round-1 binary (rebuilt from its source: the same sha256, `88cbc548…`), 24 of 51 failed,
    among them the new `the_escrow_address_is_the_creators_and_nobody_can_open_someone_elses`
    (`ConstraintSeeds`: the old seeds are the buyer's), `a_payout_lands_only_at_the_receiving_partys_standard_account`
    ("paid the Seller elsewhere") and `rent_goes_back_to_the_creator_never_to_whoever_fronted_it`
    (the payer recorded, not the buyer); both one-tap tests failed, the old program wanting the payer
    in the rent slot. After the change all 51 pass. The client's one-tap test was written first too: the old `payInOneTap` gave
    three instructions, the first not the deposit address.
  - **LiteSVM, 51 tests:** `escrow.rs` 22 (two new: whose the address is, where rent goes), with the
    closers, the sweep and the payout-address test rewritten for both sides; `adversarial.rs` 27,
    the front-run finding turned into `nobody_can_open_the_address_a_buyer_is_about_to_use`, the
    timer's seller-account finding into `timer_whoever_sends_the_sellers_timer_can_pay_only_its_standard_account`,
    a party handing its standard account away tested for both sides; `one_tap.rs` 2, the deposit
    address first in every one tap.
  - **The fuzzer:** I13 (an escrow's address is its creator's; one `create` in twenty aims at
    another key's address and must be refused); I3 checks rent reaches the creator to the lamport and
    nobody else, the payer named in the rent slot now and then and refused; I5 checks each party is
    paid only at its standard account; the payer, the seller or anyone tries `close_unfunded`; two
    `create`s in three make the deposit address first. Against the round-1 binary it fails at once
    (I7 at `create`, I3 on the recipient).
  - **The client** as above; 16 unit tests (the `whatDiffers` test gone). The validator test's
    buyer and seller hold no SOL, and every refund reaches them: the split's deposit rent to the
    buyer, the invoice's to the seller, the refund's to the buyer, a swept tip to the seller, and a
    sweep named to the payer refused. `scripts/devnet.ts` and `test/devnet.test.ts` follow
    (type-checked, not run).
  - **`feepayer/test/feepayer.test.ts`:** its escrow part rewritten on the new client (see learned
    1): pay, release, one tap, and a third escrow opened and closed unfunded, all through Kora, plus
    a sweep. Its registration part is unchanged.
  - **`escrow/README.md`** and **`escrow/security-checklist.md`** updated: the addresses, both payout
    rules, where rent goes, the new costs, fifteen known limits.
- **Measured** (LiteSVM, twelve runs with fresh keys):
  - one tap, the deposit address first: 39,400 to 52,900 compute units, 701 bytes; with the seller's
    account made in it 53,000 to 71,000 and 743 bytes;
  - `release_to_seller` 11,400 to 14,400 (it now derives the seller's address); `create` 31,600 to
    49,700; `release_to_buyer`, `arbitrate`, the timer, `close_unfunded` and `sweep_rent` 32 bytes
    longer, since the creator is a key those transactions did not otherwise carry;
  - the rents do not change: at 5,080 lamports a byte the payer fronts 3,479,800 in a one tap, the
    buyer gets the deposit's 1,488,440 back in the same transaction, the receipt keeps 1,991,360.
  - Through Kora (`feepayer/`, mock prices, one base unit per lamport): pay charged 4,777,650 for
    4,777,600 spent; the release 10,050 for 10,000; the one tap 4,777,650 for 4,777,600, where the
    fee payer's session measured 2,039,330 over (the deposit it got back, plus 50); the person got 9,846,160 lamports back (three deposit rents,
    one escrow rent, a swept tip) and the fee payer none.
- **Verified:** 51 LiteSVM tests; 16 client tests; the validator test; `feepayer`'s local test end
  to end with Kora 2.0.5; the fuzzer's long campaign on the final binary (`46ea84c2…`): 50,000
  iterations of 80 flows (4,000,000 flows), exit 0, every way out accepted thousands of times
  (`timer_release` 2,772, `arbitrate` 6,048, `close_unfunded` 80,510, `sweep_rent` 48,701).
- **Learned:**
  1. **`feepayer`'s local test was broken on `main`.** It merged after round 1 but was written
     against the escrow client before it (`approveIx`, `OfferTerms`, `rentPayer`), so it could not
     load. Ported here, as the task allowed.
  2. **Refunds now arrive as SOL in a wallet that may hold none.** That works: an empty wallet must
     end at the rent-exempt minimum for an empty account, and every refund but a sweep is larger at
     any rate (165 and 256 bytes against 0). A small sweep into an empty wallet fails until more has
     built up; nothing is lost.
  3. **`throughKora`'s quote is one signature short when the person signs only the payment.** It asks
     for the price before adding the payment instruction, so a sweep (which needs no signature) was
     quoted for one signature and refused ("Required 10000 lamports"). The test sends the sweep from another key instead; anyone
     may. A fee payer client must quote with the payment in place.
  4. **Every escrow step through Kora is charged exactly what the fee payer spends, plus 50
     lamports.** With rent no longer coming back to it, Kora 2.0.5's outflow-only price is right,
     and Kora 2.2's counting of returning rent is no longer needed for the escrow.
  5. **The round-1 build reproduces:** its source rebuilt here gave the same sha256.
- **Open:**
  1. **A party named as the escrow itself** (checklist limit 3): accepted by `create`, and it locks
     the deal's money. Refuse it at `create` (one more check, before deploy), or leave it to the
     app? Not tested.
  2. **Refunds arrive in SOL.** In a fee payer's app the person's wallet holds none otherwise. How is
     it shown or used without saying "SOL": left in the wallet, paid back out at ramp-out, or taken
     by the fee payer as payment (Kora could accept SOL as a paid token)?
  3. **Frozen accounts now include the seller's,** with no way round: the seller can no longer name
     another account. Every way out that pays a party waits while that party's standard account is
     frozen.
  4. Still standing from round 1: whether a way out should record the funding time;
     `recover_late`'s holder check; SOL and other-mint tokens at an escrow's address.
  5. **For the consolidation session** (not this session's folders):
     - the handoff (line 109) says rent above the minimum goes "back to whoever paid it" and that a
       never-funded escrow closes by "either party or its rent payer": now the creator, and either
       party only; its Open (line 226) still lists where money to the buyer lands and "SOL … goes to
       the rent payer";
     - `feepayer/README.md`'s "The deposit, answered: counted, and never given back" and its open
       "The refund gap" are answered: every deposit comes back to the person;
     - `docs/changes/services.md` opens 1 and 2 are closed by this round;
     - an index derives an invoice's address from the seller's key;
     - `docs/devnet.md`'s escrow size, hash and cost are stale (303,432 bytes now).

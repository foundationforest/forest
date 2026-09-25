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

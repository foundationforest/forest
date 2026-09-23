# Adversarial review 1: the registry and the escrow

Session 10, September 22, 2026. Nothing here is deployed. Every attack ran under LiteSVM, Trident
or a local validator, against the programs exactly as they are in this repository.

## The verdict

1. **Do not deploy the registry as it is.** Its treasury is still the placeholder, and anyone can
   derive that key from a string in this repository. The first stranger to read it would take
   every fee and every dial. It was always meant to be replaced before deploy; now a test proves
   what happens if it is not.
2. **No other attack could take a buyer's or a seller's money in a normal dollar deal.**
   - Two real bugs were found and fixed. The escrow rounded a buyer's cancellation refund the
     wrong way, by at most a millionth of a dollar. Both clients believed events that any program
     can forge, which would have let anyone fake a badge or a payment receipt to an index.
   - Two small leaks need a decision. SOL sent the wrong way ends with whoever paid the rent. A
     sponsor's rent can be locked by escrows nobody ends.
3. **The biggest open question is consent, not code.** An escrow is the buyer's alone. A stranger
   can open one naming any seller, then lock it, or turn it into a "receipt", and choose its
   arbiter and deadlines. Before the index is built, decide how it treats deals the seller never
   acknowledged.

## Findings, by severity

Severity means: **money** (someone can lose funds), **promise** (a rule in the handoff stops being
true), **nuisance** (friction, no loss). "Fixed" means fixed in this session with a test that
failed first. "For Carlos" means it changes a design decision, so it is described and left alone.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | money, promise | The registry's placeholder treasury key is public | for Carlos: replace before deploy |
| 2 | money (small) | Wrapped SOL sent to an escrow without a "sync" goes to the rent payer, not the buyer | for Carlos |
| 3 | money (sponsor's) | A sponsor's rent can be locked forever in escrows nobody ends | for Carlos |
| 4 | promise | A buyer's cancellation refund rounded down instead of up | **fixed** |
| 5 | promise | Both clients read forged events as real: fake badges, fake receipts | **fixed** |
| 6 | promise | The seller never consents: strangers can lock, "receipt" or rig escrows naming any seller | for Carlos |
| 7 | promise | One escrow address can hold two deals, so it is not a unique deal id | for Carlos |
| 8 | promise | The treasury can bring vouchers back by accepting a token it mints | for Carlos |
| 9 | promise | The wallet that pays is not tied to the profile; a human can badge a profile they don't own | for Carlos |
| 10 | promise (reasoned, not tested) | Registering right after joining can link a face check to a profile by timing | for Carlos |
| 11 | nuisance | A treasury key holding no SOL refuses small rent sweeps | operations note |
| 12 | nuisance | Every ending needs a token account owned by each party, even one receiving nothing | note |
| 13 | nuisance | The client builds valid terms nobody meant (milliseconds as seconds, and others) | for Carlos |
| 14 | nuisance | A second payment to a one-tap link is stranded until the buyer reopens the id | note |

**What held.** Everything else was refused, in all 44 hand-written tests and about 41.6
million fuzzed steps (40 million on the escrow, 1.6 million on the registry). That covers:

- a different or look-alike account in every slot
- the wrong signer, or keys swapped between slots
- a second `init` or `create` over a live account
- 1,024 single-bit changes to a real proof, and a proof moved to another profile, market, list,
  root or code
- the same code twice, including twice in one transaction
- values just past the field order
- amounts of 1 and of the largest possible number
- every deadline to the second
- two endings in one transaction, and a replayed signed transaction
- Token-2022 in every place
- sweeps aimed at other accounts or other destinations
- a rent rise after a sweep
- the whole treasury handover sequence

Details and test names are below.

---

## How this was done

- **Read without trusting comments.** Both programs, both LiteSVM harnesses and both TypeScript
  clients. The rules were taken from `docs/handoff.md`, then checked against what the code does.
- **44 hand-written tests**, kept as the adversarial suites:
  - `escrow/program/tests-litesvm/tests/adversarial.rs`: 23
  - `escrow/program/tests-litesvm/tests/one_tap.rs`: 2
  - `registry/program/tests-litesvm/tests/adversarial.rs`: 15
  - both clients' `test/client.test.ts`: 2 new tests, and 2 existing tests extended

  Several tests hold many attacks each; the registry's proof tests alone make 1,037.

  A test named for something that should be refused asserts that it is refused. A test named
  `finding_…` asserts the attack is accepted, so the suite records what this report says. When a
  hole is later closed, that test fails and gets updated.
- **Fuzzing.** The escrow ran under Trident 0.12 (Ackee). The registry could not, for the reason
  given under "Fuzzing"; its invariants run as a LiteSVM property test instead. Each fuzzer keeps
  its own model of the program and predicts, for every random instruction, whether it must
  succeed and exactly what must move. It fails on any disagreement.
- **Toolchain.** Solana CLI 4.2.2 (`cargo build-sbf`), LiteSVM 0.16, Trident 0.12.0, Node 22.

## The threat list

### Registry

The promises, from the handoff, and how each was attacked. ✔ means the attack was refused, as it
should be; ✘ means it was accepted (a finding).

**R-1. One human, one badge per market.** A code is recorded once and never again.
- ✔ The same proof twice; twice in one transaction (both revert, no fee).
  `a_code_cannot_be_used_twice`, `replay_one_code_twice_in_one_transaction_reverts_both`
- ✔ The same code written a second way (plus the field order). `proof_bound_to_…` ("the same code
  plus the field order")
- ✔ Sending lamports to a code's address first, hoping `init` finds it taken: it registers anyway.
  `replay_lamports_sent_to_a_code_address_first_do_not_block_it`
- ✔ Fuzzed: across every accepted registration, the code tree's count and root equal a rebuild
  from the codes accepted, and no code lands twice (R1 in `invariants.rs`).
- ✘ A lookalike market name ("online-tutors " or "Online-Tutors") needs a new proof, which the
  human can make, and gets a new code. That is by design: the program accepts any scope, and
  indexes count only exact directory names. **An index must compare the bytes exactly: no case
  folding, no trimming, no Unicode normalisation.**

**R-2. Only a real member's proof counts, bound to this market and this profile.**
- ✔ Another profile's DID, a lookalike or capitalised market, another human's code, a root that
  was never the list's, the zero root, a root plus the field order, list 1 named for a list-0
  proof, empty and 65-byte names and DIDs. `proof_bound_to_its_did_market_root_and_code`
  (13 cases)
- ✔ Every single-bit change to the proof's three points, 1,024 in all.
  `proof_every_single_bit_flip_in_the_points_is_refused`
- ✘ The proof does not bind the wallet that pays: finding 9.
  `finding_the_paying_wallet_is_not_bound_to_the_did`

**R-3. 25 cents, always, in an accepted token, to the treasury.**
- ✔ Paying from a victim's token account, the fee to a stranger's account, to the treasury's
  account for another mint, to a Token-2022 account, Token-2022 as the token program.
  `substitution_every_account_in_register` (9 cases)
- ✔ One unit short; an unaccepted mint; the treasury paying itself. (Existing tests.)
- ✔ Fuzzed: the wallet pays exactly the fee and the treasury receives exactly it, in USDC and in
  added mints of 2 to 19 decimals (R2).
- ✘ The treasury can accept a token it mints itself: finding 8.
  `finding_the_treasury_can_accept_a_token_it_mints_itself`

**R-4. Only the treasury turns dials, and the handover takes two steps.**
- ✔ A stranger on every dial; an issuer adding issuers; an issuer of list 0 inserting into
  list 1; accepting with nothing pending; accepting by the overwritten first key; accepting twice.
  `signers_…`, `treasury_a_handover_in_one_transaction_…`, and the existing handover tests.
- ✔ A key only the program could sign for can be proposed and is simply never accepted.
- ✔ Both steps in one transaction work only with both keys signing.
- ✘ Deployed as is, the treasury key is public: finding 1.
  `finding_the_placeholder_treasury_is_anyones_key`

**R-5. The sweep sends only the excess above rent, only to the treasury, and touches nothing
else.**
- ✔ The wrong account, the wrong destination, an account the program does not own, a code nobody
  registered, a list nobody opened, sweeping twice.
  `sweep_nothing_twice_nothing_missing_and_a_rent_rise_freezes_nothing`, plus existing tests.
- ✔ Exactly the excess leaves; no other registry account moves; the caller pays only its fee.
  `sweep_takes_from_nothing_but_the_target_and_gives_to_nothing_but_the_treasury`
- ✔ The rent rate going **up** again after a sweep leaves every account below the new minimum.
  Registration, insertion and the dials still work (the runtime allows a rent-paying account to be
  written as long as its lamports do not grow).
- ✘ A treasury key holding no SOL refuses small sweeps: finding 11.

**R-6. The list remembers its last 128 roots; nobody is removed.**
- ✔ Existing test at 127 and 128 inserts; fuzzed: after every insert, every ring slot holds exactly
  the root it should and nothing else is in the ring; the root equals a full LeanIMT rebuild; the
  count only grows (R3, R4).
- ✔ Out-of-field and zero commitments refused. A duplicate commitment is accepted, which harms
  nothing: `finding_an_issuer_can_insert_the_same_commitment_twice`.

**R-7. `init` writes constants, whoever sends it, once.** ✔ Existing tests.

**Across both programs.** ✔ No seed string used by either program can collide with another, across
or within the programs. Each program refuses accounts the other owns.
`pda_the_two_programs_cannot_share_an_address`,
`substitution_an_escrow_shaped_account_owned_by_another_program_is_refused`.

### Escrow

**E-1. Money moves only by the rules: approval, silence, agreement, arbiter, cancellation, close.**
- ✔ Another escrow's deposit account; a look-alike deposit account (owned by the escrow's
  address, but not the one it recorded) at an ending and at `create`; payout accounts of another
  mint, owned by another party, the seller in the buyer's slot, a Token-2022 account, Token-2022
  as the program. `substitution_…` (4 tests)
- ✔ An escrow's exact bytes placed under the registry's, the system program's or the token
  program's ownership.
- ✔ An unsigned rent payer; buyer and seller swapped in `agree`; the arbiter as seller.
  `signers_…`
- ✔ The buyer moving or closing the deposit account directly through the token program.
- ✔ Fuzzed (I7): for every instruction, with any key allowed to sign, the program accepted exactly
  what the README's state machine allows.

**E-2. No ending pays more than was deposited; excess goes back to the buyer.**
- ✔ Splits of one unit at 1, 5,000, 9,999, 10,000 and 0 basis points. The largest amount a u64
  holds, through `approve`, `agree` and `cancel_buyer`, with no overflow or lost unit.
  `arithmetic_splits_at_the_edges_add_up_and_never_overflow`
- ✔ Fuzzed (I1, I2, I6): deposit accounts hold exactly what was sent; each ending pays out exactly
  that balance; no token is created or destroyed.
- ✘ Wrapped SOL: finding 2.

**E-3. The buyer's cancellation refund is the step's percent.**
- ✘ **Before the fix**: an amount of 3 at 50% paid the buyer 1 and the seller 2.
  `arithmetic_a_cancellation_refund_is_never_below_the_steps_percent`. Fixed: finding 4.

**E-4. Time rules hold to the second.** Existing tests cover silence, cancel and close at
exactly each boundary; the fuzzer moves time to one second either side of every deadline it
knows.
- ✘ Terms that are valid but nobody meant: a service time already past releases the moment money
  lands; refund steps longer than silence race the seller; a service time at the end of time
  blocks silence. `finding_a_service_time_…`, `finding_steps_that_outlast_silence_…`. Part of
  finding 6.

**E-5. An ended escrow accepts nothing; nothing is spent twice.**
- ✔ Two endings in one transaction revert together, in three orders. A signed approval replayed
  onto a reopened address is refused. `double_spend_…`
- ✔ Fuzzed (I4): every instruction on an ended escrow was refused.
- ✘ The address can be reopened for a new deal: finding 7.
  `finding_an_ended_escrows_address_can_hold_a_second_deal`

**E-6. Rent returns to whoever paid it.**
- ✔ Existing test for all seven endings; fuzzed (I3): to the lamport, and to nobody else.
- ✘ The rent payer also receives SOL that anyone sent to the escrow's address or the deposit
  account by mistake (`rent_lamports_sent_to_the_escrow_address_go_to_the_rent_payer`, a note).
  And the rent payer cannot recover its rent from an escrow nobody ends: finding 3.

**E-7. Classic SPL Token only.** ✔ Token-2022 as mint, account and program: refused everywhere.
- ✘ Any classic mint is accepted, including one the buyer controls. That makes a
  "billion-dollar" receipt in a worthless token
  (`finding_a_self_minted_token_makes_a_receipt_that_looks_like_real_money`). An index must
  check the mint against the market's accepted tokens. See "Rules an index must follow".

**E-8. Parties are keys, and each party agreed to the deal.** This is not stated as a promise,
but the handoff's "an unresolved lock marks both" and "evidence" rest on it.
- ✘ Finding 6: `finding_a_stranger_can_lock_…`, `finding_a_stranger_can_make_a_receipt_…`,
  `finding_the_buyer_can_name_an_arbiter_it_holds`.

### Clients

- ✘→fixed. Both `decodeEvents` (escrow) and `decodeRegisteredEvents` (registry) took any
  `Program data:` line: finding 5.
- ✘→fixed. `cancelPayout` showed the old, wrong rounding, so the app would have shown the buyer
  what the program paid, not what the rule promised.
- ✘ `termsFor` accepts a millisecond timestamp as seconds, refund steps longer than silence, and
  a past service time: finding 13.
  `finding: termsFor builds terms the program accepts but no buyer meant`.
- ✔ Every instruction builder checks what the program checks before a transaction is built. (The
  existing tests.)

## The product check: one-tap Pay

**It works.** `create`, a plain token transfer into the deposit account and `approve` ride in one
transaction and succeed. The escrow opens, fills and releases in the same second, and leaves the
same `Created`, `Approved` and `Closed` record at the same kind of address as a week-long escrow.
There is no `Funded` event, because nobody observed funding separately; an index should read an
ending as proof of funding. `create_fund_and_approve_ride_in_one_transaction`.

| | Compute units | Of 1,400,000 | Bytes | Of 1,232 |
|---|---|---|---|---|
| Seller already has a token account | 51,727 | 3.7% | 668 | 54% |
| Seller's token account made in the same transaction | 57,735 | 4.1% | 710 | 58% |
| Fullest terms (arbiter, service time, four steps) | 50,753 | 3.6% | 749 | 61% |

(Legacy transactions with a compute-budget instruction. Compute units vary by up to about 1,500
between runs, because `create` searches for two address bumps and the keys are random.)

**The receipt costs no rent.** The payer fronts both accounts' rent for the length of the
transaction and gets all of it back in the same transaction. At LiteSVM's rate that is 4,920,720
lamports; 3,591,560 at today's 5,080 per byte; 492,072 after the cuts. The payer needs that much
available. The seller's token account, if made in the same transaction, is the seller's to keep
and its rent is not returned.

No program change is needed. One consequence is finding 14: once a one-tap escrow closes, a
second payment to its link is stranded until the same buyer reopens the same id
(`a_one_tap_receipt_is_the_same_record_as_a_slow_one`).

## Fuzzing

### Escrow, under Trident

`escrow/program/trident-tests/`. Trident runs the built `forest_escrow.so` in its own runtime.

- **The flows:** random `create`: each term goes wrong about one time in thirty, in each way the
  program must refuse, and about half of all creates land; deposits from anyone (including to closed escrows' addresses),
  fund-and-mark, `mark_funded`, `object`, all seven endings with the right key or any key and,
  one time in twenty, a wrong payout or rent account, and time moving by random stretches or to
  one second either side of a deal's own deadlines.
- **The invariants,** checked after every step:
  - **I1** every deposit account holds exactly what was sent to it;
  - **I2** each ending pays out exactly what the deposit account held, no more;
  - **I3** rent returns to the recorded rent payer, to the lamport, and to nobody else;
  - **I4** an ended escrow accepts no instruction;
  - **I5** a cancellation refund is never below the step's percent;
  - **I6** no token is created or destroyed;
  - **I7** the program accepts exactly what the state machine allows.
- **Signatures:** Trident's runtime does not check them, so every key can sign; every authority
  rule had to hold on key comparisons alone.
- **Proof that it catches bugs:** run against the program as it was before this session's fix, it
  failed 40 times in 24,000 steps with "cancel_buyer: the seller's share". Run against the fixed
  program, it passes.
- **The long run:** 400,000 iterations of 100 flows: **40,000,000 flow calls, 27,184,961 transactions, in 1,910
  seconds (32 minutes) on four cores. Every invariant held** (Trident exit code 0 with
  `TRIDENT_WITH_EXIT_CODE=1`; master seed `c144d195…4c74e`, in Trident's output).
  - Accepted: 1,610,718 escrows created, 2,314,569 deposits and 771,166 fund-and-marks landed.
  - Endings that landed, each checked to the unit and the lamport: 1,251,240 in all
    (170,276 approvals; 180,476 agreements; 73,050 arbitrations; 94,604 buyer cancellations;
    286,597 seller cancellations; 380,004 closes; 66,233 releases by silence).
  - Also accepted: 176,828 objections and 59,719 marks.

### Registry: why not Trident, and what ran instead

Trident 0.12 cannot run the registry. Its runtime (`trident-svm` 0.2.0) starts with every
Solana feature switched off (`SVMFeatureSet::default()`), and its builder offers no way to switch
one on. So the `sol_poseidon` and `alt_bn128` syscalls are never registered. The program's first
hash fails as "unsupported BPF instruction", 2,814 compute units into `insert_identity`. Making it
work would mean patching Trident. The attempt is kept in `registry/program/trident-tests/` so
this can be re-checked when Trident changes.

The same model and invariants run under LiteSVM instead:
`registry/program/tests-litesvm/tests/invariants.rs`. It uses real signatures and a seeded random
generator (`FOREST_FUZZ_SEED` replays a run).

- **The flows:** registrations with the five real proofs, corrupted about one time in three; inserts by
  the issuer or anyone, of good, zero, out-of-field and duplicate commitments; proposals and
  acceptances by the right key or any; tokens of 0 to 21 decimals, Token-2022 mints, repeats;
  issuers added and removed; lists opened; lamports sent to registry accounts; sweeps; and the
  rent rate moving between the three rates the sweep exists for, in both directions.
- **The invariants:**
  - **R1** a code is never recorded twice, and the code tree matches a rebuild;
  - **R2** no key that has held the treasury ever loses a lamport or a token unit, and it gains
    exactly the fee and exactly the swept excess;
  - **R3** each list's count only grows and its root matches a rebuild;
  - **R4** each list's ring holds exactly its last 128 roots;
  - **R5** the program accepts exactly what the rules allow.
- **It found one thing in its first second,** a disagreement the model had not expected. That is
  finding 11. The model now includes the runtime's rent rule, and a dedicated test pins it.
- **The long run:** two runs of 10,000 iterations of 80 flows, seeds 1111 and 2222: **1,600,000 flow calls, 834 and 832
  seconds (about 14 minutes each, side by side). Every invariant held.** Seed 1111 alone:
  - 43,453 registrations accepted and 133,969 refused;
  - 107,450 inserts;
  - 14,216 handovers accepted;
  - 45,579 tokens added;
  - 46,208 sweeps, at all three rent rates.

### Coverage

Neither tool gives line coverage of a program running as SBF bytecode. Trident's coverage works
for programs linked in natively, and LiteSVM has none. What was recorded instead is every
instruction reached with both outcomes, and every refusal reason the program can give for it:

- **Escrow:** every instruction was reached both accepted and refused, except the plain deposits,
  which must always land. **All 25 of the program's own refusals were reached**, from `SameParty`
  to `TimeOverflow`. So were Anchor's account checks (`AccountNotInitialized`, `ConstraintHasOne`,
  `ConstraintTokenOwner`, `ConstraintDuplicateMutableAccount`) and the system program's "already
  in use".
- **Registry:** every instruction was reached both accepted and refused. The program's own
  refusals reached were:
  - on proofs and members: `NotAFieldElement`, `RootNotRecent`, `ProofMalformed`,
    `ProofRejected`, `NotAnIssuer`;
  - on issuers and tokens: `IssuerAlreadyAdded`, `IssuerNotFound`, `MintAlreadyAccepted`,
    `WrongDecimals`;
  - on the treasury: `TreasuryEmpty`, `TreasuryUnchanged`, `NoPendingTreasury`,
    `NotThePendingTreasury`;
  - on sweeps: `WrongSweepTarget`, `NothingToSweep`.

  Also reached: Anchor's owner, has-one, address, token-owner and duplicate checks, and the
  runtime's rent rule. Not reached by the fuzzer:
  - `MarketNameLength`, `DidLength`, `MintMismatch`, `MintNotAccepted` and `FeeGoesNowhere`,
    which the hand-written attacks and earlier tests cover;
  - `TooManyIssuers` and `TooManyMints`, because no iteration fills eight issuers or sixteen
    mints;
  - three that nothing outside can reach: `WrongList` (the list's address is derived from the
    same index it checks), `HashFailed`, and `TreeFull` (2³² members).

## The findings in detail

### 1. The registry's placeholder treasury is anyone's key (money, promise)

- **The attack:** the treasury constant in `registry/program/src/lib.rs` comes from the public
  string `REPLACE-BEFORE-DEPLOY-treasury-0`. Anyone who reads this repository can sign as the
  treasury. If the program is deployed and sealed as it is, that stranger can:
  - hand the treasury to themselves;
  - name themselves issuer and insert humans who do not exist, as many as they like, which
    undoes "one human, one badge" for good;
  - take every fee.
- **The test:** `finding_the_placeholder_treasury_is_anyones_key` does all of that, and the next
  registration pays the attacker.
- **The fix is not code.** The constant must become the charter's real treasury before the first
  deploy, as the registry README already says.
- **For Carlos:** also consider a build guard. For example, a mainnet build that refuses to
  compile while the constant is the placeholder, so the mistake cannot ship by accident. The cost
  is one more build flag for the test builds.

### 2. Wrapped SOL: unsynced SOL goes to the rent payer (money, small)

- **The attack:** the native mint (wrapped SOL) is a classic SPL Token mint, so `create` accepts
  it. SOL sent to a wrapped-SOL deposit account by a plain transfer only counts after someone
  sends a "sync". Anything that arrives after the last sync is never paid to the buyer. When the
  deposit account closes, every lamport in it goes to the rent payer.
- **The test:** `finding_wrapped_sol_sent_without_a_sync_goes_to_the_rent_payer`. The rent payer
  received 54,920,720 lamports: its own 4,920,720 of rent plus the buyer's 50,000,000.
- **Related note:** SOL sent by mistake to the escrow's own address, rather than the deposit
  account, also ends with the rent payer. When the rent payer is a sponsor, the buyer's mistake
  pays the sponsor.
- **For Carlos:**
  - Option (a): refuse the native mint at `create`. One line; costs a SOL market nothing today,
    since market files list dollar tokens.
  - Option (b): sync before paying out. That changes an ending's accounts.
  - Recommendation: (a). Every market today is priced in dollars.

### 3. A sponsor's rent can be locked forever (money, the sponsor's)

- **The attack:** a buyer opens escrows on a sponsor's rent, names a seller key nobody holds, sets
  a cancellation deadline a century away, and never funds them. Only the buyer or the seller can
  close a never-funded escrow; the sponsor cannot.
- **The test:** `finding_a_sponsor_cannot_recover_rent_from_an_escrow_nobody_ends`. That is
  4,920,720 lamports per escrow at LiteSVM's rate.
- **For Carlos:** either the sponsor's policy handles it (for example, sponsor `create` only
  inside a one-tap transaction that also funds it, or rate-limit per buyer), or the program lets
  the rent payer close a never-funded escrow after some wait. The program change adds a third
  party who can end an escrow; the policy route needs no change.

### 4. A cancellation refund rounded the wrong way (promise) — fixed

- **The bug:** `cancel_buyer` rounded the buyer's refund down, so the seller's share rounded up.
  The README's sealed rule says the opposite: "the seller's share rounds down, in every split and
  in a cancellation's remainder". So did the invariant this review was asked to check.
  - Example: an amount of 3 at a 50% step paid the buyer 1 instead of 2.
  - At most one base unit per cancellation (a millionth of a dollar in USDC).
  - The client's `cancelPayout` had the same arithmetic. Its test was titled "the seller's share
    rounds down" while asserting it rounded up.
- **The fix:**
  - program: `to_seller = share(amount, 10,000 − refund_bps)`, one line;
  - the client's `cancelPayout` to match;
  - the client test's expected numbers;
  - a sentence in the README's sealed rules.
- **The tests:** `arithmetic_a_cancellation_refund_is_never_below_the_steps_percent` failed
  before and passes after. The client payout test failed before and passes after. The Trident
  fuzzer independently fails the unfixed program 40 times.

### 5. The clients read forged events as real (promise) — fixed

- **The bug:** `decodeRegisteredEvents` and `decodeEvents` took every log line starting
  `Program data:`, whichever program wrote it. Any program can write a line with a `Registered`
  entry's exact bytes: any DID, and a real code copied from a real registration. An index using
  that decoder would show a badge on a profile that was never registered. The same goes for
  escrow receipts.
- **The fix:** both clients gained `programDataLines(logs, programId)`. It follows the runtime's
  own `Program <id> invoke [n]` and `Program <id> success` or `failed` lines, which no program can
  forge, because a program's own output always starts `Program log:` or `Program data:`. It keeps
  only the lines written while the registry or escrow program itself was running.
- **The tests:** both clients' event tests failed before and pass after. They cover a forger
  alone, a forger after a real instruction, a line written by the token program while the escrow
  waits, a line with no program running, the program called from another program, and another
  deployment of the same code. Both validator tests decode real logs with the new decoders.
- **Not changed:** the Rust harnesses decode their own transactions only, so their decoders were
  left as they are.

### 6. The seller never consents (promise)

The buyer alone signs `create`. Four attacks follow from that.

- **A lock on anyone.** A stranger opens an escrow naming any seller, funds it with one base unit
  and objects. The handoff says an unresolved lock "marks both". The seller's only way out,
  `cancel_seller`, marks the seller instead. Cost to the attacker: one base unit, plus rent they
  get back later. `finding_a_stranger_can_lock_an_escrow_naming_any_seller`
- **A receipt without a deal.** One base unit to a seller who did nothing produces a real
  `Created`, `Approved` and `Closed` at an address a review can point at. A one-star review "with
  evidence" is then a single transaction.
  `finding_a_stranger_can_make_a_receipt_naming_any_seller`
- **A puppet arbiter.** The arbiter may not be the buyer's key, but nothing stops it being the
  buyer's second key. After delivery, the "arbiter" gives the seller nothing.
  `finding_the_buyer_can_name_an_arbiter_it_holds`
- **Rigged clocks.** Refund steps longer than silence, a service time already past, a service
  time at the end of time. Each is valid, and each quietly changes who wins.

**For Carlos,** three ways, not exclusive:

- **(a) The seller signs too.** The seller co-signs `create`, or a separate `accept` the program
  requires before funding counts.
  - Closes all four at the root.
  - Costs a seller signature before every deal, so a buyer cannot pay a seller who is offline.
    That fights one-tap Pay, unless the seller's app pre-signs a pay link.
  - A sealed-program change.
- **(b) Indexes count only acknowledged deals.** Marks and receipts count only on escrows the
  seller acknowledged. The Deals-and-evidence decision already has the tool: two reviews pointing
  at each other across one deal id. Or the seller having signed any instruction on it.
  - No program change.
  - A one-sided lock or receipt then weighs nothing, and the seller's `cancel_seller` from a lock
    they never agreed to should not count against them.
- **(c) Apps check terms.** The seller's app reads the escrow before delivering, refuses unknown
  arbiters and terms outside the market file, and the market file says which arbiters are
  allowed. Needed in any case.

My recommendation: **(b) and (c) now**, and (a) only if a real market shows (b) is not enough.

### 7. One address, two deals (promise)

- **The attack:** the escrow's address is derived from the buyer and an 8-byte id. The same buyer
  reusing an id after the escrow closed gets the same address for a new deal, with another
  seller, even in the transaction that closed the first.
  `finding_an_ended_escrows_address_can_hold_a_second_deal`
- **Why it matters now:** the handoff now says an escrow's address *is* the deal id, and the deal
  id is "32 random bytes chosen at creation". The program's address is neither random 32 bytes
  nor single-use.
- **For Carlos:**
  - (a) Define the deal id as the address plus the slot or signature of its `Created`. No program
    change.
  - (b) The program keeps a small permanent marker per closed address. Rent forever, which the
    program otherwise avoids.
  - (c) Accept it. Only the same buyer can reuse an address, and reviews carry their own time.
  - This was already open from session 8. The new decision makes it sharper.

### 8. The treasury can bring vouchers back (promise)

- **The attack:** `add_token` takes any classic mint with 2 to 19 decimals. A treasury that mints
  its own "dollar" and hands it out has vouchers again: registrations paid in a token that cost
  nobody anything. The program cannot tell a stablecoin from a voucher.
  `finding_the_treasury_can_accept_a_token_it_mints_itself`
- **For Carlos:** this is the treasury's honesty, bounded only by who holds the key. A multisig
  and a public policy are the whole defence short of a fixed mint list, and a fixed list would
  seal out future dollar tokens.

### 9. The wallet that pays is not tied to the profile (promise)

- **What the proof binds:** the market and the DID, not the wallet that pays.
  - The harmless side: whoever relays Alice's registration can pay for it, and Alice still gets
    her badge. `finding_the_paying_wallet_is_not_bound_to_the_did`
  - The other side: the human who makes a proof chooses the DID, and nothing checks that they
    control it. So a verified human can make a badge for someone else's profile and sell it:
    still one per human per market, but no longer "their own".
- **The gap for indexes:** the paying wallet is not in the `Registered` event. An index would
  have to read the transaction's accounts to compare it with the profile's declared wallet.
- **For Carlos:**
  - (a) An index rule: a badge counts only if the profile's declared wallet paid. Needs no program
    change, but breaks sponsored or relayed payment by another wallet.
  - (b) Bind the wallet into the proof's message. A change to what is sealed, possible only
    before deploy.
  - (c) Accept badge selling as bounded by one per human per market.

### 10. Timing can link a face check to a profile (promise; reasoned, not tested)

- **The risk:** a registration names the list root its proof was made against, and every insert
  makes a new root. Suppose a person registers right after joining, with the root their own
  insert created, while few others are joining. Then anyone watching the chain can guess which
  insert, and so which face check session, belongs to which DID. The issuer knows which session
  made which insert, so the issuer can guess best of all. That bends "nothing server-side ever
  holds a person next to a profile" from "holds" to "can infer".
- **For Carlos:** a client rule. Wait until some number of people have joined after you before
  registering, or until a set time has passed. Cost: the first badge is not instant.
- **Not tested here:** it needs real joining rates to size the wait.

### 11. A treasury key with no SOL refuses small sweeps (nuisance)

- **What happens:** the runtime refuses any transaction that leaves a credited account below its
  rent-exempt minimum. A treasury key holding no SOL is such an account: a fresh key, or a
  multisig vault just after a handover.
  - At today's rate, an empty account's minimum is 650,240 lamports.
  - A sweep smaller than that fails whole.
  - A larger sweep, or anyone sending the treasury a little SOL, unblocks it. No money is lost.
- **Found by:** the registry fuzzer, in its first second. Pinned by
  `finding_a_sweep_into_a_treasury_holding_no_sol_fails_until_someone_funds_it`.
- **Operations note, now in the registry README:** a treasury should hold about 0.001 SOL from
  the moment it accepts.

### 12. Every ending needs both parties' token accounts (nuisance)

- **What happens:** each ending takes a token account owned by the buyer and one owned by the
  seller, even when one receives nothing. If the seller has never held the token, whoever sends
  the ending first creates one, about 0.002 SOL of rent that is not returned. That includes a
  stranger sending `release_by_silence`, and the buyer closing a never-funded escrow.
- **Known:** this was session 8's choice #11. The one-tap measurement above includes the case.

### 13. The client builds valid terms nobody meant (nuisance)

- **What happens:** `termsFor` reads a number as Unix seconds. An app passing `Date.now()`
  (milliseconds) creates an escrow whose service time is about 55,000 years away: silence never
  comes, and a refund step lasts as long. `termsFor` also passes, unwarned:
  - a market whose refund steps outlast its silence;
  - a service time already past.
- **The test:** pinned in the client test
  `finding: termsFor builds terms the program accepts but no buyer meant`.
- **For Carlos:** have the client refuse service times beyond a sane horizon, and warn when a
  refund step outlasts silence or a service time is past. Small, but it changes what the client
  accepts, so it is a decision.

### 14. A second payment to a one-tap link is stranded (nuisance)

- **What happens:** once a one-tap escrow closes, its deposit address can still receive tokens.
  Wallets create the account again. Only the same buyer reopening the same id can pay those
  tokens out.
- **Known:** already open from session 8. One-tap makes it likelier, because the link's escrow
  is closed the moment it is paid. `a_one_tap_receipt_is_the_same_record_as_a_slow_one`.

## Rules an index must follow

These are not bugs in anything built. The index is not built yet. They are what the attacks
above show an index must do. Each is a thing to write into `index/` and its skill file:

1. Read only events the program itself wrote. Use `programDataLines` or the same rule.
2. Compare market names to the directory byte for byte.
3. Count an escrow receipt only if its mint is one the market accepts.
4. Weigh a deal by whether the seller acknowledged it (finding 6).
5. Tell apart two deals at one address by the time of each `Created` (finding 7).
6. Treat an ending as proof of funding. A one-tap escrow has no `Funded` event.
7. Know that the logs are transaction metadata kept by RPC nodes, not chain state. Keep an
   archive of its own.

## What I could not test

- **A real chain.**
  - How far a real validator's clock drifts from wall time around a deadline.
  - Whether RPC providers keep logs and serve `getSignaturesForAddress` for a closed address
    years later.
  - Log truncation on long transactions.
  - Transaction ordering by a leader who reorders or front-runs.
  - The real rent cuts landing as SIMD-0437 steps.
  - Circle's freeze authority. It can freeze a deposit account (every ending then fails) or the
    treasury's USDC account (registrations in USDC then fail until the payer names another
    treasury-owned account). The handoff's "USDC always, so registration can never be halted" is
    only as true as Circle's willingness.
- **A real fee payer.** `feepayer/` has no Kora configuration yet. So these are untested:
  - whether a registrant can make the sponsor pay a large priority fee (the client sets no price,
    but a registrant could add one);
  - whether extra instructions can ride on the sponsor's signature;
  - rate limits, and the sponsor rent lock of finding 3.
- **A real face check.** Didit's deduplication, and the issuer's honesty. A duplicate that passes
  the face check can never be removed, by design. A compromised issuer key can add humans until
  the treasury removes it, and those humans stay.
- **The cryptography itself.** groth16-solana's point checks, including subgroup membership of the
  second proof point; the syscalls; the July 2024 ceremony. 1,024 bit flips all being refused is
  evidence, not a proof. This needs the paid review in "Before mainnet".
- **Phones and wallets.** Whether wallets accept a program-derived address as a Solana Pay
  recipient.
  - A data point from this session: `@solana/pay` 1.0.26 derives the deposit account with no
    off-curve check, and requires it to exist and not be frozen.
  - The older `@solana/spl-token` helper refuses an off-curve owner by default
    (`TokenOwnerOffCurveError`).
  - So it depends on which helper a wallet uses. Not tried on a phone.
- **A human.** The paid review of both programs and the lawyer pass in "Before mainnet" still
  stand in full. This review is one reader with tools, not that.
- **Fresh proofs inside the fuzzer.** A proof takes about a second to make, so the registry fuzzer
  uses the five real proofs, corrupted in many ways, rather than new humans.
- **Line coverage.** See "Coverage": neither tool can measure it for these programs.

## After session 11

Carlos decided the escrow and registry questions this report left for him; session 11 built them.
The findings' tests were updated as the report said they would be: a hole closed turns a
`finding_…` test into a refusal. Where each finding stands now:

| # | Finding | Now | Test |
|---|---|---|---|
| 1 | Placeholder treasury | Unchanged; the first line of `registry/README.md`'s deploy checklist | `finding_the_placeholder_treasury_is_anyones_key` |
| 2 | Wrapped SOL | Closed: the native mint is refused at `create` | `tokens_wrapped_sol_is_refused_at_create` |
| 3 | Sponsor's rent | Narrowed: the rent payer closes a never-funded escrow after its last deadline (`close_unfunded`); a far deadline, or a funded escrow the seller never accepts, still holds it | `finding_a_sponsor_waits_for_the_last_deadline_and_cannot_close_a_funded_escrow_nobody_accepts` |
| 4, 5 | Rounding, forged events | Fixed in session 10 | as above |
| 6 | Seller consent | Closed for locks, arbiters and clocks: the seller accepts first. A full payment still needs no consent, by decision; its receipt says the seller never accepted | `consent_a_stranger_cannot_lock_an_escrow_naming_any_seller`, `consent_a_buyers_puppet_arbiter_decides_nothing_the_seller_did_not_accept`, `clock_a_past_service_time_no_longer_releases_the_moment_the_money_lands`, `finding_a_stranger_can_still_pay_any_seller_in_full_and_the_receipt_says_unaccepted`, `finding_an_invoice_with_a_service_time_releases_as_soon_as_late_money_lands` |
| 7 | One address, two deals | Closed: a funded escrow's account is a permanent receipt | `reinit_an_ended_escrows_address_never_holds_a_second_deal` |
| 8 | Vouchers | Unchanged; with a fee per token the treasury now also sets the amount | `finding_the_treasury_can_accept_a_token_it_mints_itself` |
| 9 | Paying wallet not bound | Closed in the program: the profile's wallet signs and the proof's message names it; an index still has to check the entry's wallet against the profile record | `proof_bound_to_the_profiles_wallet_and_nobody_else_can_land_it`, `the_profiles_wallet_signs_on_the_paid_and_the_sponsored_path` |
| 10 | Timing | Policy in the handoff: Soil waits a random interval before a first registration; the issuer inserts in batches | none (reasoned) |
| 11 | Treasury with no SOL | Documented in the deploy checklist; the rule is the runtime's, so no program change | `finding_a_sweep_into_a_treasury_holding_no_sol_fails_until_someone_funds_it` |
| 12 | Both token accounts | Narrowed: `withdraw` and `close_unfunded` name no seller account | `rent_returns_to_the_rent_payer_on_every_ending_and_the_escrow_account_stays` |
| 13 | `termsFor` | Closed in the client: `checkTerms` before any signature | `terms the program accepts but nobody meant are refused before signing` |
| 14 | A second payment to a one-tap link | Worse: the address never reopens, so it is stranded for good (open) | `finding_a_second_payment_to_a_one_tap_link_is_stranded_for_good` |

Two rules for an index change. Rule 4 now has something to read: a receipt's `accepted_at` (in the
account and in the `Ended` event) says whether the seller accepted. Rule 5 no longer applies to a
funded escrow, whose address never holds a second deal. And one rule is new: a badge counts for a
profile only when the `Registered` entry's wallet is the wallet its profile record declares.

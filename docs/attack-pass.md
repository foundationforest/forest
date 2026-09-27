# Attack pass: the programs, the services, and the duplicate face

Session 16, 2026-09-26. The job: assume every earlier session was wrong, try to break both sealed
Solana programs and the five public devnet services from outside, and confirm a duplicate face is
refused. Every attack is recorded below with its mechanism and the result, and either a test that
pins the refusal or a `finding_` test that pins the behaviour the program accepts by design.

Nothing here is shipped, and nothing is on mainnet. Both programs are still upgradeable on devnet,
so overflow checks were turned on and rebuilt in this session.

## Headline

- **No new exploitable hole was found in either sealed program.** The programs were already
  heavily tested; this pass turned overflow checks on, added seven tests at edges the earlier
  suites left uncovered, and re-ran every suite and both fuzzers on the new binaries. Everything
  passes.
- **The duplicate face is refused.** A fresh Didit session opened through the public issuer, with
  Carlos redoing the check on his phone, was declined as a duplicate. This also settles a standing
  open question: the foundation's workflow **does** run the face search the issuer reads.
- **The public services refuse what they should.** The issuer rejects every malformed, oversized,
  forged and replayed request tried; the fee payer refuses an unknown program, a transfer of its
  own SOL, and a priority fee; the index fabricates nothing (404 on forged reads) and weighs the
  real deal correctly.
- Everything that turned up is a **known, documented** property (a `finding_`), not a new hole. The
  ones worth Carlos's eye are collected under "Findings for Carlos" below; none is a deploy blocker
  beyond the two already-recorded placeholder-key blockers.

## 1. Overflow checks on (task item 1)

The escrow already set `overflow-checks = true` in its release profile; the registry did not. Added
it to `registry/program/Cargo.toml`, rebuilt both as SBPF v3 (and the escrow as v0 for Trident),
and re-ran everything on the new binaries.

**Binary change.** The registry's compiled bytes change, as expected; the escrow's do not (its flag
was already on). Hashes are of the default build (mainnet USDC), which differs by construction from
the devnet build in `devnet/devnet.json` (devnet substitutes its own keys and USDC).

| Program | Build | sha256 | Size |
|---|---|---|---|
| registry | v3, overflow-checks **off** (baseline) | `c33310b77544b0075fa58426652a74aa45bc3ffacf62cd92f28778ee8d3275b2` | 304,928 |
| registry | v3, overflow-checks **on** (this session) | `49b4a6af7c99ed92518aae86b67b4b3e375b89f5cfda0e6b7b799861dffbebe1` | 307,280 |
| escrow | v3, overflow-checks on (already) | `53f32c4322b8cb47411eedd15c517cdd732ffcd7492ea9535cfbef96ed4967b4` | — |
| escrow | v0, overflow-checks on (for Trident) | `57e83f6a174b801e9fa23ab5efae2f13dfb9fc4c52d9aa02c8474e6cb36af2c7` | 304,912 |

**Behaviour change.** The registry has three unchecked increments: `list_count + 1` (`open_list`),
`code_tree.count = count + 1` (`register`), and `leaf_count += 1` (`push_root`). With the flag on
they abort on overflow instead of wrapping. All are unreachable in practice — 2^32 lists, or 2^64
leaves, each needing its own transaction and rent — so no reachable behaviour changes. The tree's
own append already refused depth 33 with `checked_add` before and after. No test regressed.

**Suites re-run on the new binaries** (Solana CLI 4.2.2, platform-tools v1.54, the CI toolchain):

| Suite | Result |
|---|---|
| registry LiteSVM (`registry.rs` 31, `adversarial.rs` 19, `invariants.rs` 1) | 51 passed |
| escrow LiteSVM (`escrow.rs` 23, `adversarial.rs` 31, `one_tap.rs` 2) | 56 passed |
| registry property test, `FOREST_FUZZ_ITERATIONS=1000` | passed (43.9s) |
| escrow Trident fuzzer, `FOREST_FUZZ_ITERATIONS=50000`, on the **v0** build (as CI does) | exit 0, no invariant broke |

The escrow fuzzer runs a v0 build because Trident 0.12's runtime starts with every feature off and
refuses a v3 program; the shipped devnet build is v3. A 2,000-iteration run with metrics on
confirmed the harness actually executes: ~2,000 invariant checks, every instruction invoked
thousands of times (a mix of accepted and refused), zero panics.

## 2. The programs, attacked (task item 2)

Method: for each attack, if it already fails there is a test pinning the refusal; if it succeeds by
design there is a `finding_` test pinning the behaviour. The earlier suites (48 registry + 52
escrow tests, two fuzzers) already cover most of the skill's checklist. This pass added tests at the
edges they left, listed first.

### New tests added this session

**Registry (`registry/program/tests-litesvm/tests/adversarial.rs`):**

| Attack | Mechanism | Result | Test |
|---|---|---|---|
| Tree past its sealed depth | Force a list to `leaf_count = 2^32 − 1` with `set_account` (unreachable by real inserts), insert once (lands at depth 32), then once more | The 2^32-th leaf registers; the next is refused `TreeFull` | `tree_full_at_depth_32_is_the_sealed_bound` |
| Fee at the arithmetic edges | Accept a mint at fee 1 and another at `u64::MAX`; register paying each; then one base unit short | Exactly 1 and exactly `u64::MAX` move; one short reverts, no code written | `register_pays_the_fee_at_one_base_unit_and_at_the_maximum` |
| Wrapped SOL as a fee token | `add_token` the native mint, then register paying in it | Accepted — the registry has no WSOL special-case (the escrow does). Pinned on the record | `wrapped_sol_is_a_classic_mint_the_registry_treats_like_any_other` |

Two edges the plan named were already covered, so no duplicate test was added: **sweep after a list
handover** goes to the new owner (`a_lists_owner_hands_it_over_in_two_steps…`, registry.rs), and a
**duplicate account** in `register` (the fee's source == destination) is refused
(`the_treasury_cannot_register_for_free`).

**Escrow (`escrow/program/tests-litesvm/tests/adversarial.rs`):**

| Attack | Mechanism | Result | Test |
|---|---|---|---|
| Reused deposit address, different buyer | Buyer A funds the seller's `id`-1 deposit address before any escrow exists there; the seller then invoices the same id naming buyer B; buyer B releases to the seller | `create` adopts buyer A's money into the B deal; the seller takes it; A is not a party and cannot recover it | `finding_a_reused_deposit_address_adopts_a_stranger_buyers_money` |
| Frozen deposit account | Freeze the vault (`data[108]=2`) and try every way out | Every way out fails until it is thawed | `finding_a_frozen_deposit_account_blocks_every_way_out` |
| Frozen seller account | Freeze the seller's standard account | Every way out that pays the seller fails; ones that pay it nothing run | `finding_a_frozen_seller_account_blocks_only_the_ways_out_that_pay_the_seller` |
| Sweep then close | Sweep an unfunded escrow's excess after a rent cut, then `close_unfunded` | The two compose: creator gets the excess and the remaining rent, nothing stranded, no underflow | `close_unfunded_after_a_sweep_returns_what_is_left_to_the_creator` |

### The curiosity checklist, mapped

Each attack class the task named, and where it is refused or pinned (existing tests unless noted):

- **Account substitution** — registry `substitution_every_account_in_register` (9 swaps); escrow
  `substitution_*` (another escrow's vault, a look-alike, wrong mint/owner/program, an escrow-shaped
  account of another program).
- **Signer confusion** — registry `the_profiles_wallet_signs…`, `signers_an_issuer_of_one_list…`;
  escrow `the_wrong_signer_is_refused_for_every_instruction` (21 cases).
- **Re-entrancy through token programs** — both use a fixed `Program<Token>` id; a Token-2022
  program passed in its place is refused (registry `substitution_every_account_in_register`,
  escrow `substitution_payout_accounts…`). No program-of-this-program ever signs a CPI it did not
  originate.
- **Arithmetic at the edges (0, 1, max)** — amount 0 refused (`bad_terms_are_refused_at_creation`,
  registry `add_token…refuses_zero`); split at 1 and `u64::MAX`
  (`arithmetic_splits_at_the_edges…`); fee at 1 and `u64::MAX` (new, above).
- **256-byte scopes** — `the_longest_scope_and_did_register…` (256-byte scope, 64-byte DID; 257/65
  refused).
- **32-deep trees** — new `tree_full_at_depth_32_is_the_sealed_bound`.
- **Stale roots** — `the_128th_insert_pushes_a_root_out_of_the_ring`; a root never held, and the
  zero root, refused (`proof_bound_to_its_did_market_root_and_code`).
- **Replayed proofs** — `replay_one_code_twice_in_one_transaction_reverts_both`,
  `proof_every_single_bit_flip_in_the_points_is_refused` (1,024 flips), the escrow's
  `double_spend_a_signed_way_out_sent_twice_is_refused`.
- **Duplicate accounts in one instruction** — registry `the_treasury_cannot_register_for_free`;
  escrow `substitution_payout_accounts…` (seller account in both payout slots).
- **Closing and re-creating at the same address** — escrow
  `reinit_an_ended_escrows_address_never_holds_a_second_deal` (a funded receipt's address never
  reopens); `finding_a_part_payment_can_be_closed_under_the_buyer…` and the new
  `finding_a_reused_deposit_address…` (a never-funded id can reopen and adopts stray money — the
  documented rule, now pinned for a different buyer too). A registry code account never closes.
- **Rent tricks after the sweep** — `sweep_nothing_twice_nothing_missing_and_a_rent_rise…`,
  `sweep_takes_from_nothing_but_the_target…`; escrow `sweep_pays_only_the_recorded_rent_recipient…`
  and the new `close_unfunded_after_a_sweep…`.
- **Wrapped SOL and Token-2022 through every path** — escrow refuses both at `create`
  (`a_token_2022_mint_and_wrapped_sol_are_refused`, `tokens_wrapped_sol_is_refused_at_create`);
  registry refuses a Token-2022 mint/account/program, and treats WSOL as an ordinary classic fee
  token (new pin).
- **Two-step handovers under races** — registry treasury and list handovers
  (`a_handover_is_proposed_then_accepted…`, `a_lists_owner_hands_it_over_in_two_steps…`,
  `treasury_a_handover_in_one_transaction_needs_both_keys_and_cannot_be_replayed`); a leaked old key
  still owns until the accept, closed only by doing both steps in one transaction (documented).

## 3. The public services, attacked from outside (task item 3)

All from this container, over HTTPS, with only public information.

### The issuer (`issuer-production-fd68.up.railway.app`)

Every malformed, oversized, forged and replayed request was refused exactly as `issuer/README.md`
documents; nothing was ever `listed`.

| Request | Answer |
|---|---|
| `GET /session` | 405 `post_only` |
| `GET /nope` | 404 `not_found` |
| `OPTIONS /session` | 204 |
| `POST /session` with a body | 400 `expected_empty_body` |
| `POST /submit` not JSON / an array / missing keys | 400 `not_json` / `not_an_object` / `expected_exactly_sessionId_and_commitment` |
| `POST /submit` bad UUID / commitment `0` / `007` | 400 `bad_session_id` / `bad_commitment` / `bad_commitment` |
| `POST /submit` a valid but unknown session | 403 `unknown_session` |
| `POST /submit` a 2,000-byte body | 413 `too_large` |
| `POST /status` a forged commitment | 200 `unknown` (counted as nothing) |
| `POST /status` an on-chain commitment (from `services.md`) | 200 `listed` |
| Replay the duplicate-face session id | 403 `duplicate_face` again; nothing used up |

**Rate limit — could not be exercised from here (reported, not a new hole).** Nine `POST /session`
in a row all returned 201; the documented 5-per-hour-per-address limit never fired. This matches
`issuer/README.md`'s own statement that the limit "is not a security boundary… someone with many
addresses… opens many sessions": the agent proxy this container egresses through does not present a
single stable client address to Railway, so the per-address counter never accumulates. I could not
hold one client IP to force the 429 from this vantage, so the per-address bound is untestable here.
**Nine Didit sessions were created and left uncompleted** (uncompleted sessions cost nothing per the
README, but they clutter the Didit console — Carlos may want to delete them; ids not recorded here).

### The fee payer (`feepayer-production.up.railway.app`, Kora 2.0.5)

`getConfig` confirms the live devnet policy: the devnet registry and escrow, SPL Token, ATA and
System as the only allowed programs; the test dollar as the only paid token; `max_signatures` 3;
`max_allowed_lamports` 0.01 SOL; Mock price; every fee-payer policy false but `system.create_account`.
Three transactions it must refuse were built with `@solana/web3.js` and submitted to `signTransaction`
(nothing landed — refused at validation):

| Transaction | Kora's answer |
|---|---|
| An unknown program (Memo) | `Invalid transaction: Program MemoSq4g… is not in the allowed list` |
| A transfer out of the fee payer's own key | `Invalid transaction: Fee payer cannot be used for 'System Transfer'` |
| A priority fee (ComputeBudget) | `Invalid transaction: Program ComputeBudget111… is not in the allowed list` |

### The index (`index-production-1b6e.up.railway.app`)

- **Fabricates nothing.** A forged profile DID and a forged deal address each return 404 with a
  plain "not in this index" message.
- **Weighs the real deal correctly.** The one devnet deal's two reviews are each `counted`, evidence
  `both` (weight 1), and their reviewers are exactly the deal's two parties (buyer and seller by
  declared wallet).
- **Hostile records written through the public host, live.** A throwaway reviewer (an unused
  profile of a public test seed → a fresh DID `did:plc:cccvt7u6zqnycjkdjk4ccga7`, wallet
  `5Zjgtsrhi5uLvCdg71fBneDHUCBETYCdwt9CdYZWeBw9`, no party to the deal) wrote, through the public
  host, (a) a well-formed review of the real deal and (b) a review with a malformed `dealId`. The
  index ingested them within ~5s and counted neither as evidence:
  - **The malformed review was refused** — it appears in the attacker's folder on the host but not on
    the index (the attacker shows one `given` review, not two). The host stores Forest records
    unvalidated (validationStatus unknown); the index is what enforces `shapes/`.
  - **The non-party review was credited no evidence.** On the deal twin it is
    `{counted: true, evidence.kind: "none", note: "notTheParties"}`, contribution 0.0025 — only the
    unavoidable 0.05 reviewer floor, never the `both` (weight 1) a real party gets. The two real
    parties stay `both`. The seller's rating moved 9.0 → 9.0016 and standing 1.2512 → 1.2538: the
    hostile review cannot forge a real receipt, which is the point.
  This matches the unit tests (`index/test/e2e.test.ts`: a forged commit is refused "Invalid
  signature on commit"; an unbadged non-party review weighs the 0.05 floor). The 0.05 floor for a
  non-party/unbadged reviewer is a documented open item (declared wallets carry no proof of control),
  not a program hole — it lives in the index's open scoring.
  - **Devnet left behind:** the throwaway DID above and its folder (a profile and two review records,
    one of them the malformed one the index ignores) persist on the public host and plc.directory, as
    devnet test data.

The two index-weighing observations from the code review, neither a program hole, are under
"Findings for Carlos".

## 4. The duplicate face, live with Carlos (task item 4)

A fresh session was opened through the public issuer (`POST /session` → 201). Carlos redid the face
check on his phone. Polling `POST /submit` went `no_liveness` → `no_liveness` → **`403
duplicate_face`**: refused, the expected result.

The decision structure, read once through Didit's connector with no personal data (its
explain-decision endpoint returns no images, extracted fields or PII):

```
status: Declined,  status_override: none,  decided_by: LIVENESS
feature LIVENESS (method PASSIVE): Declined
  cause: risk DUPLICATED_FACE, effect Declined, "Duplicated face from other approved session"
lifecycle_status: false,  unexplained: false
```

This confirms end to end that the foundation's workflow runs the duplicate-face search and declines
a repeat face — settling the handoff's open question ("whether the workflow runs the face search the
issuer reads: shown only when a second check with the same face is refused"). Carlos's face was
already enrolled from the 2026-09-26 loop, so the new session was declined against that prior
approved session, as designed.

## Findings for Carlos

None is new; each is a documented property, collected here because it is the kind of thing worth a
person's eye before mainnet.

1. **Two placeholder keys are anyone's** (`TREASURY`, `FOUNDATION_ISSUER`), derived from public
   seeds in the source. Deploy blockers, already recorded; the devnet build substitutes real keys.
   Pinned: `finding_the_placeholder_treasury_is_anyones_key`,
   `finding_the_placeholder_issuer_key_is_anyones_key`.
2. **The treasury can accept a token it mints itself** — vouchers by another name. Pinned:
   `finding_the_treasury_can_accept_a_token_it_mints_itself`.
3. **A frozen token account is a denial of service.** A classic mint's freeze authority (USDC has
   one) can freeze the deposit account (blocks every way out) or a party's account (blocks the ways
   out that pay that party). Now pinned for all three targets.
4. **A reused deposit address adopts a stranger's money.** Ids must be unique per deal, and a buyer
   must pay only an escrow it has read and that names it; the program cannot tell whose money
   arrived. Pinned: `finding_a_reused_deposit_address_adopts_a_stranger_buyers_money`.
5. **The registry accepts wrapped SOL as a fee token**, where the escrow refuses it. On the record.
6. **The issuer's request limit is per client address and not a security boundary** — confirmed from
   outside (nine sessions, no 429). It stops one person from one place, nothing more, as documented.
7. **Index weighing, not a program hole:** a profile declares its own wallet with no proof of
   control, so an unbadged profile declaring another's wallet can be matched to that wallet's
   receipts, gaining at most the 0.05 floor (already an open item); and the counted review among
   duplicates is chosen by the record's own `createdAt`, so a future-dated review wins. Both live in
   the index's scoring, which is open and replaceable, never in a sealed program.

## What was skipped, and why

- **Load and rate tests that cost money or could take a service down** — not run, per the task. The
  issuer rate limit was probed to nine sessions only; the fee payer was only sent transactions it
  refuses (nothing landed, nothing paid).
- **Forging a bad-signature or another-DID commit to the index** — a commit is signed by its
  folder's key and checked by the host and the relay before the index sees it, so a forged commit
  never reaches the index (unit-tested: `index/test/e2e.test.ts` "Invalid signature on commit"). It
  cannot be produced from outside without the folder's signing key, so it was not forged live.
- **Claiming a badge by declaring another's wallet** — a badge comes from an on-chain `Registered`
  event keyed by DID, not from a folder record, so a profile cannot grant itself one; nothing to
  write.

# Security checklist: the Forest registry

Written with the safe-solana-builder skill (`.claude/skills/safe-solana-builder/`) for the free list of
badges, and redone for lines that never change (`add_proof` removed): every rule in its
`references/shared-base.md` (sections 1 to 31),
`references/anchor.md` and `references/litesvm.md`, how this program applies it or why it does not
apply, and every limit known today. The program is `program/src/`; the tests named here are in
`program/tests-litesvm/tests/`. Nothing here is shipped, and no paid review has happened.

| | |
|---|---|
| Program | `forest_registry`, `FoRBadgeLineFreeNoFeeNoAdmin1111111111111111` in the source (a placeholder nobody holds a key for); devnet `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` |
| Framework | Anchor 1.2, `cargo build-sbf --arch v3` (Solana CLI 4.2.2, platform-tools v1.54), no IDL, no warnings |
| Testing | LiteSVM, 26 tests: `registry.rs` 13, `adversarial.rs` 12, `invariants.rs` the property test (1,000 steps in CI's nightly job); the client's unit tests (12, memberships included), a local validator (`test:validator`), the devnet run with its read-only smoke tests (5), and a register through Kora on the relayer's `kora.toml` |
| Risk level | 🟢 Low by the skill's table: no token, no CPI but the system program's, no admin, no custody beyond each line's own rent deposit. Treated as sealed, so this checklist carries a High-risk decisions section. |
| Upgrade authority | Removed at mainnet deploy (`README.md`). On devnet it stays on the devnet deploy key. No pause, no admin, no override of a line. |

## High-risk decisions

Each is on purpose, and none can be changed after deploy.

1. **Sealed.** No upgrade, no pause, no way for anyone to undo or edit a line. A bug found after
   deploy stays; the remedy is a new program at a new address.
2. **Roots are not checked.** A proof's root is an input the program takes as given. Anyone can make
   a list of their own, with as many identities as they like, and write lines proven against it under
   any label. The program guarantees only one line per identity secret per label; whether a root belongs
   to an issuer worth trusting is each reader's decision.
3. **Nobody signs but the payer.** The proof is the consent: only the secret's holder can make it,
   and it binds one profile and one label. So anyone may send any instruction, a proof is public once
   sent, and a front-runner can land a person's `register` first. It gains nothing but paying the
   deposit and being recorded as payer (`finding_a_front_runner_who_strips_a_proof_costs_one_transaction_never_the_line`).
4. **A line never changes.** `register` is the only write: no instruction appends to a line, edits it
   or closes it, and `refund` moves only lamports. A line holds one issuer's root. Every other issuer
   is a membership record in the profile's folder, which the program never sees and readers check
   (`verifyMembership`). So the program has no append path to guard, and the earlier version's
   `add_proof` bytes reach no instruction (`a_line_never_grows_and_never_changes`, and the property
   test's I2).
5. **A line never closes.** Its existence is the one-line-per-code rule; closing it would reopen the
   code. Only what the rent cuts free above the minimum goes back, to the recorded payer.
6. **The profile is any 32 bytes.** The program does not check that it is a usable ed25519 key
   (`records/SPEC.md` §1); readers do (`finding_the_program_takes_any_32_bytes_as_a_profile`).

## Shared base, sections 1 to 31

### 1. Account and identity validation

- **1.1 Signer checks. Applied.** The one authority is the payer, an Anchor `Signer` in `register`,
  which pays and nothing more. No instruction takes any other signer: the proof is the authority,
  checked by verifying it against the code, label and profile it is sent with
  (`the_profile_key_signs_nothing_and_anyone_may_send`, `nothing_is_signed_but_the_payer`).
- **1.2 Ownership checks. Applied.** The line is an `Account<Line>`, owned by this program
  (`a_planted_line_owned_by_another_program_is_refused`); the system program is a `Program<System>`.
  `refund`'s payer is an `UncheckedAccount` that only ever receives lamports (anchor.md §1.1 below).
- **1.3 Account data matching. Applied.** `refund` has `has_one = payer`: lamports go only to the
  payer the line records (`refund_goes_only_to_the_recorded_payer`). `register` derives the scope
  and the message from the label and the profile it writes, so a proof binds exactly the line it
  creates (`a_proof_is_bound_to_its_label_and_profile`).
- **1.4 Type cosplay. Applied.** `Line` carries Anchor's discriminator, checked on load.
- **1.5 Reinitialization. Applied.** A line is `init` at the address derived from its code, and that
  failure is the one-line rule itself (`a_second_line_for_the_same_code_is_refused`,
  `replay_one_code_twice_in_one_transaction_reverts_both`). Lamports sent to the address first do not
  block it (`lamports_sent_to_a_line_address_first_do_not_block_it`).
- **1.6 Writable checks. Applied.** Only the line and the payer are `mut`.

### 2. PDAs

- **2.1 Canonical bumps. Applied.** Found by Anchor's `bump` at `init` and stored; `refund` reuses
  the stored bump. No instruction takes a bump from the caller.
- **2.2 PDA sharing. Applied.** One line per code, and a code is one human under one label.
- **2.3 Seed collisions. Applied.** One seed prefix, `code`, followed by exactly 32 bytes.
- **2.4 Purpose isolation. Applied.** One kind of account.

### 3. Arithmetic and logic

- **3.1 Checked math. Applied.** The only arithmetic is a line's size (bounded: at most 277 bytes)
  and the refund's excess, `saturating_sub`, after which the line must hold exactly its minimum.
  `overflow-checks = true` in the release profile.
- **3.2 Multiply before divide. Does not apply:** no division.
- **3.3 Slippage. Does not apply:** no price.
- **3.4 Lamport invariant. Applied.** `refund` moves exactly the excess from the line to the recorded
  payer. The property test checks it (I4) and that no key loses lamports in a transaction it did not
  sign (I5).

### 4. Duplicate mutable accounts. Applied.

The mutable accounts are the line and the payer. The payer signs and a line's address is a PDA,
which cannot sign, so they cannot be one account in `register`. In `refund`, passing the line as its
own payer is refused (`refund_goes_only_to_the_recorded_payer`).

### 5. CPIs. Applied.

The only CPIs are Anchor's own to the system program (`init`'s account creation), through
`Program<System>`, so the program id is checked. Nothing is read after them that they changed.

### 6. Storage and lifecycle. Applied.

A line is sized exactly once, at `init` (`Line::space`, pinned by compile-time asserts), and never
resized. It is never closed (High-risk 5).
`Rent` and `Clock` are read with `Rent::get()` and `Clock::get()`, never from a passed account.

### 7. Token-2022. Does not apply: no token.

### 8. Transaction model. Applied.

`register` is one proof, about 120,000 compute units, under the default 200,000 for one instruction,
so no transaction needs a compute-budget instruction (`what_a_line_costs`). A register is 488 to 601
bytes of 1,232.

### 9. Safe Rust. Applied.

No `unsafe`, no `unwrap` or `expect` in the program; every failure is a typed error.

### 10. The curiosity principle. Applied.

Same account twice: refused (4). Another program's account: refused (1.2). A malicious program id:
only `Program<System>`. A non-canonical bump: never taken. A proof replayed, stripped, bent in every
bit, or aimed at another code: `adversarial.rs`. The earlier version's `add_proof`: no instruction
answers it.

### 11. Oracles. Does not apply.

### 12. Fees. Does not apply: the program charges nothing.

### 13. Dust and time-limited accounts. Applied.

Lamports sent to a line (dust or not) are refunded to its payer (`refund_reaches_the_payer`). Lines
are not time-limited.

### 14. Coupled fields. Applied.

A line's fields are written together, once, at `register`, and never again. The property test checks
that a line's bytes stay exactly what `register` wrote, whatever lands after (I2).

### 15. Shared positions and pools. Does not apply.

### 16. Clock. Applied.

One field, `time`, unix seconds from the clock sysvar, written once. Nothing compares against it.

### 17. Mint integrity. Does not apply: no mint.

### 18. Input validation. Applied.

The label is at most 128 bytes (`LabelTooLong`) and must be UTF-8 (Borsh refuses otherwise:
`a_label_that_is_not_utf8_is_refused`). An empty label is allowed: the program does not care what the
text says. Every public input must be a BN254 field element (`NotAFieldElement`); the points must
decompress (`ProofMalformed`). The profile is not checked (High-risk 6).

### 19. Type narrowing. Applied.

No narrowing casts in the program.

### 20. Events. Applied by design: none.

A line is an account, so readers read accounts (`fetchLines`, one filter by profile). Nothing the
program says lives only in a log.

### 21. Reward accounting. Does not apply.

### 22. Withdrawal paths. Applied.

The only lamports the program holds are each line's deposit; what rises above the minimum has a way
out, `refund`, to the payer.

### 23. Token-2022 extensions. Does not apply.

### 24. Access control

- **24.1 Lockups. Does not apply.**
- **24.2 Admin key rotation. Does not apply: there is no admin.**

### 25. Stack frames. Applied.

Three accounts per instruction; the build shows no stack-offset warning.

### 26. State machine and lifecycle. Applied.

A line has one state, existing, entered once by `register` and absorbing: nothing changes it after.

### 27. Slippage and fee ordering. Does not apply.

### 28. Bonding curves and AMMs. Does not apply.

### 29. Permissionless initialization and user parameters

- **29.1 Frontrunnable initialization. Applied.** There is no initialization of shared state. A
  line's creator can be anyone, and gains nothing but paying (High-risk 3).
- **29.2 User parameters. Applied.** The label and the root are the user's; the label is bounded,
  and the root is 32 bytes checked to be a field element.
- **29.3, 29.4 Config. Does not apply: no config.**

### 30. Withdraw and drain. Applied.

`refund` moves exactly lamports minus the current minimum and checks the line holds exactly the
minimum after.

### 31. Miscellaneous

- **31.1 Shared config. Does not apply.**
- **31.2 Stack frames. See 25.**
- **31.3 Unclosed accounts lock rent. Applied by design:** a line never closes (High-risk 5); only
  the excess is returned.
- **31.4 Treasury. Does not apply.**
- **31.5 Token-2022 mint space. Does not apply.**
- **31.6 Signer as new account. Does not apply:** a line is a PDA.
- **31.7 Repeated actions resetting time. Applied:** `time` is written once.

## anchor.md

- **Account types.** `Account<Line>`, `Signer`, `Program<System>`, and one `UncheckedAccount`,
  `refund`'s payer, with a `/// CHECK:` comment: `has_one` ties it to the line, and it only receives
  lamports.
- **Constraints.** `init` with `seeds` and `bump` for a new line; `seeds` with the stored bump and
  `has_one = payer` for `refund`. No `realloc`: a line is never resized.
- **No `init_if_needed`, no `close`.**
- **Errors.** Six, in `errors.rs`, each with a message.
- **Build.** `overflow-checks = true`; the three features Anchor's macros test for are declared so
  the build has no warnings.

## LiteSVM checklist (litesvm.md §9)

- [x] Happy path with full state verification: `a_line_is_written_with_its_profile_code_label_root_time_and_payer`, `a_line_never_grows_and_never_changes`.
- [x] Wrong signer: there is one signer, the payer, by design; the proof is what is checked (`a_proof_is_bound_to_its_label_and_profile`, `a_proof_with_a_different_code_is_refused`).
- [x] Re-initialization fails: `a_second_line_for_the_same_code_is_refused`.
- [ ] Deadlines: none in this program.
- [x] Over-limit: `the_label_is_free_text_up_to_128_bytes`.
- [ ] Account closure: a line never closes.
- [x] Balances asserted after every transfer: `refund_reaches_the_payer`, the property test.
- [x] PDA seeds the same as on chain: `line_address` in the harness, checked against the client's `lineAddress` through the wire vectors.
- [x] `expire_blockhash()` before every send.
- [x] No `unwrap()` on sends that must fail.
- [x] Compute units logged: `what_a_line_costs`.

## Known limits

- **A self-made list is a valid list.** The registry cannot tell a trusted issuer's root from anyone
  else's; readers must (High-risk 2). An issuer that never publishes its roots backs nothing any
  reader can check.
- **Roots can link lines.** A person whose lines in two labels carry the same root, or whose
  memberships show the same rare set of roots, can be matched across those lines by anyone reading.
  Apps prove against each issuer's newest root, and a person chooses which issuers back which line
  and which memberships a profile publishes.
- **A membership is checked by readers only.** The program never sees one. A reader that skips a
  step of `verifyMembership`, or trusts roots without checking the issuer's signature on them,
  counts what it should not. Where issuers publish roots, and in what signed form, is open.
- **A line address funded first, below the line's minimum, cannot be registered through the
  relayer.** Anchor's `init` then tops the address up with a System transfer from the payer, and the
  relayer's `kora.toml` lets its key create accounts, never transfer SOL. Kora 2.0.5 refused exactly
  this on a local validator ("Fee payer cannot be used for 'System Transfer'"). It needs the code
  before its line exists, which only a sent proof shows. Any other payer still registers it, and
  what was sent counts toward the deposit (`lamports_sent_to_a_line_address_first_do_not_block_it`).
- **A refund to a payer holding no SOL waits.** The runtime refuses to leave a system account below
  its own rent minimum, so a small refund to an emptied payer is refused until it holds some SOL
  again (`finding_a_refund_to_a_payer_holding_no_sol_fails_until_someone_funds_it`). The excess stays
  in the line meanwhile.
- **Whoever pays is recorded.** When a relayer sends `register`, refunds go to it, not to the person.
- **The placeholder program id.** The source names `FoRBadgeLine…1111`, which nobody holds a key for;
  every deploy substitutes its own (`devnet/deploy.sh` in this folder).
- **Not audited.** No paid review has happened.

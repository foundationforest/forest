# Security checklist: the Forest registry

Written with the safe-solana-builder skill (kept in this repo while the programs were written, and
in its git history since) for the registry of rows, one per stamp: every rule in its
`references/shared-base.md` (sections 1 to 31), `references/anchor.md` and `references/litesvm.md`,
how this program applies it or why it does not apply, and every limit known today. The program is
`program/src/`; the tests named here are in `program/tests-litesvm/tests/`. Nothing here is in
production, and no paid review has happened.

| | |
|---|---|
| Program | `forest_registry`, `FoRRegistryRowsFreeNoFeeNoAdmin1111111111111` in the source (a placeholder nobody holds a key for); devnet `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` |
| Framework | Anchor 1.2, `cargo build-sbf --arch v3` (Solana CLI 4.2.2, platform-tools v1.54), no IDL, no warnings |
| Testing | LiteSVM, 33 tests: `registry.rs` 19, `adversarial.rs` 13, `invariants.rs` the property test (1,000 steps in CI's nightly job); the client's unit tests (20), the person circuit's (8), a local validator (`test:validator`), and the devnet run with its read-only smoke tests (5) |
| Risk level | 🟢 Low by the skill's table: no token, no CPI but the system program's, no admin, no custody beyond each row's own rent deposit. Treated as sealed, so this checklist carries a High-risk decisions section. |
| Upgrade authority | Removed at mainnet deploy (`README.md`). On devnet it stays on the devnet deploy key. No pause, no admin, no override of a row. |

## High-risk decisions

Each is on purpose, and none can be changed after a mainnet deploy.

1. **Sealed.** No upgrade, no pause, no way for anyone to undo or edit a row. A bug found after
   deploy stays; the remedy is a new program at a new address.
2. **Issuers are not checked.** The issuer's key is a public input: the proof shows that key signed
   a note for the person's secret, and the program stores it. Anyone can sign notes with a key of
   their own, for as many secrets as they like, and write rows with them under any label. The
   program guarantees only one row per stamp; whether an issuer's key is worth trusting, and from
   when, is each reader's decision (`verifyTier` gives the row's issuer and time). Any key that
   signed a note lands (`finding_the_program_takes_any_issuer_whose_note_the_proof_shows`).
3. **The main key signs, and the proof names it.** Only the main key can put a row on its profile,
   and a proof seen in flight cannot land under another profile: its message is the main key
   (`a_stranger_cannot_register_my_profile_or_take_my_proof`,
   `finding_a_proof_in_flight_cannot_be_stolen_and_a_whole_transaction_only_lands_as_sent`). The
   payer signs too, and may be anyone, the main key included.
4. **A row never changes.** `register` is the only write: no instruction edits a row or closes it,
   and `refund` moves only lamports (`a_row_never_changes`, and the property test's I2).
5. **A row never closes.** Its existence is the one-row-per-stamp rule; closing it would free the
   stamp. Only what the rent cuts free above the minimum goes back, to the recorded payer.
6. **`refund` takes any row without re-deriving its address.** A row stores its stamp but not its
   bump, and `refund` needs neither. `Account<Row>` checks the owner and the `Row` discriminator,
   and only `register` makes such an account, only at a stamp's address; an account of this program
   with other bytes is refused (`an_account_of_the_registry_that_is_not_a_row_is_refused`).
7. **The time is the clock's.** `register` takes no time; the row's `made` is
   `Clock::unix_timestamp`, the validators' estimate, which readers use as a date
   (`the_rows_time_is_set_by_the_program`).
8. **The tier is checked and not kept.** It is a public input, so a tier the issuer did not sign is
   refused (`a_tier_the_issuer_did_not_sign_is_refused`), but the row holds no tier: a profile shows
   it with the same proof attached.

## Shared base, sections 1 to 31

### 1. Account and identity validation

- **1.1 Signer checks. Applied.** `register` has two `Signer`s: the main key, which the row
  names and the proof's message binds, and the payer, which pays and nothing more
  (`the_profile_must_sign`, `register_is_signed_by_the_profile_and_the_payer_and_refund_by_nobody`).
  `refund` takes no signer: the amount and the destination come from the chain.
- **1.2 Ownership checks. Applied.** The row is an `Account<Row>`, owned by this program
  (`a_planted_row_owned_by_another_program_is_refused`); the system program is a
  `Program<System>`. `refund`'s payer is an `UncheckedAccount` that only ever receives lamports
  (anchor.md §1.1 below).
- **1.3 Account data matching. Applied.** `refund` has `has_one = payer`: lamports go only to the
  payer the row records (`refund_goes_only_to_the_recorded_payer`, and Bob's row with Alice's payer
  in `substitution_every_account`). `register` derives the scope and the message from the label and
  the signing profile, so a proof binds exactly the row it creates
  (`a_proof_is_bound_to_its_label_and_profile`).
- **1.4 Type cosplay. Applied.** `Row` carries Anchor's discriminator, checked on load; the earlier
  `Line` bytes of an earlier version and a zeroed account of this program are refused
  (`an_account_of_the_registry_that_is_not_a_row_is_refused`).
- **1.5 Reinitialization. Applied.** A row is `init` at the address derived from its stamp, and
  that failure is the one-row rule itself (`one_row_per_stamp`,
  `replay_one_stamp_twice_in_one_transaction_reverts_both`). Lamports sent to the address
  first do not block it (`lamports_sent_to_a_row_address_first_do_not_block_it`).
- **1.6 Writable checks. Applied.** Only the row and the payer are `mut`; the profile is read-only.

### 2. PDAs

- **2.1 Canonical bumps. Applied.** Found by Anchor's `bump` at `init`. No instruction takes a bump
  from the caller, and none re-derives a row's address, so the bump is not stored (High-risk 6).
- **2.2 PDA sharing. Applied.** One row per stamp, and a stamp is one person at one issuer under
  one label.
- **2.3 Seed collisions. Applied.** One seed prefix, `row`, followed by exactly 32 bytes.
- **2.4 Purpose isolation. Applied.** One kind of account.

### 3. Arithmetic and logic

- **3.1 Checked math. Applied.** The only arithmetic is a row's size (bounded: at most 308 bytes)
  and the refund's excess, `saturating_sub`, after which the row must hold exactly its minimum.
  `overflow-checks = true` in the release profile.
- **3.2 Multiply before divide. Does not apply:** no division.
- **3.3 Slippage. Does not apply:** no price.
- **3.4 Lamport invariant. Applied.** `refund` moves exactly the excess from the row to the recorded
  payer. The property test checks it (I4) and that no payer loses lamports in a transaction it did
  not sign (I5).

### 4. Duplicate mutable accounts. Applied.

The mutable accounts are the row and the payer. The payer signs and a row's address is a PDA, which
cannot sign, so they cannot be one account in `register`. The main key and the payer may be one key:
both are `Signer`s, which serialize nothing on exit, and Anchor allows them to repeat
(`anyone_may_pay_the_profile_included`). In `refund`, passing the row as its own payer is refused
(`refund_goes_only_to_the_recorded_payer`).

### 5. CPIs. Applied.

The only CPIs are Anchor's own to the system program (`init`'s account creation), through
`Program<System>`, so the program id is checked. Nothing is read after them that they changed.

### 6. Storage and lifecycle. Applied.

A row is sized exactly once, at `init` (`Row::space`, pinned by compile-time asserts), and never
resized. It is never closed (High-risk 5). `Rent` is read with `Rent::get()`, never from a passed
account.

### 7. Token-2022. Does not apply: no token.

### 8. Transaction model. Applied.

`register` is one proof, about 133,000 compute units, under the default 200,000 for one instruction,
so no transaction needs a compute-budget instruction (`what_a_row_costs`). A register with two
signatures is 617 to 730 bytes of 1,232.

### 9. Safe Rust. Applied.

No `unsafe`, no `unwrap` or `expect` in the program; every failure is a typed error.

### 10. The curiosity principle. Applied.

Same account twice: refused or harmless (4). Another program's account: refused (1.2). This
program's account that is not a row: refused (1.4). A malicious program id: only `Program<System>`.
A non-canonical bump: never taken. A proof replayed, bent in every bit, aimed at another stamp,
another issuer's key or another tier, or signed under another profile: `registry.rs` and
`adversarial.rs`.

### 11. Oracles. Does not apply.

### 12. Fees. Does not apply: the program charges nothing.

### 13. Dust and time-limited accounts. Applied.

Lamports sent to a row (dust or not) are refunded to its payer (`refund_reaches_the_payer`). Rows
are not time-limited.

### 14. Coupled fields. Applied.

A row's fields are written together, once, at `register`, and never again. The property test checks
that a row's bytes stay exactly what `register` wrote, whatever lands after (I2).

### 15. Shared positions and pools. Does not apply.

### 16. Clock. Applied.

`register` reads `Clock::get()` and stores `unix_timestamp`, in seconds, as the row's `made`; the
field says its unit. Nothing in the program compares times: the time is for readers, who stop
counting a leaked key's rows from a date. No time is taken from the caller.

### 17. Mint integrity. Does not apply: no mint.

### 18. Input validation. Applied.

The label is at most 128 bytes (`LabelTooLong`) and must be UTF-8 (Borsh refuses otherwise:
`a_label_that_is_not_utf8_is_refused`). An empty label is allowed: the program does not care what
the text says. Every public input must be a BN254 field element (`NotAFieldElement`): the stamp,
the issuer key's two numbers and the tier (`proof_bound_to_its_public_inputs_and_the_field`); the
points must decompress (`ProofMalformed`). The issuer's key is bound by the proof, not checked
against any list (High-risk 2).

### 19. Type narrowing. Applied.

No narrowing casts in the program. The clock's `i64` is stored as an `i64`.

### 20. Events. Applied by design: none.

A row is an account, so readers read accounts (`fetchRows`, filters at fixed offsets). Nothing the
program says lives only in a log.

### 21. Reward accounting. Does not apply.

### 22. Withdrawal paths. Applied.

The only lamports the program holds are each row's deposit; what rises above the minimum has a way
out, `refund`, to the payer.

### 23. Token-2022 extensions. Does not apply.

### 24. Access control

- **24.1 Lockups. Does not apply.**
- **24.2 Admin key rotation. Does not apply: there is no admin.**

### 25. Stack frames. Applied.

Four accounts in `register`, two in `refund`; the build shows no stack-offset warning.

### 26. State machine and lifecycle. Applied.

A row has one state, existing, entered once by `register` and absorbing: nothing changes it after.

### 27. Slippage and fee ordering. Does not apply.

### 28. Bonding curves and AMMs. Does not apply.

### 29. Permissionless initialization and user parameters

- **29.1 Frontrunnable initialization. Applied.** There is no shared state to initialize. A row
  needs its main key's signature, so nobody can create one for a main key they do not hold.
- **29.2 User parameters. Applied.** The label, the stamp, the issuer's key and the tier are the
  user's; the label is bounded, and the rest are field elements bound by the proof. The time is
  not the user's.
- **29.3, 29.4 Config. Does not apply: no config.**

### 30. Withdraw and drain. Applied.

`refund` moves exactly lamports minus the current minimum and checks the row holds exactly the
minimum after.

### 31. Miscellaneous

- **31.1 Shared config. Does not apply.**
- **31.2 Stack frames. See 25.**
- **31.3 Unclosed accounts lock rent. Applied by design:** a row never closes (High-risk 5); only
  the excess is returned.
- **31.4 Treasury. Does not apply.**
- **31.5 Token-2022 mint space. Does not apply.**
- **31.6 Signer as new account. Does not apply:** a row is a PDA.
- **31.7 Repeated actions resetting time. Applied by design:** a row's time is written once, at
  `register`, and a second `register` for its stamp is refused.

## anchor.md

- **Account types.** `Account<Row>`, two `Signer`s, `Program<System>`, and one `UncheckedAccount`,
  `refund`'s payer, with a `/// CHECK:` comment: `has_one` ties it to the row, and it only receives
  lamports.
- **Constraints.** `init` with `seeds` and `bump` for a new row; `has_one = payer` for `refund`. No
  `realloc`: a row is never resized.
- **No `init_if_needed`, no `close`.**
- **Errors.** Six, in `errors.rs`, each with a message.
- **Build.** `overflow-checks = true`; the three features Anchor's macros test for are declared so
  the build has no warnings.

## LiteSVM checklist (litesvm.md §9)

- [x] Happy path with full state verification: `a_row_is_written_with_its_main_key_stamp_issuer_payer_time_and_label`, `a_row_never_changes`.
- [x] Wrong signer: `the_profile_must_sign`, `a_stranger_cannot_register_my_profile_or_take_my_proof`, `a_proof_is_bound_to_its_label_and_profile`.
- [x] Re-initialization fails: `one_row_per_stamp`.
- [x] Wrong proof inputs: `a_wrong_issuer_key_is_refused`, `a_tier_the_issuer_did_not_sign_is_refused`, `a_forged_proof_is_refused`, `a_proof_with_another_stamp_is_refused`.
- [x] Time from the clock, not the caller: `the_rows_time_is_set_by_the_program`.
- [ ] Deadlines: none in this program.
- [x] Over-limit: `the_label_is_free_text_up_to_128_bytes`.
- [ ] Account closure: a row never closes.
- [x] Balances asserted after every transfer: `refund_reaches_the_payer`, the property test.
- [x] PDA seeds the same as on chain: `row_address` in the harness, checked against the client's `rowAddress` through the wire vectors.
- [x] `expire_blockhash()` before every send.
- [x] No `unwrap()` on sends that must fail.
- [x] Compute units logged: `what_a_row_costs`.

## The circuit

- [x] **The program holds the person circuit's key, and only it.** `program/src/verifying_key.rs`
  is `groth16-solana`'s converter run on `circuit/devnet/verification-key.json`
  (`registry/circuit/test/person.test.ts` checks it byte for byte), and the LiteSVM tests land only
  real proofs made with that setup. The circuit's own tests show a wrong issuer key, a forged
  signature, a note signed without the tag, a tier the issuer did not sign, another person's
  secret, another label and another main key all fail.
- [ ] **The setup is single-party.** Whoever ran `circuit/devnet/setup.sh` could forge a proof.
  Devnet only; a public setup ceremony comes before mainnet, and a new setup is a new program.

## Known limits

- **The single-party setup can forge.** Until a public setup ceremony, whoever made the devnet
  setup could prove a note no issuer signed, for any stamp, issuer key and tier. Devnet only.
- **Any key can be an issuer.** The registry cannot tell a trusted issuer's key from anyone else's;
  readers must (High-risk 2).
- **A row stays under the key it was made with.** A note under an issuer's new key gives the same
  stamp, so a row cannot move to the new key. If a key leaks, readers stop counting its rows from
  that date on; a person who registered under it after the leak holds an uncounted row and cannot
  write another for that stamp.
- **One row per issuer, not per face.** A person with notes from two issuers holds two stamps per
  label. That is how a second profile in one market works; a reader that trusts both issuers
  counts both rows.
- **A fee payer whose policy forbids transfers from its key cannot register a pre-funded address.**
  When a row's address holds lamports below the row's minimum, Anchor's `init` tops it up with a
  System transfer from the payer. Funding it first needs the stamp before its row exists, which
  only a sent proof shows. Any other payer still registers it, and what was sent counts toward the
  deposit (`lamports_sent_to_a_row_address_first_do_not_block_it`).
- **A refund to a payer holding no SOL waits.** The runtime refuses to leave a system account below
  its own rent minimum, so a small refund to an emptied payer is refused until it holds some SOL
  again (`finding_a_refund_to_a_payer_holding_no_sol_fails_until_someone_funds_it`). The excess
  stays in the row meanwhile.
- **Whoever pays is recorded.** When a fee payer pays for `register`, refunds go to it, not to the
  person.
- **The placeholder program id.** The source names `FoRRegistryRows…1111`, which nobody holds a key
  for; every deploy substitutes its own (`devnet/deploy.sh` in this folder).
- **Not audited.** No paid review has happened.

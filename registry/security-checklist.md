# Security checklist: the Forest registry, v1

Written with the safe-solana-builder skill (Frank Castle's, in `.claude/skills/safe-solana-builder/`)
when the registry's longest scope went from 64 to 256 bytes: every rule in its
`references/shared-base.md` (sections 1 to 31), `references/anchor.md` and `references/litesvm.md`,
how this program applies it or why it does not apply, and every limit known today. It is the
registry's first checklist; the program was written before the skill was in the repo, and this
reads it as it stands. The program is `program/src/`; the tests named here are in
`program/tests-litesvm/tests/`. Nothing here is shipped, and no paid review has happened.

| | |
|---|---|
| Program | `forest_registry`, v1, `FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B` for local work |
| Framework | Anchor 1.2, `cargo build-sbf` (Solana CLI 4.2.2, platform-tools v1.54), no IDL. Builds and passes as SBPF v0 and as SBPF v3 (`--arch v3`) |
| Testing | LiteSVM (48 tests: `registry.rs` 31, `adversarial.rs` 16, `invariants.rs` the property test), a local validator (the client's `test:validator`), the devnet run and its read-only smoke tests (`docs/devnet.md`). The Trident fuzzer in `program/trident-tests/` cannot run (Trident 0.12 lacks the Poseidon and alt_bn128 syscalls) and keeps a stale model |
| Risk level | 🟢 Low by the skill's table ("registry"), but it moves tokens (the fee, by CPI), has a key that turns dials (the treasury), and is sealed at deploy. Treated as 🔴 **Critical**, so this checklist carries a High-Risk Decisions section. |
| Upgrade authority | Removed at mainnet deploy (`README.md`, "The upgrade authority, and how it is removed"). No pause, no admin override of a registration. A v2 is a new program with new lists. On devnet the authority stays on the devnet deploy key. |

## High-risk decisions

Each is on purpose, and none can be changed after deploy.

1. **Sealed.** No upgrade, no pause, no way for anyone to undo or override a registration. A bug
   found after deploy stays; the only remedy is a new program with new lists that everyone joins
   again.
2. **Two placeholder keys in the source.** `TREASURY` and `FOUNDATION_ISSUER` are derived from
   public seeds so the tests can sign for them, so anyone with the repo can sign for them too.
   Deployed as they are, a stranger takes every fee and every dial, and owns list 0. Pinned by
   `finding_the_placeholder_treasury_is_anyones_key` and
   `finding_the_placeholder_issuer_key_is_anyones_key`; `README.md`'s deploy checklist says what
   replaces them. Devnet builds replace them with devnet keys (`devnet/build.sh`).
3. **One treasury key turns every dial.** It accepts mints, each at a fee it sets once, and receives
   every fee and every sweep but a list's. It can accept a token it mints itself, a voucher by
   another name (`finding_the_treasury_can_accept_a_token_it_mints_itself`); only its discipline, a
   multisig and a public policy stand against that. It moves in two steps (§24.2), with no timelock.
4. **Issuers are open, and the program checks nothing about them.** Anyone opens a list and names
   its insert keys; an insert key may insert any commitment, the same one twice included
   (`finding_an_issuer_can_insert_the_same_commitment_twice`). Every `Registered` entry names the
   list and its owner, and an index weighs a badge by who vouched.
5. **Nobody is ever removed.** Removing an insert key removes no one, a closed list keeps every
   member and root, and a duplicate human that passed a face check cannot be taken out in v1.
6. **A code account never closes.** Its existence is the one-badge rule; closing it would reopen the
   code. So its rent is never returned; only what the rent cuts free above the minimum is swept, to
   the treasury.
7. **`init` is permissionless, but writes only constants** (§29.1): the treasury, USDC and its fee,
   and list 0's owner are program constants, so whoever sends `init` first has nothing to choose.

## Shared base, sections 1 to 31

### 1. Account and identity validation

- **1.1 Signer checks. Applied.** Every authority is an Anchor `Signer`: the payer (`init`,
  `open_list`, `register`), the treasury (`propose_treasury`, `add_token`), the pending treasury
  (`accept_treasury`), a list's owner (`open_list`, `close_list`, `add_issuer`, `remove_issuer`,
  `propose_list_owner`), the pending owner (`accept_list_owner`), an insert key
  (`insert_identity`), and in `register` the profile's wallet and the fee authority. Each is then
  compared with the key recorded on chain: `has_one = treasury`, and in the handler
  `NotTheListOwner`, `NotAnIssuer`, `NotThePendingTreasury`, `NotThePendingListOwner`. The profile's
  wallet is also bound by the proof, whose message is derived from that signer's key.
  `sweep_rent` takes no signer by design. Tested by `only_the_treasury_changes_settings`,
  `an_unauthorised_key_cannot_insert`, `signers_an_issuer_of_one_list_cannot_insert_into_another`,
  `only_a_lists_owner_adds_or_removes_its_insert_keys_or_closes_it`,
  `the_profiles_wallet_signs_on_the_paid_and_the_sponsored_path` and
  `proof_bound_to_the_profiles_wallet_and_nobody_else_can_land_it`.
- **1.2 Ownership checks. Applied.** The config and code accounts are `Account<…>` and the list and
  code tree `AccountLoader<…>`, all owned by this program; token accounts and mints are
  `anchor_spl::token` types, owned by the classic token program; programs are `Program<…>`. The one
  unchecked target, `sweep_rent`'s, is checked by hand (anchor.md §1.1 below). Tested by
  `substitution_every_account_in_register` and `a_sweep_cannot_be_pointed_anywhere_else`.
- **1.3 Account data matching. Applied.** `has_one = treasury` on the config for the treasury's
  instructions; `token::authority = fee_authority` on the fee's source and
  `token::authority = config.treasury` on its destination; the two token accounts' mints must match
  (`MintMismatch`); the list named in the arguments must be the list the seeds give (`WrongList`);
  `sweep_rent`'s recipient is read from the chain, never taken from the caller.
- **1.4 Type cosplay. Applied.** Every account type carries Anchor's 8-byte discriminator, checked on
  load; `sweep_rent` checks a list's discriminator and length by hand before reading its owner.
- **1.5 Reinitialization. Applied.** The config, list 0 and the code tree are created with `init`,
  so a second `init` fails (`init_runs_once_and_writes_only_the_constants`). A new list is `init` at
  the next index. A code account is `init` at an address derived from the code, and that failure is
  the one-badge rule itself (`a_code_cannot_be_used_twice`,
  `replay_one_code_twice_in_one_transaction_reverts_both`); lamports sent to a code's address first
  do not block it (`replay_lamports_sent_to_a_code_address_first_do_not_block_it`).
- **1.6 Writable checks. Applied.** Only the accounts an instruction writes are `mut`.

### 2. PDAs

- **2.1 Canonical bumps. Applied.** Every PDA is found by Anchor's `bump` at creation and its bump
  stored (`config.bump`, `list.bump`, `code_tree.bump`, `used_code.bump`). The config's later
  constraints reuse the stored bump; the list's and the code tree's re-derive the canonical bump
  with `bump`, which costs compute, not safety. No instruction takes a bump from the caller.
- **2.2 PDA sharing. Applied.** The config and the code tree are one each by design; each list is
  its own address by index; each code its own address.
- **2.3 Seed collisions. Applied.** Four distinct prefixes, `config`, `list`, `code-tree` and
  `code`, each followed by nothing or by a fixed-length value (a list's index as 4 bytes, a code as
  32), so no two kinds of account can share an address.
- **2.4 Purpose isolation. Applied.** One kind of PDA per purpose.

### 3. Arithmetic and logic

- **3.1 Checked math. Applied, with one unchecked counter.** The fee is read, never computed. The
  trees' counts are bounded by `tree::append`, which uses `checked_add` and refuses depth 33
  (`TreeFull`), so the `+ 1` after it cannot overflow. `sweep_rent` subtracts with
  `saturating_sub`, moves only the excess, and checks the target ends exactly at its minimum.
  `open_list`'s `list_count + 1` is unchecked: it wraps only after 2^32 lists, each paying a list's
  rent, and a wrap makes the next `open_list` fail (list 0's address is taken), so it can stop new
  lists, never corrupt one. The release profile does not set `overflow-checks` (Known limits).
- **3.2 Multiply before divide. Does not apply:** no division.
- **3.3 Slippage. Does not apply:** no price. Each mint's fee is fixed when it is accepted and never
  changes.
- **3.4 Lamport invariant. Applied.** `sweep_rent` moves exactly the excess from one account to one
  recipient; nothing else moves lamports but the system program's account creation. No account is
  ever closed.

### 4. Duplicate mutable accounts. Applied.

`register`'s mutable accounts are the code tree, the new code account, the payer and the two token
accounts. The fee's source and destination must differ (`FeeGoesNowhere`, after Anchor's own
duplicate check), so the treasury cannot pay itself for a badge
(`the_treasury_cannot_register_for_free`). In `sweep_rent`, the target is a PDA of this program and
the recipient must be a list's owner or the treasury, keys that had to sign to get there, which a
PDA of this program never does.

### 5. CPIs

- **5.1 Program IDs. Applied.** The only CPIs are the token program's `transfer` (`Program<Token>`)
  and the system program's account creation through Anchor's `init` (`Program<System>`).
- **5.2 Reload after CPI. Applied:** nothing is read after the transfer.
- **5.3 Signer pass-through. Applied.** The transfer carries only the fee authority's signature,
  which it needs.
- **5.4 SOL around CPI. Does not apply:** the only callees are the classic token and system
  programs, fixed by address.
- **5.5 Post-CPI ownership. Does not apply,** for the same reason.
- **5.6 Errors propagate. Applied:** every CPI ends in `?`.
- **5.7 invoke vs invoke_signed. Applied:** no PDA of this program ever signs.
- **5.8 Defense in depth. Applied:** the program holds no tokens. The fee goes straight from the
  payer's account to the treasury's.

### 6. Storage and lifecycle

- **6.1 Storage. Applied.** Every size is an explicit `LEN` (config 710, list 5,520, code tree 1,104,
  code 1, each after the discriminator), pinned by compile-time assertions. The two big accounts are
  zero-copy `repr(C)`.
- **6.2 Rent. Applied:** Anchor's `init` funds every account at the rent-exempt minimum.
- **6.3 Closing. Does not apply:** no account closes, by design (High-risk decision 6).
- **6.4 Sysvars. Applied:** rent is read with `Rent::get()`, a syscall; no sysvar account is passed.

### 7. Token-2022. Applied by refusal.

The program uses the classic `token::transfer` on purpose, and its token types are
`anchor_spl::token`'s, owned by the classic token program, so a Token-2022 mint cannot be accepted
and a Token-2022 account cannot pay (`substitution_a_token_2022_mint_cannot_be_accepted`). USDC is a
classic mint.

### 8. Transaction model. Applied.

A registration is one transaction: the code written, the tree appended and the fee paid all revert
together (`too_little_paid_writes_nothing`). It uses about 133,000 to 139,000 compute units of
1,400,000, and the client sets a limit. Its size: 830 bytes of 1,232 at an ordinary scope; the
largest, a 256-byte scope and a 64-byte DID, is 1,105 bytes on either payment path and 1,152 with a
fee payer's payment instruction added (`what_a_registration_costs`). No lookup table; every signer
inline.

### 9. Safe Rust

- **9.1 Vectors. Applied.** No `vec![0, N]`.
- **9.2 No `unsafe`. Applied.** `sweep_rent` reads a list with `bytemuck::from_bytes`, the same safe
  cast Anchor's zero-copy loader makes, after checking the length and the discriminator.
- **9.3 `remaining_accounts`. Does not apply:** not read.
- **9.4 No panics on user input. Applied:** no `unwrap()` or `expect()` in `src/`; every failure is
  a `RegistryError` or Anchor's.

### 10. The curiosity principle. Applied.

The same account twice: §4. Another program's account: §1.2. A Token-2022 mint: §7. A CPI that does
nothing: the token program's transfer fails or moves the amount. A malicious program id: §5.1. A
non-canonical bump: §2.1. And for a proof: every public input below the field's order, the scope
and message derived by the program, never taken from the caller, and every single bit flip in the
points refused (`proof_every_single_bit_flip_in_the_points_is_refused`,
`proof_bound_to_its_did_market_root_and_code`).

### 11. Oracles. Does not apply.

### 12. Fees. Applied.

One rule on the one path that charges: every `register` pays the fee recorded for its mint, USDC's
constant or the treasury's once-set amount, from the fee authority's account to the treasury's.
There is no other path to a badge.

### 13. Dust and time-limited accounts. Applied.

No token account is ever closed, so dust blocks nothing. Lamports sent to a code's address before it
is used do not block it (1.5). There are no time-limited accounts. No `init_if_needed`.

### 14. Coupled fields. Applied.

A list's root, its ring of recent roots and its count move together in `push_root`; the code tree's
count and root together; the pending treasury and a list's pending owner are cleared by the accept
that consumes them; a mint and its fee are written at the same index with the count.

### 15. Shared positions and pools. Does not apply.

### 16. Clock. Does not apply: the program reads no clock.

### 17. Mint integrity

- **Applied:** `init` requires USDC to count in six decimals (`WrongDecimals`), because 250,000 is
  0.25 only then (`init_takes_usdc_only_at_its_address_and_in_six_decimals`). Every other mint's fee
  is in its own base units, so its decimals are logged for readers and never relied on.
- **Close authority. Does not apply:** a classic mint has none.
- **Freeze authority. Known limit:** USDC's issuer can freeze a payer's account or the treasury's,
  which stops registrations paid from it, or all registrations in that mint.

### 18. Input validation. Applied.

The scope is 1 to 256 bytes and the DID 1 to 64 (`MarketNameLength`, `DidLength`; borsh refuses
invalid UTF-8); both are hashed, so the bounds only size the transaction and the log
(`the_longest_scope_and_did_register_and_the_entry_carries_both_whole`; a 257-byte scope and a
65-byte DID refused in `proof_bound_to_its_did_market_root_and_code`). Every public input and every
commitment must be below BN254's scalar order, and neither a commitment nor a root may be zero. The
root must be one of the list's last 128. A fee must be above zero.

### 19. Type narrowing. Applied.

The `as u8` casts of the mint and insert-key counts are bounded by `MAX_MINTS` (16) and
`MAX_ISSUERS` (8), checked first. Fees are `u64` in the state, the instruction and the events; list
indexes `u32` everywhere.

### 20. Events. Applied.

Every change emits a structured Anchor event: `RegistryOpened`, `TreasuryProposed`,
`TreasuryChanged`, `ListOpened`, `ListClosed`, `ListOwnerProposed`, `ListOwnerChanged`,
`IssuerChanged`, `IdentityInserted`, `Registered`, `TokenAccepted`, `RentSwept`. The largest,
`Registered` with a 256-byte scope and a 64-byte DID, is about 430 bytes, far from the 10 KB log
limit. The entry lives in the log and in no account, on purpose; the code itself is in an account
and in the code tree, so an index keeps its own archive of the log
(`docs/decisions/adversarial-review-1.md`).

### 21. Reward accounting. Does not apply.

### 22. Withdrawal paths. Applied.

The program holds no tokens. Every PDA's lamports above its minimum have a way out,
`sweep_rent`; the minimum itself stays by design (High-risk decision 6).

### 23. Token-2022 extensions. Does not apply: Token-2022 is refused (7).

### 24. Access control

- **24.1 Lockups. Does not apply.**
- **24.2 Two-step rotation. Applied, twice:** the treasury (`propose_treasury`, `accept_treasury`)
  and each list's owner (`propose_list_owner`, `accept_list_owner`), each with a pending slot, the
  new key's signature to accept, and `None` to clear. No timelock (High-risk decision 3). Tested by
  `a_handover_is_proposed_then_accepted_and_only_then_does_anything_move`,
  `treasury_a_handover_in_one_transaction_needs_both_keys_and_cannot_be_replayed` and
  `a_lists_owner_hands_it_over_in_two_steps_and_only_then_does_anything_move`.

### 25. Stack frames. Applied.

`cargo build-sbf` reports no stack-offset warning, as v0 or as v3. The two big accounts are
zero-copy, so a registration never copies 5.5 kB.

### 26. State machine and lifecycle. Applied.

A list is open or closed, and closed is absorbing: nothing reopens it
(`a_closed_list_takes_no_new_members_and_every_proof_against_it_stays_valid`). A code is unused or
used, and used is absorbing: its account never closes. No timestamps exist to misuse.

### 27. Slippage and fee ordering. Does not apply.

### 28. Bonding curves and AMMs. Does not apply.

### 29. Permissionless initialization and user parameters

- **29.1 Frontrunnable init. Applied:** `init` writes only constants (High-risk decision 7). A new
  list's owner signs, so no list is recorded as owned by a key that did not agree. Two
  `open_list` calls racing for one index: the second fails its seeds and is sent again.
- **29.2 User parameters. Applied:** a list's owner and insert keys shape only that list; what a
  badge from it is worth is the index's call.
- **29.3 Config that breaks live entities. Applied:** a mint's fee is written once and never
  changed, and nothing removes a mint, so no dial can strand a registration in flight except the
  treasury moving, which changes where the next fee lands.
- **29.4 "No change" semantics. Applied:** each proposal instruction sets one field; `None` means
  clear, and there is nothing else to leave unchanged.

### 30. Withdraw and drain. Applied.

`sweep_rent` takes only what is above the current rent-exempt minimum, to the one recipient the
program reads, and leaves the account at exactly that minimum
(`a_sweep_leaves_exactly_the_new_minimum`,
`sweep_nothing_twice_nothing_missing_and_a_rent_rise_freezes_nothing`).

### 31. Miscellaneous

- **31.1 Mutable shared config. Applied:** fees are fixed per mint (29.3).
- **31.3 Unclosed accounts. Applied, by design:** code accounts and lists are never closed (6.3).
- **31.4 Treasury can receive tokens. Applied:** the treasury is a key that signed to become the
  treasury, so it can move what it receives. A registration needs a token account the treasury owns
  in the fee's mint; until one exists, registrations in that mint fail, and anyone may make it.
- **31.6 Signer-as-new-account. Does not apply:** every account the program creates is a PDA.
- **31.7 Repeated privileged resets. Does not apply:** no timers.

## anchor.md

- **§1 Account types. Applied.** `Account<…>`, `AccountLoader<…>`, `Signer`, `Program<…>`
  throughout. Two `UncheckedAccount`s, both in `sweep_rent`, each with its `/// CHECK:`: the target
  (its address derived by the program from the seeds the caller names, its owner required to be
  this program, and for a list its discriminator and length), and the recipient (required to equal
  the list's owner or the config's treasury, read from the chain; it only receives lamports).
- **§2.2 `has_one`. Applied** for the treasury. A list's owner, its insert keys and the pending keys
  are checked in the handlers instead, on purpose, so each rule is findable in the program's text.
- **§2.3 Seeds and bumps. Applied** (§2.1 above).
- **§2.4 `init` only. Applied:** no `init_if_needed`.
- **§2.5 `close`. Does not apply:** nothing closes.
- **§2.6 `realloc`. Does not apply:** no account changes size.
- **§3.1 `reload()`. Applied:** nothing is read after a CPI.
- **§3.2 Initialization once. Applied** (§1.5 above).
- **§4 Token operations. Deliberately classic.** `token::transfer`, not `transfer_checked`:
  Token-2022 is refused (§7 above), and a registration does not carry the mint. USDC's decimals are
  checked at `init`.
- **§5 CPI. Applied:** `Program<Token>`, and a `CpiContext` holding only the transfer's accounts.
- **§6 Errors. Applied:** `RegistryError`, each with a message; `require!` and its typed forms.
- **§8 Build. Two notes.** The release profile sets no `overflow-checks` (Known limits), and Anchor
  1.2's derive macros print `unexpected cfg` warnings for `anchor-debug`, which are cosmetic.

## LiteSVM checklist (litesvm.md §9)

- **Happy path, full state.** `two_humans_register_in_two_markets_each` (entries, code accounts,
  balances, both trees rebuilt and compared) and
  `the_longest_scope_and_did_register_and_the_entry_carries_both_whole`.
- **Wrong signer.** §1.1 above.
- **Re-initialization.** `init_runs_once_and_writes_only_the_constants`,
  `a_code_cannot_be_used_twice`.
- **Deadlines.** Does not apply: no clock. The ring of recent roots is the one sequence rule:
  `the_128th_insert_pushes_a_root_out_of_the_ring`.
- **Over-limit and zero.** A zero fee, a 257-byte scope, a 65-byte DID, one base unit short
  (`add_token_records_the_fee_the_treasury_sets_once_and_refuses_zero`,
  `proof_bound_to_its_did_market_root_and_code`, `too_little_paid_writes_nothing`). The mint and
  insert-key caps (16, 8) are covered only by the property test's random flows.
- **Closure.** Does not apply: nothing closes.
- **Token balances.** Asserted after every paid registration and every sweep.
- **PDA seeds.** Written out a second time by hand in `tests-litesvm/src/lib.rs`.
- **`expire_blockhash()`.** The harness calls it before every transaction.
- **No `unwrap()` on expected failures.** Refusals use `expect_err` or `err()`.
- **Compute units.** `what_a_registration_costs` prints them; there is no `zz_cu_summary` test.

## Known limits

1. The placeholder `TREASURY` and `FOUNDATION_ISSUER` (High-risk decision 2).
2. The treasury can accept a self-minted token, and no timelock guards its handover (decision 3).
3. An insert key can insert anything, twice included, and nobody is ever removed (decisions 4, 5).
4. USDC's freeze authority can stop registrations paid from, or into, a frozen account (§17).
5. A code account's rent is never returned, and its excess sweeps to the treasury, not to whoever
   paid it (decision 6; open in the handoff).
6. `list_count + 1` is unchecked, and the release profile sets no `overflow-checks` (§3.1). Both are
   program changes, possible only before deploy.
7. Anyone can open lists without limit, and a race for one index makes the loser send again (§29.1).
8. A human who holds another profile's wallet can badge that profile; the later circuit under the
   handoff's Open closes it.
9. The Trident fuzzer cannot run, and its model is stale; `invariants.rs` is the property test kept
   current.
10. No paid review has happened.

# Session log: the escrow, v2 (2026-09-30)

This session touched only `escrow/`, as asked, so its built, learned and open are here rather than
in `docs/changes.md`; a consolidation session folds them in, as "Building in parallel" in the
handoff says for `docs/changes/<topic>.md`.

## Built

- `escrow/v2/program`: the escrow, v2. v1 plus `object`, the funding time on every receipt, and
  `sweep_rent` to the payer recorded at `create`. v1's layout kept in the first 256 bytes, 41
  appended; v1's error codes kept, four appended. Builds SBPF v3 with no warning.
- `escrow/v2/program/tests-litesvm`: v1's 56 tests adapted, one added to `one_tap.rs` (a marked
  invoice keeps the mark's time), and `objection.rs` (7): 64 in all, green. Each of the four new
  rules, removed from the program, fails at least one.
- `escrow/v2/client`: v1's client for v2, `objectIx` and `canObject` added, the Solana Pay helpers
  (`pay.ts`: `solanaPayUrl`, `invoice`, `formatAmount`, `awaitingPayment`, `depositAddress`)
  removed. Type-check and 16 tests green.
- Devnet: v2 at `B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7`, 291,568 bytes, SBPF v3, the
  deployed bytes checked against the build, 1.4843424 SOL spent exactly as computed; upgrade
  authority on the deploy key. v1 at `3vAVLw…CbeR` untouched (last deployed in slot 504106452,
  before and after). Two deals through the client: an invoice paid in one tap, its receipt funded
  and ended at the same second though nobody marked it; and a buyer's escrow with a one-day timer
  to the seller, marked, objected to by the buyer, then split 60/40 by both.
  `escrow/v2/devnet/devnet.json` has every signature.

## Learned

- The deploy key held 5.80 SOL before this deploy, where the handoff (read September 26) says
  1.80; the founder added the difference. After this deploy it holds 4.317.
- Devnet's rent rate is 5,080 lamports a byte, today's mainnet rate, so no sweep has anything to
  move there yet; the sweep to the payer is tested under LiteSVM only.

## Decided (Carlos, 2026-09-30)

- The sweep goes to the recorded payer, a fee payer included: it keeps refunds from Solana's rent
  cuts and says so plainly to people. Its "charges exactly what it spends" line is updated in the
  services' repo, not here.
- One objection per escrow; its deadline is the timer's due time; it needs no timer and no money;
  `close_unfunded` still runs after one.
- CI for `escrow/v2`, the fee payer's allowlist and the index reading v2 are later sessions' work.

## Open

- **CI** (mechanical, a later session): `.github/workflows/checks.yml` builds and tests v1 only. v2
  needs the same three lines in the `programs` job and a matrix entry for `escrow/v2/client`.
- **The fee payer and the index** (mechanical, later sessions): `feepayer/kora.toml` allows v1's
  program id only, so the public fee payer refuses v2 transactions; the index follows one escrow
  program id (already open in the handoff: "a list of ids, each with its adapter").
- **Whether the receipt should say the funding was marked** (program, `README.md`, "Chosen, not
  decided" 1): not asked; as built, it does not.
- **The fuzzer and the validator test** (mechanical): not carried over to v2.
- **The handoff and `docs/devnet.md`** (mechanical): describe v1 only; the consolidation adds v2.

# Session log: the escrow, v2, takes both token programs (2026-09-30)

Carlos asked, before sealing, for v2 to take Token-2022 mints as well as classic ones, touching only
`escrow/v2/`, so this log is here, as the one above.

## Built

- `escrow/v2/program`: every mint of either token program, the token program named checked against
  the mint's owner; wrapped SOL of either program and a Token-2022 mint with a transfer fee (or a
  confidential transfer fee) refused at `create` (`TransferFee`, 6029); every payment out a
  `transfer_checked` built by hand so a transfer hook's accounts, the instruction's remaining
  accounts, go along, each without a signature; every way out names the mint after the deposit
  account; the deposit account and each party's standard account under the mint's token program.
  The account layout is unchanged. 314,336 bytes (from 291,568), SBPF v3, no warning.
- `escrow/v2/program/tests-litesvm`: the harness takes a token program; the 64 classic tests pass
  on the changed program, two rewritten where they said Token-2022 is refused.
  `token_2022.rs` (22): a mint made by Token-2022's own instructions with every extension Open USD
  has, compared type by type and in order with the mainnet account's bytes (embedded, read at slot
  452,061,257); every way out, the one taps, a part payment and late money, with the hook naming no
  program and naming a builtin test hook that checks it is called mid-transfer with no signer and
  counts its calls; a hook switched on after funding; each hook account needed; a spy in Token-2022's
  place showing the escrow forwards no signature; pause, freeze, frozen-by-default and the permanent
  delegate used as an issuer would; a transfer-fee mint refused at 0 and 50 bps. 86 in all, green.
  Removing each of the five new rules fails at least one test.
- `escrow/v2/client`: `tokenOf` (a mint's program and decimals, with the program's refusals),
  every builder under either program with hook accounts appended as non-signers, `transferIx` now a
  `transfer_checked`, `hookAccounts` (spl-token's own resolver through the caller's reader, a deposit
  address the same transaction makes read as planned) and `payoutTransfers`. `@solana/spl-token`
  0.4.9 moves to dependencies. 19 tests, green; type-check clean.
- Devnet: v2 at **`FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`** (label `escrow-v2-program-2`),
  deployed bytes checked against the build, 1.600113840 SOL spent exactly as computed; upgrade
  authority on the deploy key. v1 (`3vAVLw…CbeR`, slot 504,106,452) and the first v2
  (`B3p13G…jKPi7`, slot 505,732,152) untouched, the first v2's record kept under `earlier`. Four
  deals through the client: an invoice paid in one tap and an objected 60/40 split in the classic
  test dollar, and the same two in a Token-2022 dollar made there with Open USD's eight extensions
  (`g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`, the devnet payer holding every issuer role). A
  second run sends nothing. `escrow/v2/devnet/devnet.json` has every signature.

## Learned

- **Open USD has more than the request listed.** On mainnet its mint also carries a mint close
  authority, a default account state (initialized; its freeze authority can switch it to frozen)
  and confidential transfers (no auto-approve, no auditor), beside the permanent delegate, pause,
  freeze authority, a hook naming no program, and metadata with its pointer. The tests use all
  eight.
- **Anchor's `token_interface::transfer_checked` drops remaining accounts,** so a hook's accounts
  never reach the token program through it; the escrow builds the instruction itself.
- **SPL's Rust resolver, and Token-2022's on-chain one in the crate version here, mark every hook
  account as a non-signer;** `@solana/spl-token` 0.4.9's JS resolver keeps a list's signer flag. The
  escrow strips it either way.
- **A hook that reads a destination's data cannot be resolved before that account exists,** as in a
  one tap: the client reads the planned deposit address as a fresh account of the escrow.
- **Token-2022 refuses a plain `Transfer` from an account with a hook extension,** even with no hook
  program named: wallets paying Open USD in must use `transfer_checked`.
- A deposit account with Open USD's extensions is 179 bytes (165 classic): 1,559,560 lamports at
  today's rate.
- The deploy key held 2.513640720 SOL before this deploy, not the 4.317 the first v2 session left;
  something spent 1.80 in between. It holds 0.913526880 now, too little for another deploy of this
  size. Devnet's rent is still 5,080 lamports a byte.
- The CI workflow already builds v2 and runs its LiteSVM tests; the README said it did not.

## Chosen, not decided

As `README.md` lists (6 to 10): the token program is not stored; the mint goes after the deposit
account; hook accounts forwarded unchecked and never signing; the confidential transfer fee and
Token-2022's wrapped SOL refused beside the transfer fee; every other extension accepted.

## Open

- **Extensions Open USD does not have** (program, before sealing): a non-transferable mint can
  strand an escrow its issuer mints into, and a scaled or interest-bearing mint shows amounts that
  drift; both are accepted as built. Refuse them too, or keep "only the transfer fee". *Needs
  Carlos.*
- **The fee payer** (`feepayer/`): Kora allows v1's program id only, and whether Kora 2.0.5 takes a
  Token-2022 dollar as payment, and passes a hook's accounts, is not checked. *Mechanical.*
- **The index** reads v1's escrow only; v2's receipts in a Token-2022 dollar need its program id and
  the mint's owner. *Mechanical.*
- **CI** runs v2's LiteSVM tests but not `escrow/v2/client`'s: a matrix entry in
  `.github/workflows/checks.yml`. *Mechanical.*
- **The handoff and `docs/devnet.md`** describe v1, classic tokens only; the consolidation adds v2,
  both token programs and the new devnet id. `CLAUDE.md`'s "Escrow v1: … classic SPL tokens only"
  is v1's and stays true; v2's rule is Carlos's to write there. *Needs Carlos.*
- **The deploy key** needs devnet SOL before any further deploy. *Mechanical.*
- **A real hook program** has not run against the escrow on devnet; the test hook is a LiteSVM
  builtin. *Mechanical.*

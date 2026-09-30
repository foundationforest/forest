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

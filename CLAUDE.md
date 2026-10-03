This repo is `forest`: the standards every Forest app shares (keys, records, the registry, the
escrow). Read `README.md` and the README of the directory you work in before any task.

## Words

Use these words: seed, main key, profile, address, label, stamp, issuer, list, registry, row,
record, folder, host, access key, permissions, private, envelope, reading key, inbox, blob, escrow,
receipt, deal, index, fee payer, app, market, role, ramp, and sealed (for programs only). Plain
words, no em-dashes.

Rules for apps: `keys/README.md`, Rules for apps that hold keys. Never copy them here.

## Programs

For any change to a Solana program, use the safe-solana-builder skill, and keep its security
checklist next to the program (`registry/security-checklist.md`, `escrow/security-checklist.md`).

## How to work in this repo

- Work in plan mode. One task per session. Open a pull request; never push to main.
- The promises in each README change only when Carlos says so in a chat; never change one as a side
  effect of a task.
- The repo is `keys/`, `records/`, `registry/`, `escrow/`, `README.md`, `CLAUDE.md` and `LICENSE`,
  with `.github/` and `.claude/`. Each directory has one README: what it is, how it works, promises,
  limits, FAQ last. The README is the standard.
- Keep the docs true in the same pull request: a change that makes a README wrong fixes it. A README
  says only what the code does today. Say "on devnet" for what runs; never state anything as
  shipped.
- When the plan is silent, choose the option that adds no rule and no text a person reads. Write
  its reason down: as a question in the FAQ of the directory it belongs to (the top README's for the
  whole repo) if it shapes Forest, otherwise in a comment beside the code. Ask only when the choice
  changes a sealed program or spends money.
- Devnet: each program's `devnet/deploy.sh` holds the key recipe it needs and writes its own
  `devnet/devnet.json`. No private key and no phrase ever goes in the repo.
- Run what `.github/workflows/checks.yml` runs before you push (Node 22.18 or later; Solana CLI
  4.2.2). A test that skips fails CI: the summary must say `# skipped 0`.

```
# Each package: install, type-check, tests that need no chain.
# keys first: records and registry/client read it.
for d in keys records registry/client escrow/client; do
  (cd "$d" && npm ci && npm run check && npm test)
done

# Each program: build as SBPF v3, then its LiteSVM tests against that build.
for p in registry/program escrow/program; do
  (cd "$p" && cargo build-sbf --arch v3 && cd tests-litesvm && cargo test)
done
```

The slower checks (the registry client on a local validator, the registry's property test, the
escrow's fuzzer) run nightly in CI; each directory's README says how to run them.

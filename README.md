# forest

Devnet only: everything here runs on Solana devnet or nowhere. Nothing is on mainnet, and nothing
is shipped.

Forest lets a person own their profile, their offers and their reputation, and deal with strangers
with no platform in between. A profile is one key the person holds; everything it says is a signed
record, kept on hosts that apps run. An issuer checks once that someone is one real human and adds
their stamp to its list, which lets them put one row per label on a free public registry without
saying who they are. Money between two strangers waits in an escrow and leaves only when both sides
agree. Any app,
index or AI can read the records and the chain; none of them holds anyone's keys.

## What this repo holds

The pieces everyone shares: the records protocol, the keys standard, and two sealed Solana programs,
the registry and the escrow, each with its client.

What it does not hold:

- **Services:** the index, the issuer and the relayer live in
  [foundationforest/services](https://github.com/foundationforest/services).
- **The market directory:** the recommended labels live in
  [foundationforest/markets](https://github.com/foundationforest/markets).
- **Apps:** Roots and any other app live in their own repos.

| Folder | What it is | Status |
|---|---|---|
| [`records/`](records/README.md) | The records protocol: its spec, the library, a reference host, private records, and the three record shapes (profile, offer, review) | Tested; not deployed |
| [`keys/`](keys/README.md) | The keys standard: a seed of 24 words, and every key a person uses mixed from it | Tested; not deployed |
| [`registry/`](registry/README.md) | Sealed program and client: one row per person per label per keeper, free | On devnet |
| [`escrow/`](escrow/README.md) | Sealed program and client: money out when both sides agree, or by an arbiter or timer set at the start; either side can object; classic and Token-2022 tokens | On devnet |
| [`devnet/`](devnet/README.md) | The devnet key recipe, and the shared devnet record | |
| [`docs/`](docs/) | [Why things are as they are](docs/decisions.md); [what runs on devnet](docs/devnet.md) | |
| [`.claude/skills/safe-solana-builder/`](.claude/skills/safe-solana-builder/SKILL.md) | The security checklist every program change goes through | |

## Run the checks

What `.github/workflows/checks.yml` runs on every pull request. Node 22.18 or later; Solana CLI
4.2.2 for the programs.

```
# Each package: install, type-check, tests that need no chain. keys first: records and registry/client read it.
for d in keys records registry/client escrow/client; do
  (cd "$d" && npm ci && npm run check && npm test)
done

# Each program: build as SBPF v3, then its LiteSVM tests against that build.
for p in registry/program escrow/program; do
  (cd "$p" && cargo build-sbf --arch v3 && cd tests-litesvm && cargo test)
done
```

A test that cannot find what it needs skips; the workflow fails on any skip. The slower checks (the
registry client's local-validator test, the registry's property test, the escrow's fuzzer) run
nightly there; each folder's README says how to run them.

Licensed Apache 2.0. [`CLAUDE.md`](CLAUDE.md) holds the rules for AI sessions working here.

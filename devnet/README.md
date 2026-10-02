# devnet

Devnet only: these scripts touch Solana devnet and never mainnet.

Up: [the repo](../README.md). What runs on devnet now, and how to check it:
[docs/devnet.md](../docs/devnet.md).

Every devnet key comes from one phrase, so any machine holding the phrase gets the same keys, the
same program ids and the same addresses. This folder holds that recipe and the shared public record.
The registry and the escrow deploy with their own scripts
([registry/devnet/](../registry/devnet/deploy.sh), [escrow/devnet/](../escrow/devnet/deploy.sh)),
from the same keys, and read this record.

| File | What it does |
|---|---|
| `keys.sh` | Derives every key from the phrase and writes the keypair files outside the repo |
| `devnet.json` | The public record: keys, the test dollar, the closed first registry, and escrow v1's deploy and deals (escrow v1 still runs on devnet; its source and the scripts that built and deployed it are no longer in this repo) |

## The key recipe

```
phrase = FOREST_DEVNET_SEED, Unicode NFKD, trimmed, runs of whitespace made one space
seed   = PBKDF2-HMAC-SHA256(phrase, salt = "forest-devnet:" + label, 600,000 iterations, 32 bytes)
key    = the ed25519 keypair whose secret seed is `seed` (Solana's Keypair.fromSeed)
```

`keys.sh` derives `deploy` (pays for deploys and holds every devnet program's upgrade authority),
`payer` (pays every fee and deposit after a deploy, as a relayer would), `buyer`, `seller`,
`escrow-program` (escrow v1's id), `test-dollar-mint` and `test-dollar-authority`, and three only the closed first
registry used: `registry-program`, `treasury` and `issuer`. The per-program scripts derive
`registry-rows-program` and `escrow-v2-program-2`. The standard library of any language reproduces it.

## What it promises

- **The same phrase gives the same keys.** A run with a new phrase starts a new record.
- **No private key in the repo.** Keypair files go to `FOREST_DEVNET_KEYS` (default
  `~/.forest-devnet/keys`): directory mode 700, files 600; a path inside the repo is refused, and a
  file holding another key is never overwritten. Only public keys are printed. The phrase is in no
  file.
- **Exact deploy costs and the built bytes.** Each program's deploy script computes a deploy's cost
  the way Solana CLI 4.2.2 spends it and refuses if the deploy key holds less, then checks the
  deployed bytes against its build by hash.

## What it trusts

- Whoever holds the phrase holds every devnet key, the upgrade authority included: devnet is not
  sealed.
- Solana CLI 4.2.2 and `cargo-build-sbf`, and the public RPC at `api.devnet.solana.com`
  (`FOREST_DEVNET_RPC` points elsewhere).

## Use it

```
export FOREST_DEVNET_SEED='<the phrase>' FOREST_DEVNET_KEYS=~/.forest-devnet/keys
devnet/keys.sh                       # the keys; the record is kept if it names the same keys
registry/devnet/deploy.sh            # the registry: deploy, or check and record
escrow/devnet/deploy.sh              # the escrow: deploy, or upgrade in place
```

Each folder's README says how to run its deals there. `FOREST_DEVNET_RPC` points a run at another
RPC.

## Limits

- **The bytes check needs the same toolchain:** Solana CLI 4.2.2, `cargo-build-sbf` 4.1.0,
  platform-tools v1.54.
- **A new phrase starts from nothing.** Its deploy key needs SOL sent by hand, and the escrow's
  deals need the classic test dollar's mint, the parties' token accounts and the buyer's dollars,
  which no script here makes.

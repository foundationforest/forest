# devnet

Devnet only: these scripts touch Solana devnet and never mainnet.

Up: [the repo](../README.md). What runs on devnet now, and how to check it:
[docs/devnet.md](../docs/devnet.md).

Every devnet key comes from one phrase, so any machine holding the phrase gets the same keys, the
same program ids and the same addresses. This folder holds that recipe, escrow v1's build and deploy
scripts, and the public record they write. The registry and escrow v2 deploy with their own scripts
([registry/devnet/](../registry/devnet/deploy.sh), [escrow/v2/devnet/](../escrow/v2/devnet/deploy.sh)),
from the same keys.

| File | What it does |
|---|---|
| `keys.sh` | Derives every key from the phrase and writes the keypair files outside the repo |
| `build.sh` | Builds the registry and escrow v1 from a copy of the source, with the devnet program ids put in |
| `deploy.sh` | Deploys one build, its exact cost computed first, then checks the deployed bytes against the build and records them |
| `devnet.json` | The public record: keys, escrow v1's deploy and deals, the closed first registry, the test dollar |

## The key recipe

```
phrase = FOREST_DEVNET_SEED, Unicode NFKD, trimmed, runs of whitespace made one space
seed   = PBKDF2-HMAC-SHA256(phrase, salt = "forest-devnet:" + label, 600,000 iterations, 32 bytes)
key    = the ed25519 keypair whose secret seed is `seed` (Solana's Keypair.fromSeed)
```

`keys.sh` derives `deploy` (pays for deploys and holds every devnet program's upgrade authority),
`payer` (pays every fee and deposit after a deploy, as a relayer would), `buyer`, `seller`,
`escrow-program`, `test-dollar-mint` and `test-dollar-authority`, and three only the closed first
registry used: `registry-program`, `treasury` and `issuer`. The per-program scripts derive
`registry-lines-program` and `escrow-v2-program-2`. The standard library of any language reproduces it.

## What it promises

- **The same phrase gives the same keys.** A run with a new phrase starts a new record.
- **No private key in the repo.** Keypair files go to `FOREST_DEVNET_KEYS` (default
  `~/.forest-devnet/keys`): directory mode 700, files 600; a path inside the repo is refused, and a
  file holding another key is never overwritten. Only public keys are printed. The phrase is in no
  file.
- **Exact deploy costs.** `deploy.sh` computes a deploy's cost the way Solana CLI 4.2.2 spends it,
  prints it, and waits (up to `FOREST_DEVNET_WAIT_MINUTES`, 90 by default) until the deploy key holds
  it. It closes any buffer a dead deploy left behind first.
- **The deployed bytes are the built ones,** checked by hash after every deploy. A program already
  deployed is only checked and recorded; one the record marks closed is refused.

## What it trusts

- Whoever holds the phrase holds every devnet key, the upgrade authority included: devnet is not
  sealed.
- Solana CLI 4.2.2 and `cargo-build-sbf`, and the public RPC at `api.devnet.solana.com`
  (`FOREST_DEVNET_RPC` points elsewhere).

## Use it

```
export FOREST_DEVNET_SEED='<the phrase>' FOREST_DEVNET_KEYS=~/.forest-devnet/keys
devnet/keys.sh                       # the keys; the record is kept if it names the same keys
devnet/build.sh                      # fails today: see Limits
devnet/deploy.sh cost                # what each deploy would cost; deploys nothing
devnet/deploy.sh escrow              # deploy, or check and record
cd escrow/client && node scripts/devnet.ts     # escrow v1's two deals; skips what is done
```

Every step checks the chain first and sends only what is missing. `FOREST_DEVNET_RPC` and
`FOREST_DEVNET_RECORD` point a run at a local validator and a copy of the record, to rehearse
without spending devnet SOL.

## Limits

- **`build.sh` fails today.** It still looks in the registry's source for lines the current registry
  no longer has (the closed registry's program id, treasury and issuer), and stops there, before
  building either program. So `deploy.sh escrow` has no build to check escrow v1's deployed bytes
  against.
- **`deploy.sh registry` is refused:** the registry it deploys is closed. The current registry
  deploys with `registry/devnet/deploy.sh`.
- **Builds are not checked to be reproducible** byte for byte on another machine.

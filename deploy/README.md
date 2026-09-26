# deploy

Puts the foundation's services online on **Solana devnet**: the host, the carrier's relay, the index,
the issuer and the fee payer on Railway, and the index's Postgres on Supabase; then proves them end to
end on their public URLs. What is running now, with every URL and signature, is in
`docs/services.md`. Nothing here is mainnet, and nothing is shipped.

Every service is built from its own folder's scripts, unchanged (`host/build.sh` and `run.sh`,
`carrier/build.sh`, the index's install line, the issuer's `npm start`, Kora's own image with
`feepayer/run.sh`). This folder adds only what deploying needs: Dockerfiles, devnet settings, a
stand-in face check, and the scripts that drive Railway, Supabase and the proof.

## What runs where

| Service | Railway service | Built by | Runs | State |
|---|---|---|---|---|
| Host | `host` | `host/Dockerfile`: Node 22.22.2, pnpm through corepack, `host/build.sh` | `host/run.sh` on port 2583 | SQLite and photos on a volume at `/data` |
| Carrier (relay only) | `carrier` | `carrier/Dockerfile`: Go 1.26, `carrier/build.sh`; ships `bin/relay` | `relay serve` on 2470 | SQLite and event files on a volume at `/data` |
| Index | `index` | `index/Dockerfile`: Node 22.22.2, `npm ci` in shapes, both clients, index | `node src/main.ts`: readers and pages in one process (the trial allows five services) | Supabase Postgres |
| Issuer | `issuer` | `issuer/Dockerfile`: Node 22.22.2, `npm ci` in registry/client and issuer | `issuer/start.sh`: the stand-in Didit when no Didit key is set, then `npm start` | SQLite on a volume at `/data` |
| Fee payer | `feepayer` | `feepayer/Dockerfile`: `ghcr.io/solana-foundation/kora:v2.0.5` by digest; the devnet `kora.toml` made by `feepayer/devnet-config.sh` | `feepayer/run.sh` | none |
| Postgres | Supabase `forest-devnet` | Supabase | session pooler, TLS verified against `index/supabase-root-2021.crt` | the index's tables |

Every image builds with the repo root as its context. Railway reads the Dockerfile path from each
service's `RAILWAY_DOCKERFILE_PATH` variable and its settings (health path, one replica, restarts);
Railway has deprecated `railway.json`, so `railway.ts` sets these through the API.

## Files

| | |
|---|---|
| `railway.ts` | Railway through its GraphQL API: `provision`, `variables`, `deploy`, `status`, `sealed`, `rotate`, `wire`, `track` |
| `supabase.ts` | Supabase through its Management API: `create`, `lockdown`, `url` |
| `fund.ts` | devnet: 1 SOL to the fee payer's key, its test-dollar account, test dollars for the proof's person |
| `e2e.ts` | the seven-step proof on the public URLs |
| `services.json` | the public record the scripts read and write: ids, URLs, addresses, signatures. Never a secret |
| `lib/` | secrets kept outside the repo, the record, devnet helpers, the proof's person |
| `*/Dockerfile`, `index/*.devnet.json`, `feepayer/devnet-config.sh`, `issuer/fake-didit.ts`, `issuer/start.sh` | one folder per service |

## Secrets

- **Where they come from.** The devnet keys come from `devnet/keys.sh` (the phrase in
  `FOREST_DEVNET_SEED`), written outside the repo. The host's, relay's and index's secrets, and
  Supabase's passwords, are made by the scripts, 32 random bytes each.
- **Where they are kept.** In `~/.forest-devnet/services/` (`FOREST_SERVICES_SECRETS`), directory 700,
  files 600, outside the repo, for this machine's own admin calls; they go when the machine goes.
  `lib/secrets.ts` refuses a folder inside the repo.
- **How they reach Railway.** Sealed, through `environmentPatchCommit` with `isSealed`. A sealed value
  reaches the build and the running service and can never be read back, by the dashboard or the API.
- **Nothing prints one.** Every message from Railway's API is redacted against every secret the run
  has touched, and the Helius key is taken out of any RPC error.
- **Check the seals** with `node railway.ts sealed`: names and seal flags only, since Railway's list has
  no value field.

Two things about Railway's API, found here:
- A variables change is applied as a workflow, one after another, and can take minutes.
  `setVariables` waits for each.
- Marking an existing unsealed variable as sealed fails ("An unknown error occurred"). So a secret found
  unsealed is removed through the config (set to null) and sent again, sealed. Changing a sealed
  variable's value works and it stays sealed.

## Putting it up from nothing

Needs Node 22.18 or later, and in the environment: `RAILWAY_API_TOKEN` (an account token),
`SUPABASE_ACCESS_TOKEN` and `FOREST_DEVNET_SEED`. Optional: `HELIUS_API_KEY` (then every devnet RPC is
Helius's, sealed), and `DIDIT_API_KEY` with `DIDIT_WORKFLOW_ID` (then the issuer uses the real face check).

```
devnet/keys.sh                           # the devnet keys, outside the repo
cd deploy && npm ci
node supabase.ts create                  # the project; waits until healthy
node supabase.ts lockdown                # no Data API rights; the read-only role
node supabase.ts url                     # connection strings, kept outside the repo
node railway.ts provision                # project, services, volumes, domains, settings
node railway.ts variables                # every variable; secrets sealed and checked
git push                                 # Railway builds what GitHub holds
node railway.ts deploy                   # builds and starts all five
node railway.ts wire                     # the relay reads the host
node fund.ts                             # devnet SOL and test dollars
node e2e.ts                              # the proof
```

`e2e.ts` also needs `npm ci` in `keys/`, `shapes/`, `registry/client` and `registry/artifacts` (then
`npm run fetch`), and `host/build.sh` run, for `host/test/device.ts`. Every script checks first and
skips what is done.

## Redeploying

- **Now:** `node railway.ts deploy [service…]` builds the tracked branch's pushed commit (it refuses when
  local `HEAD` is not what GitHub holds). `node railway.ts status` shows each latest deployment.
- **A push redeploys nothing yet.** The services track `claude/zen-ritchie-9yl3w3`. Railway cloned the
  repo because it is public, but builds on push need Railway's GitHub app installed on
  `foundationforest/forest`. After that, and once this is merged:

  ```
  node railway.ts track main               # every service builds from main; each push to main redeploys
  ```
- **Variables alone:** `node railway.ts variables`, then `deploy` the services they belong to.

## Rotating a secret

| Secret | How |
|---|---|
| `PDS_JWT_SECRET`, `PDS_ADMIN_PASSWORD`, `RELAY_ADMIN_PASSWORD`, `INDEX_SIGNING_SEED` | `node railway.ts rotate NAME`: a new value, sealed, and a redeploy of its service. A new `INDEX_SIGNING_SEED` is a new signing identity for the index: every score is signed again under new public keys |
| `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` | no Forest DID names it (`host/README.md`); delete it from the secrets folder, run `variables`, `deploy host` |
| `DATABASE_URL` | reset the database password in Supabase, write it to `supabase-db-password` in the secrets folder, `node supabase.ts url`, `node railway.ts variables`, `deploy index` |
| `ISSUER_KEYPAIR`, `FOREST_FEEPAYER_KEY` | they are devnet keys from the phrase. A new issuer key must first be made an insert key of list 0 by its owner; a new fee payer key needs SOL and a test-dollar account (`fund.ts`) |
| The Helius key, Didit's | set the new value in the environment, `node railway.ts variables`, `deploy` the index, issuer and fee payer (Helius) or the issuer (Didit) |

A sealed value cannot be read back, so check a new credential works (the service's health, its logs)
before revoking the old one.

## What it costs

Measured on 2026-09-25 with the services idle after the proof, against Railway's published prices
(RAM $10 a GB-month, CPU $20 a vCPU-month, volumes $0.15 a GB-month, egress $0.05 a GB; builds free):

| Service | Memory | CPU (average) |
|---|---|---|
| host | 0.18 GB | 0.001 vCPU |
| index | 0.18 GB | 0.002 vCPU |
| issuer | 0.11 GB | 0.001 vCPU |
| carrier (relay) | 0.02 GB | 0.001 vCPU |
| fee payer | 0.01 GB | under 0.001 vCPU |
| **All five** | **0.51 GB** | **under 0.005 vCPU** |

- **Railway usage: about $5.3 a month.** Memory $5.10, CPU $0.10, the three volumes at most $0.23 (500 MB
  each, 33 MB used), egress a few cents.
- **On the trial (now):** the one-time $5 credit covers about four weeks of this, inside the trial's 30
  days. Then the account falls to the Free plan ($1 a month, 0.5 GB per service), and the services stop.
- **On Hobby:** $5 a month, which includes $5 of usage, so about $5.30 a month in all. Splitting the
  index's pages into a sixth service adds about 0.1 GB, about $1.
- **Supabase:** $0 on the free plan (500 MB database). Supabase pauses a free project after a week
  without activity. The index queries it every 10 seconds, which should count; not watched for a week.
- **Helius:** its plan is Carlos's and not checked here. The index alone makes about 2 requests every
  10 seconds (one per program), about 520,000 a month, plus the issuer's and Kora's.
- **Devnet SOL:** free, but not on tap (`docs/devnet.md`, "Funding"). Kora's key holds about 1.1 SOL; a
  registration costs it 0.0007 and it is paid back in test dollars.

## Different from a mainnet setup

| Here (devnet) | Mainnet |
|---|---|
| The devnet program ids, unsealed, from `docs/devnet.md` | Fresh ids, sealed the day each deploys |
| The test dollar the devnet run mints; Kora prices it with its mock (one base unit buys one lamport) | USDC; Kora prices it through Jupiter (`JUPITER_API_KEY`) |
| Keys from a devnet phrase: issuer, fee payer (the `payer` key), treasury | The foundation's issuer key, a fee payer key with an operations loop, the charter's treasury |
| A stand-in face check that approves everyone | Didit, on the foundation's workflow |
| The issuer batches every 120 seconds | Every hour or at 50 (its defaults), so a list entry can't be matched to a face check by time |
| The index's readers and pages in one process, the pages holding the signing seed | Two services; the pages hold no seed and read through `index_pages` |
| Railway's domains | forest.foundation for the index |
| A trial account: no redeploy on push, 1 GB per service, restarts on failure only (10 at most), 7 days of logs | Hobby or Pro, with Railway's GitHub app on the repo |
| Railway's request logs keep each client's address and path (7 days here) | The same, unless something changes: open in `docs/handoff.md` |
| Helius's devnet RPC | A mainnet RPC that allows `simulateTransaction` with inner instructions (Kora) |

## What the trial blocked

- **Six services.** The trial allows five across the workspace. The index runs as one service, and a
  throwaway project from an earlier session (`devnet-airdrop-temp`) was deleted, with Carlos's yes, to
  free the fifth slot for the fee payer.
- **Two projects** at most, and one new volume per 30 seconds (`provision` waits).
- **Restart always.** Asked for; Railway set every service to restart on failure instead.

Once the account is on Hobby and Railway's GitHub app is on the repo:
1. `node railway.ts track main`;
2. split the index: a `pages` service from the same Dockerfile, starting `node src/main.ts web` with
   `DATABASE_URL_PAGES` (the `index_pages` role) and no seed, and the `index` service starting
   `node src/main.ts readers` with its public domain moved to `pages`. `railway.ts` does not do this yet.

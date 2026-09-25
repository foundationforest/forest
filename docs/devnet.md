# Devnet

Devnet is Solana's practice network: test SOL from a faucet, and no real money. Everything here is
test-only except the program ids and this record. `devnet/devnet.json` holds the same record in the
form the scripts and the smoke tests read. Nothing is shipped, and devnet is not mainnet.

## Status (session 18): keys that last, funding short, nothing deployed

**Stale: every escrow number on this page.** The escrow's size, hash and deploy cost below (363,120
bytes, 1.8455 SOL) are of an older escrow. The escrow on `main` builds to 304,912 bytes (sha256
`57e83f6a…36af2c7` with the committed placeholder id), and its devnet deals are those in
`escrow/client/scripts/devnet.ts`. The devnet session rewrites this page.

**Nothing is deployed on devnet.** The deploy key holds 2.0 SOL, from two faucet grants. Both
deploys need about 3.53 SOL, and the payer about 0.2 more (see "What the deploy costs"). Nobody
could get more: not the faucet from the session's machine, and not Carlos from faucet.solana.com.
Session 18 waited 90 minutes and stopped, as it was asked to.

**Done:**

- **Keys that outlive the machine.** Every devnet key is derived from one phrase,
  `FOREST_DEVNET_SEED`, by `devnet/keys.sh`. Any session with the same phrase gets the same keys,
  the same program ids and the same addresses. So the 2.0 SOL on the deploy key are not stranded:
  the next session holding the phrase spends them.
- **Builds.** Both programs are built for devnet with these keys, on the same toolchain as session
  15 (below).
- **The faucet record.** Below, and in `devnet/devnet.json` under `airdrops`.

**Not done on devnet** (no deploy, so no signatures):

- the deploy itself;
- `init` and the test dollar;
- the registration and its refusal;
- the two deals;
- the smoke tests, which need a deploy to test.

**Still valid from session 15:** the same steps rehearsed end to end on a local validator. Every
step was green there.

**What the next session needs:** about 1.8 SOL more on the deploy key,
`2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A`, and `FOREST_DEVNET_SEED` set. Then it runs "How to
run it" below.

**Session 15's keys are stranded.** Its deploy, payer and treasury keys (3.3 SOL in all) were made
on a machine that is gone, so nobody can move that SOL. It is test SOL; nothing is lost.

## Keys

`devnet/keys.sh` derives each key from the phrase alone, one label per key:

- **The phrase:** `FOREST_DEVNET_SEED`, Unicode NFKD, trimmed, runs of whitespace made one space.
- **The seed:** `seed = PBKDF2-HMAC-SHA256(phrase, salt = "forest-devnet:" + label, 600,000 iterations, 32 bytes)`.
- **The key:** the ed25519 keypair whose secret seed is `seed`, as Solana's `Keypair.fromSeed`
  makes it.

It uses nothing but a standard library, so any language reproduces it.

- **Where the keys go.** The keypair files, in `solana-keygen`'s format, go to `FOREST_DEVNET_KEYS`
  (default `~/.forest-devnet/keys`). That directory is outside the repo, mode 700, files 600.
- **What is kept, and where.** The phrase is in no file and nowhere in this repo. It is set in
  the session's environment. Nothing prints a private key or the phrase.
- **Rerunning.** `keys.sh` run again with the same phrase gives the same files and leaves
  `devnet/devnet.json` as it is. A different phrase starts the record afresh; the old one stays in
  git history.
- **Anyone who holds the phrase holds every key below,** the upgrade authority of both devnet
  programs included.

| Role | Label | Public key | SOL now |
|---|---|---|---|
| Deploy: pays for the deploys, and is the programs' upgrade authority | `deploy` | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | 2.0 |
| Treasury: `TREASURY` in the devnet registry build | `treasury` | `CkzCrVbQEDwex643ncFFnFwAZ3EJ6YHgnarHmrJWo5w9` | 0 |
| Foundation issuer: `FOUNDATION_ISSUER` in the devnet registry build, list 0's owner | `issuer` | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` | 0 |
| Payer: every network fee and rent after the deploy, as a fee payer would | `payer` | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | 0 |
| Buyer | `buyer` | `4kFff36dwTKhK8tEm4m9QiyRCRcj67aXsYgkKMxwLuqE` | 0 |
| Seller | `seller` | `3Ttfgh6ATW9j5cYMttLiZuVub77hQjkDiZDDhzqyooTf` | 0 |
| Registry program id (nothing deployed there yet) | `registry-program` | `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i` | |
| Escrow program id (nothing deployed there yet) | `escrow-program` | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` | |
| Test dollar mint (not made yet) | `test-dollar-mint` | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` | |
| Test dollar mint authority | `test-dollar-authority` | `EK6EjtXy1YMDwDSUNQGJv6RVuG4KVRyoJxErZGR2xyzK` | |

The person who registers is the keys recipe's pinned test seed (`keys/test/vectors.json`):

- profile 0's wallet: `Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx`;
- its DID: `did:plc:wece24yzukt4pj6hqvmb2fn4`;
- its identity commitment: `1456869013…5629808185`.

That key is public by construction.

## What the deploy costs

About **3.53 SOL on the deploy key for both programs, then 0.2 for the payer**. Session 15's
figure, 5.37, counted each program twice.

**Why one copy, not two.** Solana CLI 4.2.2's `program deploy` (`cli/src/program.rs`,
`do_process_program_deploy`):

1. It funds the upload buffer with the program data account's rent, and that rent plus the fees
   is all it checks the payer holds.
2. The loader's deploy instruction hands the buffer's SOL back to the payer, then funds the
   program data account from it.

So the peak is one copy of each program, and deploying one after the other keeps the first
program's data account while the second uploads.

**At devnet's rent** (5,080 lamports a byte, read on 2026-09-24):

| | Bytes | Program data rent | Program account | Write fees (about) | Kept |
|---|---|---|---|---|---|
| registry | 329,136 | 1.6729 SOL | 0.0008 | 0.0017 | 1.6737 |
| escrow (stale, see Status) | 363,120 | 1.8455 SOL | 0.0008 | 0.0018 | 1.8464 |
| both, one after the other | | | | | about 3.53 |

This comes from reading the CLI's source, not from a devnet deploy. If it is wrong, a deploy
stops short and the CLI leaves a buffer. `solana program close --buffers` returns that buffer's
SOL to the deploy key.

## The faucet

**Session 18: 2 of 62 requests granted, 2.0 SOL.** On 2026-09-24, for the deploy key only, through
RPC `requestAirdrop`:

- first, 12 requests from 15:30 to 15:33 UTC, with backoff (2, then 1 SOL);
- then one 1 SOL request a minute until 17:00 UTC.

Both grants came through Alchemy's public demo endpoint, at 16:25 and 16:27 UTC. Both are
finalized; their signatures are in `devnet/devnet.json`, under `airdrops`. The rest were refused:

- `api.devnet.solana.com`: 18 times "Internal error", then 13 times 429, "You've either reached
  your airdrop limit today or the airdrop faucet has run dry".
- Alchemy's endpoint: 29 times HTTP 429, with no body.

The other routes are closed to a machine:

- **faucet.solana.com** asks for a Cloudflare captcha on every request, and for a GitHub sign-in
  for more. It was not used from the machine. Carlos could not get SOL from it either.
- **Ankr and Helius** answer `requestAirdrop` only with an API key.
- **dRPC** has no devnet on its free plan.
- **The proof-of-work faucets** on devnet (program `PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL`,
  22 faucets) are drained: the two with anything left hold 0.02 SOL or less.

Session 15 had the same answers: 5 of 448 requests granted over about 3.5 hours, all through
Alchemy.

**Devnet USDC is not used.** Circle's faucet (`faucet.circle.com`) sits behind a reCAPTCHA, so the
run makes a test dollar instead: a classic SPL Token mint with six decimals and a mint authority
derived like every other key. The treasury accepts it with `add_token` at 250,000 base units
(0.25), and the registration and both deals pay in it.

`init` still writes devnet USDC as `mints[0]` at 0.25, a constant, as on mainnet:

- no separate step adds it, and `add_token` would refuse it (`MintAlreadyAccepted`);
- accepting the test dollar is permanent on that config, since nothing removes a mint. It is
  devnet.

## How the builds are parameterised

`devnet/build.sh` builds each program from a copy of its committed `Cargo.toml`, `Cargo.lock` and
`src`, placed in `devnet/target/` (ignored). The copies differ from the source by exactly these
lines. The script refuses unless each old line appears once before the change, and the new one
once after it:

| Program | Line in `src/lib.rs` | Committed (tests, and mainnet until replaced) | Devnet build |
|---|---|---|---|
| registry | `declare_id!` | `FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B` | `registry.programId` |
| registry | `pub const TREASURY` | `F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s` (placeholder) | `keys.treasury` |
| registry | `pub const FOUNDATION_ISSUER` | `H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS` (placeholder) | `keys.foundationIssuer` |
| escrow | `declare_id!` | `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT` | `escrow.programId` |

- **The registry** is built with `--features devnet`, which makes `USDC_MINT` devnet's USDC,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- **The escrow** needs no feature.
- **What the script checks and prints:** it checks that no file other than `lib.rs` differs,
  prints the substitutions as a diff, and prints each build's sha256.
- **Why the program id changes too:** Anchor refuses to run at an address other than its
  `declare_id!`, and nobody holds a keypair for either vanity id.

**Session 18's builds**, with Solana CLI 4.2.2, `cargo-build-sbf` 4.1.0, platform-tools v1.54 and
rustc 1.89.0 (session 15's toolchain):

| | Bytes | sha256 |
|---|---|---|
| `forest_registry.so` (devnet) | 329,136 | `303957136883acbab9e80e4eda04f4a5a525af29dfdd68d8dbb1fe659b1de79b` |
| `forest_escrow.so` (devnet, stale, see Status) | 363,120 | `9dbe2a62a319f6b35ee5a11248e591ab87ad79b8bb897b0f5d1e90c9bf152888` |

- **Session 15's builds** had the same sizes and other hashes, because they named other keys.
- **The next session should get these hashes.** It uses the same phrase, the same source and
  this toolchain. Whether the build is byte for byte reproducible across machines has not been
  checked yet.

The committed placeholders and the LiteSVM tests' own builds in `*/program/target/` are not touched.

## How to run it

**You need:**

- `FOREST_DEVNET_SEED` set;
- the Solana CLI 4.2.2 on the PATH (`sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.2/install)"`);
- `npm ci` done in `keys/`, `registry/artifacts` (then `npm run fetch`), `registry/client` and
  `escrow/client`.

```
export FOREST_DEVNET_KEYS=~/.forest-devnet/keys     # outside the repo; keys.sh's default
devnet/keys.sh                                      # the same keys from the same phrase
# the deploy key needs about 3.53 SOL, plus 0.2 it or anyone sends on to the payer
devnet/build.sh                                     # both programs, parameterised as above
devnet/deploy.sh                                    # deploy, check the bytes, record
cd registry/client && node scripts/devnet.ts        # init, test dollar, insert, register, refused
cd escrow/client   && node scripts/devnet.ts        # the invoice paid in one tap; the 60/40 agreement
npm run test:devnet                                 # in each client: read-only smoke tests
```

- **Steps can be run again.** Every step checks the chain first and skips what is done. A run
  that stops, on a rate limit say, can simply be started again, and with the same phrase in any
  later session too.
- **Signatures are recorded.** Every transaction's signature, and a line on what it did, go into
  `devnet/devnet.json` under `transactions`. The details go under `registry`, `registration`,
  `deals` and `tokenAccounts`.
- **The smoke tests hold no key and send nothing,** so anyone can run them at any time against a
  record whose deploy happened. Against today's record they fail, because nothing is deployed.

**Rehearsing on a local validator first** costs no devnet SOL. Set `FOREST_DEVNET_RPC` to the local
validator and `FOREST_DEVNET_RECORD` to a copy of the record, then start the validator like this:

```
solana-test-validator --reset --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g \
  --url https://api.devnet.solana.com --clone 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

- **The deactivated feature is SIMD-0500,** "Disable deployment of SBPF v0, v1 and v2 programs". A
  test validator turns every feature on, and these builds are SBPF v0.
- **`--clone` plants devnet USDC's mint,** which `init` reads.

## What is different from mainnet

- **Not sealed.** The upgrade authority stays on the deploy key.
  - Sealing (`solana program set-upgrade-authority <id> --final`) is the mainnet step, done the
    day each program deploys there, as both READMEs say.
  - On devnet the programs stay upgradeable by whoever holds the phrase.
- **Test keys.** The treasury, the foundation issuer and the program ids are derived from a devnet
  phrase. They are not the charter's treasury, the foundation's issuer key, or ids kept for
  mainnet.
- **A test token.** The run pays in a test dollar the run mints itself, not USDC.
- **The old program format still deploys on devnet.** Both builds are SBPF v0.
  - SIMD-0500, which refuses new v0 to v2 deploys, is not active on devnet: its feature account,
    `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`, does not exist there (read 2026-09-24).
  - Once it activates, these builds can no longer be deployed anywhere it is active.
- **No Kora.** A plain payer key plays the fee payer and charges nobody.
- **No face check.** The issuer inserts a commitment derived from a public test seed.

# Devnet

Devnet is Solana's practice network: test SOL from a faucet, and no real money. Everything here is
test-only except the program ids and this record. `devnet/devnet.json` holds the same record in the
form the scripts and the smoke tests read. Nothing is shipped, and devnet is not mainnet.

## Status (2026-09-25): both programs deployed, a real badge and two real deals

**On devnet now:**

- **Both programs**, built in the newer program format (SBPF v3). Each deployed copy's bytes were
  checked against its build.
- **The registry, used for real:**
  - `init` sent;
  - a test dollar accepted;
  - profile 0's person inserted into list 0 by the devnet issuer;
  - profile 0 badged in `freelance/seller` with a real proof, made from list 0's members as read
    back from devnet;
  - the same registration sent again, and refused on chain.
- **Two real deals on the escrow:**
  - an invoice the buyer paid and released in one transaction, the deposit address made first;
  - a buyer's escrow, funded, marked, and settled by a 60/40 split both sides signed.
- **The smoke tests:** all 8 pass against devnet, 5 for the registry and 3 for the escrow
  (`npm run test:devnet`, 2026-09-25).

**Not done on devnet:**

- Kora: a plain payer key played the fee payer.
- A real face check: the issuer inserted a commitment from a public test seed.
- `sweep_rent`, the list handovers, `close_list`, the escrow's other ways out, and its options.
  Those run under LiteSVM and on a local validator only.

### The programs

| | Registry | Escrow |
|---|---|---|
| Program id | `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i` | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` |
| Program data | `8o6rWB9iGKc7cMQKeUhinQzT3kxRrpRzXgp6MkScna9c` | `6WQ3CvZnVBodtQ9fSTieCfMQzUTJJnqTaaPjAYqE8T83` |
| Format | SBPF v3 | SBPF v3 |
| Bytes | 304,928 | 282,888 |
| sha256 of the build and of the deployed bytes | `47171998b5d12c46e97720721fa7ded05c0d9c1132f7483572622ea76568c64c` | `e4c9d3dad28199282940e6d35aae896ab14610257ae84a6106353f71e6113182` |
| Upgrade authority | the deploy key, `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | the same |
| Deploy slot | 504,105,793 | 504,106,452 |
| Deploy signature | `AkfJTcjedMaLWVBM6TwMCG3o9SbU1HT6zHMXHGpXPv4RiYj2hsg14up4WEjnBW3eHuCJFmUsUZTtHrW8wDMRPGF` | `hbAsbJNCAcrNoCpPpBTumdcrzrRPALnTFxFnA3Nejiwnfj9Q7p68vK3zR321KCQVETJafDqNRCNXNMYWn6MCTxS` |

The registry build includes the 256-byte scope limit (this session's change).

The registry's accounts:

| | Address |
|---|---|
| config | `4nxop5nYuJHyRKgLn6yj6vvDB1LZTM7wDykH3N8Qsn2y` |
| list 0 | `7PMx9JpaP7ZwewZ78833FomUbHQgDFFERM9WuvyRurjD` |
| code tree | `82eKSXYhRAQGL3Y2FtFYc9fFQQnxhPbFHwGAxjvNxGJX` |
| devnet USDC, `mints[0]` at 0.25 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| test dollar mint (6 decimals, accepted at 250,000) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |

The test dollar's token accounts:

| Holder | Address |
|---|---|
| treasury | `B9iw1KiatSkcVyk3nuPbaR6mWy3iqC3yt1dDnCyBcvdj` |
| profile 0's wallet | `5ibx9fUA31Zf259Dong6H26n7MVHnVtBxEzrx7a16cA4` |
| buyer | `DsNgtxH7aVrbGJNraTgB19AaRrWSGdr7z7Vwzwz6BX4R` |
| seller | `8WU1DgsmnTnfwjNPUwDuV4wPtLnjzaeKsefhnBXz6Gcq` |

### The badge

Profile 0 of the keys recipe's pinned test seed, in `freelance/seller`, on list 0:

| | |
|---|---|
| Profile's wallet | `Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx` |
| DID | `did:plc:wece24yzukt4pj6hqvmb2fn4` |
| Identity commitment | `14568690134484466610252976219100933485694269593799802854234702390895629808185` |
| List 0 as read from devnet | 1 member, found in 2 transactions |
| Root the proof used | `2035961e8afaccb15bc1cd878da3c4f42db4a7f0a72b19c30251a4a2b8a3b239` |
| Code (the proof's nullifier) | `12081e10633818060719a994b13b69ce1548b4e76839dae6e0878a1e845505aa` |
| Code account | `8oYetSy3vATJNJyLtU4RWKG2NccYYL6gAnN6R28Cbqq8` |
| Registration | `25CpahXh3ZKjrF3hxHet7xms1xjmTK1d94B6Y9MTeDCXaNEJ6TZtgUvsYqKWAaxpsHF6fT9gr2UncUtNxAiLrYGE` |
| Its cost | 835 bytes (v0 transaction), 137,019 compute units; the proof took 1.3 s on the session's machine |
| The same registration again, refused | `58fpcLpumjsW2Lq2znDYDB2pE2YoduS61TnJPyMb3r9MEEJtySMAYt7zHBNJTAGZbXbmbtXT3MJgJhpd8cqwCT5c` |

- **How the refusal shows on chain:** error `InstructionError [1, Custom 0]`, with the log line
  "Allocate: account … 8oYetSy3… already in use". The code account already exists.
- **The payments:** the profile's wallet signed and paid 0.25 test dollars to the treasury. The
  payer paid the network fee and the code account's rent.
- **One thing not checked:** whether `freelance` is a market in the `markets` directory. The
  registry accepts any name, but the foundation's index counts only directory markets.

### The deals

**1. An invoice, paid in one tap.** The seller opened it in one transaction. Later, in one
transaction, the buyer (`payInvoiceInOneTap`):

1. made the deposit address first (an idempotent create, so a fee payer that checks every
   transfer's destination finds it made);
2. paid 2.00 into it;
3. released it to the seller.

| | |
|---|---|
| Escrow, the receipt | `GCWxAT7cQZeaRdfkTkhsRnAPEEim58pv6SJqfJrtq8Qm` (the seller's address, id 13100031500319075776) |
| Deposit address, closed at the end | `4ffWkRmTXgUpNREZ9SqKwXVxLjQKMfy3g13QiRZJ2AfB` |
| invoice (`create`, by the seller) | `4rYJSwYTNVJEUNqZxYgWJKQp4SFfqSXgGzKJBkZKVeeyLpveHbKkb3apb6stvKidMMgkZTHxw49wyLUJbDmMohBo` |
| one tap (deposit address, transfer, `release_to_seller`) | `66g2DXqb8VgNM7sYymhEjaEPi4wsgXLNaUZxMYs68m4AsbxN6DBK6HoiJaquWuu5hdy9iD4YhRX32Zc1Mvn64Riq` |
| Receipt | ended, released to the seller: 2.00 to the seller, 0 to the buyer; created by the seller; rent back to the seller |

**2. A buyer's escrow, split 60/40.**

| | |
|---|---|
| Escrow, the receipt | `CerdZJU5Xqk8wrn5x3KDF41fW6Kd22QRR1h4GFG6zumq` (the buyer's address, id 225163091175537227) |
| Deposit address, closed at the end | `EaFkT5d2degrBTDn7vS39wEMttmRk3tK8TUinr6hYn3H` |
| create (the buyer's, 3.00, no options) | `5Y9FrY4m1TqqjoVUKTNw9VSH4XCTfo5WuBx7iPvh53PmkthzGYDcGkRd2o5tJsaWL3GsKAQrTN6iuobwjAHPKVWV` |
| fund (a plain transfer) | `2UqDDbMAJ92KX63dFvxJKttfFSZ5A4tsezgTdotya1KH3HtVrGUYMkuWfQt4wqLQXQrno5k9VswsCBe5d6XCSrei` |
| mark_funded (the payer, nobody else signing) | `3cLrUgCaTB9YeYsT4AbR5ERzCnTM4JaVTdqNpHqMHdQnLgXYKJbKBpej7dXPPz1qzFLb4hu8Z32TUNaqL4f9bnNV` |
| split (buyer and seller both sign) | `2jkrKGRZFTZdi3PFv8YVJgdPTUX9Ypm9tuyEx2U7xJcThXbRaekvyseGa8a5ERbBGQZA6MXq7FyC2f9FUL1YaHsZ` |
| Receipt | ended, split: 1.80 to the seller, 1.20 to the buyer; created by the buyer; funding marked; rent back to the buyer |

In both deals the payer fronted every rent, and each deposit address's rent went back to whoever
opened the escrow. That is why the buyer and the seller each now hold 0.00148844 SOL.

### The registry's other transactions

In order, after the two deploys:

| What | Signature |
|---|---|
| 0.2 SOL from the deploy key to the payer | `48GXVDTL5w2y8X59iS4BR6W3Y8kEPCHvXtC4FxtCzRUaP49ghctfEgV77YNAJeZHEvLBoe5otxuzMPw7HGrF8aA1` |
| 0.01 SOL from the payer to the treasury, so a sweep can land there | `4VsrXor6iNvbKv8mhJbLvvonq2gVqFmGAkDiedNXRDQKDqqDXxRadAcaSVYN2CqSHgJQo1p184rvd48aE2WcGi4j` |
| 0.01 SOL from the payer to the foundation issuer, for the same reason | `2tH9z1ieNmUkKVh3tdkCbfqqwoXZm8j3XK88uWjFrxHFQJUT2ZWVhYYHBkdGwYe6cNn4wD47wFoUBue4YzCfta2j` |
| `init` | `5dBGfPmpgPnDqd584xx2CyVB1R6GAqb2JHFb72Cb8576A4a2VQB7e4GVsXfVNaVwTvesf9Gv7iPYCxdKgjKQ5pAS` |
| the test dollar's mint | `5sANiHH84r3mhQkQU7NParcXEn71EwzySLyi1GLNPtpCs4xG1vWwC6eY2jJFpeRUrkN4kYgEygzAFca81i34RLc1` |
| `add_token`, the test dollar at 0.25 | `5Z8LKmJKSGitGaafrDgLNxujpk3DigpKdH7TnCGic9MzREDgdShCpf2Bx7qFFwN4xKHuWs7qpYb1YEnyHc55x9fy` |
| four token accounts | `2VwD2Q3Z3fo7GRVBf9FhCYeTGYveQrxUSaV1MTozTgxYzJpUW2rA2Y5nLndjkiJh3vCut9htCe2ymzGgpvuCpS6X` |
| test dollars minted: 1.00 to profile 0, 10.00 to the buyer | `2BCYVQJ156e3S458kQJcpFCtZmquxHsGY91CjFApqo1CZMf3qjqPJoq5s3KXbrz7gmgBSDKQeuqoLxnUZa8XU5Mv` |
| `insert_identity`, profile 0's commitment into list 0 | `3rTkDouR4he5AdkR8fWNX8BB3L9qBsuTHPwbJBw3cucZ4qg1FxikgRgX8f8ifh2erT8ykkgeSiwCBN3HZUX5bUd4` |

**`add_token` was recovered from the chain.** It landed while the public endpoint was answering
429 to the script's confirmation polling. The script stopped before writing it down; its
signature was then read back from the config's transaction history, and it was checked there: the
payer and the treasury signed, it logged `AddToken`, and it succeeded. Both scripts now wait out a
429 while confirming or reading logs, so a sent transaction's signature is no longer lost that way.

## Keys

`devnet/keys.sh` derives each key from the phrase alone, one label per key:

- **The phrase:** `FOREST_DEVNET_SEED`, Unicode NFKD, trimmed, runs of whitespace made one space.
- **The seed:** `seed = PBKDF2-HMAC-SHA256(phrase, salt = "forest-devnet:" + label, 600,000 iterations, 32 bytes)`.
- **The key:** the ed25519 keypair whose secret seed is `seed`, as Solana's `Keypair.fromSeed`
  makes it.

It uses nothing but a standard library, so any language reproduces it. This session's phrase gave
exactly the keys session 18 recorded.

- **Where the keys go.** The keypair files, in `solana-keygen`'s format, go to `FOREST_DEVNET_KEYS`
  (default `~/.forest-devnet/keys`): outside the repo, mode 700, files 600.
- **What is kept, and where.** The phrase is in no file and nowhere in this repo; it is set in the
  session's environment. Nothing prints a private key or the phrase.
- **Anyone who holds the phrase holds every key below,** the upgrade authority of both devnet
  programs included.

| Role | Label | Public key | SOL after the run |
|---|---|---|---|
| Deploy: pays for the deploys; the programs' upgrade authority | `deploy` | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | 2.8075158 |
| Treasury: `TREASURY` in the devnet registry build | `treasury` | `CkzCrVbQEDwex643ncFFnFwAZ3EJ6YHgnarHmrJWo5w9` | 0.01 |
| Foundation issuer: `FOUNDATION_ISSUER` in the devnet registry build, list 0's owner | `issuer` | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` | 0.01 |
| Payer: every network fee and rent after the deploy, as a fee payer would | `payer` | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | 0.1258545 |
| Buyer | `buyer` | `4kFff36dwTKhK8tEm4m9QiyRCRcj67aXsYgkKMxwLuqE` | 0.0014884 |
| Seller | `seller` | `3Ttfgh6ATW9j5cYMttLiZuVub77hQjkDiZDDhzqyooTf` | 0.0014884 |
| Registry program id | `registry-program` | `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i` | |
| Escrow program id | `escrow-program` | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` | |
| Test dollar mint | `test-dollar-mint` | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` | |
| Test dollar mint authority | `test-dollar-authority` | `EK6EjtXy1YMDwDSUNQGJv6RVuG4KVRyoJxErZGR2xyzK` | |

The person who registers is the keys recipe's pinned test seed (`keys/test/vectors.json`), so its
key is public by construction.

## What a deploy costs, exactly

`devnet/deploy.sh` deploys one program per run. So the deploy key needs enough for one program at a
time, not both at once.

**The formula.** Before each deploy, the script computes the cost the way Solana CLI 4.2.2's
`program deploy` spends it (`cli/src/program.rs`, `do_process_program_deploy`). For a program of L
bytes, with no priority fee (the CLI then adds no compute-budget instruction):

```
rent(45 + L)        program data account; the CLI funds the upload buffer with it, and the
                    loader hands it back and moves it into the program data account
+ rent(36)          program account, paid in the final transaction
+ 10,000            the buffer's creation: two signatures
+ 5,000 x writes    one per 1,012-byte chunk that is not all zeros (the new buffer holds zeros)
+ 10,000            the final deploy: two signatures
```

All of it is spent, and none comes back. The CLI's own balance check leaves out `rent(36)`, so a
key a little short passes that check and fails at the last transaction, leaving a buffer.
`deploy.sh` closes any leftover buffer before it deploys.

**Computed against spent, at devnet's rent (5,080 lamports a byte):**

| | Bytes | Writes | Computed | Spent (the key's balance before minus after) |
|---|---|---|---|---|
| registry (the larger) | 304,928 | 302 | **1.5522762 SOL** | 1.5522762 SOL |
| escrow | 282,888 | 280 | 1.4402030 SOL | 1.4402030 SOL |

- **Exact to the lamport** on devnet.
- **Also exact in the local rehearsal**, where rent is 6,960 lamports a byte: 2.1261744 and
  1.9726660 SOL. There the key was given exactly the computed amount and ended at zero.
- **No buffer was left** before the second deploy (`solana program show --buffers` listed none).

The peak for the larger program, printed on a line by itself before its deploy:

```
2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A 1.552276200 SOL
```

The key held 6.0 SOL, so there was no wait. `deploy.sh` waits (checking every 60 seconds, up to
`FOREST_DEVNET_WAIT_MINUTES`, 90 by default) only when the key is short.

**What the run needs after the deploys:** 0.2 SOL, which the registry script sends once from the
deploy key to the payer. The payer spent about 0.074 SOL: the rents of the config, list 0, the code
tree, the mint, four token accounts, the code account and both escrows, plus the fees.

## Funding

**The deploy key received 6.0 SOL in all:**

- **2.0 SOL from the faucet** in session 18, 2026-09-24: 2 of 62 `requestAirdrop` requests granted,
  both by Alchemy's public demo endpoint.
- **4.0 SOL on 2026-09-25**, between 17:01 and 17:03 UTC, before this session started: four plain
  transfers of 1 SOL from `FkTagjLiMb6YMjfSTJJGbcHmfWefpoRHj9e2ricMFLX8`. Who holds that address was
  not checked.

Every signature is in `devnet/devnet.json`, under `airdrops`.

**The public faucets are closed to a machine:**

- `api.devnet.solana.com` answers "Internal error" or 429;
- Alchemy's demo endpoint answers 429;
- faucet.solana.com asks for a captcha and a GitHub sign-in;
- Ankr and Helius need a key;
- the proof-of-work faucets are drained.

**Devnet USDC is not used.** Circle's faucet sits behind a reCAPTCHA, so the run mints a test
dollar instead: a classic SPL Token mint with six decimals and a mint authority derived like every
other key. The treasury accepts it with `add_token` at 250,000 base units (0.25). `init` still
writes devnet USDC as `mints[0]` at 0.25, a constant, as on mainnet. Accepting the test dollar is
permanent on this config, since nothing removes a mint.

## The builds

`devnet/build.sh` builds each program from a copy of its committed `Cargo.toml`, `Cargo.lock` and
`src`, placed in `devnet/target/` (ignored). The copies differ from the source by exactly these
lines, and the script refuses unless each old line appears once before the change and the new one
once after:

| Program | Line in `src/lib.rs` | Committed (tests, and mainnet until replaced) | Devnet build |
|---|---|---|---|
| registry | `declare_id!` | `FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B` | `registry.programId` |
| registry | `pub const TREASURY` | `F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s` (placeholder) | `keys.treasury` |
| registry | `pub const FOUNDATION_ISSUER` | `H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS` (placeholder) | `keys.foundationIssuer` |
| escrow | `declare_id!` | `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT` | `escrow.programId` |

- **The registry** is built with `--features devnet`, which makes `USDC_MINT` devnet's USDC.
- **Why the program id changes too:** Anchor refuses to run at an address other than its
  `declare_id!`, and nobody holds a keypair for either vanity id.
- **The format:** both are built with `--arch v3`, the newer program format (SBPF v3). The ELF
  header says so, and `build.sh` prints it. `FOREST_SBPF_ARCH=v0` builds the old format.
- **The toolchain:** Solana CLI 4.2.2, `cargo-build-sbf` 4.1.0, platform-tools v1.54, rustc 1.89.0
  (sessions 15 and 18 used the same).
- **Reproducibility:** whether the builds are byte for byte reproducible on another machine has not
  been checked.

### Why v3, and what was tested before using it

SIMD-0500 ("Disable deployment of SBPF v0, v1 and v2 programs", feature
`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`) is not active on devnet or mainnet: its feature
account does not exist on either (read 2026-09-25). Once it activates, old-format builds can no
longer be deployed there. SBPF v3 deployment (`5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC`) is
already active on both: on devnet since slot 461,808,000.

Every check below passed with both programs built `--arch v3`, before devnet was used:

- **Both LiteSVM suites:** the registry's 48 tests and the escrow's 52.
- **Both clients' local-validator tests** (`npm run test:validator`).
- **A full local rehearsal of this run** on a validator where every feature is on, SIMD-0500
  included: `build.sh`, both deploys, both scripts, a rerun of each that sent nothing new, and both
  smoke suites. No feature had to be switched off. An old-format build would have been refused
  there.

The v3 builds are smaller and a little cheaper to run:

- **Sizes:** the registry's placeholder-id build is 304,928 bytes against 329,136 as v0. The
  escrow's is 282,888 against 304,912.
- **Compute:** a registration takes 133,038 compute units under LiteSVM against 133,093.

The registry's suite also passes on a v0 build, which is what `.github/workflows/checks.yml` builds.

## How to rerun it

**You need:**

- `FOREST_DEVNET_SEED` set to the same phrase;
- the Solana CLI 4.2.2 on the PATH (`sh -c "$(curl -sSfL https://release.anza.xyz/v4.2.2/install)"`);
- `npm ci` done in `keys/`, `registry/artifacts` (then `npm run fetch`), `registry/client` and
  `escrow/client`.

```
export FOREST_DEVNET_KEYS=~/.forest-devnet/keys     # outside the repo; keys.sh's default
devnet/keys.sh                                      # the same keys from the same phrase
devnet/build.sh                                     # both programs, SBPF v3, parameterised as above
devnet/deploy.sh cost                               # what each deploy costs; deploys nothing
devnet/deploy.sh registry                           # the larger first; waits for SOL if short
devnet/deploy.sh escrow                             # closes any leftover buffer first
cd registry/client && node scripts/devnet.ts        # payer funded, init, test dollar, insert, register, refused
cd escrow/client   && node scripts/devnet.ts        # the invoice paid in one tap; the 60/40 split
npm run test:devnet                                 # in each client: read-only smoke tests
```

- **Everything is already done on devnet.** Every step checks the chain first and skips what is
  done, so run again with this phrase it sends nothing. `deploy.sh` finds each program deployed and
  only checks its bytes against a fresh build; that needs the same toolchain, since the check is by
  hash.
- **A run that stops can be started again,** on a rate limit say. The public endpoint answers 429
  often; the scripts and the smoke tests wait it out.
- **Signatures are recorded.** Every transaction's signature, with a line on what it did, goes into
  `devnet/devnet.json` under `transactions`. The details go under `registry`, `registration`,
  `deals` and `tokenAccounts`.
- **The smoke tests hold no key and send nothing,** so anyone can run them against this record at
  any time, for as long as devnet keeps the accounts and the transaction history.
- **A new phrase starts afresh.** `keys.sh` then starts a new record, and the scripts make new
  programs, deals and a new badge. The old record stays in git history.

**Rehearsing on a local validator first** costs no devnet SOL. Set `FOREST_DEVNET_RPC` to the local
validator and `FOREST_DEVNET_RECORD` to a copy of the record, then start it like this:

```
solana-test-validator --reset --url https://api.devnet.solana.com --clone 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

- **`--clone` plants devnet USDC's mint,** which `init` reads.
- **Funding it:** `solana airdrop` gives the deploy key what `deploy.sh cost` prints. Give it exactly
  that, and each deploy ends with the key at zero.
- **An old-format build** (`FOREST_SBPF_ARCH=v0`) also needs
  `--deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`, because a test validator turns
  on SIMD-0500 with every other feature.

## What is different from mainnet

- **Not sealed.** The upgrade authority stays on the deploy key, and whoever holds the phrase can
  upgrade both devnet programs. Sealing is the mainnet step, done the day each program deploys
  there, as both READMEs say.
- **Test keys.** The treasury, the foundation issuer and the program ids are derived from a devnet
  phrase. They are not the charter's treasury, the foundation's issuer key, or ids kept for mainnet.
- **A test token.** The run pays in a test dollar the run mints itself, not USDC.
- **No Kora.** A plain payer key plays the fee payer, and charges nobody.
- **No face check.** The issuer inserts a commitment derived from a public test seed.
- **The same format as mainnet would take today.** Both builds are SBPF v3, which mainnet also
  accepts, and SIMD-0500 is active on neither network.
- **The public endpoint.** Everything went through `api.devnet.solana.com`, which rate-limits a
  single client often. A mainnet run would use a provider's endpoint.

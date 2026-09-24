# Devnet

Devnet is Solana's practice network: test SOL from a faucet, and no real money. Everything here is
throwaway except the program ids and this record. `devnet/devnet.json` holds the same record in the
form the scripts and the smoke tests read. Nothing is shipped, and devnet is not mainnet.

## Status (session 15): prepared, rehearsed, stopped at the deploy

**Nothing is deployed on devnet.** The devnet faucet refused almost every request from the
session's machine, and deploying both programs needs about 5.37 SOL on the deploy key. It got 3.0.

Done:

- **Keys.** The keys are throwaway, made on the session's machine outside the repo and printed
  nowhere. The public halves are below and in `devnet/devnet.json`.
- **SOL from the faucet.** 5 of 448 requests were granted over about 3.5 hours, 3.3 SOL in all
  (below).
- **Builds.** Both programs are built for devnet, parameterised as below. The registry build
  includes session 15's list rent and handover changes.
- **A local rehearsal of the whole run.** It used those exact builds at these program ids, on a
  local validator. Every step came back green:
  - the deploy, with the deployed bytes checked against the build;
  - `init`;
  - the test dollar accepted;
  - one person inserted;
  - the list's members read back from the log;
  - a real proof;
  - the registration;
  - the same registration refused ("account … already in use");
  - an invoice paid in one tap;
  - a deal objected to and settled 60/40 by both parties;
  - the eight smoke tests.

Not done on devnet, because the deploy never happened: the deploy itself, `init`, the registration
and its refusal, and the two deals. So there are no devnet signatures for them.

**A later devnet session does not reuse these keys.** They live only on the machine that made them,
which goes when session 15 ends. It starts over:

1. `devnet/keys.sh` makes new keys, which means new program ids and new addresses, and rewrites
   `devnet/devnet.json`.
2. Fund the deploy key with about 5.4 SOL, and the payer with about 0.1. The treasury gets 0.01
   from the payer.
3. Run the steps below.

The three funded keys below are stranded: their SOL cannot be moved without keys nobody holds. It
is test SOL, so nothing is lost.

## Keys (session 15, public halves only)

| Role | Public key | SOL at the end |
|---|---|---|
| Deploy: pays for the deploys, and is the programs' upgrade authority | `HSnymG2JZfN4WUNmD5TJRtEfpVzcA23WNddqpA2vxrZs` | 3.0 |
| Treasury: `TREASURY` in the devnet registry build | `DhM7Pcx2XCQMfaz7v9KydJWdeCiwvYCnuAXzzNMmk6Pa` | 0.1 |
| Foundation issuer: `FOUNDATION_ISSUER` in the devnet registry build, list 0's owner | `HZ6q5ynucXsgT2AojAUY5tGSL3uzjukGzJA5guzBLkjR` | 0 |
| Payer: every network fee and rent after the deploy, as a fee payer would | `Au5KL1NfKhMYGi54cT4ifXj1nwssUJ7sv9GS84mgh1fX` | 0.2 |
| Buyer, seller: the two deal parties | `DYqRj9VDwFJ3tVjn5Xjr7bT4MyycFhyb6DSJNvPfRXHC`, `91ECaikDr3QUGtNRxGYUsNvzSpXkwsAEBhP1iAgebqkj` | 0 |
| Test dollar mint, and its mint authority | `EDz4Jncf8icmJ6g97TLvjCebmSDnzYURozTJMQysbtfn`, `8ybJZeNkd6FhZDarzff5t9PEXHfo1dUMRAgQJhxt25Ai` | 0 |
| Registry program id (nothing deployed there) | `EJLh7jhukvT2FJAXiXMkskorfKBcU2H8ZEm63sXLSxQX` | |
| Escrow program id (nothing deployed there) | `4i1QizMZLXCq6bE7aPDz9tELAKNYnz41WxTSy9JYjw1j` | |

The person who registers is the keys recipe's pinned test seed (`keys/test/vectors.json`):

- profile 0's wallet: `Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx`;
- its DID: `did:plc:wece24yzukt4pj6hqvmb2fn4`;
- its identity commitment: `1456869013…5629808185`.

That key is public by construction.

## The faucet

The faucet was asked through RPC `requestAirdrop` on 2026-09-24, in two rounds:

1. **06:12 to 06:40 UTC**, for the deploy, payer, treasury and issuer keys. Backoff, with shrinking
   amounts (1, 0.5, 0.2 and 0.1 SOL). 3 of 376 requests were granted.
2. **06:41 to 09:37 UTC**, for the deploy key alone, 1 SOL every 5 minutes. 2 of 72 were granted.

All five grants came through Alchemy's public demo endpoint, and all are finalized on devnet
(signatures in `devnet/devnet.json`, `airdrops`). The rest were refused:

- `api.devnet.solana.com`: 224 times with 429, "You've either reached your airdrop limit today or
  the airdrop faucet has run dry".
- Alchemy's endpoint: 217 times with HTTP 429 and no body, and twice with "Internal error".

In all: deploy 3.0 SOL, payer 0.2, treasury 0.1, issuer 0. `faucet.solana.com`, a web page that
offers a GitHub sign-in, and other providers' faucets were not tried from the machine.

**Devnet USDC was not used, and will not be.** Circle's faucet (`faucet.circle.com`) sits behind a
reCAPTCHA, so the run makes a test dollar instead: a classic SPL Token mint with six decimals and a
throwaway mint authority. The treasury accepts it with `add_token` at 250,000 base units (0.25),
and the registration and both deals pay in it.

`init` still writes devnet USDC as `mints[0]` at 0.25, a constant, as on mainnet. No separate step
adds it, and `add_token` would refuse it (`MintAlreadyAccepted`). Accepting the test dollar is
permanent on that config, since nothing removes a mint. It is devnet, and a later deploy is a new
config anyway.

## How the builds are parameterised

`devnet/build.sh` builds each program from a copy of its committed `Cargo.toml`, `Cargo.lock` and
`src`, placed in `devnet/target/` (ignored). The copies differ from the source by exactly these
lines, and the script refuses unless each old line appears once and the new one appears once after
the change:

| Program | Line in `src/lib.rs` | Committed (tests, and mainnet until replaced) | Devnet build |
|---|---|---|---|
| registry | `declare_id!` | `FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B` | `registry.programId` |
| registry | `pub const TREASURY` | `F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s` (placeholder) | `keys.treasury` |
| registry | `pub const FOUNDATION_ISSUER` | `H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS` (placeholder) | `keys.foundationIssuer` |
| escrow | `declare_id!` | `FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT` | `escrow.programId` |

- The registry is built with `--features devnet`, which makes `USDC_MINT` devnet's USDC,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- The escrow needs no feature.
- The script checks that no file other than `lib.rs` differs, prints the substitutions as a diff,
  and prints each build's sha256.
- The program id has to change too: Anchor refuses to run at an address other than its
  `declare_id!`, and nobody holds a keypair for either vanity id.

Session 15's builds, with Solana CLI 4.2.2, `cargo-build-sbf` 4.1.0, platform-tools v1.54 and rustc
1.89.0:

| | Bytes | sha256 |
|---|---|---|
| `forest_registry.so` (devnet) | 329,136 | `133dcd703dce435280da26bda48e0f2480a88246791eaf54d6e2d2c88f6c75bb` |
| `forest_escrow.so` (devnet) | 363,120 | `bbe41b6d38809756a8352eb6806cd6c87f5188e10ff10ad926dc4640ea431c31` |

A later session's builds name its own keys, so their hashes differ.

The committed placeholders and the LiteSVM tests' own builds in `*/program/target/` are not touched.

## How to run it

With the Solana CLI (4.2.2 or later) on the PATH, and `npm install` done in `registry/artifacts`
(then `npm run fetch`), `registry/client`, `escrow/client` and `keys/`:

```
export FOREST_DEVNET_KEYS=~/.forest-devnet/keys     # outside the repo
devnet/keys.sh                                      # new keys; rewrites devnet/devnet.json
# fund the deploy key (about 5.4 SOL) and the payer (about 0.1 SOL)
devnet/build.sh                                     # both programs, parameterised as above
devnet/deploy.sh                                    # deploy, check the bytes, record
cd registry/client && node scripts/devnet.ts        # init, test dollar, insert, register, refused
cd escrow/client   && node scripts/devnet.ts        # the invoice paid in one tap; the 60/40 agreement
npm run test:devnet                                 # in each client: read-only smoke tests
```

- **Steps can be run again.** Every step checks the chain first and skips what is done, so a run
  that stops (a rate limit, say) can simply be started again.
- **Signatures are recorded.** Every transaction's signature and a line on what it did go into
  `devnet/devnet.json` under `transactions`, and the details under `registry`, `registration`,
  `deals` and `tokenAccounts`.
- **The smoke tests hold no key and send nothing**, so anyone can run them at any time against a
  record whose deploy happened. Against session 15's record they fail, because nothing was
  deployed.

**Rehearsing on a local validator first** costs no devnet SOL. Set `FOREST_DEVNET_RPC` to the local
validator and `FOREST_DEVNET_RECORD` to a copy of the record, then start it like this:

```
solana-test-validator --reset --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g \
  --url https://api.devnet.solana.com --clone 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

- **The deactivated feature is SIMD-0500**, "Disable deployment of SBPF v0, v1 and v2 programs". A
  test validator turns every feature on. These builds are SBPF v0, and v0 still deploys on devnet
  and mainnet, where SIMD-0500 is not active.
- **`--clone` plants devnet USDC's mint**, which `init` reads.

## What is different from mainnet

- **Not sealed.** The upgrade authority stays on the deploy key. Sealing (`solana program
  set-upgrade-authority <id> --final`) is the mainnet step, done the day each program deploys
  there, as both READMEs say. On devnet the programs stay upgradeable, and here by a key nobody
  holds any more.
- **Throwaway keys.** The treasury, the foundation issuer and the program ids are one machine's
  throwaway keys, not the charter's treasury, the foundation's issuer key, or ids kept for
  mainnet.
- **A test token.** The run pays in a test dollar the run mints itself, not USDC.
- **No Kora.** A plain payer key plays the fee payer and charges nobody.
- **No face check.** The issuer inserts a commitment derived from a public test seed.

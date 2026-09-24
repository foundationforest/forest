# Devnet

Devnet is Solana's practice network: test SOL from a faucet, no real money. Everything here is
throwaway except the program ids and this record. `devnet/devnet.json` is the same record in a form
the scripts and the smoke tests read. Nothing is shipped; devnet is not mainnet.

## Status (session 15): stopped at the deploy, waiting for test SOL

Done:

- Four throwaway keys and their funding. Deploy, treasury, issuer and payer keys, plus the two
  program ids, a buyer, a seller and a test dollar's mint and mint authority. They were made with
  `solana-keygen` on the session's machine, outside the repo, and printed nowhere. Only the public
  keys are recorded (`devnet/devnet.json`, `keys`).
- The faucet, retried for 28 minutes with backoff and smaller amounts. It granted 3 of 376
  requests:
  - deploy: 1.0 SOL;
  - payer: 0.2 SOL;
  - treasury: 0.1 SOL;
  - issuer: nothing.

  Every other answer was a rate-limit refusal. The signatures and the exact answers are in
  `devnet/devnet.json`, under `airdrops`.
- Both programs built for devnet (`devnet/build.sh`, below):
  - registry: 329,136 bytes, sha256 `133dcd70…6c75bb`;
  - escrow: 363,120 bytes, sha256 `bbe41b6d…ea431c31`.
- The whole run rehearsed on a local validator with those exact builds at their devnet ids, with
  every step green:
  - the deploy (`devnet/deploy.sh`);
  - the registry run (init, the test dollar accepted, one person inserted, one registration, the
    same one refused);
  - the two deals;
  - the eight smoke tests.

Blocked: the deploy. Deploying both programs costs the deploy key about 5.37 SOL at its peak (each
program's data account, plus a buffer of the same size while it uploads, refunded after). The key
holds 1.0.

Nothing is deployed on devnet yet.

# Devnet

Devnet only: this is Solana's practice network, with test SOL and test dollars and no real money.
Nothing is on mainnet.

Up: [the repo](../README.md). The scripts that put these here: [devnet/](../devnet/README.md).

## What runs

| Program | Program id | Record |
|---|---|---|
| Registry | `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` | [`registry/devnet/devnet.json`](../registry/devnet/devnet.json) |
| Escrow, v1 | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` | [`devnet/devnet.json`](../devnet/devnet.json) |
| Escrow, v2 | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` | [`escrow/v2/devnet/devnet.json`](../escrow/v2/devnet/devnet.json) |

All three are built as SBPF v3, and none is sealed: each one's upgrade authority is the devnet deploy
key, `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A`, which anyone holding the devnet phrase holds.

What is on them:

- **Registry:** one line, at `469GDtZ4yNERtQJHHAFvQvGUmMWJgtzw1oFGinYuDaKt`: the keys recipe's test
  profile 0 (`Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx`) under `freelance/seller`, proven against
  a stand-in issuer's list. A membership record for a second stand-in issuer is in the record, and
  checks against the line.
- **Escrow v1:** two receipts in the test dollar: an invoice paid and released in one tap
  (`GCWxAT7cQZeaRdfkTkhsRnAPEEim58pv6SJqfJrtq8Qm`), and a buyer's escrow split 60/40 by both sides
  (`CerdZJU5Xqk8wrn5x3KDF41fW6Kd22QRR1h4GFG6zumq`).
- **Escrow v2:** five receipts. In the test dollar: an invoice paid in one tap
  (`B4LdqfRmxNwU56vUBk447AQnd34BKZox5HzdPo95CPje`), and an escrow with a timer the buyer objected
  to, then split (`CaQG2mdoHnoPif9LdtVipULdyJAWCXCXViJ4jSHoJE2B`). The same two again in a
  Token-2022 dollar made with Open USD's extensions (`8Vt3eP2eCPQ9sUAXWAqKsTqVZuNUEVUSKnM1J5izzyCK`,
  `Cw4jQXhSPfXjbW66fn5pN7oj5mN8XPLnNCMZ3XaT5BAu`), and one more invoice in it
  (`2GPnA88UjFHA8WA6nA3WzQm7eaNGzStFYpEfiEd7yjPz`).

| Test dollar | Mint | |
|---|---|---|
| Classic | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` | 6 decimals; mint authority `EK6EjtXy1YMDwDSUNQGJv6RVuG4KVRyoJxErZGR2xyzK` |
| Token-2022, Open USD's extensions | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` | 6 decimals; every issuer role held by the payer key |

| Key | Public key |
|---|---|
| deploy | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` |
| payer, playing the relayer | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| buyer | `4kFff36dwTKhK8tEm4m9QiyRCRcj67aXsYgkKMxwLuqE` |
| seller | `3Ttfgh6ATW9j5cYMttLiZuVub77hQjkDiZDDhzqyooTf` |

## Closed

Superseded programs, closed: each one's program data is gone and its deposit went back to the deploy
key. The accounts they made stay readable, their rent locked for good, and nothing can change them.
A closed program id can never hold a program again.

| Was | Program id | Record |
|---|---|---|
| The first registry: lists, a code tree, a fee | `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i` | `devnet/devnet.json`, `registry.closed` |
| A registry whose lines could grow | `GWyKGgoRg2g3kpKNgsXBWS1ayHTHHzwbtLJW4XGVP2RW` | `registry/devnet/devnet.json`, `earlier` |
| The first escrow v2, classic tokens only | `B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7` | `escrow/v2/devnet/devnet.json`, `earlier` |

## How to check

Read-only; nothing here needs a key.

```
solana program show <program id> --url devnet     # a running one names its authority, the deploy key;
                                                  # a closed one answers "Program <id> has been closed"
solana account <address> --url devnet             # any receipt or line above

cd registry/client && npm ci && npm run test:devnet   # the registry and its line, checked against the record
cd escrow/client   && npm ci && npm run test:devnet   # escrow v1 and its two receipts
```

Escrow v2 has no smoke test: read its receipts with `solana account`, and decode them with
`decodeEscrow` from `escrow/v2/client`. `FOREST_DEVNET_RPC` points the smoke tests at another devnet
endpoint.

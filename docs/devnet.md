# Devnet

Devnet only: this is Solana's practice network, with test SOL and test dollars and no real money.
Nothing is on mainnet.

Up: [the repo](../README.md). The scripts that put these here: [devnet/](../devnet/README.md).

## What runs

| Program | Program id | Record |
|---|---|---|
| Registry | `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` | [`registry/devnet/devnet.json`](../registry/devnet/devnet.json) |
| Escrow | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` | [`escrow/devnet/devnet.json`](../escrow/devnet/devnet.json) |
| Escrow v1, source no longer in this repo | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` | [`devnet/devnet.json`](../devnet/devnet.json) |

All three are built as SBPF v3, and none is sealed: each one's upgrade authority is the devnet deploy
key, `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A`, which anyone holding the devnet phrase holds.

What is on them:

- **Registry:** two rows on a stand-in keeper's list (`5tUPxWGKqNbFctBXKS8LgnkM8A1Jfn5qVrUGxKjFXozB`),
  under `freelance/seller`.
  - The current one, at `LhQV7M3m63r4WWFYbgVhr9C3fo5ouFyb6PLjpHZAAPF`: keys/'s test person, for
    their `freelance/seller` profile (`5RWsXwx9Urx8d9sUv1i4viMJZ9pQufyNA76o7sCdLysx`). The record
    also holds the refusal of their `freelance/buyer` profile's row for the same market stamp, and a
    refund.
  - An earlier test person's, at `9UDuRdcKnuYPKeafnW4C29WdpDnFKtYLhqdwvFRKfhkr`, for a stand-in
    profile, made before keys/ moved to its new test seed. Rows never close, so it stays, at its
    rent minimum, with nothing left to refund. The record keeps it under `earlierRows`.
- **Escrow:** five receipts. In the test dollar: an invoice paid in one tap
  (`B4LdqfRmxNwU56vUBk447AQnd34BKZox5HzdPo95CPje`), and an escrow with a timer the buyer objected
  to, then split (`CaQG2mdoHnoPif9LdtVipULdyJAWCXCXViJ4jSHoJE2B`). The same two again in a
  Token-2022 dollar made with Open USD's extensions (`8Vt3eP2eCPQ9sUAXWAqKsTqVZuNUEVUSKnM1J5izzyCK`,
  `Cw4jQXhSPfXjbW66fn5pN7oj5mN8XPLnNCMZ3XaT5BAu`), and one more invoice in it
  (`2GPnA88UjFHA8WA6nA3WzQm7eaNGzStFYpEfiEd7yjPz`).
- **Escrow v1:** two receipts in the test dollar: an invoice paid and released in one tap
  (`GCWxAT7cQZeaRdfkTkhsRnAPEEim58pv6SJqfJrtq8Qm`), and a buyer's escrow split 60/40 by both sides
  (`CerdZJU5Xqk8wrn5x3KDF41fW6Kd22QRR1h4GFG6zumq`). Its source and client are in git history only.

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
| Two later registries: lines that grew, then lines that never changed | `GWyKGgoRg2g3kpKNgsXBWS1ayHTHHzwbtLJW4XGVP2RW`, `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` | `registry/devnet/devnet.json` at commit `0abdd13` |
| The escrow's first deploy, classic tokens only | `B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7` | `escrow/devnet/devnet.json`, `earlier` |

## How to check

Read-only; nothing here needs a key.

```
solana program show <program id> --url devnet     # a running one names its authority, the deploy key;
                                                  # a closed one answers "Program <id> has been closed"
solana account <address> --url devnet             # any receipt or row above

cd registry/client && npm ci && npm run test:devnet   # the registry and its row, checked against the record
```

The escrow has no smoke test: read its receipts with `solana account`, and decode them with
`decodeEscrow` from `escrow/client`. `FOREST_DEVNET_RPC` points the smoke test at another devnet
endpoint.

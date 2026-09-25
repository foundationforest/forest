# index

The Forest index, part one: the data and the scores, served as JSON. It reads signed records from
a firehose and the registry's and escrow's own events from the chain. It scores every profile
twice (uniqueness and trust, never blended, each score signed twice) and serves stable JSON URLs
with no session and no login. Pages for people come in part two.

**Nothing here is shipped.** It has run on this machine against a local host, a local directory
of DIDs, a local validator and a local Postgres, and nowhere else. Nothing is deployed.

## What it reads

- **Records**, from a firehose: the host's own (`host/`) in tests, the carrier later.
  - It uses Bluesky's own consumer, `@atproto/sync`, unchanged. For every commit, the consumer
    resolves the DID document, checks the commit's signature against the signing key the document
    names, and checks each record against the signed commit by its Merkle proof. A commit that fails
    is dropped whole.
  - Each record is then checked against its lexicon with `shapes/`' own validator, and a record that
    fails is not stored.
  - Only the four Forest collections are read: profile, post, review, credential. The cursor is kept
    in Postgres, so a restart resumes where it stopped.
- **Chain events**, from an RPC: a local validator in tests.
  - For each program, it reads every transaction that named it, oldest first; failed transactions
    are skipped.
  - It keeps each transaction's log lines in its own archive (`chain_transactions`), because RPC
    nodes are not an archive.
  - It reads only events the programs themselves wrote. The clients' decoders already refuse a
    `Program data:` line that another program wrote.
  - From the registry, **badges**: the scope (market, and role after a colon), the DID, the profile's
    wallet, the list, and the list's owner.
  - From the escrow, **receipts**: buyer, seller, token, amount, when it was funded, accepted and
    ended, the outcome, and what each side got.
- **The market directory**, from a folder of market files (`MARKETS_DIR`): the `markets` repo's
  once it exists; `shapes/examples/markets` in tests. Each file is checked with `shapes/`' validator.

**The escrow program is being rewritten.** Everything the index knows about its events is in one
file, `src/chain/escrow.ts`. It maps the escrow client's events to the index's own `EscrowFact`.
When the events change, change that file and nothing else.

## How it scores

In [SCORING.md](SCORING.md), in plain words. In short:

- A badge counts only under a directory name, byte for byte, and only for the wallet the profile
  declares.
- **Uniqueness** combines the weights this index gives the issuers vouching for a badge. The
  weights are in `config/issuers.json`: the foundation's list starts at 1, everyone else at 0.
- **Trust** sums the reviews received. Each weighs by its reviewer (their badge, then their own
  trust) and by what is under its deal id:
  - a receipt both sides said yes to: 1
  - a one-tap payment: 0.5, or 1 once the seller reviews it too
  - no receipt: 0.05
- Every score is signed with Ed25519, and with EdDSA-Poseidon on BabyJubJub for later proofs.

## Endpoints

GET only; JSON; `cache-control: public, max-age=30`; `access-control-allow-origin: *`; no
cookies, no session, no login. Amounts are base units as strings. Scores are numbers; the signed
statement carries the exact value in millionths.

| URL | What |
|---|---|
| `/` | The index's two public keys, the statement format, and the list of endpoints |
| `/categories` | Each category, from the market files, with its markets and their live offer counts |
| `/markets/{market}` | The market file, the aliases this index groups under it, and counts (offers, requests, badged profiles). An alias answers 301 to the directory name |
| `/markets/{market}/offers?limit=&offset=` | Live offers, alias spellings included. Badged sellers first, then by trust, then newest. Each offer carries the seller's two scores side by side |
| `/profiles/{did}` | The profile, every badge (counted or not, and why not), both signed scores, posts, credentials, review counts |
| `/profiles/{did}/reviews` | Reviews received and given, each with its evidence, its reviewer's weight and what it added |
| `/deals/{dealId}` | The escrow receipt (or null for a deal with no escrow), the profiles that declare its two wallets, and the reviews that name it |
| `/search?q=` | Directory markets whose name, alias, category or role contains `q`, and live offers matching `q` by full-text search (Postgres's `simple` configuration, which favours no language) |

The endpoints use the records' own field names, such as `wallet` and `mint`, because they are for
machines. Pages for people (part two) show none of them.

## Run it locally

Needs Node 22.18 or later (it runs TypeScript directly) and Postgres 14 or later. The index imports
`registry/client`, `escrow/client`, `shapes` and, in tests, `keys` and `host/` by path, so install
those first:

```
(cd shapes && npm install) && (cd registry/client && npm install) && (cd escrow/client && npm install)
cd index && npm install

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/forest_index
export MARKETS_DIR=../shapes/examples/markets
export INDEX_SIGNING_SEED=$(openssl rand -hex 32)     # keep it: it is the index's signing identity
export FIREHOSE_URL=ws://localhost:2583              # a host from host/run.sh, or the carrier
export PLC_URL=https://plc.directory
export SOLANA_RPC_URL=http://127.0.0.1:8899
npm start                                            # migrates, reads, scores, serves on :8080
```

Tests:

```
npm run test:unit                                    # the scoring rules and the signatures; nothing else needed
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
```

`npm test` also runs the end-to-end test. It needs:

- `host/` built (`./build.sh`) and `keys` installed;
- both programs built (`cargo build-sbf` in `registry/program` and `escrow/program`);
- the proving files (`npm run fetch` in `registry/artifacts`);
- `solana-test-validator` on the PATH;
- a Postgres where it may create and drop a database.

It skips, saying which, if one is missing. It takes about 30 seconds here, 19 of them making three
registration proofs.

`npm run check` type-checks; `npm run migrate` applies the migrations and stops (`npm start` does
that too).

## Environment variables

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. A local one, or Supabase's connection string later |
| `MARKETS_DIR` | yes | A folder of market files. Only these names count in badges and indexes |
| `INDEX_SIGNING_SEED` | yes | 32 bytes as 64 hex characters. Both signing keys come from it |
| `FIREHOSE_URL` | no | `ws://` or `wss://`. Unset: no record reader |
| `PLC_URL` | no | Where DIDs resolve. Default `https://plc.directory`. An `http://` URL (a local directory) makes the resolver use plain fetch |
| `SOLANA_RPC_URL` | no | Unset: no chain reader |
| `CHAIN_COMMITMENT` | no | `finalized` (default) or `confirmed` (tests) |
| `CHAIN_POLL_MS` | no | Default 5000 |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID` | no | Default: the clients' own ids |
| `PORT` | no | Default 8080 |
| `ISSUERS_FILE`, `ALIASES_FILE`, `SCORING_FILE` | no | Default: the files in `config/` |

## Files

| | |
|---|---|
| `migrations/` | The schema, in plain SQL, applied in order, each once |
| `config/` | This index's opinions: issuer weights, market aliases, scoring weights |
| `src/records/` | The firehose reader and the record store |
| `src/chain/` | The chain reader, the registry adapter, and **the escrow adapter** |
| `src/scores/` | The scores as pure functions, the signatures, and the recompute |
| `src/api/` | The endpoints (`handle(Request) → Response`) and a node:http server |
| `SCORING.md` | The rules, in plain words |

## Part two

Not built here:

- **Pages for people**, with structured data, published per category once it is dense enough.
- **The JSON twin of every page**, at a URL next to it.
- **A sitemap, `llms.txt`, and the read skill**: a plain text file that teaches any AI where the
  endpoints are and how to read them, published at forest.foundation and in `index/`.
- **The badge and the pay link** on forest.foundation. The pay link is a one-time Solana Pay link
  naming the escrow's address.
- **Deploy** to Vercel and Supabase. The endpoints can run as Vercel functions (`handle` is a web
  standard handler). The two readers hold an open websocket and a poll loop, which a serverless
  function cannot keep alive, so they need a long-running process somewhere. Where is an open
  question.

The choices made here where the handoff was silent, and the open questions, are in
`docs/changes/index.md`.

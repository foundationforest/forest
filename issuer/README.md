# issuer

The foundation's issuer: the step from "a face check passed" to "this person's secret is on the
foundation's list". The foundation runs the first issuer, on list 0, which it owns. Issuers are
open: anyone may open a list of their own in the registry and run this service, or another, on it.

**Nothing here is shipped.** It has run against a stand-in Didit and a local validator, and nowhere
else: no real face check, no devnet, no Railway.

## What it does

1. **The app asks for a face check.** `POST /session`: the service opens a Didit session on the
   foundation's workflow and returns the page the person does the check on, and the session's id.
2. **The person does the check** on Didit's page: liveness and a duplicate-face search. Didit holds
   the face.
3. **The app sends two things:** the session id and the person's identity commitment, computed on
   the device from the identity secret `keys/` derives (`humanIdentity(seed).commitment`). Nothing
   else is accepted: a body with any other field is refused.
4. **The service asks Didit for that session's decision** and accepts only this: the session is on
   the foundation's workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session id
   counts once.
5. **Accepted commitments wait in a queue.** A batch takes all of them every hour, or as soon as 50
   are waiting, whichever comes first. It shuffles them and inserts them into the list one
   transaction each, so an entry on the chain can't be matched to a face check by when it arrived.
6. **The app polls `POST /status`** until its commitment is `listed`. It can then build proofs
   against the list with `registry/client`.

## What it never does

- **Never keeps a session next to a commitment.** The file holds two tables that share nothing, with
  no timestamps and no row numbers: the SHA-256 of every session id used, and the commitments still
  waiting. A commitment leaves the file once it is on the list. Deleted bytes are overwritten, and
  after every batch the whole file is rewritten from what it still holds. A test reads the raw file
  and checks this.
- **Never logs a request, an address, a session id or a commitment.** It logs one line per batch
  (how many were inserted) and the kind of an error, never an error's message.
- **Never puts anything a person sends in a URL.** All three routes are POST with a JSON body,
  because hosting platforms log every request's path.
- **Never stores anything at `/session`.** The session's `vendor_data` is a fresh random id that
  names nobody.
- **Never signs for anyone.** Its key signs only its own inserts, and it holds no one else's key.
  There are no accounts.
- **Never deletes a Didit session.** Deleting a session removes that face from Didit's duplicate
  search, and the person could then pass again under a new secret.

## The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "https://verify.didit.me/…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "commitment": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"commitment": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |

The commitment is a decimal number, as Semaphore prints it: above zero, below BN254's field order,
no leading zero.

Errors are `{"error": "<code>"}`:

- **`400`: a malformed request.**
  - `bad_session_id`, `bad_commitment`, `not_json`, `not_an_object`, `expected_empty_body`
  - `expected_exactly_sessionId_and_commitment`, `expected_exactly_commitment`
- **`403`: a face check that does not count.**
  - `unknown_session`, `wrong_workflow`, `duplicate_face`
  - `no_liveness`, `liveness_not_passed`, `not_approved`
- **`409`: already used or waiting.**
  - `session_used`, `commitment_queued`, `already_listed`
- **Other codes.**
  - `404 not_found`, `405 post_only`, `413 too_large` (bodies are capped at 1 KB)
  - `502 face_check_unavailable`, `500 internal`

A refused or failed submit uses nothing up. The same session can be sent again, for instance once a
review in Didit's console approves it. CORS is open to any origin.

## The Didit workflow it expects

The service reads a decision; it can't see how the workflow was set up. So these are rules for
whoever runs it:

- **A liveness step, with face search on.** Face search is on by default. A workflow can turn it off
  (`face_search_enabled: false`), and then no decision says "duplicate" at all.
- **The duplicate-face rule should decline.** The issuer refuses the risk codes whatever the
  workflow's rules decide, but the person should be told on Didit's page, not afterwards.
- **Never delete sessions, or turn on biometric-template retention first.** Deleting a session
  drops its face from the duplicate search.
- **`DIDIT_API_KEY` must belong to the application that owns the workflow.** Didit shows a key only
  its own application's sessions.

## Running it locally

Node 22.18 or later runs the TypeScript directly. The registry client is imported from
`../registry/client/src` by relative path, the way `registry/client/scripts/devnet.ts` imports
`keys/`, so both packages need their dependencies:

```
cd registry/client && npm ci
cd issuer          && npm ci
npm run check                # type-check, the registry client's files included
npm test                     # no chain: a stand-in Didit, an in-memory list, a real SQLite file
npm run test:validator       # end to end on solana-test-validator (see below)
npm start                    # the service, with the variables below
```

`npm run test:validator` needs the Solana CLI on the PATH (4.2.2, `docs/devnet.md`) and the registry
program built (`cargo build-sbf` in `registry/program`). It starts its own validator, loads the
program, sends `init`, and starts the service from its environment variables with the real chain
client and a stand-in Didit. The issuer key is the program's placeholder, which the tests can sign
for; see `registry/README.md`, deploy checklist step 2.

To run the service by hand against that validator, write a key file (`solana-keygen new -o
issuer-keypair.json`, or the placeholder as the test does) and set at least the four required
variables.

## Environment variables

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The foundation's Didit API key. A secret. |
| `DIDIT_WORKFLOW_ID` | yes | | The workflow sessions are opened on; decisions on any other are refused |
| `ISSUER_KEYPAIR_PATH` | yes | | Path to the issuer's key file (64 numbers, as `solana-keygen` writes). It must be an insert key of the list, and it pays its own inserts, so it holds a little SOL. Never commit it (`.gitignore` covers `*keypair*.json`) |
| `SOLANA_RPC_URL` | yes | | The RPC the service reads the list from and sends inserts to |
| `REGISTRY_PROGRAM_ID` | no | the client's `PROGRAM_ID` | The registry program; devnet's is in `devnet/devnet.json` |
| `LIST_INDEX` | no | `0` | The list this issuer inserts into |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file |
| `BATCH_MAX` | no | `50` | A batch runs as soon as this many are waiting |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer, whatever is waiting |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

The service refuses to start if a required variable is missing, if the key is not an insert key of
the list, or if the list is closed.

## What running it on Railway will need

Not tried. What the service needs from any host, as it reads on Railway's documents in September
2026:

- **One replica, never more.** The queue is a SQLite file and one process runs the batches.
- **A volume** for `DATABASE_PATH`, or every deploy empties the queue and forgets the used sessions.
  A volume backup is a copy of the file as it was: waiting commitments included, and the deleted
  bytes of files that are gone, which the service can't rewrite.
- **The repo root as the build's root,** since the service imports `registry/client`.
  - Build: `npm ci` in `registry/client`, then in `issuer`. Start: `npm start` in `issuer`.
  - Node 22.18 or later: Railpack reads `RAILPACK_NODE_VERSION`, or `engines` in `package.json`.
  - The repo root has no `package.json`, so Railpack may not recognize the service as Node without
    a Railpack config file or a Dockerfile. Not tried.
- **`DIDIT_API_KEY` as a sealed variable.** Railway gives a sealed variable to the service but
  never shows it again.
- **The key file.** Railway has no secret files. Either the file sits on the volume (then every
  volume backup holds the key), or the start command writes it from a sealed variable to a path
  outside the volume. Not decided.
- **SOL on the issuer key** for its inserts, about 5,000 lamports each.
- **Railway's HTTP logs.** Railway keeps every request's client address and path for 3 to 90 days,
  depending on plan, and its documents describe no way to turn that off. The service puts nothing
  in a path, but the addresses are Railway's log, not the service's. This conflicts with "no address
  logs" and is open (`docs/changes/issuer.md`).
- **A public domain** for the app to call. `PORT` is set by Railway.

## Chosen, not decided

Where the handoff and the task were silent, the simplest option was taken. Each is reversible
until something ships, and each is in `docs/changes/issuer.md`.

1. **Each Didit session gets a random `vendor_data`.** Didit's duplicate check compares a face
   against faces verified under a different `vendor_data`, and its documents don't say what happens
   with none. A fresh random one per session makes every earlier face count, and names nobody.
2. **`POSSIBLE_DUPLICATED_FACE` refuses, like `DUPLICATED_FACE`.** "Not a duplicate" is not what
   Didit reported.
3. **The session must be approved as a whole,** not only its liveness steps.
4. **A refused or failed submit doesn't use the session up.** A session in review may be approved
   later.
5. **Status is a POST,** so a commitment is never in a URL.
6. **The commitment is sent as a decimal number,** the way Semaphore prints it.
7. **The file keeps session ids as SHA-256 hashes,** not in the clear. Refusing reuse needs no more,
   and a copy of the file then lists no Didit session.
8. **Two `WITHOUT ROWID` tables, no timestamps, `secure_delete` on, and `VACUUM` after every batch.**
   `VACUUM` rewrites the file from its live rows, which also drops the order rows arrived in. The
   rollback journal is deleted after each commit.
9. **One insert per transaction,** sent in the shuffled order, each confirmed (or its blockhash
   expired) before the next. The issuer key pays its own network fees; the fee payer is for
   people's transactions.
10. **A batch takes everything waiting,** skips any commitment already on the list, and stops at
    the first failure, leaving the rest queued. The program takes the same commitment twice, so not
    sending it twice is the issuer's job.
11. **The members are held in memory,** read from the chain at start and before every batch, plus
    each confirmed insert. `/status` never reads the chain itself.
12. **`node:sqlite` and `node:http`,** built into Node, so the service has one dependency:
    `@solana/web3.js`, pinned to the client's version.
13. **CORS is open to any origin.** The app may be served from anywhere.
14. **At start, the key must be an insert key of an open list.**

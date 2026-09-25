# Changes: the issuer

This session ran in parallel with others and owned `issuer/` only, so its log is here rather than in
`docs/changes.md`, as Carlos asked. The next session that edits `docs/changes.md` or
`docs/handoff.md` folds it in. The handoff's build status (Next, step 2) is not updated here.

## 2026-09-25: the issuer, face check to list, batched

- **Build order:** step 2 of the handoff's "Next", the issuer flow, asked for by Carlos. It runs on
  a local validator with a stand-in Didit. Nothing is deployed: no real face check, no devnet, no
  Railway.
- **Decided (by Carlos, in planning; built here):**
  - **The issuer also opens the Didit session (`POST /session`).** The task had the app get a session
    id by itself, but opening a session needs the foundation's API key (`POST /v3/session/`), which
    an app can't hold. And the handoff rules out the face check as a product-side service. So the
    service has three routes, not two.
- **Chosen, not decided:** the fourteen in `issuer/README.md`, "Chosen, not decided". The ones that
  matter most:
  - **A random `vendor_data` on every session.**
  - **`POSSIBLE_DUPLICATED_FACE` refuses.**
  - **A refused session is not used up.**
  - **Status is a POST,** so no commitment ever sits in a URL.
  - **Session ids are kept hashed.**
  - **`VACUUM` after every batch.**
  - **One insert per transaction, paid by the issuer key.**
- **Built:**
  - **`issuer/`, a small HTTP service in TypeScript** on Node's built-in HTTP and SQLite.
    - Its one dependency is `@solana/web3.js`, pinned to the registry client's version.
    - `src/didit.ts`: the `FaceCheck` interface, the Didit v3 client, and `judge`, the one rule.
    - `src/store.ts`: two tables that share nothing.
    - `src/list.ts`: the list's members and the insert, through `registry/client`.
    - `src/batch.ts`: shuffle, the triggers, and the rewrite after each batch.
    - `src/server.ts`: the three routes. `src/service.ts`: configuration from the environment.
  - **Tests:** 18 without a chain and one end to end on `solana-test-validator`, all passing.
    - **Without a chain:** the accepted flow; a failed liveness check refused; a duplicate face
      refused (both codes, whether Didit's rules declined it or not); a reused session refused,
      including two requests racing on one session; every other refusal and malformed body;
      batches shuffled (neither arrival order nor the file's key order); both triggers; no double
      insert after a crash; a failed batch keeps the rest queued.
    - **The raw file:** after the batch, the file holds none of 300 commitments in any form, no
      session id in the clear, only the two tables, and no journal beside it. With `secure_delete`
      and `VACUUM` turned off, this test fails.
    - **The Didit client:** tested against a local stand-in answering in the shape of Didit's
      documents.
    - **End to end on a validator:** `init`, the service started from environment variables with
      the real chain client, three people submitted, one batch, and the list's leaves read back
      with `fetchListLeaves` are exactly those three.
    - `registry/client`'s own tests still pass (20 of 20).
  - **`issuer/README.md`:** what the service does and never does, the API, the Didit workflow it
    expects, how to run it, the environment variables, and what Railway will need.
- **Learned:**
  - **Didit's API is version 3.**
    - Fetching a decision: `GET https://verification.didit.me/v3/session/{id}/decision/` with an
      `x-api-key` header. Opening a session: `POST /v3/session/`.
    - A decision carries `liveness_checks[]`, each with its own `status` and `warnings[].risk`.
    - Didit's own documents write the status both as `Approved` and as `APPROVED`.
  - **A duplicate face is a risk code, not a status.**
    - Didit's face search runs inside every liveness step and reports `DUPLICATED_FACE` or
      `POSSIBLE_DUPLICATED_FACE`, meaning the face was "already verified under a different
      `vendor_data`".
    - Its standalone Face Search returns "Approved" for a pure duplicate and leaves the policy to
      the caller. So the issuer checks the codes itself rather than trusting a status.
  - **Deleting a Didit session removes its face from the duplicate search,** and the person can
    then pass again unflagged, under a new secret. A workflow can also turn the face search off
    (`face_search_enabled: false`), and then no decision says "duplicate". The issuer can see
    neither. Both are operating rules in the README.
  - **Didit lets an API key see only its own application's sessions.** A product holding its own
    Didit key could not hand the foundation a session to check, which is another reason the
    issuer opens the session.
  - **Railway's HTTP logs keep every request's client address and path,** for 3 to 90 days by
    plan, with no documented way to turn them off.
  - **Deleting a SQLite row does not remove it from the file.** With neither `secure_delete` nor
    `VACUUM`, 156 of 300 deleted commitments were still readable in the file. Either one alone
    removed them all.
  - **The registry takes the same commitment twice**
    (`finding_an_issuer_can_insert_the_same_commitment_twice`). So a batch re-reads the list first,
    and waits for each insert until its blockhash expires, never less.
- **Open:**
  1. **Losing the seed, against the duplicate check.** The handoff says a person who loses their
     seed gets back on the list with another face check. But that face is already on the list, so
     Didit reports a duplicate and this issuer refuses it, forever. Either the handoff's sentence
     changes, or something decides when a known face may join again. Letting it join again gives
     one human two secrets, so two badges per market.
  2. **A passed check that never reached `/submit`** (the device lost between the check and the
     submit) locks the person out the same way: their face is Didit's, and their session id is
     gone with the device.
  3. **A minimum batch size.** An hourly batch of one person is an anonymity set of one for anyone
     who sees both Didit's session times and the chain. Should a batch wait for at least N?
  4. **Railway's address logs conflict with "no address logs".** The service keeps none, but
     Railway keeps every client address for days. This applies to the host and every other
     Railway service too. It needs a decision: accept it, find a host that does not log, or put
     something in front.
  5. **No rate limit on `/session` or `/submit`.** Anyone can open Didit sessions at the
     foundation's cost (Didit bills per check, beyond a free monthly allowance), and a flood of
     submits spends Didit's decision rate limit.
  6. **Where the issuer key file lives on Railway:** on the volume (every backup then holds it), or
     written at start from a sealed variable. Before mainnet it is the real `FOUNDATION_ISSUER`
     key, not the placeholder.
  7. **A manual approval in Didit's console keeps the duplicate warning,** so the issuer still
     refuses a false duplicate that a person has cleared. Is there a path for a false positive?
  8. **Two face checks by one person at the same moment** may not see each other in Didit's
     duplicate search if neither is approved yet. Didit's documents don't say; ask Didit.
  9. **`fetchListLeaves` reads every transaction that touched the list,** at start and before
     every batch. Fine at thousands of members, not at millions; an index could serve the members
     instead.
  10. **The Didit client is tested against a stand-in built from Didit's documents, not Didit
      itself.** Its first real run should compare a real decision's shape with `parseDecision`.

## 2026-09-25: the issuer, round two: a request limit, and the key from a sealed variable

- **Build order:** a follow-up to the issuer, asked for by Carlos. The first round's pull request
  (#20) was already merged, so this round is a new pull request from `main`, not an update to #20.
  Nothing is deployed.
- **Decided (by Carlos; built here):**
  - **A simple request limit on opening sessions:** per network address, in memory only, never
    written to disk or logs, a few per hour. A refused request gets a plain "try later". It exists to
    stop someone running up the foundation's Didit bill. The README says it resets on restart and is
    not a security boundary.
  - **The issuer key on Railway comes as a sealed variable** (`ISSUER_KEYPAIR`, the key file's
    contents), written at start to a file readable only by the service in a temporary directory,
    never in the repo or the image. `ISSUER_KEYPAIR_PATH` stays for local runs.
  - **No change to batching:** hourly or at 50, shuffled. The proof already hides which entry on the
    list is anyone's, so a minimum batch size adds little. This closes round one's open 3.
- **Chosen, not decided** (the simplest option; `issuer/README.md`, items 15 to 19):
  - **Five sessions per address per hour by default** (`SESSION_LIMIT_PER_HOUR`), in a window that
    starts at the address's first request. Only `/session` is counted, after its body is checked.
    A refusal is `429 {"error": "try_later"}`, and Didit is not asked.
  - **An IPv6 address counts by its /64,** since one device or household usually holds a whole
    /64. An IPv4 address counts alone. `::ffff:`-mapped IPv4 counts as the IPv4 address.
  - **The limit keeps keyed hashes, not addresses:** HMAC-SHA256 under a random key made at start
    and never written. Windows whose hour has passed are dropped once an hour.
  - **The address comes from a proxy's header only when `CLIENT_ADDRESS_HEADER` names one**
    (`x-real-ip` on Railway). Unset, the connection's own address counts and every such header is
    ignored, so a client can't choose its own address where no proxy stands in front.
  - **The key file is deleted as soon as the key is loaded.** Nothing reads it again. The file is in
    a new directory under the system's temporary directory (0700), holding one file (0600). The
    variable is taken out of the process's environment once read.
  - **Setting both key variables is refused,** rather than one silently winning.
- **Built:**
  - **`issuer/src/limit.ts`:** the limit and the address grouping.
  - **In `issuer/src/list.ts`:** `parseKeypair`, whose errors quote none of the key, and
    `writeKeyFile`. `issuer/src/service.ts` and `issuer/src/server.ts` wire both in.
  - **A leak fixed on the way:** a malformed key file used to fail with JSON's own parse error,
    which quotes part of the text it fails on, so a broken key would have printed part of itself to
    the log. Both key paths now fail with a message naming only the variable or the file.
  - **Tests:** three new ones without a chain, 21 in all, and the validator test now runs with the
    key from `ISSUER_KEYPAIR`. All pass.
    - **The limit over HTTP:** three sessions, then `try_later`, with Didit not asked; another
      address unaffected; three IPv6 addresses in one /64 share a count, and the next /64 doesn't;
      a malformed request isn't counted; with no header named, a client's own `x-real-ip` is
      ignored; no address in the log or the file.
    - **The limit's clock:** a fresh share after an hour, stale windows dropped, the /64 grouping.
    - **The key:** from a variable, the file and its directory private to the user and under the
      temporary directory, removed afterwards; malformed keys refused without quoting them; both
      variables refused.
    - **End to end:** on the validator, the service loaded the key from `ISSUER_KEYPAIR`, and its
      file was gone once the service was up.
    - Turning the limit off fails two tests; writing the key file readable by all fails one.
  - **`issuer/README.md`:** "The request limit", the two key variables, Railway's
    `CLIENT_ADDRESS_HEADER`, and items 15 to 19 of "Chosen, not decided".
- **Learned:**
  - **Behind Railway's edge, the connection's address is the edge's,** so a limit that counts it
    would limit everyone together. Railway puts the client's address in `X-Real-IP` (its networking
    documents).
  - **Railway hands sealed variables to builds as well as deployments,** so "not in the image" holds
    only while no build step reads `ISSUER_KEYPAIR`. None does.
- **Open:**
  1. **Shared addresses share one count.** People behind one carrier-grade NAT or one campus address
     get five sessions an hour between them. Whether that is too few is for real traffic to show;
     the number is one variable.
  2. **`/submit` is not limited.** Each submit asks Didit for a decision, which costs nothing but
     spends Didit's rate limit. Its documents give 600 requests a minute per key in one place
     ("Retrieve Session") and 100 decision reads a minute in another (its agent skills).
  3. **The limit's memory grows with the number of addresses in an hour.** One entry each, dropped
     after the hour. Someone with very many addresses could grow it; not measured.
  4. Round one's open 1, 2, 4 and 7 to 10 stand. Its 5 (no rate limit) and 6 (the key on Railway)
     are closed by this round, and its 3 (a minimum batch) by Carlos's decision.

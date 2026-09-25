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

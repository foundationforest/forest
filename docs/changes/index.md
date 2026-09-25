# Index: changes log

Sessions that build `index/` write here. This file follows `docs/changes.md`'s shape: built, learned, open.

## 2026-09-25: index part one, the data, the scores, JSON

- **Build order:** step 5 of the handoff's "Next" (the index), first half, asked for by Carlos:
  - ingest records from a firehose and registry and escrow events from the chain;
  - score uniqueness and trust, each signed twice;
  - serve JSON.

  Pages, the JSON twin of every page, sitemap, llms.txt, the read skill, the badge and pay link, and
  the deploy are part two. Ran in parallel with other sessions; touched `index/` and this file
  only. Nothing is deployed anywhere.
- **Asked for by Carlos, built as asked:**
  - Postgres with plain SQL migrations.
  - Records from the host's firehose, verified against DID documents.
  - Only the programs' own events.
  - Escrow events through one adapter, so the rewrite in progress changes one file.
  - A badge counts only when the profile declares its wallet.
  - Per-issuer weights in a config file: the foundation's list at 1, others at 0.
  - Evidence weights in three classes.
  - Scores never blended, signed with EdDSA-Poseidon and Ed25519.
  - Market aliases in a config file.
  - The endpoints listed.
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing ships):
  1. **Aliases group posts and URLs, never badges.** A badge counts only under the directory name,
     byte for byte (adversarial review 1, rule 2). If aliases merged badges, one human could
     register under two spellings and hold two badges in one market.
  2. **A reviewer's starting weight is its best uniqueness, with a floor of 0.05 for no counted
     badge.** "Weighted by the reviewer's own trust" with "everyone starts at zero" leaves every
     score at zero forever without a seed; the handoff's "an unbadged reviewer's review weighs near
     zero" supplies it.
     - The reviewer's weight is `max(u, 0.05) × (1 + t/(|t|+1))`, iterated to a fixed point
       (tolerance 1e-9, at most 100 rounds).
     - Uniqueness is only an input to how much a review weighs. The two scores are published
       separately.
  3. **Trust is a sum, not an average.** Each review adds `weight × evidence × (rating − 3)/2`, so
     it can go below zero. No rating counts as neutral (0). Self-reviews are ignored.
  4. **Dedupe:** per reviewer and subject, one review per deal id with evidence under it, and one in
     all (the latest) for everything without. Without this, invented deal ids inflate a score for
     free.
  5. **Evidence classes:**
     - paid and accepted (or invoiced): 1
     - one-tap paid, not accepted: 0.5, or 1 once the seller reviews the same deal id
     - withdrawn, never accepted, never paid, or no receipt: 0.05

     "Paid" is a `Funded` event or an ending that paid from a full balance (rule 6: an ending proves
     funding). An escrow in progress that is funded and accepted already counts fully.
  6. **A receipt counts only when the reviewer and the subject are its two parties by their
     declared wallets**, either way round, and its token is in `countedMints` (USDC mainnet and
     devnet). This is the handoff's "the index decides which tokens it counts"; market files no
     longer list tokens.
  7. **Uniqueness combines issuers as `1 − Π(1 − w)`.** Two issuers at 0.5 give 0.75: more than
     either alone, never more than 1. A sum would overclaim; a maximum would ignore a second voucher.
  8. **The weight follows the list owner the `Registered` entry names**, not whoever owns the list
     after a handover.
  9. **A scope is split at the first colon into market and role.** A role must be one of the market
     file's roles to count. Whether scopes carry roles is still the `markets` repo's call.
  10. **Categories come from the market files' `category` field**; there are no category files yet.
  11. **Trust is per profile, not per market**, because a review names no market.
  12. **Score encoding for signing:**
      - Values are in millionths.
      - The Poseidon message is `Poseidon(domain, kind, fieldHash(did), scopeOf(scope), value + 2^63, at)`.
        The scope is the registry's own `scopeOf`, so a later circuit ties a uniqueness score to the
        Semaphore scope of that market's badge.
      - The Ed25519 signature is over a six-line text statement.
      - Both keys come by HKDF-SHA256 from one seed, `INDEX_SIGNING_SEED`.
      - A value that did not change keeps its statement and signatures.
  13. **The index's public keys are served at `/`**, an endpoint not on the list, because without
      them nobody can check a signature.
  14. **Offer order: badged sellers first, then trust, then newest.** Two keys side by side, not one
      blended number.
  15. **An alias URL answers 301** to the directory name.
  16. **Search:** substring match over directory market names, aliases, categories and roles, and
      Postgres full-text search with the `simple` configuration (no language favoured) over live
      offers.
  17. **Full recompute on every change**, debounced by 250 ms, one run at a time.
  18. **Profiles and receipts link by declared wallets.** `/deals/{id}` lists the profiles that
      declare each party's wallet. That is public data the profiles published.
  19. **Not acted on in part one:** identity, account and sync events from the firehose; backfill
      by `getRepo`; photos beyond their CID and type; the unresolved-lock mark (stored as `locked`,
      not weighed).
  20. **The resolver uses plain fetch only when `PLC_URL` is `http://`** (local). Otherwise it keeps
      `@atproto/identity`'s default fetch, which refuses private addresses.
  21. **The index imports `registry/client`, `escrow/client` and `shapes` by relative path**, not as
      packages. Node strips TypeScript types only outside `node_modules`, and those packages are not
      built or published.
  22. **`CHAIN_COMMITMENT` defaults to `finalized`**; tests read `confirmed`.
- **Built** (all in `index/`):
  - **Schema:** `migrations/001_init.sql`: profiles, posts, reviews, credentials,
    chain_transactions (the log archive), badges, escrow_receipts, cursors, review_weights, scores.
  - **Record reader:** `src/records/firehose.ts` (`@atproto/sync` 0.4.10, the host pin's own
    version, with `MemoryRunner` and the cursor in Postgres) and `src/records/store.ts` (the lexicon
    check with `shapes/src/validate.js`, then upsert or delete).
  - **Chain reader:** `src/chain/poll.ts`, which pages `getSignaturesForAddress` back to its cursor,
    archives logs and reads each transaction in one database transaction.
  - **Adapters:** `src/chain/registry.ts` over `decodeRegisteredEvents`, and `src/chain/escrow.ts`,
    **the escrow adapter**, over `decodeEvents`, mapping to the index's own `EscrowFact`.
  - **Scores:** `src/scores/compute.ts` (pure), `sign.ts`, `run.ts`.
  - **Endpoints:** `src/api/routes.ts` (web-standard `handle(Request)`) and `server.ts`
    (node:http). `src/main.ts` runs everything; `src/migrate.ts` only migrates.
  - **Config:** `config/issuers.json`, `aliases.json`, `scoring.json`.
  - **Tests, 20, all passing here:**
    - `test/scoring.test.ts` (8): every evidence class, badge counting, the uniqueness
      combination, dedupe, self-reviews, the fixed point, negative trust.
    - `test/sign.test.ts` (4): both signatures verify; a changed value or another index's keys fail
      both.
    - `test/e2e.test.ts` (1 test, 7 steps), on a local PLC, the host from `host/`, a local
      validator with both programs, and a throwaway Postgres database. It covers three profiles and
      two posts (one under an alias); three real badges on list 0, one for an undeclared wallet;
      a paid deal (open, accept, transfer, mark funded, approve); reviews both ways plus one with a
      made-up deal id; a forged commit refused for its signature next to a genuine one stored;
      scores exactly as the formula gives, with both signatures verified from the served JSON; and
      every endpoint's fields, status codes and cache headers.
  - **Text:** `index/README.md` and `index/SCORING.md`.
- **Learned:**
  - **The firehose consumer does the verification, and does it whole.** A commit for Ana's DID
    signed with Mallory's key reaches `onError` as a `FirehoseParseError`. Its cause is a
    `RepoVerificationError`, "Invalid signature on commit", raised after one retry with a fresh key.
    Nothing from that commit reaches the index's code. Ops whose Merkle proof fails are dropped
    silently.
  - **The payment into an escrow is invisible to a reader that follows the escrow program.** A plain
    token transfer into the deposit address never names the program, so `getSignaturesForAddress`
    on the program does not return it. The index learns the escrow was paid only from `Funded` or
    an ending. That makes rule 6 (an ending proves funding) necessary, not just convenient. The
    test's deal is four escrow transactions, not five.
  - **Two badged people who review each other once converge to 1.618 each** (x = 1 + x/(x+1)). A
    pair reinforces itself; trust is not a count of good deals. Worth a look when Carlos weighs the
    formula.
  - **EdDSA-Poseidon signing is slow in JavaScript: about 88 ms per score**, and verification
    about the same (zk-kit 1.0.4 on this machine, both signatures together). 10,000 changed scores
    take about 15 minutes, inside one database transaction as built. Fine for part one; it needs a
    worker, batching outside the transaction, or a faster library before it has real traffic.
  - **Mixing the clients' copy of `@solana/web3.js` with the index's works** on every path used
    here (instructions, versioned transactions, keys), because web3.js checks shapes, not classes.
    The adapters still turn everything into strings at the boundary.
  - **Timings here:** the end-to-end test takes about 29 seconds, of which about 19 are the three
    registrations (a proof each). The unit tests take about 1 second.
  - **The machine was reset between turns once:** Postgres had to be started again. A later
    session should expect to run `pg_ctlcluster 16 main start` first.
- **Open** (questions for Carlos; not decided here):
  1. **Where the readers run.** The endpoints fit Vercel functions, but the firehose reader holds a
     websocket and the chain reader a poll loop, which serverless cannot keep. Railway, like the
     host and carrier? Part two needs the answer.
  2. **Collusion by real small deals.** Two real people who accept each other's tiny escrows gain
     full evidence each time. Candidates: a minimum amount per counted token, less weight for repeat
     deals between the same two profiles, or both.
  3. **An unbadged profile can claim someone else's wallet** by declaring it, and so be matched to
     that wallet's receipts. It gains at most the 0.05 reviewer floor. The stricter rule, "a wallet
     counts only when a badge proves it", would close it, and would also make an unbadged buyer's
     receipt count as none.
  4. **The trust scale.** A raw sum with mutual reinforcement (the 1.618 above). Whether readers
     need it normalised, or shown as counts beside it, is a part-two question for the pages.
  5. **No rating counts as neutral.** The handoff's "what is missing weighs less" could also mean a
     thin review is a small positive vouch.
  6. **Which tokens count.** Only USDC (mainnet and devnet) is in `countedMints`. Whether the
     treasury's other accepted tokens should count automatically is Carlos's call.
  7. **The issuer weights file names the registry's placeholder `FOUNDATION_ISSUER`.** When the
     registry's placeholder is replaced before mainnet, `config/issuers.json` must change with it.
  8. **Escrow versions.** One escrow program id is read. New deals move to a new version while old
     ones finish on theirs, so the reader needs a list of ids, each with its adapter. After the
     rewrite lands, `src/chain/escrow.ts` is where that goes.
  9. **Backfill and moves.** Only the firehose from cursor 0. A folder imported on another host, or
     history older than the firehose keeps, needs `getRepo` and `verifyRepo`; identity and account
     events (a moved or deactivated folder) are not acted on.
  10. **Signing at scale** (the 88 ms above), and whether the index's signing seed lives in the
      deploy's secrets or a key service.
  11. **The index keeps its own log archive,** but it has only the RPC's word for what the logs say.
      A second RPC to cross-check, or reading the receipt accounts too, is a choice for the deploy.

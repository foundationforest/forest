# Index, part two: changes log

The parallel index session's log for part two (see "Building in parallel" in the handoff), for the
consolidation session to fold into `docs/changes.md` and `docs/handoff.md`. Part one's is
`docs/changes/index.md`. This file follows `docs/changes.md`'s shape: built, learned, open.

## 2026-09-25: index part two, pages for people and machines

- **Build order:** step 5 of the handoff's "Next" (the index), second half, asked for by Carlos.
  The same data as open pages, for people and for machines, with no login anywhere. Ran in parallel
  with other sessions; touched `index/` and this file only. Nothing is deployed anywhere.
- **Asked for by Carlos, built as asked:**
  - **Pages for people,** rendered on the server as plain HTML with no JavaScript: home
    (categories), category, market (offers, sellers ranked), profile, deal (the receipt). No crypto
    words anywhere a person reads.
  - **For machines:**
    - schema.org JSON-LD on every page;
    - a JSON twin of every page at the same URL with `.json`, linked from the page;
    - `sitemap.xml`, and a `robots.txt` that allows everyone;
    - `llms.txt`;
    - the read skill at `/skill.md`.
  - **The badge shown plainly** ("Verified real person, one per market", and who vouched), and a
    **Pay link** on every offer in one documented format (`index/PAYLINK.md`).
  - **The split for hosting:** readers and pages as two processes on one database, documented for
    Railway and, for the pages, Vercel (`index/HOSTING.md`). No deploy.
  - **The tests listed:** every page renders, the JSON-LD validates, each twin matches its page,
    the sitemap lists every page, the skill's URLs resolve, and no banned words.
- **Found on `main`, and fixed here because part two stands on it:**
  1. **Part one did not fit the escrow that merged after it (#22).**
     - `src/chain/escrow.ts` no longer type-checked.
     - An ended deal made the chain reader write `to_timestamp(NaN)` and stop.
     - Every real payment scored "nobody said yes", because the accept step is gone.

     Asked mid-session whether to fix it here; **Carlos chose to fix it here.**
  2. **Part one crashed on the current market file.** `online-tutors.json` no longer lists
     `roles`, and `badgeScope` and `/search` called `roles.includes` on undefined. A unit test
     already failed on `main`. Fixed with shapes' own `rolesOf` (seller and buyer when absent).
  3. **Part one split a badge scope at `:`.** `CLAUDE.md` and `shapes/README.md` recommend
     `market/role` (`online-tutors/seller`). Now only `/`. Never both, since two spellings are two
     codes, so two badges for one human in one market.
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing ships):
  1. **The pages own the bare paths; part one's JSON moved to the `.json` twins.** The spec puts
     the twin at the page's URL with `.json`, and part one's JSON sat at those URLs:
     - `/` became `/index.json`, which also carries the public keys;
     - `/categories` folded into `/index.json`;
     - `/markets/{m}/offers` folded into `/markets/{m}.json`;
     - `/profiles/{did}/reviews` folded into `/profiles/{did}.json`.

     Nothing called them.
  2. **One model per page.** A data function returns an object; that object is the twin, and the
     HTML is rendered from it. That is what keeps the twin and the page from saying different
     things.
  3. **Evidence under the rewritten escrow is the handoff's words, literally.**
     - Paid and created by the seller (an invoice): 1.
     - Paid and created by the buyer: 0.5, or 1 once the seller reviews the deal.
     - Not paid: 0.05.
     - "Paid" is a funding mark or any ending, since every way out needs the full amount.

     A split (both sign) or a release back to the buyer (the seller signs) is not read as the
     seller saying yes; see Open 1.
  4. **The Pay link is an https link at the index:**

         {PUBLIC_URL}/pay?v=1&offer=<at-uri>&cid=<cid>&price.amount=…&price.mint=…&price.per=…[&terms.arbiter=…][&terms.timer.days=…&terms.timer.to=…]

     - Every parameter after `cid` is the post record's own field, by its path.
     - The parameters come in one fixed order, and unknown ones are ignored.
     - **No seller key, on purpose.** The app reads it from the seller's profile, so a forged link
       cannot redirect money.
     - The link checks against the record by `cid`.
     - A browser shows the terms, an app can take the link, and an AI can parse it.
     - The handoff's "one-time Solana Pay link naming the escrow's address" is the next step, after
       an escrow exists; the escrow client makes it (`solanaPayUrl`, `invoice`). Both are in
       `PAYLINK.md`.
     - The link shows only on a live offer whose profile names a key.
  5. **JSON-LD shapes:**
     - A profile is a `ProfilePage` about a `Person`, or a `LocalBusiness` when a live offer names
       a place. Its offers are `Offer`s of a `Service`, priced with `UnitPriceSpecification`.
     - Reviews and the rating are nodes of their own, with `itemReviewed` pointing at the
       profile. schema.org's `review` and `aggregateRating` do not take a `Person`.
     - A market is a `CollectionPage` with an `OfferCatalog`.
     - A deal is a `PayAction`. `MoneyTransfer` does not take `recipient`.
  6. **`AggregateRating` from trust alone, on 1 to 5, as `3 + 2·t/(|t|+1)`.**
     - It uses the same curve the reviewer weight uses.
     - `reviewCount` is the counted rated reviews.
     - `ratingExplanation` says it is not an average of stars.
     - With no counted rated review there is no rating.
  7. **How the pages show the scores:**
     - Trust as its number, with the counts beside it ("1.62 · from 2 reviews, 1 backed by a
       payment"). This answers part one's open question 4 for now.
     - Uniqueness as a percentage on each badge.
     - The two are never on one line as one number.
  8. **Money:**
     - A new `config/currencies.json` maps a token to a currency for display (USDC mainnet and
       devnet as `$`, 6 decimals).
     - Any other token shows as "a price in a currency this index doesn't show", with no number.
  9. **Dates** are `en-GB` in UTC ("5 Sept 2026"), the same for every reader. The pages are in
     English only.
  10. **`noindex` pages:**
      - search results, pay links, and deals with no receipt;
      - these are open to all but kept out of the sitemap;
      - the sitemap is one `urlset` (fine under 50,000 pages).
  11. **The web process holds no seed.** The readers write the public keys to a new `index_meta`
      table when they start; the pages read them.
  12. **Processes:**
      - `node src/main.ts readers | web`, or both with no argument.
      - `PUBLIC_URL` is an origin (default `https://forest.foundation`).
      - `llms.txt` and `skill.md` are written for forest.foundation and served with `PUBLIC_URL`
        in its place.
  13. **The read skill's profile, deal and Pay link examples are the test data's fixed ids.**
      Nothing is live, so the only real URLs are local ones. The skill says so.
  14. **Validating against schema.org means its vocabulary.**
      - The vocabulary is release 30.1 (sha256 pinned), cut to classes, properties, domains,
        ranges and enumeration members: 190 KB in `index/test/schemaorg/`, with the script that
        makes it.
      - The check is strict: every type is a class, every property's domain takes the node, and
        every value fits the range.
      - It does not check any search engine's own rich-result rules.
  15. **Banned words, checked in each page's visible text and shown attributes:** wallet, USDC,
      chain, blockchain, gas, crypto, token, Solana, mint. The read skill (for machines) names
      Solana in its "check it yourself" parts, and tells agents not to say those words to people.
  16. **An empty search's twin answers with no results** (part one's `/search` answered 400), so
      every page has a twin.
  17. **Profile photos are not shown.** Only the blob's id is kept; see Open 7.
- **Built** (all in `index/`):
  - **Pages:**
    - `src/web/`: `data.ts` (page models, with part one's queries moved in), `pages.ts`,
      `html.ts`, `words.ts`, `jsonld.ts`, `paylink.ts`, `pay.ts`, `machine.ts`, `routes.ts`, and
      `server.ts` moved from `src/api/`. `src/api/` is gone.
    - `skill.md`, `llms.txt`, `PAYLINK.md`, `HOSTING.md`.
  - **Readers and pages:** `src/main.ts` starts the readers, the pages, or both. The config gains
    `PUBLIC_URL` and `CURRENCIES_FILE`, and the seed is optional for the pages.
  - **Escrow fit:**
    - `src/chain/escrow.ts` maps `Created` (with `creator`, `arbiter`, `timer`), `Funded`,
      `Ended` and `Closed`, and ignores `RecoveredLate` and `RentSwept`.
    - `src/chain/poll.ts` stores them.
    - `migrations/002_pages.sql`: receipts gain `creator`, `arbiter`, `timer_days` and `timer_to`,
      and lose `accepted_at` and `locked`; plus `index_meta`.
    - `src/scores/compute.ts` and `run.ts`: the evidence rule above.
    - `SCORING.md`: the evidence table, the `market/role` scope, and how the pages show scores.
  - **Tests, 29, all passing here:**
    - `test/scoring.test.ts` (8, evidence rewritten for the new escrow, `/` scopes and default
      roles) and `test/sign.test.ts` (4).
    - `test/pages.test.ts` (1 test, 8 steps) over `test/fixture.ts`: part one's story (Ana, Ben,
      Cleo; two offers, one under an alias, one with a timer; three badges, Cleo's for an
      undeclared key; one invoice paid in one tap; three reviews) written into a fresh database.
      Records go through part one's own `applyRecordOp` and scores come from the real recompute.
      It checks all six things asked for, plus the Pay link's round trip and its `check`
      (`matches`, `changed`, `differs`, `notFound`, `invalid`).
    - `test/e2e.test.ts` (1 test, 7 steps), moved to the new escrow client and the twins. Ana
      invoices Ben; Ben pays and releases in one transaction. The scores are the same as part
      one's (Ben 1.618, Ana 1.618 − 0.0025); both signatures verify from the served JSON; the
      receipt says `creator: seller`, `releasedToSeller` and no funding mark. **Run here**, not
      only type-checked.
  - `npm run check` is clean (it failed on `main`).
- **Verified:**
  - `npm test`, 29 of 29, three full runs after the last fix; about 30 s, 19 of them three
    registration proofs.
  - The page tests alone, 15 runs in a row.
  - Readers and pages as two separate processes on one database: the readers wrote the keys, and
    the pages, holding no seed, served them in `/index.json`.
  - The vocabulary extractor, run against the network, gives the vendored file byte for byte.
- **Learned:**
  - **Parallel sessions can break each other through the merge order.** Part one merged against
    the old escrow client; the escrow rewrite merged after it. Nothing ran the index's
    type-check, so `main` carried an index that didn't compile. Each package's own check isn't
    enough; the consolidation session (or a CI job) should run every package's `check` after each
    merge.
  - **pg's pool resolves `end()` before its sockets close.** A test that then drops its database
    `with (force)` sometimes kills a closing connection, which reports an error nobody listens for:
    about 1 run in 12 here. Waiting for `pg_stat_activity` to empty first fixed it (15 of 15). Part
    one's end-to-end test had the same race; fixed the same way.
  - **schema.org has no rating or review on a Person.** `itemReviewed` takes any Thing, so
    standalone `Review` and `AggregateRating` nodes are how a person-to-person marketplace says it
    in valid schema.org. `recipient` is not a `MoneyTransfer` property; `PayAction` has it.
  - **The whole end-to-end test runs on a fresh machine of this kind** (setup not timed) after:
    - the Solana CLI 4.2.2 from Anza's installer;
    - `cargo build-sbf` for both programs. The escrow build came out at 311,680 bytes, the size
      the escrow session logged;
    - `host/build.sh`;
    - `npm run fetch` for the proving files.
  - **Node's `en-GB` dates now write "Sept",** not "Sep".
  - **An invoice paid in one tap is two transactions** the index sees (the create, then
    pay-and-release), and no funding mark: the ending alone proves the payment.
- **Open** (questions for Carlos; not decided here):
  1. **Does a seller's signature on the way out count as the seller saying yes?** A split needs
     both signatures, and a release back to the buyer is signed by the seller. Today, on a
     buyer-created escrow, both still count half until the seller reviews, because the handoff
     names only "created the escrow or reviewed the deal".
  2. **The 1 to 5 rating made from trust.** Is putting trust on schema.org's scale acceptable, or
     should machines get only the raw trust and counts? It is trust alone, never blended with
     uniqueness.
  3. **Address logs at the hosting platforms.** The index logs no visitor address, but Railway's
     HTTP logs and Vercel's request logs are the platforms' own. What they record about a visitor,
     and whether it can be turned off, was not checked, and must be before any deploy ("No address
     logs").
  4. **Which apps open a Pay link.** An https link at forest.foundation opens in a browser. For an
     app to take it directly, the domain must list that app (Apple's and Android's app-link files),
     much like the passkey's related-origins file. Which apps the foundation lists, and on what
     rule, is Carlos's call. Until then, a person opens the link in their app by hand.
  5. **The index claims forest.foundation's root.** The pages live at `/`. The passkey's
     `/.well-known/webauthn` (related origins), and any app-link files, must be served by the same
     deployment or routed around it.
  6. **Languages.** "Global from day one" and English-only pages. Which languages, and whether a
     page follows the reader's browser or its own URL.
  7. **Photos.** A profile's photo is a blob on its own host. Showing it means linking to that host
     (which then sees each visitor's address) or the index fetching and serving it. Not shown yet.
  8. **A plain `market` badge and `market/role` badges both count.** One human can hold
     `online-tutors`, `online-tutors/seller` and `online-tutors/buyer`: three badges in one market.
     Should a plain `market` scope count when the market has roles? This is the `markets` repo's
     call, or Carlos's.
  9. **Scale:**
     - a profile page lists every review;
     - the sitemap is one file;
     - offers are ranked with correlated subqueries;
     - every page is computed per request behind a 30-second cache;
     - the pool is 10 connections, where a serverless instance wants 1 (HOSTING.md).

     All fine at test size; each is later work.
  10. **The read skill's examples are test data.** Swap them for real ones once a real market has
      profiles.
  11. **The market page's "verified real people" count includes buyers' badges.** It counts every
      counted badge in the market, not only sellers'.
  12. **Part one's open questions stand,** except the trust scale (Open 4 there), answered for now
      by showing counts beside the number.

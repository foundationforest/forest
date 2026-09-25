# Markets v1: shapes and index (2026-09-25)

A parallel session. It owns `shapes/`, `index/` and `.github/`, and edits nothing else. Carlos asked for four things:

- the new market template;
- the review and post shapes;
- the index to match;
- the checks to build both programs in the newer format (SBPF v3).

The `markets` repo is being rewritten to the same schema at the same time, so the schema here comes from Carlos's text, not from that repo.

## Decided (by Carlos; built here)

In the task:

- **The market file:**
  - The keys are exactly `name`, `folder`, `description`, `sides` (`two` or `one`), `labels`, `money`, `evidenceTypes`, `offerFields`, `reviewFields`, `ratings` and `howDealsGo`.
  - `labels` is optional and two-sided only. `reviewFields` is optional. `ratings` always includes `overall`.
  - Roles come from sides: `seller` and `buyer`, or `peer`.
  - `roles`, `credentialIssuers`, `category` and `fields` are gone, and with `fields` the profile fields go too.
- **A review:** `ratings` is a map of names to 1.0 to 10.0, and `media` is a list of photos and short videos. Only `subject` is required.
- **A post:** `location` is `{ lat, lon, precisionKm, area }`.
- **The index:**
  - folders in place of categories;
  - a badge counts only under a role its market's sides allow;
  - a rating (the weighted `overall`, 1.0 to 10.0) beside standing, on every page, twin and structured data;
  - `near=lat,lon&km=N`;
  - the escrow options in one sentence, with a flag;
  - the market's labels on pages.
- **CI:** build as SBPF v3; keep an old-format build only if something needs it.

In planning:

1. **Decimals in records are text:** `"8.5"`, `"38.72"`, as `price.amount` already is.
2. **Standing is today's trust score renamed**, and its algorithm is unchanged. It is renamed everywhere, the signed statement's `kind` word included.
3. **`price` is optional on a post.** The validator requires it only when the market file says `money` is true.
4. **No aliases anywhere.** The index no longer reads the Aliases table: a market is its one name.
5. **Any rating name.** A review may use any rating name. The file's `ratings` only suggests; nothing is refused for a name outside it.
6. **Exact points are allowed.** `lat` and `lon` take up to 4 decimals, and `precisionKm` runs from 0 (exact, for a shop or a venue) to 20000. The app rounds.
7. **A review's market is its subject profile's market**, the one scope that profile lives in. The review gets no new field.

## Chosen, not decided

Each is the simplest reading, and each is reversible; nothing is deployed.

- **The market file:**
  - `description` is required, because the text marked only `labels` and `reviewFields` optional. It stays one line of at most 300 characters.
  - `labels` is exactly `{ seller, buyer }`, one line of at most 64 characters each, and is refused on a one-sided market.
  - `ratings` names are camelCase, at most 64 characters, like field names.
  - `howDealsGo` is non-empty text of at most 3000 characters, and may span lines.
- **The review:**
  - A rating name is 1 to 64 characters and must not start with `$`, which atproto reserves.
  - `media` holds at most 10 blobs: `image/png`, `image/jpeg` or `video/mp4`, at most 50 MB each.
- **The post:**
  - All four location keys are required inside `location`.
  - `precisionKm` is a whole number of kilometres.
- **The validator checks a blob's type and size** against its lexicon's `accept` and `maxSize`: a review's media, and a profile's photo too. The lexicon library checks neither (see Learned).
- **The signal from `overall`** is `(overall − 5.5) / 4.5`: 10 is +1, 5.5 is 0, 1 is −1. It is the straight-line version of the old stars (5 was +1, 3 was 0, 1 was −1). The golden-ratio worked example stands with overalls of 10 and 1.
- **The rating** averages `overall` over the reviews standing counts, weighted by reviewer weight × evidence weight, the weights standing uses. When no counted review gives an `overall`, there is no rating (not zero).
- **The rating is signed** like every score, as a third kind: code 3, value in millionths. Standing keeps trust's code 2.
- **A profile's market** is the one market its counted badges name, or none when they name zero or more than one. The index reads it from the last recompute's uniqueness rows.
  - It gives a review its market's `reviewFields`, shown on the review.
  - It gives a receipt page its labels, through the seller's profile.
- **JSON-LD:**
  - The profile's `AggregateRating` is the rating, with `bestRating` 10.
  - Each `Offer` also carries its seller's `aggregateRating`, and standing as a `PropertyValue` named `standing`. schema.org gives a Person neither.
  - The trust-squashed 1-to-5 rating is gone.
- **The options sentence:**
  - The wording: "No arbiter, no timer."; "Money goes back to the {buyer} after N days automatically."; "Money goes to the {seller} after N days automatically."; "An arbiter may decide how the money is split." Two options are joined with a semicolon.
  - On an offer, "the arbiter is one of the two sides" means the arbiter is the poster's declared key, since the other side is unknown until someone pays. On a receipt, it means the arbiter is the buyer or the seller.
  - Every offer shows the sentence, including an offer in a no-money market ("No arbiter, no timer.").
- **`near`:**
  - It is a haversine in plain SQL, measured to the post's own rounded point.
  - Offers that name no point are left out.
  - `km` must be above 0 and at most 20000; a malformed `near` or `km` answers 400.
  - A market page filtered by `near` is `noindex` and is not in the sitemap.
- **Smaller changes:**
  - The pay page's check gains `noPrice`.
  - The migration deletes old `trust` rows so the next recompute signs them afresh as `standing`.
  - `@atproto/syntax` leaves `shapes/`: it only checked `credentialIssuers`.
- **What pages show of a review:** its ratings, its review fields, and a count of photos and videos. The photos themselves are not shown, which is the same open question as the profile photo.

## Built

- **`shapes/`:**
  - Lexicons:
    - `post`: `price` optional, and `#location`.
    - `review`: `ratings`, an object that declares `overall`; `media`.
  - `validate.js`:
    - the market template: the eleven keys, sides, labels, money, ratings, howDealsGo, and both field blocks;
    - the rating and degree rules;
    - the blob rules;
    - price required when a market has money;
    - review fields merged from the market passed in.
  - Examples:
    - the online-tutors market in the new schema, with labels tutor and student and a `sessions` review field;
    - a review with `ratings` and `sessions`.
  - `README.md`, and 48 tests.
- **`index/`:**
  - The directory: folders, sides, labels, no aliases. The migration `004_markets_v1.sql`.
  - The store: location and optional price; `overall`.
  - Scores: standing and the signed rating.
  - Pages and twins:
    - folders; two numbers; options and flag; labels;
    - `near`; how deals go; no price and no Pay link in a no-money market;
    - review ratings, fields and media;
    - JSON-LD.
  - The test markets repo gains a one-sided, no-money market, `learning/language-exchange`.
  - The fixture gives Ben a priceless peer offer with a place and a `language-exchange/peer` badge. Ana's Spanish offer has a timer to the buyer.
  - Tests:
    - page test 9 covers two numbers, the options and the flag, labels, near in and out, no price, and review fields;
    - scoring tests cover the rating, the signal and peer badges;
    - the sign test covers the new kinds.
  - `e2e.test.ts` is updated.
  - Docs: `SCORING.md`, `README.md`, `skill.md`, `llms.txt` and `PAYLINK.md`.
- **`.github/workflows/checks.yml`:**
  - The programs job builds both programs with `--arch v3` and fails unless each `.so` says SBPF v3.
  - The fuzz job rebuilds only the escrow, as v0, for Trident (see Learned).

## Learned

- **AT Protocol refuses fractional numbers when it encodes a record**: "Non-integer numbers (1.5) are not supported by the AT Data Model", from `@atproto/lex-cbor`.
  - `@atproto/lexicon`'s check lets a float through in an undeclared or `unknown` field.
  - It also takes an array where an object is declared.
  - So the validator checks every rating value itself, and refuses an array for `ratings`.
- **`@atproto/lexicon` checks only that a blob is a blob**, not its `accept` or `maxSize`. The host checks nothing for a collection it has no lexicon for.
- **The host test writes `shapes/examples/review.json` to a real host**, and a host refuses a record that points at a blob it does not hold. So the examples carry no `media`; the shapes test builds its own.
- **SBPF v3, run here on this session's v3 builds:**
  - Both LiteSVM suites pass: registry 48 and escrow 52.
  - The registry property test passes: 100 iterations, 4,000 flows.
  - The validator tests of the registry client, the escrow client and the issuer pass, each 1 of 1 with none skipped.
  - The fee payer's local test passes (Kora 2.0.5 in front of a validator), 1 of 1.
  - The index's whole `npm test` passes, the end-to-end test included: 39 of 39, none skipped.
  - The host's `test.sh` passes: its jest suites, and 7 of 7 of its own tests, which write the new shapes examples.
  - The carrier's test was not run here: it reads only the profile and post examples, which did not change, and it needs the relay built.
  - The v3 builds' sha256: registry `c33310b7…`, escrow `53f32c43…`.
- **Trident 0.12 runs only v0 programs.**
  - Its runtime (trident-svm 0.2.0, on solana-svm 2.3.13) starts with `SVMFeatureSet::default()`, every feature off.
  - With the v3 escrow, 1,952 of 2,000 iterations broke invariant I7 on `create` ("model says true, program said false").
  - The same seed (`c76897c2…`) on a v0 build of the same source broke nothing.
  - That is the one old-format build kept.
- **Trident prints its failures through its progress bar**, which says nothing without a terminal. In CI a broken invariant shows only as exit 99, with no message; `script -qec '…' /dev/null` shows them.

## Open

1. **The handoff and `docs/changes.md`, for the consolidation session:**
   - Sections to update:
     - Record shapes: review `ratings` and `media`; the post's `location` and optional `price`;
     - Markets: the template, folders, sides, no aliases;
     - Reputation: rating and standing, three scores;
     - the Index paragraph;
     - Build status: CI builds v3, and the fuzzer uses v0.
   - Handoff Open items this answers or changes:
     - "Whether a market file keeps `credentialIssuers`": it does not;
     - "The 1 to 5 rating machines get": replaced by the rating, out of 10;
     - "CI builds v0": done;
     - "A review with no rating counts as neutral": still so, now "no `overall`".
   *Mechanical.*
2. **The `markets` repo must match**:
   - the eleven keys, spelled as above;
   - the directory line format this index reads, ``- [`name`](folder/name.json): …``, with the file at `<folder>/<name>.json`;
   - its Aliases table is no longer read.

   Any file that differs is refused by the index, with the reason in `Directory.refused`. *Mechanical,* in that repo.
3. **A profile badged in two markets lives in no one market.** Its reviews get no review fields, and its receipts no labels. Does a profile's one scope get enforced, or chosen by the profile? *Needs Carlos.*
4. **The validator cannot tell whether a point was rounded.** An app that writes a home at `precisionKm` 0 publishes the address. Should apps, or the validator, warn about an exact point that is not a shop or venue? *Needs Carlos.*
5. **`video/mp4` in `media`** sits against CLAUDE.md's "video hosting out of scope for v1". A host that takes a review's video is hosting it, and the host's blob upload limit decides in practice. *Needs Carlos.*
6. **Fuzzing tests the old format.** The escrow fuzzer runs a v0 build of the same source, not the v3 format devnet runs. A Trident with v3 enabled, or with a settable feature set, closes the gap. *Mechanical.*
7. **The security checklists** (`escrow/security-checklist.md` item 13, and `registry/security-checklist.md`'s framework line) still describe v0 as the build. They are outside this session's folders. *Mechanical.*
8. **An offer in a no-money market still says "No arbiter, no timer."** The ask says every offer carries its options, but there no escrow is made. *Needs Carlos,* if it should say nothing there.
9. **`near` scans every live offer in the market**, with no index on the point: fine at this size. *Mechanical,* later.

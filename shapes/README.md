# shapes

The four record shapes every Forest market shares, as AT Protocol lexicons, plus a validator.

- `lexicons/foundation/forest/`: `profile`, `post`, `review`, `credential`. Namespace `foundation.forest.*`.
- `src/validate.js`: checks a record against its lexicon, and checks a market file against the rule "market files add fields, never new shapes". Uses `@atproto/lexicon` unchanged.
- `bin/validate.js`: the command line for the same two checks.
- `examples/`: one record of each shape, and `markets/online-tutors.json`, a test fixture. Canonical market files live in the `markets` repo.
- `test/`: runs the validator on the examples and on things it must reject.

```
cd shapes
npm install
npm test
node bin/validate.js record examples/post.json --market examples/markets/online-tutors.json
node bin/validate.js market examples/markets/online-tutors.json
```

A post may carry a `terms` block, fully optional, on an offer or a request. It holds only the options an escrow made from the post is created with, each off unless set: `arbiter`, a Solana key that may decide any split, and `timer`, `{ days, to }`: that many whole days after funding, everything goes to `to`, which is `seller` or `buyer`. With no terms, the only ways out of an escrow are the ones the two sides sign. The post's `price` names its token by `mint`, the token's address on Solana: any classic token works, and which tokens an index weighs is the index's call. `price` is optional in the shape; checked against a market file, it is required when the file says `money` is true.

A post's `remote` and `location` are both optional: a post may say it happens online, name a place, or say neither. A `location` is `{ lat, lon, precisionKm, area }`, all four required inside it:

- `lat` and `lon` are degrees as decimal text, at most four decimals (`"38.72"`, `"-9.14"`). A record holds no fractional numbers: AT Protocol's encoding refuses them, so decimals are text, as a price's amount is.
- `precisionKm` is how far, in whole kilometres from 0 to 20000, the point may be from the real place. The app rounds the point to it before writing. 0 is an exact point, for a shop or a venue. Nothing here can tell whether a point was rounded.
- `area` is the place in words.

A review requires only `subject`, the DID it is about (and `createdAt`, as every record has): a review can be as thin as pointing at a person. Everything else is optional; what is missing weighs less, and nothing is refused for it.

- `ratings` is a map of names to ratings, each decimal text from 1.0 to 10.0 with at most one decimal (`{ "overall": "8.5", "patience": "10" }`). Any name may be used (1 to 64 characters, not starting with `$`); `overall` is the one every index reads, by convention.
- `text`.
- `media`: up to ten photos and short videos (`image/png`, `image/jpeg`, `video/mp4`, at most 50 MB each), as blob references.
- `dealId` is the deal the review is about: the escrow's address (base58, 32 bytes) when an escrow exists, else 32 random bytes as lowercase hex, chosen when the deal began. The validator refuses a `dealId` that is neither, since it points at nothing.

A review names no market. Its market is the market of the profile it is about, which lives in one scope (`market/role`); an app passes that market's file to check the review against it.

A market file has nine required keys and two optional ones. Nothing else belongs in one:

- `name`, the market's spelling, a lowercase slug. Anyone can use any market name; the `markets` repo lists the spellings the foundation recommends.
- `folder`, where the file sits in the `markets` repo's directory (`<folder>/<name>.json`), a slug. Folders group markets for reading; they are never a program concept.
- `description`, one line of text, at most 300 characters.
- `sides`, `two` or `one`. A market's roles come from it: `seller` and `buyer` when two, `peer` when one. The recommended badge scope is `market/role`, such as `online-tutors/seller`.
- `labels`, optional, only when `sides` is `two`: `{ "seller": …, "buyer": … }`, the plain words pages use for the two sides (`tutor`, `student`). A label is a word, not a role: posts and badges still say `seller` and `buyer`.
- `money`, true or false: whether deals in this market are paid. When true, a post in it must carry a price.
- `evidenceTypes` lists the evidence that applies to deals in this market (`escrow` is the one defined so far). It is metadata for indexes, which weigh a deal by the evidence under it; it never makes a record invalid.
- `offerFields`, the extra fields a post in this market carries, and `reviewFields`, optional, the extra fields a review of a profile in it carries: each `{ properties, required }`, flat fields (string, integer, boolean, or an array of those) in lexicon field syntax. A market may mark its own fields required. It cannot add a shape, nest anything, or redefine a base field.
- `ratings`, the rating names a review in this market usually carries, `overall` always among them. It suggests; a review may use other names too.
- `howDealsGo`, plain text on how deals in this market usually go, at most 3000 characters.

A market file restricts no deal: the arbiter, the timer, the token and the amount are the seller's, per offer. With a market file the validator checks a post's market name, that its role is one the market's sides allow, its offer fields, and its price when the market has money; and a review's review fields. It checks a market file's structure, nothing more.

Design choices made here without a decision behind them are logged in `docs/changes.md` as "chosen, not decided".

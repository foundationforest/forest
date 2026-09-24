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

A post carries a `terms` block, required on an offer: `autoReleaseDays` (after the clock starts, the money goes to the seller unless the buyer has objected), up to four `cancellationSteps` of `{ hours, refundPercent }` (hours from the clock start, negative before the service time; deadlines strictly rising, none after auto-release), and an optional `arbiter` key. An escrow is created from these terms, as the seller set them for this offer. The post's `price` names its token by `mint`, the token's address on Solana: any classic token works, and which tokens an index weighs is the index's call.

A review requires only `subject`, the DID it is about (and `createdAt`, as every record has): a review can be as thin as pointing at a person. `rating` (1 to 5), `text` and `dealId` are optional; what is missing weighs less, and nothing is refused for it. `dealId` is the deal the review is about: the escrow's address (base58, 32 bytes) when an escrow exists, else 32 random bytes as lowercase hex, chosen when the deal began. The validator refuses a `dealId` that is neither, since it points at nothing.

A market file has exactly seven keys: `name`, `category`, `roles`, `fields`, `evidenceTypes`, `suggested`, `credentialIssuers`.

- `category` names the deal shape, how money, time and evidence flow: `home-services`, `freelance-work`, `buy-and-sell`. Any slug passes; a later category is a new file in the `markets` repo, not code.
- `evidenceTypes` lists the evidence that applies to deals in this market (`escrow` is the one defined so far). It is metadata for indexes, which weigh a deal by the evidence under it; it never makes a record invalid.
- `suggested` holds starting values for an offer's terms, `{ autoReleaseDays, cancellationSteps }`, which an app offers a seller and the seller changes freely.
- Under `fields` it may add flat fields (string, integer, boolean, or an array of those) to `profile`, `post`, or `review`, in lexicon field syntax, and may mark its own fields required. It cannot add a shape, add to a credential, nest anything, or redefine a base field.

A market file restricts no deal. There is no arbiter rule, no token list and no fixed auto-release: the arbiter is always available, any token works, and the auto-release days and cancellation steps are the seller's, per offer. With a market file the validator checks only that a post uses the market's name and one of its roles. It checks a market file's structure, and nothing enforces a market file's values on a deal.

Design choices made here without a decision behind them are logged in `docs/changes.md` as "chosen, not decided".

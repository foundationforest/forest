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

A post may carry a `terms` block, fully optional, on an offer or a request. It holds only the options an escrow made from the post is created with, each off unless set: `arbiter`, a Solana key that may decide any split, and `timer`, `{ days, to }`: that many whole days after funding, everything goes to `to`, which is `seller` or `buyer`. With no terms, the only ways out of an escrow are the ones the two sides sign. The post's `price` names its token by `mint`, the token's address on Solana: any classic token works, and which tokens an index weighs is the index's call.

A post's `remote` and `location` are both optional: a post may say it happens online, name a place, or say neither.

A review requires only `subject`, the DID it is about (and `createdAt`, as every record has): a review can be as thin as pointing at a person. `rating` (1 to 5), `text` and `dealId` are optional; what is missing weighs less, and nothing is refused for it. `dealId` is the deal the review is about: the escrow's address (base58, 32 bytes) when an escrow exists, else 32 random bytes as lowercase hex, chosen when the deal began. The validator refuses a `dealId` that is neither, since it points at nothing.

A market file has five required keys, `name`, `category`, `fields`, `evidenceTypes`, `credentialIssuers`, and two optional ones, `description` and `roles`. Nothing else belongs in one.

- `name` is the market's spelling, a lowercase slug. Anyone can use any market name; the `markets` repo lists the spellings the foundation recommends.
- `category` groups markets for reading, as a folder and a page in the `markets` repo. Any slug passes; categories are never a program concept.
- `description`, optional, is one line of text, at most 300 characters.
- `roles`, optional, are the sides a post in the market can take. Absent, they are `seller` and `buyer`. The recommended badge scope is `market/role`, such as `online-tutors/seller`.
- `evidenceTypes` lists the evidence that applies to deals in this market (`escrow` is the one defined so far). It is metadata for indexes, which weigh a deal by the evidence under it; it never makes a record invalid.
- Under `fields` it may add flat fields (string, integer, boolean, or an array of those) to `profile`, `post`, or `review`, in lexicon field syntax, and may mark its own fields required. It cannot add a shape, add to a credential, nest anything, or redefine a base field.

A market file says nothing about money or time and restricts no deal: the arbiter, the timer and the token are the seller's, per offer. With a market file the validator checks only that a post uses the market's name and one of its roles, and that it carries the market's extra fields. It checks a market file's structure, nothing more.

Design choices made here without a decision behind them are logged in `docs/changes.md` as "chosen, not decided".

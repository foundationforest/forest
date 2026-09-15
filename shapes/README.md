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

A market file has exactly eight keys: `name`, `roles`, `fields`, `silenceDays`, `arbiterAllowed`, `reviewEvidence`, `credentialIssuers`, `tokens`. Under `fields` it may add flat fields (string, integer, boolean, or an array of those) to `profile`, `post`, or `review`, in lexicon field syntax, and may mark its own fields required. It cannot add a shape, add to a credential, nest anything, or redefine a base field.

Design choices made here without a decision behind them are logged in `docs/changes.md` as "chosen, not decided".

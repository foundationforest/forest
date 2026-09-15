# keys

The keys recipe: how a passkey's secret becomes a person's seed, and the seed becomes separate keys and a name per profile, entirely on the device. `SPEC.md` is the recipe in plain words plus exact steps, so any product can open the same seed from the same passkey. `src/` is a small TypeScript library that implements it for browsers and Node from existing parts (Web Crypto, `@atproto/crypto`, `@noble/curves`, `@ipld/dag-cbor`, `@scure/bip39`, `@scure/base`), with the did:plc genesis operation built here and checked in the tests against the directory's own library. `test/` holds fixed test vectors and the tests; `test-page/` is a static page that runs the recipe against a real passkey in a browser. Nothing here talks to a server, except one function that sends a genesis operation to the directory when a caller asks.

```
cd keys
npm install
npm test              # Node 22.18 or later runs the TypeScript tests directly
npm run check         # type-check
npm run build         # emit dist/ for consumers
npm run build:page    # bundle the library for test-page/
```

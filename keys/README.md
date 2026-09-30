# keys

The keys recipe: how a passkey's secret becomes a person's seed, and the seed becomes each profile's key and box key plus one identity and one central wallet per person, entirely on the device. A profile's key is its name (a did:key), its signature and its wallet. `SPEC.md` is the recipe in plain words plus exact steps, so any product can open the same seed from the same passkey. `src/` is a small TypeScript library that implements it for browsers and Node from existing parts (Web Crypto, `@noble/curves`, `@scure/bip39`, `@scure/base`, `age-encryption`, `@semaphore-protocol/identity`). `test/` holds fixed test vectors and the tests; `test-page/` is a static page that runs the recipe against a real passkey in a browser. Nothing here talks to a server.

```
cd keys
npm install
npm test              # Node 22.18 or later runs the TypeScript tests directly
npm run check         # type-check
npm run build         # emit dist/ for consumers
npm run build:page    # bundle the library for test-page/
```

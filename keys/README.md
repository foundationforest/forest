# keys

Devnet only: nothing in this folder is deployed anywhere, and nothing is on mainnet.

Up: [the repo](../README.md). The recipe: [SPEC.md](SPEC.md). A page that runs it against a real
passkey: [test-page/](test-page/README.md).

A passkey on the person's device gives a 32-byte secret. From it come the seed, and from the seed
every key the person uses, on the device, with nothing sent anywhere. Any app that follows SPEC.md
gets the same keys from the same passkey, so a person is never locked into one app.

| Key | One per | Used for |
|---|---|---|
| profile key (ed25519) | profile | The profile's name (its did:key), its signature on every record, and its Solana wallet: one key, three uses |
| box key (age, post-quantum hybrid) | profile | Opening records sealed to the profile |
| identity secret (Semaphore) | person | Badges: its commitment goes to each issuer once; proofs are made from it on the device |
| central wallet (ed25519) | person | Where money meets a ramp, apart from every profile |

## What it promises

- **The same passkey gives the same keys,** on any device, in any app, every time.
- **The keys are unrelated.** Each is its own HKDF output under its own label: none can be computed
  from another, and the seed from none of them.
- **Extra passkeys open the same seed** through a seed file, which tells whoever stores it nothing.
- **The 24 words restore the seed.** They are the only backup, and not a way to sign in.
- **Nothing leaves the device.** The library talks to no network and stores nothing.

## What it trusts

- The passkey provider's PRF extension: the same 32 bytes for the same input, every time, kept
  secret. The passkey belongs to `forest.foundation`; products are listed in its related-origins
  file (SPEC §1).
- Web Crypto: HKDF-SHA256, AES-256-GCM, random nonces.
- Libraries, unchanged: `@noble/curves`, `@scure/base`, `@scure/bip39`, `age-encryption`, and
  `@semaphore-protocol/identity` 4.12.1, the line that matches the registry's setup files.

## Use it

Everything is exported from `src/index.ts`; everything that derives is async.

| Function | Gives |
|---|---|
| `seedFromPrf(prf)` | The seed from the passkey's PRF output. Ask the passkey with `PRF_INPUT` |
| `profileKey(seed, n)` | Profile `n`'s key: `did`, `address`, `publicKey`, `privateKey` |
| `boxKey(seed, n)` | Profile `n`'s box identity, and the recipient its folder record publishes |
| `identitySecret(seed)`, `humanIdentity(seed)` | The person's identity secret; Semaphore's identity and its commitment |
| `centralWallet(seed)` | The person's central wallet |
| `seedFileLabel(prf)`, `wrapSeed(seed, prf)`, `unwrapSeed(file, prf)` | The seed file for an extra passkey |
| `exportWords(seed)`, `importWords(text)` | The 24 words, and back (both sync) |
| `didKey(publicKey)` | The did:key of an ed25519 key (sync) |

```
cd keys
npm ci
npm test             # the pinned vectors, and each step recomputed without the library
npm run check        # type-check
npm run build        # dist/ for other packages
npm run build:page   # the bundle test-page/ loads
```

Node 22.18 or later runs the TypeScript directly. `records/` derives the profile and box keys with
its own code and checks them against the same `test/vectors.json`.

## Limits

SPEC §10 lists what the recipe does not do: no recovery without a passkey or the words, no key
rotation, no way back into an issuer's list once the seed is lost. Beyond it:

- **The tests run in Node.** No test here uses a real passkey; `test-page/` is for trying one by
  hand.
- **No device storage.** Where a seed file is kept is the app's choice; the library only makes and
  opens files.

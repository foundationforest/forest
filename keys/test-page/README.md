# Keys test page

Devnet only: this page runs in a browser and touches no chain.

Up: [keys](../README.md).

A static page that runs the recipe against a real passkey: create a passkey with the PRF
extension, unlock, show profiles 0 and 1 (each one's did:key, wallet address and box recipient),
get the same after a reload, and show the 24 words.

```
cd keys
npm ci
npm run build:page          # writes test-page/dist/forest-keys.js (ignored by git)
npx serve test-page         # or any static server, on HTTPS or http://localhost
```

- **A test passkey.** The page sets no `rp.id`, so the passkey belongs to the page's own origin and
  opens nothing else. The real relying party is `forest.foundation`.
- **Create once, then Unlock.** After a reload, Unlock again: the seed's fingerprint and every key
  must match. The page keeps only the credential id and the last fingerprint in `localStorage`.
- **PRF on `get`, not `create`.** Authenticators do not all return a PRF result at creation, so the
  page never relies on one.
- **A provider with PRF is needed:** iCloud Keychain on iOS 18 and macOS 15 or later, Google Password
  Manager on Android and Chrome, Windows Hello on recent Windows, and hardware keys with
  hmac-secret. A passkey without PRF fails at Create with a message saying so.
- **Nothing leaves the tab.** The name and the wallet address are the same 32 bytes, written two
  ways.

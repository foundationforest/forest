# Keys test page

A static page that exercises the recipe end to end in a real browser: create a passkey with the PRF extension, unlock, show each profile's name (its `did:key`), its wallet address and its box recipient for profiles 0 and 1, reproduce them after a reload, and show the 24 paper words.

Build the library bundle, then serve this folder from any HTTPS origin, or from `http://localhost`:

```
cd keys
npm install
npm run build:page          # writes test-page/dist/forest-keys.js (ignored by git)
npx serve test-page         # or any static server
```

Notes for testers:

- The passkey's relying party is the page's own origin, because the page sets no `rp.id`. The real relying party is `forest.foundation`, with products listed in its related-origins file. A passkey made on this page is a test passkey; it opens nothing else.
- Create once, then Unlock; after a reload, Unlock again. The seed fingerprint and every key must be the same. The page keeps only the credential id and the last fingerprint in `localStorage`.
- PRF is evaluated on `get`, not on `create`: authenticators do not all return a PRF result at creation, and some browsers return none, so the page never relies on it.
- PRF needs a passkey provider that supports the extension: iCloud Keychain on iOS 18 and macOS 15 or later, Google Password Manager on Android and Chrome, Windows Hello on recent Windows, and hardware keys with hmac-secret. A passkey without PRF fails at Create with a clear message.
- The name and the wallet address are the same 32 bytes, written two ways. Nothing leaves the tab; everything runs in memory.
- Checked so far: headless Chromium with a virtual authenticator that supports PRF ran the whole flow, including a reload. Real authenticators on Apple, Android and Windows are still to be tested.

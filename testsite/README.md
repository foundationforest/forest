# Test site

A static site with two test pages. No server, no framework: everything runs in the page. Nothing here is a product, and nothing here is deployed.

- `keys/`: the keys test page from `keys/test-page`, with the same behaviour, plus a footer and a link back. A passkey unlocks a seed, and the seed makes each profile's keys and name.
- `handover/`: an experiment. Can two phones show they were together, in the browser, using only passkeys? The test script for a person is `handover/README.md`.

Both pages use their own origin as the passkey's relying party. In Forest the relying party is `forest.foundation`.

## Put it online

1. In Vercel, add a new project and import this repository.
2. Set **Root Directory** to `testsite/dist`. Leave the framework as "Other". There is nothing to install or build: `testsite/dist/vercel.json` says so.
3. Deploy. Vercel serves the site over HTTPS at its own address. The pages are at `/keys/` and `/handover/`.

Use one address for all tests. Each address is a separate site as far as passkeys are concerned, so a passkey made on a preview address doesn't work on the production one.

Any other static host with HTTPS works the same way: serve `testsite/dist` as it is. Pages need a trailing slash (`/keys/`), because they load their scripts by relative path. `vercel.json` redirects `/keys` to `/keys/`.

## Rebuild

```
bash testsite/build.sh
```

You need Node 22 and npm.

- It installs `keys/`'s dependencies if they're missing.
- It rewrites `testsite/dist/`.
- It bundles the keys library with `keys/`'s own esbuild. The entry and flags are those of `npm run build:page`, plus `--minify` and no source map.
- It copies `keys/test-page/page.js` unchanged, then the site's own files.

Commit `dist/` after a rebuild.

`testsite/dist/` is committed so the site can be put online without a build step. It is an exception in the root `.gitignore`.

To try it on a computer:

```
npx http-server testsite/dist
```

`localhost` counts as a secure origin. Phones need HTTPS.

## What is where

| Path | What |
|---|---|
| `index.html` | links to the two pages |
| `keys/index.html` | `keys/test-page/index.html` with a footer and a link back. Its script, `page.js`, is taken from `keys/test-page` at build time, so it cannot drift |
| `handover/index.html`, `handover/handover.js` | the handover page. Plain JS, no dependencies, no build |
| `handover/README.md` | the test script |
| `vercel.json` | Vercel's config. The build copies it into `dist/`, because Vercel reads it from the root directory it is given |
| `build.sh` | the build |
| `dist/` | the built site |

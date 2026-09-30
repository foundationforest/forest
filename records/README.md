# records

Forest's data layer: signed entries on plain hosts. A profile is one key; everything it says is a
small signed JSON entry; hosts store entries and serve them in the order they took them in; the
newest version counts, and what the owner wrote outranks any delegate. Nothing here is shipped.

| Path | What |
|---|---|
| `SPEC.md` | The protocol, short and exact, with test vectors |
| `schemas/` | The four record shapes as JSON Schemas: `profile`, `offer`, `review`, `proof`, with one example each |
| `src/` | The library: keys, canonical text, entries, the merge, writing, the client, approval requests (the core, `@forest/records`); the reference host (`/host`), an index's reading side (`/indexer`), sealed entries (`/sealed`), Pkarr discovery (`/discovery`), the connections service for assistants over MCP (`/connections`) |
| `web/` | The reference approval page (passkey, show, sign, post), bundled by `web/build.ts`, which also lists the libraries in the bundle |
| `test/` | The tests; `vectors.json` pins the spec's vectors; `test/net/` holds one live test |
| `bench/` | Throughput on one machine |
| `docs/` | The lab's report and research, as written when the design was chosen |

The keys recipe (passkey to seed, seed to each profile's key and box key) is `keys/SPEC.md`. The
profile key is the one `keys/` derives, and the tests check this library's keys against
`keys/test/vectors.json`.

The approval page's bundle holds code from four libraries: `@noble/curves`, `@noble/hashes`,
`@scure/base` and `canonicalize` (`web/dist/approve.deps.txt` after a build).

## Run

Node 22.18 or later (TypeScript runs as is). The browser test uses Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or `CHROME_PATH`; without it that test
skips.

```
cd records
npm ci               # also builds dist/
npm run check        # tsc
npm test             # everything local, browser and MCP included
npm run test:net     # live: a fresh key's host list on public Pkarr relays
npm run bench        # throughput
node test/vectors.ts # print the spec's vectors
```

`npm test` runs on loopback: two or three hosts, a connections service, a stand-in Pkarr relay,
and a page server, each started and stopped by the tests. Nothing is published anywhere.
`npm run test:net` publishes one packet for a random key to relay.pkarr.org and reads it back
there and from pkarr.pubky.org and pkarr.pubky.app.

## Depend on it

`@forest/records` is a package with its own entry points, each built to `dist/` with types:
`@forest/records` (the core, which needs no server, database or encryption library),
`/host`, `/indexer`, `/sealed`, `/discovery`, `/connections`, and `/schemas/<kind>.json`.

- From a checkout: `npm install ../forest/records` links it (run `npm ci` in `records/` first).
- As a copy: `npm pack` in `records/` builds and packs it; install the tarball.

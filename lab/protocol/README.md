# lab/protocol

A lab prototype of Forest's data protocol: signed entries on plain hosts. Exploration only;
nothing here is shipped, and nothing outside this folder depends on it.

| File | What |
|---|---|
| `REPORT.md` | The recommendation, in plain words first; the comparison; the attacks; open questions |
| `SPEC.md` | The protocol, short and exact, with test vectors |
| `RESEARCH.md` | What exists (Nostr, AT Protocol, Farcaster, Pubky, Pkarr, DWN, Willow, UCAN, Keyhive, MLS, HPKE, age, DIDs, WebAuthn PRF, MCP, agent payments), with sources |
| `src/` | keys, canonical text, entries, the merge, writing, the host, the client, the index, sealed entries, discovery, approval requests, the connections service (MCP) |
| `web/` | The approval page (passkey, show, sign, post), bundled by `web/build.ts`, which also lists the libraries in the bundle |
| `test/` | 81 tests; `vectors.json` pins the spec's vectors; `test/net/` holds one live test |
| `bench/` | Throughput on this machine |

The approval page's bundle holds code from four libraries: `@noble/curves`, `@noble/hashes`,
`@scure/base` and `canonicalize` (`web/dist/approve.deps.txt` after a build).

## Run

Node 22.18 or later (TypeScript runs as is, like `keys/`). The browser test uses Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or `CHROME_PATH`; without it that test
skips.

```
cd lab/protocol
npm ci
npm run check        # tsc
npm test             # everything local, browser and MCP included (about 20 seconds)
npm run test:net     # live: a fresh key's host list on public Pkarr relays
npm run bench        # throughput
node test/vectors.ts # print the spec's vectors
```

`npm test` runs on loopback: two or three hosts, a connections service, a stand-in Pkarr relay,
and a page server, each started and stopped by the tests. Nothing is published anywhere.
`npm run test:net` publishes one packet for a random key to relay.pkarr.org and reads it back
there and from pkarr.pubky.org and pkarr.pubky.app.

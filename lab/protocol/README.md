# lab/protocol

A lab prototype of Forest's data protocol: signed entries on plain hosts. Exploration only;
nothing here is shipped, and nothing outside this folder depends on it.

| File | What |
|---|---|
| `REPORT.md` | The recommendation, in plain words first; the comparison; the attacks; open questions |
| `SPEC.md` | The protocol, short and exact, with test vectors |
| `RESEARCH.md` | What exists (Nostr, AT Protocol, Farcaster, Pubky, Pkarr, DWN, Willow, UCAN, Keyhive, MLS, HPKE, age, DIDs, WebAuthn PRF, MCP, agent payments), with sources |
| `src/` | keys, canonical text, entries, the merge, writing, the host, the client, the index, sealed entries, discovery, the approval logic, the MCP door |
| `web/` | The approval page (passkey, sign, publish), bundled by `web/build.ts` |
| `test/` | 77 tests; `vectors.json` pins the spec's vectors |
| `bench/` | Throughput on this machine |

## Run

Node 22.18 or later (TypeScript runs as is, like `keys/`). The browser test uses Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or `CHROME_PATH`; without it that test
skips.

```
cd lab/protocol
npm ci
npm run check        # tsc
npm test             # everything, browser and MCP included (about 20 seconds)
npm run bench        # throughput
node test/vectors.ts # print the spec's vectors
```

Everything runs on loopback: two or three hosts, a door, a stand-in Pkarr relay, and a page
server, each started and stopped by the tests. Nothing is published anywhere.

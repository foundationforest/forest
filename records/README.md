# records

Devnet only: nothing in this folder is deployed anywhere, and nothing is on mainnet.

Up: [the repo](../README.md). The protocol: [SPEC.md](SPEC.md). The record shapes:
[schemas/](schemas/). The keys it signs with: [keys/](../keys/README.md).

A profile is one key. Everything the profile says is a record: a small signed JSON value at a path
such as `profile`, `offer/<id>` or `review/<id>`. Boards keep records and serve them in the order
they took them in. A reader checks every signature itself, reads every board the profile names,
and merges what it finds. At each path the newest version counts, and what the owner signed
outranks anything a delegate signed.

The spec and the code say *host* for a board and *entry* for one signed version of a record.

## What it promises

- **A record checks the same wherever it comes from.** One canonical spelling (RFC 8785 over a
  narrowed JSON), strict Ed25519, a size cap of 65,536 bytes. A board cannot forge or change a
  record; it can only withhold it.
- **Every reader computes the same view.** The merge is a pure function of the feeds read and the
  reader's clock (SPEC §5): two readers with the same feeds agree.
- **The owner comes first.** A delegate never overwrites a path the owner wrote, never writes the
  folder record or a permission, and cannot pass a permission on.
- **Permissions are off by default.** Nobody can write for a profile unless the person approves a
  permission (a grant). Taking it back ends it from then on; what it published before stays.
- **A person can always leave a board.** A board must take a newer folder record for any profile it
  holds or held, so it can never lock anyone in.
- **A board holds nothing secret.** No keys, no accounts, no login, and it must not log network
  addresses. It cannot read a sealed record: it sees that one exists, its path, time and size, and
  how many readers it has.

## What it trusts

- **Readers trust boards for order and presence, never content.** Arrival order decides only
  whether a delegate's record came in before or after a permission changed. A board that withholds
  records is routed around by reading the profile's other boards, or the app's own copies.
- **Boards trust signatures.** What counts as badged, for a board's policy and
  its `badged=1` feed, is its operator's choice, by design: the reference board takes an
  `isBadged` function (a registry lookup against the issuers the operator trusts, say), and
  without one counts no profile as badged.
- **The approval page trusts the device:** its passkey for the seed, its browser for the page. The
  boards a request names are hints; the page posts to the boards the profile's signed folder record
  names.
- **Pkarr is a hint.** The folder record decides. `checkPayload` checks a packet's signature itself,
  since the official client's `SignedPacket.fromBytes` does not.
- **Libraries, unchanged:** `@noble/curves`, `@noble/hashes`, `@scure/base` and `canonicalize` (the
  core and the approval page); `age-encryption` (sealed records); `@synonymdev/pkarr` (discovery);
  `@modelcontextprotocol/server` and `zod` (connections); Node's built-in `node:sqlite` (the board).

## Use it

`@forest/records` is a package with six import paths, each built to `dist/` with types:

| Import | What it gives |
|---|---|
| `@forest/records` | Profile keys and did:key names; canonical text; signing, checking and encoding records; the merge (`viewProfile`, `viewAll`, `liveContent`); writing (`ownerEntry`, `delegateEntry`, `folderEntry`, `grantEntry`, `revokeEntry`, `nextTime`); talking to boards (`publish`, `readPage`, `readAll`); approval requests (`requestLink`, `requestFromLink`, `describe`, `approve`, `isPublished`). Needs no server, database or encryption library |
| `@forest/records/host` | `Host`, the reference board: one SQLite file, `POST` and `GET /v1/entries` |
| `@forest/records/indexer` | `Index`: follows boards, crawls the boards folder records name, merges. No ranking |
| `@forest/records/sealed` | `boxKey`, `seal`, `open`, `readerCount` |
| `@forest/records/discovery` | Pkarr packets: make, check, publish and resolve a profile's boards; `Relay`, a stand-in relay for tests |
| `@forest/records/connections` | `Connections`: the MCP service for assistants, with `forest_read` and `forest_draft` |
| `@forest/records/schemas/<kind>.json` | The four shapes, as JSON Schemas |

Publish a profile with one offer, and read it back:

```ts
import { folderEntry, ownerEntry, profileKey, publish, readAll, viewProfile } from '@forest/records'

const me = profileKey(seed, 0) // seed from keys/; me.did is the profile's name
const now = Date.now()
await publish([board], [
  folderEntry(me, { hosts: [board] }, now),
  ownerEntry(me, 'offer/maths', { direction: 'offer', description: 'One hour of maths, online.', createdAt: new Date(now).toISOString() }, now),
])
const { versions } = await readAll(board, { profile: me.did })
const view = viewProfile(me.did, [versions], Date.now())
view.current.get('offer/maths')?.entry.body
```

`web/` is the reference approval page: the one place a person's seed is opened, to sign one request
after one tap and a passkey. `npm run build:page` bundles it into `web/dist/`, with the bundle's
SHA-256 and the list of libraries in it.

```
cd records
npm ci                 # also builds dist/
npm run check          # type-check
npm test               # everything local, on loopback: boards, the MCP service, the page in Chromium
npm run test:net       # live: one packet for a random key on public Pkarr relays
npm run bench          # throughput on this machine
node test/vectors.ts   # print the spec's test vectors
```

Node 22.18 or later. The browser test uses `CHROME_PATH`, or
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; without either it skips. To depend on the
package from another checkout, `npm install ../forest/records` (after `npm ci` here), or install the
tarball `npm pack` makes.

## Limits

- **The reference board is a reference.** One process, one SQLite file, listening on `127.0.0.1`
  unless told otherwise; TLS is the operator's. It forgets old versions only when its operator calls
  `prune()`, and asks `isBadged` again only on each write or on `refreshBadges()`.
- **Checking signatures is slow here.** Pure JavaScript checks about 340 a second on one core. A
  board or index under load should verify in native code with the same strict rules (SPEC §7).
- **No blobs.** Records name photos and media by SHA-256; how those bytes are stored and served is
  not specified, and nothing here stores them.
- **No Pkarr publishing.** `discovery` makes and checks packets; nothing here publishes or
  republishes them on a schedule.
- **The approval page finds profiles 0 to 15 only,** and keeps a copy of what it signed in the
  browser's `localStorage` (`forest.entries`).
- **Sealed records have no forward secrecy.** A box key that leaks opens everything ever sealed to
  it, and a reader taken off keeps what it already opened.
- **The MCP service is a reference too:** it listens on `127.0.0.1`, has no login, and holds nothing.

# records

Devnet only: nothing in this folder is deployed anywhere, and nothing is on mainnet.

Up: [the repo](../README.md). The protocol: [SPEC.md](SPEC.md). The record shapes:
[schemas/](schemas/).

## What it is

How a Forest profile says things, and how anyone reads them. A profile is one key. Everything the
profile says (its card, its offers, its reviews of others) is a record: a small signed JSON value
at a path in the profile's folder, such as `profile`, `offer/maths` or `review/7`. Hosts keep
records and serve them to anyone. Any app, index or AI can read them, and checks every signature
itself.

This folder holds the protocol, a library that follows it, a reference host, the three record
shapes, tests and test vectors.

## How it works

```
seed ── "forest/v1/profile/tutoring/seller" ──▶ profile key ── "forest/v1/read" ──▶ reading key
                                                    │
                                          signs every record
                                                    ▼
app ── POST /v1/records ──▶ the hosts its hosts record names ── GET /v1/records ──▶ any reader
```

1. **Keys.** A person's seed makes one profile key per label, such as `tutoring/seller`. The key's
   base58 address is the profile's name. From the profile key comes its reading key, for private
   records. Nothing else is needed: no account, no sign-up, no directory.
2. **Records.** The app signs each record with the profile key, posts it to every host the
   profile's `hosts` record names, and keeps its own copy. At each path the newest record counts; a
   `null` body deletes.
3. **Writer keys.** To let another app write, the person lists that app's own key in the profile's
   `permissions` record: which paths, until when. Its records carry `by`, its key. A host checks
   the permissions record when the record arrives; a reader checks it again, against the current
   permissions record. The profile key's own records always win over a writer's.
4. **Private records.** A body can be an envelope that only chosen reading keys open. Readers
   publish their reading key in their profile record, in `read`.
5. **Hosts.** A host is open: it takes signed records for any profile, keeps the newest at each
   path, and forgets the versions they replaced after a number of days it chooses.

### Run it

`@forest/records` has three import paths, each built to `dist/` with types:

| Import | What it gives |
|---|---|
| `@forest/records` | Keys (`profileKey`, `keyFromSecret`); canonical text; signing, checking and encoding records; the view (`viewProfile`, `liveContent`); writing (`ownerRecord`, `writerRecord`, `hostsRecord`, `permissionsRecord`, `nextTime`); talking to hosts (`publish`, `readPage`, `readAll`, `readProfile`). No server, database or encryption library in it |
| `@forest/records/host` | `Host`, the reference host: one SQLite file, `POST` and `GET /v1/records` |
| `@forest/records/private` | `readingKey`, `makePrivate`, `openPrivate`, `readerCount` |
| `@forest/records/schemas/<kind>.json` | The three shapes, as JSON Schemas |

Publish a profile with one offer, read it back, then let another app write offers:

```ts
import { randomBytes } from 'node:crypto'
import { hostsRecord, keyFromSecret, ownerRecord, permissionsRecord, profileKey, publish, readProfile, writerRecord } from '@forest/records'

const me = profileKey(seed, 'tutoring/seller') // seed: the 32 bytes the person's 24 words encode
const now = Date.now()
await publish([host], [
  hostsRecord(me, [host], now),
  ownerRecord(me, 'offer/maths', { direction: 'offer', description: 'One hour of maths, online.', createdAt: new Date(now).toISOString() }, now),
])
const view = await readProfile([host], me.address, Date.now())
view.current.get('offer/maths')?.record.body

const helper = keyFromSecret(randomBytes(32)) // the other app's own writer key
await publish(view.hosts, [permissionsRecord(me, [{ key: helper.address, paths: ['offer'], until: now + 30 * 86_400_000 }], now)])
await publish(view.hosts, [writerRecord(helper, me.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: new Date(now).toISOString() }, now)])
```

```
cd records
npm ci                 # also builds dist/
npm run check          # type-check
npm test               # everything, on loopback
npm run bench          # speed on this machine
node test/vectors.ts   # print the spec's test vectors
```

Node 22.18 or later. Built from existing pieces, unchanged: `@noble/curves`, `@noble/hashes`,
`@scure/base` and `canonicalize` for the core; `age-encryption` for private records; Node's
built-in `node:sqlite` for the host.

## Promises

- **A record checks the same wherever it comes from.** One canonical spelling (RFC 8785 over a
  narrowed JSON), strict Ed25519, at most 65,536 bytes. A host cannot forge or change a record; it
  can only withhold it.
- **Every reader computes the same view from the same records.** Where they came from and in what
  order does not matter. The reader's clock matters only to hold back records dated more than ten
  minutes ahead.
- **The owner wins.** A writer key never replaces or deletes what the profile key wrote, and never
  writes the hosts or permissions record.
- **Nobody writes for a profile unless its permissions record says so,** and removing a writer key
  ends everything it wrote, at once, for every reader that has the new permissions record.
- **A person can always move.** A profile's name is its key, not a host's address. A host never
  refuses a newer hosts or permissions record by its own policy.
- **A host holds nothing secret.** No keys, no accounts, no login, it logs no network address, and
  it cannot open a private record.

## Limits

- **The reference host is a reference.** One process, one SQLite file, listening on `127.0.0.1`
  unless told otherwise; TLS is the operator's. It checks each record against everything it stores
  for that profile, which is slow for a busy one.
- **Checking signatures is slow here.** Pure JavaScript checks about 150 a second on one core of the
  machine these tests ran on, against about 7,800 for OpenSSL. A busy host or index should verify
  in native code with the same strict rules (SPEC §8).
- **A host keeps only the newest record at each path,** and what it replaced for its keep days.
  Older history is in the app's copies, or nowhere.
- **No blobs.** Records name photos and media by SHA-256; how those bytes are stored and served is
  not specified, and nothing here stores them.
- **An expired writer key still listed can be misused against careless hosts.** Hosts refuse its
  new records, but a host that skips that check could take one it dates before `until`, and readers
  of that host would count it. Remove writer keys you no longer use.
- **Private records have no forward secrecy and are not post-quantum** (X25519). A reading key that
  leaks opens every envelope made for it, and a reader removed keeps what it already opened. Anyone
  sees a private record's path, time, size and number of reading keys.
- **Two profiles of one person can be linked by how they are written.** An app that writes both at
  the same moment to the same host puts them side by side in its listing; one writer key listed by
  both names itself in both. Write them apart, and give each profile its own writer keys.

## FAQ

**What if a host deletes my records?**
Nothing lasting is lost. Your app keeps a copy of every record it signed, and your hosts record can
name up to eight hosts, each holding everything. Readers read the others. To replace the host,
publish a new hosts record and post your copies to the new one. A record checks the same wherever
it comes from, and your name is your key, so nothing about you changes.

**Can a writer key be abused?**
Within its limits, yes: whoever holds it can write at the paths your permissions record allows,
until its `until`, and it can replace what it or another writer key wrote there. It cannot touch any
path you wrote with your profile key, your hosts record or your permissions record, and it cannot
write after `until` on an honest host. So list narrow paths and a near `until`, and remove it the
moment it goes wrong: everything it wrote stops counting at once.

**What happens to a removed writer's old records?**
They stop counting, at once, for every reader that has your new permissions record. A writer
record counts only while the current permissions record allows it, so taking a key out of
permissions (or deleting the record) undoes all it wrote. Hosts forget those records after their keep days. To keep something a writer wrote,
publish it again with your profile key before you remove the writer: then it is yours.

**Why does the owner win?**
A writer key lives somewhere less safe than the profile key: on a server, or with another app. If
it could replace what you wrote yourself, losing it would let someone rewrite your card or your
offers. Because the owner wins, the worst a lost writer key can do is add records where you never
wrote, and you can always overwrite or delete those by writing at the same path.

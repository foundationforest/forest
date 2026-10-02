# records

Up: [the repo](../README.md). The record shapes: [schemas/](schemas/).

## What it is

How a Forest profile says things, and how anyone reads them. A profile is one key. Everything the
profile says (its card, its offers, its reviews of others) is a record: a small signed JSON value
at a path in the profile's folder, such as `profile`, `offer/maths` or `review/7`. A review sits in
its writer's folder: the one it's about can't erase it; the one who wrote it can. Hosts keep
records and serve them to anyone. Any app, index or AI can read them, and checks every signature
itself.

This README is the standard. The library in `src/` does every MUST in it, and `test/` checks it.
MUST, SHOULD and MAY are used as in RFC 2119. The folder also holds a reference host, the three
record shapes as JSON Schemas, and test vectors.

## How it works

```
seed ── "forest/v1/profile/tutoring/seller" ──▶ profile key ── "forest/v1/read" ──▶ reading key
                                                    │
                                          signs every record
                                                    ▼
app ── POST /v1/records ──▶ the hosts its hosts record names ── GET /v1/records ──▶ any reader
```

### Keys

The profile key and the reading key are [keys/](../keys/README.md)'s, mixed from the person's seed.
records mixes no key. Nothing else is needed: no account, no sign-up, no directory.

| Key | Made from | Used for |
|---|---|---|
| profile key | keys/: ed25519, mixed from the seed and the label, such as `tutoring/seller` | signing the profile's records; one profile per label |
| reading key | keys/: age's post-quantum hybrid identity (`mlkem768x25519`), mixed from the profile key | opening private records |
| writer key | any other ed25519 key, made by an app | writing where the permissions record allows |

- **Names.** A profile's name is its public key in base58: its address, which is also its Solana
  wallet. A writer key is named the same way. An address has one spelling: decoding and encoding
  again MUST give the same text.
- **Usable keys.** A key named anywhere (`profile`, `by`, a writer's `key`) MUST be a canonical
  point in the prime-order subgroup and not of small order. Anything else is refused.
- **What a profile key signs:** Solana transactions, and records. A record's signed bytes begin
  with `0xff`, which no Solana message begins with.

### Canonical JSON

Every value in a record is in this narrowed JSON: strings without lone surrogates; whole numbers
within ±(2^53 − 1) (money and coordinates are decimal text: `"30"`, `"38.72"`); `true`, `false`,
`null`; arrays without holes; objects whose keys match `^[a-z][a-zA-Z0-9]{0,63}$`; nested at most
16 deep. Its canonical text is RFC 8785 (JCS). A record travels as exactly its canonical text: a
reader MUST re-serialize what it parsed and refuse the record unless the result equals the bytes it
received.

### Records

```
{ "v": 1, "profile": <address>, "path": <path>, "time": <ms since 1970>,
  "body": <object> | null, "by"?: <address>, "sig": <base64url> }
```

- `v` is 1. No other field is allowed.
- `time` is whole milliseconds, 0 to 2^53 − 1. A `null` body deletes the path.
- `by` is there only when a writer key signed. It differs from `profile`, and is never at a control
  path.
- `sig` is Ed25519 (RFC 8032) by `by` if present, else by `profile`, over the signing input
  `0xff` ‖ UTF-8(`forest/v1/record\n`) ‖ UTF-8(canonical text of the record without `sig`), in
  base64url without padding. Verification is strict: S < L, canonical encodings, R and the key in
  the prime-order subgroup, the key not of small order, then the cofactorless equation.
- The id is lowercase hex of SHA-256(signing input).
- The canonical text is at most 65,536 bytes. Larger things are blobs named by SHA-256, not
  specified here.

### Paths

- A path is 1 to 4 segments separated by `/`, each `[a-z0-9][a-z0-9._-]{0,63}`, at most 256 bytes.
- **Control paths**, the owner's alone: `hosts` and `permissions`.
- **Content:** `profile` (the card), `offer/<id>` (an offer or a request) and `review/<id>`, shaped
  by the JSON Schemas in `schemas/`; a market adds fields, never a shape. Other first segments are
  content too; readers MAY ignore them.
- A prefix covers a path segment by segment: `offer` covers `offer` and `offer/x`, not `offerx`.

### Control records

- **hosts:** `{ "urls": [origin, …] }`: 1 to 8 distinct origins, `https://host[:port]`, lower case,
  no path (`http` only on loopback, for tests). Where the profile's records live.
- **permissions:** `{ "writers": [{ "key": <address>, "paths": [prefix, …], "until"?: <ms> }, …] }`:
  the list of writer keys, at most 16, each with at most 16 content-path prefixes. `until` is
  optional: whole milliseconds, 0 to 2^53 − 1. A writer without it has no end.
- A field not named here, at any level, makes the record invalid, so a later limit is never ignored.

### Writers

One rule: a writer can write while it is on the list; what it already wrote always stays.

- `until` means the writer is on the list up to that date.
- Removing a writer means setting its `until` to now. Apps never delete entries from the list, so
  its past records keep counting.
- Hosts refuse a writer's record after its `until`; readers count it if its date is before its
  `until`.
- The owner's record wins over a writer's at the same path, so the owner can always delete a
  writer's record.

A writer's records carry `by`, its key.

### Which record counts

A reader's view of a profile is a pure function of the records it holds and its clock `now`:

1. Records dated after `now + 600,000` are held back.
2. Record A is newer than B if `A.time > B.time`, or the times are equal and `A.id > B.id`.
3. At `hosts` and at `permissions`, the newest record is current.
4. At a content path, if the owner has any record there, the owner's newest is current. Otherwise
   the newest writer record the current permissions record allows: a writer on its list whose `key`
   is `by`, one of whose `paths` covers the record's path, and, if it has an `until`, the record's
   `time` < `until`. A key not on the list counts for nothing.
5. A current record with a `null` body means the path is deleted.

Readers check `until` against the record's own time and no clock; when a writer record arrived is
the host's check (see Hosts).

### Private records

A private record's body is `{ "private": <base64url of an age file> }` and nothing else. The age
file is the envelope; it holds the canonical text of an object, encrypted to one or more reading
keys: the readers' `read` fields from their profile records, and usually the profile's own. Each
reading key is an age post-quantum hybrid recipient (`age1pq1…`, stanza `mlkem768x25519`); an app
MUST NOT make an envelope for any other kind. Each one adds about 2 KB, so the 65,536-byte cap
allows about 30. A host checks a private record like any other and cannot open it. Anyone can see
that it exists, its path, time and size, and how many reading keys it was made for. To remove a
reader, write a new version for the rest; a reader keeps what it already opened. There is no
forward secrecy.

### Hosts

A host is an HTTPS service with no keys, no accounts and no login: a record's signature is its only
credential. It is open: it takes signed records for any profile and serves them to anyone. Every
host answers the same two requests, the host socket:

| Request | Answer |
|---|---|
| `POST /v1/records`, body NDJSON, one canonical record per line, at most 100 | NDJSON, one `{i, id?, ok, error?, message?}` per line |
| `GET /v1/records?profile=&after=` | NDJSON of stored records in the order taken, after the cursor `after`, for one profile if asked; header `forest-cursor`: the last sequence number |

A page is at most 1,000 records and 4,194,304 bytes: a host ends it before a line that would pass
that. Readers MAY refuse a larger page.

**Taking a record in**, in this order, error code in brackets:

1. The checks of Canonical JSON and Records [`canonical`, `shape`, `path`, `key`, `version`,
   `time`, `body`, `control`, `hosts`, `permissions`, `size`, `signature`], and
   `time ≤ now + 600,000` [`future`].
2. Within a request, hosts and permissions records first, then the rest in the order sent.
3. It MUST become the current record at its path by Which record counts, over what the host stores
   plus it [`older`, `permission`].
4. A writer record: when it arrives, its key MUST be on the current permissions record's list for
   its path, and that writer's `until`, if it has one, MUST be later than the host's clock
   [`permission`].
5. A host MAY refuse a content record by its own policy [`policy`]. It MUST NOT refuse a hosts or
   permissions record by policy, so a person can always move and always remove a writer key.

**Keeping.** A host keeps every current record. A record that stops being current is kept for a
number of days the host chooses (the reference host: 30) by its own clock, then deleted. A host MUST
NOT log network addresses. It SHOULD verify in native code with these same strict rules: OpenSSL's
defaults accept a small-order signature this protocol refuses.

### Apps that write records

Follow [keys/](../keys/README.md)'s rules for apps that hold keys. Also:

- Give each profile its own writer keys: a writer key named in two profiles links them.
- Set `time = max(now, newest known at that path + 1)`.
- Post every record to every host the hosts record names, hosts and permissions records first.
  To move, post a hosts record naming the new hosts to old and new, then the copies. To leave a
  host, send it deletes.

### Run it

`@forest/records` has three import paths, each built to `dist/` with types:

| Import | What it gives |
|---|---|
| `@forest/records` | Keys as addresses (`keyFromPrivate`, `publicKeyFromAddress`); canonical text; signing, checking and encoding records; the view (`viewProfile`, `liveContent`); writing (`ownerRecord`, `writerRecord`, `hostsRecord`, `permissionsRecord`, `nextTime`); talking to hosts (`publish`, `readPage`, `readAll`, `readProfile`). No server, database or encryption library in it |
| `@forest/records/host` | `Host`, the reference host: one SQLite file, `POST` and `GET /v1/records` |
| `@forest/records/private` | `makePrivate`, `openPrivate`, `readerCount`. The reading key itself is keys/'s `readingKey` |
| `@forest/records/schemas/<kind>.json` | The three shapes, as JSON Schemas |

Publish a profile with one offer, read it back, then let another app write offers:

```ts
import { randomBytes } from 'node:crypto'
import { profileKey } from '@forest/keys' // keys/
import { hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, readProfile, writerRecord } from '@forest/records'

const me = await profileKey(seed, 'tutoring/seller') // seed: the 32 bytes the person's 24 words encode
const now = Date.now()
await publish([host], [
  hostsRecord(me, [host], now),
  ownerRecord(me, 'offer/maths', { direction: 'offer', description: 'One hour of maths, online.', createdAt: new Date(now).toISOString() }, now),
])
const view = await readProfile([host], me.address, Date.now())
view.current.get('offer/maths')?.record.body

const helper = keyFromPrivate(randomBytes(32)) // the other app's own writer key
await publish(view.hosts, [permissionsRecord(me, [{ key: helper.address, paths: ['offer'], until: now + 30 * 86_400_000 }], now)])
await publish(view.hosts, [writerRecord(helper, me.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: new Date(now).toISOString() }, now)])
```

```
(cd keys && npm ci)    # the tests take their keys from keys/
cd records
npm ci                 # also builds dist/
npm run check          # type-check
npm test               # everything, on loopback
npm run bench          # speed on this machine
node test/vectors.ts   # print the test vectors
```

Node 22.18 or later. Built from existing pieces, unchanged: `@noble/curves`, `@noble/hashes`,
`@scure/base` and `canonicalize` for the core; `age-encryption` for private records; Node's
built-in `node:sqlite` for the host.

### Test vectors

`test/vectors.json`: a hosts, profile, offer, permissions, writer's offer and delete record, each
with its wire text, signing input and id, for keys/'s `tutoring/seller` profile from its test seed
`00 01 … 1f`; the profile record's `read` is that profile's reading key. The seed, the profile key
and the reading key are pinned in `keys/test/vectors.json`, and checked there. The writer key's
private key is 32 bytes of `0x2a`. `test/vectors.test.ts` recomputes the records, and checks each
with node:crypto (Ed25519, SHA-256). The profile is `EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu`;
every signing input begins `ff 66 6f 72 65 73 74 2f` (`0xff`, then `forest/`).

## Promises

- **A record checks the same wherever it comes from.** One canonical spelling, strict Ed25519, at
  most 65,536 bytes. A host cannot forge or change a record; it can only withhold it.
- **Every reader computes the same view from the same records.** Where they came from and in what
  order does not matter. The reader's clock matters only to hold back records dated more than ten
  minutes ahead.
- **The owner wins.** A writer key never replaces or deletes what the profile key wrote, and never
  writes the hosts or permissions record.
- **Nobody writes for a profile unless its permissions record says so.** Removing a writer ends
  what it can add, never what it already wrote.
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
  in native code with the same strict rules (see Hosts).
- **A host keeps only the newest record at each path,** and what it replaced for its keep days.
  Older history is in the app's copies, or nowhere.
- **No blobs.** Records name photos and media by SHA-256; how those bytes are stored and served is
  not specified, and nothing here stores them.
- **A removed writer key can still write to a careless host.** Honest hosts refuse its records once
  its `until` has passed, but a host that skips that check could take a record it dates before
  `until`, and readers of that host would count it. The owner deletes it by writing at that path.
- **Private records have no forward secrecy.** A reading key that leaks opens every envelope made
  for it, and a reader removed keeps what it already opened. Anyone sees a private record's path,
  time, size and number of reading keys.
- **A private record holds about 30 reading keys at most.** Each post-quantum reading key adds
  about 2 KB to the envelope, and a record is at most 64 KB.
- **Two profiles of one person can be linked by how they are written.** An app that writes both at
  the same moment to the same host puts them side by side in its listing; one writer key listed by
  both names itself in both. Write them apart, and give each profile its own writer keys.

## FAQ

**What if a host deletes my records?**
Nothing lasting is lost. Your app keeps a copy of every record it signed, and your hosts record can
name up to eight hosts, each holding everything. Readers read the others. To replace the host,
publish a new hosts record and post your copies to the new one. A record checks the same wherever
it comes from, and your name is your key, so nothing about you changes.

**Can a host lock me in?**
No. A host holds no keys and no accounts, takes signed records for any profile, and never refuses a
newer hosts or permissions record by its own policy. It can stop serving you, but it can never stop
you moving, and never keep a writer key from being removed.

**How does a reader find my records? Is there a directory?**
Your hosts record says where they live, and no directory or relay is needed. Nothing grows with the
network but each reader's own work.

**Why do hosts never log network addresses?**
One phone writing for two profiles would link them.

**How long does a host keep old versions?**
The newest record at each path, always; what it replaced, for a number of days the host chooses. A
field for it in the hosts record would be one more rule for every app.

**Could a record's signature be used to move my money?**
No. A record's signed bytes begin with `0xff`, and no Solana transaction begins with it, so a
record's signature can never be a payment's.

**Can a writer key be abused?**
Within its limits, yes: whoever holds it can write at the paths your permissions record allows,
until its `until`, and it can replace what it or another writer key wrote there. It cannot touch any
path you wrote with your profile key, your hosts record or your permissions record, and it cannot
write after `until` on an honest host. So list narrow paths and a near `until`. When you are done
with it, set its `until` to now, and delete with your profile key anything it wrote that you do not
want.

**What happens to a removed writer's old records?**
They stay. Removing a writer is setting its `until` to now, and a reader counts a writer's record
if it is dated before `until`: everything it wrote before then still counts, and nothing dated
later does. Hosts refuse whatever it sends from then on, and keep what it wrote. To make one of its
records yours, publish it again with your profile key.

**Why does a reader check a writer's record by its date, and not by its own clock?**
So that readers agree whatever their clocks say, and so that removing a writer never erases what it
already wrote. When a record arrived is the host's check.

**Why does the owner win?**
A writer key lives somewhere less safe than the profile key: on a server, or with another app. If
it could replace what you wrote yourself, losing it would let someone rewrite your card or your
offers. Because the owner wins, the worst a lost writer key can do is add records where you never
wrote, and you can always overwrite or delete those by writing at the same path.

**Why only post-quantum reading keys?**
A private record is one envelope for all its readers. One classic key among them would let a
quantum computer open it for all of them.

**Why do offers and reviews name no market?**
A profile names one market and role, from its label. An offer's market and side are its author's;
a review's market is that of the profile it is about. A registry row counts for a profile under its
own label, so neither needs more.

**Does a review need proof of a deal?**
No. A review needs only its subject. Evidence weighs, it never rejects: what is missing weighs
less, and nothing is refused. An index decides how much each review weighs.

**How does a review name a deal?**
By its deal id: the escrow receipt's address when the deal went through the escrow, else 32 random
bytes chosen when the deal began. Two reviews across one id show both sides took part, so no shape
for it is needed.

**Why not AT Protocol, Nostr or Pubky as the base?**
AT Protocol has one server per profile and a central directory. Nostr's keys cannot be Solana keys,
and it has no writer key that can be removed. Pubky's servers can forge records.

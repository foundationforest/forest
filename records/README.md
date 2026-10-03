# records

Up: [the repo](../README.md). The record shapes: [schemas/](schemas/).

## What it is

How a Forest profile says things, and how anyone reads them. A profile is one key. Everything the
profile says (its card, its offers, its reviews of others) is a record: a small signed JSON value at
a path in the profile's folder, such as `profile`, `offer/maths` or `review/7`. A review sits in the
folder of the profile that wrote it: the one it's about can't erase it; the one who wrote it can.
Hosts keep records and serve them to anyone. Any app, index or AI can read them, and checks every
signature itself. A profile can also declare an inbox: anyone may deliver it a sealed message, and
only its main key pulls them. Hosts also keep the photos and videos records name: blobs.

This README is the standard. The library in `src/` does every MUST in it, and `test/` checks it.
MUST, SHOULD and MAY are used as in RFC 2119. The folder also holds a reference host, the three
record shapes as JSON Schemas, and test vectors.

## How it works

```
seed ── "forest/v1/profile/tutoring/seller" ──▶ main key ── "forest/v1/read" ──▶ reading key
                                                    │
                                          signs every record
                                                    ▼
app ── POST /v1/records, then PUT /v1/blobs ──▶ the hosts its hosts record names ── GET ──▶ any reader

sender ── POST /v1/inbox ──▶ the recipient's hosts ── POST /v1/inbox/pull ──▶ the recipient's main key only
```

### Keys

The main key and the reading key are [keys/](../keys/README.md)'s, mixed from the person's seed.
records mixes no key. Nothing else is needed: no account, no sign-up, no directory.

| Key | Made from | Used for |
|---|---|---|
| main key | keys/: ed25519, mixed from the seed and the label, such as `tutoring/seller` | signing the folder's records, the messages it sends and the pulls of its inbox; its address is the profile's name and its Solana address; one profile per label |
| reading key | keys/: age's post-quantum hybrid identity (`mlkem768x25519`), mixed from the main key | opening private records and messages |
| access key | any ed25519 key an app makes | writing where the permissions record lists it |

- **Names.** A profile's name is its main key in base58: its address, which is also its Solana
  address. An access key is named the same way. An address has one spelling: decoding and encoding
  again MUST give the same text.
- **Usable keys.** A key named anywhere (`profile`, `by`, an access key's `key`, a message's `to`
  and `from`, an inbox's `issuer`) MUST be a canonical point in the prime-order subgroup and not of
  small order. Anything else is refused.
- **What a main key signs:** Solana transactions, records, messages and pull requests. The signed
  bytes of the last three begin with `0xff`, which no Solana message begins with, then each with its
  own text (`forest/v1/record\n`, `forest/v1/message\n`, `forest/v1/pull\n`), so no signature is
  ever two of them.

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
- `by` is there only when an access key signed. It differs from `profile`, and is never at a
  control path.
- `sig` is Ed25519 (RFC 8032) by `by` if present, else by `profile`, over the signing input
  `0xff` ‖ UTF-8(`forest/v1/record\n`) ‖ UTF-8(canonical text of the record without `sig`), in
  base64url without padding. Verification is strict: S < L, canonical encodings, R and the key in
  the prime-order subgroup, the key not of small order, then the cofactorless equation.
- The id is lowercase hex of SHA-256(signing input).
- The canonical text is at most 65,536 bytes. Larger things are blobs, named by SHA-256 (Blobs,
  below).

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
- **permissions:** `{ "access": [{ "key": <address>, "paths": [prefix, …], "until"?: <ms> }, …] }`:
  the list of access keys, at most 16, each with at most 16 content-path prefixes. `until` is
  optional: whole milliseconds, 0 to 2^53 − 1. An access key without it has no end.
- A field not named here, at any level, makes the record invalid, so a later limit is never ignored.

### Access keys

One rule, the access rule: an access key can write while it is on the list; what it already wrote
always stays.

- `until` means the key is on the list up to that date.
- Removing an access key means setting its `until` to now. Apps never delete entries from the list,
  so its past records keep counting.
- Hosts refuse an access key's record after its `until`; readers count it if its date is before its
  `until`.
- The owner's record wins over an access key's at the same path, so the owner can always delete an
  access key's record.

An access key's records carry `by`, its key.

Write scope lives here, in the permissions record. Read scope is the envelopes: a private record
opens only for the reading keys it is sealed to (Private records, below). Pay scope is the chain's
own allowance, and Forest has no format for it.

### Which record counts

A reader's view of a profile is a pure function of the records it holds and its clock `now`:

1. Records dated after `now + 600,000` are held back.
2. Record A is newer than B if `A.time > B.time`, or the times are equal and `A.id > B.id`.
3. At `hosts` and at `permissions`, the newest record is current.
4. At a content path, if the owner has any record there, the owner's newest is current. Otherwise
   the newest access key's record the current permissions record allows by the access rule: an
   entry on its list whose `key` is `by`, one of whose `paths` covers the record's path, and, if it
   has an `until`, the record's `time` < `until`. A key not on the list counts for nothing.
5. A current record with a `null` body means the path is deleted.

Readers check `until` against the record's own time and no clock; when an access key's record
arrived is the host's check (see Hosts).

### Private records

A private record's body is `{ "private": <base64url of an age file> }` and nothing else. Each
private record is one age file, the envelope: the canonical text of an object under a random key
made for that record, and that key sealed once per reader.

The readers are reading keys the owner makes, one for each reader, and hands over. So a reader needs
no profile and no key of its own, and a made key that leaks opens only what this owner sealed to
it. The owner usually adds its own reading key, to open its copy. A profile's `read` field is that
profile's own reading key. How a made key's private half reaches its reader is the app's.

Each reading key is an age post-quantum hybrid recipient (`age1pq1…`, stanza `mlkem768x25519`); an
app MUST NOT seal an envelope to any other kind. Each one adds about 2 KB, so the 65,536-byte cap
allows about 30. A host checks a private record like any other and cannot open it. Anyone can see
that it exists, its path, time and size, and how many reading keys it is sealed to. To remove a
reader, write a new version for the rest; a reader keeps what it already opened. There is no
forward secrecy.

### Inbox

A profile can take messages: sealed notes anyone delivers to its hosts, and only its main key pulls.
A message is not a record: it has no path and no versions, and it is in no one's folder.

**Declaring it.** The profile record's optional `inbox` field (`schemas/profile.json`):

```
"inbox": { "senders": "anyone" | { "issuer": <address> }, "once"?: true, "maxBytes"?: <integer> }
```

- No `inbox` field means no inbox: hosts refuse deliveries.
- `senders` is `"anyone"`, or `{ "issuer" }`: the sender's key must hold a registry row from that
  issuer, under any label.
- `once`: one message from each sender, ever.
- `maxBytes`: the largest message it takes, as canonical text in bytes.
- Senders seal to the profile's `read`, so a profile with an inbox gives one.
- A host refuses deliveries to an inbox it cannot read: a field, a rule or a value it does not know.
  So a new rule can be added later without an old host taking what it should refuse.

**Messages.**

```
{ "v": 1, "to": <address>, "from": <address>, "time": <ms since 1970>,
  "body": { "private": <base64url of an age file> }, "sig": <base64url> }
```

- `v` is 1. No other field is allowed, in the message or in its body.
- `to` is the recipient profile. `from` is the sender's key: a main key, or any other ed25519 key.
- `body` is one envelope (Private records) sealed to `to`'s reading key alone.
- `sig` is Ed25519 by `from`, strict as a record's, over `0xff` ‖ UTF-8(`forest/v1/message\n`) ‖
  UTF-8(canonical text of the message without `sig`), in base64url without padding.
- The id is lowercase hex of SHA-256(signing input), as a record's. The canonical text is at most
  65,536 bytes.

**Deliver.** The sender reads the recipient's profile record for its `inbox` and `read`, and its
hosts record. It seals the body to `read`, signs, and posts the message to each host the hosts
record names (`POST /v1/inbox`). Anyone may deliver, with no login; each host checks the message on
its own (Taking a message in, under Hosts).

**Pull.** The recipient asks each of its hosts for what arrived after a cursor
(`POST /v1/inbox/pull`):

```
{ "v": 1, "profile": <address>, "after": <cursor>, "time": <ms since 1970>, "sig": <base64url> }
```

- `sig` is Ed25519 by the profile's main key over `0xff` ‖ UTF-8(`forest/v1/pull\n`) ‖
  UTF-8(canonical text without `sig`). An access key cannot pull.
- `after` is the `forest-cursor` of the last page; 0 for everything.
- `time` is within 600,000 ms of the host's clock, either way.
- It is a POST and not a GET because hosting platforms log URLs, and a signed URL would be a log of
  pulls.

### Blobs

A blob is bytes a record names by SHA-256: a profile record's `photo`, or the `media` of an offer or
a review. Each name gives the hash, the type (`mimeType`) and the size.

- Post the record first, then the bytes, to each host: `PUT /v1/blobs/<sha256>` with the type the
  record names as `content-type`. A host takes bytes only while a current record on it names that
  hash as that type.
- `GET /v1/blobs/<sha256>` answers the bytes with that type, or 404 when the host does not hold
  them.
- Readers fetch a blob from the record's hosts, and check its SHA-256 themselves.

### Hosts

A host is an HTTPS service with no keys, no accounts and no login: a record's signature is its only
credential, and a pull's is the recipient's. It is open: it takes signed records for any profile and
serves them to anyone; it takes messages for any profile whose profile record on it declares an
inbox, and serves them only to that profile's main key; it takes the bytes a current record names,
and serves them to anyone. Every host answers the same six requests, the host socket:

**`POST /v1/records`.** The body is NDJSON, one canonical record per line. The answer is NDJSON,
one `{i, id?, ok, error?, message?}` per line (Taking a record in).

**`GET /v1/records?profile=&after=`.** The answer is NDJSON of stored records in the order taken,
after the cursor `after`, for one profile if asked. Its header `forest-cursor` is the last sequence
number on the page: the next page is after it.

**`POST /v1/inbox`.** The body is NDJSON, one canonical message per line. The answer is NDJSON, one
`{i, id?, ok, error?, message?}` per line (Taking a message in).

**`POST /v1/inbox/pull`.** The body is a pull request's canonical text. The answer is NDJSON of the
messages to that profile that arrived after the cursor, in arrival order, with `forest-cursor` as
for records. A pull it refuses is answered 400 with `{ok, error, message}`: [`stale`] when its time
is more than 600,000 ms from the host's clock, [`signature`] when the profile's main key did not
sign it, or a shape code.

**`PUT /v1/blobs/<sha256>`.** The body is the raw bytes, `content-type` their type, and the path
their SHA-256 in lowercase hex. The answer is `{ok, error?, message?}` (Taking a blob in).

**`GET /v1/blobs/<sha256>`.** The answer is the bytes, with the type a record named when they came
in, or 404 when the host does not hold them.

**Sizes.** A host chooses how many records or messages a request may carry, and how many lines and
bytes a page holds; a page always holds at least one line. A request with more lines gets one
[`batch`] result, and one with more bytes gets 413. A client handles any size: it sends a refused
request again in halves, follows the cursor page by page, and refuses unread a line longer than
65,536 bytes.

**Taking a record in**, in this order, error code in brackets:

1. The checks of Canonical JSON and Records [`canonical`, `shape`, `path`, `key`, `version`,
   `time`, `body`, `control`, `hosts`, `permissions`, `size`, `signature`], and
   `time ≤ now + 600,000` [`future`].
2. Within a request, hosts and permissions records first, then the rest in the order sent.
3. It MUST become the current record at its path by Which record counts, over what the host stores
   plus it [`older`, `permission`].
4. An access key's record: when it arrives, its key MUST be on the current permissions record's
   list for its path, and that key's `until`, if it has one, MUST be later than the host's clock
   [`permission`].
5. A host MAY refuse a content record by its own policy [`policy`]. It MUST NOT refuse a hosts or
   permissions record by policy, so a person can always move and always remove an access key.

**Taking a message in**, in this order, error code in brackets:

1. The checks of Messages [`canonical`, `shape`, `version`, `key`, `time`, `body`, `size`], and
   `time ≤ now + 600,000` [`future`].
2. No message with the same id is here already [`duplicate`].
3. The current profile record of `to` on this host declares an inbox [`no_inbox`].
4. The signature [`signature`].
5. The rule. `"anyone"` passes. `{ issuer }` needs a row for `from` from that issuer, under any
   label [`sender`]: a registry lookup, over an RPC the host chooses; a host without one accepts
   only `"anyone"` [`rule_unsupported`]. A lookup that fails is [`lookup`]: the sender may try
   again. An inbox the host cannot read is [`rule_unsupported`] too.
6. `once`: a second message from this `from` to this `to` is refused, ever [`once`]. The host keeps
   each pair it takes while the inbox says `once`, for as long as it keeps the profile.
7. `maxBytes`: the canonical text is at most that many bytes [`too_big`].
8. A host MAY refuse a message by its own policy [`policy`].

**Taking a blob in**, in this order:

1. The bytes' SHA-256 is the name in the path [`hash`].
2. A current record on this host names that hash, with the `content-type` sent as its type
   [`unnamed`]. So the record comes first.
3. The host's own policy allows the size and the type [`policy`].

**Keeping.**

- A host keeps every current record. A record that stops being current is kept for a number of
  days the host chooses, by its own clock, then deleted.
- A host keeps a message for a number of days it chooses, from when it arrived; a pull does not
  delete it.
- A host keeps bytes while a current record on it names them. Once none does, it may delete them
  after its keep days.

A host SHOULD verify in native code with these same strict rules: OpenSSL's defaults accept a
small-order signature this protocol refuses.

### Apps that write records

Follow [keys/](../keys/README.md)'s rules for apps that hold keys. Also:

- Give each folder its own access keys: an access key named in two folders links them.
- Set `time = max(now, newest known at that path + 1)`.
- Post every record to every host the hosts record names, hosts and permissions records first.
  To move, post a hosts record naming the new hosts to old and new, then the copies. To leave a
  host, send it deletes.
- Post a record, then the blobs it names, to each of those hosts.
- Deliver a message to each host the recipient's hosts record names. Pull your inbox from each of
  your own hosts.

### Run it

`@forest/records` has three import paths, each built to `dist/` with types:

| Import | What it gives |
|---|---|
| `@forest/records` | Keys as addresses (`keyFromPrivate`, `publicKeyFromAddress`); canonical text; signing, checking and encoding records; the view (`viewProfile`, `liveContent`); writing (`ownerRecord`, `accessRecord`, `hostsRecord`, `permissionsRecord`, `nextTime`); messages and pulls (`signMessage`, `decodeMessage`, `messageId`, `pullRequest`, `checkPull`, `inboxOf`); talking to hosts (`publish`, `readPage`, `readAll`, `readProfile`, `deliver`, `pull`, `putBlob`, `getBlob`). No server, database or encryption library in it |
| `@forest/records/host` | `Host`, the reference host: one SQLite file and the six requests. Unless told otherwise, it takes 100 records or messages a request; serves 1,000 a page, at most 4,194,304 bytes; keeps a replaced record, a message, and bytes no current record names any more for 30 days; and takes png, jpeg and mp4 blobs up to 50,000,000 bytes. Give it `rowLookup` to take messages for inboxes with an issuer's rule |
| `@forest/records/private` | `makePrivate`, `openPrivate`, `readerCount`; `message` (seal and sign one) and `openMessage`. The reading key itself is keys/'s `readingKey` |
| `@forest/records/schemas/<kind>.json` | The three shapes, as JSON Schemas |

Publish a profile with one offer, read it back, then let another app write offers:

```ts
import { randomBytes } from 'node:crypto'
import { mainKey } from '@forest/keys' // keys/
import { accessRecord, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, readProfile } from '@forest/records'

const me = await mainKey(seed, 'tutoring/seller') // seed: the 32 bytes the person's 24 words encode
const now = Date.now()
await publish([host], [
  hostsRecord(me, [host], now),
  ownerRecord(me, 'offer/maths', { direction: 'offer', description: 'One hour of maths, online.', createdAt: new Date(now).toISOString() }, now),
])
const view = await readProfile([host], me.address, Date.now())
view.current.get('offer/maths')?.record.body

const helper = keyFromPrivate(randomBytes(32)) // the other app's own access key
await publish(view.hosts, [permissionsRecord(me, [{ key: helper.address, paths: ['offer'], until: now + 30 * 86_400_000 }], now)])
await publish(view.hosts, [accessRecord(helper, me.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: new Date(now).toISOString() }, now)])
```

Write to that profile's inbox from another profile, then pull it on the owner's device:

```ts
import { mainKey, readingKey } from '@forest/keys'
import { deliver, pull, pullRequest, readProfile } from '@forest/records'
import { message, openMessage } from '@forest/records/private'

const buyer = await mainKey(otherSeed, 'tutoring/buyer')
const seller = await readProfile([host], me.address, Date.now()) // its card declares an inbox and gives read
const read = seller.current.get('profile')?.record.body?.read as string
await deliver(seller.hosts, [await message(buyer, me.address, { text: 'Is Tuesday at six free?' }, Date.now(), read)])

const page = await pull(host, pullRequest(me, 0, Date.now())) // the main key signs each pull
const { identity } = await readingKey(me.privateKey)
for (const m of page.messages) (await openMessage(m.message, identity)).body
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
`@scure/base` and `canonicalize` for the core; `age-encryption` for private records and messages;
Node's built-in `node:sqlite` for the host.

### Test vectors

`test/vectors.json`: a hosts, profile, offer, permissions, access key's offer and delete record,
each with its wire text, signing input and id, for keys/'s `tutoring/seller` profile from its test
seed `00 01 … 1f`; the profile record's `read` is that profile's reading key. The seed, the main key
and the reading key are pinned in `keys/test/vectors.json`, and checked there. The access key's
private key is 32 bytes of `0x2a`. It also holds a message from keys/'s `tutoring/buyer` profile to
`tutoring/seller`, with its wire text, signing input and id, and a pull request by
`tutoring/seller`. The message's body is sealed to `tutoring/seller`'s reading key; age's sealing is
random, so the sealed body is pinned as it was made. `test/vectors.test.ts` recomputes the records,
the message and the pull, checks each with node:crypto (Ed25519, SHA-256), and opens the message
with `tutoring/seller`'s pinned reading key. The profile is
`EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu`; every signing input begins
`ff 66 6f 72 65 73 74 2f` (`0xff`, then `forest/`).

## Promises

- **A record checks the same wherever it comes from.** One canonical spelling, strict Ed25519, at
  most 65,536 bytes. A host cannot forge or change a record; it can only withhold it.
- **Every reader computes the same view from the same records.** Where they came from and in what
  order does not matter. The reader's clock matters only to hold back records dated more than ten
  minutes ahead.
- **The owner wins.** An access key never replaces or deletes what the main key wrote, and never
  writes the hosts or permissions record.
- **Nobody writes for a profile unless its permissions record says so.** Removing an access key
  ends what it can add, never what it already wrote.
- **A person can always move.** A profile's name is its key, not a host's address. A host never
  refuses a newer hosts or permissions record by its own policy.
- **A host holds nothing secret.** No keys, no accounts, no login, and it cannot open a private
  record.
- **Only a profile's main key can pull its inbox.**

## Limits

- **The reference host is a reference.** One process, one SQLite file, listening on `127.0.0.1`
  unless told otherwise; TLS is the operator's. It checks each record against everything it stores
  for that profile, which is slow for a busy one.
- **Checking signatures is slow here.** Pure JavaScript checks about 150 a second on one core of the
  machine these tests ran on, against about 7,800 for OpenSSL. A busy host or index should verify
  in native code with the same strict rules (see Hosts).
- **A host keeps only the newest record at each path,** and what it replaced for its keep days.
  Older history is in the app's copies, or nowhere.
- **A removed access key can still write to a careless host.** Honest hosts refuse its records once
  its `until` has passed, but a host that skips that check could take a record it dates before
  `until`, and readers of that host would count it. The owner deletes it by writing at that path.
- **A host sees who wrote to whom.** It holds each message's `from`, `to`, time and size, though not
  what it says. That is less than escrows and reviews already show in public. Filtering by an
  inbox's rule needs the sender, so there is no anonymous mode.
- **A host without a registry lookup accepts only "anyone".** It refuses messages to an inbox with
  an issuer's rule.
- **A blob is only as true as its hash.** The record says what it is, and the bytes say what they
  are. A host checks the hash, never that the bytes are the type or size the record gives.
- **Messages have no forward secrecy.** A reading key that leaks opens every message sealed to it,
  from any host or copy that still holds them.
- **Private records have no forward secrecy.** A reading key that leaks opens every envelope sealed
  to it, and a reader removed keeps what it already opened. Anyone sees a private record's path,
  time, size and number of reading keys.
- **A private record holds about 30 reading keys at most.** Each post-quantum reading key adds
  about 2 KB to the envelope, and a record is at most 64 KB.
- **Two profiles of one person can be linked by how they are written.** An app that writes both at
  the same moment to the same host puts them side by side in its listing; one access key listed by
  both names itself in both; and a host that logs addresses links them; the foundation's hosts do
  not ([services](https://github.com/foundationforest/services)). Write them apart, and give each
  folder its own access keys.

## FAQ

**What if a host deletes my records?**
Nothing lasting is lost. Your app keeps a copy of every record it signed, and your hosts record can
name up to eight hosts, each holding everything. Readers read the others. To replace the host,
publish a new hosts record and post your copies to the new one. A record checks the same wherever
it comes from, and your name is your key, so nothing about you changes.

**Can a host lock me in?**
No. A host holds no keys and no accounts, takes signed records for any profile, and never refuses a
newer hosts or permissions record by its own policy. It can stop serving you, but it can never stop
you moving, and never keep an access key from being removed.

**How does a reader find my records? Is there a directory?**
Your hosts record says where they live, and no directory or relay is needed. Nothing grows with the
network but each reader's own work.

**How long does a host keep old versions?**
The newest record at each path, always; what it replaced, for a number of days the host chooses. A
field for it in the hosts record would be one more rule for every app.

**Could a record's signature be used to move my money?**
No. A record's signed bytes begin with `0xff`, and no Solana transaction begins with it, so a
record's signature can never be a payment's.

**Can an access key be abused?**
Within its limits, yes: whoever holds it can write at the paths your permissions record allows,
until its `until`, and it can replace what it or another access key wrote there. It cannot touch
any path you wrote with your main key, your hosts record or your permissions record, and it cannot
write after `until` on an honest host. So list narrow paths and a near `until`. When you are done
with it, set its `until` to now, and delete with your main key anything it wrote that you do not
want.

**What happens to a removed access key's old records?**
They stay. Removing an access key is setting its `until` to now, and a reader counts its record if
it is dated before `until`: everything it wrote before then still counts, and nothing dated later
does. Hosts refuse whatever it sends from then on, and keep what it wrote. To make one of its
records yours, publish it again with your main key.

**Why does a reader check an access key's record by its date, and not by its own clock?**
So that readers agree whatever their clocks say, and so that removing an access key never erases
what it already wrote. When a record arrived is the host's check.

**Why does the owner win?**
An access key lives somewhere less safe than the main key: on a server, or with another app. If it
could replace what you wrote yourself, losing it would let someone rewrite your card or your
offers. Because the owner wins, the worst a lost access key can do is add records where you never
wrote, and you can always overwrite or delete those by writing at the same path.

**Why only post-quantum reading keys?**
A private record is one envelope for all its readers. One classic key among them would let a
quantum computer open it for all of them.

**Why does the owner make the readers' keys?**
So a reader needs no profile and no key of its own: the owner's app makes a reading key for it and
hands it over. And a made key that leaks opens only what one owner sealed to it, never everything
ever sealed to the reader's own key.

**Why is a message not a record in the sender's folder?**
Anyone reads a folder. A message there would need a field naming its recipient so hosts could route
it, and that field would make every inquiry a public fact: who asked whom, and when. A message goes
to the recipient's hosts instead, sealed, and only the recipient pulls it.

**Why does the recipient sign the pull?**
Otherwise anyone could ask a host for a profile's messages, and who wrote to whom would be public
to anyone. Each body is sealed, but `from`, `to` and the time are not. A pull signed by the main
key, within ten minutes of the host's clock, lets only the profile list its inbox.

**Why is there no deposit rule?**
A rule that asks senders to pay would have every host check payments. An inbox's `senders` is a
field with kinds, and a host refuses deliveries under a kind it does not know, so a kind can be
added later without breaking anything.

**Why are blobs kept only while a record names them?**
A host stores records; bytes ride on a record. Bytes no record names would make a host a free file
store for anyone. When the last record naming them goes, the bytes go after the host's keep days.

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
and it has no access key that can be removed. Pubky's servers can forge records.

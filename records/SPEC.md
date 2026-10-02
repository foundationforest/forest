# Forest records, v1

Devnet only: nothing here is shipped. The library in this folder does every MUST below, and `test/`
checks it. MUST, SHOULD and MAY are used as in RFC 2119.

A profile is one ed25519 key. Everything it says is a record: a small signed JSON value at a path in
the profile's folder. Hosts store records and serve them to anyone. At each path the newest record
counts, and the profile key's own record wins over any writer key's.

## 1. Keys

The profile key and the reading key are [keys/](../keys/README.md)'s, from the person's seed. This
spec mixes no key.

| Key | Made from | Used for |
|---|---|---|
| profile key | keys/: ed25519, mixed from the seed and the label, such as `tutoring/seller` | signing the profile's records; one profile per label |
| reading key | keys/: age's post-quantum hybrid identity (`mlkem768x25519`), mixed from the profile key | opening private records (§7) |
| writer key | any other ed25519 key, made by an app | writing where the permissions record allows (§5) |

- **Names.** A profile's name is its public key in base58: its address, which is also its Solana
  wallet. A writer key is named the same way. An address has one spelling: decoding and encoding
  again MUST give the same text.
- **Usable keys.** A key named anywhere (`profile`, `by`, a writer's `key`) MUST be a canonical
  point in the prime-order subgroup and not of small order. Anything else is refused.
- **What a profile key signs:** Solana transactions, and records. A record's signed bytes begin
  with `0xff`, which no Solana message begins with.

## 2. Canonical JSON

Every value in a record is in this narrowed JSON: strings without lone surrogates; whole numbers
within ±(2^53 − 1) (money and coordinates are decimal text: `"30"`, `"38.72"`); `true`, `false`,
`null`; arrays without holes; objects whose keys match `^[a-z][a-zA-Z0-9]{0,63}$`; nested at most
16 deep. Its canonical text is RFC 8785 (JCS). A record travels as exactly its canonical text: a
reader MUST re-serialize what it parsed and refuse the record unless the result equals the bytes it
received.

## 3. Records

```
{ "v": 1, "profile": <address>, "path": <path>, "time": <ms since 1970>,
  "body": <object> | null, "by"?: <address>, "sig": <base64url> }
```

- `v` is 1. No other field is allowed.
- `time` is whole milliseconds, 0 to 2^53 − 1. A `null` body deletes the path.
- `by` is there only when a writer key signed. It differs from `profile`, and is never at a control
  path (§4).
- `sig` is Ed25519 (RFC 8032) by `by` if present, else by `profile`, over the signing input
  `0xff` ‖ UTF-8(`forest/v1/record\n`) ‖ UTF-8(canonical text of the record without `sig`), in
  base64url without padding. Verification is strict: S < L, canonical encodings, R and the key in
  the prime-order subgroup, the key not of small order, then the cofactorless equation.
- The id is lowercase hex of SHA-256(signing input).
- The canonical text is at most 65,536 bytes. Larger things are blobs named by SHA-256, not
  specified here.

## 4. Paths

- A path is 1 to 4 segments separated by `/`, each `[a-z0-9][a-z0-9._-]{0,63}`, at most 256 bytes.
- **Control paths**, the owner's alone: `hosts` and `permissions`.
- **Content:** `profile` (the card), `offer/<id>` (an offer or a request) and `review/<id>`, shaped
  by the JSON Schemas in `schemas/`; a market adds fields, never a shape. Other first segments are
  content too; readers MAY ignore them.
- A prefix covers a path segment by segment: `offer` covers `offer` and `offer/x`, not `offerx`.

## 5. Control records

- **hosts:** `{ "urls": [origin, …] }`: 1 to 8 distinct origins, `https://host[:port]`, lower case,
  no path (`http` only on loopback, for tests). Where the profile's records live.
- **permissions:** `{ "writers": [{ "key": <address>, "paths": [prefix, …], "until"?: <ms> }, …] }`:
  at most 16 writers, each with at most 16 content-path prefixes. `until` is optional: whole
  milliseconds, 0 to 2^53 − 1. A writer without it has no end.
- A field not named here, at any level, makes the record invalid, so a later limit is never ignored.

## 6. Which record counts

A reader's view of a profile is a pure function of the records it holds and its clock `now`:

1. Records dated after `now + 600,000` are held back.
2. Record A is newer than B if `A.time > B.time`, or the times are equal and `A.id > B.id`.
3. At `hosts` and at `permissions`, the newest record is current.
4. At a content path, if the owner has any record there, the owner's newest is current. Otherwise
   the newest writer record the current permissions record allows: a writer whose `key` is `by`,
   one of its `paths` covers the record's path, and, if it has an `until`, the record's
   `time` < `until`.
5. A current record with a `null` body means the path is deleted.

So the owner wins at any path it wrote. Readers check `until` against the record's own time and no
clock; when a writer record arrived is the host's check (§8).

**Removing a writer** is setting its `until` to now, in a new permissions record. Nothing it already
wrote disappears: its records dated before `until` still count, and none dated after do. A key left
out of the permissions record, or a deleted permissions record, allows nothing, so every record that
key signed stops counting: an app does that only for a stolen key.

## 7. Private records

A private record's body is `{ "private": <base64url of an age file> }` and nothing else. The age
file is the envelope; it holds the canonical text of an object, for one or more reading keys: the
readers' `read` fields from their profile records, and usually the profile's own. Each reading key
is an age post-quantum hybrid recipient (`age1pq1…`, stanza `mlkem768x25519`); an app MUST NOT
make an envelope for any other kind. Each one adds about 2 KB, so the 65,536-byte cap allows about
30. A host checks a
private record like any other and cannot open it. Anyone can see that it exists, its path, time and
size, and how many reading keys it was made for. To remove a reader, write a new version for the
rest; a reader keeps what it already opened. There is no forward secrecy.

## 8. Hosts

A host is an HTTPS service with no keys, no accounts and no login: a record's signature is its only
credential. It is open: it takes signed records for any profile and serves them to anyone.

| Request | Answer |
|---|---|
| `POST /v1/records`, body NDJSON, one canonical record per line, at most 100 | NDJSON, one `{i, id?, ok, error?, message?}` per line |
| `GET /v1/records?profile=&after=` | NDJSON of stored records in the order taken, after the cursor `after`, for one profile if asked; header `forest-cursor`: the last sequence number |

A page is at most 1,000 records and 4,194,304 bytes: a host ends it before a line that would pass
that. Readers MAY refuse a larger page.

**Taking a record in**, in this order, error code in brackets:

1. The checks of §2 and §3 [`canonical`, `shape`, `path`, `key`, `version`, `time`, `body`,
   `control`, `hosts`, `permissions`, `size`, `signature`], and `time ≤ now + 600,000` [`future`].
2. Within a request, hosts and permissions records first, then the rest in the order sent.
3. It MUST become the current record at its path by §6, over what the host stores plus it
   [`older`, `permission`].
4. A writer record: when it arrives, its key MUST be listed for its path in the current permissions
   record, and that writer's `until`, if it has one, MUST be later than the host's clock
   [`permission`].
5. A host MAY refuse a content record by its own policy [`policy`]. It MUST NOT refuse a hosts or
   permissions record by policy, so a person can always move and always remove a writer key.

**Keeping.** A host keeps every current record. A record that stops being current is kept for a
number of days the host chooses (the reference host: 30) by its own clock, then deleted. A host MUST
NOT log network addresses. It SHOULD verify in native code with these same strict rules: OpenSSL's
defaults accept a small-order signature this protocol refuses.

## 9. Apps that hold keys

- Never store or send the seed. Keep keys on the device.
- Show what the profile key signs before it signs.
- Keep a copy of every record signed.
- Give another app a writer key, never the profile key; a different one for each profile, since a
  writer key named in two profiles links them.
- Set `time = max(now, newest known at that path + 1)`.
- Post every record to every host the hosts record names, hosts and permissions records first.
  To move, post a hosts record naming the new hosts to old and new, then the copies. To leave a
  host, send it deletes.

## 10. Test vectors

`test/vectors.json`: a hosts, profile, offer, permissions, writer's offer and delete record, each
with its wire text, signing input and id, for keys/'s `tutoring/seller` profile from its test seed
`00 01 … 1f`; the profile record's `read` is that profile's reading key. The seed, the profile key
and the reading key are pinned in `keys/test/vectors.json`, and checked there. The writer key's
private key is 32 bytes of `0x2a`. `test/vectors.test.ts` recomputes the records, and checks each
with node:crypto (Ed25519, SHA-256). The profile is `EofQN9U3MiKVmAo3Pyvuw19WjyYbpddfN52E1Q1uBwhu`;
every signing input begins `ff 66 6f 72 65 73 74 2f` (`0xff`, then `forest/`).

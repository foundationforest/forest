# Forest data protocol, v1

**Status:** the adopted design (30 September 2026). Devnet only: nothing here is shipped. The
library in this folder implements every MUST below, and `test/` checks it. MUST, SHOULD and MAY
are used as in RFC 2119.

One idea: a profile is a public key; everything it says is a small signed JSON entry; hosts are
plain HTTPS stores that check signatures and keep entries in the order they took them in; at each
path the newest version counts, and what the owner wrote outranks what any delegate wrote.

## 1. Keys

**Seed.** HKDF-SHA256 of the passkey's PRF output, with info `forest.foundation/seed/v1`. The PRF
input is the UTF-8 of `forest.foundation/prf/v1`. All HKDF below is HKDF-SHA256 with an empty
salt and a 32-byte output.

| Key | Derivation | Use |
|---|---|---|
| profile key, profile `n` | ed25519 secret = HKDF(seed, `forest.foundation/profile/<n>/wallet/v1`) | the profile's name, its signatures, its Solana wallet |
| box key, profile `n` | 32 bytes = HKDF(seed, `forest.foundation/profile/<n>/box/v1`), used as an age post-quantum hybrid identity: `bech32("AGE-SECRET-KEY-PQ-", bytes)`, upper case | opening sealed entries |

**Names.**
- A profile's name is the did:key of its ed25519 public key: `did:key:z` + base58btc(`ed 01` ‖ key).
- The same 32 bytes in base58 are its Solana address.
- A did:key has exactly one spelling: decoding and re-encoding MUST give the same text.

**Usable keys.** A key named anywhere in this protocol (`profile`, `by`, a grant's `to`) MUST:
- be a canonical point encoding;
- be in the prime-order subgroup;
- not be of small order.

Anything else is refused.

**What a profile key signs.** A profile key signs these three things and nothing else:

| What | Signed bytes begin with | Why they cannot be confused |
|---|---|---|
| a Solana transaction | the message header (first byte < 0x80, or 0x80 for v0) | Solana's own format |
| a Forest entry | `0xff` then `forest.foundation/entry/v1\n` | `0xff` never begins a Solana message (version 127 does not exist) |
| a Pkarr packet | `3:seqi` (BEP-44) | cannot begin with `0xff`; too short to hold the accounts its header would ask for |

A new use MUST begin with bytes none of these can begin with. A signing function MUST derive the
public key from the secret itself; it never accepts a public key alongside the secret.

## 2. Canonical values

Every JSON value in an entry is in this narrowed JSON:
- strings without lone surrogates;
- whole numbers within ±(2^53 − 1) (money and coordinates are decimal text: `"30"`, `"38.72"`);
- `true`, `false`, `null`;
- arrays without holes;
- objects whose keys match `^[a-z][a-zA-Z0-9]{0,63}$`;
- nested at most 16 deep.

The canonical text of a value is RFC 8785 (JCS). Because keys are ASCII, UTF-16 key order and
UTF-8 key order are the same.

**Wire rule.** An entry travels as exactly its canonical text. A reader MUST re-serialize what it
parsed and refuse the entry unless the result equals the bytes it received. This refuses:
- duplicate keys;
- other key orders;
- whitespace;
- other escapes;
- other number spellings.

## 3. Entries

```
{ "v": 1, "profile": <did:key>, "path": <path>, "time": <ms since 1970>,
  "body": <object> | null, "by"?: <did:key>, "grant"?: <64 hex>, "sig": <base64url> }
```

- **`v` and fields.** `v` MUST be 1. No other top-level field is allowed.
- **`time`.** Whole milliseconds since 1970, 0 ≤ time ≤ 2^53 − 1. It orders the signer's own
  versions and nothing else.
- **`body`.** `null` means delete.
- **Owner entries.** An owner entry has neither `by` nor `grant`.
- **Delegate entries.**
  - Have both. `by` MUST differ from `profile`.
  - `grant` is the id of the exact grant version the delegate signs under.
  - A delegate entry MUST NOT be at a control path.
- **`sig`.** Ed25519 (RFC 8032) over the signing input, base64url without padding (86 characters).
  - The signer is `by` if present, else `profile`.
- **Verification** is strict:
  - S < L;
  - canonical encodings;
  - R and the key in the prime-order subgroup, the key not of small order;
  - then the cofactorless equation.

  With both points torsion-free, cofactored and cofactorless verifiers agree.
- **Signing input:** `0xff` ‖ UTF-8(`forest.foundation/entry/v1\n`) ‖ UTF-8(canonical text of the
  entry without `sig`).
- **Id:** lowercase hex of SHA-256(signing input). A second spelling of a signature is not a new
  entry.
- **Size:** the canonical text is at most 65,536 bytes. Larger content goes in blobs addressed by
  SHA-256 (not specified in this draft).

## 4. Paths

- **Grammar.** A path is 1 to 4 segments separated by `/`, each `[a-z0-9][a-z0-9._-]{0,63}`, at
  most 256 bytes in all.
- **Control paths** (owner only):
  - `folder`, exactly;
  - `grant/<id>`, exactly two segments.
- **Content kinds** indexes read:
  - `profile` (the card);
  - `offer/<id>` (an offer or a request, by its `direction`);
  - `review/<id>`;
  - `proof/<id>` (a credential is one kind of proof).

  Their bodies' shapes are JSON Schemas in `schemas/`. A market adds fields to them, never a new
  shape.
- **Other kinds.** Other first segments are content too; readers MAY ignore them. Private notes and,
  later, personal data are examples.
- **Prefix matching.** A prefix covers a path segment by segment: `offer` covers `offer` and
  `offer/x`, not `offerx`.

## 5. The merge

A reader's view of a profile is a pure function of its **feeds** and its clock `now`.
- A feed is checked entries in the order one source took them in: a host's feed, read by cursor
  (§7), or an app's own copies in the order it made or got them.
- A feed filtered to one profile keeps all the order the merge uses, which is per profile.

1. **Future.** Entries with `time > now + 600,000` are held back.
2. **Order of versions.** Version A is newer than B if `A.time > B.time`, or the times are equal
   and `A.id > B.id`.
3. **Control paths.** Only owner entries count; the newest is current.
4. **Delegate entries, feed by feed.** Walk each feed in its order, keeping, for each grant path,
   the newest owner version seen so far. A feed **takes in** a delegate entry E if, at E's place in
   that feed:
   - the newest owner version at the path of E's grant is exactly the version E names, and its body
     is not null;
   - that grant's `to` equals E's `by`;
   - one of the grant's `paths` covers E's path;
   - E's `time ≤ until`.

   E **counts** if any feed takes it in.
5. **Content paths.**
   - If any owner entry exists at the path, the newest owner entry is current, and delegate entries
     there do not count.
   - Otherwise the newest delegate entry that counts is current.
6. **Deletes and history.** A current version with a `null` body means the path is deleted. Older
   versions that count are history, kept by hosts for `keep` days (§7).

Consequences:
- **Revoking ends a grant from then on.** Deleting a grant, editing it (a new version) or reviving
  it (a new version after a delete) ends the earlier version for everything after it in each feed.
  What a feed took in before stays, whenever it is read.
- **`until`.** Hosts refuse delegate entries that arrive after `until` by their own clock (§7). A
  reader checks only the entry's claim, `time ≤ until`. There is no expiry by the reader's clock.
- **A feed's order is its host's word.** A host could place a late entry before a revocation for
  readers that come later. The owner overrides any delegate entry by writing at its path.

## 6. Control entries

**Folder** (`folder`): `{ "hosts": [origin, …], "box"?: <age recipient>, "keep"?: <days> }`.
- `hosts` has 1 to 8 distinct origins: `https://host[:port]`, lower case, no path. `http` is
  allowed only on loopback, for tests.
- `box` is `age1pq1…` (post-quantum hybrid) or `age1…`.
- `keep` is 0 to 3650, default 30.
- A folder whose body is `null` closes the profile.
- Any other field makes the folder invalid.

**Grant, a permission** (`grant/<id>`): `{ "to": <did:key>, "paths": [prefix, …], "until": <ms>, "label"?: <text>, "client"?: <text> }`.
- **Optional and off by default.** Nobody holds a grant unless the person approves one (§12).
- `to` is the one key that may sign under it.
- `paths` is 0 to 16 content prefixes; control paths are never allowed. An empty list grants
  nothing.
- `label` and `client` are at most 200 characters each; they are for the person's app.
- Any other field makes the grant grant nothing. A reader that does not know a field fails closed,
  so a later limit (for example on payments) can never be silently ignored.
- A delegate cannot grant: there is no re-delegation.

## 7. Hosts

A host is an HTTPS service. It holds no keys, has no accounts, and needs no login: an entry's
signature is its only credential.

| Request | Answer |
|---|---|
| `POST /v1/entries`, body: NDJSON, one canonical entry per line, at most 100 | NDJSON, one `{i, id?, ok, error?, message?}` per line |
| `GET /v1/entries?after=&profile=&badged=1&limit=` | NDJSON of stored entries in arrival order; header `forest-cursor`: the last sequence number |

**Feeds.** A host numbers entries in the order it takes them in and serves them in that order.
Three filters, in any combination:
- `after`: only entries after this cursor.
- `profile`: one profile's entries.
- `badged=1`: only profiles the host counts as badged. What counts is the host operator's choice,
  by design: typically a registry line naming the profile key, since that key is the one a badge
  names, proven against the root of an issuer the operator trusts. A host that checks nothing
  counts no profile as badged. A profile badged later shows from then on; a reader that wants its
  earlier entries reads it by `profile`.

`limit` is at most 1000 lines a page. A page is at most 4 MB (4,194,304 bytes): a host ends it
before a line that would pass that. Readers MAY refuse a larger page.

**Taking an entry in.** In this order; the error code is in brackets.
1. Checks:
   - the canonical wire rule [`canonical`];
   - the entry's shape [`shape`, `path`, `key`, `version`, `time`, `body`, `control`, `folder`, `grant`, `size`];
   - the signature [`signature`];
   - `time ≤ now + 600,000` [`future`].
2. Order within a request: folders first, so a new profile arrives in one request; the rest in the
   order sent. That is the order the feed shows.
3. A folder:
   - For a profile the host never held, the folder MUST name the host [`not-named`].
   - For a profile it holds or held, the folder MUST be newer than the one it has [`stale`].
4. Anything else:
   - the host MUST hold the profile: its current folder names the host [`not-held`];
   - a delegate entry MUST NOT be at a path the owner wrote [`grant`];
   - a delegate entry MUST be taken in by the host's own feed as it arrives (§5, rule 4), and the
     host's clock MUST NOT be past the grant's `until` [`grant`]. What it took in before a
     revocation stays.

**Policy.** What a host refuses beyond these checks is its own policy [`policy`]. The protocol
gives it two things to decide by, and nothing more:
- every entry's signature, which says which key wrote it;
- the public registry, which says which keys hold a badge.

The protocol sets no budgets. A host MUST NOT refuse a newer folder for a profile it holds or
held, so a person can always leave.

**Keeping and forgetting.**
- While a host holds a profile, it keeps every current version forever, and every grant version a
  kept delegate version names, so a reader that comes later can still place it.
- It keeps a version that stopped counting for `keep` days, measured by its own clock from that
  moment, then deletes it.
- When a profile's current folder no longer names the host, or is `null`, the host keeps only that
  folder and the current deletes, for good. Everything else it forgets after `keep` days. So an
  old folder or old entries replayed after a move are refused or forgotten.

A host MUST NOT log network addresses.

**Checking signatures in production.** Hosts and indexes SHOULD verify in native code, with the
same strict rules (§3). On this machine native Ed25519 checked about 10,000 signatures a second on
one core; this prototype's strict pure JavaScript, about 340. A native library's defaults are not
enough: OpenSSL accepts a signature this protocol refuses (the small-order case), so the key rules
and the subgroup check on R must be added.

## 8. When a host closes, or blocks a reader

Nothing lasting is lost, because a host holds nothing only it can give:
- **Every entry is on every host in the folder,** and the app keeps its own copies (§10). A reader
  that a host blocks, or finds gone, reads another host or an index. An entry checks the same
  wherever it comes from.
- **Moving is copying.** The app publishes a folder without that host, naming a new one, and posts
  its copies there. Ids do not change: the profile's name is its key, not a host's address.
- **No account to lose and no key held,** so a host cannot lock a person out; it can only stop
  serving.

What goes with a closed host: versions no other host or copy has, and its own arrival order (other
hosts' orders remain). A new host refuses delegate entries whose grant is past `until` by its
clock, so those stay only on the hosts that took them in time.

## 9. Discovery

There is no directory and no relay. A reader finds hosts by:
1. reading the signed folder on any host it knows;
2. crawling: following the hosts named in the folders it reads;
3. pings: apps MAY tell indexes about new profiles (outside this protocol);
4. optionally Pkarr: a signed DNS packet on the Mainline DHT, keyed by the profile key itself.
   - It holds one TXT record per host: name `_forest`, value `host=<origin>`, TTL 3600.
   - It is signed by the profile key (BEP-44).
   - The folder is authoritative; the packet is a hint.
   - An app SHOULD hand the signed packet to its hosts to publish and republish (about hourly),
     and SHOULD NOT reach the DHT or a relay from the person's device.
   - Readers MUST check the BEP-44 signature themselves or use a client that does. The official JS
     client's `SignedPacket.fromBytes` does not.

## 10. Writers

- **Time.** A writer sets `time = max(now, newest known version at that path + 1)`.
- **Every host, and a copy.** An app posts every entry to every host in the profile's folder, and
  keeps its own copy of every entry it makes or gets for its profiles, in order. A reader merges
  what it finds on all of them.
- **Moving hosts.**
  1. Publish a folder naming the new host, to the new and old hosts.
  2. Copy all entries, in order, from the app's copies or an old host, to the new one.
  3. Publish a folder without the old host.
- **Passkey signatures** are never published: one passkey serves every profile, and its key would
  link them.

## 11. Sealed entries

Available from day one, to any writer: the owner, or a delegate under a grant covering the path.

A sealed body is `{ "sealed": <base64url of an age file> }`, and nothing else.
- **Plaintext.** The canonical text of an object.
- **Recipients.**
  - The readers' `box` recipients, read from their own signed folders, and the profile's own.
  - Post-quantum hybrid (`mlkem768x25519`) SHOULD be used.
  - age names no recipient in the file.
- **Hosts** check a sealed entry like any other (signature, grant, path) and cannot read it. They
  see that it exists, its path, time and size, and the number of readers (one header line each).
- **Removing a reader.** A new version sealed to the rest. A reader keeps what it already opened,
  and the old version stays on hosts for `keep` days.
- **No forward secrecy.** A box key that leaks opens every entry ever sealed to it.

## 12. Connections

Apps and assistants alike: the protocol has no notion of either. A connection is any program that
works for a person.

**By default a connection holds nothing:** no key, no grant, no store of drafts. It reads public
entries, drafts an approval request, and hands the person its link. The person's device shows the
exact entry, signs it after one tap and a passkey, and posts it to the profile's hosts. A draft
waits in its link until the person returns. The program learns the outcome by reading the
profile's hosts: the owner's current version at that path, with that body. There is no reply.

**Approval request.**

```
{ "v": 1, "profile": <did:key>, "path": <path>, "body": <object> | null, "hosts": [origin, …] }
```

- `profile`, `path` and `body` are the owner entry proposed (§3), without `time` and `sig`.
- `path` is a content path or `grant/<id>`, never `folder`: a person changes where they live in
  their own app.
- `body` is not sealed: the page must show what it signs.
- `hosts` is 1 to 8 origins where the profile's folder can be read. They are hints: the page posts
  to the hosts the profile's signed folder names.
- No other field.

**Link.** The approval page's URL, then `#`, then base64url (no padding) of the request's canonical
text (§2). The page MUST refuse a link whose text is not canonical or whose request breaks these
rules. After `#`, the request never reaches the page's server.

**Permission.** A permission is a grant (§6), asked for like any entry: an approval request at
`grant/<id>` whose body is the grant, naming the key that will sign. Taking it back is an approval
of `null` at the same path, or the person's own app deleting it.

**An always-on signer of the person's own.** A person who wants some things published while their
phone is off can run a signer of their own: a small always-on program, on a machine they control,
with its own key and a narrow grant (for example `offer`, for 30 days). Programs send it approval
requests. It signs with its own key the ones its grant covers and passes the rest on as links. It
never holds the profile key; its key can do only what the grant says, until the person revokes it
with one approval. Whoever runs a signer can act within its grants while it runs, which is why the
one to hold a grant is the person's own.

**The approval page** is the one place the seed is opened. It MUST:
- get the PRF output with user verification, and make the seed;
- find the request's profile among profile indexes 0 to 15, and refuse otherwise;
- read the profile's entries from the request's hosts and check them;
- show the request as plain text, never HTML, before the tap;
- sign with the time rule (§10), and post to every host in the profile's folder;
- keep a copy on the device, and wipe the seed.

It SHOULD be served from an immutable build whose hash and library list are published, with a
strict Content-Security-Policy: `script-src 'self'`, `require-trusted-types-for 'script'`,
`trusted-types 'none'`, `frame-ancestors 'none'`. Here its bundle holds four libraries:
`@noble/curves`, `@noble/hashes`, `@scure/base` and `canonicalize`.

**A service for assistants (informative).** `src/connections.ts` is an MCP server (2026-07-28,
stateless) with no login and two tools:
- `forest_read` returns a profile's public entries;
- `forest_draft` answers `input_required` with the approval link (URL mode). When the client
  returns, it reads the profile's hosts and answers that the entry is published, or that the
  draft waits in its link.

It holds nothing, so a second copy of it gives the same answers. Any program can make approval
links without it.

## 13. Test vectors

`test/vectors.json`, from the test seed `test/keys.json` pins (PRF `00 01 … 1f`), profile 0.
`test/vectors.test.ts` recomputes them and checks each with OpenSSL and a second SHA-256.

- profile 0: `did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL`, address
  `Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx` (the wallet `test/keys.json` pins)
- a delegate key, 32 bytes of `0x2a`: `did:key:z6MkgAnvkP45uNxwCKeNdt6wrYkEjpYX4f7Nrd8MQqFL8Fbn`
- an offer, id `6329b8bbb840aad79762742f0edd2dde2d63e4d22ef0093ac4ecff160e668222`:

```
{"body":{"createdAt":"2026-09-21T13:33:20Z","description":"One hour of maths tutoring, online.","direction":"offer","price":{"amount":"30","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","per":"hour"}},"path":"offer/maths","profile":"did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL","sig":"Dso2ITMCDYNHu9Edqftt7Ji9om-VD-LmueMJjaI3xVLfaN8ppkwKRfKtXKlVRzZ-_lfqIjPwtG7JxHgHif1KBQ","time":1790000000000,"v":1}
```

- the grant it signs for the delegate, id `706dac68c691b107d76774a9ddf0aa60b55525ac4faae22032c8f6c236f5a918`:

```
{"body":{"label":"My signer, offers only","paths":["offer"],"to":"did:key:z6MkgAnvkP45uNxwCKeNdt6wrYkEjpYX4f7Nrd8MQqFL8Fbn","until":1790604800000},"path":"grant/signer1","profile":"did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL","sig":"g7TDa4UUNG-e3jnE7hftFurJ_1oLT20I96qKbmHsTBt5h-xLap4znAxZWD1QTfxeDj48xgD_ne259hsIidUqBA","time":1790000000000,"v":1}
```

- the delegate's offer under it (`by`, `grant`), id
  `5931b4f19e511d01156e546883c78799779ec98a79d8c0db88d8563881f732e6`, and the delete of the first
  offer, id `f564b45a62b246ccb6aa1ccc6e3b994731052143fcac90b14209217cd1c30877`: see the file.
- every signing input begins `ff 66 6f 72 65 73 74 2e` (`0xff`, then `forest.`).

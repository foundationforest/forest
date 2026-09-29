# Protocol 2: the spec

Short and exact. The code in `src/` implements it and `test/vectors.json` pins the bytes; another
implementation that produces those bytes from those inputs is conformant. When this text and
`src/entry.ts` differ, both are wrong. Version 1. Nothing is shipped.

## 1. Words

- **Profile.** One folder of records, named by a key. A person may hold many; nothing public joins them.
- **DID.** The profile's name: `did:key` of its ed25519 signing key (W3C did:key, unchanged).
- **Entry.** One signed step in a profile's log. Every entry names the one before it.
- **Log.** The ordered entries of one profile. The folder is what the log says now.
- **Record.** The current value at a collection and a key: what an entry put there last.
- **Grant.** An entry by the profile key that lets another key write, within limits.
- **Pointer.** A signed statement of which hosts serve the log, in the form the BitTorrent DHT stores.
- **Host.** A server that stores logs, pointers and blobs, verifies, and signs nothing.
- **Index.** Anything that reads hosts, verifies for itself, and keeps state. Anyone can run one.
- **Delegate.** A key the profile granted: an AI agent, a laptop, a product's server.
- **Reader.** An X25519 key a private record is addressed to.

## 2. Keys

The seed comes from a passkey exactly as `keys/SPEC.md` says (its steps 1, 2, 7 and 8 are
unchanged, and its HKDF is the one used here). For profile `n`:

| Key | HKDF-SHA256(seed, empty salt, info, 32) | Curve | Role |
|---|---|---|---|
| signing | `forest.foundation/profile/<n>/signing/v2` | ed25519 | the DID; signs entries, pointers, permits |
| reader | `forest.foundation/profile/<n>/reader/v2` | X25519 | opens private records addressed to the profile |
| wallet | `forest.foundation/profile/<n>/wallet/v1` | ed25519 | the Solana wallet, unchanged from the recipe |

The identity secret and the central wallet are unchanged. There is no control key: nothing rotates
the signing key (see `README.md`, "Identity is the key"). A delegate's keys are random, made where
the delegate runs, never from anyone's seed.

`did:key` encoding: `did:key:z` + base58btc(multicodec prefix + 32-byte public key); the prefix is
`0xed 0x01` for ed25519 and `0xec 0x01` for X25519. A profile DID is 56 characters.

## 3. Encoding and signing

Every signed or hashed structure is DAG-CBOR (IPLD's deterministic CBOR: sorted keys, no
undefined, CIDs as tag 42). A reference is a CIDv1 (dag-cbor, sha2-256) of the encoded bytes;
a blob's is CIDv1 (raw, sha2-256).

An ed25519 signature is over a fixed context string followed by the DAG-CBOR bytes of the
structure without its `sig` field:

| Structure | Context |
|---|---|
| entry | `forest/entry/1` |
| permit | `forest/permit/1` |
| pointer | BEP44's `3:seqi<seq>e1:v<len>:<bytes>` (no context; the DHT's own rule) |

## 4. The entry

```
Entry = {
  v:    1
  did:  text          the profile, a did:key of an ed25519 key
  seq:  uint          0 for the first entry, then +1 each
  prev: CID | null    the previous entry's CID; null only at seq 0
  at:   uint          the writer's clock, unix seconds
  op:   "put" | "del" | "grant" | "revoke" | "keys"
  by?:  text          the delegate's did:key, when a delegate signed
  via?: CID           the grant entry's CID; present exactly when `by` is
  col?: text          collection, 1..256 chars (put and del of a public record)
  key?: text          record key, 1..512 chars (put, del)
  rec?: map           the record (public put), or the op's own record (grant, revoke, keys)
  enc?: Enc           the ciphertext (private put)
  sig:  bytes(64)     by `by` if present, else by `did`
}
```

An encoded entry is at most 65,536 bytes. Fields allowed per op, and nothing else:

| op | fields | meaning |
|---|---|---|
| put | col, key, rec | a public record: `rec` is any map |
| put | key, enc | a private record: `key` is opaque, `enc` per section 7 |
| del | col?, key | delete the record at (col, key), or the private record at key when `col` is absent |
| grant | rec = Grant | let `rec.to` write, within `rec` |
| revoke | rec = { grant: CID } | end that grant |
| keys | rec = { reader: did:key X25519 } | publish the profile's reader key |

`by` may appear only on put and del. `grant`, `revoke` and `keys` are signed by the profile key.

```
Grant = {
  to:       text        the delegate's did:key (ed25519)
  reader?:  text        the delegate's reader did:key (X25519)
  cols:     [text]      public collections it may write; "*" for any
  ops:      ["put" | "del"]  at least one
  private?: bool        may write and delete private records
  exp:      uint        unix seconds; entries with a later `at` are refused
  max?:     uint ≥ 1    at most this many entries under this grant
  note?:    text ≤ 1000
}
```

## 5. The rules

The state of a log is folded from its entries in order. An entry is valid against a state when
all of these hold, checked in this order, each with the name a refusal carries:

1. `shape`: the shape above. `size`: at most 65,536 bytes.
2. `seq`: equals the head's seq + 1, or 0 with no head. `prev`: equals the head's CID.
3. When `by` is present: `unknown-grant` unless `via` is a grant entry earlier in this log;
   `not-granted` unless that grant's `to` is `by`; `revoked` if a revoke of it appears earlier;
   `expired` if `at` is after its `exp`; `scope` unless `op` is in its `ops`, and, for a public
   record, `col` is in its `cols` or `cols` holds `"*"`, and, for a private record, `private` is
   true; `limit` if `max` entries have already been written under it.
4. `signature`: the signature verifies under the signer's key over the context and the bytes.

Then the state changes: the head moves; a put sets the record, a del removes it; a grant is
added under the entry's CID with a use count of 0; a revoke marks it (a revoke of a grant not in
the log is `unknown-grant`); keys sets the reader; a delegate's entry adds one to its grant's
use count.

What is not a rule: `at` is not checked against the previous entry or any clock by the verifier.
A host refuses an entry whose `at` is more than 300 seconds from its own clock (`clock`), which
is what makes expiry mean anything. Only the chain makes revocation mean something, and it
needs no clock.

Forks: two valid entries with the same `seq` and `prev` can exist only if the same key signed
both. A host keeps the first it saw and refuses the other (`seq` or `prev`, HTTP 409). An index
that sees both keeps the one it saw first and marks the profile forked.

## 6. The pointer

A BEP44 mutable item (BitTorrent's DHT, BEP 44), as Pkarr carries them:

```
payload = sig(64) || seq as big-endian uint64 (8) || DNS packet (≤ 1000 bytes)
sig     = ed25519(profile signing key, "3:seqi" + seq + "e1:v" + len(packet) + ":" + packet)
seq     = unix time in microseconds when signed
packet  = a DNS response with one answer:
          TXT  _forest.<z-base32 of the public key>.  "v=1"  "hosts=<url>,<url>,…"
```

Newest `seq` wins; a store refuses a lower or equal `seq`. The same bytes go, unchanged, to any
Pkarr relay (`PUT /<z-base32 key>`; verified live against `relay.pkarr.org`), to any host
(`PUT /pointer/<did>`), and to any index. A reader asks whatever sources it has and keeps the
newest payload whose signature verifies. The DHT is a neutral fallback, not a dependency: a
profile whose host is already known needs no DHT lookup.

## 7. Private records

```
Enc = {
  alg: "A256GCM+HPKE(X25519,HKDF-SHA256,A256GCM)"
  iv:  bytes(12)
  ct:  bytes          AES-256-GCM(cek, iv, aad, DAG-CBOR({ col, key, rec }))
  to:  [{ kid: text, enc: bytes(32), ct: bytes(48) }]   one per reader
}
aad     = "forest/private/1|" + did + "|" + opaque key
cek     = 32 random bytes, one per entry
to[i]   = HPKE base mode (RFC 9180; DHKEM X25519 HKDF-SHA256, HKDF-SHA256, AES-256-GCM),
          info "forest/private/1", aad = kid, sealing cek to the reader's X25519 key
```

The entry's `key` is opaque (16 random bytes, base64url); the real collection and key are inside
the ciphertext. An update reuses the opaque key. What a host or anyone else sees: the ciphertext's
length, the opaque key, the readers' key ids, the writer, the time. A reader added later cannot
open earlier records; a reader dropped later keeps what it could already open.

## 8. Blobs

A blob (a photo, a video) is stored by content id and pointed at from a record as the shapes
already do. Storing one needs a permit:

```
Permit = { did, cid: text, exp: uint, by?: text, via?: text, sig: bytes(64) }
```

signed with context `forest/permit/1` by the profile key, or by a delegate whose grant is live
and allows `put`. A blob nothing points at may be dropped by a host after `exp`.

## 9. The host

HTTP, no accounts, no sessions, no cookies, no address kept. One SQLite file. Anyone may send any
valid entry; the signature is the authorisation.

| Method and path | Does |
|---|---|
| `POST /log/{did}` (body: one entry, DAG-CBOR) | verifies against the log's state and stores; 201 `{seq, cid}`; 409 with the head on `seq`/`prev`; 400 with the refusal's name otherwise |
| `GET /log/{did}?since=N` | `{did, head, entries: [base64url bytes]}` from seq N |
| `GET /state/{did}` | head, reader, grants (with use counts and revocations), record counts per collection |
| `GET /record/{did}/{col}/{key}`, `GET /records/{did}/{col}` | current public records, as JSON |
| `GET /private/{did}` | the current private entries (ciphertext) |
| `GET`/`PUT /pointer/{did}` | the pointer payload; a lower `seq` is refused |
| `GET /changes?since=C&limit=L` | everything stored, in the host's own order, for indexes |
| `POST /pull` `{did, from}` | copies a log from another host, verifying each entry |
| `POST /blob/{did}` (header `x-forest-permit`), `GET /blob/{did}/{cid}` | blobs |

A host recomputes state incrementally: verifying an entry costs the same at seq 1,000 as at seq 1.

## 10. The index

Follows hosts through `/changes`; verifies every entry against its own state with the rules in
section 5; keeps every entry; finds profiles by the DIDs that appear in records (a review's
`subject`, a link) and resolves their pointers through the DHT, the hosts it knows, or another
index; learns each profile's pointer as it meets it, so it can answer for it; re-resolves pointers
to follow moves; marks forks; records every refusal with its name and the host that served it.
Everything an index shows can be recomputed by anyone from the same public bytes.

## 11. What is borrowed and what is new

| Piece | Source | Changed? |
|---|---|---|
| Passkey → seed, seed file, 24 words | `keys/SPEC.md` | no |
| HKDF-SHA256 per key | RFC 5869, `keys/src/hkdf.ts` | two new labels, one label dropped |
| did:key | W3C did:key | no |
| ed25519, X25519, SHA-256 | `@noble/curves`, `@noble/hashes` (audited) | no |
| DAG-CBOR, CID | IPLD, `@ipld/dag-cbor`, `multiformats` | no |
| HPKE | RFC 9180, `@hpke/core` | no |
| AES-256-GCM | Web Crypto | no |
| BEP44 mutable item, Pkarr relay, z-base32, DNS packet | BitTorrent BEP 44, Pkarr, RFC 1035, `dns-packet` | the TXT record's name |
| Delegation shape | UCAN 1.0's field meanings (issuer, audience, subject, command, policy, expiry, proof by CID, revocation by CID) | the policy is five fixed limits, not a predicate language; chains are one deep |
| SQLite, HTTP | Node's own | no |
| The entry's field set and section 5 | **new**, about 280 lines | the thing to audit |

## 12. Reading order for an auditor

`entry.ts` (the rules), `did.ts`, `keys.ts`, `codec.ts`; then `private.ts`, `pointer.ts`,
`permit.ts`; then `host.ts`, `client.ts`, `index.ts`. Then `test/0-vectors.test.ts` and the claim
tests in order. About 1,300 lines of source, 1,200 of tests.

## 13. Constants

| Name | Value |
|---|---|
| entry context | `forest/entry/1` |
| permit context | `forest/permit/1` |
| HPKE info | `forest/private/1` |
| private aad | `forest/private/1|<did>|<opaque key>` |
| pointer record | `_forest.<z-base32 key>` TXT `v=1`, `hosts=…` |
| entry size limit | 65,536 bytes |
| collection, key length | 256, 512 |
| host clock tolerance | 300 s |
| DHT packet limit | 1,000 bytes |

A change to any of these is a new version, with a new number in the context strings.

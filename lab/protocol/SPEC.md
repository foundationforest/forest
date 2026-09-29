# Forest data protocol, lab draft v1

**Status:** a lab draft for a decision. Nothing here is shipped. The prototype in this folder
implements every MUST below, and `test/` checks it. MUST, SHOULD and MAY are used as in RFC 2119.

One idea: a profile is a public key; everything it says is a small signed JSON entry; hosts are
plain HTTPS stores that check signatures; at each path the newest version counts, and what the
owner wrote outranks what any delegate wrote.

## 1. Keys

**Seed.** The seed is keys/SPEC.md's: HKDF-SHA256 of the passkey's PRF output, with info
`forest.foundation/seed/v1`. All HKDF below is HKDF-SHA256 with an empty salt and a 32-byte output.

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
- **Other kinds.** Other first segments are content too; readers MAY ignore them. Private notes and,
  later, personal data are examples.
- **Prefix matching.** A prefix covers a path segment by segment: `offer` covers `offer` and
  `offer/x`, not `offerx`.

## 5. The merge

A reader's view of a profile is a pure function of the entries it holds and its clock `now`. It
takes checked entries whose `profile` is that profile.

1. **Future.** Entries with `time > now + 600,000` are held back.
2. **Order.** Version A is newer than B if `A.time > B.time`, or the times are equal and `A.id > B.id`.
3. **Control paths.** Only owner entries count; the newest is current.
4. **Live grants.**
   - A grant is live if its version is current at its `grant/<id>` path, its body is not null, and
     `now ≤ until`.
   - Its id is the id of that version.
5. **Content paths.**
   - If any owner entry exists at the path, the newest owner entry is current, and delegate entries
     there do not count.
   - Otherwise the newest delegate entry that counts is current. A delegate entry counts when:
     - its `grant` names a live grant;
     - that grant's `to` equals its `by`;
     - one of the grant's `paths` covers its path;
     - `grant.time ≤ time ≤ until`.
6. **Deletes and history.** A current version with a `null` body means the path is deleted. Older
   versions that count are history, kept by hosts for `keep` days (section 7).

Consequences:
- **Revoke.** Deleting a grant, editing it (a new version) or reviving it (a new version after a
  delete) ends everything signed under the earlier version.
- **Expiry.** It ends everything signed under the grant when `now` passes `until`, whatever
  `time` the delegate claimed.
- **Keeping.** The owner keeps a delegate's work by re-signing it as an owner entry (section 10).

## 6. Control entries

**Folder** (`folder`): `{ "hosts": [origin, …], "box"?: <age recipient>, "keep"?: <days> }`.
- `hosts` has 1 to 8 distinct origins: `https://host[:port]`, lower case, no path. `http` is
  allowed only on loopback, for tests.
- `box` is `age1pq1…` (post-quantum hybrid) or `age1…`.
- `keep` is 0 to 3650, default 30.
- A folder whose body is `null` closes the profile.
- Any other field makes the folder invalid.

**Grant** (`grant/<id>`): `{ "to": <did:key>, "paths": [prefix, …], "until": <ms>, "label"?: <text>, "client"?: <text> }`.
- `paths` is 0 to 16 content prefixes; control paths are never allowed. An empty list grants
  nothing: a drafts-only connection proves the owner's consent and is not published.
- `label` and `client` are at most 200 characters each; they are for the owner's app.
- Any other field makes the grant grant nothing. A reader that does not know a field fails closed,
  so a later limit (for example on payments) can never be silently ignored.
- A delegate cannot grant: there is no re-delegation.

## 7. Hosts

A host is an HTTPS service. It holds no keys, has no accounts, and needs no login: an entry's
signature is its only credential.

| Request | Answer |
|---|---|
| `POST /v1/entries`, body: NDJSON, one canonical entry per line, at most 100 | NDJSON, one `{i, id?, ok, error?, message?}` per line; status 429 if any line was refused for `busy` or `rate`, else 200 |
| `GET /v1/entries?profile=&path=&after=&limit=` | NDJSON of stored entries in arrival order after sequence `after`; `path` is a prefix; `limit` ≤ 1000; header `forest-cursor`: the last sequence number |
| `GET /.well-known/forest` | `{host, protocol, limits}` |

**Accepting an entry.** In this order; the error code is in brackets.
1. Checks:
   - the canonical wire rule [`canonical`];
   - the entry's shape [`shape`, `path`, `key`, `version`, `time`, `body`, `control`, `folder`, `grant`, `size`];
   - the signature [`signature`];
   - `time ≤ now + 600,000` [`future`].
2. Order within a request: folders first, then grants, then the rest, so a new profile arrives in
   one request.
3. A folder:
   - For a profile the host never held, the folder MUST name the host [`not-named`]. A profile
     without a badge is admitted within the new-profile budget [`busy`].
   - For a profile it holds or held, the folder MUST be newer than the one it has [`stale`].
4. Anything else:
   - the host MUST hold the profile: its current folder names the host [`not-held`];
   - within the key's rate [`rate`] and quota [`quota`];
   - a delegate entry MUST count under the host's own view and MUST NOT be at a path the owner
     wrote [`grant`].

**Keeping and forgetting.**
- While a host holds a profile, it keeps every current version forever.
- It keeps a version that stopped counting for `keep` days, measured by its own clock from that
  moment, then deletes it.
- When a profile's current folder no longer names the host, or is `null`, the host keeps only that
  folder and the current deletes, for good. Everything else it forgets after `keep` days. So an
  old folder or old entries replayed after a move are refused or forgotten.

**Budgets** are host policy, not protocol. The prototype's defaults:

| Key | Entries | Bytes | Writes a minute |
|---|---|---|---|
| without a badge | 100 | 256 KiB | 30 |
| with a badge | 20,000 | 64 MiB | 600 |

- New profiles without a badge: 1,000 an hour host-wide, and 5 an hour per network address.
- Address budgets are counted in memory under an HMAC with a key made each hour, and never logged.
- A host checks a badge by asking the registry about the key itself, because the key is the wallet.

A host MUST NOT log network addresses.

## 8. Discovery

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

## 9. Sealed entries

A sealed body is `{ "sealed": <base64url of an age file> }`, and nothing else.
- **Plaintext.** The canonical text of an object.
- **Recipients.**
  - The readers' `box` recipients, read from their own signed folders, plus the writer's own.
  - Post-quantum hybrid (`mlkem768x25519`) SHOULD be used.
  - age names no recipient in the file.
- **What a host sees.** That the entry exists, its path, time and size, and the number of
  readers (one header line each).
- **Removing a reader.** A new version sealed to the rest. A reader keeps what it already opened.
- **No forward secrecy.** A box key that leaks opens every entry ever sealed to it.

## 10. Writers

- **Time.** A writer sets `time = max(now, newest known version at that path + 1)`.
- **Several hosts.** A writer publishes every entry to every host in the profile's folder. A
  reader merges what it finds on all of them.
- **Keeping a delegate's work.** When a grant is revoked or expires, the owner's app lists what
  the delegate wrote. With one approval it re-signs, as owner entries, the ones the owner keeps.
- **Moving hosts.**
  1. Publish a folder naming the new host, to the new and old hosts.
  2. Copy all entries from an old host to the new one.
  3. Publish a folder without the old host.
- **The approval page** is the one place the seed is opened. It MUST:
  - get the PRF output with user verification;
  - find the request's profile among profile indexes 0 to 15, and refuse otherwise;
  - read the profile's folder from hosts and check it;
  - show the entry it will sign as plain text (never HTML);
  - sign, and publish to the folder's hosts;
  - then drop the seed.

  It SHOULD be served with a strict Content-Security-Policy (`script-src 'self'`,
  `require-trusted-types-for 'script'`) from an immutable build whose hash is published.
- **Passkey signatures** are never published: one passkey serves every profile, and its key would
  link them.

## 11. The door (informative)

An MCP server (2026-07-28) lets an assistant read, draft and write. It holds no person's key.

- **Connect.** In production this is MCP authorization: OAuth 2.1 with PKCE, the approval page as
  the consent screen.
  - The page signs a grant naming a key the door derives as HKDF(master key,
    `forest.door/agent/v1/<nonce>`), for a fresh nonce.
  - The token the client receives seals `{profile, grant id, nonce, hosts, client, exp}` with
    XChaCha20-Poly1305 under HKDF(master key, `forest.door/token/v1`).
  - The door stores nothing but a few minutes of pending approvals.
- **Write under the rule.** If the grant covers the path and the owner has not written there, the
  door signs with the agent key and publishes.
- **Write needing approval.** Otherwise the tool returns `input_required` with a URL-mode
  elicitation to the approval page and a `requestState` signed with HMAC (the SDK's codec). The door accepts the
  page's entry only if it is exactly the draft, signed by the profile's own key. On the client's
  retry it answers once.
- **Defaults.** Paths `["offer"]`, 7 days; reviews one at a time.

## 12. Test vectors

`test/vectors.json`, from keys/SPEC.md's test seed (PRF `00 01 … 1f`), profile 0.
`test/vectors.test.ts` recomputes them and checks each with OpenSSL and a second SHA-256.

- profile 0: `did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL`, address
  `Azh4zBXfQsXLKrrD6YanN7VZhpNyQot7vVdtB2r41UWx` (the wallet `keys/test/vectors.json` pins)
- the assistant key, 32 bytes of `0x2a`: `did:key:z6MkgAnvkP45uNxwCKeNdt6wrYkEjpYX4f7Nrd8MQqFL8Fbn`
- an offer, id `6329b8bbb840aad79762742f0edd2dde2d63e4d22ef0093ac4ecff160e668222`:

```
{"body":{"createdAt":"2026-09-21T13:33:20Z","description":"One hour of maths tutoring, online.","direction":"offer","price":{"amount":"30","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","per":"hour"}},"path":"offer/maths","profile":"did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL","sig":"Dso2ITMCDYNHu9Edqftt7Ji9om-VD-LmueMJjaI3xVLfaN8ppkwKRfKtXKlVRzZ-_lfqIjPwtG7JxHgHif1KBQ","time":1790000000000,"v":1}
```

- the grant it signs for the assistant, id `e422dbec919af75fdddfb4b8fcc0a61a57da49b09fcb40bd3716de4a0baa4b94`:

```
{"body":{"label":"Assistant, offers only","paths":["offer"],"to":"did:key:z6MkgAnvkP45uNxwCKeNdt6wrYkEjpYX4f7Nrd8MQqFL8Fbn","until":1790604800000},"path":"grant/assistant1","profile":"did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL","sig":"MTKC7yVLm9NV9vEJodLReiWN8AFERY-3hP_42aPlJ9nHoGMnkRYEsEaaCfPBj9hCl-UedqtGGN5cDAlTM4AzAw","time":1790000000000,"v":1}
```

- the assistant's offer under it (`by`, `grant`), id
  `a9967d0bde6455aa0670f379952c2f415bfd19783a49af713d4fc4b0d2166509`, and the delete of the first
  offer, id `f564b45a62b246ccb6aa1ccc6e3b994731052143fcac90b14209217cd1c30877`: see the file.
- every signing input begins `ff 66 6f 72 65 73 74 2e` (`0xff`, then `forest.`).

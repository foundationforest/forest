# Research notes: what exists for Forest's data layer

*Written in the lab (`lab/protocol/`, PR #36) and kept as written.*

Read on 29 September 2026, from primary sources where they could be reached (specs, repositories,
the authors' own posts). Anything taken from a secondary source, or not checked, says so. Nothing
here is Forest's design; that is `SPEC.md`, and the choice is argued in `REPORT.md`.

The needs, as numbered in the task:

1. Four record types (profile, offer, review, proof); anyone reads public records.
2. Only the owner, or writers the owner authorized, can write; nobody, hosts included, can forge.
3. AI and app writers act without holding the person's keys: one tap and a face scan per action,
   or standing rules the owner signed (scoped, time-limited, revocable) that work with the phone off.
   Agent payments under the same rules later.
4. Update = a new version on top; delete = an empty version; old versions pruned after 30 days
   unless the owner's rule says otherwise.
5. Anyone runs a host; a profile uses several; swappable any time; a host holds no keys, cannot
   forge, cannot read private data; moving is copying.
6. Indexes read hosts directly; no central directory or relay.
7. Nothing public ties two profiles of one person; name the metadata that still could.
8. Private data later without redesign: entries only chosen readers can read, revocable.
9. A profile's record identity and its wallet (Solana, ed25519) bound by its badge; consider one key.
10. The protocol cannot be corrupted; anyone can verify it; every trust point listed.
11. Small enough for one person to audit in a day; standard, reviewed cryptography.

## In one table

| Technology | Status, September 2026 | Best idea for Forest | Why not as is |
|---|---|---|---|
| Nostr | Active; specs still churn | Self-signed events any host can store; move by copying | secp256k1 only (no wallet key); no delegation anyone can check; deletion is a request |
| AT Protocol | Production for public data; private "Spaces" in alpha | Typed records in a signed, movable repository | Host signs by default; one host at a time; no Ed25519; scopes checked only by the host |
| Farcaster | Sold in January, looking for a new owner since August | A root key authorizes app keys; anyone checks | Needs a chain and a tiny validator set; app keys have no scope or expiry |
| Pubky | Beta, fast-breaking releases | Key -> Pkarr pointer -> HTTP host with a change feed; revocable app grants | Records unsigned (the host can forge); private area not encrypted; one host per key |
| Pkarr | Maintained (8.0.2, 23 Sep 2026) | A pointer from a key to its hosts with no operator | 1000-byte records, 2-hour life unless republished, lookups visible |
| Web5 DWN | Dormant since late 2024 | App signs with its own key and names the owner's grant | Spec has TODO gaps; its sponsor is gone |
| Willow + Meadowcap | Small team, no audit | Scoped, time-limited capabilities; deletion by prefix | No revocation; no history; a new hash (WILLIAM3); no discovery |
| UCAN 1.0 | v1.0.0 on 8 Jul 2026 | Conditions on delegated powers | Needs a revocation cache and trusted time for stored records; few, unaudited libraries |
| Keyhive, p2panda | Pre-alpha / unaudited | Group keys that heal after removal | Built for live documents and chat, not stored records |
| HPKE, age | RFC 9180 (successor in IESG review); age stable | Encrypt once, wrap the key to each reader | No audited JS HPKE; age's TypeScript library is by age's author on audited parts |
| MLS | RFC 9420; deployed (Wire, RCS) | Forward secrecy for groups | Needs one agreed order of changes per group |
| did:key, VC 2.0 | did:key a community draft; VC 2.0 a W3C Recommendation | Self-certifying key names; `eddsa-jcs-2022` | Heavier than Forest needs for its own entries |
| WebAuthn PRF | WebAuthn Level 3 a W3C Recommendation, 25 Aug 2026 | A seed from a passkey, phishing-resistant | Missing in some password managers |
| MCP | Spec 2026-07-28, stateless | Approval by URL, outside the AI client | Identity at the URL is the server's job |

## 1. Nostr

**How it works.**
- An event is `{id, pubkey, created_at, kind, tags, content, sig}`.
  - `id` is SHA-256 of the exact JSON `[0,pubkey,created_at,kind,tags,content]`, with fixed escapes.
  - `sig` is BIP-340 Schnorr on secp256k1 over the id.
- Kinds come in four ranges:
  - regular: stored;
  - replaceable (10000-19999, 0, 3): relays keep the newest per (key, kind);
  - ephemeral (20000-29999): not stored;
  - addressable (30000-39999): keyed by (kind, key, `d` tag).
  - Ties on `created_at` go to the lowest id. There is no sequence number and no link to the previous version.
- Deletion (NIP-09) is a kind 5 request that relays SHOULD honor. Its own text says deletion cannot be guaranteed.
- Expiry (NIP-40): relays SHOULD drop expired events but may keep them; "not a security feature."
- NIP-70 marks an event so relays accept it only from its author after NIP-42 authentication.

**Encryption.**
- NIP-44 v2:
  - Construction: X-coordinate of a secp256k1 ECDH result, HKDF with salt `nip44-v2`, then per message a random nonce, ChaCha20, and HMAC-SHA256.
  - Padding to power-of-two buckets.
  - Audited by Cure53 in December 2023.
  - Its own stated limits: no forward secrecy, no post-compromise security, no deniability, no post-quantum protection; network addresses, dates and sizes leak.
  - Payloads over 64 KB were added in June 2026, after the audit.
- NIP-59 gift wrap:
  - Nesting: the real event goes unsigned inside a sealed, signed layer, inside an outer layer signed by a one-time key.
  - Hides the sender, the kind and the true time.
  - Does not hide the recipient (`p` tag), the network address, size or timing.
- Groups: NIP-EE (MLS) is superseded by the Marmot protocol. Least Authority reviewed Marmot (Nov 2025) and audited its development kit (Mar 2026) and White Noise (Apr 2026).

**Remote signing and delegation.**
- NIP-46 lets an app ask a "bunker" to sign:
  - requests travel as kind 24133 over relays, encrypted with NIP-44;
  - permissions look like `sign_event:1`;
  - a pending request can return an `auth_url` the app opens, then a second answer.
  - No expiry, no amount limits, no revocation anyone else can check.
  - The bunker holds the whole key while it is online.
- NIP-26 delegation is marked "unrecommended: adds unnecessary burden for little gain."
- The multi-device "Keychains" proposal (NIP-A0) was closed on 5 Aug 2025; its author wrote that "Nostr will not likely ever handle device keys." Subkey (NIP-102) and delegation-in-NIP-46 proposals sit unmerged.
- Key rotation: four competing proposals as of Nov 2025, none merged. One maintainer: rotation needs "a global state which we don't have."
- FROSTR (threshold shares of one key) is alpha, with no audit found.

**Discovery and hosting.**
- NIP-65 (kind 10002) lists a person's relays. Finding that list at all relies on hints in links or on indexer relays (purplepag.es and similar), which act as informal directories.
- NIP-77 (negentropy) syncs sets of events between relay and client; strfry, khatru and rust-nostr support it.
- Blossom stores files by SHA-256 on HTTP servers; its upload tokens are Nostr events.
- Relays guarantee no storage. A 2023 measurement (arXiv 2402.05709):
  - 712 relays analysed; the top relay held 73% of posts;
  - a fifth of relays were down more than 40% of the time;
  - 95% of free relays could not cover their costs.
- The 2026 relay count was not verified.

**Attacks on record.** "Not in The Prophecies" (EuroS&P 2025, Black Hat USA 2025):
- major clients skipped signature checks, so relays could forge posts and profiles;
- NIP-04 direct messages were malleable;
- keys were reused across purposes.

**Library.** nostr-tools 2.25.2. One npm maintainer. It depends only on the noble libraries. No audit of nostr-tools itself found.

**Against the needs.**
- Right: N1, N5 (any relay, cannot forge, move by copying), N11 (small core).
- Partly:
  - N2 and N3: no writer anyone can check other than the key itself; standing rules mean a bunker holding the key online.
  - N4: deletion and retention are relay policy.
  - N6: bootstraps through indexer relays.
  - N8: pairwise only, nothing revocable once published.
- Wrong: N9 (secp256k1; a Solana key cannot be the Nostr key).

Sources:
- https://github.com/nostr-protocol/nips (01, 05, 09, 11, 17, 26, 40, 42, 44, 46, 47, 55, 59, 62, 65, 66, 70, 77, 86, EE)
- PRs 829, 1056, 1795, 2114, 2137, 2139, 2361, 2411 in that repository
- https://github.com/marmot-protocol/marmot
- https://leastauthority.com/blog/audit-of-white-noise-marmot-development-kit-mdk/
- https://opensats.org/projects/frostr
- https://github.com/hzrd149/blossom
- https://arxiv.org/html/2402.05709v2
- https://eprint.iacr.org/2025/1459
- https://github.com/nbd-wtf/nostr-tools

## 2. AT Protocol

**How it works.**
- Records sit in a Merkle Search Tree. A signed commit is `{did, version 3, data, rev, prev, sig}`, ECDSA over SHA-256 of the CBOR commit.
- Curves: p256 and k256 only (low-S required); no Ed25519.
- The DID document's first `#atproto` key is the signing key; its first `#atproto_pds` entry is the host.
- did:plc:
  - The operation log carries 1-5 rotation keys (k256/p256), verification methods (any did:key), handle, services, `prev`, `sig`.
  - The DID is 24 characters of base32(SHA-256(first operation)).
  - A higher-priority rotation key can override for 72 hours.
  - The directory cannot forge but can refuse, withhold or misorder.
  - An independent Swiss association was announced (Sep 2025) and founded in early 2026 (secondary source). Its 28 Sep 2026 post calls taking over the directory "the next step", so Bluesky PBC still runs plc.directory.
- The host signs every commit and every service-auth token with the same key.
  - A device-held key needs a fork. There is no standard endpoint for commits signed elsewhere; picopds lists it as planned.
  - An open proposal (Mar 2026) adds a separate `#atproto_service` key, because otherwise every background request needs a user gesture.

**Authorization.**
- OAuth with PAR, PKCE and DPoP. Access tokens last under 30 minutes. Refresh tokens last up to 2 weeks (public clients) or 180 days (confidential).
- Scopes cover:
  - `repo` (collection × create/update/delete);
  - `rpc`;
  - `blob`;
  - `account`, `identity`;
  - permission sets as Lexicons (late 2025).
- No expiry on a permission. Only the host enforces it; a reader cannot check who wrote a record.

**History and hosting.**
- The repository keeps only the current state; deletion leaves no tombstone.
- Sync v1.1 lets a consumer check each change.
- One active host per account. Moving = export, import, directory update.
- Tap (Dec 2025) verifies and backfills from a relay. Jetstream drops the proofs.

**Private data.**
- "Spaces" alpha, 20 Aug 2026 (proposal 0016):
  - access control per space;
  - read credentials of about 2 hours;
  - members' records live on their own hosts.
- The authors: "Spaces give you access control not confidentiality… it's not encrypted."
- End-to-end encryption is out of scope. Reasons given: servers need to search, moderate and notify, and key management is hard.

**Standards track.** An IETF working group (ATP) was chartered on 19 Mar 2026 for the repository and sync; non-public data is out of scope.

**Against the needs.**
- Right: N1, N10 (self-certifying repository, verifiable sync), N5 (moving is copying a CAR file).
- Wrong:
  - N2/N3: one key signs everything, so delegated writers are invisible; scopes are host-enforced without expiry.
  - N4: no history.
  - N5: one host.
  - N6: plc.directory and relays.
  - N8: Spaces unencrypted.
  - N9: no Ed25519.
  - N11: Lexicon, XRPC, CBOR, MST, CAR, PLC, OAuth+DPoP.

Sources:
- https://atproto.com/specs/repository
- https://atproto.com/specs/cryptography
- https://atproto.com/specs/did
- https://web.plc.directory/spec/v0.1/did-plc
- https://atproto.com/blog/plc-directory-org
- https://blog.plcred.org/3mwlphq42d227
- https://github.com/bluesky-social/atproto/discussions/4739
- https://github.com/DavidBuchanan314/picopds
- https://atproto.com/specs/oauth
- https://atproto.com/specs/permission
- https://atproto.com/blog/relay-updates-sync-v1-1
- https://atproto.com/guides/account-migration
- https://atproto.com/blog/introducing-tap
- https://atproto.com/blog/atproto-spaces-alpha
- https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data
- https://datatracker.ietf.org/wg/atp/about/

## 3. Farcaster

**How it works.**
- An account number (fid) belongs to an Ethereum custody address on OP Mainnet.
- The custody address adds ed25519 app keys ("signers") to a KeyRegistry. Each app key carries metadata signed by the requesting app, which says who asked but limits nothing.
- Messages:
  - format: protobuf;
  - hash: BLAKE3 truncated to 160 bits;
  - signature: ed25519 by a registered app key;
  - timestamps at most about 10 minutes ahead.
- Removing a key: "Removing a key will delete all offchain messages associated with the key." Validity follows the key's current state, not the state when signed; the workaround is to re-sign with a new key.
- Storage is rented per unit per year; the oldest messages are pruned past the limit.
- Snapchain (2025) replaced hubs: a BFT chain, sharded by account, with a small validator set (two entities as of Feb 2026, per Neynar's notes via search).

**Status.**
- Neynar acquired the protocol and app from Merkle Manufactory on 21 Jan 2026.
- On 17 Aug 2026 Neynar said it was looking for "a new home / team to run the products."

**Against the needs.**
- Right: N2/N3's shape (a root key authorizes app keys anyone can check), and the root can be recovered because the account is not a key.
- Wrong:
  - app keys have no scope and no expiry;
  - revocation erases history;
  - a chain plus a tiny validator set;
  - no choice of host;
  - no private data;
  - one company's fortunes decide it.

Sources:
- https://github.com/farcasterxyz/protocol/blob/main/docs/SPECIFICATION.md
- https://docs.farcaster.xyz/reference/contracts/reference/key-registry
- https://docs.neynar.com/snapchain/whitepaper
- https://neynar.com/blog/neynar-is-acquiring-farcaster
- https://www.theblock.co/post/386549/haun-backed-neynar-acquires-farcaster-after-founders-pivot-to-wallet-app
- https://crypto.news/farcaster-seeks-new-operator-seven-months-after-sale/

## 4. Pkarr, did:dht and Pubky

**Pkarr.**
- A signed DNS packet (under 1000 bytes) stored on the BitTorrent Mainline DHT as a BEP-44 mutable item:
  - `seq` = a microsecond timestamp;
  - the signature is ed25519 over the bencoded `3:seqi<seq>e1:v<len>:<packet>`.
- DHT nodes never take a lower `seq`. Items "MAY expire in 2 hours" and "SHOULD be re-announced once an hour."
- Anyone holding a signed packet can republish it; nobody can change it.
- HTTP relays serve browsers:
  - `PUT`/`GET /<z-base32 key>`, body = signature (64) || timestamp (8, big-endian) || packet;
  - 409 for an older timestamp; 1072 bytes at most;
  - relays must verify, so they cannot forge, but can withhold or serve stale data.
- DHT nodes commonly block cloud address ranges. Lookups show which address asks for which key.
- The official JS client (`@synonymdev/pkarr` 8.0.2) talks only to relays (by default Pubky's). Majors 6, 7 and 8 all shipped in 2026.

**did:dht.**
- A DID document as DNS records in a Pkarr packet.
- "Rotation of the Identity Key is not possible."
- Implementer's Draft, last updated July 2024; given to DIF in Nov 2024; did-dht.com no longer resolves.

**Pubky Core.**
- The key's Pkarr record names its homeserver.
- The homeserver:
  - is HTTP `PUT`/`GET`/`DELETE`/list under `/pub/` and `/priv/`;
  - offers a paginated event feed with cursors, which the Nexus indexer aggregates across homeservers;
  - republishes its users' Pkarr records.
- Grant auth (v0.10, Aug 2026): a grant binds path capabilities to an app's key; the app trades it for hour-long bearer tokens and refreshes without the root key, so it works with the phone off. Grants can be listed and revoked.
- Its own security model page:
  - the homeserver "can tamper with user data without detection";
  - data "is not cryptographically signed";
  - `/priv/` is "access control, not encryption".
- One homeserver per key; moving is manual.

**Against the needs.**
- Pubky has the closest overall shape (N3, N6).
- But:
  - N2/N5: the host can forge;
  - N3: grants are host-enforced;
  - N8: nothing is encrypted;
  - N5: one host.
- Pkarr is a clean, optional pointer (N6). It uses ed25519 like Solana (N9), with the size, life and visibility limits above.

Sources:
- https://github.com/pubky/pkarr
- https://www.bittorrent.org/beps/bep_0044.html
- https://registry.npmjs.org/@synonymdev/pkarr
- https://github.com/decentralized-identity/did-dht
- https://github.com/pubky/pubky-core
- https://pubky.org/explore/pubky-protocol/security-model/
- https://pubky.org/explore/pubky-protocol/authentication/

## 5. Web5 Decentralized Web Nodes (DWN)

- Messages are JSON descriptors whose `authorization` is a JWS by DID keys.
- Protocol definitions declare who can do what to which record type.
- Permission grants are records with a required `dateExpires` and a scope. Revocation is a separate record.
- A delegated write carries the app's own signature plus `authorDelegatedGrant`, so an app signs with its own key and anyone can check the owner's grant.
- Encryption derives keys along protocol paths; the code supports secp256k1 only.
- Several nodes per DID through a service entry.
- Status:
  - Block wound down TBD and gave DWN to DIF in Nov 2024;
  - the spec's last commit was Sep 2024, dwn-sdk-js's Oct 2024;
  - the one continuation, Enbox, is a "Research Preview — Not Production Ready," unaudited.
- Right: the delegated-write shape (N2/N3). Wrong: dormant, gaps in the spec, no commitment to the whole store (a host can leave records out).

Sources:
- https://identity.foundation/decentralized-web-node/spec/
- https://github.com/decentralized-identity/dwn-sdk-js
- https://blog.identity.foundation/block-contributes-to-dif/
- https://github.com/enboxorg/enbox

## 6. Willow and Meadowcap

**Willow.**
- An entry is (namespace, subspace, path, timestamp, payload length, payload digest) plus an authorisation token.
- The newest wins. An entry deletes all older entries under its path prefix, so there is no history.
- Willow'25 parameters (proposal, May 2025): Ed25519 keys and signatures, and WILLIAM3, a BLAKE3 variant with no independent analysis published.

**Meadowcap** (final, Nov 2025).
- Capabilities for read or write, delegated by signature, each step narrowing the area (subspace, path prefix, time range).
- No revocation; the spec suggests capabilities "valid for one week at a time."

**Sync.**
- Confidential Sync (proposal) matches interests by salted hashes.
- A simple GET/PUT protocol (WTP) is a sketch.

**Status.** Rust crates (0.7.x, Aug 2026) by a two-person team; NLnet-funded until Sep 2025; Earthstar 11 in beta; no audit found.

**Against the needs.**
- Right: N2/N3 (checkable, scoped, timed delegation), N9 (Ed25519).
- Wrong:
  - no revocation;
  - writer-chosen timestamps win;
  - no history;
  - a non-standard hash;
  - no discovery;
  - a young stack.

Sources:
- https://willowprotocol.org/specs/data-model/index.html
- https://willowprotocol.org/specs/willow25/index.html
- https://willowprotocol.org/specs/meadowcap/index.html
- https://willowprotocol.org/specs/confidential-sync/index.html
- https://codeberg.org/worm-blossom/willow_rs

## 7. UCAN

- v1.0.0 on 8 Jul 2026; authors from Protocol Labs, Bluesky and number zero.
- A delegation is a CBOR envelope with a varsig header and a payload:
  - issuer, audience, subject;
  - command;
  - policy (jq-like selectors, comparisons, `and`/`or`/`not`, `all`/`any`);
  - nonce, meta, not-before and expiry.
- Revocation: whoever controls the resource "MUST maintain a cache of Revocations."
- No passkey (WebAuthn) signature format in varsig.
- Implementations: rs-ucan ("has not been formally audited"), go-ucan, a JS one (secondary).
- Right: the richest conditions for standing rules, and later agent payments.
- Wrong: for stored public records, every reader needs the revocation feed, and records signed before a revocation stay valid unless time is trusted. Also a CBOR + varsig + policy evaluator, and few, unaudited libraries.

Sources:
- https://github.com/ucan-wg/spec
- https://github.com/ucan-wg/revocation
- https://github.com/ChainAgnostic/varsig
- https://github.com/ucan-wg/rs-ucan

## 8. Keyhive and p2panda

**Keyhive (Ink & Switch).**
- Individuals and groups with pull < read < write < admin.
- Delegations and revocations are signed operations that converge like a CRDT.
- BeeKEM group key agreement: the paper ePrint 2026/1434 proves forward secrecy and post-compromise security. It notes that the concurrency it needs costs forward secrecy.
- Pre-alpha: "DO NOT use this release in production."

**p2panda.**
- p2panda-auth: a membership CRDT with conditions.
- p2panda-encryption (DCGKA): group data keys that rotate on removal, and a double ratchet for messages. Needs causal order.
- 0.7.x (Aug 2026); an audit was "pending" in Feb 2025, no report found.

**For Forest.** Both are the right research for group chat and co-editing later, not for records that must stay readable to readers who join late.

Sources:
- https://www.inkandswitch.com/keyhive/notebook/
- https://eprint.iacr.org/2026/1434
- https://p2panda.org/2025/02/24/group-encryption.html
- https://docs.rs/p2panda-encryption/latest/p2panda_encryption/

## 9. HPKE, MLS and age

**HPKE (RFC 9180).**
- Modes base, psk, auth, auth-psk.
- Standard suite DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001, ChaCha20Poly1305 0x0003.
- One-shot `Seal(pkR, info, aad, pt) -> (enc, ct)`.
- Not forward secret against a reader's key compromise; no replay protection.
- The successor draft (`draft-ietf-hpke-hpke-05`, Proposed Standard) drops the auth modes. The JOSE and COSE HPKE drafts allow base and psk only, and define the multi-reader pattern: encrypt once, seal the key to each reader.
- JavaScript: hpke-js / `@hpke/core` 1.9.0 ("has not been formally audited") and panva's `hpke`. No audited JS HPKE was found; noble has no HPKE.

**MLS (RFC 9420).**
- Group key agreement with forward secrecy, post-compromise security, and add/remove at log cost.
- Needs every member to process one agreed order of changes, i.e. one sequencer per group (MIMI makes a hub responsible), so it fits poorly across independent hosts.
- New members cannot read earlier content by design.
- Deployed by Wire and Webex; cross-platform RCS on MLS began rolling out 11 May 2026.
- TypeScript: ts-mls, unaudited.
- For Forest: right for live group chat later; overkill for stored records.

**age** (the format, and typage, its TypeScript library by age's author).
- Header lines, one per reader, each wrapping a random file key; readers are not named in the file. Then ChaCha20-Poly1305 payload chunks.
- `age-encryption` 0.3.1 on npm depends only on `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum` and `@scure/base`, the same audited libraries Forest already uses.
- Hybrid post-quantum identities (ML-KEM-768 + X25519) are available.
- No audit statement for typage itself was found.

Sources:
- https://www.rfc-editor.org/rfc/rfc9180.html
- https://datatracker.ietf.org/doc/draft-ietf-hpke-hpke/
- https://datatracker.ietf.org/doc/draft-ietf-jose-hpke-encrypt/
- https://github.com/dajiaji/hpke-js
- https://www.rfc-editor.org/rfc/rfc9750.html
- https://github.com/LukaJCB/ts-mls
- https://github.com/FiloSottile/typage
- https://age-encryption.org/v1

## 10. DIDs and verifiable credentials

**did:key** (W3C Credentials Community Group draft).
- base58btc (`z`) of a multicodec prefix plus the key:
  - ed25519 `ed 01` -> `z6Mk…`;
  - x25519 `ec 01`;
  - secp256k1 `e7 01` -> `zQ3s…`;
  - P-256 `80 24` -> `zDn…`.
- A Solana address is base58 of the same raw 32-byte ed25519 key.

**Status.**
- DID Core 1.0 is a W3C Recommendation (2022); DID 1.1 is a Candidate Recommendation (Mar 2026).
- did:webvh 1.0 (DIF, Aug 2025) is a hash-chained log on the web with pre-rotation and optional witnesses.
- VC Data Model 2.0 and the EdDSA cryptosuites became W3C Recommendations on 15 May 2025:
  - `eddsa-jcs-2022` signs SHA-256(JCS(proof options)) || SHA-256(JCS(document)) with Ed25519;
  - no JSON-LD processing is needed for it.
- JCS (RFC 8785):
  - I-JSON input (no duplicate keys);
  - keys sorted by UTF-16 code units;
  - numbers written the ECMAScript way;
  - no whitespace.

Sources:
- https://w3c-ccg.github.io/did-key-spec/
- https://www.w3.org/TR/cid-1.0/
- https://www.w3.org/TR/did-1.1/
- https://identity.foundation/didwebvh/v1.0/
- https://www.w3.org/TR/vc-data-model-2.0/
- https://www.w3.org/TR/vc-di-eddsa/
- https://www.rfc-editor.org/rfc/rfc8785.html

## 11. Passkeys: PRF, and passkeys as signers

**Standard.** WebAuthn Level 3 became a W3C Recommendation on 25 Aug 2026: PRF, Related Origin Requests, hints, client capabilities.

**PRF support** (Corbado's matrix, updated 29 Sep 2026):
- Works:
  - iCloud Keychain on iOS 18 / macOS 15 and later (fixed for cross-device use in 18.4);
  - Google Password Manager;
  - Windows Hello (Feb 2026 update; Chrome/Edge 147+, Firefox 148+);
  - 1Password, Proton Pass, Keeper, Enpass.
- Partial: Bitwarden (0% on iOS/Safari).
- None: Dashlane, NordPass.
- Samsung Pass: PRF at sign-in only. Microsoft Password Manager: sign-in with PRF fails.
- Cross-device (phone QR + Bluetooth): works as the phone's provider does.
- The output differs per passkey and per provider, so each extra passkey needs its own wrapped copy of the seed.
- A WebAuthn co-editor asks people to stop using passkeys to encrypt user data (27 Feb 2026), because deleting the passkey loses the data. Forest's recipe answers this with the 24 words.

**Related origins.** Chrome/Edge 128+, Safari 18, Firefox 152+; at most about 5 domain labels.

**A passkey signature as a public approval.**
- It signs authenticatorData || SHA-256(clientDataJSON), with ES256 (P-256) on Apple and Android, not Ed25519.
- Synced passkeys report signCount 0.
- The phone shows only the site and account, never the text being approved; the web page shows that.
- Forest therefore never publishes passkey signatures. One passkey serves every profile, so its public key would link them. The passkey only unlocks the seed.

**Cross-device.** RFC 10027 (BCP 247, Aug 2026) names FIDO/WebAuthn, with its QR + Bluetooth proximity check, as the recommended way to approve from a device other than the one asking.

Sources:
- https://www.w3.org/TR/webauthn-3/
- https://www.corbado.com/blog/passkeys-prf-webauthn
- https://blog.timcappalli.me/p/passkeys-prf-warning/
- https://passkeys.dev/docs/advanced/related-origins/
- https://www.rfc-editor.org/rfc/rfc10027

## 12. MCP (Model Context Protocol)

**Current spec: 2026-07-28** (stateless).
- No `initialize` handshake and no session id; each request carries its version and client capabilities in `_meta`.
- Server-initiated requests became "multi round-trip requests":
  - the server answers a tool call with an `InputRequiredResult` (`inputRequests`, `requestState`);
  - the client retries with `inputResponses`.
- Tasks (long waits) are an extension.
- MCP Apps (sandboxed HTML UIs) became an official extension on 26 Jan 2026.

**URL-mode elicitation** (read directly from the 2026-07-28 page).
- A request carries `mode: "url"`, a `message` and a `url`.
- The client MUST:
  - show the full URL and get consent;
  - not prefetch it;
  - open it where neither the client nor the model can read the page.
- "accept" means only that the user agreed to open it. The server learns the outcome when the client retries with the echoed `requestState`.
- The server:
  - MUST NOT put sensitive data or pre-authenticated links in the URL;
  - MUST NOT use URL mode to authorize the client for itself (that is MCP authorization);
  - MUST verify that the user who opens the URL is the one who started it.
- The 2025-11-25 version had an `elicitationId`, a completion notification and error -32042.

**Authorization.** OAuth 2.1 resource server:
- protected resource metadata (RFC 9728) and audience checks (RFC 8707);
- PKCE;
- Client ID Metadata Documents preferred; dynamic registration deprecated.

**SDKs.** The TypeScript SDK's v2 line (`@modelcontextprotocol/server`, `client`, `core` 2.2.0, 28 Sep 2026) "implements the 2026-07-28 MCP spec"; `@modelcontextprotocol/sdk` 1.31.0 implements 2025-11-25.

Sources:
- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.html

## 13. Agent authorization and agent payments

Each is judged against: scoped, time-limited, revocable standing rules, signed by the owner, checkable by anyone, working with the phone off.

- **Google AP2.**
  - v0.2, Apr 2026: checkout and payment "mandates" as SD-JWTs, bound to the agent's key, with amount, budget, recurrence, payee and time constraints. Contributed to the FIDO Alliance with Mastercard's Verifiable Intent.
  - Right: owner-signed, constrained, checkable offline.
  - Wrong: commerce-only; revocation beyond expiry undefined; v0.2.
- **x402.**
  - HTTP 402 payments, Linux Foundation since Apr 2026. On Solana the client partly signs an SPL transfer and a facilitator pays the fee.
  - Right: pay per request on Solana.
  - Wrong: the agent needs its own spending key; no mandate object.
- **OAuth for agents.**
  - RFC 9396 (rich authorization details); transaction tokens (draft); attenuating agent tokens (individual draft, the closest shape to Forest's rules); `draft-ietf-wimse-aims-00` (passkey-authenticated grants; "local UI confirmation alone" is not authorization).
  - Wrong for Forest: the root of trust is an online authorization server.
- **OpenID AuthZEN 1.0** (Jan 2026): an "is this allowed?" query API. Not a credential.
- **Visa Intelligent Commerce and Trusted Agent Protocol, Mastercard Agent Pay:** card-network enforcement, not checkable by anyone.
- **Solana.**
  - SPL `approve`/`revoke`: one delegate, one cap, no expiry.
  - Smart wallets (e.g. Swig): roles, spend limits, time windows, passkey authorities, enforced on chain.
  - The off-chain message standard starts with `\xffsolana offchain`; `0xff` can never start a transaction.
  - The secp256r1 program checks passkey signatures on chain.
- **Biscuit.**
  - Tokens anyone can narrow offline, with datalog checks. Unaudited ("looking for an audit").
- **Lens v3.** Account managers with permission flags; changing managers needs the owner.

Sources:
- https://github.com/google-agentic-commerce/AP2/releases
- https://www.fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/
- https://github.com/x402-foundation/x402
- https://solana.com/docs/payments/agentic-payments/x402
- https://datatracker.ietf.org/doc/draft-ietf-wimse-aims/
- https://datatracker.ietf.org/doc/html/draft-niyikiza-oauth-attenuating-agent-tokens-00
- https://openid.net/authorization-api-1-0-final-specification-approved/
- https://solana.com/docs/tokens/basics/approve-delegate
- https://docs.anza.xyz/proposals/off-chain-message-signing
- https://github.com/eclipse-biscuit/biscuit
- https://lens.xyz/docs/protocol/accounts/manager

## 14. Adjacent work

- **W3C Linked Web Storage 1.0** (first draft Mar 2026, built on Solid): a personal-data-store API; the server enforces access, records are unsigned, hosts read everything.
- **did:webvh 1.0:** a possible did:plc replacement without a directory, but tied to a web host.
- **IETF key transparency** (draft-04, Apr 2026): lets anyone check which key belongs to which name; relevant if Forest ever adds names.
- **iroh-docs** (Willow's predecessor), **Holepunch Autobase** (multi-writer peer-to-peer log), **OCapN** (live capabilities), **DSNP** (runs on the Frequency chain): read, not relevant enough to score.

## 15. Lessons carried into the design

1. **Verify everything, trust no host.** Nostr relays forged posts wherever clients skipped signatures (EuroS&P 2025).
2. **Pick your revocation trade.** No surveyed system has delegation that anyone can check, that can be revoked, and that works offline for stored records, without giving something up:
   - UCAN and DWN need a revocation feed;
   - Meadowcap has no revocation;
   - Keyhive and p2panda need CRDT machinery;
   - Farcaster judges validity on the key's current state, so revoking erases what the key signed, and re-signing keeps it.
   - Forest takes Farcaster's trade, without a chain: the revocation sits in the folder the reader already reads.
3. **An app signs with its own key and names the owner's grant.** This is DWN's delegated-write shape; Pubky's grants add path scopes.
4. **Keep hosts dumb and plural.** Pubky's host shape (HTTP plus a change feed with cursors), with signed records and several hosts.
5. **A passkey signature must never be public.** One passkey serves every profile.
6. **Use Solana's `0xff` rule** to keep entry signatures and payment signatures apart.
7. **Approve outside the AI client.** MCP URL mode, with the approval page proving the user by the signature it produces.

## Not verified

- The 2026 count of public Nostr relays.
- Which relays support NIP-77.
- Snapchain's validator operators today.
- Whether Snapchain still deletes a removed key's messages.
- Farcaster's 2026 users and fees.
- The Marmot and White Noise audit findings.
- Audits of nostr-tools, FROSTR, typage, hpke-js, UCAN libraries, Keyhive, p2panda, Willow.
- Pubky's grant wire format.
- Whether MCP 2026-07-28 formally dropped error -32042.
- Visa TAP's signature details.
- The exact date the PLC association was founded.

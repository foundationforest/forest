# Forest's data protocol: report

Lab exploration, 29 September 2026. Nothing here is shipped, and nothing outside `lab/protocol/` was
changed. Claims marked **verified** name the test that shows them (`npm test`: 77 tests, all
passing). Everything else is marked **believed**.

## Page one

**Recommendation: build Forest's records on a small protocol of its own, assembled from standard
parts. Not Nostr, and not AT Protocol.** Working name: *signed entries on plain hosts*.

How it works:

1. **One key per profile: its name, its signature and its wallet.** A badge on the registry then
   points straight at the profile's key. Nothing needs cross-checking.
2. **Everything a profile says is a small signed note.** Anyone can check who wrote it, and nobody
   can change it, hosts included. The newest version counts; an empty version is a delete.
3. **Hosts are plain web servers that store notes and hand them out.** Anyone can run one, and a
   profile uses several. Moving is copying. Hosts hold no keys and can't read private notes.
4. **An assistant writes with its own key, under a permission the person signed:** what kinds of
   things, and until when. The person can take it back at any time. For anything else, the
   assistant asks, and the person approves with one tap and a face scan. The assistant never
   holds the person's keys.
5. **Private notes are locked so only chosen readers can open them.** The lock is post-quantum by
   default.

**Why not Nostr, the current lean.** Nostr's core is good, and this design borrows its best ideas.
But three things matter for Forest:
- **Its keys can never be Solana keys.** Every profile would need two keys and proofs tying them
  together.
- **It has no way to give an assistant limited, expiring, revocable permission.** Its maintainers
  closed the proposals ("Nostr will not likely ever handle device keys"). The Nostr way is a
  server that holds your whole key, which Forest forbids.
- **Deletion is only a request, and keeping old versions for 30 days is not a thing relays do.**

So Forest would write the hard parts itself anyway, on top of rules that fight them. What Nostr
would give is its ecosystem, and Forest's records would not use most of it.

**Why not stay on AT Protocol.**
- One host at a time.
- The host signs by default; Forest patched that and would keep patching it forever.
- A central directory.
- Private data isn't encrypted: their new "Spaces" are access control only.
- Its keys can't be Solana keys either.

**What it costs.**
- **A short spec and about 1,500 lines of code to own.** The core rules are 442 lines; the host is
  314. One person can audit the core in a day.
- **No existing ecosystem.** We run our own hosts and indexes; this prototype includes both.
- **Checking signatures in plain JavaScript is slow:** about 260 a second on one core here. Real
  hosts and indexes should use native crypto: 8,265 a second measured on the same core.
- **Replaced:** the host fork, the relay (carrier), did:plc and the two secp256k1 keys in `keys/`,
  and the index's reader. The record shapes become plain JSON. None of this is in production.

**What stays hard.**
- **Revoking an assistant removes what it wrote,** unless you keep it; one approval re-signs
  everything you keep. This is the price of not trusting any clock: after a revocation, a stolen
  assistant key can't fake old posts. *Verified.*
- **No key rotation.** If one profile's key leaks, that profile, and its badge in that market,
  are lost for good. This is the same as today, because every key comes from one seed.
- **The approval page is the most trusted code in Forest,** because it opens the seed. Whoever
  serves it could steal keys. It must stay tiny, locked down (it is, here: *verified*), and
  published with its hash.
- **The door (the AI connection) can act within every permission it holds while it runs.**
  - A leaked door master key alone cannot sign under any permission. *Verified.*
  - An operator, or a thief with the master key and a token, can act, but only within that
    permission.
- **Consent phishing works if you don't read.** Approve a connection someone else started, and
  their assistant writes within that permission until you revoke it. The page says who is asking.
- **Timing and network addresses can still link your profiles.** Examples: one phone writing both
  profiles at once, or one small host holding both. Apps and hosts must hide this; the protocol
  can't. *Verified finding.*
- **Passkey secrets (PRF) are missing in some password managers,** such as Dashlane and most of
  Bitwarden. This affects the keys recipe, not this protocol.

**Proved by running code:**
- profiles as wallets;
- two hosts and an index;
- update, delete and pruning;
- an assistant under a rule;
- one-tap approval with a real WebAuthn passkey in Chromium (its virtual authenticator stands in for the phone);
- an encrypted note only its reader opens;
- MCP 2026-07-28 end to end;
- about forty attacks.

**Believed, not tested:**
- real phones;
- the real Mainline DHT (no UDP here);
- the full OAuth wiring;
- anything at more than one machine's scale.

---

## 1. The design in brief

The exact rules are in `SPEC.md`; the code in `src/`.

- **Identity.**
  - A profile is an ed25519 key derived from the seed with the label `keys/` already uses for the
    profile wallet (`forest.foundation/profile/<n>/wallet/v1`), so existing seeds keep working.
    *Verified: profile ids equal `keys/test/vectors.json`'s wallet addresses (core.test.ts,
    "the seed and every profile key are exactly what keys/ pins").*
  - Its name is `did:key:z6Mk…`; its Solana address is the same 32 bytes.
  - One new label gives the box key for sealed entries.
- **Entry.**
  - Shape: `{v, profile, path, time, body|null, by?, grant?, sig}`.
  - The signature is Ed25519 over `0xff ‖ "forest.foundation/entry/v1\n" ‖ JCS(entry without sig)`.
  - The wire form is exactly that canonical text.
  - The id is the SHA-256 of the signing input.
- **Merge.**
  - Newest version wins.
  - The owner first: what the owner wrote at a path outranks any delegate.
  - Delegates count only under the exact grant version they name, while it is current and
    unexpired.
  - Deletes are empty versions.
  - Entries dated too far ahead wait.
  - It is a pure function: same entries, same clock, same view. *Verified (view.test.ts, "same
    entries in any order…"; attacks.test.ts, "two indexes reading different hosts compute the
    same view").*
- **Folder.** A profile's own settings entry: its hosts, its box key, how many days hosts keep old
  versions.
- **Grant.**
  - Written by the owner, naming a delegate key, path prefixes and an end time.
  - Revoking deletes it.
  - A grant field a reader does not know grants nothing.
- **Hosts.**
  - HTTP + SQLite, two endpoints: store and read (with a cursor), plus a small info document.
  - They check every entry, keep current versions, and forget old ones after the owner's `keep` days.
  - They refuse replays after a move.
  - They budget new keys without a badge.
- **Discovery.**
  - Signed folders on any host.
  - Crawling the hosts that folders name.
  - Optionally Pkarr (signed DNS records on the BitTorrent DHT) keyed by the profile key.
- **Sealed entries.** age files to each reader's box key, post-quantum hybrid by default.
- **The door.** An MCP server holding no person's keys (section 4).

## 2. Candidates compared

Four candidates, scored on the eleven needs (✓ meets, ◐ partly, ✗ no). The research behind each
cell is in `RESEARCH.md`, with sources.

| Need | A. AT Protocol (today) | B. Nostr + a Forest spec | C. Willow + Meadowcap | **D. Signed entries on plain hosts** |
|---|---|---|---|---|
| 1 records, public read | ✓ | ✓ | ✓ | ✓ |
| 2 only owner or authorized, no forgery | ◐ fork; delegates invisible | ◐ delegates are an add-on | ✓ | ✓ |
| 3 AI writers: tap or standing rules | ✗ scopes checked only by the host, no expiry | ◐ tap via NIP-46; rules need an online key | ◐ not revocable | ✓ |
| 4 versions, delete, prune after 30 days | ◐ no history | ◐ delete is a request | ◐ no history | ✓ on honest hosts |
| 5 many swappable hosts, keyless, blind | ✗ one host | ✓ | ✓ | ✓ |
| 6 no directory or relay | ✗ | ◐ indexer relays | ✗ no discovery | ◐ folders and crawling; Pkarr optional |
| 7 unlinkable profiles | ◐ | ◐ | ◐ | ◐ keys yes; timing and addresses are the app's to hide |
| 8 private data later | ✗ Spaces not encrypted | ◐ pairwise only | ◐ guidance only | ✓ age, post-quantum |
| 9 one key with the wallet | ✗ | ✗ | ✓ | ✓ |
| 10 verifiable, few trust points | ◐ directory, relay | ◐ permissions not checkable | ✓ | ✓ |
| 11 small, standard crypto | ✗ | ◐ | ✗ new hash, big sync spec | ✓ |
| What it costs | the fork, forever | the hard parts, outside Nostr's norms | a young, unaudited stack | a small spec and host of our own |

**Runner-up: B.** Forest would borrow Nostr's event format and relays, and write its own:
- delegation;
- retention;
- delete;
- discovery;
- wallet binding.

B is the right choice only if being readable by Nostr apps matters more than one key per profile.
Forest's records are offers, reviews and proofs, and Nostr's social apps would not show them in
any useful way.

**Also read and not scored:**
- Pubky: the closest shape, but its hosts can forge and read private data.
- Web5 DWN: dormant.
- UCAN 1.0: the best conditions language, but needs a revocation feed and trusted time.
- Keyhive, p2panda and MLS: group encryption for later chat.
- Farcaster: needs a chain.
- AT Protocol "Spaces": not encrypted.

## 3. What was invented, and why nothing existing did the job

Everything else is reused unchanged:
- Ed25519 (RFC 8032) via noble;
- JCS (RFC 8785) via its author's library;
- SHA-256 and HKDF;
- did:key;
- age (typage, by age's author);
- Pkarr and BEP-44;
- WebAuthn PRF;
- MCP 2026-07-28 via the official SDK;
- SQLite.

| Invented | Size | Why not an existing one |
|---|---|---|
| The entry and its signing rule | about 60 lines | Nostr's is secp256k1 and allows one writer per address. W3C `eddsa-jcs-2022` is the same primitive plus a proof object Forest does not need (switching later is cheap). JWS still needs canonical text to stop two readers seeing two contents. |
| Grants, owner-first, retroactive revocation | about 60 lines | NIP-26 is abandoned and has no revocation. UCAN needs a revocation feed and trusted time for stored records. Meadowcap has no revocation. Farcaster's needs a chain and has no scopes. |
| The merge and retention rules | about 100 lines | Nostr and Willow keep only the newest version and have no multi-writer order; AT Protocol keeps no history. |
| The host API | about 300 lines | Nostr relays speak WebSocket with single-writer rules. Pubky's homeserver shape is closest, but it trusts the host with unsigned data. The AT Protocol PDS needs a fork. |
| The folder entry | 20 lines | A profile's hosts and box key must be signed by the profile and replicated with it. |
| The `_forest` Pkarr record | 1 convention | Pkarr is unchanged; only the record name is ours. |
| The door and the approval page | about 370 lines | This is product glue: MCP and WebAuthn are used as specified. |

## 4. The AI connection, step by step

Reading needs nothing: hosts and indexes answer plain HTTP. What follows is about writing.

**Connecting once (MCP authorization; the core of it is built and tested, the OAuth screens are
described).**
1. In Claude, the person adds Forest's door as a connector.
2. Claude's browser tab opens the door's sign-in, which is the approval page on forest.foundation.
3. The page says, in words: "claude.ai asks to write for you, on its own, until 6 October. Only:
   offers. Nothing else, and never your own posts. You can take it back at any time."
4. One tap and a face scan. On the phone, or on the laptop through the browser's own "use a
   phone" (see below).
5. The page:
   - makes the seed from the passkey;
   - signs a grant naming a key the door made for this connection alone;
   - publishes the grant to the profile's hosts;
   - forgets the seed.
6. Claude receives a token. The door keeps nothing: the connection's key is rebuilt from the door's
   master key and a number sealed inside the token.

*Verified:* door.test.ts, "connect: one approval…"; browser.test.ts, "connect: the page says who
asks…".

**Writing under the rule, phone off.**
1. "Post my physics tutoring at 40 an hour."
2. Claude calls `forest_write`. The door checks the grant on the hosts, signs with the connection's
   key, and publishes.
3. Done; nobody was asked.

*Verified:* grants.test.ts, "the phone is off…"; door.test.ts, "standing rule…".

**Writing anything else: one approval (on the phone).**
1. "Leave Bob a 9 out of 10."
2. A review is outside the rule. The door answers `input_required` with a link to the approval page
   (MCP URL mode) and a signed `requestState`.
3. Claude shows the full link and asks to open it. The person opens it on the phone.
4. The page shows exactly what will be signed, as plain text: "Publish review/1: subject …,
   ratings …, text …". One tap and a face scan. The phone signs with the profile's own key and
   publishes to the profile's hosts.
5. Claude retries the call. The door sees the signed entry and answers "Approved and published."

*Verified, with a real passkey:* browser.test.ts, "an assistant over MCP…".

**On a laptop without the passkey.**
- The laptop's browser shows the approval page. The tap asks for the passkey, and the browser
  offers "use a phone": a QR code, then Bluetooth checks that the phone is nearby, then the phone's
  face scan.
- This is the cross-device flow RFC 10027 recommends, because the Bluetooth check stops someone
  far away from using a QR code they sent you.
- The passkey's secret comes back to the laptop page for that one approval (PRF works through
  it). The seed lives in the page only while it signs.
- If the laptop has no Bluetooth: open the same link on the phone and approve there.

*Believed:* real devices and the Bluetooth flow are not tested here.

**Taking it back.**
1. The Forest app shows active connections with their names. "Remove" deletes the grant with one
   tap.
2. What the assistant wrote stops showing at once.
3. The app lists it: "Keep these 12?" One more approval re-signs the ones kept.

*Verified:* grants.test.ts, "revoked: … one approval keeps it".

**What the design refuses.** *Verified.*
- An assistant can't write beyond its paths.
- It can't overwrite or delete what the person wrote.
- It can't grant itself more.
- It can't write in another profile.
- A draft cannot be approved by another person's passkey.
- A forged, foreign or replayed `requestState` gets nothing.
- A draft carrying HTML stays text, and the page's policy refuses HTML altogether.

*Verified:* door.test.ts, browser.test.ts, view.test.ts, attacks.test.ts.

**Known risk.** Prompt injection inside a standing rule. An assistant that reads a hostile review
could be talked into posting within its paths. Hence the defaults:
- offers only;
- 7 days;
- reviews always one at a time.

## 5. Trust points: every one, and no others

What each party can do, and what it cannot.

| Who | Can | Cannot |
|---|---|---|
| **The person's passkey provider** (Apple, Google, a password manager) | Whoever controls that account can get the PRF secret and so the seed: every profile, every wallet | Nothing else |
| **The approval page** (code served at forest.foundation and the related origins) | It opens the seed; malicious code could steal it | Mitigations: tiny, no third-party code, strict CSP with Trusted Types (*verified*), immutable build with its hash published (the build prints it) |
| **The app holding the seed** (e.g. Roots, for payments) | Same as the approval page, while unlocked | Apps that only need records can use grants and never touch the seed |
| **The door**, while it runs | Act within every grant it holds (it sees the tokens) | Act beyond them; sign as the person. A leaked master key alone signs nothing (*verified*: door.test.ts) |
| **The AI provider** | Sees what it drafts, and which profiles one conversation touches (so it can link them) | Sign anything; it holds no key |
| **Issuers** (face check) | Vouch for humans, or wrongly vouch | Anything in this protocol; they matter to badges only |
| **Hosts** | Withhold, delay, or serve an older version to a reader who asks only them; see network addresses, timing and sizes; keep what they should forget; refuse to store | Forge, alter, or read sealed entries (*verified*: host.test.ts, attacks.test.ts, sealed.test.ts) |
| **Indexes** | Rank, hide, or misreport | Change what anyone else computes: anyone can recompute from hosts (*verified*: attacks.test.ts) |
| **Pkarr relays / the DHT** | Withhold, or serve an older hint | Forge a host list (*verified* against a tampering relay) |
| **The libraries** (noble, typage, canonicalize, the MCP SDK) and the browser | Everything, if compromised | Pinned versions, few dependencies; noble is audited |
| **Solana** | Registry and escrow only | Nothing in this protocol |

- The clock of a writer only orders its own versions.
- The clock of a reader decides expiry, and only for grants.
- No other party is in the path of a record, from the phone that signs it to the reader that
  checks it.

**The door's master key, precisely.** *Verified: door.test.ts, "a leaked master key alone…".*
- **Alone:** it opens no token and derives no connection key. Finding the number that gives a
  known key is a preimage attack. It signs nothing under any existing grant.
- **With a token** (which the running door sees on every call, and a client stores): it becomes
  that one connection's key, within that grant, until the grant ends or is revoked.
- **Rotating the master key** ends every connection at once; people reconnect with one tap.

## 6. Attacks, need by need

"Held" means the attack failed. **Finding** means it worked, and the report says what hides it.

| Need | Tried | Happened | Where |
|---|---|---|---|
| 1 | Read with no account, token or key | Held: reading is plain HTTP | host.test.ts |
| 1 | A host withholds an update | Held: the index took it from the other host | host.test.ts "withholds…" |
| 2 | Change any field of a signed entry (profile, path, time, body) | Held: signature fails | core.test.ts "any change…" |
| 2 | A host serves a forged line | Held: the reader refused it and counted it | host.test.ts |
| 2 | Second spelling of a signature (S + L) | Held: refused, and it could not make a new id anyway | attacks.test.ts |
| 2 | Small-order key: (R = identity, S = 0) "verifies" everything | Held: Forest refuses such keys. **Finding:** OpenSSL (node:crypto) accepts that signature for the identity key; readers must apply Forest's key rules, not a library's default | attacks.test.ts |
| 2 | Mixed-order key: cofactored and cofactorless verifiers disagree | Held: Forest refuses such keys. **Finding:** the split is real without the check (12 of 16 signatures disagreed) | attacks.test.ts |
| 2 | Duplicate keys, other escapes, other number forms, whitespace | Held: the wire must be canonical | core.test.ts, host.test.ts |
| 2 | An entry signing input read as a Solana transaction | Held: Solana's own decoder refuses it (version 127) | attacks.test.ts |
| 2 | A payment signature or Pkarr signature used as an entry signature, and the reverse | Held | attacks.test.ts |
| 2 | Use one profile's grant in another profile | Held | attacks.test.ts |
| 3 | An assistant writes outside its paths (a review, the profile card, `offerx`) | Held | view.test.ts, grants.test.ts |
| 3 | An assistant overwrites or deletes the owner's own offer | Held: owner first | view.test.ts, grants.test.ts |
| 3 | A stolen assistant key after revocation, also backdated | Held | grants.test.ts |
| 3 | Revive a revoked grant to bring old entries back | Held: they named the old version | view.test.ts |
| 3 | Write after expiry with the phone off; backdate within the window | Held: expiry ends all of it, by the reader's clock | view.test.ts, grants.test.ts |
| 3 | An assistant grants itself more | Held: delegates can't write grants | view.test.ts |
| 3 | Another person approves the draft | Held | door.test.ts, browser.test.ts |
| 3 | The door swaps the draft, or passes off another profile's signature | Held | door.test.ts |
| 3 | Forged, foreign, replayed `requestState` | Held | door.test.ts |
| 3 | HTML in a draft | Held: shown as text; the page's policy refuses HTML sinks | browser.test.ts |
| 3 | Consent phishing | **Finding:** works if the person approves without reading; the page names the client | door.test.ts |
| 3 | Leaked door master key | Held alone; **finding** with a token: acts within that grant | door.test.ts |
| 4 | Bring back a deleted offer from a host that missed the delete | Held | attacks.test.ts |
| 4 | Date an entry far ahead to pin it | Held: hosts refuse, readers hold it back | host.test.ts, view.test.ts |
| 4 | A slow clock makes an edit lose | Held: writers date after the newest version | view.test.ts |
| 4 | A host keeps old versions it should forget | **Finding (inherent):** public data can be copied; only honest hosts forget | spec §7 |
| 5 | Search a host's whole database for the person's secrets | Held: none there | attacks.test.ts |
| 5 | Move hosts by copying | Held: same verified profile | host.test.ts |
| 5 | Replay an old folder or old entries to the old host after a move | Held: refused, or forgotten after `keep` | host.test.ts |
| 5 | The host reads a sealed note | Held | sealed.test.ts |
| 6 | A folder signed by someone else naming other hosts | Held | attacks.test.ts |
| 6 | A relay tampers with a Pkarr packet, or replays an older one | Held | discovery.test.ts |
| 6 | The Pkarr library's `fromBytes` on a tampered packet | **Finding:** accepted, because it doesn't verify; Forest checks signatures itself | noted in SPEC §8 |
| 7 | Look for any key, id or box key shared by two profiles of one person | Held: nothing shared but what the person chose (the host, repeated template text) | attacks.test.ts |
| 7 | Two profiles written at the same moment | **Finding:** adjacent in the host's feed, same millisecond | attacks.test.ts |
| 8 | The host, a stranger, or the person's other profile opens a sealed note | Held | sealed.test.ts |
| 8 | A removed reader opens the next version | Held; the old version stays readable to them until hosts forget it, and forever if they kept it | sealed.test.ts |
| 8 | Count the readers of a sealed note | **Finding:** anyone can | sealed.test.ts |
| 9 | Claim someone else's wallet | Held by construction: the profile is the wallet | core.test.ts |
| 10 | Two indexes on different hosts | Held: the same view | attacks.test.ts |
| 11 | Size of the core rules | 442 lines of code; 77 tests | this report |
| spam | 100 fresh keys at once | Held: the host admitted its hourly budget (set to 20 in the test; the default is 1,000) and answered 429 to the rest; existing profiles kept writing; a badged key was not held back | spam.test.ts |
| spam | One address makes many profiles | Held: a few per hour | spam.test.ts |
| spam | An unbadged key fills a host | Held: quota | spam.test.ts |

## 7. Unlinkable profiles: what still links, and who must hide it

Nothing in the protocol ties two profiles of one person. *Verified: no key, box key, grant key or
id repeats.* These remain:

| Signal | Who sees it | The layer that must hide it |
|---|---|---|
| Network address (one phone writes for both profiles) | Hosts, the door, Pkarr relays | The app and network: different hosts per profile; later, Oblivious HTTP (RFC 9458) relays in front of hosts; hosts never log addresses (policy, and Railway's own logs are an open item) |
| Timing (both written in the same second) | Anyone reading the feed (*verified finding*) | The app: publish each profile on its own schedule, with random delays |
| Host choice (a personal host, or the same small host for all profiles) | Anyone | The app: large shared hosts, or different hosts per profile; warn when a set is unique |
| One assistant connection for several profiles | The door, the AI provider | One connection per profile (the door makes a fresh key per connection: *verified*); one conversation per profile if it matters |
| Money moving between the central wallet and profile wallets | Anyone, on chain | Unchanged from today: pools and ramps, the app's choice |
| The same passkey | Only the device | Passkey signatures are never published |
| Retention setting (`keep`), rare fields, writing style | Anyone | The app: defaults |

## 8. Spam

Keys are free, so hosts budget. The prototype's defaults (host policy, not protocol):
- **Without a badge:**
  - 100 entries, 256 KiB and 30 writes a minute per key;
  - new profiles admitted within 1,000 an hour host-wide and 5 an hour per network address, counted
    in memory under a keyed hash that changes every hour, never logged.
- **With a badge:** 20,000 entries, 64 MiB and 600 writes a minute. A host checks the badge by
  asking the registry about the key, since the key is the wallet.
- **Past a budget:** new profiles get 429. Profiles a host already holds keep writing.

*Verified: spam.test.ts.* Behind a proxy, a host needs the forwarded address. *Believed:* whether 5
new profiles per address per hour holds up for shared addresses (a campus, a mobile carrier) needs
real traffic.

## 9. Scale: a billion profiles

*Believed, from measurements on one core of this machine (Xeon at 2.1 GHz, Node 22;
`bench/throughput.ts`).*

| Measured here | Per second |
|---|---|
| Canonical text of an entry | 190,000 |
| Ed25519 verify, native OpenSSL | 8,265 |
| Ed25519 verify, Forest strict, pure JS | 262 (the subgroup check on R alone: 1,026) |
| Host check-and-store, SQLite, pure-JS crypto | 154 (bound by verification) |
| Host serving its feed, pages of 1,000 | 780,000 lines |
| Merging one profile of 1,000 entries | 3,900 merges |

One offer is 485 bytes on the wire.

Assume a billion profiles, 20 current entries each, and one new entry a week each.
- **Data.**
  - 20 billion current entries, about 10 TB network-wide.
  - Writes average 1,650 a second; a peak of perhaps 16,000.
- **Hosts.** At a million profiles per host, about 1,000 hosts of about 10 GB each. One SQLite
  file per host holds that; a host with 100 million profiles needs a database that shards.
- **An index that reads everything.**
  - It follows about 1,000 host feeds (cursors, plain HTTP).
  - Steady state: it verifies about 1,650 entries a second, one core of native crypto with the
    subgroup check.
  - First load: 20 billion verifications, about 60 core-days, so about a day on 64 cores. It
    stores about 10 TB.
- **A market index.** It reads profile cards first (the `path=profile` filter): a billion cards,
  about 0.5 TB. Then it reads in full only the profiles in its markets.
- **Discovery.** Crawling a thousand hosts is easy. Badged profiles are known from the registry.
  Pkarr lookups for millions of keys run in parallel on the DHT.

What must change before that scale:
- **Native crypto** in hosts and indexes.
- **Incremental merges** in the host: it currently recomputes a profile's view on every write.
- **Real storage** for the largest hosts.
- **Budgets tuned** on real traffic.

What does not have to change: the protocol has no global order, no directory and no relay, so
nothing in it grows with the network except each reader's own work.

## 10. The registry, and one key for records and money

- **The profile key is the wallet.** The badge's registry line should name the profile by that
  32-byte key, and the key signs the registration. The registry then binds the badge to the key
  that writes the records and receives the money, with no declared-wallet field and no cross-check
  by indexes. That closes the index's open item on declared wallets ("an unbadged profile can
  declare someone else's wallet").
- **Costs of one key.**
  - It signs two kinds of things. The `0xff` prefix keeps them apart (*verified* against Solana's
    own decoder).
  - The key must never go into a general wallet app, whose "sign any message" could be pointed at
    Forest's format. Forest's own wallet surfaces should refuse raw messages starting with `0xff`.
  - No rotation: a leaked profile key loses that profile and its badge in that market. Today's
    design loses the same, since the badge already binds the wallet.
- **For the parallel registry session:**
  - the message the proof binds should be the profile key alone;
  - an index counts a badge for a profile when the badge's key is the profile's key;
  - with today's program, when `Registered.did` is the did:key of `Registered.wallet`.

## 11. What changes in the repo if this is adopted

Rules in CLAUDE.md that Carlos would change:
- "AT Protocol for records, keys and names";
- "Four record shapes: profile, post, review, credential" (now profile, offer, review, proof);
- "Names are a later feature… the DID is the identity" (still true: the DID is did:key);
- "Don't resurrect: a Forest-written folder standard" (this is one).

Pieces this replaces or changes:

| Piece | What happens to it |
|---|---|
| `host/` (AT Protocol fork) | Replaced by a host like `src/host.ts` |
| `carrier/` (relay and Jetstream) | Removed: indexes read hosts directly |
| `keys/` | The two secp256k1 keys and did:plc are dropped; one label is added (box key); the wallet label becomes the profile key |
| `shapes/` | Lexicons become plain JSON shapes (JSON Schema or code); decimals stay text; blobs become SHA-256 references; `post` becomes `offer`, `credential` becomes `proof` |
| `index/` | Its reader follows host feeds instead of the relay; its declared-wallet rule becomes "the badge's key is the profile" |
| Names | Handles go away; readable names later can be DNS or Pkarr records pointing at the did:key |

## 12. Open questions

**Needs Carlos:**
- Adopt this, or Nostr with a Forest delegation spec, or stay? It changes rules in CLAUDE.md
  (section 11).
- **Revocation takes down what an assistant wrote unless kept.**
  - Is that acceptable as a product behaviour?
  - The alternative needs a trusted clock (a chain anchor) or a revocation feed every reader
    consults.
- **Default permission for assistants.** This draft uses offers only for 7 days, and reviews one at
  a time. Longer?
- **Who runs the door, and where its master key lives.** It is a trust point: section 5.
- **Hosts.**
  - Should a host be allowed to check the registry, so badged keys get more room? It asks the chain
    about keys, which is public.
  - Who runs the first hosts, and on what terms for profiles without a badge?
- **Pkarr.** Include it at launch, or rely on folders, crawling and pings first?
- **Private data.**
  - Post-quantum by default: yes in this draft (about 1.1 KB per reader).
  - Personal data (contacts, health, AI memory) is a separate standard on the same entries; when?
- **Consent phishing.** Only accept connections from AI clients the app knows (a list), or any
  client, named on the page?

**Mechanical:**
- The OAuth screens for the door; the in-app list of connections with "remove" and "keep these".
- Native crypto (Rust or Go) for hosts and indexes; incremental merges in the host.
- Blobs (photos, video) by SHA-256 on hosts; Blossom's read path could be reused.
- Test on real phones: iOS, Android, Windows, and the cross-device flow.
- A Pkarr republisher in hosts (they hold the signed packet); a native DHT client for indexes.
- A spec review by someone outside, and a fuzzer on the entry parser.

## 13. Verified versus believed

**Verified by running code** (`cd lab/protocol && npm ci && npm test`: 77 tests pass):
- The profile key is exactly the wallet `keys/` derives. Two profiles share no public value.
- A profile, an offer and a review published to two HTTP hosts. An index finds the second host
  from the folder and merges both.
- Update, delete, pruning after `keep` days, `keep: 0`, tombstones kept, and replay after a move
  refused.
- An assistant under a signed rule with the phone off. Refused outside its scope and at the owner's
  paths. Revocation, expiry and revival handled. "Keep these" in one approval.
- The door on MCP 2026-07-28 over HTTP through the official SDK:
  - standing-rule writes;
  - URL-mode approval;
  - forged, foreign and replayed `requestState` refused;
  - the master-key analysis;
  - consent phishing recorded.
- In headless Chromium with a virtual authenticator:
  - a real WebAuthn passkey's PRF makes the seed;
  - setup, connect and per-action approval each with one tap;
  - HTML refused;
  - another person's passkey refused.
- A sealed note readable only by its reader and its owner, post-quantum. Reader count visible.
- Pkarr packets built by the official client, resolved through a stand-in relay. Tampering and
  rollback refused.
- Spam budgets and quotas.
- Strict Ed25519 against OpenSSL, the Solana decoder check, and vectors checked by a second
  implementation.
- Throughput numbers (section 9).

**Believed, not tested here:**
- Real phones and their password managers. The cross-device Bluetooth flow.
- The Mainline DHT itself (no UDP in this sandbox).
- MCP OAuth screens and client ID metadata documents.
- Behaviour with real AI clients: Claude's URL-mode UI, prompt injection.
- Scale beyond one machine (section 9).
- Railway and Vercel not logging addresses.
- Whether hosts will actually be run by others.

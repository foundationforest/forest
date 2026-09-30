# Forest's data protocol: report

Lab exploration, 29 September 2026, second round. Nothing here is shipped, and nothing outside
`lab/protocol/` was changed. Claims marked **verified** name the test that shows them (`npm test`:
81 tests, all passing; `npm run test:net`: 1 live test, passing). Everything else is marked
**believed**.

## Page one

**Recommendation: build Forest's records on a small protocol of its own, assembled from standard
parts. Not Nostr, and not AT Protocol.** Working name: *signed entries on plain hosts*.

How it works:

1. **One key per profile: its name, its signature and its wallet.** A badge on the registry then
   points straight at the profile's key. Nothing needs cross-checking.
2. **Everything a profile says is a small signed note.** Anyone can check who wrote it, and nobody
   can change it, hosts included. The newest version counts; an empty version is a delete.
3. **Hosts are plain web servers that store notes and hand them out, in the order they got
   them.** Anyone can run one, and a profile uses several. The app posts every note to all of
   them and keeps its own copies, so a host that closes or shuts someone out costs nothing
   lasting. Hosts hold no keys and set their own rules, from the signatures and the public
   registry.
4. **Assistants and apps hold nothing of yours: no key, no permission.** They read public notes,
   draft, and send you an approval link. Your phone shows the exact note; one tap and your
   passkey sign it, and it goes to your hosts. A draft waits in its link until you come back.
5. **Private notes (sealed entries) are available from day one, for reading and writing.** They
   are locked so only the readers you choose can open them, whoever writes them. The lock is
   post-quantum.
6. **Optional: a permission for a signer of your own.** An always-on program you run can publish
   some things, such as offers, while your phone is off. Taking the permission back ends it from
   then on; what it posted stays.

One honest line: **an assistant that wrote a post can recognize it later on public hosts, in
either mode.** It knows its own words; under a permission, the post also carries the signer's key.
*Verified.*

**Why not Nostr, the current lean.** Nostr's core is good, and this design borrows its best ideas.
But three things matter for Forest:
- **Its keys can never be Solana keys.** Every profile would need two keys and proofs tying them
  together.
- **It has no way to give a signer limited, revocable permission.** Its maintainers closed the
  proposals ("Nostr will not likely ever handle device keys"). The Nostr way is a server that
  holds your whole key, which Forest forbids.
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
- **A short spec and about 1,350 lines of code to own.** The core rules are 532 lines; the host is
  261; the approval page is 72, plus 86 it shares with the tests. Counts leave out comments and
  blank lines. One person can audit the core in a day.
- **The approval page is small:** 59 KB, with code from four libraries, all listed by the build
  and checked by a test.
- **No existing ecosystem.** We run our own hosts and indexes; this prototype includes both.
- **Checking signatures in plain JavaScript is slow:** about 340 a second on one core here.
  Production hosts and indexes need native code: about 10,000 a second on the same core.
- **Replaced:** the host fork, the relay (carrier), did:plc and the two secp256k1 keys in `keys/`,
  and the index's reader. The record shapes become plain JSON. None of this is in production.

**What stays hard.**
- **A stolen signer key.** If you gave a permission and its key is stolen, what the thief posts
  before you take the permission back stays, until you delete it (your own notes always win).
- **Hosts decide what came first.** When a reader comes late, the host's order says what arrived
  before you took a permission back. A dishonest host you chose could slip a thief's post in
  before; you delete it. *Verified finding.*
- **No key rotation.** If one profile's key leaks, that profile, and its badge in that market,
  are lost for good. This is the same as today, because every key comes from one seed.
- **The approval page is the most trusted code in Forest,** because it opens the seed. Whoever
  serves it could steal keys. It must stay tiny, locked down (it is, here: *verified*), and
  published with its hash and its library list.
- **Tapping without reading.** Approve a permission someone else asked for, and their key
  publishes within it until you take it back. The page says who asks, what for and until when.
  *Verified finding.*
- **Timing and network addresses can still link your profiles.** Examples: one phone writing both
  profiles at once, or one small host holding both. Apps and hosts must hide this; the protocol
  can't. *Verified finding.*
- **Passkey secrets (PRF) are missing in some password managers,** such as Dashlane and most of
  Bitwarden. This affects the keys recipe, not this protocol.

**Proved by running code:**
- profiles as wallets;
- two hosts and an index, with three kinds of feed;
- update, delete and pruning;
- draft and approve with a real WebAuthn passkey in Chromium (its virtual authenticator stands in
  for the phone), and an assistant over MCP 2026-07-28 whose draft waits for the person;
- a permission for a signer of your own; taking it back, also as seen by a reader who comes later;
- private notes written by you or by a signer, opened by the chosen reader only;
- a host shutting a reader out, then closing, with nothing lost;
- a signed host list on a public Pkarr relay, found by two other public relays;
- about fifty attacks.

**Believed, not tested:**
- real phones;
- the Mainline DHT itself (the other relays may share storage with the first);
- how AI apps show a long approval link;
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
  - A delegate's entry counts if some feed took it in while the exact grant version it names was
    current there. Revoking ends a grant from then on; nothing depends on a reader's clock.
  - Deletes are empty versions.
  - Entries dated too far ahead wait.
  - It is a pure function of the feeds: same feeds, same clock, same view. *Verified (view.test.ts,
    "the owner's entries in any order, over any split into feeds…", "each feed is walked in its own
    order…"; attacks.test.ts, "two indexes reading different hosts compute the same view").*
- **Folder.** A profile's own settings entry: its hosts, its box key, how many days hosts keep old
  versions.
- **Grant (a permission).**
  - Optional, off by default. Written by the owner, naming one key, path prefixes and an end time.
  - Revoking deletes it, from then on.
  - A grant field a reader does not know grants nothing.
- **Hosts.**
  - HTTP + SQLite, two endpoints: store, and read the feed in arrival order, filtered by cursor,
    profile, or badged profiles only.
  - They check every entry, keep current versions, and forget old ones after the owner's `keep` days.
  - They refuse replays after a move.
  - Anything more they refuse is their own policy, from signatures and the public registry.
- **Discovery.**
  - Signed folders on any host.
  - Crawling the hosts that folders name.
  - Optionally Pkarr (signed DNS records on the BitTorrent DHT) keyed by the profile key.
- **Sealed entries.** age files to each reader's box key, post-quantum hybrid by default, written by
  the owner or by a delegate.
- **Connections.** Approval requests carried in links; an approval page on the person's device; an
  MCP service for assistants that holds nothing (section 4).

## 2. Candidates compared

Four candidates, scored on the eleven needs (✓ meets, ◐ partly, ✗ no). The research behind each
cell is in `RESEARCH.md`, with sources.

| Need | A. AT Protocol (today) | B. Nostr + a Forest spec | C. Willow + Meadowcap | **D. Signed entries on plain hosts** |
|---|---|---|---|---|
| 1 records, public read | ✓ | ✓ | ✓ | ✓ |
| 2 only owner or authorized, no forgery | ◐ fork; delegates invisible | ◐ delegates are an add-on | ✓ | ✓ |
| 3 AI writers: tap or standing rules | ✗ scopes checked only by the host, no expiry | ◐ tap via NIP-46; rules need an online key | ◐ not revocable | ✓ tap by default; rules through a signer of your own |
| 4 versions, delete, prune after 30 days | ◐ no history | ◐ delete is a request | ◐ no history | ✓ on honest hosts |
| 5 many swappable hosts, keyless, blind | ✗ one host | ✓ | ✓ | ✓ |
| 6 no directory or relay | ✗ | ◐ indexer relays | ✗ no discovery | ◐ folders and crawling; Pkarr optional |
| 7 unlinkable profiles | ◐ | ◐ | ◐ | ◐ keys yes; timing and addresses are the app's to hide |
| 8 private data | ✗ Spaces not encrypted | ◐ pairwise only | ◐ guidance only | ✓ age, post-quantum, from day one |
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
| Grants, owner-first, revocation by arrival order | about 60 lines | NIP-26 is abandoned and has no revocation. UCAN needs a revocation feed and trusted time for stored records. Meadowcap has no revocation. Farcaster's needs a chain, and revoking there erases what the key signed. |
| The merge and retention rules | about 100 lines | Nostr and Willow keep only the newest version and have no multi-writer order; AT Protocol keeps no history. |
| The host API | about 260 lines | Nostr relays speak WebSocket with single-writer rules. Pubky's homeserver shape is closest, but it trusts the host with unsigned data. The AT Protocol PDS needs a fork. |
| The folder entry | 20 lines | A profile's hosts and box key must be signed by the profile and replicated with it. |
| The approval request and its link | about 30 lines | An unsigned entry with host hints, in a URL fragment. Nostr's NIP-46 needs a live signer on a relay; OAuth needs a server that remembers the request. |
| The `_forest` Pkarr record | 1 convention | Pkarr is unchanged; only the record name is ours. |
| The connections service and the approval page | about 190 lines | This is product glue: MCP and WebAuthn are used as specified. |

## 4. Connections, step by step

Apps and assistants alike: the protocol has no notion of an AI. Reading needs nothing: hosts and
indexes answer plain HTTP. What follows is about writing.

**Nothing to connect.** The assistant only needs your profile's name, which you give it once. The
MCP service needs no login and keeps nothing. *Verified:* connections.test.ts, "reading
needs nothing: no key, no grant, no login".

**Writing, with your phone at hand.**
1. "Post my physics tutoring at 40 an hour."
2. Claude calls `forest_draft`. The service answers `input_required` with an approval link (MCP URL
   mode). The link carries the exact note.
3. Claude shows the link. You open it on your phone.
4. The page shows exactly what will be signed, as plain text: "Publish offer/physics: description
   …, price …". One tap and a face scan. The phone signs with the profile's own key, posts to
   every host in your folder, and keeps a copy.
5. Claude comes back to the service, which reads your hosts, finds the note, and answers
   "Published".

*Verified, with a real passkey:* browser.test.ts, "an assistant over MCP: the draft's link opened
on the phone, one tap, reported published"; "a note: the page shows exactly what it will sign…".

**Writing while you are away.**
- Claude is told: "Not approved yet, and nothing is published. The draft waits in its link."
- The draft lives only in the link, so it never expires and no server keeps it.
- When you come back, days later, you open the link and approve. Claude sees the note on your
  hosts the next time it looks.
- A second copy of the service, which never saw the draft, gives the same answer.

*Verified:* connections.test.ts, "the person is away…"; "a draft: its link carries exactly the
note… a copy of the service that never saw it reports it".

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

**Optional: a signer of your own, for when your phone is off.**
1. Your signer (an always-on program you run) asks for a permission: a link like any other. The
   page says: "“My signer, offers only” asks to publish for you on its own, until 2026-10-06.
   Only: offer. Never over what you wrote yourself. You can take this back at any time. What it
   published before then stays."
2. One tap. The permission is a public note naming the signer's own key.
3. With your phone off, the signer publishes offers with its own key. Anything else it passes on
   to you as a link.
4. Taking it back is one more approval. From then on its key publishes nothing; what it posted
   stays.

*Verified:* browser.test.ts, "a permission for a signer of the person's own…"; grants.test.ts,
"the phone is off…", "revoked: it ends from now on…"; connections.test.ts, the take-back in
"FINDING, consent phishing…".

**What the design refuses.** *Verified.*
- A signer writing beyond its paths, over what you wrote yourself, into another profile, or
  granting itself more.
- A note approved with another person's passkey.
- A link asking to change your folder, or to sign a sealed note the page cannot show.
- A link changed in transit, not in its one canonical spelling, or carrying an extra field.
- A draft carrying HTML: it stays text, and the page's policy refuses HTML altogether.

*Verified:* view.test.ts, grants.test.ts, connections.test.ts, browser.test.ts, attacks.test.ts.

**Prompt injection is smaller than before.** An assistant that reads a hostile review can only
draft, and you see the exact note before it is signed. With a permission, your signer follows its
own rules, not an assistant's.

## 5. Trust points: every one, and no others

What each party can do, and what it cannot.

| Who | Can | Cannot |
|---|---|---|
| **The person's passkey provider** (Apple, Google, a password manager) | Whoever controls that account can get the PRF secret and so the seed: every profile, every wallet | Nothing else |
| **The approval page** (code served at forest.foundation and the related origins) | It opens the seed; malicious code could steal it | Mitigations: small (72 lines on the core; 59 KB built), four listed libraries, no third-party code, strict CSP with Trusted Types (*verified*), immutable build with its hash published (the build prints it) |
| **The app holding the seed** (e.g. Roots, for payments) | Same as the approval page, while unlocked | Apps that only need records never touch the seed: they send approval links |
| **The connections service** | See drafts and which profiles they are for; put different words in a link than the assistant asked for (the page shows the words before the tap); tell the assistant something false about the outcome (anyone can read the hosts) | Sign or publish anything: it holds no key and no grant (*verified*) |
| **A signer of your own**, if you give it a permission | Act within that permission while it runs; so can a thief with its key, until you take it back | Act beyond it; sign as the profile (*verified*) |
| **The AI provider** | Sees what it drafts, and which profiles one conversation touches; recognizes its words later on public hosts (*verified finding*) | Sign anything; it holds no key |
| **Issuers** (face check) | Vouch for humans, or wrongly vouch | Anything in this protocol; they matter to badges only |
| **Hosts** | Withhold, delay, or serve an older version to a reader who asks only them; decide the order a late reader sees around a revocation (*verified finding*); see network addresses, timing and sizes; keep what they should forget; refuse by their own policy | Forge, alter, or read sealed entries (*verified*: host.test.ts, attacks.test.ts, sealed.test.ts) |
| **Indexes** | Rank, hide, or misreport | Change what anyone else computes: anyone can recompute from hosts (*verified*: attacks.test.ts) |
| **Pkarr relays / the DHT** | Withhold, or serve an older hint | Forge a host list (*verified* against a tampering relay) |
| **The libraries** (noble, scure, canonicalize, typage, the MCP SDK) and the browser | Everything, if compromised | Pinned versions, few dependencies; noble is audited |
| **Solana** | Registry and escrow only | Nothing in this protocol |

Clocks:
- A writer's clock only orders its own versions.
- A host's clock decides only when a grant's `until` has passed, for what arrives there.
- No reader's clock ends anything.

No other party is in the path of a record, from the phone that signs it to the reader that checks
it.

## 6. Attacks, need by need

"Held" means the attack failed. **Finding** means it worked, and the report says what hides it.

| Need | Tried | Happened | Where |
|---|---|---|---|
| 1 | Read with no account, token or key | Held: reading is plain HTTP | host.test.ts, connections.test.ts |
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
| 3 | A signer writes outside its paths (a review, `offerx`), over the owner's own offer or card | Held | view.test.ts, grants.test.ts |
| 3 | A signer's entry that arrived before its grant | Held: counts for nothing | view.test.ts |
| 3 | A stolen signer key after revocation, also backdated; a reader who comes a month later | Held: hosts refuse it; the late reader still shows what was posted before, and nothing after | grants.test.ts |
| 3 | Edit or revive a grant to let in what arrived in between | Held | view.test.ts |
| 3 | Post after `until`, dated inside the grant's life | Held: hosts go by their own clock | grants.test.ts |
| 3 | A host slips a revoked signer's post in before the revocation, for late readers | **Finding:** late readers count it; the owner's delete removes it (owner first) | grants.test.ts |
| 3 | A signer grants itself more | Held: delegates can't write grants | view.test.ts |
| 3 | Another person's passkey approves the note | Held | connections.test.ts, browser.test.ts |
| 3 | A link changed in transit, non-canonical, with an extra field; a link for the folder or a sealed body | Held: refused | connections.test.ts, browser.test.ts |
| 3 | A second copy of the service, which never saw the draft | Held: same answer; there is no state to forge | connections.test.ts |
| 3 | HTML in a draft | Held: shown as text; the page's policy refuses HTML sinks | browser.test.ts |
| 3 | Approving a permission someone else asked for | **Finding:** their key publishes within it until taken back; the page names who asks, what for and until when | connections.test.ts |
| 4 | Bring back a deleted offer from a host that missed the delete | Held | attacks.test.ts |
| 4 | Date an entry far ahead to pin it | Held: hosts refuse, readers hold it back | host.test.ts, view.test.ts |
| 4 | A slow clock makes an edit lose | Held: writers date after the newest version | view.test.ts |
| 4 | A host keeps old versions it should forget | **Finding (inherent):** public data can be copied; only honest hosts forget | SPEC §7 |
| 5 | Search a host's whole database for the person's secrets | Held: none there | attacks.test.ts |
| 5 | Move hosts by copying | Held: same verified profile | host.test.ts |
| 5 | Replay an old folder or old entries to the old host after a move | Held: refused, or forgotten after `keep` | host.test.ts |
| 5 | A host shuts a reader out, then closes | Held: the reader uses the other host; the app's copies go to a new one; the same entries | host.test.ts "costs nothing lasting…" |
| 5 | The host reads a sealed note | Held | sealed.test.ts |
| 6 | A folder signed by someone else naming other hosts | Held | attacks.test.ts |
| 6 | A relay tampers with a Pkarr packet, or replays an older one | Held | discovery.test.ts; live: the public relay refused an older packet (409) |
| 6 | The Pkarr library's `fromBytes` on a tampered packet | **Finding:** accepted, because it doesn't verify; Forest checks signatures itself | SPEC §9 |
| 7 | Look for any key, id or box key shared by two profiles of one person | Held: nothing shared but what the person chose (the host, repeated template text) | attacks.test.ts |
| 7 | Two profiles written at the same moment | **Finding:** adjacent in the host's feed, same millisecond | attacks.test.ts |
| 7 | An assistant looks for what it wrote, on public hosts | **Finding:** found, in either mode: its own words, or its own key | attacks.test.ts |
| 8 | The host, a stranger, or the person's other profile opens a sealed note | Held | sealed.test.ts |
| 8 | A signer writes a sealed note under a permission; the grant still checked | Held: only the owner and the chosen reader open it; outside the grant's paths it is refused, sealed or not | sealed.test.ts |
| 8 | A removed reader opens the next version | Held; the old version stays readable to them until hosts forget it, and forever if they kept it | sealed.test.ts |
| 8 | Count the readers of a sealed note | **Finding:** anyone can | sealed.test.ts |
| 9 | Claim someone else's wallet | Held by construction: the profile is the wallet | core.test.ts |
| 10 | Two indexes on different hosts | Held: the same view | attacks.test.ts |
| 11 | Size of the core rules | 532 lines of code; 81 tests and 1 live test | this report |
| hosts | 200 fresh keys at a host with no policy | All taken: the protocol sets no budget | policy.test.ts |
| hosts | A flood of fresh keys at a host with its own policy (an example: 20 new profiles without a badge an hour) | Held by that policy, from signatures and the registry alone: new unbadged profiles waited, badged keys and profiles it held carried on, and a full profile could still leave | policy.test.ts |

## 7. Unlinkable profiles: what still links, and who must hide it

Nothing in the protocol ties two profiles of one person. *Verified: no key, box key, grant key or
id repeats.* These remain:

| Signal | Who sees it | The layer that must hide it |
|---|---|---|
| Network address (one phone writes for both profiles) | Hosts, Pkarr relays | The app and network: different hosts per profile; later, Oblivious HTTP (RFC 9458) relays in front of hosts; hosts never log addresses (policy, and Railway's own logs are an open item) |
| Timing (both written in the same second) | Anyone reading the feed (*verified finding*) | The app: publish each profile on its own schedule, with random delays |
| Host choice (a personal host, or the same small host for all profiles) | Anyone | The app: large shared hosts, or different hosts per profile; warn when a set is unique |
| Drafts for several profiles from one conversation | The connections service, the AI provider | One conversation per profile if it matters; the service keeps nothing |
| An assistant's own words, or its signer key | The AI provider, or whoever ran the signer (*verified finding*) | Nothing hides it: it wrote them |
| Money moving between the central wallet and profile wallets | Anyone, on chain | Unchanged from today: pools and ramps, the app's choice |
| The same passkey | Only the device | Passkey signatures are never published |
| Retention setting (`keep`), rare fields, writing style | Anyone | The app: defaults |

## 8. Hosts set their own policy

Keys are free, and the protocol sets no budgets. A host decides what else to refuse, from two
things the protocol gives it:
- **Signatures:** every entry says which key wrote it.
- **The public registry:** which keys hold a badge. The key is the wallet the badge names, so the
  host asks about the key itself.

That is enough to write a policy. The one tested is an example, not a rule: 20 new profiles
without a badge an hour, five entries each; badged keys unlimited. In a flood of 100 fresh keys it
took 20, profiles it already held kept writing, a badged key passed, and next hour new keys were
taken again. *Verified: policy.test.ts.* A host without a policy took 200 fresh keys.

Two limits stay in the protocol, because leaving would otherwise be at a host's mercy:
- a host always takes a newer folder for a profile it holds or held, so a person can always leave;
- a host never logs network addresses.

A host may also slow down floods at its network edge, like any website, outside the protocol.
*Believed:* whether signatures and the registry are enough for hosts under real spam needs real
traffic.

## 9. When a host closes, or shuts a reader out

It costs nothing lasting:
- Every note is on every host in the folder, and the app keeps its own copies.
- A reader that one host shuts out, or finds gone, reads another host or an index. A note checks
  the same wherever it comes from.
- Replacing the host is a move: a folder naming the new host, then the app's copies posted there.
  Ids don't change; the profile's name is its key, not a host's address.
- There is no account to lose and no key at the host, so a host cannot lock anyone out. It can only
  stop serving.

*Verified: host.test.ts, "costs nothing lasting…": a host refused every read, then closed; the
reader got the same entries from the other host, and the app's copies rebuilt the profile on a
new host.*

What does go: versions nobody else kept, and that host's own arrival order. And one edge: a new
host refuses a signer's posts whose permission has already ended by its clock, so those stay only
on the hosts that took them in time.

## 10. Scale: a billion profiles

*Believed, from measurements on one core of this machine (Xeon at 2.1 GHz, Node 22;
`bench/throughput.ts`). Numbers moved by up to a third between runs on this shared machine.*

| Measured here | Per second |
|---|---|
| Canonical text of an entry | 232,000 |
| Ed25519 verify, native OpenSSL | 10,186 |
| Ed25519 verify, Forest strict, pure JS | 343 (the subgroup check on R alone: 1,315) |
| Host check-and-store, SQLite, pure-JS crypto | 204 (bound by verification) |
| Host serving its feed, pages of 1,000 | 875,000 lines |
| Merging one profile of 1,000 entries | 8,564 merges |

One offer is 485 bytes on the wire.

Assume a billion profiles, 20 current entries each, and one new entry a week each.
- **Data.**
  - 20 billion current entries, about 10 TB network-wide.
  - Writes average 1,650 a second; a peak of perhaps 16,000.
- **Hosts.** At a million profiles per host, about 1,000 hosts of about 10 GB each. One SQLite
  file per host holds that; a host with 100 million profiles needs a database that shards.
- **An index that reads everything.**
  - It follows about 1,000 host feeds (cursors, plain HTTP).
  - Steady state: it checks about 1,650 entries a second, one core of native code with the subgroup
    checks.
  - First load: 20 billion checks. At 4,000 to 5,000 strict checks a second per core, that is 46
    to 58 core-days: about a day on 64 cores. It stores about 10 TB.
- **A market index.** It reads the badged feeds first (`badged=1`): profiles that hold a badge,
  with no spam. Then it reads in full only the profiles in its markets.
- **Discovery.** Crawling a thousand hosts is easy. Badged profiles are known from the registry.
  Pkarr lookups for millions of keys run in parallel on the DHT.

What must change before that scale:
- **Native signature checks** in hosts and indexes (SPEC §7).
- **Incremental merges** in the host: it currently recomputes a profile's view on every write.
- **Real storage** for the largest hosts.
- **Host policies** tuned on real traffic.

What does not have to change: the protocol has no global order, no directory and no relay, so
nothing in it grows with the network except each reader's own work.

## 11. The registry, and one key for records and money

- **The profile key is the wallet.** The badge's registry line should name the profile by that
  32-byte key, and the key signs the registration. The registry then binds the badge to the key
  that writes the records and receives the money, with no declared-wallet field and no cross-check
  by indexes. That closes the index's open item on declared wallets ("an unbadged profile can
  declare someone else's wallet").
- **Hosts read the registry** for their badged feeds and their own policies; indexes read it for
  badges. Both ask about keys, which is public.
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

## 12. What changes in the repo if this is adopted

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
| AI access | An approval page and a connections service that holds nothing, instead of OAuth scopes at the host |

## 13. Open questions

**Needs Carlos:**
- Adopt this, or Nostr with a Forest delegation spec, or stay? It changes rules in CLAUDE.md
  (section 12).
- **Revocation by arrival order trusts hosts' order** for readers who come late (section 6, the
  finding). The alternative is a trusted clock (a chain anchor) or re-signing, which this round
  removed. Acceptable?
- **Permissions.** Off by default here, for a signer of the person's own. Should Forest ship such
  a signer, or leave it to people who run their own?
- **Hosts.** Who runs the first hosts, and on what policy for profiles without a badge?
- **Pkarr.** Include it at launch, or rely on folders, crawling and pings first? The public relays
  work today (section 6).
- **Private data.**
  - Post-quantum by default: yes in this draft (about 1.1 KB per reader).
  - Personal data (contacts, health, AI memory) is a separate standard on the same entries; when?
- **One tap for several notes.** A request holds one note. Should one approval cover a batch?
- **Sealed drafts.** The page refuses a sealed note it cannot show. The fix is for the page to seal
  it itself, from the readers' folders, so the person sees who can read it. Now or later?

**Mechanical:**
- The in-app list of permissions, with "take back".
- Native signature checks (Rust or Go) for hosts and indexes; incremental merges in the host.
- Blobs (photos, video) by SHA-256 on hosts; Blossom's read path could be reused.
- Test on real phones: iOS, Android, Windows, and the cross-device flow.
- Long links: approval links for big notes may be cut by some apps, and don't fit a QR code.
- A Pkarr republisher in hosts (they hold the signed packet); a native DHT client for indexes.
- A spec review by someone outside, and a fuzzer on the entry parser.

## 14. Verified versus believed

**Verified by running code** (`cd lab/protocol && npm ci && npm test`: 81 tests pass;
`npm run test:net`: 1 live test passes):
- The profile key is exactly the wallet `keys/` derives. Two profiles share no public value.
- A profile, an offer and a review published to two HTTP hosts. An index finds the second host
  from the folder and merges both. Feeds by cursor, by profile and badged only.
- Update, delete, pruning after `keep` days, `keep: 0`, tombstones kept, and replay after a move
  refused. A host shutting a reader out, then closing: nothing lost.
- Draft and approve:
  - the link carries the exact note, and the service keeps nothing;
  - a draft waits while the person is away;
  - over MCP 2026-07-28 through the official SDK, with no login;
  - in headless Chromium with a virtual authenticator, a real WebAuthn passkey's PRF opens the
    seed; one tap signs and posts; HTML is refused; another person's passkey is refused; a broken
    link is refused;
  - the page's bundle holds four libraries, listed by the build.
- A signer of the person's own, under a permission, with the phone off. Refused outside its paths
  and at the owner's paths. Revocation ends it from then on, also for a reader who comes a month
  later. `until` by each host's clock. A reordering host (finding) and the owner's delete.
- Sealed notes, post-quantum, written by the owner or by a signer, opened only by the chosen reader
  and the owner; a reader removed on the next version. Reader count visible.
- Pkarr packets built by the official client, resolved through a stand-in relay, tampering and
  rollback refused; and live: stored by relay.pkarr.org (204), read back byte for byte, resolved by
  the official client, found by pkarr.pubky.org and pkarr.pubky.app, an older one refused (409).
- A host's own policy, from signatures and the registry alone; no budget in the protocol.
- Strict Ed25519 against OpenSSL, the Solana decoder check, and vectors checked by a second
  implementation.
- Throughput numbers (section 10).

**Believed, not tested here:**
- Real phones and their password managers. The cross-device Bluetooth flow.
- That the other relays found the packet through the Mainline DHT, rather than storage they share
  with the first relay.
- Behaviour with real AI clients: how Claude shows a URL-mode link, and prompt injection.
- Scale beyond one machine (section 10).
- Railway and Vercel not logging addresses.
- Whether hosts will actually be run by others.

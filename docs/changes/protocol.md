# Protocol lab log

## 2026-09-29: the data protocol, researched, designed, built in the lab, attacked

- **Built:** everything in `lab/protocol/`; nothing outside it changed except this log.
  - `RESEARCH.md`: what exists, with sources, as of today. Covers:
    - Nostr (NIPs 01, 09, 17, 26, 40, 42, 44, 46, 59, 65, 70, 77, EE/Marmot), AT Protocol (repo,
      PLC, OAuth scopes, Spaces), Farcaster, Pubky, Pkarr, did:dht, Web5 DWN, Willow and
      Meadowcap, UCAN 1.0, Keyhive, p2panda;
    - HPKE, MLS, age, did:key, VC 2.0, WebAuthn Level 3 PRF, MCP 2026-07-28;
    - agent authorization and payments: AP2, x402, OAuth drafts, AuthZEN, Visa, Mastercard,
      Solana delegation, Biscuit.
  - `REPORT.md`: page one in plain words; four candidates scored on the eleven needs; every
    invented piece justified; the AI connection step by step (phone, and a laptop without the
    passkey); trust points; attacks need by need; unlinkability; spam; scale; the registry
    interface; what changes if adopted; open questions; verified versus believed.
  - `SPEC.md`: signed entries on plain hosts, exact, with pinned vectors. The pieces:
    - a profile is one ed25519 key, the wallet keys/ already derives;
    - entries signed over `0xff` ‖ tag ‖ JCS;
    - owner-first merge;
    - grants naming an exact version, ended by revocation, edit, revival or expiry;
    - folders; hosts with two endpoints;
    - optional Pkarr hints; age sealed entries;
    - the door.
  - Prototype, TypeScript on Node 22. 442 lines of core rules; about 1,500 lines of code in all.
    - Parts: keys, canonical text, entries, merge, writing, an HTTP and SQLite host, client,
      index, sealed entries, Pkarr discovery, approval logic.
    - The MCP door on the official SDK v2 (2026-07-28, over HTTP).
    - An approval page with a strict CSP and Trusted Types.
  - Tests and benchmark: 77 tests, all passing, and `tsc` clean.
    - Headless Chromium with a PRF virtual authenticator.
    - An MCP client pinned to 2026-07-28.
    - Attacks per need, spam floods, vectors checked with a second implementation.
    - A throughput benchmark.
- **Chosen, not decided** (the task left it open; the option that adds the least was taken):
  - **The profile key's label stays** `forest.foundation/profile/<n>/wallet/v1`, so seeds already
    made keep working. The box key gets one new label, `forest.foundation/profile/<n>/box/v1`.
  - **Entry encoding.**
    - JCS with a `0xff` text prefix, not W3C `eddsa-jcs-2022` (same primitive, bigger) and not JWS
      (still needs canonical text).
    - Object keys `[a-z][a-zA-Z0-9]{0,63}`; whole numbers only; 64 KiB per entry.
  - **Time.**
    - Milliseconds; a 10-minute window for dates ahead.
    - Grants have no start field; they end at `until` by the reader's clock.
  - **Hosts.**
    - Keep 30 days by default, counted by the host's clock from when a version stopped counting.
    - NDJSON on the wire; at most 100 entries per request.
    - Budgets: unbadged 100 entries, 256 KiB and 30 writes a minute; badged 20,000, 64 MiB
      and 600; new unbadged profiles 1,000 an hour, 5 per address.
  - **Private and discovery.**
    - Sealed entries post-quantum by default: age's hybrid identity is a 32-byte seed, so it
      comes from the seed like every other key.
    - Pkarr record `_forest`, TXT `host=<origin>`.
  - **The door.**
    - Agent key HKDF(master, `forest.door/agent/v1/<nonce>`).
    - Tokens sealed with XChaCha20-Poly1305.
    - `requestState` signed by the SDK's HMAC codec.
    - Default grant: `["offer"]` for 7 days.
  - **The approval page** searches profile indexes 0 to 15 for the request's profile.
- **Decided in this session's chat** (Carlos, 29 September):
  - Design from first principles; nothing needs to fit the current version.
  - The record types are profile, offer, review, proof (a credential is one kind of proof).
  - The door is a trust point.
  - Spam defaults must be defined and tested.
  - Revocation drops what a grant signed unless the owner re-signs, with "keep these" as one
    approval.
  - A scale section.
  - An attack section per need.
- **Learned:**
  - **Nostr** has no maintained delegation. NIP-26 is "unrecommended", and the keychain
    proposal closed with "Nostr will not likely ever handle device keys". Its standing rules
    mean a signer holding the whole key.
  - **AT Protocol:**
    - Spaces (private data, alpha, 20 Aug 2026) is "access control not confidentiality".
    - plc.directory is still run by Bluesky PBC.
    - Ed25519 is not an allowed key type.
  - **Pubky** homeservers can forge: its own docs say data is not signed.
  - **Farcaster** changed hands in January 2026 and was looking for a new owner by August.
  - **MCP SDK:**
    - v2 (`@modelcontextprotocol/server` 2.2.0) serves 2026-07-28 only through its HTTP entry
      (`createMcpHandler`).
    - Its default supported versions stop at 2025-11-25.
    - An in-process `InMemoryTransport` negotiates the 2025 era, where the SDK's shim runs URL
      elicitation server-side. A test that seemed to check `requestState` replays was not doing
      so until the client was pinned to 2026-07-28 over HTTP.
  - **Pkarr:**
    - The JS client's `SignedPacket.fromBytes` accepted a tampered packet (it does not verify).
    - Its relay resolve path does refuse a tampered packet.
    - The client asks relays for `/<key>?policy=…`.
  - **Ed25519 across implementations:**
    - Node's OpenSSL accepts the universal signature (R = identity, S = 0) for the identity key.
    - For a mixed-order key, cofactored and OpenSSL verification disagreed on 12 of 16
      signatures. Forest's key rules (prime-order subgroup, not small order) remove both.
  - **Solana's own message decoder** refuses a Forest signing input: "version 127".
  - **Speed on this VM:** noble's strict verify runs about 260 a second on one core; native
    OpenSSL 8,265. Host intake is bound by verification.
  - **Node's TypeScript stripping** refuses parameter properties; write fields out.
- **Open:** `lab/protocol/REPORT.md` section 12. Needs Carlos:
  - adopt this, Nostr with a Forest delegation spec, or stay (it changes rules in CLAUDE.md);
  - revocation's cost as product behaviour;
  - default assistant permissions;
  - who runs the door and holds its master key;
  - host terms for unbadged keys, and hosts checking the registry;
  - Pkarr at launch or later;
  - when personal data gets its standard;
  - a list of known AI clients against consent phishing.

  Mechanical:
  - the OAuth screens and the connections list;
  - native crypto and incremental merges;
  - blobs;
  - real-phone tests and the cross-device flow;
  - a Pkarr republisher and a native DHT client;
  - an outside spec review and a parser fuzzer.

## 2026-09-29, second round: draft and approve by default; revocation from now on; hosts' own policy

- **Built:** all in `lab/protocol/`, as adopted with nine changes.
  - **Draft and approve is the default.**
    - `src/request.ts`: the approval request. It travels in a link after `#`; the page checks it,
      shows it as text, and signs and posts it from the person's device. There is no reply: the
      requester reads the hosts.
  - **`src/connections.ts` replaces the door.**
    - An MCP server (2026-07-28) with no login, key, grant or draft store.
    - Two tools: `forest_read` and `forest_draft`. A draft waits in its link.
  - **Revoking ends a grant from then on.**
    - The merge walks each feed in arrival order (`src/view.ts`).
    - Hosts refuse what arrives after a revocation, or after `until` by their own clock.
    - Hosts keep the grant versions their delegate entries name.
    - "Keep these" removed.
  - **Hosts.**
    - Budgets, quotas, rates and the per-address budget removed.
    - An optional policy hook, given signatures and the registry.
    - Feeds filtered by cursor, profile, and badged only.
    - Request order kept. `/.well-known/forest` dropped.
  - **The approval page, rewritten.**
    - One file, no framework, 59 KB.
    - Four libraries, listed by the build and checked by a test.
    - The box key moved to `src/sealed.ts`, so the page carries no encryption library.
  - **Tests: 81, up from 77, plus one live test.**
    - Revocation from now on: in the merge, at hosts, for a late reader, and with a reordering host.
    - Feed filters; a host shutting a reader out, then closing; a host's own policy.
    - Sealed notes written under a grant; a reader removed on the next version.
    - Connections over MCP; the new page in Chromium; the recognition finding.
    - The live Pkarr test from PR #35: `npm run test:net`.
  - **Docs.** SPEC, REPORT and README rewritten. The grant and delegated vectors were regenerated
    for the renamed label and path.
- **Chosen, not decided** (the plan was silent; the option that adds least was taken):
  - **A draft lives in its link**, as base64url of canonical text after `#`, not on a server. Done
    means the owner's version at the path, with that body, is on the hosts.
  - **An approval request is exactly `{v, profile, path, body, hosts}`.**
    - No "from" field: a permission's label is inside the grant.
    - The folder cannot be requested.
    - A sealed body cannot be requested, because the page must show what it signs.
  - **The service holds no grants.** Permissions are for a signer of the person's own. The door's
    agent keys, tokens, master key, OAuth connect flow and `requestState` are gone.
  - **`until` goes by each host's clock at arrival;** readers check only `time ≤ until`. So a new
    host refuses a signer's posts under a grant that has already ended.
  - **Hosts.**
    - They keep every grant version a kept delegate entry names.
    - `badged=1` means any badge in any market.
    - The `path` filter is removed (three filters, as asked).
    - Answers are always 200 with per-line results; 429 went with the budgets.
  - **The page keeps its copies** in the browser's localStorage.
  - **Test names.** The delegate fixture is `signer`; the vector grant is `grant/signer1`, "My
    signer, offers only".
- **Decided in this session's chat** (Carlos, 29 September, second round):
  1. Draft and approve by default. Grants are optional and off, with one paragraph on a signer of
     one's own.
  2. Revoking ends a grant from now on. Hosts and indexes keep what they saw before. No "keep these".
  3. No budgets or use-count limits in the spec. Hosts set their own policy from signatures and
     the public registry ("stamps" meant the signatures entries already carry).
  4. Feeds since a cursor, by profile, and badged only.
  5. The folder is unchanged. The app posts to all hosts and keeps copies. A section on a host
     closing or blocking a reader.
  6. "The door" becomes "connections"; the permission and approval-request formats go in the spec;
     the server is a service.
  7. The approval page is rewritten: minimal, dependencies listed.
  8. Sealed entries from day one, with two tests, and the recognition line on page one.
  9. Native signature checks noted.
  10. The live DHT test from PR #35; PR #35 closes after.
- **Learned:**
  - **MCP SDK v2.**
    - `inputRequired()` works without `requestState`.
    - A retried call carries `inputResponses`, read with `inputResponse(ctx.mcpReq.inputResponses,
      key)`. A stateless service needs no sessions and no codec.
  - **The merge needs feeds, not a bag of entries.** Walking each feed on its own keeps it
    deterministic, whatever order the feeds are read in (verified).
  - **Pruning would have broken revocation from now on.** Once a host forgets the old grant
    version, a late reader cannot place the posts made under it. Hosts must keep it.
  - **The old batch sorting was wrong for arrival order.** Folders, then grants, then content could
    put a revocation before a post sent earlier. Now: folders first, then request order.
  - **Moving a profile collides with `until` by host clock** (above).
  - **Public Pkarr relays answer from this sandbox.**
    - relay.pkarr.org took a packet (204) and refused an older one (409).
    - pkarr.pubky.org and pkarr.pubky.app returned it at once. Whether they share storage with
      relay.pkarr.org is unknown.
  - **The page needs no setup mode.** A test can read the virtual authenticator's PRF output
    through `page.evaluate`.
  - **Speed moved between runs.** Strict JavaScript verify: 262, then 343 a second. OpenSSL: 8,265,
    then 10,186.
- **Open:** `lab/protocol/REPORT.md` section 13. Needs Carlos:
  - revocation by arrival order trusts hosts for late readers: acceptable?
  - ship a signer of one's own, or leave it to people who run one?
  - hosts' policy for unbadged profiles, and who runs the first hosts;
  - Pkarr at launch;
  - when personal data gets its standard;
  - batch approvals, and sealed drafts through the page.

  Mechanical:
  - the in-app permissions list;
  - native checks and incremental merges;
  - blobs;
  - real phones and long links;
  - a Pkarr republisher;
  - an outside review and a parser fuzzer.

## 2026-09-30: adopted; the lab moves into records/

- **Built:**
  - **`records/`** from `lab/protocol/`, moved with its history: `SPEC.md`, the library, the
    reference host, the reference approval page, the tests, the vectors, the benchmark;
    `REPORT.md` and `RESEARCH.md` under `records/docs/`, kept as written.
    - A package, `@forest/records`, built to `dist/` with types on install and on pack. The core
      (`@forest/records`) pulls in no SQLite, MCP, Pkarr or age; `/host`, `/indexer`, `/sealed`,
      `/discovery`, `/connections` and `/schemas/*` are their own entry points. Checked from a
      scratch app installed both by tarball and by folder link.
    - 93 tests (81 from the lab, 12 for the schemas), 0 skipped; type-check clean.
  - **`records/schemas/`:** `profile`, `offer`, `review`, `proof` as JSON Schema 2020-12, from the
    four lexicons, with one example each from `shapes/examples`. No `$type`: the path says the
    kind. Decimals stay text; blobs are `{ sha256, mimeType, size }`.
  - **`keys/`:** one key per profile (`profileKey`: its did:key is the name, its address the
    wallet) and the box key (`boxKey`). The secp256k1 keys, did:plc, `@atproto/crypto`,
    `@ipld/dag-cbor` and `@did-plc/lib` are gone. `SPEC.md` sections 3, 6, 9, 10 and 11
    rewritten; the passkey-to-seed steps unchanged. `test/vectors.json`: each profile is
    `{ index, did, wallet, box }`; every wallet, the seed, identity, central wallet, words and
    seed file unchanged byte for byte. `records/` recomputes them with its own code. The test
    page shows name, wallet and box.
  - **Deleted:** `host/`, `carrier/`, `shapes/`, `names/`, `registry/scratch/`, `lab/`, and
    `index/`, `issuer/`, `feepayer/`, `deploy/`, `testsite/` (the services repo holds copies of the
    first four, pinned to forest f0a87e5).
  - **Text:** CLAUDE.md's three rule lines from the report's list (section 12 now; 11 when the
    task was written); one line atop `docs/handoff.md`; the root README's folder list; the root
    `.gitignore`'s host and testsite lines.
  - **CI:** `records` in the node matrix (its browser test in the runner's Chrome) and in the
    push-to-main type-check. The shapes, issuer, index and end-to-end jobs and the host build
    went with their folders.
- **Chosen, not decided** (the plan was silent; the option that adds least was taken):
  - `profile.wallet` dropped: the profile key is the wallet (report section 11).
  - `review.subject` is a did:key; `proof.issuer` any DID.
  - `proof.credential` is text: the credential as issued, JSON or a JWT.
  - Text limits are the lexicons' grapheme counts, applied as code points.
  - `dealId`'s pattern checks the base58 alphabet and 32 to 44 characters, not the decoded length.
  - Blob references are closed (`sha256`, `mimeType`, `size` and nothing else); records and
    their other objects stay open.
  - The degree patterns accept exactly the old rule's spellings, leading zeros included.
  - `records/src/keys.ts` keeps its own synchronous derivation, which the approval page needs;
    `keys/` stays the recipe. Both are checked against `keys/test/vectors.json`.
  - `keys/`' box key returns age's recipient too, so `keys/` now depends on `age-encryption`.
  - `@modelcontextprotocol/client` moved to devDependencies: only tests use it.
  - This log, not `docs/changes.md`: the task left `docs/` alone but for the handoff line.
- **Decided in this session's chat** (Carlos, 30 September):
  - The lab design is adopted.
  - Also delete `index/`, `issuer/`, `feepayer/`, `deploy/` and `testsite/`.
  - `registry/client` is not touched: its devnet script stays red until the registry session.
  - Market files stay as they are.
- **Learned:**
  - A W3C credential cannot be an entry body: `@context` breaks the entry key rule.
  - JSON Schema counts code points, not graphemes, and cannot check a base58 string's byte length.
  - The market-file format is written in lexicon field syntax (`maxGraphemes`, arrays with
    `maxLength`). Moving it to JSON Schema changes the `markets` repo's files, so it was not
    ported; its validator left with `shapes/`.
  - `age-encryption` bundles for the browser: the keys test page opens the box key in Chromium.
  - After `keys/` changed, the only code still using its old functions was
    `registry/client/scripts/devnet.ts` (and the deleted `index/` and `deploy/`).
- **Open:**
  - **Red until the registry session:** `registry/client`'s type-check, two errors in
    `scripts/devnet.ts` (`didGenesis`, `profileKeys`). Its tests pass. Report section 11 says
    what the registry should bind: the profile key alone.
  - **Markets:** `markets/check.sh` must pin a forest commit from before this change until the
    Markets phase. The market-file format and its validator need a new home.
  - **Stale text:** `docs/handoff.md` and `docs/changes.md` still describe AT Protocol, the host,
    the carrier and did:plc (the handoff's first line points to `records/SPEC.md`); a comment in
    `escrow/client/src/terms.ts` names `shapes/`. A consolidation session folds this log.
  - The reference host is a class; a runnable service, and where the approval page is served,
    belong to the services repo.
  - Report section 13's questions are still open.

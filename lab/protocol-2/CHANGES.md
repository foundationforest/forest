# Lab log: protocol-2

This session's log lives here, not in `docs/changes.md`, because the task said to change nothing
outside `lab/protocol-2/`. A consolidation session can fold it in.

## Plan (written before the work)

1. Read the current design (`CLAUDE.md`, `docs/handoff.md`, `docs/decisions/host.md`, `keys/SPEC.md`,
   `shapes/`, `host/README.md`, `docs/attack-pass.md`).
2. Name what the current data layer (AT Protocol, forked host, did:plc) cannot do by construction
   against the eight claims, and what it does well.
3. Design the smallest protocol that meets all eight, built only from standard primitives, and say
   for each piece which existing thing it is and what, if anything, is new.
4. Prototype it in TypeScript on Node 22 (built-in SQLite and WebCrypto), with one test file per
   claim, each test named for the claim it proves, adversarial cases included.
5. Write the report: first page for a non-technical founder, then the comparison, the costs, and
   the risks; the spec; and the claims table (verified by a named test, or believed).
6. Open a pull request. Change nothing outside this folder.

## 2026-09-29: protocol-2, the data layer questioned and rebuilt in the lab

- **Task:** design the protocol people's records live in and prove it works, against eight claims;
  a report with a plain first page, a short exact spec, a prototype with tests that also try to
  cheat it, every claim marked verified by a named test or believed. Work only in `lab/protocol-2/`.
- **Built:**
  1. `README.md`: the report. Page one for a founder; the eight claims; the design in a page; what
     changes for Forest and what does not; the honest comparison with keeping AT Protocol; costs in
     numbers; risks; how to run.
  2. `SPEC.md`: keys (two new HKDF labels, the control key dropped), did:key names, DAG-CBOR and
     CIDs, the entry (five ops, the grant's five limits), the rules in order with the name of each
     refusal, the pointer as a BEP44 item in Pkarr's form, private records (HPKE-wrapped content
     keys, opaque keys), permits and blobs, the host's routes, the index's behaviour, what is
     borrowed and what is new, a reading order, the constants.
  3. `src/`, about 1,300 lines in ten files: `entry.ts` (the rules), `keys.ts`, `did.ts`, `codec.ts`,
     `private.ts`, `pointer.ts`, `permit.ts`, `host.ts` (HTTP over Node's SQLite, no accounts, no
     addresses), `client.ts` (a writer for a device or a delegate; mirrors by pull), `index.ts`
     (verifies for itself, follows references, learns and re-resolves pointers, marks forks).
  4. `test/`: 33 tests in eleven files, one per claim plus vectors, shapes and forks; and
     `test/net/pkarr.test.ts`, which put a pointer through `relay.pkarr.org` and got it back byte for
     byte. `test/vectors.json` pins keys, six entries, a pointer and a permit from the keys recipe's
     own test seed. `scripts/vectors.ts` regenerates them; `scripts/verify.ts` verifies any log from
     any host.
  5. `CLAIMS.md`: the table.
- **Chosen, not decided** (each reversible; nothing ships):
  1. did:key with no rotation, over did:plc or a directory of our own. Reasoned in the report.
  2. A hash-chained log with per-entry signatures, over the AT Protocol repo with delegate keys in
     the DID document. The chain is what makes revocation a rule without a clock.
  3. Delegation in UCAN 1.0's shape but with five fixed limits and no re-delegation, implemented in
     the rules file rather than imported: the reference libraries carry transports and a policy
     language an auditor would have to learn.
  4. Private records hide the collection and the key inside the ciphertext; the entry's key is
     opaque. Sizes, counts, timing and readers' key ids stay visible, and the spec says so.
  5. Pointers as Pkarr/BEP44 bytes so one signature serves the DHT, hosts and indexes.
  6. The host checks `at` within 300 seconds; the verifier does not check time at all.
  7. Hosts mirror by pulling from another host; a writer writes to one and asks the rest to pull.
  8. Blobs need a signed permit; unreferenced blobs may be dropped after it expires (not built).
  9. This log lives in `lab/protocol-2/CHANGES.md`, not `docs/changes.md`, as the task said to
     change nothing else.
- **Learned:**
  - Three claims (an AI writing while the phone is off, private records, no central directory)
    fail on the current layer by construction, not by bug, and fixing them makes it non-standard.
  - Rotation in the current design protects against no threat that can occur: every key comes
    from one seed, so a leak of one is a leak of all. Its one real value is post-quantum migration.
  - A public Pkarr relay accepts and returns a pointer signed here with no account, no key of
    theirs, and no fee; a lower sequence is refused as BEP44 says.
  - Node 22 needs nothing installed for SQLite, ed25519, X25519, AES-GCM or TypeScript.
  - The whole thing measures about 2.5 ms per entry to sign, verify and apply in JavaScript, and
    6 to 8 ms per write through the host, flat across profiles and log length.
  - The index must learn a profile's pointer when it first meets it, or a second index seeded
    from it has nothing to ask; found by the test, fixed.
- **Open:**
  1. Whether to take this path. *Needs Carlos.* If yes: what stays of `host/`, `carrier/`, the
     index's readers, and the keys package's control key and did:plc code.
  2. A second reader for `src/entry.ts` before anything real. *Needs Carlos, money.*
  3. The successor mechanism for a key that must change, and the registry v2 change that lets a
     code re-point to a successor DID. *Needs Carlos, later.*
  4. Abuse limits on a host without accounts: per DID, per size, badge-gated storage. *Mechanical.*
  5. Blob expiry for unreferenced blobs; private blobs (encrypt with the same content key). *Mechanical.*
  6. Load: SQLite write throughput under concurrent writers, the host behind a front that hides
     addresses, Pkarr from a phone. *Mechanical.*
  7. Names: a DNS TXT record from a name to a did:key, later, as before. *Needs Carlos, later.*
  8. An inclusion proof per record (a Merkle root per host-signed head, or an index-signed state)
     if buyers' apps need one without the whole log. *Needs Carlos.*
- **Still standing:** nothing is shipped; nothing outside `lab/protocol-2/` changed.

# The host: Vow as is, a fork, or a minimal host

Decided after this report, in session 7: the recommendation below was taken, and `host/` holds the fork of the reference PDS's write path. The report is kept as written; see `docs/changes.md`.

Session 6, September 2026. Report only. No host code was written, nothing was run against a relay,
and nothing here is decided. Every claim about a codebase cites a file and line in that codebase as
cloned on September 17, 2026, so it can be checked.

The host is the AT Protocol server that stores each profile's folder and serves it to the carrier.
Forest's rule for it: it must accept commits signed on the user's device, and it must never hold a
signing key. Session 2's `keys/` produces those signatures. It should run on Railway with plain
SQLite files.

## In plain language

Four candidates were read: Vow (Go, "keyless"), Bluesky's reference PDS (TypeScript), rsky-pds
(Rust), and millipds (Python), plus a look at tranquil-pds (Rust) and the planning notes for a
Rust PDS that does not exist yet.

**What was found.** Only Vow lets the user's device sign a commit today. It does exactly the
two-phase write Forest wants: the server prepares the commit, sends the unsigned bytes to the
user's browser tab over a WebSocket, the tab signs with a key derived from a passkey, and the
server checks the signature and stores the commit. The commit that comes out is a normal AT
Protocol commit that any relay can verify. So the idea is proven in running code, and that is
worth a lot.

But Vow is one person's experiment on top of another person's small project. It has no tests at
all. It needs an IPFS node running next to it, because every repo block and every photo is stored
in IPFS, not in SQLite. Its signing is welded to its own login page and its own passkey handling.
It still holds a server key that signs the first commit of every account and every imported
repo. It ignores the write-conflict check that the protocol relies on. Its last commit is from
May 2026, and it pins a personal fork of Bluesky's Go libraries.

The reference PDS does not do any of this today: it holds one private key per user on its disk and
signs every commit itself. But the place where it signs is one small function, the part that talks
to relays never touches the key, it runs on SQLite files and a disk folder for photos, it has over
four hundred tests, and it is what every relay, directory and client is tested against. The change
to make it accept a device-signed commit is confined to a handful of files.

rsky-pds is the same design in Rust, moved to SQLite this summer and actively maintained, but
larger and with a concrete key type baked into the signing call. millipds has the cleanest and
smallest write path of all (one function) but has been quiet for nearly a year, keeps the key in
its database, and its author says the schema may break without a migration. tranquil-pds needs
Postgres and is AGPL. Nothing else maintained was found that accepts an outside signature.

**Recommendation.** Do not run Vow, and do not fork it. Use it as the proof and the reference for
the design: the flow it implements is the flow to build. Fork the reference PDS's write path,
which is a small, well-fenced change to a well-tested codebase. If that fork turns out to fight
the reference PDS's account machinery more than expected, the fallback is a minimal host written
on Bluesky's own repo and server libraries, which is more code to own but no code to carry.
Unknown until built: whether the pending-commit state and the device-signed write authentication
can be added without touching the OAuth code; how much the fork costs to rebase (the history says
every few months, small); whether the two-step round trip is fast enough from a phone; and
whether SQLite on a Railway volume holds up under the carrier's subscription. Nothing is decided
in this session.

## 1. Vow

Source: `tangled.org/julien.rbrt.fr/vow`, cloned with full history. MIT (`Dockerfile` label,
`license`).

**What it is.** A fork of Hailey's cocoon, a Go PDS (`git log`: initial commit 2025-03-28 by
Hailey, squashed; `readme.md` names cocoon), with a keyless layer added by Julien Robert from
2026-03-10 ("feat: add vow features"). 213 commits, 92 by Hailey and 73 by Julien Robert, last on
2026-05-28. 13,796 lines of Go outside tests. **Zero test files** (`find . -name '*_test.go'`
returns nothing; `go test ./...` reports "no test files" for every package). `go build ./...`
succeeds. `go.mod` requires Go 1.26 and replaces Bluesky's `indigo` with a personal fork
(`go.mod:5`: `replace github.com/bluesky-social/indigo => github.com/julienrbrt/indigo`).

**What "keyless" means here** (`specs.md`, "Overview" and "Key Types"). The user's passkey is
created with the WebAuthn PRF extension. The browser page derives a secp256k1 signing key from the
PRF output with HKDF-SHA256 (`server/templates/account.html:304-327`), keeps the PRF output in
`localStorage` (`account.html:453`), and sends the server only the public key. The server stores
two public keys and a credential id per account: `auth_public_key` (the passkey's own P-256 key,
for WebAuthn assertions) and `signing_public_key` (the derived secp256k1 key, for commits)
(`models/models.go:21-25`; the comment on line 23 says P-256 but the code parses it as K-256,
`server/repo.go:627`, `handle_server_supply_signing_key.go:116`). The DID document then carries
the derived key as `atproto`, the PDS's own P-256 key as `atproto_service`, and the derived key as
the only rotation key; the PDS rotation key is removed
(`server/handle_server_supply_signing_key.go:47-68`).

**Does the write path accept a commit signed outside its own login flow?** Yes for the signature,
no for the channel it arrives on.

- `applyWrites` (`server/repo.go:352`) applies the ops to the MST, writes the new blocks, and
  serialises the commit with an empty signature: `buildUnsignedCommit` (`repo.go:183-212`,
  "does NOT require a signing key"). It keeps everything needed to finish in memory as
  `pendingCommitState` (`repo.go:313-335`), pushes a `sign_request` carrying the base64url
  unsigned commit CBOR to the account's signer over a WebSocket (`repo.go:588-617`,
  `SignerHub.RequestSignature`), and blocks the HTTP request until the signature arrives or 30
  seconds pass (`server/signer_hub.go:301`).
- The reply must carry a WebAuthn assertion whose challenge is the unsigned commit bytes, and a
  raw 64-byte secp256k1 signature over those same bytes. The server verifies the assertion
  (rpId hash equals the PDS hostname, user-presence flag set: `server/webauthn.go:237-254`, with
  `s.config.Hostname` as rpId at the call site in `server/handle_signer_connect.go`) and then the
  commit signature against the stored public key (`handle_signer_connect.go`,
  `verifyWebAuthnSignResponse`; again `repo.go:623-631`). `finaliseCommit` attaches the
  signature, writes the commit block and returns its CID (`repo.go:213-259`);
  `finaliseWriteFromState` persists records and emits the firehose event (`repo.go:644`).
- The signer channel is Vow's own: a WebSocket opened from the account page under a session
  cookie (`server/handle_account_signer.go`, route `/account/signer`, `server/server.go:556`) or
  under a bearer token from Vow's session (`server/handle_signer_connect.go`, route
  `com.atproto.server.signerConnect`, `server.go:599`). Registering the key requires a WebAuthn
  attestation object from a passkey created on Vow's hostname
  (`handle_server_supply_signing_key.go:26-36`). The commit-signature check itself is generic:
  bytes, a public key, `HashAndVerifyLenient`; nothing about how the key was derived.

**What the server still signs.** The genesis commit of every new account and every imported repo
is signed by the PDS rotation key (`server/handle_server_create_account.go:166-206`,
`server/handle_import_repo.go:110-114`, `commitRepo` at `repo.go:261`, "kept for the
initial-account-creation path"). The DID is created by the PDS with that key and control is
transferred to the user later (`server/plc/client.go:149-165`, `specs.md` "Key Transfer
Operation"). So the server does hold a private key that has signed commits; what it never holds is
the user's signing key after registration.

**Gaps found in the write path.** `swapCommit` is accepted and ignored (`repo.go:311` "TODO make
use of swap commit"; `repo.go:353` `_ = swapCommit // TODO: eventually use this.`). Two writes
racing for one repo have no protocol-level guard. Pending state lives only in memory, so a restart
during the signing wait loses it (harmless: the request fails and the client retries).

**Does a standard relay accept its repos?** The sync surface is complete: `subscribeRepos`,
`getRepo`, `getRecord`, `getBlocks`, `getLatestCommit`, `getRepoStatus`, `listRepos`, `listBlobs`,
`getBlob` (`server/server.go:528-539`). The firehose is Bluesky's own `events` package with a
SQLite-backed persister (`server/persist.go`), so the frames are ordinary `#commit` frames with
CAR blocks. The commit's signature verifies against the DID document's `atproto` key, which is
the device's derived key. There is nothing Vow-specific for a relay to accept or reject. Not
tested here against a relay; the readme says people use it with `bsky.network`.

**What it needs to run.** Go 1.26; a Kubo IPFS node, because the only block store is IPFS and
every repo block and every blob goes through its RPC API (`cmd/vow/main.go:82`: "All repo blocks
and blobs are stored via this node"; `blockstore/ipfs.go` is the only backend; `server/server.go:401-404`
connects at startup; 21 Go files reference it); SQLite through gorm for accounts, the record index,
blob references and firehose events (`go.mod`, `VOW_DB_NAME` default `/data/vow/vow.db`); a
rotation key and a JWK on disk; SMTP optional. `docker-compose.yaml` runs three services plus a
one-shot invite creator, with the IPFS node exposing peer-to-peer port 4001. On Railway that is two
services with volumes, and the IPFS node is not "plain SQLite files".

**What would have to change for Forest, and how large it is.**

1. Key registration: replace the attestation-based `supplySigningKey` with "here is my signing
   public key and my DID", since `keys/` already derives the key and the device makes the DID.
   About one handler.
2. The assertion on every write: either make it optional, or make the rpId and allowed origins
   configurable so a passkey belonging to `forest.foundation` can be asserted from Soil's origin
   (`webauthn.go:237-240` hard-codes the PDS hostname). Small, but a product decision: does
   every post and review need a biometric prompt, or only unlocking the seed?
3. Accounts: email and password are required at signup (`handle_server_create_account.go:25-29`),
   plus invite codes and sessions; every write needs a bearer token from Vow's session
   (`server.go:603-606`). Forest has no accounts, so the prepare step would authenticate by a
   service JWT the device signs with its own key. Touches signup, session and middleware.
4. The block store: replace IPFS with a SQLite or disk store. cocoon upstream has one; Vow's write
   path depends on the recording store and a `Verify` hook (`repo.go:236-247`,
   `newRecordingBlockstoreForRepo`). Twenty-one files reference IPFS.
5. Address logs: every request is logged with `remote_addr` at info level, unconditionally
   (`server/server.go:273-279`); `handle_oauth_authorize.go:218-219` reads `X-Forwarded-For`;
   `handle_sync_subscribe_repos.go:27` keys subscribers by remote address. Three sites.
6. The DID flow: Forest makes the DID on the device with the control key as rotation key.
   `createAccount` accepts a caller-supplied DID (`handle_server_create_account.go:24-26`) but
   then writes an empty root, and `applyWrites` casts the root unconditionally
   (`repo.go:355`); whether a bring-your-own DID can make its first write is untested.
7. Tests: none exist, so every change above would be the first test of that path.

Rough size: 1,500 to 2,500 lines touched or added out of 13,800, in a codebase with no tests,
one active author, and a pinned personal fork of its main dependency. Vow's own `specs.md` lists
the open ecosystem gap honestly: AppViews verify service-auth tokens against `atproto`, not
`atproto_service`, so its "compat mode" makes the passkey sign those too
(bluesky-social/atproto discussion #4739).

## 2. The reference PDS

Source: `github.com/bluesky-social/atproto`, `packages/pds` and `packages/repo`. Dual MIT and
Apache-2.0. 801 commits between 2025-10-02 and 2026-09-16 in the deepened clone, that is, daily
activity. `packages/pds/src`: 20,893 lines of TypeScript; `packages/repo/src`: 3,249. 57 test
files and about 412 test cases under `packages/pds/tests`. Node 22 or later.

**Where exactly it signs a commit.** One function: `signCommit(unsigned, keypair)` in
`packages/repo/src/util.ts:87-96`, which DAG-CBOR-encodes the unsigned commit and calls
`keypair.sign(encoded)`. It is called from `Repo.formatCommit` (`packages/repo/src/repo.ts:118-201`,
the call at 162), from `formatInitCommit` (`repo.ts:57`) for a new repo, and from
`formatResignCommit` (`repo.ts:206`). The PDS reaches it through
`RepoTransactor.formatCommit`, which loads the repo and calls
`repo.formatCommit(writeOps, this.signingKey)` (`packages/pds/src/actor-store/repo/transactor.ts:166`),
from `processWrites` (`transactor.ts:79-102`), inside the actor's SQLite transaction opened by the
XRPC handler: `ctx.actorStore.transact(did, async (actorTxn) => { processWrites; sequencer.sequenceCommit })`
(`packages/pds/src/api/com/atproto/repo/applyWrites.ts`, handler body). The `swapCommit` check
is at `transactor.ts:114-116`.

**Where the key comes from.** A private key file per user on the PDS disk, next to that user's
SQLite database: `ActorStore.keypair(did)` reads it and imports it as a secp256k1 keypair
(`packages/pds/src/actor-store/actor-store.ts:41-45`); `ActorStore.create(did, keypair)` writes it
at account creation (`actor-store.ts:107-116`, `fs.writeFile(keyLocation, privKey)`). Account
creation generates it as an exportable keypair (`actor-store.ts:155-159`) or takes a reserved one.
The `Keypair` type the repo library needs is only `did()` and `sign(bytes)`.

**The smallest change that accepts a client-signed commit.** Two shapes, from smallest to
cleanest.

- *Remote signer, no protocol change.* Give `ActorStore.keypair(did)` a `Keypair` whose `sign`
  sends the bytes to the device and awaits the signature (the way Vow does, over a WebSocket or a
  long-poll), and store only the public did:key at creation. Nothing in `packages/repo` or the
  transactor changes; the relay side sees an ordinary commit. Cost: the actor's SQLite transaction
  stays open while the device signs, so a timeout is mandatory. Per-user database, so only that
  user's writes wait. About 300 lines for the signer channel plus a few dozen changed.
- *Two-phase over HTTP, the shape the handoff asks for.* Split `Repo.formatCommit` into a part
  that returns the unsigned commit bytes with the new blocks, rev and ops, and a part that takes
  the signature and produces the CID (about 40 lines in `repo.ts`, where the `UnsignedCommit`
  type already exists). Add two XRPC methods: prepare, which runs the existing checks and MST work
  and stores the pending commit (rev, data CID, new blocks, ops, `prev`) in the actor database
  under a token with a short expiry; and submit, which takes the token and the signature, checks
  the repo root is still the pending `prev` (the same check as `swapCommit`, `transactor.ts:114`),
  verifies the signature with `verifyCommitSig` (`packages/repo/src/util.ts:99-105`) against the
  DID document's `atproto` key, then runs the existing `applyCommit`, `indexWrites`,
  `processWriteBlobs` and `sequencer.sequenceCommit` in one transaction. Files: `repo.ts`,
  `transactor.ts`, two new handlers with two lexicon files, `actor-store.ts` (no key file; store
  the did:key), `createAccount.ts` (take the device's DID, signing key and PLC operation; the
  "bring a DID and plcOp" path exists at `createAccount.ts:153-175` but requires the entryway's
  rotation key in the operation at 162-163, which changes). About 400 to 600 lines added and 60
  changed, in six to eight files.

`importRepo` is the closest existing entrypoint that stores an outside commit
(`packages/pds/src/api/com/atproto/repo/importRepo.ts`), but it replaces the whole repo, and it
passes no key to the verifier, so the imported commit's signature is not checked
(`verifyDiff(currRepo, blockMap, roots[0], undefined, undefined, ...)`; the check runs only
`if (signingKey !== undefined)`, `packages/repo/src/sync/consumer.ts:118-119`). Not a write path.

**Does the relay-facing side need any change?** No. `packages/pds/src/sequencer` and
`packages/pds/src/api/com/atproto/sync` contain no reference to `signingKey` or `keypair`;
`sequenceCommit(did, commitData)` formats the `#commit` frame from the commit data alone
(`packages/pds/src/sequencer/sequencer.ts:173-177`).

**Storage and running it.** One SQLite file per user (`actor-store/db/index.ts:15`,
`Database.sqlite(location)`), plus account and sequencer databases, blobs on disk
(`packages/pds/src/disk-blobstore.ts`) or S3. This is how Bluesky's own self-host image runs, and
it fits Railway with one volume.

**What breaks on upstream updates.** Changes since 2025-01-01 in the files the fork cuts through:
`actor-store/blob/transactor.ts` 15, `sequencer/sequencer.ts` 10, `repo/car.ts` 10,
`sequencer/events.ts` 9, `repo/types.ts` 8, `actor-store/record/reader.ts` 8, `api/.../putRecord.ts` 7,
`importRepo.ts` 7, `actor-store/record/transactor.ts` 7, `repo/util.ts` 6, `repo/repo.ts` 6. The
two files where the split lives, `repo.ts` and `repo/transactor.ts`, changed six and seven times in
twenty months. A rebase every few months, small each time, as long as the fork stays in those
files and adds handlers rather than editing existing ones.

**What the PDS knows about people.** Client IP is used as a rate-limit key in memory
(`packages/pds/src/rate-limits.ts:26,42`; `createSession.ts:30,35`) and forwarded on proxied
requests (`api/proxy.ts:37-39`). Request logging goes through pino and must be turned off or
stripped of addresses; for Forest, rate limits key on the DID. The PDS is account-centric: email,
password, OAuth, app passwords, invite codes, an optional entryway. Every write presents
credentials through `ctx.authVerifier.authorization(...)` at the top of each handler, separate
from the handler body. The PDS already verifies service JWTs signed by a DID's key for
inter-service calls (`packages/pds/src/auth-verifier.ts:539-549`), which is the credential a
device with its own signing key can mint, so "no accounts" is a new branch in the auth verifier,
not a new auth system.

## 3. Other implementations

**rsky-pds** (Rust, Blacksky, Apache-2.0). Active: 496 commits touching `rsky-pds` from
2023-11-15 to 2026-09-17, mostly by Rudy Fraser. 93,158 lines in `rsky-pds/src` and 7,579 in
`rsky-repo/src`, about 821 test functions. Storage moved to SQLite on 2026-07-14 ("add sqlite
storage foundation"): per-actor `store.sqlite`, an account database, a sequencer database, blobs
on disk or S3, and a per-actor key file `{data}/actors/<shard>/<did>/key` (`rsky-pds/README.md`;
`actor_store/mod.rs:489-504`). It signs the same way the reference does:
`sign_commit(unsigned, keypair)` in `rsky-repo/src/util.rs:21-30`, called from
`format_commit` / `process_writes` (`rsky-pds/src/actor_store/mod.rs:1030,1174`) with the
swap-commit check (`mod.rs:1183-1187`). Historically all repos shared one signing key from the
environment (`rsky-pds/src/context.rs:10-12`, `PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX`) and a
`rotate-keys` binary migrates to per-actor keys (`rsky-pds/src/bin/rotate-keys.rs`). No path takes
an outside signature. The keypair is the concrete `secp256k1::Keypair`, not an interface, so a
remote signer cannot be slotted in without changing the signing call; the two-phase split is the
same two or three functions as in TypeScript. Rate limits read `X-Forwarded-For`
(`rate_limits.rs:513-520`). A serious fork candidate if Rust is preferred, at four times the size
of the reference's PDS package and with fewer hands. Not compiled here.

**millipds** (Python, MIT). 3,596 lines, 241 commits from 2024-02-25 to 2025-10-09, 237 of them
by one author, 77 tests. One SQLite file. The user's signing key is stored as PEM in the `user`
table (`src/millipds/database.py:157-166`). The whole write is one function,
`repo_ops.apply_writes` (`repo_ops.py:138`), in one transaction: MST diff, ops, proofs, the
signature at `repo_ops.py:361-364`, the firehose row. The `swapCommit` check is at 155-159. The
author's own comment at line 142: "one big transaction (we could perhaps work in two phases,
prepare (via read-only conn) then commit?)". The cleanest write path to split, and the least
maintained: the README says it is not production grade and the schema may break without a
migration path until 1.0. Access logs include `X-Forwarded-For` (`static_config.py:8`) and the
firehose logs each client's address (`atproto_sync.py:332`). No outside signatures.

**tranquil-pds** (Rust, AGPL-3.0-or-later, `tangled.org/tranquil.farm/tranquil-pds`, mirror at
`github.com/Bogay/tranquil-pds`). Active through 2026-09-12, about 218,000 lines including tests,
Postgres through sqlx (`Cargo.toml:126`). Its passkeys and 2FA are for logging in, not for
signing (`README.md`). Postgres and the AGPL both cut against Forest; not read further.

**cocoon** (Go, Hailey). Vow's upstream, with a SQLite block and blob store. Not keyless. Not
cloned separately; read through Vow's history.

**atproto-pds** (Rust, planned). A design note dated May 1, 2026 proposes a new crate with
per-account SQLite by default; design only, no code. Its own comparison table lists the same set
as above (reference, indigo's deprecated Go PDS, rsky-pds, tranquil-pds, cocoon), which is a fair
sign the survey is complete.

Nothing maintained was found, in any language, that accepts a device-made signature on an ordinary
write, other than Vow.

## 4. One write from Soil, on the two closest

The two closest to Forest's rule are Vow as it runs today and the reference PDS with the two-phase
fork. In both, the device builds the record from `shapes/` and validates it before anything
leaves the device, and photos are uploaded before the record that points at them.

**A. Vow, as it runs today.**

1. Soil's page holds the profile's signing key. In Vow the page derives it from the passkey's PRF
   output with HKDF (`account.html:304-327`); for Forest the page would hold the key `keys/`
   derives instead, and the server would not know the difference.
2. The page keeps a signer WebSocket open to the host, authenticated by Vow's session
   (`/account/signer` or `com.atproto.server.signerConnect`).
3. Soil sends `com.atproto.repo.applyWrites` with the record, authenticated by Vow's session
   token.
4. The host loads the repo from IPFS, applies the op to the MST, writes the new record and MST
   blocks to IPFS, serialises the commit with an empty signature, keeps the pending state in
   memory, and pushes `sign_request {requestId, did, payload: base64url(unsigned commit CBOR),
   ops}` down the WebSocket (`repo.go:352-617`). The HTTP request waits, up to 30 seconds.
5. The device asks the passkey for an assertion with the payload as challenge (a user-presence
   gesture), signs the payload with the signing key (raw 64-byte r‖s), and replies
   `sign_response {requestId, authenticatorData, clientDataJSON, signature, commitSignature}`.
6. The host verifies the assertion against the stored passkey key and the commit signature against
   the stored signing key, writes the commit block, updates root and rev in SQLite, records the
   record row, and emits the `#commit` frame with the CAR blocks through the SQLite-backed
   persister (`repo.go:623-700`, `persist.go`). The HTTP request returns the new CID and rev.
7. The carrier, subscribed to `subscribeRepos`, verifies the commit signature against the DID
   document's `atproto` key, which is the device's key, and passes the record to the indexes.

Photos: `uploadBlob` stores the bytes in IPFS (`handle_repo_upload_blob.go`), the record carries
the CID, `getBlob` serves from IPFS or redirects to a gateway. What the host must never see: the
signing key (true today after registration; the server verifies with the public key only), the
seed (never sent; Vow keeps the PRF output in the browser's `localStorage`, which is Vow's choice
and not Forest's), the identity secret (never involved), address logs (not true today:
`server.go:273-279` logs every request's remote address, to be removed).

**B. The reference PDS with the two-phase fork (proposed, not built).**

1. The device builds the record. It uploads photos with `uploadBlob`, authenticated by a service
   JWT it signs with the profile's signing key (issuer the DID, audience the host's DID, method
   name in `lxm`), which the PDS already knows how to verify.
2. The device calls the new prepare method with the writes and the same JWT. The host runs the
   existing `formatCommit` up to the unsigned commit: applies the writes to the MST, computes the
   data CID and rev, collects the new blocks and ops, stores them as a pending commit under a
   token in the profile's SQLite file with a short expiry, and returns `{token, rev, prev,
   unsignedCommit}` where `unsignedCommit` is the DAG-CBOR bytes to sign.
3. The device signs those bytes with the signing key from `keys/`. No passkey prompt is needed
   for the write itself; the passkey was used to unlock the seed. Soil can add a prompt if it
   wants one.
4. The device calls submit with the token and the signature. The host loads the pending commit,
   checks the repo root is still `prev` (otherwise "stale, prepare again"), attaches the
   signature, checks it with `verifyCommitSig` against the DID document's signing key from the
   directory replica, and in one transaction applies the commit, indexes the records, tracks the
   blob references, and sequences the `#commit` frame. It returns `{cid, rev}`.
5. The carrier receives the frame from `subscribeRepos`, verifies the signature against the DID
   document, and passes the record to the indexes.

Photos: the disk blobstore on the Railway volume (`disk-blobstore.ts`), S3 later if the volume
is outgrown; references tracked per record as today. What the host must never see: no private key
file is ever created (the creation step stores the did:key only), no seed, no identity secret;
request logging off or stripped of addresses; rate limits keyed by DID.

## 5. Recommendation

Fork the reference PDS's write path; do not run or fork Vow. Vow proved the design works end to
end, and its flow is the one to copy, but it is untested code that needs an IPFS node, is tied
to its own login page, still signs first commits with a server key, and has one part-time
author. The reference PDS is what the rest of the network is tested against, runs on SQLite files
and a disk folder, and the change is a few hundred lines in a handful of files whose upstream
churn is low. If the fork turns out to fight the account and OAuth machinery, the fallback is a
minimal host on Bluesky's own repo, identity and server libraries, which is more code to own but
none to carry. Unknown until built: whether pending commits and DID-signed writes fit without
touching OAuth; how the fork rebases in practice; whether the two-step round trip is fast enough
from a phone; and whether SQLite on a Railway volume holds up under the carrier's subscription.
Nothing is decided in this session.

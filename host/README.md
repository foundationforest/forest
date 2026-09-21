# host

The Forest host: Bluesky's reference PDS with its write path forked so that every commit is signed
on the owner's device and the host holds no signing key for any folder. It stores folders, serves
them to the carrier, and never signs.

**Nothing here is shipped.** It has run on this machine, against a local directory of DIDs, and
nowhere else. No Railway, no public instance, no relay has read it.

| | |
|---|---|
| `UPSTREAM` | the one upstream commit this fork sits on |
| `patches/` | five patches, one topic each, applied on top of that commit. All of the fork is here. |
| `build.sh` | clones upstream at that commit, applies the patches, installs, builds |
| `run.sh` | runs the host from `pds.env`, on plain SQLite files and a folder of photos |
| `test.sh` | upstream's own tests for what the patches touch, then Forest's end-to-end tests |
| `test/` | the end-to-end tests, and `device.ts`, the reference for what a product's side does |
| `pds.env.example` | the settings that matter, with what each one is for |
| `upstream/` | made by `build.sh`, not committed |

## Upstream

`bluesky-social/atproto` at `9c76c3422ed0c5369871633d2c4ed67a2f61ae33` (2026-09-21, `@atproto/pds`
0.5.34), MIT and Apache 2.0. Everything in `upstream/` after `build.sh` is that commit plus the five
patches as five commits, so `git -C upstream log` shows exactly what this fork changes and
`git -C upstream diff $(cat UPSTREAM)` shows all of it: 15 files, about 1,100 lines added and 46
changed, in `packages/repo` and `packages/pds`. Nothing else in the monorepo is touched.

Patches rather than a copy of the codebase, because the change is a few hundred lines in a
20,000-line package that Bluesky changes daily: a patch series is readable, and moving to a newer
upstream commit is `git am` again, with the conflicts, if any, in the open.

## Build, run, test

Needs git, Node 22 or later, pnpm 11 (`corepack enable` gives the version upstream pins), and the
network for github.com and the npm registry. Rust and Solana are not needed here.

```
cd host && ./build.sh                       # clone at the pin, apply patches, pnpm install, build
cd host && cp pds.env.example pds.env       # then set the three secrets
cd host && ./run.sh                         # the host, on http://localhost:2583
cd host && ./test.sh                        # upstream's tests, then Forest's
cd host && node --test test/*.test.ts       # Forest's end-to-end tests alone
```

`run.sh` keeps everything under `PDS_DATA_DIRECTORY` (`account.sqlite`, `sequencer.sqlite`,
`did_cache.sqlite`, one `actors/<xx>/<did>/store.sqlite` per folder) and photos under
`PDS_BLOBSTORE_DISK_LOCATION`. No Redis, no Postgres, no S3, no other service beyond what the
reference PDS already needs. `build.sh` was run from an empty directory on this machine: it
applied all five patches on the pin, built, and the end-to-end tests passed there.

## What changed, and why

**0001, `packages/repo`: commit formatting split from signing.** `Repo.formatCommit` was one
function that built the commit and signed it with a local keypair. It is now
`formatUnsignedCommit` (everything up to the signature: deterministic for the same repo state,
writes and rev) plus `finalizeCommit` (attach a signed commit, add its block). `formatCommit` and
`formatInitCommit` are those two with `signCommit` in between, so upstream's bytes and behaviour
are unchanged; upstream's 58 tests for the package pass as they were. This is the one change that
makes a key on another machine able to sign the same bytes.

**0002, `packages/pds`: an actor store with no signing key.** `ActorStore.create` writes a key
file only when given a keypair. Its `transact` and `writeNoTransaction` used to read the key file
before doing anything; now, when there is none, they hand the transactor a keypair that refuses to
sign with a clear `NoSigningKey` error. So every server-signed path in the PDS (`applyWrites`,
`createRecord`, `putRecord`, `deleteRecord`, the identity endpoints, account creation) fails loudly
for a Forest folder instead of failing on a missing file or, worse, signing with the wrong key.

**0003, `packages/pds`: the device-signed two-phase write, and folders made from a device-made
DID.** Two procedures under `foundation.forest.host`, defined in `lexicons/foundation/forest/host/`
and served by `packages/pds/src/api/foundation/forest/host/`:

- `prepareCommit` takes the writes (`com.atproto.repo.applyWrites`'s own create, update and
  delete shapes), applies them to the folder's tree without storing anything, and returns the
  unsigned commit's DAG-CBOR bytes, its `rev`, the head it builds on (`prev`, `since`), the
  tree root, and the writes with every record key filled in.
- `submitCommit` takes the same writes and `rev` plus the signature. It rebuilds the commit,
  checks in this order: `swapCommit` against the head (the existing `InvalidSwap` semantics);
  `rev` is a TID newer than the head's (`InvalidRev`, which is what refuses a replay); the
  signature verifies, against the signing key the DID document names, over the rebuilt bytes
  (`InvalidSignature`; a moved head with no `swapCommit` also lands here, because the rebuilt
  commit is no longer the one that was signed); then it stores, indexes, ties the photos to the
  record, sequences the `#commit` event and updates the root, exactly as `applyWrites` does.
- Both are authenticated by a service token the device signs with the folder's signing key
  (issuer the DID, audience the host's DID, method the endpoint), which the reference PDS already
  knew how to verify (`userServiceAuth`). No password, no session, no OAuth.
- Nothing is kept between the two phases. The host recomputes at submit, so there is no pending
  table, no expiry, no cleanup, and a replay fails on the head check like any stale commit.
- When the DID has no folder on this host, `prepareCommit` returns the genesis (an empty tree,
  or the initial creates) and `submitCommit` creates the folder around the signed genesis: the
  actor store with no key file, the repo, one `actor` row with the handle the DID document
  names, and the sequencer's identity, account, commit and sync events. No email, no password, no
  invite, no session. The DID document, read fresh from the directory, must point its
  `atproto_pds` service at this host's public URL and must name a signing key and a handle. The
  handle goes through the same validation as upstream's signup and must be free on this host.
  Rolled back in reverse if any step fails, as upstream's `createAccount` does.
- Inside the transactor, the checks `formatCommit` ran before formatting (swap commit, per-record
  swaps, the ops for the event) are one shared method now, used by the server-signed path (whose
  behaviour is unchanged) and the device-signed one.

**0004, `packages/pds`: `importRepo` accepts the device's token.** One line. A folder whose
commits are signed on the device has no password and so no session; moving it to this host needs
`importRepo` to take the same credential `prepareCommit` and `submitCommit` take. Everything else
about the import is upstream's: the CAR's root commit is stored as-is, with the device's signature
on it, and no re-signing happens because there is no key to re-sign with.

**0005, `packages/pds`: no address logs.** See below.

Read but not changed, because they hold no key: the blob path (`disk-blobstore.ts`, the blob
transactor and `uploadBlob`, which already accepted the device's token), the sequencer, every
`com.atproto.sync.*` endpoint and the firehose. A relay sees ordinary `#commit` frames with an
ordinary commit whose signature verifies against the DID document, which is what test 5 checks
with Bluesky's own `@atproto/sync` consumer.

## No address logs

Removed, in patch 0005: the request serializer that pino-http applies to every logged request
used to record the socket's `remoteAddress` and `remotePort` and every request header. It now
drops both fields and the headers `x-forwarded-for`, `x-real-ip`, `forwarded`, `cf-connecting-ip`,
`true-client-ip`, `x-client-ip` and `fly-client-ip` before anything is written. A logged request
is `id`, `method`, `url`, `query`, `params` and the remaining headers, with authorization already
obfuscated by upstream. Checked by hand on a running host: `grep remoteAddress` over its log finds
nothing.

Still there, and why: the in-memory rate limiter keys its `global-ip` bucket on the client
address (a counter that lives in the process and is never written anywhere); `createSession`'s
limiter keys on identifier and address (no Forest folder can create a session); and upstream's
OAuth provider records an address per OAuth login in the account database's `device` table (no
Forest folder can log in through OAuth, so the table stays empty). None of these is a log, and
none can hold a Forest profile next to an address, but they are named here so nobody has to find
them again.

## What a product must do on its side

`test/device.ts` is the reference, in about a hundred lines. A product:

1. **Holds the seed.** Unlocks it with the passkey once per session, derives the profile's keys
   with `keys/` (`profileKeys`), and keeps them in memory. Nothing about the seed or the keys ever
   goes to the host.
2. **Creates the DID.** `keys/`'s `didGenesis` with the host's public URL as `pds` and a handle,
   then `submitGenesis` to the directory. The control key is the rotation key; the signing key is
   the `atproto` verification key.
3. **Signs a token per call.** A service token for each request (`createServiceJwt` from
   `@atproto/xrpc-server`, or its forty lines rewritten: issuer the DID, audience the host's DID,
   `lxm` the method, one minute of life), signed with the signing key.
4. **Uploads photos first**, with `com.atproto.repo.uploadBlob` and that token, and puts the
   returned blob reference in the record.
5. **Writes in two phases.** `prepareCommit` with the writes; sign the returned bytes with the
   signing key; `submitCommit` with the returned writes, the `rev`, the signature, and the
   returned `prev` as `swapCommit`. The first write creates the folder.
6. **Moves a folder** by pointing the DID at the new host (a PLC update signed with the control
   key), making the empty folder there with one genesis write, `getRepo` from the old host, and
   `importRepo` at the new one with the device's token; then uploads the photos again.

No passkey gesture is needed for a write: the passkey unlocked the seed, the signing key signs
from memory. A product may add a prompt; the host cannot tell and does not care.

## Tests

`test/host.test.ts`, Node's own runner, no build step of its own. It starts a real local directory
of DIDs (`@did-plc/server`, in memory) and two hosts in the same process, each on SQLite files in
a temporary directory, and runs six tests in order:

1. A folder is made from a DID `keys/` built, its genesis prepared by the host and signed by the
   device; the host has no key for it and cannot produce one; a second genesis is refused.
2. A post, a profile (with a real uploaded photo), a review and a credential from
   `shapes/examples/` are written through the two phases and read back identical, per record and
   per collection; the photo is served byte for byte.
3. Every file under the host's data and photo directories is read: no `key` file, no reserved
   key, and none contains the seed, the signing key or the control key, raw, hex, base64 or
   base64url.
4. A commit signed with another profile's key is refused (`InvalidSignature`); a commit prepared
   on a head that has since moved is refused with `swapCommit` (`InvalidSwap`) and without it
   (`InvalidSignature`); an accepted commit replayed is refused both ways (`InvalidSwap`,
   `InvalidRev`); the server-signed write path refuses the folder's token, and the store's
   stand-in key refuses to sign.
5. Bluesky's `@atproto/sync` firehose consumer, resolving DIDs from the local directory, reads
   the host's firehose from the start and authenticates every commit for the folder against the
   DID document with no error; and by hand, the repo `getRepo` serves verifies with `verifyRepo`
   against the signing key, fails against another key, and the head commit's signature checks.
6. The DID is pointed at a second host; an empty folder is made there; the first host's CAR is
   imported; the photo re-uploaded; the second host serves the same records with the same CIDs
   and the same head commit, verifies against the DID document, holds no key either, and the
   next device-signed write builds on the imported head.

`test.sh` runs, before these, upstream's own tests for `packages/repo` (58) and the PDS suites
that cover what the fork cuts through, crud, sync, file uploads and account migration (97, on
SQLite, no Postgres, Redis or browser). All pass on the fork. The rest of upstream's PDS suite was
not run here: parts of it need Postgres, Redis or a browser.

The relay's own code (indigo, in Go) was not run here; the verification used is the AT Protocol
library's, the same functions the TypeScript relay-side consumer uses.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible until something
ships, and each is in `docs/changes.md`.

1. **Stateless between the phases.** Submit recomputes the commit from the writes and rev rather
   than reading a stored pending commit. No table, no expiry, no migration; the cost is the
   device sending the writes twice.
2. **The genesis is the folder's creation.** No separate create-account endpoint: a DID with no
   folder here prepares and submits its first commit, and the folder exists only once that
   signature has arrived. There is never a half-made folder.
3. **Folders are made active, and only when the DID document already points here.** Upstream's
   deactivated-until-activated migration state needs `activateAccount`, which checks for the
   host's own rotation key and reads the account's key file; neither exists for a Forest folder.
   So a move is: point the DID here, genesis, import. Between the DID update and the import the
   folder is briefly empty on the new host.
4. **The handle stored is the one the DID document names**, validated by upstream's signup rules
   (syntax, reserved words, this host's service domains or a resolvable domain), first come first
   served on this host, verified by nobody here. A relay verifies handles for itself, as it
   always has.
5. **Method names** `foundation.forest.host.prepareCommit` and `submitCommit`, under the same
   authority as `shapes/`'s record types. Error names `InvalidSwap` (upstream's), `InvalidRev`,
   `InvalidSignature`, `IncompatibleDidDoc` (upstream's), `HandleTaken`.
6. **`importRepo` keeps upstream's no-signature-check.** The importing device is the one that
   signed, and the served result is what tests verify. A host that never signs could reasonably
   refuse a CAR whose root does not verify; that is one argument to `verifyDiff`, not taken here
   because upstream does not take it.
7. **Forest's tests live outside the monorepo**, on Node's runner, importing upstream's built
   packages by path and `keys/` from source, so they need none of upstream's test tooling and the
   patches carry no tests of their own.
8. **The host's own rotation key stays required by config**, as upstream requires it. No Forest
   DID contains it and nothing here uses it; it is the price of not touching upstream's config.

## What is not done

- **Railway.** Nothing has been deployed anywhere. `run.sh` and `pds.env.example` are what a
  Railway service would run and set, with `PDS_DATA_DIRECTORY` and `PDS_BLOBSTORE_DISK_LOCATION`
  on one volume, but that has not been tried.
- **Names.** A folder's handle is whatever its DID document says. The random and chosen names
  under `forest.foundation` are the names service's, built after the index.
- **The carrier.** No relay has subscribed to this host. Test 5 uses the relay-side library, not a
  relay.
- **After an import, no sync event.** Upstream emits one from `activateAccount`, which a Forest
  folder cannot call. A relay that followed the folder's move sees the new host's genesis and
  then, at the next write, a head it does not know, and resyncs with `getRepo`. The old host keeps
  serving the folder as active until told otherwise; nothing tells it.
- **The `shapes/` lexicons are not on the host.** Records of Forest's four types are stored with
  `validationStatus: unknown`, as any unknown type is; the device validates with `shapes/` before
  writing. The reference PDS can be told about lexicons; not done here.
- **A folder cannot be deactivated or deleted by its owner** through this host's endpoints:
  upstream's `deactivateAccount` and `deleteAccount` need a session. Not asked for, not built.
- **Rate limits by DID** are those of `applyWrites`; the IP-keyed global bucket is upstream's and
  untouched.
- **A rebase.** The pin is today's `main`. How the five patches fare against next month's is
  unknown until tried; `build.sh` will say.

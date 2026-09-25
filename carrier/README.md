# carrier

The carrier passes Forest's records from Forest hosts to indexes. It is two pieces of Bluesky's
software, configured, with no Forest code:

1. **The relay** reads the hosts and checks every commit's signature against the DID document.
2. **Jetstream** reads the relay and serves the stream as JSON. Each index takes Forest's records
   from it: `foundation.forest.*`, plus the account and identity events.

**Nothing here is shipped.** It has run on this machine only: one local host, one local directory
of DIDs, and no Railway.

## Why these two

The standard relay is Bluesky's indigo relay (`cmd/relay`), and it does the part that has to be
exact:
- it checks every commit's signature against the DID document;
- it checks each commit's history against the last one;
- it reads only the hosts an admin adds;
- it serves any number of subscribers.

It has no filter by record type, and no standard piece has one that can serve more than one index:
- Tap, indigo's other sync tool, filters on the server, but it splits its events between connected
  clients rather than copying them. That makes one Tap per index.
- A relay cannot drop records from a commit anyway: the signature covers the whole folder, so a
  commit with records removed no longer verifies.

So Jetstream sits in front. It is the lighter consumer Bluesky runs for this: it reads one relay
stream, turns each record into JSON, and lets each subscriber ask for record types by prefix. It
always passes account and identity events. The legacy Jetstream (`jetstream-legacy`), not the
rewrite in `bluesky-social/jetstream`, because:
- the legacy one is a plain consumer of one stream;
- the rewrite is a full-network archive that backfills every host and serves nothing until it has.

Carlos chose relay plus Jetstream over Tap, and over the relay alone, in this session's planning
(`docs/changes/services.md`).

## What it does, and what it does not

- **Reads Forest hosts only.** Public `requestCrawl` is off (`RELAY_DISABLE_REQUEST_CRAWL=true`),
  so no host joins by asking. An admin adds each host once.
- **Checks signatures.** Every commit is checked against the signing key in its DID document,
  resolved from `RELAY_PLC_HOST`. Every commit after an account's first is also checked to follow
  from the one before (strict sync, the default).
  - The first commit the relay sees from a folder has only its signature checked: there is nothing
    before it. The relay logs this ("not verifying prevData or MST inversion for first commit from
    account"), and the test counts it once.
  - When the relay cannot resolve a DID, its code passes the commit on unchecked, with a log line
    ("skipping commit signature validation"). A new account whose DID does not resolve is refused
    at creation, so this is a window for DIDs that stop resolving later. Read in the source
    (`cmd/relay/relay/verify.go`), not run here.
- **Passes on account and identity events.** The relay passes all four event kinds (`#commit`,
  `#sync`, `#identity`, `#account`). Jetstream passes commits, identity and account events as
  JSON, and identity and account events whatever a subscriber filters.
- **Drops non-Forest records only where the index asks.** The drop is the subscription's
  `wantedCollections=foundation.forest.*`, not the carrier's. An index that leaves the parameter
  out gets every record the Forest hosts hold. Jetstream splits each commit into its records, so a
  commit holding a Forest record and another record delivers the Forest one alone (tested).
- **Does not know which profiles are registered.** The handoff's "carries registered profiles
  only" needs something that reads the registry. Neither piece does, and nothing custom is
  allowed here.

## Files

| | |
|---|---|
| `UPSTREAM` | the two pins: indigo at `dbcca561c7035fbda2c92ddd6a35b303db1f4a0f` (2026-09-22) and jetstream-legacy at `8a65de4eda28bed1cafcbcf25b0cd46ac6f2148b` (2026-04-15) |
| `build.sh` | fetches both at their pins into `src/` and builds `bin/relay` and `bin/jetstream`, unchanged |
| `relay.env.example` | the relay's settings, every one its own, with what each is for |
| `jetstream.env.example` | Jetstream's, likewise |
| `run.sh` | `./run.sh relay` or `./run.sh jetstream`, from `relay.env` or `jetstream.env` |
| `test/carrier.test.ts` | the local run (below) |

`src/`, `bin/`, `data/` and the two `.env` files are not committed.

## Build, run, test

It needs git and Go. Go fetches the 1.26 toolchain both pins require by itself. The test also
needs the host built (`host/build.sh`) and Node 22.5 or later.

```
cd carrier && ./build.sh                     # both pieces at their pins, into bin/
cd carrier && cp relay.env.example relay.env && cp jetstream.env.example jetstream.env   # then set the password
cd carrier && ./run.sh relay                 # :2470, admin on the same port
cd carrier && ./run.sh jetstream             # :6008/subscribe
cd carrier && npm run test:local             # the local run
```

**The local run**, `test/carrier.test.ts`, about 8 seconds:

1. It starts a local directory of DIDs (`:2582`) and the host from `host/` (`http://localhost:2583`)
   in its own process, as `host/`'s tests do.
2. It starts the relay and Jetstream from the variables in the two `.env.example` files, with only
   paths, the password and the directory's address replaced.
3. It checks the relay refuses a public `requestCrawl`, and that the admin endpoint cannot add a
   loopback host (below). It then adds the host and restarts the relay.
4. It opens two subscribers: an index with `wantedCollections=foundation.forest.*`, and one with no
   filter.
5. A device makes a DID with `keys/` and writes through the host's two-phase path, with
   `host/test/device.ts`:
   - the folder's genesis;
   - a profile (with a photo) and a post, from `shapes/examples/`;
   - an `app.bsky.feed.post`;
   - one commit holding a second Forest post and a second `app.bsky.feed.post`.

What it checks:
- The index receives the identity event, the account event (active), the profile and both posts,
  each exactly as written, and neither non-Forest record.
- The unfiltered subscriber receives all five records.
- The relay logged no warning, skipped no signature check, and left history unchecked only for the
  first commit.
- The relay holds the folder as an active account.

**One step is for localhost only.** Before subscribing, the relay checks that a host answers. It
does this through a client that refuses loopback and private addresses and any port but 80 and 443:
its SSRF guard, with no switch. So the admin endpoint cannot add `http://localhost:2583`, and the
test shows that refusal. It then writes the host into the relay's own `host` table, which is the row
the endpoint would have written, and restarts the relay, which resubscribes to every active host. A
host at a public https address is added with the endpoint alone.

## Adding a host

One admin call per Forest host. The hostname has no scheme and no port, and the host must answer on
https at 443:

```
curl -u "admin:$RELAY_ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"hostname":"host.example.org"}' https://<relay>/admin/pds/requestCrawl
```

Each host may hold 100 active folders by default (`RELAY_DEFAULT_ACCOUNT_LIMIT`). Past that, new
folders are held back ("host-throttled"). Raise one host's limit with `POST /admin/pds/changeLimits`,
or list trusted hosts in `RELAY_TRUSTED_DOMAINS`. Neither was needed here.

## How an index subscribes

```
wss://<jetstream>/subscribe?wantedCollections=foundation.forest.*
```

- Each message is one JSON event:
  - `{"did", "time_us", "kind": "commit", "commit": {"rev", "operation", "collection", "rkey", "record", "cid"}}` for a record created, updated (with `record`) or deleted (without);
  - `{"did", "time_us", "kind": "identity", "identity": {"did", "handle", "seq", "time"}}` when a DID document changes;
  - `{"did", "time_us", "kind": "account", "account": {"active", "status"?, "did", "seq", "time"}}` when a folder is activated, deactivated or taken down.
- To resume, pass `cursor=<time_us>` from the last event handled, a few seconds early. Jetstream
  keeps `JETSTREAM_EVENT_TTL` (24 hours) of events.
- Anything older comes from the folder itself: `com.atproto.sync.getRepo` on the relay redirects to
  the host.
- Other parameters: `wantedDids` (up to 10,000), `compress=true` (zstd), and `maxMessageSizeBytes`.
  A subscriber may change its filter mid-stream with an options message.
- **An index that wants to check every signature itself** reads the relay's own stream:
  `wss://<relay>/xrpc/com.atproto.sync.subscribeRepos`. It gets CBOR commits for every record on
  every Forest host, and filters them itself. Jetstream's JSON is only as trustworthy as the
  Jetstream it came from.

## What running it on Railway will need

None of this has been tried; nothing is deployed.

**Two services, each built from its upstream Dockerfile at the pin:**
- indigo's `cmd/relay/Dockerfile`: Go 1.26, runs `/relay serve`, port 2470.
- jetstream-legacy's `Dockerfile`: port 6008, metrics on 6009.

Railway builds from a repository and path. So each service points at the upstream repository at
the pinned commit, or at a fork holding exactly that commit.

**The relay:**
- A volume holding `DATABASE_URL`'s SQLite file and `RELAY_PERSIST_DIR`, or Railway's Postgres for
  `DATABASE_URL` (the relay's own README advises Postgres beyond a small relay).
- `RELAY_ADMIN_PASSWORD` as a secret variable. The other variables are as in `relay.env.example`,
  with `RELAY_PLC_HOST=https://plc.directory`.
- **Forest hosts are reached at their public https addresses, never over Railway's private
  network:** the relay's SSRF guard refuses private addresses.
- Its port needs a public domain only if other indexes are to read the raw stream. The admin
  endpoints share that port, behind the password.

**Jetstream:**
- A volume for `JETSTREAM_DATA_DIR`.
- `JETSTREAM_WS_URL` pointing at the relay. Railway's private network should do here, since
  Jetstream's dialer has no such guard (not tried).
- A public domain for `/subscribe`.
- A restart policy of "always". Jetstream exits by design when no event has come for
  `JETSTREAM_LIVENESS_TTL`, expecting to be restarted. The example sets 24 hours, because the
  default 15 seconds would restart a quiet network constantly.

**Then:** each Forest host added once with the admin call above.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible, since nothing is
deployed, and each is in `docs/changes/services.md`.

1. **The legacy Jetstream, not the rewrite.** It is a plain consumer. The rewrite archives the
   whole network, backfills every host, and serves nothing until it has.
2. **Hosts are added by an admin only.** Public `requestCrawl` is off. Who decides what counts as a
   Forest host is open.
3. **Strict sync checks**, the relay's default.
4. **`JETSTREAM_LIVENESS_TTL=24h`**, and events kept 24 hours.
5. **SQLite and files on disk**, as the host does. Postgres is one variable away.
6. **Both pins are the latest commit on each default branch today.** jetstream-legacy has had no
   commit since April 2026.

## What is not done

- **A carrier that enforces "Forest records only" on its own side.** Not possible with these pieces
  unchanged. The index's filter does it (open 2 in the log).
- **"Registered profiles only."** Needs a reader of the registry; neither piece has one.
- **A bad signature seen by the relay.** The host refuses a badly signed commit before the relay
  could see one (`host/`'s test 4). The relay's own check was read in its source, not provoked here.
- **A folder moving between hosts.** After an import, the host sends no sync event (see
  `host/README.md`), and how the relay treats the new host's first commit for a known DID was not
  tried.
- **Railway.** Nothing deployed.

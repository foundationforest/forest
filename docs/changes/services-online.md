# Services online (2026-09-25)

A parallel session: it owns `deploy/` and `docs/services.md`, and writes only this log. It put the
host, the carrier's relay, the index, the issuer and the fee payer on Railway against Solana devnet,
with the index's Postgres on Supabase, and proved them end to end on their public URLs. Devnet only;
nothing is shipped.

Carlos decided, during the session:
- **Go on Railway's trial as it is:** five services, the index's readers and pages in one, no redeploy
  on push, and record what the trial blocks.
- **Kora signs with the devnet `payer` key**, after 1 SOL from the deploy key.
- **A second fixed test seed is the whole person of the proof:** a documented constant in the keys
  fixtures; its profile 0, its identity, its badge.
- **Delete `devnet-airdrop-temp`,** a throwaway Railway project from an earlier session, to free the
  fifth service slot.

## Built

- **Five services on Railway, at public URLs** (project `forest-devnet`; `docs/services.md` has every
  URL, id and signature):
  - the host, with SQLite and photos on a volume;
  - the relay, reading the host;
  - the index, readers and pages in one process, on Supabase;
  - the issuer, with the stand-in face check, on a volume;
  - the fee payer, Kora 2.0.5 from its own image, on the devnet rules.
- **Every secret sealed through Railway's API** and checked against Railway's list of names and seal
  flags: 11 in all. The RPC URLs are sealed too, because they hold the Helius key.
- **Supabase `forest-devnet`** (free plan, `us-west-1`):
  - the Data API turned off, and `anon`/`authenticated` stripped of every right on `public`, now and for
    new tables;
  - the read-only role `index_pages`;
  - the index connects through the session pooler with `sslmode=verify-full`, against Supabase's root CA
    shipped in the image;
  - the index ran its migrations itself.
- **The wiring:** the relay reads the host (admin `requestCrawl`); the index reads the relay; the
  index, issuer and fee payer read devnet through Helius; everything names the ids in `docs/devnet.md`.
- **`deploy/`:**
  - a Dockerfile per service, each reusing its folder's own build and run scripts unchanged;
  - the devnet opinions for the index (issuer weights, currencies, counted mints);
  - `feepayer/devnet-config.sh`, which makes the devnet `kora.toml` from `feepayer/kora.toml` with
    exactly five lines changed;
  - `issuer/fake-didit.ts`, a stand-in for Didit's API v3, started only when no Didit key is set;
  - `railway.ts`, `supabase.ts`, `fund.ts`, `e2e.ts`, and `README.md`: what runs where, redeploying,
    rotating, cost, and how it differs from mainnet.
- **`keys/test/second-seed.json`:** the second fixed test seed, SHA-256 of a documented string. It is
  outside this session's folders, at Carlos's request; nothing in `keys/` tests it.
- **Devnet:**
  - 1 SOL from the deploy key to the payer;
  - the payer's test-dollar account (Kora's payment address);
  - 2.00 test dollars to seed 2's wallet.
- **The proof, all seven steps passed on the public URLs, and a rerun sent nothing:**
  1. seed 2's DID `did:plc:zefdl6huirvjcnefpybzrzhp`, in plc.directory, naming the public host;
  2. its profile and a `tutoring` offer, signed here and stored by the host;
  3. both on the index's pages, through the relay;
  4. its commitment inserted into list 0 by the issuer's batch (member 1);
  5. a `tutoring/seller` badge registered through the public fee payer: 841 bytes, 135,503 compute
     units; Kora charged 706,010 base units, exactly the fee, the code account's deposit and its 50;
  6. the badge counted on the profile page, weight 1, uniqueness 1, signed twice;
  7. the DID document and the host (`did:web:host-production-22a4.up.railway.app`) both naming the
     public URL.

## Learned

**Railway.** Railway's API behaved like this, as seen here:
- **Config files are deprecated.** `railway.json` is refused ("Config as Code … is deprecated. Use
  Infrastructure as Code (.railway/railway.ts)"). The settings go through `serviceInstanceUpdate`, and
  the Dockerfile path through the `RAILWAY_DOCKERFILE_PATH` variable. The builder enum has no
  `DOCKERFILE`.
- **A public repo builds without Railway's GitHub app,** but nothing redeploys on push.
  `serviceInstanceDeployV2` with a commit builds that commit.
- **The trial's limits:** 2 projects, 5 services counted across the workspace, 3 volumes of 500 MB,
  1 GB and 2 vCPU per service, builds cut at 20 minutes, one new volume per 30 seconds, 7 days of logs.
  Asking for more answers "Free plan resource provision limit exceeded". Railway also set every
  service's restart policy to "on failure", overriding "always".
- **Health checks call `PORT`,** whatever port the service listens on and the domain targets. The host
  and relay failed until `PORT` matched.
- **Variables changes are workflows,** applied one after another, sometimes minutes later.
  - Sealing an existing unsealed variable fails ("An unknown error occurred").
  - Removing it through the config (`null`) and sending it again sealed works.
  - Changing a sealed variable's value keeps it sealed.
  - A change for a service made seconds before can wait behind others; waiting for the workflow is what
    works.
- **The API's `projects` query lists none of a workspace's projects;** `workspace { projects }` does. A
  rerun that relied on the first tried to make a second project and was refused, harmlessly.
- **Railway's variable list has no value field,** so checking seals can never show a secret.

**Supabase.**
- **The pooler endpoint lists only transaction mode (6543);** session mode is the same host on 5432.
- **node-postgres treats `sslmode=require` as full verification,** and Supabase's pooler chains to
  Supabase's own root CA, which Node doesn't carry. Adding it with `NODE_EXTRA_CA_CERTS` fixed it with no
  change to the index. `verify-full` is now written out, because the next major version of `pg` weakens
  `require`.
- **By default Supabase gives its public API roles every right on new tables in `public`.** Without the
  revokes, anyone holding the project's public key could have written the index's tables.

**The services.**
- **Kora publishes `v2.0.5` as an image** (Debian, `/usr/local/bin/kora`), so the fee payer needs no
  Rust build, and `feepayer/run.sh` runs in it unchanged.
- **The host's image builds from `host/build.sh` inside the 20-minute limit.** Locally it took 309 s on
  four cores and makes 1.5 GB.
- **Upstream's PDS serves no `/.well-known/did.json` for its own `did:web`.** Its identity shows in
  `describeServer`. Nothing in the proof needed the document; adding one would change the host's logic.
- **Kora's price is exactly as designed.** The fee payer's charge on devnet was the network fee (10,000),
  the code account's deposit (137 bytes at 5,080 lamports a byte: 695,960) and 50, with no margin.
- **A process that makes a proof does not exit by itself;** the prover's worker threads keep Node
  alive. `e2e.ts` exits explicitly.
- **The environment changed during the session:** `HELIUS_API_KEY` and `DIDIT_API_KEY` appeared,
  `DIDIT_WORKFLOW_ID` did not. So Helius serves every devnet RPC, and the issuer keeps the stand-in:
  it can't open a real session without the workflow.

**Cost.** Measured idle: 0.51 GB of memory and under 0.005 vCPU for all five. That is about $5.30 a
month of Railway usage (`deploy/README.md`).

## Open

- **Railway's plan.** The trial's $5 credit lasts about four weeks at this usage; then the services
  stop. Hobby is about $5.30 a month in all. *Needs Carlos.*
- **Redeploy on push.** It needs Railway's GitHub app installed on `foundationforest/forest`. Then
  `node deploy/railway.ts track main` after this merges. *Needs Carlos, then mechanical.*
- **Split the index into readers and pages** once a sixth service is allowed, the pages on
  `index_pages` and with no signing seed. `railway.ts` doesn't do it yet. *Mechanical.*
- **A real face check.** `DIDIT_WORKFLOW_ID` is missing, so the issuer runs the stand-in, which
  approves everyone: anyone can put a commitment on devnet's list 0, five sessions an hour per address,
  each insert paid by the devnet issuer key (0.01 SOL, about 2,000 inserts). And a real face check needs
  a person, so the scripted proof can't pass through one. *Needs Carlos.*
- **Secrets only Railway now holds.** The relay's and the host's admin passwords, and the index's signing
  seed, are sealed, and their only other copies sit on this session's machine, which goes away. Adding
  a second host to the relay means `rotate RELAY_ADMIN_PASSWORD` first. Where the index's seed should
  live is already open in `docs/handoff.md`. *Needs Carlos.*
- **Restart policy "on failure", not "always."** It holds for crashes. Jetstream, which exits by design
  and so needs "always", is not deployed. *Mechanical, on a paid plan.*
- **Address logs.** Railway keeps every request's client address and path for 7 days on this plan: the
  handoff's open item, now live. *Needs Carlos.*
- **Seed 2's DID is permanent in plc.directory, and anyone can change it,** since the seed is public. A
  public test DID naming a Forest host is fine for devnet; worth knowing before anything reads it as
  real. *Mechanical, no action.*
- **The host serves no `did.json` for its own `did:web`,** as upstream doesn't. Whether anything will
  need it. *Mechanical.*
- **Railway's Infrastructure as Code** (`.railway/railway.ts` at the repo root) would replace
  `deploy/railway.ts`'s settings. It is outside this session's folders and not tried. *Mechanical.*
- **The Supabase project `forest`** (paused, `us-west-2`, from May) is untouched; what it was for isn't
  recorded here. *Needs Carlos.*
- **Helius's plan against the load:** the index alone makes about 520,000 requests a month. *Needs
  Carlos.*
- **The index's pool** takes 10 connections per process, against the session pooler's limits on the
  free plan. Fine at one process; check before scaling. *Mechanical.*

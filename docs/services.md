# Services on devnet

The foundation's five services, running on Railway against Solana devnet, with the index's Postgres on
Supabase, and proved end to end on their public URLs on 2026-09-25. **Devnet only, and nothing is
shipped:** test keys, a test dollar, a stand-in face check, a trial Railway account. `deploy/README.md`
says how it runs and how to change it; `deploy/services.json` holds the same record in the form the
scripts read.

## Where each one is

| Service | Public URL | What answers there |
|---|---|---|
| Host (`host/`) | https://host-production-22a4.up.railway.app | `/xrpc/_health` → `{"version":"0.5.34"}`; the host's DID is `did:web:host-production-22a4.up.railway.app` (`com.atproto.server.describeServer`) |
| Carrier: the relay (`carrier/`) | https://carrier-production-f88f.up.railway.app | `/xrpc/_health`; indexes read `wss://carrier-production-f88f.up.railway.app/xrpc/com.atproto.sync.subscribeRepos` |
| Index, readers and pages in one process (`index/`) | https://index-production-1b6e.up.railway.app | every page and its `.json` twin, `/sitemap.xml`, `/llms.txt`, `/skill.md` |
| Issuer (`issuer/`) | https://issuer-production-fd68.up.railway.app | `POST /session`, `/submit`, `/status`; the face check is the stand-in (below) |
| Fee payer, Kora 2.0.5 (`feepayer/`) | https://feepayer-production.up.railway.app | Kora's JSON-RPC at `/`, `/liveness`; signs as `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |

**Jetstream is not deployed.** The foundation's index reads the relay's own stream; whether the carrier
keeps Jetstream is open (`docs/handoff.md`).

## Railway

| | |
|---|---|
| Workspace | Carlos Islas's Projects, on the **trial** (subscription type `trial`) |
| Project | `forest-devnet`, `d222014f-0f90-4695-961e-c6ba803102d7`; environment `production`, `59c63b74-7845-4638-bc65-5fa46ec22aed` |
| Source | `foundationforest/forest`, branch `claude/zen-ritchie-9yl3w3`, commit `b829cbef` deployed; built from `deploy/<service>/Dockerfile` with the repo root as context |
| Redeploys on push | **No.** Railway's GitHub app is not installed on the repo; Railway cloned it because it is public. `node deploy/railway.ts deploy` builds the branch's pushed commit |
| Restart policy | On failure (Railway set it; the trial allows 10 restarts) |
| Region | Railway's default (the API reports none) |

| Service | Service id | Volume | Sealed variables |
|---|---|---|---|
| host | `1f59a363-75d8-4d30-afc8-4c836e9c0cb1` | `/data`, 500 MB (34 MB used) | `PDS_JWT_SECRET`, `PDS_ADMIN_PASSWORD`, `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` |
| carrier | `a3d89a6e-ca40-4348-a61f-a3b76c2b7d34` | `/data`, 500 MB (33 MB used) | `RELAY_ADMIN_PASSWORD` |
| index | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | none | `DATABASE_URL`, `INDEX_SIGNING_SEED`, `SOLANA_RPC_URL` |
| issuer | `a1ce9fdf-ad09-4bf5-a016-bab97ce8be81` | `/data`, 500 MB (33 MB used) | `ISSUER_KEYPAIR`, `SOLANA_RPC_URL` |
| feepayer | `8eda2bc9-4966-4e9c-8fcb-664efe976c37` | none | `FOREST_FEEPAYER_KEY`, `RPC_URL` |

- **Every secret is sealed, set through Railway's API** (`environmentPatchCommit` with `isSealed`), and
  checked against Railway's own list of names and seal flags, which carries no values. The RPC variables
  are sealed because their URL holds the Helius key.
- **The keys are devnet's:** the issuer's is `devnet/keys.sh`'s `issuer`
  (`7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7`, list 0's owner), the fee payer's is its `payer`
  (`9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd`).
- **Every other variable is plain** and listed in `deploy/railway.ts` (`variablesFor`).

## Supabase

| | |
|---|---|
| Organization | Forest, **free** plan |
| Project | `forest-devnet`, ref `grhoheihzqwgzyiajzkp`, region `us-west-1` |
| Connection | session pooler `aws-0-us-west-1.pooler.supabase.com:5432`, user `postgres.grhoheihzqwgzyiajzkp`, `sslmode=verify-full` against Supabase's root CA (`deploy/index/supabase-root-2021.crt`) |
| Migrations | run by the index's readers at start, as they are built to |
| Data API | turned off, and `anon`/`authenticated` hold no rights on schema `public`, now or for new tables |
| Read-only role | `index_pages`, made for when the pages run apart; unused while the index is one process |

## Wiring

| | |
|---|---|
| Relay → host | the admin `requestCrawl` for `host-production-22a4.up.railway.app`: 200; the relay lists it `Registered`, `SSL`, `HasActiveConnection: true`, limit 100 folders |
| Index → relay | `FIREHOSE_URL=wss://carrier-production-f88f.up.railway.app` |
| Index, issuer, fee payer → devnet | Helius's devnet RPC (the key was set during the session) |
| Programs | registry `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i`, escrow `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` (`docs/devnet.md`) |
| Fee payer's rules | `feepayer/kora.toml` with five lines changed by `deploy/feepayer/devnet-config.sh`: the two program ids, the test dollar `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` as the paid token (twice), and Kora's mock price |
| Face check | the stand-in `deploy/issuer/fake-didit.ts`, inside the issuer's container: every session it opens passes. `DIDIT_API_KEY` appeared during the session but `DIDIT_WORKFLOW_ID` did not, so the real one is not set |

## The end-to-end proof

`node deploy/e2e.ts`, 2026-09-25, 22:43 to 22:45 UTC: **all seven steps passed**. Run again at 22:46, it
found everything in place and sent nothing.

The person is the second fixed test seed (`keys/test/second-seed.json`), profile 0. Its keys are public
by construction.

| Step | What happened |
|---|---|
| 1. The DID | `did:plc:zefdl6huirvjcnefpybzrzhp`, made here and sent to plc.directory: https://plc.directory/did:plc:zefdl6huirvjcnefpybzrzhp. Handle `forest-seed2-p0.host-production-22a4.up.railway.app`. **Permanent and public, and anyone can change it, since the seed is public** |
| 2. Profile and post on the host | the folder's genesis commit `bafyreicwjazqvty2wof2lkslohaajqrf6qukixtiqdqbvun5qqtecm4q7u`, signed here, holding `at://did:plc:zefdl6huirvjcnefpybzrzhp/foundation.forest.profile/self` (declaring wallet `Ux7wKu7VMpDnkMFn1LxYDzv5SykSyyRNUXcDPLVG2WU`) and `at://did:plc:zefdl6huirvjcnefpybzrzhp/foundation.forest.post/3mwetspeunk2v` (an offer in `tutoring`, 10 test dollars an hour) |
| 3. Seen on the index | https://index-production-1b6e.up.railway.app/profiles/did:plc:zefdl6huirvjcnefpybzrzhp (and `.json`), and the post on https://index-production-1b6e.up.railway.app/markets/tutoring, within a minute, through the relay |
| 4. The issuer | a session from the stand-in, commitment `12320236330478641936781802142443378236731250063022611120734225829319609112781` submitted, queued, then inserted by the issuer's batch: member 1 of list 0 (`7PMx9JpaP7ZwewZ78833FomUbHQgDFFERM9WuvyRurjD`), insert `4ov2ogEHW9sqfb3XCxxDuTzBkr3FDXBquP1JSYzAp8LzANMsx2iX95u1vZgMFzcENdeXcu6ALrnwWqTzJkvPd4ra` |
| 5. The badge, through the public fee payer | `tutoring/seller`, registration `5QetLo4KtqypuGZTTkV36phj7y4nVWBj681QgFq4inYHQo1hhA3VNpvKqDZKn7zPtzBNo2x7pc5hP5gCZfQpGN5A`: Kora signed as payer and sent it; the profile's wallet signed and paid the 0.25 and Kora's charge |
| 6. The badge on the index | on the profile page, **counted**, vouched by "Forest Foundation (devnet key)" at weight 1; uniqueness 1 in `tutoring/seller`, signed with Ed25519 and EdDSA-Poseidon |
| 7. Names the public URL | the DID document's `atproto_pds` is `https://host-production-22a4.up.railway.app`, and the host calls itself `did:web:host-production-22a4.up.railway.app` |

**The registration, measured:**

| | |
|---|---|
| Size | 841 bytes (v0 transaction) |
| Compute | 135,503 units, no compute budget instruction (Kora allows none) |
| Network fee | 10,000 lamports (two signatures) |
| Kora's charge | 706,010 test-dollar base units: 10,000 fee + 695,960 for the code account's storage deposit (137 bytes at devnet's 5,080 a byte) + Kora's 50. No margin |
| Proof | 1.7 s on the session's machine |
| Code | `13bc335a5385dbcddf2c6cc7417e4fb67e1a6566827bcd77341fb3679ca936f0`, account `A5rrNKPiiz6CmWFZcPhK75fvHUnoc7hbKdSYkeseWU8M` |
| Root the proof used | `21c9fbd96ff6c2a0f990fa19de90522058a714c6be9f6d7d89abf393cf55955d` (list 0 with 2 members) |

At Kora's mock price one test-dollar base unit buys one lamport, so the charge reads as 0.71 test
dollars. That is the mock's number, not a real dollar price.

## Devnet transactions this session

| What | Signature |
|---|---|
| 1 SOL from the deploy key to the payer (the fee payer's key) | `3HE365iaTREMg6XqBiG9rJ8NRFjE5MtBcqgapVzyrH8Uvfiw9Yei5ixKQMuX6j9XPL5xPRTyduuf67AVXNC27rgu` |
| Test-dollar accounts: the payer's (where Kora is paid) and seed 2 profile 0's wallet's; the deploy key paid | `41PCZaJXPbFF19aAdsWqcqdqqpfYdzKJDCBFfErwV6n9RSmKVWnvoYSrubtdkC9dPTbsMwm5R3MaVh7aC9sVDCcf` |
| 2.00 test dollars minted to seed 2 profile 0's wallet | `2JgMD27RCDYP6Dn5YE5YvC4bzYUVG3yrPf5XY9ABoaGBR1j2z7yd8sfcqXbrqtpishRcx2JPQd9KWzJ4uac6kcDv` |
| The issuer's insert of seed 2's commitment into list 0 | `4ov2ogEHW9sqfb3XCxxDuTzBkr3FDXBquP1JSYzAp8LzANMsx2iX95u1vZgMFzcENdeXcu6ALrnwWqTzJkvPd4ra` |
| The registration through Kora | `5QetLo4KtqypuGZTTkV36phj7y4nVWBj681QgFq4inYHQo1hhA3VNpvKqDZKn7zPtzBNo2x7pc5hP5gCZfQpGN5A` |

| Key | SOL after the funding, before the registration |
|---|---|
| Payer (Kora's key) | 1.12585452 |
| Deploy key | 1.80451892 |

## Check it yourself

No key needed:

```
curl https://host-production-22a4.up.railway.app/xrpc/_health
curl https://host-production-22a4.up.railway.app/xrpc/com.atproto.server.describeServer
curl 'https://host-production-22a4.up.railway.app/xrpc/com.atproto.repo.listRecords?repo=did:plc:zefdl6huirvjcnefpybzrzhp&collection=foundation.forest.post'
curl https://index-production-1b6e.up.railway.app/profiles/did:plc:zefdl6huirvjcnefpybzrzhp.json
curl -X POST https://issuer-production-fd68.up.railway.app/status -d '{"commitment":"12320236330478641936781802142443378236731250063022611120734225829319609112781"}'
curl -X POST https://feepayer-production.up.railway.app -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getConfig","params":{}}'
```

## What this is not

- **Not auto-deployed.** A push to `main` redeploys nothing until Railway's GitHub app is installed on
  the repo and the services track `main` (`deploy/README.md`).
- **Not a real face check.** The stand-in approves every session, so anyone can put a commitment on
  devnet's list 0, five sessions an hour per address, each insert paid by the devnet issuer key.
- **Not split as designed.** The index's pages run in the readers' process and so hold the signing seed,
  because the trial allows five services.
- **Not at forest.foundation.** Railway's own domains.
- **Not free of address logs.** Railway keeps every request's client address and path for its log
  retention (7 days on this plan); open in `docs/handoff.md`.
- **Not lasting.** The trial's $5 credit runs out in about a month at the usage measured
  (`deploy/README.md`, "What it costs"); then the services stop.

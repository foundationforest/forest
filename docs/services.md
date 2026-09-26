# Services on devnet

The foundation's five services, running on Railway against Solana devnet, with the index's Postgres on
Supabase, proved end to end on their public URLs on 2026-09-25, run through the whole loop on
2026-09-26 with a person's real face check ("The loop", below), and built from `main` and redeployed
on every push to it since 2026-09-26. **Devnet only, and nothing is shipped:** test keys, a test
dollar, Didit's real face check in front of a devnet list. `deploy/README.md`
says how it runs and how to change it; `deploy/services.json` holds the same record in the form the
scripts read.

## Where each one is

| Service | Public URL | What answers there |
|---|---|---|
| Host (`host/`) | https://host-production-22a4.up.railway.app | `/xrpc/_health` → `{"version":"0.5.34"}`; the host's DID is `did:web:host-production-22a4.up.railway.app` (`com.atproto.server.describeServer`) |
| Carrier: the relay (`carrier/`) | https://carrier-production-f88f.up.railway.app | `/xrpc/_health`; indexes read `wss://carrier-production-f88f.up.railway.app/xrpc/com.atproto.sync.subscribeRepos` |
| Index, readers and pages in one process (`index/`) | https://index-production-1b6e.up.railway.app | every page and its `.json` twin, `/sitemap.xml`, `/llms.txt`, `/skill.md` |
| Issuer (`issuer/`) | https://issuer-production-fd68.up.railway.app | `POST /session`, `/submit`, `/status`; the face check is Didit's (below) |
| Fee payer, Kora 2.0.5 (`feepayer/`) | https://feepayer-production.up.railway.app | Kora's JSON-RPC at `/`, `/liveness`; signs as `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |

**Jetstream is not deployed.** The foundation's index reads the relay's own stream; whether the carrier
keeps Jetstream is open (`docs/handoff.md`).

## Railway

| | |
|---|---|
| Workspace | Carlos Islas's Projects, on the **Hobby** plan |
| Project | `forest-devnet`, `d222014f-0f90-4695-961e-c6ba803102d7`; environment `production`, `59c63b74-7845-4638-bc65-5fa46ec22aed` |
| Source | `foundationforest/forest`, branch `main`; commit `1c4b5e2` deployed to all five on 2026-09-26; built from `deploy/<service>/Dockerfile` with the repo root as context |
| Redeploys on push | **Yes.** Railway's GitHub app is installed on the repo, and each service has a deploy trigger on `main` (`node deploy/railway.ts track main`) |
| Restart policy | On failure, at most 10 restarts |
| Region | Railway's default (the API reports none) |

| Service | Service id | Volume | Sealed variables |
|---|---|---|---|
| host | `1f59a363-75d8-4d30-afc8-4c836e9c0cb1` | `/data`, 500 MB (34 MB used) | `PDS_JWT_SECRET`, `PDS_ADMIN_PASSWORD`, `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` |
| carrier | `a3d89a6e-ca40-4348-a61f-a3b76c2b7d34` | `/data`, 500 MB (33 MB used) | `RELAY_ADMIN_PASSWORD` |
| index | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | none | `DATABASE_URL`, `INDEX_SIGNING_SEED`, `SOLANA_RPC_URL` |
| issuer | `a1ce9fdf-ad09-4bf5-a016-bab97ce8be81` | `/data`, 500 MB (33 MB used) | `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `ISSUER_KEYPAIR`, `SOLANA_RPC_URL` |
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
| Face check | Didit's, on the foundation's workflow: `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` sealed on the issuer on 2026-09-26, so `deploy/issuer/start.sh` starts no stand-in |

## The face check

A real Didit session, opened through the public issuer on 2026-09-26 at 17:56 UTC (`POST /session`
answered 201). Its check page:

https://verify.didit.me/session/_Gq_qtCJqtle

- **Done and used.** Carlos did the check on his phone on 2026-09-26 at about 19:55 UTC, in the loop
  (below). Didit approved it and the issuer took it with the seller's commitment, so the session
  counts once and never again. Its id is not recorded here or in `deploy/services.json`.
- **Carlos's face is now in Didit's duplicate search** for the foundation's application. A later check
  with the same face there is refused as a duplicate, unless this session is deleted in Didit's
  console (`issuer/README.md`).
- **What the decision says,** read once for its shape, with nothing personal printed or kept:
  `Approved`, on the issuer's workflow; one liveness step, `PASSIVE`, `Approved`, no warnings, and its
  face-search `matches` list empty; the workflow's features are `LIVENESS` and `IP_ANALYSIS`.

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

Since 2026-09-26 the index runs markets v1, where a profile's record names its market and role and a
badge counts only under that scope. This proof's profile named neither, so its badge showed as not
counted (`notProfileScope`) until the loop (below) rewrote the record to name `tutoring/seller`: the
index counts the badge again and lists the offer in `tutoring`.

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

## Devnet transactions of the 2026-09-25 proof

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

## The loop

`FACE_CHECK_SESSION=<id> node deploy/e2e.ts`, 2026-09-26, 19:51 to 19:57:49 UTC: **all nine steps
passed** on the public services, in 6 minutes 25 seconds. Run again at 19:58:42, and once more after
a fix to what it writes, it found everything in place and sent nothing: the newest signature on every
address the loop touches, every folder's head commit and every DID's log in plc.directory were the
same before and after, and `deploy/services.json` was unchanged.

**What a person did: one face check.** Carlos opened the check page ("The face check", above) on his
phone and did Didit's check. The script asked at about 19:51:38 UTC, and the issuer accepted the
session 229 seconds later (it is asked every 20 seconds, so the check itself ended between 209 and
229 seconds). Everything else was the script: every key comes from a public test seed, every
signature was made on this machine, and nobody needed a password, an account or any SOL.

### Who is who

The seeds are public (`keys/test/`), so every key below is public, and anyone can change these DIDs.
Each handle is `forest-seedN-pK.host-production-22a4.up.railway.app`.

| | Seed, profile | DID | Declared wallet | In |
|---|---|---|---|---|
| The 2026-09-25 proof's profile | seed 2, profile 0 | [`did:plc:zefdl6huirvjcnefpybzrzhp`](https://index-production-1b6e.up.railway.app/profiles/did:plc:zefdl6huirvjcnefpybzrzhp) | `Ux7wKu7VMpDnkMFn1LxYDzv5SykSyyRNUXcDPLVG2WU` | `tutoring/seller` |
| The seller, a new person | seed 3 (`keys/test/third-seed.json`), profile 0 | [`did:plc:wdmngk2i2wj6x5imlwytn6ik`](https://index-production-1b6e.up.railway.app/profiles/did:plc:wdmngk2i2wj6x5imlwytn6ik) | `31zEpfk1vQp3Bob3DFNXmvJwtgM7DSqhHH96n6X9n67x` | `tutoring/seller` |
| The buyer: seed 2's person on the other side | seed 2, profile 1 | [`did:plc:smufpq5kribdr4mheawtintt`](https://index-production-1b6e.up.railway.app/profiles/did:plc:smufpq5kribdr4mheawtintt) | `E9zbbdiFz73xwqhCiW7E9VSvuJDvhL1yecmdRmCrBXa7` | `tutoring/buyer` |

### The steps

| Step | What happened | Time |
|---|---|---|
| 1. The proof's profile on markets v1 | its record rewritten to name `tutoring/seller`, commit `bafyreidxgzzmbdjusivi6t6flf5auugg3ljg44yalfhwxg377mntnrg3ja`; the index counts its badge again and lists its offer in `tutoring` | 7 s |
| 2. The seller's profile and offer | its DID sent to [plc.directory](https://plc.directory/did:plc:wdmngk2i2wj6x5imlwytn6ik); its folder made with the profile and one offer, 10 test dollars an hour, online (`at://did:plc:wdmngk2i2wj6x5imlwytn6ik/foundation.forest.post/3mwh2oieysk2f`), commit `bafyreifmyygss6dsmjeyeopsfp2gpynm6b3row7cnc74d25sip6mpnrfdq`; both on the index | 7 s |
| 3. The face check | the issuer answered `no_liveness` until the check was done, then took the session with seed 3's commitment (229 s); its next batch put the commitment on list 0 as member 2 (102 s later) | 333 s |
| 4. The seller's badge | 5.00 test dollars minted to its wallet; `tutoring/seller` proved here (1.4 s) and registered through the fee payer; counted on its profile page, vouched by "Forest Foundation (devnet key)" | 8 s |
| 5. The buyer | its DID sent to [plc.directory](https://plc.directory/did:plc:smufpq5kribdr4mheawtintt); its folder made with a `tutoring/buyer` profile, commit `bafyreihbjoy65qt5n5sjjc6wneje22p5tm7ge7ykw6k3snuyv22jf4roea`; 12.00 test dollars minted; `tutoring/buyer` proved (1.0 s) and registered through the fee payer; counted | 13 s |
| 6. The invoice | the seller invoiced the buyer for one hour of the offer, 10.00, through the fee payer: escrow `GUbXZG6Cbto9TuouAE5hJnkDJYHomZkKk2TzFTzSh4Q3` (the seller's address, id 16850276214498466287), deposit address `Ex1RzwgDp5cjBWcP4BUK1uGf6UMSAhi36b6DwHcRdkU4` made first | 3 s |
| 7. Pay and release | the buyer checked the invoice (its own key as buyer, the seller, the amount, and no option the offer did not set), then paid and released it in one transaction through the fee payer. On chain: ended, released to the seller, 10.00 to the seller, created by the seller. On the [deal page](https://index-production-1b6e.up.railway.app/deals/GUbXZG6Cbto9TuouAE5hJnkDJYHomZkKk2TzFTzSh4Q3): "The teacher asked for this payment, so both sides agreed to it and reviews that name it count in full." | 8 s |
| 8. Reviews both ways | the buyer's of the seller, overall 9 and clarity 8.5 (`at://did:plc:smufpq5kribdr4mheawtintt/foundation.forest.review/3mwh2zjnuo32f`, commit `bafyreifzycq3igxplwk3h7i2nlngwsk7q7vzoieginhjliwnvars7lo57i`); the seller's of the buyer, overall 10 and clarity 9 (`at://did:plc:wdmngk2i2wj6x5imlwytn6ik/foundation.forest.review/3mwh2zjvlqd2f`, commit `bafyreih5kyv6pntd2wdpmr3qlw4waycsjski7noftvsdfcycnl252a257m`); each names the escrow as its deal | 6 s |
| 9. Identity | all three DID documents name `https://host-production-22a4.up.railway.app` | 0 s |

Of the 6 minutes 25 seconds, 5 minutes 33 seconds were the face check and the issuer's batch. Each
step's time runs until the index shows its result.

### What the index shows

| | The seller | The buyer |
|---|---|---|
| Badge | `tutoring/seller`, counted; uniqueness 1 ("100%") | `tutoring/buyer`, counted; uniqueness 1 |
| Rating | 9.0 of 10, from 1 review | 10.0 of 10, from 1 review |
| Standing | 1.25 | 1.56 |
| The review it received | overall 9, clarity 8.5; counted; evidence `both` ("Backed by a payment both sides agreed to") | overall 10, clarity 9; counted; evidence `both` |

The deal page lists both reviews. The two standings are each other's reviewers' weights at work
(`index/SCORING.md`): each is `(1 + t / (|t| + 1)) × signal`, with the other's standing as `t`,
converged to 1.2512 and 1.5558.

### What it cost

| Transaction | Signature | Bytes | Compute units | Kora's charge, in test-dollar base units |
|---|---|---|---|---|
| The seller's registration | `3caThkaYTzpYCaCiNqvS4d1q7f3sMbAkJNbGVHYLa5sAT2biT7DejqZCeHRVkQqJXR12A9joKmKz83FhKMuJuFwe` | 841 | 135,510 | 706,010: the 10,000 fee, the code account's 695,960, Kora's 50 |
| The buyer's registration | `3HKpNijuD7pJFFo7EqYVLirbvENbRjMYZKUBL1rzzJHs1BpVF3HySEvjBQtrLUYqptmZvrqGB1UPaDe4kEWz4rhq` | 840 | 136,331 | 706,010, the same |
| The invoice | `iELKYCkUYCVzcgkcfp1noqczHC8pZGNaBaMNNzCbECsveBiPs2U433aeuXUrwFq77QDaRHB8DUJqNm5EitR1LdS` | 646 | 29,569 | 3,489,850: the 10,000 fee, the escrow's 1,991,360, the deposit address's 1,488,440, Kora's 50 |
| Pay and release | `5SpTfT3Z4B1zPsHvBk3dgjT35iCw3t6DBNAiqFcBUGDuWf4kDiQV6Bp6n6gVcmnXWRTe7GpDjczgQZTS9Y1Hx46f` | 641 | 18,998 | 10,050: the 10,000 fee, Kora's 50 |

- **Each registration also paid the 0.25** to the treasury, from the profile's own wallet.
- **Kora charged exactly what it spent, plus its 50 per transaction.** Its key spent 4,911,720
  lamports in the loop and took 4,911,920 test-dollar base units: the same, plus 4 × 50. No margin;
  at the mock price one base unit buys one lamport.
- **The deposit address's 1,488,440 lamports went back to the seller** at the release, as the invoice's
  creator. So the seller's wallet now holds 0.00148844 SOL it never asked for (`docs/handoff.md`,
  Open). The escrow keeps its 1,991,360 as the permanent receipt.

### Devnet transactions in the loop

| What | Signature |
|---|---|
| 5.00 test dollars minted to the seller's wallet, its token account made; the deploy key paid | `55SgiUPQUQ3eaxPZ6i8LXsUEhLqayTDoD9Bx4uNrKdeRKQC9Lg5VEsqM6gdoAnnVTNDR4URr7asFnBDtbPtsy5Yn` |
| The issuer's insert of the seller's commitment into list 0 | `5w6T44qChMwaY2Hxd222omwdhbGQEJuHKqQj6T8n9TWhXyBV88W86pqjj7hoPvAmMn6X684KwoFcgRn6C5ALjMFd` |
| The seller's registration, `tutoring/seller`, through Kora | `3caThkaYTzpYCaCiNqvS4d1q7f3sMbAkJNbGVHYLa5sAT2biT7DejqZCeHRVkQqJXR12A9joKmKz83FhKMuJuFwe` |
| 12.00 test dollars minted to the buyer's wallet, its token account made; the deploy key paid | `KpTxJD7wd7iy7C5FjeGSBGw4UwhHSoq4B2MHG3vpirZ4Q3GNHin6vKRCSqPifW4WPfX4RaHXrkTMsuXuPMMVGFf` |
| The buyer's registration, `tutoring/buyer`, through Kora | `3HKpNijuD7pJFFo7EqYVLirbvENbRjMYZKUBL1rzzJHs1BpVF3HySEvjBQtrLUYqptmZvrqGB1UPaDe4kEWz4rhq` |
| The invoice (the deposit address made first, then `create` by the seller), through Kora | `iELKYCkUYCVzcgkcfp1noqczHC8pZGNaBaMNNzCbECsveBiPs2U433aeuXUrwFq77QDaRHB8DUJqNm5EitR1LdS` |
| Pay and release in one transaction (the deposit address, the transfer, `release_to_seller`), through Kora | `5SpTfT3Z4B1zPsHvBk3dgjT35iCw3t6DBNAiqFcBUGDuWf4kDiQV6Bp6n6gVcmnXWRTe7GpDjczgQZTS9Y1Hx46f` |

| Key | After the loop |
|---|---|
| Kora's key | 1.12023684 SOL; 5.61793 test dollars collected since 2026-09-25 |
| Deploy key | 1.80152204 SOL (0.00299688 for the two token accounts and their fees) |
| Issuer key | 0.00999 SOL |
| The seller's wallet | 10.55414 test dollars, 0.00148844 SOL |
| The buyer's wallet | 1.03394 test dollars, no SOL |

## Check it yourself

No key needed:

```
curl https://host-production-22a4.up.railway.app/xrpc/_health
curl https://host-production-22a4.up.railway.app/xrpc/com.atproto.server.describeServer
curl 'https://host-production-22a4.up.railway.app/xrpc/com.atproto.repo.listRecords?repo=did:plc:zefdl6huirvjcnefpybzrzhp&collection=foundation.forest.post'
curl https://index-production-1b6e.up.railway.app/profiles/did:plc:zefdl6huirvjcnefpybzrzhp.json
curl -X POST https://issuer-production-fd68.up.railway.app/status -d '{"commitment":"12320236330478641936781802142443378236731250063022611120734225829319609112781"}'
curl -X POST https://feepayer-production.up.railway.app -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getConfig","params":{}}'
curl https://index-production-1b6e.up.railway.app/profiles/did:plc:wdmngk2i2wj6x5imlwytn6ik.json
curl https://index-production-1b6e.up.railway.app/profiles/did:plc:smufpq5kribdr4mheawtintt.json
curl https://index-production-1b6e.up.railway.app/deals/GUbXZG6Cbto9TuouAE5hJnkDJYHomZkKk2TzFTzSh4Q3.json
curl -X POST https://issuer-production-fd68.up.railway.app/status -d '{"commitment":"1346789220767776419926245555024760855748731755560010769479057017479885879851"}'
```

## What this is not

- **One face check, not a product's flow.** A person did Didit's check once, on a page the issuer had
  opened earlier; the script, not a phone, held the seed and sent the session. Roots' random wait
  between joining the list and a first registration is not in the script: the seller registered
  seconds after its insert, which was the only one in its batch, so on devnet its badge can be
  matched to the moment of the check.
- **Not split as designed.** The index's pages run in the readers' process and so hold the signing seed
  (`deploy/README.md`, "As it runs").
- **Not at forest.foundation.** Railway's own domains.
- **Not free of address logs.** Railway keeps every request's client address and path for its log
  retention, and the foundation's Didit workflow runs IP analysis, so Didit keeps the address of the
  phone that did the check; both open in `docs/handoff.md`.

# Services: the fee payer and the carrier

The log for `feepayer/` and `carrier/`, kept apart from `docs/changes.md` while sessions run in
parallel. Same three lists: built, learned, open.

## 2026-09-25: the fee payer and the carrier, configured and run locally

- **Build order:** the handoff's "Next" steps 3 (the fee payer's config) and 4 (the carrier's
  config), asked for by Carlos together, in one session that owns `feepayer/` and `carrier/` only.
  Both ran on this machine. Nothing is deployed anywhere: no devnet, no mainnet, no Railway.
- **Decided (by Carlos, in planning):**
  - **The carrier is Bluesky's relay plus Jetstream.** The filter to `foundation.forest.*` is each
    index's subscription parameter, not the carrier's. Chosen over:
    - Tap, which filters on the server but splits its events between connected clients, so it feeds
      one index;
    - the relay alone, with the filter left to the host.

    Because no standard piece filters on the server for more than one subscriber, and nothing custom
    is allowed.
- **Closed by this session:** session 14's open 5 ("whether Kora's price counts the storage deposit
  it puts down inside a program call"). It does (learned 1). What it does not count is the
  deposit coming back (learned 2, open 1).
- **Chosen, not decided** (the simplest option where the handoff is silent; each reversible, since
  nothing is deployed):
  - **Fee payer:**
    1. **Kora 2.0.5**, the latest stable release, pinned in `feepayer/KORA`. `main` is 2.2.0-beta.8.
    2. **Margin 0.** The charge is the cost, plus the 50 lamports Kora adds for the payment
       instruction. Because nothing inside charges anything but the registry.
    3. **Paid to the fee payer's own token account** (no separate `payment_address`).
    4. **At most 0.01 SOL of deposits and three signatures per transaction.**
    5. **No compute budget program, so no priority fee.** The five programs asked for, and no more.
    6. **No API key or HMAC.** A browser page cannot keep a secret, and every transaction pays.
    7. **The local run prices with Kora's mock**, on a copy of `kora.toml` with one line changed.
  - **Carrier:**
    1. **The legacy Jetstream** (`jetstream-legacy`), not the rewrite. The rewrite archives the
       whole network, backfills every host, and serves nothing until it has.
    2. **Hosts are added by an admin only.** Public `requestCrawl` is off.
    3. **The relay's strict sync checks**, its default.
    4. **`JETSTREAM_LIVENESS_TTL=24h`**, and events kept 24 hours.
    5. **SQLite and files on disk.**
    6. **Both pins are today's latest commits:** indigo `dbcca561…`, jetstream-legacy `8a65de4e…`.
    7. **For the local run only, the host is written into the relay's `host` table.** The admin
       endpoint cannot add a loopback host (learned 8).
- **Built:**
  - **`feepayer/`:**
    - `KORA`, `build.sh` (`cargo install kora-cli --locked`);
    - `kora.toml`: five programs, USDC, margin 0, and the fee payer's key allowed only to fund new
      accounts;
    - `signers.toml` (the key from `FOREST_FEEPAYER_KEY`);
    - `run.sh`, which refuses a key file inside the repo;
    - `test/feepayer.test.ts`;
    - `README.md`, rewritten.
  - **`carrier/`:**
    - `UPSTREAM`, `build.sh` (`go build` of `cmd/relay` and `cmd/jetstream` at the pins);
    - `relay.env.example`, `jetstream.env.example`, `run.sh`;
    - `test/carrier.test.ts`;
    - `README.md`, rewritten.
  - **The fee payer's local run** (about 20 seconds):
    - A validator with both programs and a test dollar at USDC's address. Kora 2.0.5 through
      `run.sh`, its key read from a file path outside the repo.
    - A wallet that never holds a lamport registers once, then pays for two escrows (pay then
      release, and one tap), all in the test dollar.
    - Seven refusals, each with nothing landing and nothing moving.
    - Every balance checked.
  - **The carrier's local run** (about 8 seconds):
    - The host from `host/` and a local directory of DIDs, the relay, and Jetstream, run from the
      two `.env.example` files.
    - A device writes: a genesis; a profile (with a photo) and a post; an `app.bsky.feed.post`; a
      commit holding a second post and a second non-Forest record.
    - An index subscribed for `foundation.forest.*` gets the identity event, the account event, the
      profile and both posts, each exactly as written, and neither non-Forest record. An
      unfiltered subscriber gets all five records.
    - The relay logs no warning and skips no signature check.
    - Both runs passed twice in a row.
- **Learned:**
  1. **Kora's price counts storage deposits, including ones made inside a program call.** It
     simulates each transaction, reads every inner instruction, and counts each System
     `CreateAccount` the fee payer funds. Measured, in lamports:
     - registration: charged 963,570 = network fee 10,000 + code account 953,520 + 50;
     - escrow pay: charged 5,160,450 = 10,000 + escrow account 3,111,120 + deposit address 2,039,280
       + 50.

     A registration paying only the network fee is refused ("Insufficient token payment. Required
     963520 lamports"). The fee payer paid for nobody, in every case.
  2. **Kora does not count what comes back, and the escrow gives the person's deposits to the fee
     payer.** The escrow records the transaction's payer as its rent payer and returns rent only to
     that key. So:
     - when an escrow ends, its deposit address's rent (2,039,280 here; $0.149 on mainnet today at
       $100 a SOL; $0.020 after the rent cuts) goes to the fee payer, though the person paid for it;
     - a one-tap escrow is charged that rent for an address it makes and closes itself. Tested to
       the lamport: the charge minus the cost is 2,039,280 + 50;
     - after the rent cuts, anyone may sweep a receipt's rent above the new minimum to the fee payer:
       $0.196 per escrow made at today's rate.

     Up to about $0.35 per escrow in all. The registration has no such gap: a code account never
     closes.
  3. **Kora 2.0.5 refuses an escrow's "Pay" as the escrow client builds it.** It looks up the
     destination of every token transfer before signing. The deposit address does not exist until
     the escrow program makes it inside `create`, so Kora answers "Account … not found".
     - It accepts an account made in the same transaction only by a top-level associated-token-account
       instruction (`token/token.rs`, `find_ata_creation_for_destination`).
     - Putting `CreateIdempotent` for the deposit address, paid by the fee payer, before `create`
       fixes it, about 10 bytes more. The escrow's `init_if_needed` accepts the account already made.
  4. **Kora's mock prices every mint but devnet USDC and wrapped SOL at 0.001 SOL a token**, about a
     tenth of a dollar's worth. So the local run's test dollar is worth one lamport a base unit, and
     the person starts with 100 of them.
  5. **Kora simulates before it checks anything.** A transaction that fails simulation is refused with
     the simulation's error, not the rule it breaks. The first draft of the "take the payment back"
     refusal failed for lack of tokens before the fee payer policy was reached.
  6. **Kora 2.0.5 reads the key from a path; `main` does not.** Built `--locked`, it uses
     solana-keychain 0.1.0, which reads the variable as a file path first, then as a JSON array or
     base58. `main` uses 1.4.0, which takes the key itself only. Railway, with no files, passes the
     key itself either way.
  7. **`kora config validate` warns three times:**
     - no auth;
     - `allow_create_account`, which is priced, capped at 0.01 SOL and tested;
     - Token-2022's permanent delegate, which cannot arise, since that program is not on the list.
  8. **The relay cannot add a loopback host.** Its reachability check uses a client that refuses
     loopback and private addresses and any port but 80 and 443 (its SSRF guard, with no switch).
     The admin `requestCrawl` for `localhost:2583` answers "host server unreachable". Its WebSocket
     dial skips that guard for plain-http hosts, and the local run writes the host row directly. On
     Railway the relay must reach Forest hosts at their public https addresses, never over the
     private network.
  9. **The relay checks history only from an account's second commit.** It checks the first
     commit's signature only, and logs "not verifying prevData or MST inversion for first commit
     from account" (once, in the test). When it cannot resolve a DID, its code passes a commit on
     with no signature check and a log line (read in `verify.go`, not provoked).
  10. **Jetstream exits after 15 seconds with no new event**, expecting to be restarted, and trims
      its store on the same clock. Fine for Bluesky's whole network; for a new one it means
      restarts every quiet minute. Hence 24 hours.
  11. **Jetstream splits a commit into its records**, so a commit holding a Forest record and
      another record delivers the Forest one alone to a filtered index.
  12. **Toolchain here:**
      - Solana CLI 4.2.2 from `release.anza.xyz`;
      - Kora 2.0.5 in about 12 minutes of Rust;
      - the relay and Jetstream in about 5 minutes, Go fetching the 1.26 toolchain itself;
      - `host/build.sh` in about 10 minutes.

      All four built at once on four cores. Nothing needed was blocked.
- **Open:**
  1. **The escrow's rent goes to the fee payer, not the person** (learned 2). The fix must land
     before the escrow deploys, and these three are the options:
     - (a) **An escrow program change:** a rent-refund key, the buyer's wallet, recorded apart from
       the key that funds the rent, so every close and sweep pays the person.
     - (b) **An outside refund:** whoever runs the fee payer hands back what returns to it. Custom
       code in a product, and trust.
     - (c) **Accept it:** say the deposits are the fee payer's. That contradicts "nothing inside
       charges anything".
  2. **The escrow's one tap through a fee payer needs the deposit address made at the top**
     (learned 3). `escrow/client` has no builder for "Pay" and its tests compose it without that
     instruction. The escrow session or Roots adds it. Not changed here: not this session's folder.
  3. **Priority fees.** With the compute budget program off the list, no transaction carries a
     priority fee, and under congestion one may land late. Allowing it lets the person set one and
     pay for it: Kora's price includes it. Keep the five programs, or add the sixth?
  4. **Kora 2.2, once stable.** It hardens the fee payer against being drained, counts a closed
     account's rent coming back (which may close half of open 1), and no longer reads the key from a
     path. Read, not run.
  5. **A payment address apart from the fee payer's key**, so the dollars it collects sit under a
     colder key.
  6. **Who runs the fee payer, and its operations loop.** Someone must keep SOL on its key and turn
     collected dollars back into SOL. With margin 0, anyone who makes and then closes an account
     they own gets SOL at the price source's rate: the fee payer is a SOL seller at the oracle, with
     no margin for the oracle's error. The handoff has Roots run an instance; Carlos to confirm
     (session 14's open 6).
  7. **"Forest records only" is the index's filter, and "registered profiles only" is nobody's.**
     Neither piece can do either without custom code. Options:
     - the index filters both, reading the registry itself;
     - or the host refuses records outside `foundation.forest.*`, which makes the relay's stream
       Forest-only at the source, and verifiable. That is a host change, for the host session.
  8. **The relay passes a commit unchecked when a DID stops resolving** (learned 9). Accept, or have
     indexes that must be sure read the relay's own stream and check signatures themselves.
  9. **Who decides what a Forest host is.** Now an admin adds each one. A list the foundation keeps?
     Open `requestCrawl`, leaving the rest to the indexes' filters?
  10. **A relay admits 100 active folders per host by default.** Raise it per host, or list trusted
      hosts, before any host grows past that.
  11. **jetstream-legacy has had no commit since April 2026.** If Bluesky retires it, the rewrite
      (or Tap per index) replaces it.
- **Still standing:** nothing is deployed anywhere, and the handoff's "Before mainnet" list stands.
  The lawyer pass it names covers the fee payer.

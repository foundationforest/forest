# Forest: kickoff for the build chat, September 13, 2026

This is message one for a fresh chat in the Forest project. It merges the strategy chat and the technical chat, with the corrections both agreed on. Nothing is shipped. One test has passed: passkey-derived seed, identical on iPhone and Mac. Every choice has its because so it can be challenged. When something here is wrong, change it and say what changed.

## How the work splits

- This chat decides. Stress tests, searches, cross-cutting judgment, anything that isn't code. Reason first, draft on request.
- Cowork does plumbing. Repos with `CLAUDE.md` and licenses, domain and DNS, hosting projects, keeping docs in sync across repos, dashboards once Carlos is signed in. It never creates accounts or types passwords; Carlos does those.
- Claude Code builds. One repo at a time, plan mode per task, reads `CLAUDE.md` first every session. Bad at "should we" questions; bring those here.
- Carlos does what only he can: wallet, accounts, KYB, the Ltd, the first sellers.

## What Forest is

An open environment where a person owns their profile, their offers and their reputation, and can transact with strangers with no platform in the middle. One human, one account, face-checked once. One profile per market; markets are per category. A market is a text file anyone can write. Any AI can read the records and, through one connection, act in them.

One sentence: one human, one record, any market, no one in between.

Why it works: accountability. You can't start over (one human, one profile per market). Evidence exists (a verified human staking their own reputation on a review, with the escrow receipt underneath). Nobody can erase it (signed records in your own folder, indexed by anyone). The foundation supplies accountability. The product, Roots, gets you paid.

Why now: four capabilities became cheap in about three years, all needed: unique human without a state (face liveness plus dedupe as an API), keys normal people can hold (passkeys), money a program can hold legally at zero marginal cost (stablecoins), a reader that needs no interface (AI agents). One person can assemble it with Claude Code.

## The shape

Face unlocks a passkey; the passkey derives a seed; the seed derives a control key, a signing key and a permanent name (DID) per profile. Each profile has a folder of signed records on a host that stores but never signs. Relays carry records to indexes; indexes rank and serve pages any AI reads. A registry on chain guarantees one verified human has one voice per market without revealing who. An escrow on chain holds money between strangers. Roots is the only thing users touch. An MCP door lets any AI post and search through it.

## Layers

| Layer | What | Source | Runs on |
|---|---|---|---|
| Login and seed | Any passkey provider. Seed is the secret the first passkey derives; extra passkeys open it via a small encrypted file we can't read. Paper export offered | Browser standard | User's device |
| Keys and names | Per profile: control key, signing key, DID. Regenerable from the seed | AT Protocol libraries | User's device |
| Folders | One per profile: profile, posts, reviews, photos, all signed on device | AT Protocol libraries | Our host stores |
| Host | Stores folders, serves the live feed. Never holds a signing key. One change, to the write path only: a two-phase write where the host prepares the commit, Roots signs it, the host stores it. Relay checks and sync are untouched. Days, not weeks | AT Protocol software, modified | Railway |
| Directory | Public cards: name, current key, current host | Independent organization; we keep a replica | Theirs |
| Relay | Subscribes to hosts, verifies signatures against the card's key, carries registered profiles and Forest record types only | AT Protocol software, configured | Foundation box |
| Index | Reads the relay, scores, serves category pages, profile pages, a machine endpoint. Open algorithm | Ours | Supabase, Vercel |
| Registry | Public list: market tag, DID, proof, one-time code. Rejects repeats. Light Protocol nullifier pattern plus Semaphore proof, verified on chain | Ours, frozen | Solana |
| Fee relayer | A Kora node (Solana Foundation's open fee-payer standard) plus one custom check: accept a voucher the user obtained earlier (free token from Roots, or 25 cents paid in a separate transaction), then sponsor the registration and pay the fee from the relayer's own account, so registrations never link to the payer | Kora, configured, one custom validation | Foundation, on Railway |
| Escrow | Holds any SPL token chosen by the market file and the parties; releases on approval, timeout, agreed split, or optional arbiter. Modes: fixed, per unit, capped | Ours, frozen | Solana |
| Face check | Once, at signup. Passive liveness plus dedupe. Foundation runs it as the first issuer and owns the account holding the list. New issuers register themselves | Didit | Theirs |
| Roots | Web app: passkey, keys, profiles, signing, escrow buttons, deposit address, ramp widget, fee sponsorship (a second Kora policy or the same node), rules for what an AI may do | Ours | Vercel |
| MCP door | Post and search from any AI. Holds no keys; forwards signing to Roots | Ours, in the Roots repo | Vercel |
| Ramps | Direct widget from a licensed provider; KYC is theirs. Transak first (self-serve dashboard, staging key immediate, production after KYB, partner fee setting). Onramper Premium later when volume pays for it. Fallback always: USDC from any exchange | Transak; Onramper later | Theirs |

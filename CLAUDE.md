This repo is `forest`: all Forest Foundation code. Read this file, then `docs/handoff.md`, before any task. Work in plan mode. One task per session. Open a pull request; never push to main.

Forest: a person owns their profile, offers and reputation, and transacts with strangers with no platform in between. One human, one face check, one badge per market. Profiles are free folders. A market is a name. Any AI reads the records. Global from day one.

Rules Claude Code does not change (Carlos changes them, in a chat, then here):
- Keys never leave the user's device. Hosts store; they never sign. Nothing anywhere has user accounts; there are keys, folders, and badges.
- The registry and escrow programs are sealed after deploy, per version. Design each as if it can never be touched again.
- Anything someone needs to compete with us lives in this repo, open.
- Use existing pieces unchanged: for records, Ed25519 keys named by did:key, RFC 8785 canonical JSON and age, with the one protocol around them in `records/SPEC.md`; Semaphore's circuit and its public setup files for the proof (its contracts are not used); groth16-solana and the Poseidon syscall for verifying; Kora as the fee payer service, with no custom code inside it (it co-signs a person's transaction and charges the network fee and any storage deposit it puts down in their dollar token; no sponsorship built in); Didit for the face check. Write only what does not exist.
- Registration is free: no fee, no token, no treasury in the program. The only costs are Solana's own (the network fee and the line's deposit), paid by whoever sends the transaction; any payer may pay for someone else; the program cannot tell and never needs to. No vouchers, no numbered codes in the program.
- Escrow v1: one shape, money out only when both sides agree, options off by default; classic SPL tokens only; parties are keys.
- No mixers, no custody, no arbitration by Forest.
- Fees exist only at ramp in and out. Nothing inside charges anything.
- Reputation is computed per profile. Profiles link only when the user chooses. Never build a per-human score that links profiles by itself.
- No address logs. Nothing server-side ever holds a person next to a profile.
- Anyone can make any market: a market is a name, and the registry accepts any name. The `markets` repo is the foundation's directory of recommended spellings; the foundation excludes, prohibits and approves nothing. The recommended badge scope is `market/role`.
- The passkey belongs to forest.foundation; products are listed in the related-origins file. Names are a later feature, not core; the DID is the identity: a did:key, the profile's own key.
- Crypto is invisible in anything a user reads: no "wallet", "USDC", "chain", "gas" in copy.
- Never state design as shipped. Nothing is shipped.

Four record shapes: profile, offer, review, proof. Market files add fields, never new shapes.

Out of scope for v1: the cross-profile zero-knowledge proof (design storage so it fits later), issuer-assisted recovery, chain posts, video hosting, arbiter as default, an entity, a ramp partnership.

For any change to a Solana program, use the safe-solana-builder skill and write its security checklist next to the program.

When the plan is silent, choose the option that adds no rule and no text a person reads; log it as chosen. Ask only when the choice changes a sealed program or spends money. At the end of every session append to `docs/changes.md`: built, learned, open. A session running in parallel writes both to its own `docs/changes/<topic>.md` instead (see "Building in parallel" in the handoff).

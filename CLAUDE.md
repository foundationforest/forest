This repo is `forest`: all Forest Foundation code. Read this file, then `docs/handoff.md`, before any task. Work in plan mode. One task per session. Open a pull request; never push to main.

Forest: a person owns their profile, offers and reputation, and transacts with strangers with no platform in between. One human, one face check, one badge per market. Profiles are free folders. A market is a name. Any AI reads the records. Global from day one.

Rules Claude Code does not change (Carlos changes them, in a chat, then here):
- Keys never leave the user's device. Hosts store; they never sign. Nothing anywhere has user accounts; there are keys, folders, and badges.
- The registry and escrow programs are sealed after deploy, per version. Design each as if it can never be touched again.
- Anything someone needs to compete with us lives in this repo, open.
- Use existing pieces unchanged: AT Protocol for records, keys and names; Semaphore's circuit and its public setup files for the proof (its contracts are not used); groth16-solana and the Poseidon syscall for verifying; Kora as the fee payer service, with no custom code inside it (it co-signs a person's transaction and charges the network fee in their dollar token; no sponsorship built in); Didit for the face check. Write only what does not exist.
- Registration: one proof, one rule: 25 cents in USDC, always; other accepted tokens at the fee set for them. No free slots, no vouchers, no numbered codes in the program. The program charges everyone; any payer may pay for someone else; the program cannot tell and never needs to.
- Escrow v1: one shape, money out only when both sides agree, options off by default; classic SPL tokens only; parties are keys.
- No mixers, no custody, no arbitration by Forest.
- Fees exist only at ramp in and out. Nothing inside charges anything except the sealed registry fee.
- Reputation is computed per profile. Profiles link only when the user chooses. Never build a per-human score that links profiles by itself.
- No address logs. Nothing server-side ever holds a person next to a profile.
- Anyone can make any market: a market is a name, and the registry accepts any name. The `markets` repo is the foundation's directory of recommended spellings; the foundation excludes, prohibits and approves nothing. The recommended badge scope is `market/role`.
- The passkey belongs to forest.foundation; products are listed in the related-origins file. Names are a later feature, not core; the DID is the identity.
- Crypto is invisible in anything a user reads: no "wallet", "USDC", "chain", "gas" in copy.
- Never state design as shipped. Nothing is shipped.

Four record shapes: profile, post, review, credential. Market files add fields, never new shapes.

Out of scope for v1: the cross-profile zero-knowledge proof (design storage so it fits later), issuer-assisted recovery, chain posts, video hosting, arbiter as default, an entity, a ramp partnership.

For any change to a Solana program, use the safe-solana-builder skill and write its security checklist next to the program.

When unsure whether something is settled, don't decide it: write the question in `docs/changes.md` and stop. At the end of every session append to `docs/changes.md`: built, learned, open. A session running in parallel writes both to its own `docs/changes/<topic>.md` instead (see "Building in parallel" in the handoff).

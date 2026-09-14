This repo is `forest`: all Forest Foundation code (record shapes,
market template, registry and escrow programs, relay config, index,
fee relayer proxy). Read this before any task.

Forest: a person owns their profile, offers and reputation; transacts
with strangers with no platform in between. One human, one face check,
one profile per market. A market is a text file. Any AI reads the
records.

Rules that do not change:
- Keys never leave the user's device. Hosts store; they never sign.
- The registry and escrow programs are frozen after deploy. Design
  them as if you can never touch them again.
- Anything someone needs to compete with us lives in this repo.
- Use existing libraries unchanged: AT Protocol for records, keys and
  names; Semaphore's circuit (not its contracts) for proofs; Light
  Protocol's groth16-solana and the Poseidon syscall for verification;
  Kora unchanged for fee sponsorship, with our checks in a small proxy
  in front of it; Didit for the face check. Write only what does not
  exist.
- No mixers, no custody, no arbitration by Forest.
- Fees exist only at ramp in and out. Nothing inside charges anything.
- Reputation is computed per profile. Profiles link only when the user
  chooses. Never build a per-human score that links profiles by itself.
- Escrow accepts classic SPL Token mints only, or Token-2022 mints
  with zero extensions, checked at creation.
- Registration vouchers are blind-signed (RSA blind signatures,
  RFC 9474). No party can match a spent voucher to its issuance.
- Crypto is invisible in anything a user reads: no "wallet", "USDC",
  "chain", "gas" in copy.
- Never state design as shipped. Nothing is shipped.
- Durable learnings go in docs/handoff.md, not only in your memory.
  End every session by appending a dated "what changed" section there.

Three record shapes: profile, post (direction, market, role, price
block), review (with escrow pointer). Market files add fields, never
new shapes.

Host reference: Vow (tangled.org/julien.rbrt.fr/vow), a keyless PDS.
Evaluate it before modifying any PDS. Host change scope, if any:
write path only.

Out of scope for v0: cross-profile zero-knowledge proof,
issuer-assisted recovery, chain posts, an entity for the foundation,
video hosting, arbiter as default, Onramper.

When unsure whether something is settled, ask before building. The
full handoff lives in docs/handoff.md; open items are at its end.

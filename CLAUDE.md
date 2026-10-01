This repo is `forest`: the pieces of Forest everyone shares (records, keys, the registry, the escrow). Read this file, then `README.md` and the README of the folder you work in, before any task. Work in plan mode. One task per session. Open a pull request; never push to main.

Devnet only: nothing here runs on mainnet, and nothing is shipped. Never state design as shipped.

Rules Claude Code does not change (Carlos changes them, in a chat, then here):
- The records protocol is `records/SPEC.md`. A profile is one ed25519 key: its did:key is its name, it signs the profile's records, and it is the profile's Solana wallet. One key per profile; nothing ties two profiles of one person together. Four record shapes: profile, offer, review, proof. A market adds fields, never new shapes.
- Keys never leave the person's device. Boards (record hosts) store and serve; they never sign. Nothing anywhere has user accounts: there are keys, records and badges. The passkey belongs to forest.foundation; products are listed in its related-origins file.
- Boards are run by apps. This repo holds the reference board, not a running one. A board holds no keys, asks for no login, logs no network address, and refuses only by its own policy, from signatures and the registry.
- The registry is free: no fee, no token, no treasury, no admin and no list in the program. The only costs are Solana's own (the network fee and a line's deposit), paid by whoever sends the transaction; any payer may pay for someone else; the program cannot tell and never needs to. No vouchers, no numbered codes. One line per human per label, never changed. Anyone can be an issuer: the program checks no root, and each reader decides which issuers it trusts.
- Anyone can make any market: a label is free text, and the registry accepts any. The recommended label is `market/role`. The `markets` repo is the foundation's directory of recommended names; the foundation excludes, prohibits and approves nothing.
- The escrow has one shape: money out only when both sides agree, options off by default, parties are keys. v1 takes classic SPL tokens; v2 takes classic and Token-2022 tokens, refusing a transfer fee and a token that cannot be transferred. New deals are meant to use v2.
- The registry and the escrow are sealed after mainnet deploy, per version. Design each as if it can never be touched again; a change is a new program at a new address.
- Services live in `foundationforest/services`: the index, the issuer (Didit's face check), and the relayer (Kora, configured, with no custom code inside it). Apps, Roots first, live in their own repos. Anything someone needs to compete with us is open: here, in `services` and in `markets`.
- Use existing pieces unchanged, and write only what does not exist: Ed25519 and did:key, RFC 8785 canonical JSON, age, Pkarr; Semaphore's circuit and its public July 2024 setup files (not its contracts); groth16-solana; Anchor; the SPL token programs.
- No mixers, no custody, no arbitration by Forest. Fees exist only at ramp in and out; nothing inside charges anything.
- Reputation is computed per profile. Profiles link only when the person chooses. Never build a per-human score that links profiles by itself. Nothing server-side ever holds a person next to a profile.
- Crypto is invisible in anything a person reads: no "wallet", "USDC", "chain", "gas" in copy.
- Out of scope until decided otherwise: issuer-assisted recovery, a cross-profile zero-knowledge proof, video hosting, an arbiter by default.

How a session works:
- For any change to a Solana program, use the safe-solana-builder skill and keep its security checklist next to the program.
- When the plan is silent, choose the option that adds no rule and no text a person reads, and write down its reason: in `docs/decisions.md`, one line, if it shapes Forest; otherwise in a comment beside the code. Ask only when the choice changes a sealed program or spends money.
- Keep the docs true in the same pull request: a change that makes a README, a SPEC or `docs/devnet.md` wrong fixes it. Docs say only what the code does today, plain words first, in these words: profile, record, board, badge, issuer, relayer, index, app, label.

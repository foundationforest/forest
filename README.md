# forest

All Forest Foundation code, open under Apache 2.0.

Forest is an open environment where a person owns their profile, their offers and their reputation, and can transact with strangers with no platform in the middle. One human, one record, any market, no one in between.

This repo holds the foundation pieces: `records/`, the data protocol (its spec, library, reference host, approval page and record shapes); `keys/`, the keys recipe; and the registry and escrow programs (`registry/`, `escrow/`). The services (the index, the issuer flow, the fee payer's configuration) move to `foundationforest/services`. Products are thin apps on top, in their own repos.

Nothing is shipped. The plan, and the reason behind every choice, is in [docs/handoff.md](docs/handoff.md). Read `CLAUDE.md` and that file before any task. Session history is in [docs/changes.md](docs/changes.md).

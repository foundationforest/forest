#!/usr/bin/env bash
# Runs, in order: upstream's own tests for the package the first patch changes; upstream's PDS
# tests that cover the write, blob, sync and migration paths the fork cuts through, on SQLite,
# with no Postgres, Redis or browser; then Forest's end-to-end tests in test/.
set -euo pipefail
cd "$(dirname "$0")"
export NODE_OPTIONS=--experimental-vm-modules
echo "== @atproto/repo"
(cd upstream/packages/repo && pnpm exec jest)
echo "== @atproto/pds: crud, sync, file uploads, account migration"
(cd upstream/packages/pds && pnpm exec jest tests/crud.test.ts tests/sync tests/file-uploads.test.ts tests/account-migration.test.ts)
echo "== Forest end-to-end"
unset NODE_OPTIONS
node --test test/*.test.ts

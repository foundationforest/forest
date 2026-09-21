#!/usr/bin/env bash
# Builds the Forest host: Bluesky's reference PDS at the commit in UPSTREAM, with the patches in
# patches/ applied on top. Needs git, Node 22 or later, and pnpm 11 (the version upstream pins;
# `corepack enable` provides it). Talks to github.com and the npm registry.
set -euo pipefail
cd "$(dirname "$0")"

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/bluesky-social/atproto}"
UPSTREAM_COMMIT="$(tr -d '[:space:]' < UPSTREAM)"

if [ ! -d upstream/.git ]; then
  echo "cloning $UPSTREAM_REPO at $UPSTREAM_COMMIT"
  git init -q upstream
  git -C upstream remote add origin "$UPSTREAM_REPO"
fi
git -C upstream fetch -q --depth 1 origin "$UPSTREAM_COMMIT"
git -C upstream checkout -q --detach "$UPSTREAM_COMMIT"

# The patches become commits on top of the pinned one, so `git -C upstream log` shows exactly
# what this fork changes, and `git -C upstream diff $UPSTREAM_COMMIT` shows the whole of it.
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-forest}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-forest@localhost}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git -C upstream am -q --3way "$PWD"/patches/*.patch
echo "applied $(ls patches/*.patch | wc -l | tr -d ' ') patches on $UPSTREAM_COMMIT"

# Nothing here needs a browser. Puppeteer is a dev dependency of upstream's own test suite.
export PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
(cd upstream && pnpm install --frozen-lockfile)

# The PDS and what it depends on, plus the test harness (dev-env: a local PLC directory and an
# in-process PDS) and the firehose consumer (sync) the tests verify commits with.
(cd upstream && pnpm --filter '@atproto/dev-env...' --filter '@atproto/sync...' run build)

# The tests sign with keys/'s library, which has its own dependencies.
(cd ../keys && npm install --no-audit --no-fund)

echo "built. run it: ./run.sh   test it: ./test.sh"

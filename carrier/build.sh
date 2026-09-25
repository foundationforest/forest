#!/usr/bin/env bash
# Builds the carrier's two pieces, unchanged, at the commits in UPSTREAM: Bluesky's relay
# (indigo's cmd/relay) and Jetstream (jetstream-legacy's cmd/jetstream). Sources land in src/,
# binaries in bin/ (neither committed). Needs git and Go; Go fetches the 1.26 toolchain both
# pin by itself (GOTOOLCHAIN=auto, the default).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p src bin

while read -r name repo commit; do
  [ -n "$name" ] || continue
  if [ ! -d "src/$name/.git" ]; then
    git init -q "src/$name"
    git -C "src/$name" remote add origin "$repo"
  fi
  git -C "src/$name" fetch -q --depth 1 origin "$commit"
  git -C "src/$name" checkout -q --detach "$commit"
  echo "$name at $commit"
done < UPSTREAM

(cd src/indigo && go build -o ../../bin/relay ./cmd/relay)
(cd src/jetstream && go build -o ../../bin/jetstream ./cmd/jetstream)
echo "built bin/relay and bin/jetstream"

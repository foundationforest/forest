#!/usr/bin/env bash
# Builds the test site into dist/, which is committed so the site can be put
# online without a build step. Run from anywhere: bash testsite/build.sh
set -euo pipefail

site="$(cd "$(dirname "$0")" && pwd)"
keys="$site/../keys"
dist="$site/dist"

rm -rf "$dist"
mkdir -p "$dist/keys/dist" "$dist/handover"

# The keys page: the library bundled by keys' own esbuild, with the entry and
# flags of its `build:page` script plus --minify. page.js is copied as is, so
# the page behaves exactly like keys/test-page.
if [ ! -d "$keys/node_modules" ]; then
  (cd "$keys" && npm ci --no-audit --no-fund)
fi
(cd "$keys" && npx esbuild src/index.ts --bundle --format=esm --platform=browser --minify \
  --outfile="$dist/keys/dist/forest-keys.js")
cp "$keys/test-page/page.js" "$dist/keys/page.js"
cp "$site/keys/index.html" "$dist/keys/index.html"

# The handover page needs no build.
cp "$site/handover/index.html" "$site/handover/handover.js" "$dist/handover/"

# The site index, and Vercel's config, which Vercel reads from the root
# directory it is given: testsite/dist.
cp "$site/index.html" "$site/vercel.json" "$dist/"

(cd "$dist" && find . -type f | sort | xargs ls -l | awk '{ print $5, $9 }')

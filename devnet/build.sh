#!/usr/bin/env bash
# Build both programs for devnet from the committed source, with devnet's keys put into a copy.
#
# Nothing committed changes. The registry's source names placeholder keys (TREASURY,
# FOUNDATION_ISSUER) that its tests sign for, and both programs name vanity program ids nobody holds
# a keypair for. So this copies each program's Cargo.toml, Cargo.lock and src into devnet/target/
# (ignored), replaces exactly these lines in the copy, each checked to appear exactly once, and
# builds there:
#
#   registry  declare_id!               -> registry.programId      from devnet/devnet.json
#             TREASURY                  -> keys.treasury
#             FOUNDATION_ISSUER         -> keys.foundationIssuer
#             built with --features devnet (USDC_MINT is devnet's USDC)
#   escrow    declare_id!               -> escrow.programId
#
# It prints each substitution as a diff against the committed file, and each .so's sha256. The
# builds land in devnet/target/forest_registry.so and devnet/target/forest_escrow.so; the LiteSVM
# tests' own builds in registry/program/target and escrow/program/target are not touched.
#
# Usage: devnet/build.sh    (needs the Solana CLI's cargo-build-sbf on the PATH, and node)

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out="$here/target"
json="$here/devnet.json"

field() { node -e "process.stdout.write(String(require(process.argv[1])$1))" "$json"; }

# Replace one exact line in a file, refusing unless it appears exactly once before and the new line
# exactly once after.
replace_once() {
  node - "$1" "$2" "$3" <<'JS'
const fs = require('fs')
const [file, from, to] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
const count = (s, t) => s.split(t).length - 1
if (count(text, from) !== 1) throw new Error(`${file}: expected exactly one of\n  ${from}\nfound ${count(text, from)}`)
const next = text.replace(from, to)
if (count(next, to) !== 1) throw new Error(`${file}: expected exactly one of\n  ${to}\nafter replacing`)
fs.writeFileSync(file, next)
JS
}

copy_program() {
  local name=$1
  rm -rf "$out/$name"
  mkdir -p "$out/$name"
  cp "$root/$name/program/Cargo.toml" "$root/$name/program/Cargo.lock" "$out/$name/"
  cp -r "$root/$name/program/src" "$out/$name/src"
}

build() {
  local name=$1 so=$2
  shift 2
  (cd "$out/$name" && cargo build-sbf "$@" >"$out/$name.build.log" 2>&1) || {
    tail -40 "$out/$name.build.log"
    exit 1
  }
  cp "$out/$name/target/deploy/$so" "$out/$so"
  # cargo-build-sbf leaves a program keypair of its own next to the .so. It is not the devnet
  # program id and nothing uses it; delete it so no key file sits under the repo.
  rm -f "$out/$name/target/deploy/"*-keypair.json
}

# Refuse if anything but src/lib.rs differs between the copy and the committed source.
only_lib_changed() {
  local others
  others=$(diff -rq "$root/$1/program/src" "$out/$1/src" | grep -v '/lib.rs and ' || true)
  if [ -n "$others" ]; then
    echo "$1: more than lib.rs differs from the committed source:" >&2
    echo "$others" >&2
    exit 1
  fi
}

registry_id=$(field .registry.programId)
escrow_id=$(field .escrow.programId)
treasury=$(field .keys.treasury)
issuer=$(field .keys.foundationIssuer)

mkdir -p "$out"

copy_program registry
lib="$out/registry/src/lib.rs"
replace_once "$lib" 'declare_id!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");' "declare_id!(\"$registry_id\");"
replace_once "$lib" 'pub const TREASURY: Pubkey = pubkey!("F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s");' "pub const TREASURY: Pubkey = pubkey!(\"$treasury\");"
replace_once "$lib" 'pub const FOUNDATION_ISSUER: Pubkey = pubkey!("H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS");' "pub const FOUNDATION_ISSUER: Pubkey = pubkey!(\"$issuer\");"
echo "registry: the substitutions, against the committed source"
diff -u "$root/registry/program/src/lib.rs" "$lib" | grep -E '^[-+][^-+]' || true
only_lib_changed registry

copy_program escrow
lib="$out/escrow/src/lib.rs"
replace_once "$lib" 'declare_id!("FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT");' "declare_id!(\"$escrow_id\");"
echo "escrow: the substitution, against the committed source"
diff -u "$root/escrow/program/src/lib.rs" "$lib" | grep -E '^[-+][^-+]' || true
only_lib_changed escrow

echo "building the registry (--features devnet) ..."
build registry forest_registry.so --features devnet
echo "building the escrow ..."
build escrow forest_escrow.so

echo "toolchain: $(solana --version 2>/dev/null || echo 'solana not on PATH'); $(cargo-build-sbf --version | tr '\n' ' ')"
(cd "$out" && sha256sum forest_registry.so forest_escrow.so && wc -c forest_registry.so forest_escrow.so | head -2)

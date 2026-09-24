#!/usr/bin/env bash
# Deploy devnet/build.sh's two builds to devnet, check the deployed bytes are the built ones, and
# record what was deployed in devnet/devnet.json.
#
#   FOREST_DEVNET_KEYS=<dir> devnet/deploy.sh
#
# <dir> holds deploy.json (it pays, and it is the upgrade authority) and registry-program.json and
# escrow-program.json (the program ids devnet/devnet.json names). Nothing is printed from them.
#
# The upgrade authority stays on the deploy key. Devnet is not sealed: sealing is the mainnet step
# (`solana program set-upgrade-authority <id> --final`, in both programs' READMEs), done on the day
# each deploys there. Write transactions go over RPC (`--use-rpc`), not to validators directly.
# A program already deployed is not deployed again; it is only checked and recorded.
# FOREST_DEVNET_RPC and FOREST_DEVNET_RECORD point it elsewhere, for a rehearsal on a local validator.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out="$here/target"
json="${FOREST_DEVNET_RECORD:-$here/devnet.json}"
keys="${FOREST_DEVNET_KEYS:?set FOREST_DEVNET_KEYS to the directory holding the devnet keypairs}"
rpc="${FOREST_DEVNET_RPC:-$(node -e "process.stdout.write(require(process.argv[1]).rpc)" "$json")}"
# Every solana command names the deploy key: this CLI wants a signer even to read, and there is no
# default keypair on the machine.
cli=(--url "$rpc" --keypair "$keys/deploy.json")

for name in registry escrow; do
  id=$(node -e "process.stdout.write(require(process.argv[1])['$name'].programId)" "$json")
  [ "$(solana-keygen pubkey "$keys/$name-program.json")" = "$id" ] || { echo "$name: the program key is not $id" >&2; exit 1; }
  so="$out/forest_$name.so"
  [ -f "$so" ] || { echo "no $so: run devnet/build.sh first" >&2; exit 1; }

  if solana program show "$id" "${cli[@]}" >/dev/null 2>&1; then
    echo "$name: already deployed at $id"
  else
    echo "$name: deploying $(wc -c <"$so") bytes to $id ..."
    solana program deploy "${cli[@]}" --upgrade-authority "$keys/deploy.json" --program-id "$keys/$name-program.json" \
      --use-rpc --output json "$so" >"$out/$name.deploy.json"
  fi

  solana program show "$id" "${cli[@]}" --output json >"$out/$name.show.json"
  solana program dump "$id" "$out/$name.dumped.so" "${cli[@]}" >/dev/null
  built=$(sha256sum <"$so" | cut -d' ' -f1)
  deployed=$(head -c "$(wc -c <"$so")" "$out/$name.dumped.so" | sha256sum | cut -d' ' -f1)
  [ "$built" = "$deployed" ] || { echo "$name: the deployed bytes are not the built ones" >&2; exit 1; }
  echo "$name: deployed bytes match the build ($built)"

  node - "$json" "$name" "$out" "$built" "$(wc -c <"$so")" <<'JS'
const fs = require('fs')
const [json, name, out, sha, bytes] = process.argv.slice(2)
const record = JSON.parse(fs.readFileSync(json, 'utf8'))
const show = JSON.parse(fs.readFileSync(`${out}/${name}.show.json`, 'utf8'))
const p = record[name]
p.programData = show.programdataAddress
p.upgradeAuthority = show.authority
p.lastDeploySlot = show.lastDeploySlot
p.soSha256 = sha
p.soBytes = Number(bytes)
const deployed = `${out}/${name}.deploy.json`
if (fs.existsSync(deployed) && !p.deploySignature) {
  const d = JSON.parse(fs.readFileSync(deployed, 'utf8'))
  p.deploySignature = d.signature
  record.transactions ??= []
  record.transactions.push({ program: name, what: `deploy: the ${name} program, built by devnet/build.sh, upgrade authority kept on the deploy key`, signature: d.signature })
}
fs.writeFileSync(json, JSON.stringify(record, null, 2) + '\n')
JS
done

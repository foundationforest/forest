#!/usr/bin/env bash
# Deploy one of devnet/build.sh's builds to devnet, check the deployed bytes are the built ones, and
# record what was deployed in devnet/devnet.json. One program per run: the deploy key needs enough
# for one program at a time, not both at once.
#
#   FOREST_DEVNET_KEYS=<dir> devnet/deploy.sh registry
#   FOREST_DEVNET_KEYS=<dir> devnet/deploy.sh escrow
#   FOREST_DEVNET_KEYS=<dir> devnet/deploy.sh cost      # print both programs' cost; deploy nothing
#
# <dir> holds deploy.json (it pays, and it is the upgrade authority) and registry-program.json and
# escrow-program.json (the program ids devnet/devnet.json names). Nothing is printed from them.
#
# Before a deploy it:
#   1. closes any buffer the deploy key left behind (a deploy that died part way), returning its SOL;
#   2. computes the exact cost of this deploy, the way Solana CLI 4.2.2's `program deploy` spends
#      it (cli/src/program.rs, do_process_program_deploy), and prints the deploy key and that amount
#      on a line by itself;
#   3. waits for the deploy key to hold it, checking every 60 seconds for up to
#      FOREST_DEVNET_WAIT_MINUTES (90 by default), and stops with exit code 3 if it never does.
#
# The cost, for a program of L bytes, with no priority fee (the CLI then adds no compute-budget
# instruction at all):
#
#   rent(45 + L)            the program data account's rent; the CLI funds the upload buffer with it,
#                           and the loader hands it back and moves it into the program data account
#   + rent(36)              the program account's rent, paid in the final transaction
#   + 10,000                the buffer's creation: two signatures (the key, the new buffer)
#   + 5,000 x writes        one signature each; a write carries 1,012 bytes, and a chunk that is all
#                           zeros is not sent, since the new buffer already holds zeros
#   + 10,000                the final deploy: two signatures (the key, the program id)
#
# All of it is spent: nothing comes back to the key. The CLI's own balance check leaves out rent(36),
# so a key holding less than this can pass it and still fail at the last transaction, leaving a
# buffer that the next run closes.
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
wait_minutes="${FOREST_DEVNET_WAIT_MINUTES:-90}"
what="${1:?usage: devnet/deploy.sh registry|escrow|cost}"
# Every solana command names the deploy key: this CLI wants a signer even to read, and there is no
# default keypair on the machine.
cli=(--url "$rpc" --keypair "$keys/deploy.json")
deployer=$(solana-keygen pubkey "$keys/deploy.json")

# The exact cost of deploying one .so, in lamports, as described above. Rent comes from the cluster.
cost() {
  node - "$rpc" "$1" <<'JS'
const fs = require('fs')
const [rpc, so] = process.argv.slice(2)
const bytes = fs.readFileSync(so)
const L = bytes.length
// Solana CLI 4.2.2, calculate_max_chunk_size: 1,232 minus the size of a write transaction carrying
// no bytes (one signature; the key, the buffer and the loader; the loader's Write with an empty
// vector), minus 1 for the length prefix. 1,232 - 219 - 1.
const CHUNK = 1012
let writes = 0
for (let at = 0; at < L; at += CHUNK) {
  if (bytes.subarray(at, Math.min(at + CHUNK, L)).some((b) => b !== 0)) writes++
}
async function rent(size) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [size] }) })
  const j = await r.json()
  if (typeof j.result !== 'number') throw new Error(`getMinimumBalanceForRentExemption(${size}): ${JSON.stringify(j)}`)
  return j.result
}
;(async () => {
  const programData = await rent(45 + L)
  const program = await rent(36)
  const fees = 10_000 + 5_000 * writes + 10_000
  const total = programData + program + fees
  console.log(JSON.stringify({ bytes: L, programDataRent: programData, programRent: program, writes, fees, total }))
})()
JS
}

sol() { node -e "process.stdout.write((Number(process.argv[1]) / 1e9).toFixed(9))" "$1"; }
balance() { solana balance "$deployer" "${cli[@]}" --lamports | cut -d' ' -f1; }

if [ "$what" = cost ]; then
  for name in registry escrow; do
    c=$(cost "$out/forest_$name.so")
    echo "$name: $c"
  done
  exit 0
fi
case "$what" in registry|escrow) ;; *) echo "usage: devnet/deploy.sh registry|escrow|cost" >&2; exit 1 ;; esac
name=$what

id=$(node -e "process.stdout.write(require(process.argv[1])['$name'].programId)" "$json")
[ "$(solana-keygen pubkey "$keys/$name-program.json")" = "$id" ] || { echo "$name: the program key is not $id" >&2; exit 1; }
so="$out/forest_$name.so"
[ -f "$so" ] || { echo "no $so: run devnet/build.sh first" >&2; exit 1; }

deployed_now=false
if solana program show "$id" "${cli[@]}" >/dev/null 2>&1; then
  echo "$name: already deployed at $id"
else
  # 1. Any buffer a dead deploy left: close it, its SOL back to the deploy key.
  if solana program show --buffers --buffer-authority "$deployer" "${cli[@]}" 2>/dev/null | grep -q '^ *[1-9A-HJ-NP-Za-km-z]\{32,44\} '; then
    echo "$name: closing the deploy key's leftover buffers first"
    solana program close --buffers --authority "$keys/deploy.json" --recipient "$deployer" --bypass-warning "${cli[@]}"
  fi

  # 2. The exact cost, on a line by itself.
  c=$(cost "$so")
  need=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).total))" "$c")
  echo "$name: $c"
  echo
  echo "$deployer $(sol "$need") SOL"
  echo

  # 3. Wait for it.
  have=$(balance)
  deadline=$(( $(date +%s) + wait_minutes * 60 ))
  while [ "$have" -lt "$need" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$name: the deploy key holds $(sol "$have") SOL of $(sol "$need") after $wait_minutes minutes; nothing deployed" >&2
      exit 3
    fi
    echo "$name: the deploy key holds $(sol "$have") SOL of $(sol "$need"); checking again in 60 s"
    sleep 60
    have=$(balance)
  done

  echo "$name: deploying $(wc -c <"$so") bytes to $id, the key holding $(sol "$have") SOL ..."
  solana program deploy "${cli[@]}" --upgrade-authority "$keys/deploy.json" --program-id "$keys/$name-program.json" \
    --use-rpc --output json "$so" >"$out/$name.deploy.json"
  after=$(balance)
  printf '{"cost":%s,"balanceBefore":%s,"balanceAfter":%s}\n' "$c" "$have" "$after" >"$out/$name.spend.json"
  echo "$name: spent $(sol $((have - after))) SOL; computed $(sol "$need")"
  deployed_now=true
fi

solana program show "$id" "${cli[@]}" --output json >"$out/$name.show.json"
solana program dump "$id" "$out/$name.dumped.so" "${cli[@]}" >/dev/null
built=$(sha256sum <"$so" | cut -d' ' -f1)
deployed=$(head -c "$(wc -c <"$so")" "$out/$name.dumped.so" | sha256sum | cut -d' ' -f1)
[ "$built" = "$deployed" ] || { echo "$name: the deployed bytes are not the built ones" >&2; exit 1; }
echo "$name: deployed bytes match the build ($built)"

node - "$json" "$name" "$out" "$built" "$(wc -c <"$so")" "$deployed_now" "$so" <<'JS'
const fs = require('fs')
const [json, name, out, sha, bytes, now, so] = process.argv.slice(2)
const record = JSON.parse(fs.readFileSync(json, 'utf8'))
const show = JSON.parse(fs.readFileSync(`${out}/${name}.show.json`, 'utf8'))
const p = record[name]
p.programData = show.programdataAddress
p.upgradeAuthority = show.authority
p.lastDeploySlot = show.lastDeploySlot
p.soSha256 = sha
p.soBytes = Number(bytes)
// The SBPF version, read from the ELF header's e_flags (0 is the old format, 3 the newer one).
p.sbpfVersion = `v${fs.readFileSync(so).readUInt32LE(0x30)}`
if (now === 'true') {
  const d = JSON.parse(fs.readFileSync(`${out}/${name}.deploy.json`, 'utf8'))
  const s = JSON.parse(fs.readFileSync(`${out}/${name}.spend.json`, 'utf8'))
  p.deploySignature = d.signature
  p.deployCost = {
    note: 'computed before the deploy by devnet/deploy.sh (lamports), and the deploy key\'s balance before and after it',
    ...s.cost,
    balanceBefore: s.balanceBefore,
    balanceAfter: s.balanceAfter,
    spent: s.balanceBefore - s.balanceAfter,
  }
  record.transactions ??= []
  record.transactions.push({ program: name, what: `deploy: the ${name} program (SBPF ${p.sbpfVersion}), built by devnet/build.sh, upgrade authority kept on the deploy key`, signature: d.signature })
}
fs.writeFileSync(json, JSON.stringify(record, null, 2) + '\n')
JS

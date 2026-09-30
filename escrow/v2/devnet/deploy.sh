#!/usr/bin/env bash
# Build the escrow, v2, for devnet and deploy it at its own address, beside v1, which it never
# touches: v1's program id, its keypair and devnet/devnet.json are only read.
#
#   FOREST_DEVNET_SEED=<the phrase> escrow/v2/devnet/deploy.sh
#
# 1. Keys. The v2 program id is the key devnet/keys.sh's recipe derives from the phrase under the
#    new label `escrow-v2-program`:
#
#      seed = PBKDF2-HMAC-SHA256(phrase NFKD-trimmed-single-spaced, "forest-devnet:escrow-v2-program",
#                                600,000 iterations, 32 bytes);  key = ed25519 from that seed
#
#    It and the deploy key (label `deploy`, which pays and keeps the upgrade authority, as for v1)
#    are written to FOREST_DEVNET_KEYS (default ~/.forest-devnet/keys), never under the repo. The
#    deploy key must be the one devnet/devnet.json names, and the v2 id must be neither program
#    that file names.
# 2. Build. escrow/v2/program's Cargo.toml, Cargo.lock and src are copied into
#    escrow/v2/devnet/target/ (ignored), `declare_id!` alone is replaced with the v2 id, checked to
#    appear exactly once, and the copy is built for SBPF v3.
# 3. Deploy, unless the id already holds a program: the exact cost computed first as
#    devnet/deploy.sh computes it, refused (exit 3) if the deploy key holds less. Writes go over RPC.
# 4. Check the deployed bytes are the built ones, and record everything public in
#    escrow/v2/devnet/devnet.json.
#
# FOREST_DEVNET_RPC points the Solana CLI at another devnet RPC; the record always names the
# public one, so a keyed URL never lands in the repo. Devnet is not sealed: the upgrade authority
# stays on the deploy key. Sealing is the mainnet step (`--final`, in escrow/v2/README.md).

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out="$here/target"
record="$here/devnet.json"
base="$root/devnet/devnet.json"
keys="${FOREST_DEVNET_KEYS:-$HOME/.forest-devnet/keys}"
rpc="${FOREST_DEVNET_RPC:-https://api.devnet.solana.com}"
[ -n "${FOREST_DEVNET_SEED:-}" ] || { echo "FOREST_DEVNET_SEED is missing or empty" >&2; exit 1; }
case "$(realpath -m "$keys")/" in
  "$root"/*) echo "refusing: $keys is inside the repo" >&2; exit 1 ;;
esac
mkdir -p "$keys" "$out"
chmod 700 "$keys"

# 1. Keys.
node - "$keys" "$base" <<'JS'
const crypto = require('crypto')
const fs = require('fs')
const [dir, base] = process.argv.slice(2)
const phrase = process.env.FOREST_DEVNET_SEED.normalize('NFKD').trim().split(/\s+/).join(' ')
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b) break; s = '1' + s }
  return s
}
const record = JSON.parse(fs.readFileSync(base, 'utf8'))
const pk = {}
for (const label of ['deploy', 'escrow-v2-program']) {
  const seed = crypto.pbkdf2Sync(Buffer.from(phrase, 'utf8'), Buffer.from(`forest-devnet:${label}`, 'utf8'), 600_000, 32, 'sha256')
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)
  const file = `${dir}/${label}.json`
  const body = JSON.stringify([...seed, ...pub])
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== body) throw new Error(`${file} holds another key; move it away first`)
  fs.writeFileSync(file, body, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  pk[label] = base58(pub)
}
if (pk.deploy !== record.keys.deploy) throw new Error(`the phrase gives deploy key ${pk.deploy}, not ${record.keys.deploy}: another phrase`)
const id = pk['escrow-v2-program']
if (id === record.escrow.programId || id === record.registry.programId) throw new Error('the v2 id is one devnet/devnet.json already names')
console.log(`escrow v2 program id ${id}, deploy key ${pk.deploy}`)
JS
id=$(solana-keygen pubkey "$keys/escrow-v2-program.json")
cli=(--url "$rpc" --keypair "$keys/deploy.json")
deployer=$(solana-keygen pubkey "$keys/deploy.json")

# 2. Build.
rm -rf "$out/program"
mkdir -p "$out/program"
cp "$root/escrow/v2/program/Cargo.toml" "$root/escrow/v2/program/Cargo.lock" "$out/program/"
cp -r "$root/escrow/v2/program/src" "$out/program/src"
node - "$out/program/src/lib.rs" "$id" <<'JS'
const fs = require('fs')
const [file, id] = process.argv.slice(2)
const from = 'declare_id!("FoRE2EscrowV2objectsTimerFundedAtPayer222222");'
const to = `declare_id!("${id}");`
const text = fs.readFileSync(file, 'utf8')
if (text.split(from).length !== 2) throw new Error(`${file}: expected exactly one ${from}`)
fs.writeFileSync(file, text.replace(from, to))
JS
echo "the substitution, against the committed source:"
diff -u "$root/escrow/v2/program/src/lib.rs" "$out/program/src/lib.rs" | grep -E '^[-+][^-+]' || true
others=$(diff -rq "$root/escrow/v2/program/src" "$out/program/src" | grep -v '/lib.rs and ' || true)
[ -z "$others" ] || { echo "more than lib.rs differs: $others" >&2; exit 1; }
(cd "$out/program" && cargo build-sbf --arch v3 >"$out/build.log" 2>&1) || { tail -40 "$out/build.log"; exit 1; }
so="$out/forest_escrow_v2.so"
cp "$out/program/target/deploy/forest_escrow_v2.so" "$so"
rm -f "$out/program/target/deploy/"*-keypair.json
built=$(sha256sum <"$so" | cut -d' ' -f1)
echo "built $(wc -c <"$so") bytes, SBPF v$(node -e "process.stdout.write(String(require('fs').readFileSync(process.argv[1]).readUInt32LE(0x30)))" "$so"), sha256 $built"

# 3. Deploy.
deployed_now=false
if solana program show "$id" "${cli[@]}" >/dev/null 2>&1; then
  echo "already deployed at $id"
else
  cost=$(node - "$rpc" "$so" <<'JS'
const fs = require('fs')
const [rpc, so] = process.argv.slice(2)
const bytes = fs.readFileSync(so)
const CHUNK = 1012 // Solana CLI 4.2.2: 1,232 minus an empty write transaction's 219 bytes, minus 1
let writes = 0
for (let at = 0; at < bytes.length; at += CHUNK) if (bytes.subarray(at, Math.min(at + CHUNK, bytes.length)).some((b) => b !== 0)) writes++
async function rent(size) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [size] }) })
  const j = await r.json()
  if (typeof j.result !== 'number') throw new Error(`getMinimumBalanceForRentExemption(${size}): ${JSON.stringify(j)}`)
  return j.result
}
;(async () => {
  const programDataRent = await rent(45 + bytes.length)
  const programRent = await rent(36)
  const fees = 10_000 + 5_000 * writes + 10_000
  console.log(JSON.stringify({ bytes: bytes.length, programDataRent, programRent, writes, fees, total: programDataRent + programRent + fees }))
})()
JS
)
  need=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).total))" "$cost")
  have=$(solana balance "$deployer" "${cli[@]}" --lamports | cut -d' ' -f1)
  echo "cost $cost; the deploy key holds $have lamports"
  [ "$have" -ge "$need" ] || { echo "the deploy key holds less than the deploy costs; nothing deployed" >&2; exit 3; }
  solana program deploy "${cli[@]}" --upgrade-authority "$keys/deploy.json" --program-id "$keys/escrow-v2-program.json" \
    --use-rpc --output json "$so" >"$out/deploy.json"
  after=$(solana balance "$deployer" "${cli[@]}" --lamports | cut -d' ' -f1)
  printf '{"cost":%s,"balanceBefore":%s,"balanceAfter":%s}\n' "$cost" "$have" "$after" >"$out/spend.json"
  echo "spent $((have - after)) lamports; computed $need"
  deployed_now=true
fi

# 4. Check and record.
solana program show "$id" "${cli[@]}" --output json >"$out/show.json"
solana program dump "$id" "$out/dumped.so" "${cli[@]}" >/dev/null
deployed=$(head -c "$(wc -c <"$so")" "$out/dumped.so" | sha256sum | cut -d' ' -f1)
[ "$built" = "$deployed" ] || { echo "the deployed bytes are not the built ones" >&2; exit 1; }
echo "deployed bytes match the build ($built)"

node - "$record" "$out" "$id" "$built" "$so" "$deployed_now" <<'JS'
const fs = require('fs')
const [recordPath, out, id, sha, so, now] = process.argv.slice(2)
const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : {
  note: 'The devnet deploy of the escrow, v2, beside v1 (devnet/devnet.json), which it does not touch. Public keys, addresses and signatures only. The program id is derived from the devnet phrase under the label escrow-v2-program; the other keys are the ones devnet/devnet.json names. Written by escrow/v2/devnet/deploy.sh and escrow/v2/client/scripts/devnet.ts.',
  cluster: 'devnet',
  rpc: 'https://api.devnet.solana.com',
}
const show = JSON.parse(fs.readFileSync(`${out}/show.json`, 'utf8'))
const p = (record.escrow ??= {})
p.programId = id
p.programData = show.programdataAddress
p.upgradeAuthority = show.authority
p.lastDeploySlot = show.lastDeploySlot
p.soSha256 = sha
p.soBytes = fs.statSync(so).size
p.sbpfVersion = `v${fs.readFileSync(so).readUInt32LE(0x30)}`
if (now === 'true') {
  const d = JSON.parse(fs.readFileSync(`${out}/deploy.json`, 'utf8'))
  const s = JSON.parse(fs.readFileSync(`${out}/spend.json`, 'utf8'))
  p.deploySignature = d.signature
  p.deployCost = { ...s.cost, balanceBefore: s.balanceBefore, balanceAfter: s.balanceAfter, spent: s.balanceBefore - s.balanceAfter }
  record.transactions ??= []
  record.transactions.push({ program: 'escrow-v2', what: `deploy: the escrow, v2 (SBPF ${p.sbpfVersion}), upgrade authority kept on the deploy key`, signature: d.signature })
}
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
JS
echo "recorded in $record"

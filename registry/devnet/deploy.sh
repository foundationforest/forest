#!/usr/bin/env bash
# Build the registry (one row per market stamp) for devnet and deploy it at its own address. The
# closed registries before it, named in this record's `earlier`, are never touched: their ids are
# only read.
#
#   FOREST_DEVNET_SEED=<the phrase> registry/devnet/deploy.sh
#
# 1. Keys. Every devnet key comes from one phrase, so any machine holding it gets the same keys and
#    the same program id. The recipe, reproducible with any language's standard library:
#
#      phrase = FOREST_DEVNET_SEED, Unicode NFKD, trimmed, runs of whitespace made one space
#      seed   = PBKDF2-HMAC-SHA256(phrase, salt = "forest-devnet:" + label, 600,000 iterations, 32 bytes)
#      key    = the ed25519 keypair whose secret seed is `seed` (Solana's Keypair.fromSeed)
#
#    One label per key: `deploy` (pays for the deploy and keeps the upgrade authority), `payer`
#    (pays every fee and deposit in registry/client/scripts/devnet.ts, as a fee payer would), and
#    `registry-rows-program`, the program id. The keypair files go to FOREST_DEVNET_KEYS (default
#    ~/.forest-devnet/keys), never under the repo: the directory mode 700, the files 600, and a file
#    holding another key is refused, not overwritten. Only public keys are printed, and the phrase
#    is in no file. The public keys must be the ones registry/devnet/devnet.json names in `keys` (a
#    missing record is started with them), and the id must be no program this record or
#    escrow/devnet/devnet.json names.
# 2. Build. registry/program's Cargo.toml, Cargo.lock and src are copied into
#    registry/devnet/target/ (ignored), `declare_id!` alone is replaced with the devnet id, checked
#    to appear exactly once, and the copy is built for SBPF v3.
# 3. Deploy, unless the id already holds a program: the exact cost computed first, the way Solana
#    CLI 4.2.2 spends it, refused (exit 3) if the deploy key holds less. Writes go over RPC.
# 4. Check the deployed bytes are the built ones, and record everything public in
#    registry/devnet/devnet.json. The check needs the same toolchain: Solana CLI 4.2.2,
#    cargo-build-sbf 4.1.0, platform-tools v1.54.
#
# FOREST_DEVNET_RPC points the Solana CLI at another devnet RPC; the record always names the
# public one, so a keyed URL never lands in the repo. Devnet is not sealed: the upgrade authority
# stays on the deploy key, and whoever holds the phrase holds it. Sealing is the mainnet step
# (`--final`, in registry/README.md). A new phrase starts from nothing: its deploy key needs SOL
# sent by hand.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$here/target"
record="$here/devnet.json"
escrow="$root/escrow/devnet/devnet.json"
keys="${FOREST_DEVNET_KEYS:-$HOME/.forest-devnet/keys}"
rpc="${FOREST_DEVNET_RPC:-https://api.devnet.solana.com}"
[ -n "${FOREST_DEVNET_SEED:-}" ] || { echo "FOREST_DEVNET_SEED is missing or empty" >&2; exit 1; }
case "$(realpath -m "$keys")/" in
  "$root"/*) echo "refusing: $keys is inside the repo" >&2; exit 1 ;;
esac
mkdir -p "$keys" "$out"
chmod 700 "$keys"

# 1. Keys.
node - "$keys" "$record" "$escrow" <<'JS'
const crypto = require('crypto')
const fs = require('fs')
const [dir, own, escrow] = process.argv.slice(2)
const phrase = process.env.FOREST_DEVNET_SEED.normalize('NFKD').trim().split(/\s+/).join(' ')
// An ed25519 private key as PKCS#8 DER is this fixed prefix and the 32-byte seed.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b) break; s = '1' + s }
  return s
}
const pk = {}
for (const label of ['deploy', 'payer', 'registry-rows-program']) {
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
const keys = { deploy: pk.deploy, payer: pk.payer }
const record = fs.existsSync(own) ? JSON.parse(fs.readFileSync(own, 'utf8')) : null
if (record) {
  for (const [name, key] of Object.entries(keys)) {
    if (record.keys?.[name] !== key) throw new Error(`the phrase gives ${name} key ${key}, not ${record.keys?.[name]}: another phrase`)
  }
} else {
  fs.writeFileSync(own, JSON.stringify({
    note: 'The devnet deploy of the registry: one row per market stamp. Public keys, addresses and signatures only. Every key comes from the devnet phrase by the recipe in registry/devnet/deploy.sh, which writes the keypairs outside the repo and checks them against `keys`; the program id\'s label is registry-rows-program. Written by registry/devnet/deploy.sh and registry/client/scripts/devnet.ts; read by registry/client/test/devnet.test.ts.',
    cluster: 'devnet',
    rpc: 'https://api.devnet.solana.com',
    keys,
  }, null, 2) + '\n')
}
const id = pk['registry-rows-program']
const other = fs.existsSync(escrow) ? JSON.parse(fs.readFileSync(escrow, 'utf8')) : {}
const taken = [...(record?.earlier ?? []).map((e) => e.registry.programId), other.escrow?.programId, ...(other.earlier ?? []).map((e) => e.escrow.programId)]
if (taken.includes(id)) throw new Error('the id is one another deploy already names')
console.log(`registry program id ${id}, deploy key ${pk.deploy}, payer ${pk.payer}`)
JS
id=$(solana-keygen pubkey "$keys/registry-rows-program.json")
cli=(--url "$rpc" --keypair "$keys/deploy.json")
deployer=$(solana-keygen pubkey "$keys/deploy.json")

# 2. Build.
rm -rf "$out/program"
mkdir -p "$out/program"
cp "$root/registry/program/Cargo.toml" "$root/registry/program/Cargo.lock" "$out/program/"
cp -r "$root/registry/program/src" "$out/program/src"
node - "$out/program/src/lib.rs" "$id" <<'JS'
const fs = require('fs')
const [file, id] = process.argv.slice(2)
const from = 'declare_id!("FoRRegistryRowsFreeNoFeeNoAdmin1111111111111");'
const to = `declare_id!("${id}");`
const text = fs.readFileSync(file, 'utf8')
if (text.split(from).length !== 2) throw new Error(`${file}: expected exactly one ${from}`)
fs.writeFileSync(file, text.replace(from, to))
JS
echo "the substitution, against the committed source:"
diff -u "$root/registry/program/src/lib.rs" "$out/program/src/lib.rs" | grep -E '^[-+][^-+]' || true
others=$(diff -rq "$root/registry/program/src" "$out/program/src" | grep -v '/lib.rs and ' || true)
[ -z "$others" ] || { echo "more than lib.rs differs: $others" >&2; exit 1; }
(cd "$out/program" && cargo build-sbf --arch v3 >"$out/build.log" 2>&1) || { tail -40 "$out/build.log"; exit 1; }
so="$out/forest_registry.so"
cp "$out/program/target/deploy/forest_registry.so" "$so"
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
  solana program deploy "${cli[@]}" --upgrade-authority "$keys/deploy.json" --program-id "$keys/registry-rows-program.json" \
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
const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
const show = JSON.parse(fs.readFileSync(`${out}/show.json`, 'utf8'))
const p = (record.registry ??= {})
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
  record.transactions.push({ what: `deploy: the registry (SBPF ${p.sbpfVersion}), upgrade authority kept on the deploy key`, signature: d.signature })
}
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
JS
echo "recorded in $record"

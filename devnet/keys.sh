#!/usr/bin/env bash
# Derive every devnet key from one phrase, so any session holding the phrase gets the same keys, the
# same program ids and the same addresses, and a devnet deploy outlives the machine that made it.
#
#   FOREST_DEVNET_SEED=<the phrase> [FOREST_DEVNET_KEYS=<dir outside the repo>] devnet/keys.sh
#
# The recipe, reproducible with any language's standard library:
#
#   phrase = FOREST_DEVNET_SEED, Unicode NFKD, trimmed, runs of whitespace made one space
#   seed   = PBKDF2-HMAC-SHA256(password = phrase, salt = "forest-devnet:" + label,
#                               600,000 iterations, 32 bytes)
#   key    = the ed25519 keypair whose 32-byte secret seed is `seed` (Solana's Keypair.fromSeed)
#
# one label per key: deploy, treasury, issuer, payer, buyer, seller, registry-program,
# escrow-program, test-dollar-mint, test-dollar-authority.
#
# The keypair files, in solana-keygen's format (the Solana CLI and the devnet scripts read them),
# go into FOREST_DEVNET_KEYS (default ~/.forest-devnet/keys), never under the repo: mode 700, files
# 600. A file already there that holds another key is refused, not overwritten. Only public keys
# are printed. devnet/devnet.json is started afresh only if it names other keys; with the same
# phrase it is left as it is, so whatever the deploy recorded stays.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
[ -n "${FOREST_DEVNET_SEED:-}" ] || { echo "FOREST_DEVNET_SEED is missing or empty: no keys derived" >&2; exit 1; }
keys="${FOREST_DEVNET_KEYS:-$HOME/.forest-devnet/keys}"
case "$(realpath -m "$keys")/" in
  "$(realpath -m "$here/..")"/*) echo "refusing: $keys is inside the repo" >&2; exit 1 ;;
esac

mkdir -p "$keys"
chmod 700 "$keys"

node - "$here/devnet.json" "$keys" <<'JS'
const crypto = require('crypto')
const fs = require('fs')
const [recordPath, dir] = process.argv.slice(2)

const phrase = process.env.FOREST_DEVNET_SEED.normalize('NFKD').trim().split(/\s+/).join(' ')
const LABELS = ['deploy', 'treasury', 'issuer', 'payer', 'buyer', 'seller', 'registry-program', 'escrow-program', 'test-dollar-mint', 'test-dollar-authority']
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
for (const label of LABELS) {
  const seed = crypto.pbkdf2Sync(Buffer.from(phrase, 'utf8'), Buffer.from(`forest-devnet:${label}`, 'utf8'), 600_000, 32, 'sha256')
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
  const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)
  const file = `${dir}/${label}.json`
  const body = JSON.stringify([...seed, ...pub])
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== body) {
    throw new Error(`${file} holds another key; move it away first (it may hold test SOL)`)
  }
  fs.writeFileSync(file, body, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  pk[label] = base58(pub)
}

const keys = {
  deploy: pk.deploy,
  treasury: pk.treasury,
  foundationIssuer: pk.issuer,
  payer: pk.payer,
  buyer: pk.buyer,
  seller: pk.seller,
  testDollarAuthority: pk['test-dollar-authority'],
}
const fresh = {
  note: 'The devnet deploy of both programs. Public keys, addresses and signatures only. Every key is derived from one phrase (devnet/keys.sh), which is kept in no file and nowhere in this repo. Written by devnet/keys.sh, devnet/deploy.sh and the devnet scripts in registry/client and escrow/client; read by their devnet smoke tests. See docs/devnet.md.',
  cluster: 'devnet',
  rpc: 'https://api.devnet.solana.com',
  keys,
  registry: { programId: pk['registry-program'] },
  escrow: { programId: pk['escrow-program'] },
  testDollar: { mint: pk['test-dollar-mint'], decimals: 6 },
}
const old = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null
const same = old &&
  JSON.stringify(old.keys) === JSON.stringify(keys) &&
  old.registry?.programId === fresh.registry.programId &&
  old.escrow?.programId === fresh.escrow.programId &&
  old.testDollar?.mint === fresh.testDollar.mint
if (same) {
  console.log(`${recordPath}: already names these keys; kept as it is`)
} else {
  fs.writeFileSync(recordPath, JSON.stringify(fresh, null, 2) + '\n')
  console.log(`${recordPath}: started afresh for these keys`)
}
console.log(JSON.stringify({ ...keys, registryProgram: fresh.registry.programId, escrowProgram: fresh.escrow.programId, testDollarMint: fresh.testDollar.mint }, null, 2))
JS

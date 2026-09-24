#!/usr/bin/env bash
# Make a fresh set of throwaway devnet keys and start a fresh devnet/devnet.json from their public
# halves. For a new devnet deploy: new keys, so new program ids and new addresses.
#
#   FOREST_DEVNET_KEYS=<dir outside the repo> devnet/keys.sh
#
# Each keypair is made with solana-keygen, its output thrown away so no secret or recovery phrase
# is printed, into <dir> (mode 700, files 600). Existing files there are kept. The record is
# rewritten with the public keys only, and nothing else: whatever a previous deploy recorded is
# dropped, since the new keys name new programs. The old record stays in git history.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
keys="${FOREST_DEVNET_KEYS:?set FOREST_DEVNET_KEYS to a directory outside the repo}"
case "$(realpath -m "$keys")/" in
  "$(realpath -m "$here/..")"/*) echo "refusing: $keys is inside the repo" >&2; exit 1 ;;
esac

mkdir -p "$keys"
chmod 700 "$keys"
for name in deploy treasury issuer payer registry-program escrow-program buyer seller test-dollar-mint test-dollar-authority; do
  [ -f "$keys/$name.json" ] || solana-keygen new --silent --no-bip39-passphrase --outfile "$keys/$name.json" >/dev/null 2>&1
  chmod 600 "$keys/$name.json"
done

node - "$here/devnet.json" "$keys" <<'JS'
const { execFileSync } = require('child_process')
const fs = require('fs')
const [record, keys] = process.argv.slice(2)
const pk = (n) => execFileSync('solana-keygen', ['pubkey', `${keys}/${n}.json`]).toString().trim()
const j = {
  note: 'A devnet deploy of both programs. Public keys, addresses and signatures only; the private keys stayed on the machine that made them and are kept nowhere. Written by devnet/keys.sh, devnet/deploy.sh and the devnet scripts in registry/client and escrow/client; read by their devnet smoke tests. See docs/devnet.md.',
  cluster: 'devnet',
  rpc: 'https://api.devnet.solana.com',
  keys: {
    deploy: pk('deploy'),
    treasury: pk('treasury'),
    foundationIssuer: pk('issuer'),
    payer: pk('payer'),
    buyer: pk('buyer'),
    seller: pk('seller'),
    testDollarAuthority: pk('test-dollar-authority'),
  },
  registry: { programId: pk('registry-program') },
  escrow: { programId: pk('escrow-program') },
  testDollar: { mint: pk('test-dollar-mint'), decimals: 6 },
}
fs.writeFileSync(record, JSON.stringify(j, null, 2) + '\n')
console.log(JSON.stringify(j.keys, null, 2))
JS

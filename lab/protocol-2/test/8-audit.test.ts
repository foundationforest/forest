// Claim 8. One person can audit it in a day: the protocol is small, and every dependency is a named,
// widely reviewed piece doing one thing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const here = new URL('..', import.meta.url).pathname

test('claim 8: the whole protocol is under 1,500 lines of source, and its dependencies are the eight named pieces', () => {
  const src = join(here, 'src')
  let total = 0
  const perFile: Record<string, number> = {}
  for (const f of readdirSync(src).sort()) {
    const lines = readFileSync(join(src, f), 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
    perFile[f] = lines.length
    total += lines.length
  }
  console.log('  lines of source (blank and comment lines left out):', JSON.stringify(perFile), 'total', total)
  assert.ok(total < 1500, `source is ${total} lines`)

  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@hpke/core', // HPKE, RFC 9180
    '@hpke/dhkem-x25519', // its X25519 KEM
    '@ipld/dag-cbor', // DAG-CBOR, the deterministic CBOR profile
    '@noble/curves', // ed25519 and X25519, audited
    '@noble/hashes', // SHA-256, audited
    '@scure/base', // base58, base64url
    'dns-packet', // the DNS wire format the pointer is carried in
    'multiformats', // CIDs
  ])
})

test('claim 8: the rules are in one file, and every refusal has a name', () => {
  const entry = readFileSync(join(here, 'src', 'entry.ts'), 'utf8')
  for (const code of ['shape', 'size', 'seq', 'prev', 'signature', 'unknown-grant', 'not-granted', 'revoked', 'expired', 'scope', 'limit']) {
    assert.ok(entry.includes(`'${code}'`), `entry.ts names the refusal ${code}`)
  }
})

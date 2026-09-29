// The spec's pinned vectors: recomputed here, and each one checked with a second Ed25519
// implementation (OpenSSL through node:crypto) and a second SHA-256.

import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { b64u, hex } from '../src/bytes.ts'
import { decodeEntry } from '../src/entry.ts'
import { publicKeyFromDid } from '../src/keys.ts'
import { vectors } from './vectors.ts'

const pinned = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))

test('the vectors are what this implementation computes', async () => {
  assert.deepEqual(await vectors(), pinned)
})

test('each vector checks with a second implementation', () => {
  for (const name of ['folder', 'offer', 'grant', 'delegated', 'deleted']) {
    const v = pinned[name] as { wire: string; signingInputHex: string; id: string }
    const { entry, id } = decodeEntry(v.wire)
    assert.equal(id, v.id)
    const input = hex.decode(v.signingInputHex)
    assert.equal(input[0], 0xff)
    assert.equal(createHash('sha256').update(input).digest('hex'), v.id)
    const key = publicKeyFromDid(entry.by ?? entry.profile)!
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' })
    assert.ok(verify(null, input, spki, b64u.decode(entry.sig)), name)
  }
})

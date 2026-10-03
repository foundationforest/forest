// The spec's pinned vectors: recomputed here, and each step checked with a second implementation:
// node:crypto (OpenSSL) for Ed25519 and SHA-256. The keys are keys/'s, and keys/'s own tests
// recompute them.

import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { b64u, base58, hex } from '../src/bytes.ts'
import { publicKeyFromAddress } from '../src/keys.ts'
import { decodeRecord } from '../src/record.ts'
import { KEYS } from './fixtures.ts'
import { vectors } from './vectors.ts'

const pinned = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const RECORDS = ['hosts', 'profileCard', 'offer', 'permissions', 'written', 'deleted'] as const

test('the vectors are what this implementation computes', async () => {
  assert.deepEqual(await vectors(), pinned)
})

test("the keys are keys/'s pinned ones; the access key, recomputed with node:crypto", () => {
  assert.equal(pinned.profile, KEYS.profiles[0].address)
  assert.equal(decodeRecord(pinned.profileCard.wire).record.body!.read, KEYS.profiles[0].reading.recipient)
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x2a)]) // Ed25519 PKCS#8
  const publicKey = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
  assert.equal(base58.encode(new Uint8Array(publicKey)), pinned.accessKey)
})

test('each record checks with a second Ed25519 and a second SHA-256', () => {
  for (const name of RECORDS) {
    const v = pinned[name] as { wire: string; signingInputHex: string; id: string }
    const { record, id } = decodeRecord(v.wire)
    assert.equal(id, v.id)
    const input = hex.decode(v.signingInputHex)
    assert.deepEqual([...input.subarray(0, 18)], [0xff, ...Buffer.from('forest/v1/record\n')])
    assert.equal(createHash('sha256').update(input).digest('hex'), v.id)
    const key = publicKeyFromAddress(record.by ?? record.profile)!
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' })
    assert.ok(verify(null, input, spki, b64u.decode(record.sig)), name)
  }
})

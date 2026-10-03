// The spec's pinned vectors: recomputed here, and each step checked with a second implementation:
// node:crypto (OpenSSL) for Ed25519 and SHA-256. The keys are keys/'s, and keys/'s own tests
// recompute them.

import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { b64u, base58, hex } from '../src/bytes.ts'
import { publicKeyFromAddress } from '../src/keys.ts'
import { checkPull, decodeMessage } from '../src/message.ts'
import { openMessage } from '../src/private.ts'
import { decodeRecord } from '../src/record.ts'
import { KEYS } from './fixtures.ts'
import { vectors } from './vectors.ts'

const pinned = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const RECORDS = ['hosts', 'profileCard', 'offer', 'permissions', 'written', 'deleted'] as const

test('the vectors are what this implementation computes', async () => {
  assert.deepEqual(await vectors(), pinned)
})

test("the keys are keys/'s pinned ones; the access key, recomputed with node:crypto", () => {
  assert.equal(pinned.profile, KEYS.mainKeys[0].address)
  assert.equal(decodeRecord(pinned.profileCard.wire).record.body!.read, KEYS.mainKeys[0].reading.recipient)
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x2a)]) // Ed25519 PKCS#8
  const publicKey = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32)
  assert.equal(base58.encode(new Uint8Array(publicKey)), pinned.accessKey)
})

/** Ed25519 by node:crypto (OpenSSL). */
const nodeVerifies = (input: Uint8Array, address: string, sig: string) =>
  verify(null, input, createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyFromAddress(address)!]), format: 'der', type: 'spki' }), b64u.decode(sig))
const startsWith = (input: Uint8Array, text: string) => assert.deepEqual([...input.subarray(0, 1 + text.length)], [0xff, ...Buffer.from(text)])

test('each record checks with a second Ed25519 and a second SHA-256', () => {
  for (const name of RECORDS) {
    const v = pinned[name] as { wire: string; signingInputHex: string; id: string }
    const { record, id } = decodeRecord(v.wire)
    assert.equal(id, v.id)
    const input = hex.decode(v.signingInputHex)
    startsWith(input, 'forest/v1/record\n')
    assert.equal(createHash('sha256').update(input).digest('hex'), v.id)
    assert.ok(nodeVerifies(input, record.by ?? record.profile, record.sig), name)
  }
})

test("the message checks with a second Ed25519 and a second SHA-256, is from keys/'s tutoring/buyer, and opens with tutoring/seller's pinned reading key", async () => {
  const v = pinned.message as { wire: string; signingInputHex: string; id: string }
  const { message, id } = decodeMessage(v.wire)
  assert.equal(id, v.id)
  const input = hex.decode(v.signingInputHex)
  startsWith(input, 'forest/v1/message\n')
  assert.equal(createHash('sha256').update(input).digest('hex'), v.id)
  assert.deepEqual([message.from, message.to], [KEYS.mainKeys[1].address, KEYS.mainKeys[0].address])
  assert.ok(nodeVerifies(input, message.from, message.sig))
  assert.deepEqual((await openMessage(v.wire, KEYS.mainKeys[0].reading.identity)).body, { text: 'Is Tuesday at six free?' })
})

test('the pull checks with a second Ed25519, by the profile it pulls', () => {
  const v = pinned.pull as { wire: string; signingInputHex: string }
  const pull = checkPull(v.wire, JSON.parse(v.wire).time)
  const input = hex.decode(v.signingInputHex)
  startsWith(input, 'forest/v1/pull\n')
  assert.equal(pull.profile, KEYS.mainKeys[0].address)
  assert.ok(nodeVerifies(input, pull.profile, pull.sig))
})

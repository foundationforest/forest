// The spec's pinned vectors: recomputed here, and each step checked with a second implementation:
// node:crypto (OpenSSL) for HKDF, Ed25519, X25519 and SHA-256, and @scure/bip39 for the words.

import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, hkdfSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bech32 } from '@scure/base'
import { b64u, base58, hex } from '../src/bytes.ts'
import { publicKeyFromAddress } from '../src/keys.ts'
import { decodeRecord } from '../src/record.ts'
import { vectors } from './vectors.ts'

const pinned = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const RECORDS = ['hosts', 'profileCard', 'offer', 'permissions', 'written', 'deleted'] as const
const hkdf = (ikm: Uint8Array, info: string) => new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array(0), info, 32))
const rawPublic = (der: string, secret: Uint8Array) =>
  new Uint8Array(createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from(der, 'hex'), secret]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32))

test('the vectors are what this implementation computes', async () => {
  assert.deepEqual(await vectors(), pinned)
})

test('the keys, recomputed with node:crypto: words to seed, seed and label to profile key, profile key to reading key', () => {
  const seed = mnemonicToEntropy(pinned.seed.words, wordlist)
  assert.equal(hex.encode(seed), pinned.seed.hex)
  const secret = hkdf(seed, `forest/v1/profile/${pinned.profile.label}`)
  assert.equal(hex.encode(secret), pinned.profile.secretKeyHex)
  const publicKey = rawPublic('302e020100300506032b657004220420', secret) // Ed25519 PKCS#8
  assert.equal(hex.encode(publicKey), pinned.profile.publicKeyHex)
  assert.equal(base58.encode(publicKey), pinned.profile.address)

  const reading = hkdf(secret, 'forest/v1/read')
  assert.deepEqual(bech32.decodeToBytes(pinned.reading.identity.toLowerCase()).bytes, reading)
  const readingPublic = rawPublic('302e020100300506032b656e04220420', reading) // X25519 PKCS#8
  assert.deepEqual(bech32.decodeToBytes(pinned.reading.recipient).bytes, readingPublic)
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

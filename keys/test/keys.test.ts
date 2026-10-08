import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { blake512 } from '@noble/hashes/blake1.js'
import { base58, bech32, hex } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519.js'
import { MLKEM768X25519 } from '@noble/post-quantum/hybrid.js'
import { Decrypter, Encrypter } from 'age-encryption'
import { subOrder } from '@zk-kit/baby-jubjub'
import { poseidon1 } from 'poseidon-lite/poseidon1'
import {
  INFO,
  SEED_LENGTH,
  WORD_COUNT,
  exportWords,
  hkdf,
  importWords,
  issuerSecret,
  mainKey,
  newSeed,
  inboxKey,
} from '../src/index.ts'

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const seed = hex.decode(vectors.seed)
const otherSeed = new Uint8Array(32).fill(7)
const [seller, buyer] = vectors.mainKeys
const [issuerA, issuerB] = vectors.issuers
const utf8 = (text: string) => new TextEncoder().encode(text)
// HKDF-SHA256 from a second implementation: empty salt, 32 bytes.
const mix = (ikm: Uint8Array, info: string) => nobleHkdf(sha256, ikm, undefined, utf8(info), 32)

// The mixing table

test('the info strings are exactly the standard', () => {
  assert.equal(INFO.profile('tutoring/seller'), 'forest/v1/profile/tutoring/seller')
  assert.equal(INFO.read, 'forest/v1/read')
  assert.equal(INFO.issuer('issuer-a.example'), 'forest/v1/issuer/issuer-a.example')
  for (const v of [...vectors.mainKeys.map((p: { label: string; info: string }) => [INFO.profile(p.label), p.info]), ...vectors.issuers.map((i: { name: string; info: string }) => [INFO.issuer(i.name), i.info])]) {
    assert.equal(v[0], v[1])
  }
})

test('HKDF agrees with an independent implementation', async () => {
  for (const info of [INFO.profile('tutoring/seller'), INFO.profile(''), INFO.read, INFO.issuer(issuerA.name)]) {
    assert.equal(hex.encode(await hkdf(seed, info)), hex.encode(mix(seed, info)), info)
  }
})

// The seed

test('the seed is 24 words, pinned, and comes back', () => {
  const words = exportWords(seed)
  assert.equal(WORD_COUNT, 24)
  assert.equal(words.split(' ').length, 24)
  assert.equal(words, vectors.words)
  assert.equal(hex.encode(importWords(words)), vectors.seed)
})

test('spacing and case are forgiven; a wrong or missing word is not', () => {
  const words: string = vectors.words
  const messy = '  ' + words.toUpperCase().replaceAll(' ', '\n   ') + '\n'
  assert.equal(hex.encode(importWords(messy)), vectors.seed)
  const wrongWord = words.split(' ')
  wrongWord[23] = 'abandon'
  assert.throws(() => importWords(wrongWord.join(' ')), /not seed words/)
  assert.throws(() => importWords(words.split(' ').slice(0, 23).join(' ')), /expected 24 words, got 23/)
  assert.throws(() => exportWords(new Uint8Array(16)), /seed must be 32 bytes/)
})

test('a new seed is 32 fresh random bytes, and makes 24 words', () => {
  const one = newSeed()
  const two = newSeed()
  assert.equal(one.length, SEED_LENGTH)
  assert.notEqual(hex.encode(one), hex.encode(two))
  assert.equal(hex.encode(importWords(exportWords(one))), hex.encode(one))
})

// Main keys

test('each label gives the pinned main key, and gives it again', async () => {
  for (const expected of vectors.mainKeys) {
    for (let round = 0; round < 2; round++) {
      const key = await mainKey(seed, expected.label)
      assert.equal(key.label, expected.label)
      assert.equal(hex.encode(key.privateKey), expected.privateKey)
      assert.equal(key.address, expected.address)
      assert.equal(key.publicKey.length, 32)
    }
  }
})

test('the main key, recomputed without the library: HKDF, ed25519, base58', async () => {
  const privateKey = mix(seed, seller.info)
  assert.equal(hex.encode(privateKey), seller.privateKey)
  const publicKey = ed25519.getPublicKey(privateKey)
  assert.equal(base58.encode(publicKey), seller.address)
  assert.equal(hex.encode((await mainKey(seed, 'tutoring/seller')).publicKey), hex.encode(publicKey))
})

test('the label is used exactly: another case, another space, another profile', async () => {
  const addresses = new Set<string>()
  for (const label of ['tutoring/seller', 'Tutoring/Seller', 'tutoring/seller ', 'tutoring/buyer', 'ünïcødé/ラベル', '']) {
    addresses.add((await mainKey(seed, label)).address)
  }
  assert.equal(addresses.size, 6)
})

test('keys of one seed have nothing to do with keys of another seed', async () => {
  assert.notEqual((await mainKey(seed, 'tutoring/seller')).address, (await mainKey(otherSeed, 'tutoring/seller')).address)
  assert.notEqual((await issuerSecret(seed, issuerA.name)).noteNumber, (await issuerSecret(otherSeed, issuerA.name)).noteNumber)
})

test('a main key needs a 32-byte seed and a label that is text', async () => {
  await assert.rejects(mainKey(seed.subarray(0, 16), 'tutoring/seller'), /seed must be 32 bytes/)
  await assert.rejects(mainKey(seed, 'tutoring/\ud800seller'), /label must be text/)
  await assert.rejects(mainKey(seed, 7 as unknown as string), /label must be text/)
})

// Inbox keys

test('each profile gives the pinned inbox key, from its main key alone', async () => {
  for (const expected of vectors.mainKeys) {
    const key = await mainKey(seed, expected.label)
    const { privateKey, ...inbox } = expected.inbox
    assert.deepEqual(await inboxKey(key.privateKey), inbox)
    assert.equal(hex.encode(await hkdf(key.privateKey, INFO.read)), privateKey)
  }
})

test("the inbox key, recomputed without the library: HKDF, ML-KEM-768 with X25519, age's bech32", () => {
  const privateKey = mix(hex.decode(seller.privateKey), INFO.read)
  assert.equal(hex.encode(privateKey), seller.inbox.privateKey)
  assert.equal(bech32.encodeFromBytes('AGE-SECRET-KEY-PQ-', privateKey).toUpperCase(), seller.inbox.identity)
  // The recipient is the hybrid public key the 32 bytes expand to, in bech32 under age1pq, with
  // no length limit: it is about 1,960 characters.
  const publicKey = MLKEM768X25519.getPublicKey(privateKey)
  assert.equal(bech32.encode('age1pq', bech32.toWords(publicKey), false), seller.inbox.recipient)
  assert.match(seller.inbox.identity, /^AGE-SECRET-KEY-PQ-1[0-9A-Z]+$/)
  assert.match(seller.inbox.recipient, /^age1pq1[0-9a-z]+$/)
})

test('age encrypts to the inbox key, and only that profile opens it', async () => {
  const encrypter = new Encrypter()
  encrypter.addRecipient(seller.inbox.recipient)
  const encrypted = await encrypter.encrypt('only for the seller profile')
  const opener = new Decrypter()
  opener.addIdentity(seller.inbox.identity)
  assert.equal(await opener.decrypt(encrypted, 'text'), 'only for the seller profile')
  const other = new Decrypter()
  other.addIdentity(buyer.inbox.identity)
  await assert.rejects(other.decrypt(encrypted, 'text'))
})

test('an inbox key needs the 32 private bytes of a main key', async () => {
  await assert.rejects(inboxKey(new Uint8Array(64)), /main private key must be 32 bytes/)
})

// Issuer secrets and note numbers

test('each issuer gives the pinned secret, scalar and note number, and gives them again', async () => {
  for (const expected of vectors.issuers) {
    for (let round = 0; round < 2; round++) {
      const { secret, scalar, noteNumber } = await issuerSecret(seed, expected.name)
      assert.equal(hex.encode(secret), expected.secret)
      assert.equal(hex.encode(mix(seed, expected.info)), expected.secret)
      assert.equal(scalar.toString(), expected.scalar)
      assert.equal(noteNumber.toString(), expected.noteNumber)
    }
  }
})

test('the scalar is the one Semaphore v4 made, and the note number Poseidon of it, step by step', () => {
  // BLAKE-512 of the 32 bytes, the first 32, pruned, read little-endian, shifted right 3, mod the
  // subgroup order: done here without zk-kit, so a change in its derivation shows up as a failing
  // test rather than silently. The note number is Poseidon(1) of the scalar.
  for (const expected of vectors.issuers) {
    const h = blake512(hex.decode(expected.secret)).slice(0, 32)
    h[0] &= 0xf8
    h[31] &= 0x7f
    h[31] |= 0x40
    let scalar = 0n
    for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(h[i])
    scalar = (scalar >> 3n) % subOrder
    assert.equal(scalar.toString(), expected.scalar)
    assert.equal(poseidon1([scalar]).toString(), expected.noteNumber)
  }
})

test('two issuers, two unrelated note numbers; and none of it is a main key', async () => {
  const a = await issuerSecret(seed, issuerA.name)
  const b = await issuerSecret(seed, issuerB.name)
  assert.notEqual(a.noteNumber, b.noteNumber)
  assert.notEqual(hex.encode(a.secret), hex.encode(b.secret))
  const all = [issuerA.secret, issuerB.secret, seller.privateKey, buyer.privateKey, seller.inbox.privateKey, buyer.inbox.privateKey, vectors.seed]
  assert.equal(new Set(all).size, all.length)
})

test('the name is used exactly, and must be text; the seed is 32 bytes', async () => {
  const names = new Set<string>()
  for (const name of ['issuer-a.example', 'Issuer-A.example', 'issuer-a.example ', '']) {
    names.add((await issuerSecret(seed, name)).noteNumber.toString())
  }
  assert.equal(names.size, 4)
  for (const name of ['issuer-\ud800a.example', 7, undefined]) {
    await assert.rejects(issuerSecret(seed, name as string), /issuer name must be text/, String(name))
  }
  await assert.rejects(issuerSecret(seed.subarray(1), issuerA.name), /seed must be 32 bytes/)
})

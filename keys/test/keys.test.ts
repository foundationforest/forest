import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { blake512 } from '@noble/hashes/blake1.js'
import { base58, bech32, hex } from '@scure/base'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { Decrypter, Encrypter } from 'age-encryption'
import { Base8, mulPointEscalar, subOrder } from '@zk-kit/baby-jubjub'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import {
  INFO,
  SEED_LENGTH,
  WORD_COUNT,
  exportWords,
  hkdf,
  importWords,
  listSecret,
  newSeed,
  profileKey,
  readingKey,
} from '../src/index.ts'

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const seed = hex.decode(vectors.seed)
const otherSeed = new Uint8Array(32).fill(7)
const [seller, buyer] = vectors.profiles
const [listA, listB] = vectors.lists
const utf8 = (text: string) => new TextEncoder().encode(text)
// HKDF-SHA256 from a second implementation: empty salt, 32 bytes.
const mix = (ikm: Uint8Array, info: string) => nobleHkdf(sha256, ikm, undefined, utf8(info), 32)

// The mixing table

test('the info strings are exactly the standard', () => {
  assert.equal(INFO.profile('tutoring/seller'), 'forest/v1/profile/tutoring/seller')
  assert.equal(INFO.read, 'forest/v1/read')
  assert.equal(INFO.list(listA.keeper), `forest/v1/list/${listA.keeper}`)
  for (const v of [...vectors.profiles.map((p: { label: string; info: string }) => [INFO.profile(p.label), p.info]), ...vectors.lists.map((l: { keeper: string; info: string }) => [INFO.list(l.keeper), l.info])]) {
    assert.equal(v[0], v[1])
  }
})

test('HKDF agrees with an independent implementation', async () => {
  for (const info of [INFO.profile('tutoring/seller'), INFO.profile(''), INFO.read, INFO.list(listA.keeper)]) {
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

// Profile keys

test('each label gives the pinned profile key, and gives it again', async () => {
  for (const expected of vectors.profiles) {
    for (let round = 0; round < 2; round++) {
      const key = await profileKey(seed, expected.label)
      assert.equal(key.label, expected.label)
      assert.equal(hex.encode(key.privateKey), expected.privateKey)
      assert.equal(key.address, expected.address)
      assert.equal(key.publicKey.length, 32)
    }
  }
})

test('the profile key, recomputed without the library: HKDF, ed25519, base58', async () => {
  const privateKey = mix(seed, seller.info)
  assert.equal(hex.encode(privateKey), seller.privateKey)
  const publicKey = ed25519.getPublicKey(privateKey)
  assert.equal(base58.encode(publicKey), seller.address)
  assert.equal(hex.encode((await profileKey(seed, 'tutoring/seller')).publicKey), hex.encode(publicKey))
})

test('the label is used exactly: another case, another space, another profile', async () => {
  const addresses = new Set<string>()
  for (const label of ['tutoring/seller', 'Tutoring/Seller', 'tutoring/seller ', 'tutoring/buyer', 'ünïcødé/ラベル', '']) {
    addresses.add((await profileKey(seed, label)).address)
  }
  assert.equal(addresses.size, 6)
})

test('keys of one seed have nothing to do with keys of another seed', async () => {
  assert.notEqual((await profileKey(seed, 'tutoring/seller')).address, (await profileKey(otherSeed, 'tutoring/seller')).address)
  assert.notEqual((await listSecret(seed, listA.keeper)).stamp, (await listSecret(otherSeed, listA.keeper)).stamp)
})

test('a profile key needs a 32-byte seed and a label that is text', async () => {
  await assert.rejects(profileKey(seed.subarray(0, 16), 'tutoring/seller'), /seed must be 32 bytes/)
  await assert.rejects(profileKey(seed, 'tutoring/\ud800seller'), /label must be text/)
  await assert.rejects(profileKey(seed, 7 as unknown as string), /label must be text/)
})

// Reading keys

test('each profile gives the pinned reading key, from its profile key alone', async () => {
  for (const expected of vectors.profiles) {
    const key = await profileKey(seed, expected.label)
    const { privateKey, ...reading } = expected.reading
    assert.deepEqual(await readingKey(key.privateKey), reading)
    assert.equal(hex.encode(await hkdf(key.privateKey, INFO.read)), privateKey)
  }
})

test("the reading key, recomputed without the library: HKDF, X25519, age's bech32", () => {
  const privateKey = mix(hex.decode(seller.privateKey), INFO.read)
  assert.equal(hex.encode(privateKey), seller.reading.privateKey)
  assert.equal(bech32.encodeFromBytes('AGE-SECRET-KEY-', privateKey).toUpperCase(), seller.reading.identity)
  assert.equal(bech32.encodeFromBytes('age', x25519.getPublicKey(privateKey)), seller.reading.recipient)
})

test('age seals to the reading key, and only that profile opens it', async () => {
  const encrypter = new Encrypter()
  encrypter.addRecipient(seller.reading.recipient)
  const sealed = await encrypter.encrypt('only for the seller profile')
  const opener = new Decrypter()
  opener.addIdentity(seller.reading.identity)
  assert.equal(await opener.decrypt(sealed, 'text'), 'only for the seller profile')
  const other = new Decrypter()
  other.addIdentity(buyer.reading.identity)
  await assert.rejects(other.decrypt(sealed, 'text'))
})

test('a reading key needs the 32 private bytes of a profile key', async () => {
  await assert.rejects(readingKey(new Uint8Array(64)), /profile private key must be 32 bytes/)
})

// List secrets and stamps

test('the keepers are the ones the vectors name', () => {
  assert.equal(base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(1))), listA.keeper)
  assert.equal(base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(2))), listB.keeper)
})

test('each list gives the pinned secret, identity and stamp, and gives them again', async () => {
  for (const expected of vectors.lists) {
    for (let round = 0; round < 2; round++) {
      const { secret, identity, stamp } = await listSecret(seed, expected.keeper)
      assert.equal(hex.encode(secret), expected.secret)
      assert.equal(hex.encode(mix(seed, expected.info)), expected.secret)
      assert.equal(identity.secretScalar.toString(), expected.secretScalar)
      assert.deepEqual(identity.publicKey.map(String), expected.publicKey)
      assert.equal(stamp.toString(), expected.stamp)
      assert.equal(identity.commitment, stamp)
    }
  }
})

test('the stamp is what Semaphore says it is, recomputed step by step', () => {
  // BLAKE-512 of the 32 bytes, the first 32, pruned, read little-endian, shifted right 3, mod
  // the subgroup order; times the base point on Baby Jubjub; the stamp is Poseidon(2) of the
  // two coordinates. Done here without the Semaphore wrapper, so a change in its derivation
  // shows up as a failing test rather than silently.
  for (const expected of vectors.lists) {
    const h = blake512(hex.decode(expected.secret)).slice(0, 32)
    h[0] &= 0xf8
    h[31] &= 0x7f
    h[31] |= 0x40
    let scalar = 0n
    for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(h[i])
    scalar = (scalar >> 3n) % subOrder
    const publicKey = mulPointEscalar(Base8, scalar)
    assert.equal(scalar.toString(), expected.secretScalar)
    assert.deepEqual(publicKey.map(String), expected.publicKey)
    assert.equal(poseidon2(publicKey).toString(), expected.stamp)
  }
})

test('two lists, two unrelated stamps; and none of it is a profile key', async () => {
  const a = await listSecret(seed, listA.keeper)
  const b = await listSecret(seed, listB.keeper)
  assert.notEqual(a.stamp, b.stamp)
  assert.notEqual(hex.encode(a.secret), hex.encode(b.secret))
  const all = [listA.secret, listB.secret, seller.privateKey, buyer.privateKey, seller.reading.privateKey, buyer.reading.privateKey, vectors.seed]
  assert.equal(new Set(all).size, all.length)
})

test('the keeper is an address in its one spelling, and the seed 32 bytes', async () => {
  const short = base58.encode(base58.decode(listA.keeper).subarray(1))
  for (const keeper of ['', 'not base58: 0OIl', short, `1${listA.keeper}`, hex.encode(base58.decode(listA.keeper)), 7]) {
    await assert.rejects(listSecret(seed, keeper as string), /keeper must be an address/, String(keeper))
  }
  await assert.rejects(listSecret(seed.subarray(1), listA.keeper), /seed must be 32 bytes/)
})

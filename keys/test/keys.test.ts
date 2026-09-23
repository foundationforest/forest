import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { blake512 } from '@noble/hashes/blake1.js'
import { base58, hex } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519.js'
import { assureValidCreationOp, createOp, validateOperationLog } from '@did-plc/lib'
import { Base8, mulPointEscalar, subOrder } from '@zk-kit/baby-jubjub'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import {
  INFO,
  PRF_INPUT,
  PRF_INPUT_TEXT,
  WORD_COUNT,
  centralWallet,
  didGenesis,
  exportWords,
  genesisOperation,
  hkdf,
  humanIdentity,
  identitySecret,
  importWords,
  profileKeys,
  seedFileLabel,
  seedFromPrf,
  unwrapSeed,
  wrapSeed,
} from '../src/index.ts'

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const prf = hex.decode(vectors.prf)
const otherPrf = hex.decode(vectors.seedFile.prf)
const params = { handle: vectors.handle, pds: vectors.pds }
const utf8 = (text: string) => new TextEncoder().encode(text)

// The passkey step

test('the PRF input is the fixed string, as UTF-8', () => {
  assert.equal(PRF_INPUT_TEXT, 'forest.foundation/prf/v1')
  assert.equal(new TextDecoder().decode(PRF_INPUT), PRF_INPUT_TEXT)
})

// The seed

test('the same PRF output gives the same seed every time, and it is the pinned one', async () => {
  const once = await seedFromPrf(prf)
  const twice = await seedFromPrf(prf)
  assert.equal(hex.encode(once), vectors.seed)
  assert.equal(hex.encode(twice), vectors.seed)
})

test('a different PRF output gives a different seed', async () => {
  assert.notEqual(hex.encode(await seedFromPrf(otherPrf)), vectors.seed)
})

test('HKDF agrees with an independent implementation', async () => {
  for (const info of [INFO.seed, INFO.control(0), INFO.signing(1), INFO.wallet(7), INFO.seedFileKey, INFO.seedFileLabel, INFO.identity, INFO.central]) {
    const ours = await hkdf(prf, info, 32)
    const theirs = nobleHkdf(nobleSha256, prf, undefined, utf8(info), 32)
    assert.equal(hex.encode(ours), hex.encode(theirs), info)
  }
})

test('the PRF output must be 32 bytes', async () => {
  await assert.rejects(seedFromPrf(prf.subarray(0, 31)), /prf must be 32 bytes/)
  await assert.rejects(seedFromPrf(new Uint8Array(33)), /prf must be 32 bytes/)
})

// Keys per profile

test('profiles 0 and 1 give the pinned keys, and give them again', async () => {
  const seed = await seedFromPrf(prf)
  for (const expected of vectors.profiles) {
    for (let round = 0; round < 2; round++) {
      const keys = await profileKeys(seed, expected.index)
      assert.equal(keys.index, expected.index)
      assert.equal(keys.control.did(), expected.control)
      assert.equal(keys.signing.did(), expected.signing)
      assert.equal(keys.wallet.address, expected.wallet)
      assert.equal(keys.wallet.privateKey.length, 32)
      assert.equal(keys.wallet.publicKey.length, 32)
    }
  }
})

test('the did:plc keys are secp256k1 and the wallet is ed25519', async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  // did:key with multicodec prefix 0xe7 (secp256k1) encodes as zQ3s...; P-256 would be zDn...
  assert.match(keys.control.did(), /^did:key:zQ3s/)
  assert.match(keys.signing.did(), /^did:key:zQ3s/)
  assert.equal(keys.control.jwtAlg, 'ES256K')
  assert.equal(keys.signing.jwtAlg, 'ES256K')
  assert.match(keys.wallet.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
})

test('every key is unrelated to every other: three per profile, across profiles', async () => {
  const seed = await seedFromPrf(prf)
  const all: string[] = []
  for (const n of [0, 1]) {
    const keys = await profileKeys(seed, n)
    all.push(keys.control.did(), keys.signing.did(), keys.wallet.address, hex.encode(keys.wallet.privateKey))
  }
  assert.equal(new Set(all).size, all.length)
})

test('keys of one seed have nothing to do with keys of another seed', async () => {
  const a = await profileKeys(await seedFromPrf(prf), 0)
  const b = await profileKeys(await seedFromPrf(otherPrf), 0)
  assert.notEqual(a.control.did(), b.control.did())
  assert.notEqual(a.signing.did(), b.signing.did())
  assert.notEqual(a.wallet.address, b.wallet.address)
})

test('the seed must be 32 bytes and the profile index a whole number from 0', async () => {
  const seed = await seedFromPrf(prf)
  await assert.rejects(profileKeys(seed.subarray(0, 16), 0), /seed must be 32 bytes/)
  await assert.rejects(profileKeys(seed, -1), /whole number, 0 or more/)
  await assert.rejects(profileKeys(seed, 1.5), /whole number, 0 or more/)
})

test('keys are not exportable', async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  await assert.rejects(keys.control.export(), /not exportable/i)
  await assert.rejects(keys.signing.export(), /not exportable/i)
})

// The identity, one per person

test('the identity secret is the pinned one, is one HKDF output, and carries no profile index', async () => {
  const seed = await seedFromPrf(prf)
  const secret = await identitySecret(seed)
  assert.equal(INFO.identity, 'forest.foundation/identity/v1')
  assert.equal(hex.encode(secret), vectors.identity.secret)
  assert.equal(hex.encode(await hkdf(seed, INFO.identity, 32)), vectors.identity.secret)
  assert.equal(secret.length, 32)
})

test('the identity and its commitment are the pinned ones, and the same seed gives them again', async () => {
  const seed = await seedFromPrf(prf)
  for (let round = 0; round < 2; round++) {
    const { identity, commitment } = await humanIdentity(seed)
    assert.equal(commitment.toString(), vectors.identity.commitment)
    assert.equal(identity.commitment.toString(), vectors.identity.commitment)
    assert.equal(identity.secretScalar.toString(), vectors.identity.secretScalar)
    assert.deepEqual(identity.publicKey.map(String), vectors.identity.publicKey)
  }
})

test("the commitment is what Semaphore says it is, recomputed step by step", async () => {
  // Session 3's report: BLAKE-512 of the 32 bytes, first 32, pruned, read
  // little-endian, shifted right 3, mod the subgroup order; times the base
  // point on Baby Jubjub; the commitment is Poseidon(2) of the two
  // coordinates. Done here without the Semaphore wrapper, so a change in its
  // derivation would show up as a failing test rather than silently.
  const secret = await identitySecret(await seedFromPrf(prf))
  const h = blake512(secret).slice(0, 32)
  h[0] &= 0xf8
  h[31] &= 0x7f
  h[31] |= 0x40
  let scalar = 0n
  for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(h[i])
  scalar = (scalar >> 3n) % subOrder
  const publicKey = mulPointEscalar(Base8, scalar)
  assert.equal(scalar.toString(), vectors.identity.secretScalar)
  assert.deepEqual(publicKey.map(String), vectors.identity.publicKey)
  assert.equal(poseidon2(publicKey).toString(), vectors.identity.commitment)
})

test('one identity per seed, not per profile, and unrelated to every profile key', async () => {
  const seed = await seedFromPrf(prf)
  const secret = await identitySecret(seed)
  for (const n of [0, 1]) {
    for (const info of [INFO.control(n), INFO.signing(n), INFO.wallet(n)]) {
      assert.notEqual(hex.encode(await hkdf(seed, info, 32)), hex.encode(secret))
    }
  }
  const other = await humanIdentity(await seedFromPrf(otherPrf))
  assert.notEqual(other.commitment.toString(), vectors.identity.commitment)
})

test('the seed must be 32 bytes', async () => {
  const seed = await seedFromPrf(prf)
  await assert.rejects(identitySecret(seed.subarray(0, 16)), /seed must be 32 bytes/)
  await assert.rejects(humanIdentity(new Uint8Array(33)), /seed must be 32 bytes/)
})

// The central wallet, one per person

test('the central wallet is the pinned one, one ed25519 key from one HKDF output with no profile index', async () => {
  const seed = await seedFromPrf(prf)
  assert.equal(INFO.central, 'forest.foundation/central/v1')
  for (let round = 0; round < 2; round++) {
    const wallet = await centralWallet(seed)
    assert.equal(wallet.address, vectors.central.wallet)
    assert.equal(wallet.privateKey.length, 32)
  }
  // Recomputed without the library: HKDF from a second implementation, then ed25519, then base58.
  const privateKey = nobleHkdf(nobleSha256, seed, undefined, utf8(INFO.central), 32)
  assert.equal(base58.encode(ed25519.getPublicKey(privateKey)), vectors.central.wallet)
})

test('the central wallet is unrelated to every profile key and to the identity secret', async () => {
  const seed = await seedFromPrf(prf)
  const central = await centralWallet(seed)
  for (const n of [0, 1, 2, 3]) {
    const keys = await profileKeys(seed, n)
    assert.notEqual(keys.wallet.address, central.address, `profile ${n}'s wallet`)
    for (const info of [INFO.control(n), INFO.signing(n), INFO.wallet(n)]) {
      assert.notEqual(hex.encode(await hkdf(seed, info, 32)), hex.encode(central.privateKey), info)
    }
  }
  assert.notEqual(hex.encode(await identitySecret(seed)), hex.encode(central.privateKey))
  assert.notEqual((await centralWallet(await seedFromPrf(otherPrf))).address, central.address, 'another seed')
})

test('the central wallet needs a 32-byte seed', async () => {
  const seed = await seedFromPrf(prf)
  await assert.rejects(centralWallet(seed.subarray(0, 16)), /seed must be 32 bytes/)
})

// The name

test('the genesis operation names the control key as rotation key and the signing key as verification key', async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  const op = genesisOperation(keys, params)
  assert.deepEqual(op, {
    type: 'plc_operation',
    rotationKeys: [keys.control.did()],
    verificationMethods: { atproto: keys.signing.did() },
    alsoKnownAs: ['at://handle.example'],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://host.example' } },
    prev: null,
  })
})

test("the signed genesis operation equals the directory library's own, byte for byte, and passes its checks", async () => {
  const seed = await seedFromPrf(prf)
  for (const expected of vectors.profiles) {
    const keys = await profileKeys(seed, expected.index)
    const ours = await didGenesis(keys, params)
    const theirs = await createOp({
      signingKey: keys.signing.did(),
      handle: params.handle,
      pds: params.pds,
      rotationKeys: [keys.control.did()],
      signer: keys.control,
    })
    assert.deepEqual(ours.op, theirs.op)
    assert.equal(ours.did, theirs.did)
    assert.equal(ours.did, expected.did)
    assert.equal(ours.op.sig, expected.sig)
    assert.match(ours.did, /^did:plc:[a-z2-7]{24}$/)
    const document = await assureValidCreationOp(ours.did, ours.op)
    assert.equal(document.did, ours.did)
    await validateOperationLog(ours.did, [ours.op])
  }
})

test('the same keys and parameters give the same DID again; other parameters give another DID', async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  const again = await didGenesis(keys, params)
  assert.equal(again.did, vectors.profiles[0].did)
  const moved = await didGenesis(keys, { handle: 'other.example', pds: params.pds })
  assert.notEqual(moved.did, again.did)
})

test('handle and host are normalised the way the directory library does it', async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  const spelled = await didGenesis(keys, { handle: 'at://handle.example', pds: 'host.example' })
  assert.equal(spelled.did, vectors.profiles[0].did)
})

test("a genesis operation changed after signing fails the library's checks", async () => {
  const keys = await profileKeys(await seedFromPrf(prf), 0)
  const { did, op } = await didGenesis(keys, params)
  const forged = { ...op, alsoKnownAs: ['at://someone.else'] }
  await assert.rejects(assureValidCreationOp(did, forged))
})

// The seed file

test('the label is deterministic, pinned, and the same one wrapSeed writes', async () => {
  assert.equal(await seedFileLabel(otherPrf), vectors.seedFile.label)
  assert.equal(await seedFileLabel(otherPrf), vectors.seedFile.label)
  const seed = await seedFromPrf(prf)
  const file = await wrapSeed(seed, otherPrf)
  assert.equal(file.label, vectors.seedFile.label)
  assert.deepEqual(Object.keys(file).sort(), ['ciphertext', 'label'])
})

test('wrap then unwrap returns the seed; each wrap is fresh', async () => {
  const seed = await seedFromPrf(prf)
  const one = await wrapSeed(seed, otherPrf)
  const two = await wrapSeed(seed, otherPrf)
  assert.notEqual(one.ciphertext, two.ciphertext)
  assert.equal(hex.encode(await unwrapSeed(one, otherPrf)), vectors.seed)
  assert.equal(hex.encode(await unwrapSeed(two, otherPrf)), vectors.seed)
})

test('the pinned seed file unwraps to the pinned seed', async () => {
  const { label, ciphertext } = vectors.seedFile
  assert.equal(hex.encode(await unwrapSeed({ label, ciphertext }, otherPrf)), vectors.seed)
})

test('a seed file opens only with the passkey that made it, and only undamaged', async () => {
  const { label, ciphertext } = vectors.seedFile
  await assert.rejects(unwrapSeed({ label, ciphertext }, prf), /not made by this passkey/)
  const flipped = ciphertext.slice(0, 40) + (ciphertext[40] === 'A' ? 'B' : 'A') + ciphertext.slice(41)
  await assert.rejects(unwrapSeed({ label, ciphertext: flipped }, otherPrf), /does not open/)
  await assert.rejects(unwrapSeed({ label, ciphertext: ciphertext.slice(0, 20) }, otherPrf), /wrong length/)
  await assert.rejects(unwrapSeed({ label: 'x' + label.slice(1), ciphertext }, otherPrf), /not made by this passkey/)
})

// Paper export

test('the seed becomes 24 words, pinned, and comes back', () => {
  const seed = hex.decode(vectors.seed)
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
  assert.throws(() => importWords(wrongWord.join(' ')), /not a paper export/)
  assert.throws(() => importWords(words.split(' ').slice(0, 23).join(' ')), /expected 24 words, got 23/)
  assert.throws(() => exportWords(new Uint8Array(16)), /seed must be 32 bytes/)
})

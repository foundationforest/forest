// Keys, canonical text, entries: the pieces every other part stands on.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { base58, hex } from '../src/bytes.ts'
import { canonical, parseCanonical } from '../src/canonical.ts'
import { EntryError, checkEntry, decodeEntry, encodeEntry, entryId, signEntry, unsignedOf } from '../src/entry.ts'
import { addressFromDid, didFromPublicKey, publicKeyFromDid } from '../src/keys.ts'
import { boxKey } from '../src/sealed.ts'
import { ownerEntry } from '../src/write.ts'
import { SEED, T0, VECTORS, alice, aliceBuyer, offerBody, profileBody } from './fixtures.ts'

describe('keys', () => {
  test('the seed and every profile key are exactly what keys/ pins: the profile id is its wallet', () => {
    assert.equal(hex.encode(SEED), VECTORS.seed)
    assert.equal(alice.address, VECTORS.profiles[0]!.wallet)
    assert.equal(aliceBuyer.address, VECTORS.profiles[1]!.wallet)
    assert.equal(addressFromDid(alice.did), alice.address)
    assert.match(alice.did, /^did:key:z6Mk/)
  })

  test('a did:key has one spelling and names a usable key', () => {
    assert.deepEqual(publicKeyFromDid(alice.did), alice.publicKey)
    assert.equal(publicKeyFromDid(alice.did + 'x'), null)
    assert.equal(publicKeyFromDid(alice.did.replace('did:key:z', 'did:key:Z')), null)
    assert.equal(publicKeyFromDid('did:key:z' + base58.encode(Uint8Array.of(0xe7, 0x01, ...alice.publicKey))), null) // secp256k1 prefix
    // The identity point, and a small-order point, are refused as names.
    const identity = new Uint8Array(32)
    identity[0] = 1
    assert.equal(publicKeyFromDid(didFromPublicKey(identity)), null)
    assert.equal(publicKeyFromDid(didFromPublicKey(hex.decode('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'))), null)
  })

  test('the box key is deterministic from the seed and post-quantum', async () => {
    const a = await boxKey(SEED, 0)
    const again = await boxKey(SEED, 0)
    const other = await boxKey(SEED, 1)
    assert.equal(a.recipient, again.recipient)
    assert.notEqual(a.recipient, other.recipient)
    assert.match(a.recipient, /^age1pq1/)
    assert.match(a.identity, /^AGE-SECRET-KEY-PQ-1/)
  })
})

describe('canonical text', () => {
  test('sorts keys, no whitespace, round-trips', () => {
    const text = canonical({ b: 1, a: [true, null, 'x'], c: { z: 'é', y: 2 } })
    assert.equal(text, '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":"é"}}')
    assert.deepEqual(parseCanonical(text), { a: [true, null, 'x'], b: 1, c: { y: 2, z: 'é' } })
  })

  test('refuses what could read two ways', () => {
    for (const text of [
      '{"a":1,"a":2}', // duplicate key
      '{"b":1,"a":2}', // key order
      '{"a": 1}', // whitespace
      '{"a":1.0}', // another number spelling
      '{"a":"\\u0041"}', // another escape
    ]) {
      assert.throws(() => parseCanonical(text), /canonical|JSON/, text)
    }
    assert.throws(() => canonical({ a: 1.5 }), /whole/)
    assert.throws(() => canonical({ a: 2 ** 53 }), /whole/)
    assert.throws(() => canonical({ a: '\ud800' }), /surrogate/)
    assert.throws(() => canonical({ __proto__x: 1 }), /key/)
    assert.throws(() => canonical({ Ab: 1 }), /key/)
    assert.throws(() => canonical(JSON.parse('{"__proto__":1}')), /key/)
    let deep: unknown = 'x'
    for (let i = 0; i < 20; i++) deep = { a: deep }
    assert.throws(() => canonical(deep), /deep/)
  })
})

describe('entries', () => {
  const entry = ownerEntry(alice, 'offer/maths', offerBody('30'), T0)

  test('an owner entry verifies, and its id is the hash of what was signed', () => {
    const { id } = checkEntry(entry)
    assert.equal(id, entryId(unsignedOf(entry)))
    const wire = encodeEntry(entry)
    assert.equal(decodeEntry(wire).id, id)
    assert.ok(wire.startsWith('{"body":'))
  })

  test('any change to any field breaks the signature', () => {
    const changes: Array<Record<string, unknown>> = [
      { path: 'offer/other' },
      { time: T0 + 1 },
      { profile: aliceBuyer.did },
      { body: offerBody('3') },
      { body: null },
    ]
    for (const change of changes) {
      const forged = { ...entry, ...change }
      assert.throws(() => checkEntry(forged), (err: EntryError) => err.code === 'signature', JSON.stringify(change))
    }
  })

  test('a key cannot sign as another profile', () => {
    assert.throws(() => signEntry({ v: 1, profile: aliceBuyer.did, path: 'profile', time: T0, body: profileBody('x') }, alice.secretKey), /not the signer/)
  })

  test('shape rules: unknown fields, control paths, delegates', () => {
    const base = { v: 1 as const, profile: alice.did, path: 'profile', time: T0, body: profileBody('A') }
    assert.throws(() => signEntry({ ...base, extra: 1 } as never, alice.secretKey), /unknown field/)
    assert.throws(() => signEntry({ ...base, path: 'Offer/x' }, alice.secretKey), /path/)
    assert.throws(() => signEntry({ ...base, path: 'offer/../x' }, alice.secretKey), /path/)
    assert.throws(() => signEntry({ ...base, path: 'folder/x' }, alice.secretKey), /folder/)
    assert.throws(() => signEntry({ ...base, path: 'grant/a/b' }, alice.secretKey), /grant/)
    assert.throws(() => signEntry({ ...base, by: alice.did, grant: 'a'.repeat(64) }, alice.secretKey), /owner signs without/)
    assert.throws(() => signEntry({ ...base, time: -1 }, alice.secretKey), /time/)
    assert.throws(() => signEntry({ ...base, path: 'folder', body: { hosts: ['http://example.com'] } }, alice.secretKey), /origin/)
    assert.throws(() => signEntry({ ...base, path: 'grant/g', body: { to: alice.did, paths: ['offer'], until: T0, pay: 5 } }, alice.secretKey), /grants nothing/)
    assert.throws(() => signEntry({ ...base, path: 'grant/g', body: { to: alice.did, paths: ['grant'], until: T0 } }, alice.secretKey), /content path/)
  })

  test('size cap', () => {
    const big = { about: 'x'.repeat(70_000) }
    assert.throws(() => ownerEntry(alice, 'profile', big, T0), /at most/)
  })
})

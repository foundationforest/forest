// Keys, canonical text, records: the pieces every other part stands on.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { base58, hex } from '../src/bytes.ts'
import { canonical, parseCanonical } from '../src/canonical.ts'
import { keyFromPrivate, publicKeyFromAddress } from '../src/keys.ts'
import { RecordError, checkRecord, decodeRecord, encodeRecord, recordId, signRecord, unsignedOf } from '../src/record.ts'
import { accessRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { KEYS, T0, accessKey, alice, aliceBuyer, allow, messageKey, offerBody, pastKey, profileBody, sizedRecord, stranger } from './fixtures.ts'

describe('keys', () => {
  test("main keys are keys/'s: its pinned profiles sign here, and a name is the key in base58", () => {
    assert.equal(alice.address, KEYS.mainKeys[0].address)
    assert.equal(aliceBuyer.address, KEYS.mainKeys[1].address)
    assert.equal(alice.address, base58.encode(alice.publicKey), 'the name is the key in base58: the same text as its Solana address')
    assert.deepEqual(keyFromPrivate(alice.privateKey), { privateKey: alice.privateKey, publicKey: alice.publicKey, address: alice.address })
    assert.throws(() => keyFromPrivate(alice.privateKey.subarray(1)), /32 bytes/)
  })

  test('an address has one spelling and names a usable key', () => {
    assert.deepEqual(publicKeyFromAddress(alice.address), alice.publicKey)
    assert.equal(publicKeyFromAddress(alice.address + '1'), null)
    assert.equal(publicKeyFromAddress('1' + alice.address), null, 'a leading 1 is a leading zero byte: 33 bytes')
    assert.equal(publicKeyFromAddress(alice.address.replace(/.$/, '0')), null, 'not base58')
    assert.equal(publicKeyFromAddress(`did:key:z${alice.address}`), null)
    // The identity point, and a small-order point, are refused as names.
    const identity = new Uint8Array(32)
    identity[0] = 1
    assert.equal(publicKeyFromAddress(base58.encode(identity)), null)
    assert.equal(publicKeyFromAddress(base58.encode(hex.decode('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'))), null)
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

describe('records', () => {
  const record = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)

  test('an owner record verifies, and its id is the hash of what was signed', () => {
    const { id } = checkRecord(record)
    assert.equal(id, recordId(unsignedOf(record)))
    const wire = encodeRecord(record)
    assert.equal(decodeRecord(wire).id, id)
    assert.ok(wire.startsWith('{"body":'))
  })

  test('a record by an access key verifies with that key, and names it in by', () => {
    const written = accessRecord(accessKey, alice.address, 'offer/physics', offerBody('40'), T0)
    assert.equal(checkRecord(written).record.by, accessKey.address)
    const { by: _by, ...asOwner } = written
    assert.throws(() => checkRecord(asOwner), (err: RecordError) => err.code === 'signature', 'without by it is not the owner’s')
  })

  test('any change to any field breaks the signature', () => {
    const changes: Array<{ [key: string]: unknown }> = [{ path: 'offer/other' }, { time: T0 + 1 }, { profile: aliceBuyer.address }, { body: offerBody('3') }, { body: null }, { by: accessKey.address }]
    for (const change of changes) {
      assert.throws(() => checkRecord({ ...record, ...change }), (err: RecordError) => err.code === 'signature', JSON.stringify(change))
    }
  })

  test('a key cannot sign as another profile, or as an access key it is not', () => {
    assert.throws(() => signRecord({ v: 1, profile: aliceBuyer.address, path: 'profile', time: T0, body: profileBody('x') }, alice.privateKey), /not the signer/)
    assert.throws(() => signRecord({ v: 1, profile: alice.address, path: 'profile', time: T0, body: profileBody('x'), by: accessKey.address }, alice.privateKey), /not the signer/)
  })

  test('shape rules: unknown fields, paths, control records, access keys', () => {
    const base = { v: 1 as const, profile: alice.address, path: 'profile', time: T0, body: profileBody('A') }
    const code = (c: string) => (err: RecordError) => err.code === c
    assert.throws(() => signRecord({ ...base, extra: 1 } as never, alice.privateKey), code('shape'))
    assert.throws(() => signRecord({ ...base, grant: 'a'.repeat(64) } as never, alice.privateKey), code('shape'), 'grants are gone')
    assert.throws(() => signRecord({ ...base, v: 2 } as never, alice.privateKey), code('version'))
    assert.throws(() => signRecord({ ...base, path: 'Offer/x' }, alice.privateKey), code('path'))
    assert.throws(() => signRecord({ ...base, path: 'offer/../x' }, alice.privateKey), code('path'))
    assert.throws(() => signRecord({ ...base, path: 'a/b/c/d/e' }, alice.privateKey), code('path'))
    assert.throws(() => signRecord({ ...base, path: 'hosts/x' }, alice.privateKey), code('path'))
    assert.throws(() => signRecord({ ...base, time: -1 }, alice.privateKey), code('time'))
    assert.throws(() => signRecord({ ...base, body: [] as never }, alice.privateKey), code('body'))
    assert.throws(() => signRecord({ ...base, by: alice.address }, alice.privateKey), code('shape'), 'the owner signs without by')
    assert.throws(() => accessRecord(accessKey, alice.address, 'permissions', { access: [] }, T0), code('control'), 'only the owner writes control records')
    assert.throws(() => accessRecord(accessKey, alice.address, 'hosts', null, T0), code('control'))
  })

  test('hosts and permissions bodies are exact: a field nobody knows refuses the record', () => {
    const hosts = (body: unknown) => () => ownerRecord(alice, 'hosts', body as never, T0)
    assert.throws(hosts({ urls: [] }), /1 to 8/)
    assert.throws(hosts({ urls: ['http://example.com'] }), /origin/)
    assert.throws(hosts({ urls: ['https://a.example/path'] }), /origin/)
    assert.throws(hosts({ urls: ['https://a.example', 'https://a.example'] }), /repeat/)
    assert.throws(hosts({ urls: ['https://a.example'], keep: 30 }), /unknown hosts field keep/)
    assert.ok(checkRecord(ownerRecord(alice, 'hosts', { urls: ['https://a.example', 'http://127.0.0.1:8080'] }, T0)))

    const perms = (access: unknown[]) => () => permissionsRecord(alice, access as never, T0)
    const readKey = KEYS.mainKeys[1].inbox.recipient as string // any age1pq1 recipient: a read key's public half
    assert.throws(perms([{ ...allow(accessKey, ['offer']), pay: 5 }]), /unknown access field pay/)
    assert.throws(perms([{ ...allow(accessKey, ['offer']), until: T0 }]), /unknown access field until/, 'no dates')
    assert.throws(perms([allow(accessKey, ['hosts'])]), /content path/)
    assert.throws(perms([allow(accessKey, ['permissions'])]), /content path/)
    assert.throws(perms([{ key: `did:key:z${accessKey.address}`, scope: 'write', paths: ['offer'] }]), /usable/)
    assert.throws(perms([{ key: accessKey.address, paths: ['offer'] }]), /scope is one of/)
    assert.throws(perms([{ key: accessKey.address, scope: 'admin' }]), /scope is one of/)
    assert.throws(perms([{ key: accessKey.address, scope: 'message', paths: ['offer'] }]), /a message key has no paths/)
    assert.ok(checkRecord(permissionsRecord(alice, [{ key: accessKey.address, scope: 'message' }], T0)), 'message')
    assert.throws(perms([{ key: accessKey.address, scope: 'pay' }]), /scope is one of write, message, read;/, 'there is no pay scope')
    assert.throws(perms([{ key: accessKey.address, scope: 'read' }]), /read key is an age/, 'a read key is an age recipient')
    assert.throws(perms([{ key: readKey, scope: 'write' }]), /usable/, 'every other key is an address')
    assert.throws(perms([{ key: accessKey.address, scope: 'past' }]), /scope is one of/, 'a past key has was, not a scope')
    for (const was of ['read', 'pay', 'past']) assert.throws(perms([{ key: accessKey.address, was }]), /a past key has was, write or message/, `was ${was}`)
    assert.throws(perms([{ key: accessKey.address, scope: 'write', was: 'write' }]), /a past key has was/, 'one or the other')
    assert.throws(perms([{ key: readKey, was: 'write' }]), /usable/, 'only write and message keys are past')
    assert.throws(perms([{ key: accessKey.address, was: 'message', paths: ['offer'] }]), /a message key has no paths/, 'a past message key had none')
    assert.ok(checkRecord(permissionsRecord(alice, [{ key: readKey, scope: 'read', paths: ['note'] }], T0)), 'a read key may list paths')
    assert.ok(checkRecord(permissionsRecord(alice, [allow(accessKey), pastKey(messageKey, 'write', ['offer']), pastKey(stranger, 'message')], T0)), 'paths are optional')
    assert.throws(perms([allow(accessKey), pastKey(accessKey, 'write', ['offer'])]), /listed twice/, 'one key, one entry')
    assert.throws(perms([{ key: readKey, scope: 'read' }, { key: readKey, scope: 'read', paths: ['note'] }]), /listed twice/)
    const many = Array.from({ length: 100 }, (_, i) => ({ key: keyFromPrivate(new Uint8Array(32).fill(i + 1)).address, was: 'write' as const }))
    assert.ok(checkRecord(permissionsRecord(alice, many, T0)), 'no cap on how many keys it lists')
    assert.throws(() => ownerRecord(alice, 'permissions', { access: [], more: 1 }, T0), /unknown permissions field/)
    assert.ok(checkRecord(permissionsRecord(alice, [allow(accessKey)], T0, 'YWdlLWVuY3J5cHRpb24')), 'notes: an envelope in base64url')
    for (const notes of ['', 'not base64url!', 5, { private: 'abc' }]) assert.throws(() => ownerRecord(alice, 'permissions', { access: [], notes }, T0), /notes is an envelope/, JSON.stringify(notes))
    assert.ok(checkRecord(permissionsRecord(alice, [allow(accessKey, ['offer', 'review'])], T0)))
    assert.ok(checkRecord(permissionsRecord(alice, null, T0)), 'a delete removes every access key')
  })

  test('no size is a rule: how large a record to take is each host’s policy (host.test.ts), and each reader’s', () => {
    const big = ownerRecord(alice, 'profile', { about: 'x'.repeat(200_000) }, T0)
    assert.ok(decodeRecord(encodeRecord(big)).id)
    assert.ok(checkRecord(sizedRecord(alice, 'note/a', 100_000, 1)).id)
  })
})

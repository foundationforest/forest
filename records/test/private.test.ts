// Private records: a body only chosen keys open (read keys, and the owner's inbox key), whoever
// writes it: the owner, or an access key the permissions record allows. Hosts check and store them
// like any record, and read none. And the grants record, a private record a person keeps.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import { publish, readAll, readProfile } from '../src/client.ts'
import { DAY } from '../src/host.ts'
import { readingKey } from '../../keys/src/index.ts'
import { b64u } from '../src/bytes.ts'
import { GRANTS_PATH, type Grant, checkGrant } from '../src/grant.ts'
import { keyFromPrivate } from '../src/keys.ts'
import { grantsRecord, isPrivate, makePrivate, message, openGrants, openMessage, openPrivate, readerCount } from '../src/private.ts'
import { accessRecord, hostsRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { canonical } from '../src/canonical.ts'
import { MAX_RECORD_BYTES, RecordError, decodeRecord, encodeRecord } from '../src/record.ts'
import { KEYS, MINUTE, T0, accessKey, alice, aliceBuyer, allow, bob, messageKey, profileBody } from './fixtures.ts'
import { startHost } from './helpers.ts'

const [aliceInbox, aliceBuyerInbox, bobInbox] = await Promise.all([readingKey(alice.privateKey), readingKey(aliceBuyer.privateKey), readingKey(bob.privateKey)])
const strangerInbox = await readingKey(new Uint8Array(32).fill(3))
/** A read key Alice's app made for Bob. */
const readKeyForBob = await readingKey(new Uint8Array(32).fill(9))

describe('keys an envelope is sealed to', () => {
  test("keys/'s inbox key, one per profile: age's post-quantum hybrid, the pinned one", async () => {
    assert.equal(aliceInbox.identity, KEYS.mainKeys[0].reading.identity)
    assert.equal(aliceInbox.recipient, KEYS.mainKeys[0].reading.recipient)
    assert.notEqual(aliceInbox.recipient, aliceBuyerInbox.recipient)
    assert.match(aliceInbox.recipient, /^age1pq1[02-9ac-hj-np-z]{1952}$/)
    assert.match(aliceInbox.identity, /^AGE-SECRET-KEY-PQ-1[02-9AC-HJ-NP-Z]+$/)
  })

  test('an envelope is made only for hybrid keys', async () => {
    const x25519 = 'age1stfaf43jlmcuwa5z5e69td3djjluwqvv9afe0nydnv2myuczqgmq9vd6u4' // a valid age X25519 recipient
    await assert.rejects(makePrivate({ text: 'x' }, []), /at least one/)
    await assert.rejects(makePrivate({ text: 'x' }, [x25519]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, [aliceInbox.recipient, x25519]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, [alice.address]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, ['age1pq1' + 'q'.repeat(60)]), /checksum/)
  })
})

describe('private records', () => {
  test('the owner makes a read key for a reader and hands it over: that reader opens the envelope; the host, a stranger, the owner’s other profile and the reader’s own key cannot', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      // Alice's app makes a read key for Bob and hands him its private half: Bob needs no profile and no key of his own.
      const forBob = await readingKey(randomBytes(32))
      const secret = { text: 'My phone is +00 555 0100; call after six.', createdAt: '2026-10-02T12:00:00Z' }
      await publish([host.url], [hostsRecord(alice, [host.url], T0), ownerRecord(alice, 'note/1', await makePrivate(secret, [forBob.recipient, aliceInbox.recipient]), T0)])

      // What the host holds: no plaintext, no read key.
      assert.ok(!host.dump().join('\n').includes('555 0100'))
      assert.ok(!host.dump().join('\n').includes(forBob.recipient))
      const onHost = (await readProfile([host.url], alice.address, T0)).current.get('note/1')!.record.body!
      assert.ok(isPrivate(onHost))

      assert.deepEqual(await openPrivate(onHost, forBob.identity), secret)
      assert.deepEqual(await openPrivate(onHost, aliceInbox.identity), secret)
      await assert.rejects(openPrivate(onHost, bobInbox.identity), 'Bob’s own inbox key is not one it was sealed to')
      await assert.rejects(openPrivate(onHost, aliceBuyerInbox.identity))
      await assert.rejects(openPrivate(onHost, strangerInbox.identity))
      // A made key that leaks opens only what the owner who made it sealed to it.
      const fromOther = await readingKey(randomBytes(32))
      await assert.rejects(openPrivate(await makePrivate(secret, [fromOther.recipient]), forBob.identity))
      // What anyone can see: that it exists, its size, and how many keys it was sealed to.
      assert.equal(readerCount(onHost as { private: string }), 2)
    } finally {
      await host.close()
    }
  })

  test('an access key writes a private record where the permissions record allows it; the host checks that, and reads nothing', async () => {
    const host = await startHost({ now: () => T0 + MINUTE })
    try {
      await publish([host.url], [permissionsRecord(alice, [allow(accessKey, ['note'])], T0)])
      // The access key's app holds no read key's private half: it seals to the public halves it was given.
      const forBob = await readingKey(randomBytes(32))
      const note = { text: 'The keys are under the mat.', createdAt: '2026-10-02T12:01:00Z' }
      const readers = [aliceInbox.recipient, forBob.recipient]
      const inside = accessRecord(accessKey, alice.address, 'note/door', await makePrivate(note, readers), T0 + MINUTE)
      const outside = accessRecord(accessKey, alice.address, 'offer/door', await makePrivate(note, readers), T0 + MINUTE)
      const [outcome] = await publish([host.url], [inside, outside])
      assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok', 'permission'], 'private or not, the permissions record is checked')

      const onHost = host.view(alice.address).current.get('note/door')!
      assert.equal(onHost.record.by, accessKey.address)
      assert.deepEqual(await openPrivate(onHost.record.body!, aliceInbox.identity), note)
      assert.deepEqual(await openPrivate(onHost.record.body!, forBob.identity), note)
      assert.ok(!host.dump().join('\n').includes('under the mat'))
    } finally {
      await host.close()
    }
  })

  test('a reader is removed in the next version: they cannot open it; the old one stays on hosts until keep days pass', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      const v1 = ownerRecord(alice, 'note/door', await makePrivate({ text: 'first' }, [bobInbox.recipient, aliceInbox.recipient]), T0 + 1)
      const v2 = ownerRecord(alice, 'note/door', await makePrivate({ text: 'second' }, [aliceInbox.recipient]), T0 + 2)
      await publish([host.url], [v1, v2])

      const current = host.view(alice.address).current.get('note/door')!.record.body as { private: string }
      assert.equal(readerCount(current), 1)
      assert.deepEqual(await openPrivate(current, aliceInbox.identity), { text: 'second' })
      await assert.rejects(openPrivate(current, bobInbox.identity), 'Bob cannot open the new version')

      // Removal reaches what comes next, not what a reader already had: the old version is still
      // on the host for its keep days, and Bob can open it there.
      const notes = async () => (await readAll(host.url, { profile: alice.address })).records.filter((c) => c.record.path === 'note/door')
      const old = (await notes()).find((c) => c.record.time === T0 + 1)!
      assert.deepEqual(await openPrivate(old.record.body!, bobInbox.identity), { text: 'first' })
      await host.prune(T0 + 31 * DAY)
      assert.deepEqual((await notes()).map((c) => c.record.time), [T0 + 2])
    } finally {
      await host.close()
    }
  })

  test('an envelope’s stanzas say mlkem768x25519, to anyone', async () => {
    const body = await makePrivate({ text: 'x' }, [aliceInbox.recipient])
    const header = Buffer.from(body.private, 'base64url').toString('latin1').split('\n---')[0]!
    assert.match(header, /^age-encryption\.org\/v1\n-> mlkem768x25519 /)
  })

  test('each key adds about 2 KB, so a private record is made for about 30 at most', async () => {
    const readers = await Promise.all(Array.from({ length: 32 }, (_, i) => readingKey(new Uint8Array(32).fill(i + 1))))
    const size = async (n: number) => canonical({ ...ownerRecord(alice, 'note/many', null, T0), body: await makePrivate({ text: 'x' }, readers.slice(0, n).map((r) => r.recipient)) }).length
    const [one, two] = [await size(1), await size(2)]
    assert.ok(two - one > 2000 && two - one < 2200, `${two - one} bytes a reader`)
    assert.ok((await size(30)) <= MAX_RECORD_BYTES)
    await assert.rejects(async () => ownerRecord(alice, 'note/many', await makePrivate({ text: 'x' }, readers.map((r) => r.recipient)), T0), /at most/)
  })
})

describe('grants', () => {
  const write: Grant = { key: b64u.encode(accessKey.privateKey), folder: alice.address, scope: 'write', paths: ['offer'], from: alice.address, since: T0, note: 'Bob’s calendar app, for the Tuesday lessons' }
  const read: Grant = { key: readKeyForBob.identity, folder: alice.address, scope: 'read', from: alice.address, since: T0 }
  const sends: Grant = { key: b64u.encode(messageKey.privateKey), folder: alice.address, scope: 'message', from: alice.address, since: T0 + 1 }
  const bobCard = { ...profileBody('Bob'), role: 'buyer', inboxKey: bobInbox.recipient, inbox: { senders: 'anyone' } }
  const code = (c: string) => (err: unknown) => err instanceof RecordError && err.code === c
  const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

  test('a grant is a key’s private half and what it is for; anything else is refused', () => {
    for (const g of [write, read, sends]) checkGrant(g)
    assert.equal(keyFromPrivate(b64u.decode(write.key)).address, accessKey.address, 'the holder gets the key back')
    const bad: Array<[string, unknown]> = [
      ['revoked is not a grant’s scope', { ...sends, scope: 'revoked' }],
      ['no dates beyond since', { ...write, until: T0 }],
      ['a read key is an age identity', { ...read, key: write.key }],
      ['any other key is 32 bytes in base64url', { ...write, key: readKeyForBob.identity }],
      ['31 bytes', { ...write, key: b64u.encode(accessKey.privateKey.subarray(1)) }],
      ['one spelling: the same bytes with a padding bit set', { ...write, key: write.key.slice(0, 42) + B64U[B64U.indexOf(write.key[42]!) ^ 1] }],
      ['a message key has no paths', { ...sends, paths: ['offer'] }],
      ['paths are content prefixes', { ...write, paths: ['hosts'] }],
      ['folder', { ...write, folder: 'x' }],
      ['from', { ...write, from: undefined }],
      ['since', { ...write, since: -1 }],
      ['note is text', { ...write, note: 7 }],
    ]
    for (const [why, g] of bad) assert.throws(() => checkGrant(g), code('grant'), why)
  })

  test('a grant reaches its holder as a message body { grant }, sealed like any message', async () => {
    const m = await message(alice, bob.address, { grant: write }, T0, bobCard)
    const opened = await openMessage(m, bobInbox.identity)
    checkGrant(opened.body.grant)
    assert.deepEqual(opened.body, { grant: write })
  })

  test('a person keeps the grants they received at grants, sealed to their own inbox key alone; a host holds none of them', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      const record = await grantsRecord(bob, bobInbox.recipient, [write, read, sends], T0)
      assert.equal(record.path, GRANTS_PATH)
      assert.equal(readerCount(record.body as { private: string }), 1)
      await publish([host.url], [record])
      // Lose the phone: the record on the host gives every grant back, to the inbox key alone.
      const kept = decodeRecord(encodeRecord((await readProfile([host.url], bob.address, T0)).current.get('grants')!.record)).record.body!
      assert.deepEqual(await openGrants(kept, bobInbox.identity), [write, read, sends])
      await assert.rejects(openGrants(kept, aliceInbox.identity))
      const disk = host.dump().join('\n')
      for (const secret of [write.key, read.key, sends.key, 'Tuesday']) assert.ok(!disk.includes(secret), secret)

      await assert.rejects(grantsRecord(bob, bobInbox.recipient, [{ ...write, scope: 'admin' } as never], T0), code('grant'))
      const other = ownerRecord(bob, GRANTS_PATH, await makePrivate({ grants: [], more: 1 }, [bobInbox.recipient]), T0)
      await assert.rejects(openGrants(other.body!, bobInbox.identity), code('grant'))
    } finally {
      await host.close()
    }
  })
})

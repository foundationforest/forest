// Private records: a body only chosen reading keys open, whoever writes it: the owner, or a writer
// key the permissions record allows. Hosts check and store them like any record, and read none.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { publish, readAll, readProfile } from '../src/client.ts'
import { DAY } from '../src/host.ts'
import { readingKey } from '../../keys/src/index.ts'
import { isPrivate, makePrivate, openPrivate, readerCount } from '../src/private.ts'
import { hostsRecord, ownerRecord, permissionsRecord, writerRecord } from '../src/write.ts'
import { canonical } from '../src/canonical.ts'
import { MAX_RECORD_BYTES } from '../src/record.ts'
import { KEYS, MINUTE, T0, alice, aliceBuyer, allow, bob, profileBody, writer } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

const [aliceRead, aliceBuyerRead, bobRead] = await Promise.all([readingKey(alice.privateKey), readingKey(aliceBuyer.privateKey), readingKey(bob.privateKey)])
const strangerRead = await readingKey(new Uint8Array(32).fill(3))

describe('reading keys', () => {
  test("keys/'s reading key, one per profile: age's post-quantum hybrid, the pinned one", async () => {
    assert.equal(aliceRead.identity, KEYS.profiles[0].reading.identity)
    assert.equal(aliceRead.recipient, KEYS.profiles[0].reading.recipient)
    assert.notEqual(aliceRead.recipient, aliceBuyerRead.recipient)
    assert.match(aliceRead.recipient, /^age1pq1[02-9ac-hj-np-z]{1952}$/)
    assert.match(aliceRead.identity, /^AGE-SECRET-KEY-PQ-1[02-9AC-HJ-NP-Z]+$/)
  })

  test('an envelope is made only for hybrid reading keys', async () => {
    const x25519 = 'age1stfaf43jlmcuwa5z5e69td3djjluwqvv9afe0nydnv2myuczqgmq9vd6u4' // a valid age X25519 recipient
    await assert.rejects(makePrivate({ text: 'x' }, []), /at least one/)
    await assert.rejects(makePrivate({ text: 'x' }, [x25519]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, [aliceRead.recipient, x25519]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, [alice.address]), /hybrid recipient/)
    await assert.rejects(makePrivate({ text: 'x' }, ['age1pq1' + 'q'.repeat(60)]), /checksum/)
  })
})

describe('private records', () => {
  test('a reader finds a reading key in a profile record; that reader opens the envelope; the host, a stranger and the owner’s other profile cannot', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now })
    try {
      await publish([host.url], [hostsRecord(bob, [host.url], T0), ownerRecord(bob, 'profile', { ...profileBody('Bob'), role: 'buyer', read: bobRead.recipient }, T0)])

      // Alice reads Bob's reading key from his signed profile record.
      const bobsCard = (await readProfile([host.url], bob.address, clock.t)).current.get('profile')!.record.body as { read: string }
      const secret = { text: 'My phone is +00 555 0100; call after six.', createdAt: '2026-10-02T12:00:00Z' }
      const body = await makePrivate(secret, [bobsCard.read, aliceRead.recipient])
      clock.advance(MINUTE)
      await publish([host.url], [hostsRecord(alice, [host.url], T0), ownerRecord(alice, 'note/1', body, clock.t)])

      // What the host holds: no plaintext, no reader named.
      assert.ok(!host.dump().join('\n').includes('555 0100'))
      const onHost = (await readProfile([host.url], alice.address, clock.t)).current.get('note/1')!.record.body!
      assert.ok(isPrivate(onHost))
      assert.ok(!JSON.stringify(onHost).includes(bob.address))

      assert.deepEqual(await openPrivate(onHost, bobRead.identity), secret)
      assert.deepEqual(await openPrivate(onHost, aliceRead.identity), secret)
      await assert.rejects(openPrivate(onHost, aliceBuyerRead.identity))
      await assert.rejects(openPrivate(onHost, strangerRead.identity))
      // What anyone can see: that it exists, its size, and how many reading keys it was made for.
      assert.equal(readerCount(onHost as { private: string }), 2)
    } finally {
      await host.close()
    }
  })

  test('a writer key writes a private record where the permissions record allows it; the host checks that, and reads nothing', async () => {
    const host = await startHost({ now: () => T0 + MINUTE })
    try {
      await publish([host.url], [permissionsRecord(alice, [allow(writer, ['note'], T0 + DAY)], T0)])
      // The writer holds no reading key of anyone's: it makes the envelope for the two that profile records publish.
      const note = { text: 'The keys are under the mat.', createdAt: '2026-10-02T12:01:00Z' }
      const readers = [aliceRead.recipient, bobRead.recipient]
      const inside = writerRecord(writer, alice.address, 'note/door', await makePrivate(note, readers), T0 + MINUTE)
      const outside = writerRecord(writer, alice.address, 'offer/door', await makePrivate(note, readers), T0 + MINUTE)
      const [outcome] = await publish([host.url], [inside, outside])
      assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok', 'permission'], 'private or not, the permissions record is checked')

      const onHost = host.view(alice.address).current.get('note/door')!
      assert.equal(onHost.record.by, writer.address)
      assert.deepEqual(await openPrivate(onHost.record.body!, aliceRead.identity), note)
      assert.deepEqual(await openPrivate(onHost.record.body!, bobRead.identity), note)
      assert.ok(!host.dump().join('\n').includes('under the mat'))
    } finally {
      await host.close()
    }
  })

  test('a reader is removed in the next version: they cannot open it; the old one stays on hosts until keep days pass', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      const v1 = ownerRecord(alice, 'note/door', await makePrivate({ text: 'first' }, [bobRead.recipient, aliceRead.recipient]), T0 + 1)
      const v2 = ownerRecord(alice, 'note/door', await makePrivate({ text: 'second' }, [aliceRead.recipient]), T0 + 2)
      await publish([host.url], [v1, v2])

      const current = host.view(alice.address).current.get('note/door')!.record.body as { private: string }
      assert.equal(readerCount(current), 1)
      assert.deepEqual(await openPrivate(current, aliceRead.identity), { text: 'second' })
      await assert.rejects(openPrivate(current, bobRead.identity), 'Bob cannot open the new version')

      // Removal reaches what comes next, not what a reader already had: the old version is still
      // on the host for its keep days, and Bob can open it there.
      const notes = async () => (await readAll(host.url, { profile: alice.address })).records.filter((c) => c.record.path === 'note/door')
      const old = (await notes()).find((c) => c.record.time === T0 + 1)!
      assert.deepEqual(await openPrivate(old.record.body!, bobRead.identity), { text: 'first' })
      host.prune(T0 + 31 * DAY)
      assert.deepEqual((await notes()).map((c) => c.record.time), [T0 + 2])
    } finally {
      await host.close()
    }
  })

  test('an envelope’s stanzas say mlkem768x25519, to anyone', async () => {
    const body = await makePrivate({ text: 'x' }, [aliceRead.recipient])
    const header = Buffer.from(body.private, 'base64url').toString('latin1').split('\n---')[0]!
    assert.match(header, /^age-encryption\.org\/v1\n-> mlkem768x25519 /)
  })

  test('each reading key adds about 2 KB, so a private record is made for about 30 at most', async () => {
    const readers = await Promise.all(Array.from({ length: 32 }, (_, i) => readingKey(new Uint8Array(32).fill(i + 1))))
    const size = async (n: number) => canonical({ ...ownerRecord(alice, 'note/many', null, T0), body: await makePrivate({ text: 'x' }, readers.slice(0, n).map((r) => r.recipient)) }).length
    const [one, two] = [await size(1), await size(2)]
    assert.ok(two - one > 2000 && two - one < 2200, `${two - one} bytes a reader`)
    assert.ok((await size(30)) <= MAX_RECORD_BYTES)
    await assert.rejects(async () => ownerRecord(alice, 'note/many', await makePrivate({ text: 'x' }, readers.map((r) => r.recipient)), T0), /at most/)
  })
})

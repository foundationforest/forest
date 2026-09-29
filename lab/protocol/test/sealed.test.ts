// Sealed entries, from day one: a body only its chosen readers can open, whoever writes it: the
// owner, or another key under a grant. Hosts check and store them like any entry, and read none.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { publish, readAll } from '../src/client.ts'
import type { Entry, FolderBody } from '../src/entry.ts'
import { DAY, type Host } from '../src/host.ts'
import { boxKey, isSealed, open, readerCount, seal } from '../src/sealed.ts'
import { viewProfile } from '../src/view.ts'
import { delegateEntry, folderEntry, grantEntry, ownerEntry } from '../src/write.ts'
import { MINUTE, OTHER_SEED, SEED, T0, alice, bob, signer } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

/** A profile's current version at a path, as its host shows it. */
async function currentAt(host: Host, profile: string, path: string, now: number) {
  return viewProfile(profile, [(await readAll(host.url, { profile })).versions], now).current.get(path)
}
/** A profile's signed folder, read from a host and checked. */
async function folderOf(host: Host, profile: string, now: number) {
  return viewProfile(profile, [(await readAll(host.url, { profile })).versions], now).folder as FolderBody
}

describe('sealed entries', () => {
  test('one chosen reader opens it; the host, a stranger and the owner’s other profile cannot', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now })
    try {
      const aliceBox = await boxKey(SEED, 0)
      const aliceOtherBox = await boxKey(SEED, 1) // the same person's other profile
      const bobBox = await boxKey(OTHER_SEED, 0)
      await publish([host.url], [folderEntry(alice, { hosts: [host.url], box: aliceBox.recipient }, T0), folderEntry(bob, { hosts: [host.url], box: bobBox.recipient }, T0)])

      // Alice finds Bob's box in Bob's signed folder, read from the host and checked.
      const secret = { text: 'My phone is +00 555 0100; call after six.', createdAt: '2026-09-29T12:00:00Z' }
      const sealed = await seal(secret, [(await folderOf(host, bob.did, clock.t)).box!, aliceBox.recipient])
      clock.advance(MINUTE)
      await publish([host.url], [ownerEntry(alice, 'note/1', sealed, clock.t)])

      // What the host holds: no plaintext, no reader named.
      const disk = host.dump().join('\n')
      assert.ok(!disk.includes('555 0100'))
      const onHost = (await currentAt(host, alice.did, 'note/1', clock.t))!
      assert.ok(isSealed(onHost.entry.body))
      assert.ok(!JSON.stringify(onHost.entry).includes(bob.did))

      // Bob opens it; Alice opens it; a stranger and Alice's other profile cannot.
      assert.deepEqual(await open(onHost.entry.body!, bobBox.identity), secret)
      assert.deepEqual(await open(onHost.entry.body!, aliceBox.identity), secret)
      await assert.rejects(open(onHost.entry.body!, aliceOtherBox.identity))
      await assert.rejects(open(onHost.entry.body!, (await boxKey(new Uint8Array(32).fill(3), 0)).identity))

      // What anyone can see: that it exists, its size, and how many readers it has.
      assert.equal(readerCount(onHost.entry.body as { sealed: string }), 2)
    } finally {
      await host.close()
    }
  })

  test('another key writes a sealed note into the profile under a grant: the owner and one chosen reader open it; the host checks the grant and reads nothing', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now })
    try {
      const aliceBox = await boxKey(SEED, 0)
      const bobBox = await boxKey(OTHER_SEED, 0)
      const { entry: grant, grantId } = grantEntry(alice, 'notes', { to: signer.did, paths: ['note'], until: T0 + 7 * DAY, label: 'My signer, notes' }, T0)
      await publish([host.url], [folderEntry(alice, { hosts: [host.url], box: aliceBox.recipient }, T0), grant, folderEntry(bob, { hosts: [host.url], box: bobBox.recipient }, T0)])

      // The signer holds no box key of anyone's: it seals to the two boxes the signed folders name.
      clock.advance(MINUTE)
      const readers = [(await folderOf(host, alice.did, clock.t)).box!, (await folderOf(host, bob.did, clock.t)).box!]
      const note = { text: 'The keys are under the mat.', createdAt: '2026-09-29T12:01:00Z' }
      const written = delegateEntry(signer, alice.did, grantId, 'note/door', await seal(note, readers), clock.t)
      const outside = delegateEntry(signer, alice.did, grantId, 'offer/sealed', await seal(note, readers), clock.t)
      const [outcome] = await publish([host.url], [written, outside])
      assert.deepEqual(outcome!.results.map((r) => r.message ?? 'ok'), ['ok', 'out-of-scope'], 'sealed or not, the grant is checked')

      const onHost = (await currentAt(host, alice.did, 'note/door', clock.t))!
      assert.equal(onHost.entry.by, signer.did)
      assert.deepEqual(await open(onHost.entry.body!, aliceBox.identity), note)
      assert.deepEqual(await open(onHost.entry.body!, bobBox.identity), note)
      await assert.rejects(open(onHost.entry.body!, (await boxKey(new Uint8Array(32).fill(3), 0)).identity))
      assert.ok(!host.dump().join('\n').includes('under the mat'))
    } finally {
      await host.close()
    }
  })

  test('a reader is removed on the next version: they cannot open it; the old version stays on hosts until keep days pass', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now })
    try {
      const aliceBox = await boxKey(SEED, 0)
      const bobBox = await boxKey(OTHER_SEED, 0)
      const { entry: grant, grantId } = grantEntry(alice, 'notes', { to: signer.did, paths: ['note'], until: T0 + 7 * DAY }, T0)
      await publish([host.url], [folderEntry(alice, { hosts: [host.url], box: aliceBox.recipient }, T0), grant])
      const v1: Entry = delegateEntry(signer, alice.did, grantId, 'note/door', await seal({ text: 'first' }, [bobBox.recipient, aliceBox.recipient]), T0 + 1)
      const v2: Entry = delegateEntry(signer, alice.did, grantId, 'note/door', await seal({ text: 'second' }, [aliceBox.recipient]), T0 + 2)
      await publish([host.url], [v1, v2])

      const current = (await currentAt(host, alice.did, 'note/door', clock.t))!
      assert.equal(readerCount(current.entry.body as { sealed: string }), 1)
      assert.deepEqual(await open(current.entry.body!, aliceBox.identity), { text: 'second' })
      await assert.rejects(open(current.entry.body!, bobBox.identity), 'Bob cannot open the new version')

      // Removal reaches what comes next, not what a reader already had: the old version is still
      // on the host for keep days, and Bob can open it there.
      const notes = async () => (await readAll(host.url, { profile: alice.did })).versions.filter((v) => v.entry.path === 'note/door')
      const old = (await notes()).find((v) => v.entry.time === T0 + 1)!
      assert.deepEqual(await open(old.entry.body!, bobBox.identity), { text: 'first' })
      host.prune(clock.t + 31 * DAY)
      assert.deepEqual((await notes()).map((v) => v.entry.time), [T0 + 2])
    } finally {
      await host.close()
    }
  })

  test('a sealed body is post-quantum by default: its stanza says so, to anyone', async () => {
    const aliceBox = await boxKey(SEED, 0)
    const sealed = await seal({ text: 'x' }, [aliceBox.recipient])
    const header = Buffer.from(sealed.sealed as string, 'base64url').toString('latin1').split('\n---')[0]!
    assert.match(header, /^age-encryption\.org\/v1\n-> mlkem768x25519 /)
  })
})

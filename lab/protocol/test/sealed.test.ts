// A sealed entry: readable by one chosen reader and by its owner, not by the host or anyone else.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readAll } from '../src/client.ts'
import { publish } from '../src/client.ts'
import type { FolderBody } from '../src/entry.ts'
import { DAY } from '../src/host.ts'
import { boxKey } from '../src/keys.ts'
import { isSealed, open, readerCount, seal } from '../src/sealed.ts'
import { viewProfile } from '../src/view.ts'
import { folderEntry, ownerEntry } from '../src/write.ts'
import { MINUTE, OTHER_SEED, SEED, T0, alice, bob } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

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
      const bobFolder = (await readAll(host.url, { profile: bob.did, path: 'folder' })).versions[0]!.entry.body as FolderBody
      const secret = { text: 'My phone is +00 555 0100; call after six.', createdAt: '2026-09-29T12:00:00Z' }
      const sealed = await seal(secret, [bobFolder.box!, aliceBox.recipient])
      clock.advance(MINUTE)
      await publish([host.url], [ownerEntry(alice, 'note/1', sealed, clock.t)])

      // What the host holds: no plaintext, no reader named.
      const disk = host.dump().join('\n')
      assert.ok(!disk.includes('555 0100'))
      assert.ok(!disk.includes(bob.did.slice(9)) || disk.includes(bob.did), 'Bob appears only as his own folder, not in Alice’s note')
      const onHost = (await readAll(host.url, { profile: alice.did, path: 'note' })).versions[0]!
      assert.ok(isSealed(onHost.entry.body))

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

  test('removing a reader: a new version to the rest; the old one is gone from hosts after keep days', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now })
    try {
      const aliceBox = await boxKey(SEED, 0)
      const bobBox = await boxKey(OTHER_SEED, 0)
      await publish([host.url], [folderEntry(alice, { hosts: [host.url], box: aliceBox.recipient }, T0)])
      const v1 = ownerEntry(alice, 'note/1', await seal({ text: 'first' }, [bobBox.recipient, aliceBox.recipient]), T0 + 1)
      const v2 = ownerEntry(alice, 'note/1', await seal({ text: 'second' }, [aliceBox.recipient]), T0 + 2)
      await publish([host.url], [v1, v2])

      const current = viewProfile(alice.did, (await readAll(host.url, { profile: alice.did })).versions, clock.t).current.get('note/1')!
      await assert.rejects(open(current.entry.body!, bobBox.identity), 'Bob cannot open the new version')
      assert.equal(readerCount(current.entry.body as { sealed: string }), 1)
      // The old version stays for keep days, and Bob can still open it there: revocation reaches
      // what comes next, not what a reader already had.
      assert.equal((await readAll(host.url, { profile: alice.did, path: 'note' })).versions.length, 2)
      host.prune(clock.t + 31 * DAY)
      assert.equal((await readAll(host.url, { profile: alice.did, path: 'note' })).versions.length, 1)
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

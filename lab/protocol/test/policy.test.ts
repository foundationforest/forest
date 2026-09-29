// Keys are free, and the protocol sets no budget. A host sets its own policy from what the
// protocol gives it: the signature on every entry (which key wrote what) and the public registry
// (which keys hold a badge). The policy below is one host's example, not the protocol's.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { publish } from '../src/client.ts'
import type { Policy } from '../src/host.ts'
import { keyFromSecret } from '../src/keys.ts'
import { folderEntry, ownerEntry } from '../src/write.ts'
import { MINUTE, T0, alice, bob, offerBody, profileBody } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

const freshKey = (i: number) => keyFromSecret(new Uint8Array(32).map((_, j) => (i * 31 + j * 7 + 1) & 255))

/** One host's choice: 20 new profiles without a badge an hour, 5 entries each; badged keys unlimited. */
function examplePolicy(now: () => number): Policy {
  let hour = -1
  let fresh = 0
  return (_entry, { badged, newProfile, stored }) => {
    if (badged) return null
    if (newProfile) {
      if (Math.floor(now() / 3_600_000) !== hour) {
        hour = Math.floor(now() / 3_600_000)
        fresh = 0
      }
      return fresh++ < 20 ? null : 'new profiles without a badge wait an hour here'
    }
    return stored.entries < 5 ? null : 'five entries for a profile without a badge here'
  }
}

describe('host policy', () => {
  test('the protocol sets no budget: a host with no policy of its own takes 200 fresh keys', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      let taken = 0
      for (let i = 0; i < 200; i++) {
        const k = freshKey(i)
        const [outcome] = await publish([host.url], [folderEntry(k, { hosts: [host.url] }, T0), ownerEntry(k, 'profile', profileBody(`bot ${i}`), T0)])
        if (outcome!.results.every((r) => r.ok)) taken++
      }
      assert.equal(taken, 200)
    } finally {
      await host.close()
    }
  })

  test('one host’s own policy, from signatures and the registry alone: in a flood, new profiles without a badge wait; badged keys and profiles it holds carry on', async () => {
    const clock = new Clock(T0)
    const host = await startHost({ now: clock.now, isBadged: (did) => did === bob.did, policy: examplePolicy(clock.now) })
    try {
      await publish([host.url], [folderEntry(alice, { hosts: [host.url] }, T0), ownerEntry(alice, 'profile', profileBody('Alice'), T0)])
      let admitted = 0
      for (let i = 0; i < 100; i++) {
        const k = freshKey(1000 + i)
        const [outcome] = await publish([host.url], [folderEntry(k, { hosts: [host.url] }, T0), ownerEntry(k, 'profile', profileBody(`bot ${i}`), T0)])
        if (outcome!.results[0]!.ok) admitted++
        else assert.deepEqual(outcome!.results.map((r) => r.error), ['policy', 'not-held'])
      }
      assert.equal(admitted, 19, 'Alice took the first of this hour’s 20')

      // During the flood: a profile it holds writes; a badged key is not held back.
      assert.equal((await publish([host.url], [ownerEntry(alice, 'offer/a', offerBody('30'), T0 + 1)]))[0]!.results[0]!.ok, true)
      assert.equal((await publish([host.url], [folderEntry(bob, { hosts: [host.url] }, T0)]))[0]!.results[0]!.ok, true)
      // Next hour, new keys are taken again.
      clock.advance(61 * MINUTE)
      assert.equal((await publish([host.url], [folderEntry(freshKey(5000), { hosts: [host.url] }, clock.t)]))[0]!.results[0]!.ok, true)

      // Alice without a badge: five entries here, her folder included. The sixth is refused, but a
      // newer folder always passes, so she can always leave.
      const more = ['b', 'c', 'd'].map((id) => ownerEntry(alice, `offer/${id}`, offerBody('1'), clock.t))
      const [full] = await publish([host.url], more)
      assert.deepEqual(full!.results.map((r) => r.error ?? 'ok'), ['ok', 'ok', 'policy'])
      assert.equal((await publish([host.url], [folderEntry(alice, { hosts: [host.url, 'https://elsewhere.example'] }, clock.t)]))[0]!.results[0]!.ok, true)
    } finally {
      await host.close()
    }
  })
})

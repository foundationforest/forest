// Keys are free. What an unbadged key gets by default, and what a flood of fresh keys gets.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { publish } from '../src/client.ts'
import { encodeEntry } from '../src/entry.ts'
import { keyFromSecret } from '../src/keys.ts'
import { folderEntry, ownerEntry } from '../src/write.ts'
import { MINUTE, T0, alice, bob, offerBody, profileBody } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

const freshKey = (i: number) => keyFromSecret(new Uint8Array(32).map((_, j) => (i * 31 + j * 7 + 1) & 255))

describe('spam', () => {
  test('a flood of fresh keys: the host admits its hourly budget, refuses the rest with 429, and existing profiles keep writing', async () => {
    const clock = new Clock(T0)
    const host = await startHost({
      now: clock.now,
      isBadged: (did) => did === bob.did,
      limits: { newProfilesPerHour: 20, newProfilesPerAddressPerHour: 1_000 },
    })
    try {
      await publish([host.url], [folderEntry(alice, { hosts: [host.url] }, T0), ownerEntry(alice, 'profile', profileBody('Alice'), T0)])

      let admitted = 0
      let refused = 0
      let statuses = new Set<number>()
      for (let i = 0; i < 100; i++) {
        const k = freshKey(i)
        const [outcome] = await publish([host.url], [folderEntry(k, { hosts: [host.url] }, T0), ownerEntry(k, 'profile', profileBody(`bot ${i}`), T0)])
        statuses.add(outcome!.status)
        if (outcome!.results[0]!.ok) admitted++
        else {
          assert.equal(outcome!.results[0]!.error, 'busy')
          assert.equal(outcome!.results[1]!.error, 'not-held')
          refused++
        }
      }
      assert.equal(admitted, 19, 'Alice, unbadged, took the first of the 20 slots this hour')
      assert.equal(refused, 81)
      assert.ok(statuses.has(429))

      // During the flood, a profile the host already holds writes as usual.
      const mine = await publish([host.url], [ownerEntry(alice, 'offer/a', offerBody('30'), T0 + 1)])
      assert.equal(mine[0]!.results[0]!.ok, true)
      // A badged key is not held back by the new-profile budget.
      const badged = await publish([host.url], [folderEntry(bob, { hosts: [host.url] }, T0)])
      assert.equal(badged[0]!.results[0]!.ok, true)
      // Next hour, new keys are admitted again.
      clock.advance(61 * MINUTE)
      const later = await publish([host.url], [folderEntry(freshKey(500), { hosts: [host.url] }, clock.t)])
      assert.equal(later[0]!.results[0]!.ok, true)
      statuses = new Set()
    } finally {
      await host.close()
    }
  })

  test('one address gets a few new profiles an hour, counted in memory under a keyed hash', async () => {
    const host = await startHost({ now: () => T0, limits: { newProfilesPerAddressPerHour: 3 } })
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => host.accept([encodeEntry(folderEntry(freshKey(1000 + i), { hosts: [host.url] }, T0))], '203.0.113.7')),
      )
      assert.deepEqual(results.map((r) => r[0]!.error ?? 'ok'), ['ok', 'ok', 'ok', 'busy', 'busy'])
      const other = await host.accept([encodeEntry(folderEntry(freshKey(2000), { hosts: [host.url] }, T0))], '198.51.100.9')
      assert.equal(other[0]!.ok, true)
    } finally {
      await host.close()
    }
  })

  test('an unbadged key gets a small quota; a badged key a large one; writes per minute are capped', async () => {
    const clock = new Clock(T0)
    const host = await startHost({
      now: clock.now,
      isBadged: (did) => did === bob.did,
      limits: { unbadged: { entries: 5, bytes: 256 * 1024, writesPerMinute: 30 }, badged: { entries: 50, bytes: 1 << 20, writesPerMinute: 10 } },
    })
    try {
      const k = freshKey(3000)
      const first = [folderEntry(k, { hosts: [host.url] }, T0), ...Array.from({ length: 6 }, (_, i) => ownerEntry(k, `offer/${i}`, offerBody('1'), T0 + i))]
      const [outcome] = await publish([host.url], first)
      assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok', 'ok', 'ok', 'ok', 'ok', 'quota', 'quota'])

      await publish([host.url], [folderEntry(bob, { hosts: [host.url] }, T0)])
      const burst = Array.from({ length: 12 }, (_, i) => ownerEntry(bob, `offer/${i}`, offerBody('1'), T0 + i))
      const [b] = await publish([host.url], burst)
      assert.equal(b!.results.filter((r) => r.ok).length, 10, 'badged: ten writes a minute here')
      assert.equal(b!.results.filter((r) => r.error === 'rate').length, 2)
      assert.equal(b!.status, 429)
    } finally {
      await host.close()
    }
  })
})

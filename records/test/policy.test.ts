// Keys are free, and the protocol sets no budget. A host may refuse content records by its own
// policy, from the record and what it already stores. It is never asked about a hosts or
// permissions record, so a person can always move and always remove a writer key. The policy below
// is one host's example, not the protocol's.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { publish } from '../src/client.ts'
import type { Policy } from '../src/host.ts'
import { keyFromSecret } from '../src/keys.ts'
import { hostsRecord, ownerRecord, permissionsRecord, writerRecord } from '../src/write.ts'
import { DAY, T0, alice, allow, offerBody, profileBody, writer } from './fixtures.ts'
import { startHost } from './helpers.ts'

const freshKey = (i: number) => keyFromSecret(new Uint8Array(32).map((_, j) => (i * 31 + j * 7 + 1) & 255))

/** One host's choice: at most three content records a profile. */
const threeEach: Policy = (_record, stored) => (stored.records < 3 ? null : 'three records a profile here')

describe('host policy', () => {
  test('the protocol sets no budget: a host with no policy of its own takes 200 fresh keys', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      let taken = 0
      for (let i = 0; i < 200; i++) {
        const k = freshKey(i)
        const [outcome] = await publish([host.url], [ownerRecord(k, 'profile', profileBody(`bot ${i}`), T0)])
        if (outcome!.results.every((r) => r.ok)) taken++
      }
      assert.equal(taken, 200)
    } finally {
      await host.close()
    }
  })

  test('a host’s own policy refuses content; a newer hosts or permissions record always passes', async () => {
    const host = await startHost({ now: () => T0, policy: threeEach })
    try {
      const results = async (records: Parameters<typeof publish>[1]) => (await publish([host.url], records))[0]!.results.map((r) => r.error ?? 'ok')
      assert.deepEqual(await results([ownerRecord(alice, 'profile', profileBody('A'), T0), ownerRecord(alice, 'offer/a', offerBody('1'), T0), ownerRecord(alice, 'offer/b', offerBody('1'), T0)]), ['ok', 'ok', 'ok'])
      assert.deepEqual(await results([ownerRecord(alice, 'offer/c', offerBody('1'), T0)]), ['policy'])
      // A writer key went bad and floods: the person can always remove it, and always move.
      assert.deepEqual(await results([permissionsRecord(alice, [allow(writer, ['offer'], T0 + DAY)], T0)]), ['ok'])
      assert.deepEqual(await results([writerRecord(writer, alice.address, 'offer/w', offerBody('1'), T0)]), ['policy'])
      assert.deepEqual(await results([permissionsRecord(alice, [], T0 + 1), hostsRecord(alice, ['https://elsewhere.example'], T0)]), ['ok', 'ok'])
    } finally {
      await host.close()
    }
  })
})

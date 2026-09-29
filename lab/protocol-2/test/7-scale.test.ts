// Claim 7. It scales to billions of people and records. What a test can show: nothing per write
// grows with the number of profiles or with a profile's length, and nothing is shared between
// profiles, so hosts and indexes shard by profile with no coordination. The arithmetic to billions
// is in the report, marked believed.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDirs, nowSeconds, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { profileKeys } from '../src/keys.ts'
import { signEntry, applyEntry, emptyState } from '../src/entry.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'

test('claim 7 (measured small): the cost of a write does not grow with profiles on the host or entries in the log', async () => {
  const a = await startHost('a')
  started.push(a)
  const profiles = 200
  const perProfile = 5
  const writers: Writer[] = []
  for (let i = 0; i < profiles; i++) {
    const seed = new Uint8Array(32)
    seed[0] = i & 255
    seed[1] = i >> 8
    seed[2] = 7
    const p = await profileKeys(seed, 0)
    writers.push(new Writer({ did: p.did, signer: p.signer, hosts: [a.url] }))
  }
  const times: number[] = []
  for (let round = 0; round < perProfile; round++) {
    for (const w of writers) {
      const t0 = performance.now()
      await w.put(POST, `p${round}`, { $type: POST, direction: 'offer', description: `round ${round}`, createdAt: 'x' })
      times.push(performance.now() - t0)
    }
  }
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const first = avg(times.slice(0, 100))
  const last = avg(times.slice(-100))
  console.log(`  ${profiles} profiles x ${perProfile} entries: first 100 writes ${first.toFixed(2)} ms each, last 100 ${last.toFixed(2)} ms each`)
  assert.ok(last < first * 3, `the last writes (${last.toFixed(2)} ms) cost more than 3x the first (${first.toFixed(2)} ms)`)

  // One long log: appending entry 1,000 costs what appending entry 10 cost, in the verifier alone.
  const seed = new Uint8Array(32).fill(42)
  const p = await profileKeys(seed, 0)
  let state = emptyState(p.did)
  let prev = null as ReturnType<typeof signEntry>['cid'] | null
  const cost: number[] = []
  for (let seq = 0; seq < 1000; seq++) {
    const t0 = performance.now()
    const e = signEntry(p.signer, { v: 1, did: p.did, seq, prev, at: nowSeconds(), op: 'put', col: POST, key: `k${seq}`, rec: { description: 'x' } })
    state = applyEntry(state, e.entry, e.cid)
    prev = e.cid
    cost.push(performance.now() - t0)
  }
  const early = avg(cost.slice(10, 110))
  const late = avg(cost.slice(-100))
  console.log(`  one log of 1,000 entries: sign+verify+apply ${early.toFixed(3)} ms early, ${late.toFixed(3)} ms late`)
  assert.ok(late < early * 3)

  // The index takes all 1,000 profile-entries in one pass and holds one state per profile.
  const index = new Index([])
  index.follow(a.url)
  const t0 = performance.now()
  const taken = await index.tick()
  console.log(`  index took ${taken} entries in ${(performance.now() - t0).toFixed(0)} ms`)
  assert.equal(taken, profiles * perProfile)
  assert.equal(index.states.size, profiles)
  const head = await new HostClient(a.url).head(writers[0]!.did)
  assert.equal(head!.seq, perProfile - 1)
})

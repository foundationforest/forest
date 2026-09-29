// A host cannot fork a log, and a writer who signs two histories is caught by any index that sees both.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDirs, nowSeconds, person, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, HostClientError } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { MemoryDht, signPointer } from '../src/pointer.ts'
import { signEntry } from '../src/entry.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'

test('a host takes one entry per seq and nothing else; a writer who signs two is flagged as forked', async () => {
  const a = await startHost('a')
  const b = await startHost('b')
  started.push(a, b)
  const ana = await person(1)
  const e0 = signEntry(ana.signer, { v: 1, did: ana.did, seq: 0, prev: null, at: nowSeconds(), op: 'keys', rec: { reader: ana.reader.did } })
  const left = signEntry(ana.signer, { v: 1, did: ana.did, seq: 1, prev: e0.cid, at: nowSeconds(), op: 'put', col: POST, key: 'p', rec: { description: 'left' } })
  const right = signEntry(ana.signer, { v: 1, did: ana.did, seq: 1, prev: e0.cid, at: nowSeconds(), op: 'put', col: POST, key: 'p', rec: { description: 'right' } })
  const ha = new HostClient(a.url)
  const hb = new HostClient(b.url)
  await ha.append(e0.bytes)
  await hb.append(e0.bytes)
  await ha.append(left.bytes)
  await hb.append(right.bytes)
  // Each host refuses the other branch: one entry per seq, first come.
  await assert.rejects(ha.append(right.bytes), (e: unknown) => e instanceof HostClientError && e.status === 409)
  await assert.rejects(hb.append(left.bytes), (e: unknown) => e instanceof HostClientError && e.status === 409)
  // An index that follows both sees the fork and says so.
  const dht = new MemoryDht()
  dht.put(ana.did, signPointer(ana.signer, [a.url, b.url]).payload)
  const index = new Index([dht])
  index.follow(a.url)
  index.follow(b.url)
  await index.tick()
  assert.ok(index.forks.has(ana.did))
  assert.equal(index.faults.filter((f) => f.code === 'fork').length, 1)
  assert.equal(index.state(ana.did)!.head!.seq, 1, 'it keeps the branch it saw first, and reports')
})

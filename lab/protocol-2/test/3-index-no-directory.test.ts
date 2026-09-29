// Claim 3. Anyone can read public records and build an index, with no central directory.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDirs, dht, nowSeconds, person, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { MemoryDht, resolvePointer, signPointer, verifyPointer } from '../src/pointer.ts'
import { CID } from '../src/codec.ts'
import { signEntry } from '../src/entry.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'
const REVIEW = 'foundation.forest.review'
const PROFILE = 'foundation.forest.profile'

async function twoPeople(local: MemoryDht) {
  const a = await startHost('a')
  const b = await startHost('b')
  started.push(a, b)
  const ana = await person(1)
  const bob = await person(2)
  const wa = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await wa.keys(ana.reader.did)
  await wa.put(PROFILE, 'self', { $type: PROFILE, name: 'Ana', market: 'online-tutors', role: 'seller', createdAt: 'x' })
  await wa.put(POST, 'p1', { $type: POST, direction: 'offer', description: 'Portuguese lessons', createdAt: 'x' })
  const wb = new Writer({ did: bob.did, signer: bob.signer, hosts: [b.url] })
  await wb.keys(bob.reader.did)
  await wb.put(REVIEW, 'r1', { $type: REVIEW, subject: ana.did, ratings: { overall: '9' }, createdAt: 'x' })
  const pa = signPointer(ana.signer, [a.url], 1)
  const pb = signPointer(bob.signer, [b.url], 1)
  local.put(ana.did, pa.payload)
  local.put(bob.did, pb.payload)
  return { a, b, ana, bob, pa, pb }
}

test('claim 3: an index told one host finds a profile on another through a reference and a signed pointer, with no directory', async () => {
  const local = new MemoryDht()
  const { b, ana, bob } = await twoPeople(local)
  const index = new Index([local])
  index.follow(b.url)
  await index.tick()
  assert.ok(index.state(bob.did), 'bob, on the host it was told about')
  assert.ok(index.state(ana.did), 'ana, found from bob\'s review')
  assert.equal(index.hosts.size, 2, 'it now follows ana\'s host too')
  assert.deepEqual(index.search(POST).map((p) => p.did), [ana.did])
  assert.equal(index.faults.length, 0)
})

test('claim 3: hosts serve pointers too, so an index with no DHT at all still finds a referenced profile', async () => {
  const local = new MemoryDht()
  const { b, ana, pa } = await twoPeople(local)
  await new HostClient(b.url).pointerPut(ana.did, pa.payload) // bob's app, or ana's, left ana's pointer at bob's host
  const index = new Index([]) // no DHT, no relay, nothing configured but one host
  index.follow(b.url)
  await index.tick()
  assert.ok(index.state(ana.did))
  assert.deepEqual(index.record(ana.did, PROFILE, 'self'), { $type: PROFILE, name: 'Ana', market: 'online-tutors', role: 'seller', createdAt: 'x' })
})

test('claim 3: two independent indexes reach the same state, and one can seed another', async () => {
  const local = new MemoryDht()
  const { a, b, ana, bob } = await twoPeople(local)
  const one = new Index([local])
  one.follow(a.url)
  one.follow(b.url)
  await one.tick()
  const two = new Index([one.pointerSource]) // asks the first index for pointers, nothing else
  two.follow(b.url)
  await two.tick()
  for (const did of [ana.did, bob.did]) {
    assert.equal(two.state(did)!.head!.cid.toString(), one.state(did)!.head!.cid.toString())
    assert.deepEqual([...two.state(did)!.records.entries()], [...one.state(did)!.records.entries()])
  }
})

test('claim 3: an index believes no host: a bad entry served to it is a fault, not a record', async () => {
  const local = new MemoryDht()
  const { a, ana } = await twoPeople(local)
  const mallory = await person(9)
  const head = (await new HostClient(a.url).head(ana.did))!
  const forged = signEntry(mallory.signer, { v: 1, did: ana.did, seq: head.seq + 1, prev: CID.parse(head.cid), at: nowSeconds(), op: 'put', col: POST, key: 'p9', rec: { description: 'planted by the host' } })
  a.host.db.prepare('INSERT INTO entries (did, seq, cid, bytes) VALUES (?, ?, ?, ?)').run(ana.did, forged.entry.seq, forged.cid.toString(), forged.bytes)
  const index = new Index([local])
  index.follow(a.url)
  await index.tick()
  assert.equal(index.state(ana.did)!.head!.seq, head.seq)
  assert.equal(index.record(ana.did, POST, 'p9'), undefined)
  assert.equal(index.faults.length, 1)
  assert.equal(index.faults[0]!.code, 'signature')
})

test('claim 3: pointer resolution keeps the newest valid pointer and ignores forged or stale ones', async () => {
  const ana = await person(1)
  const mallory = await person(9)
  const stale = signPointer(ana.signer, ['http://old.example'], 1).payload
  const fresh = signPointer(ana.signer, ['http://new.example'], 2).payload
  // A forgery: Mallory signs a pointer for Ana's DID.
  const forgedPointer = signPointer(mallory.signer, ['http://evil.example'], 99).payload
  assert.throws(() => verifyPointer(ana.did, forgedPointer))
  // A replayed old payload with its sequence bumped by hand fails the signature.
  const bumped = new Uint8Array(stale)
  bumped[71] = 9
  assert.throws(() => verifyPointer(ana.did, bumped))
  const found = await resolvePointer(ana.did, [{ get: () => forgedPointer }, { get: () => fresh }, { get: () => stale }, { get: () => bumped }, { get: () => { throw new Error('down') } }])
  assert.deepEqual(found!.pointer.hosts, ['http://new.example'])
})

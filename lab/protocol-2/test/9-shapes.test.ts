// The four record shapes are unchanged: the example records in `shapes/examples/` validate against
// the lexicons in `shapes/lexicons/` with the AT Protocol lexicon library, travel through the new
// log byte for byte, and a photo travels as a blob the record points at by content id.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Lexicons, jsonToLex, parseLexiconDoc } from '@atproto/lexicon'
import { cleanDirs, nowSeconds, person, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, HostClientError, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { blobCid } from '../src/codec.ts'
import { delegateKeys } from '../src/keys.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const shapesDir = new URL('../../../shapes/', import.meta.url)
const SHAPES = ['profile', 'post', 'review', 'credential'] as const

function loadLexicons(): Lexicons {
  const lex = new Lexicons()
  for (const s of SHAPES) {
    const doc = JSON.parse(readFileSync(new URL(`lexicons/foundation/forest/${s}.json`, shapesDir), 'utf8'))
    lex.add(parseLexiconDoc(doc))
  }
  return lex
}

test('the four example records validate, round-trip unchanged, and index as they are', async () => {
  const a = await startHost('a')
  started.push(a)
  const lex = loadLexicons()
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const host = new HostClient(a.url)
  for (const s of SHAPES) {
    const record = JSON.parse(readFileSync(new URL(`examples/${s}.json`, shapesDir), 'utf8')) as Record<string, unknown>
    lex.assertValidRecord(`foundation.forest.${s}`, jsonToLex(record))
    const key = s === 'profile' ? 'self' : `k-${s}`
    await w.put(`foundation.forest.${s}`, key, record)
    const back = await host.record(ana.did, `foundation.forest.${s}`, key)
    assert.deepEqual(back!.rec, record, `${s} came back changed`)
  }
  const index = new Index([])
  index.follow(a.url)
  await index.tick()
  assert.equal(index.search('foundation.forest.review').length, 1)
  assert.equal(index.faults.length, 0)
})

test('a photo travels as a blob: the record points at its content id and the host serves the bytes', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const cid = await w.putBlob(photo, 'image/jpeg')
  assert.equal(cid, blobCid(photo).toString())
  await w.put('foundation.forest.profile', 'self', { $type: 'foundation.forest.profile', name: 'Ana', market: 'online-tutors', role: 'seller', photo: { $type: 'blob', ref: { $link: cid }, mimeType: 'image/jpeg', size: photo.length }, createdAt: 'x' })
  const served = await new HostClient(a.url).blob(ana.did, cid)
  assert.equal(served!.mime, 'image/jpeg')
  assert.deepEqual(served!.bytes, photo)

  // Uploads need a permit: none, a stranger's, or a delegate's without a live grant are refused.
  const host = new HostClient(a.url)
  await assert.rejects(host.putBlob(ana.did, photo, 'image/jpeg', new Uint8Array(10)), (e: unknown) => e instanceof HostClientError)
  const stranger = await person(9)
  const sw = new Writer({ did: ana.did, signer: stranger.signer, via: (await w.put('foundation.forest.post', 'p', { description: 'x' })).cid, hosts: [a.url] })
  await assert.rejects(sw.putBlob(photo, 'image/jpeg'), (e: unknown) => e instanceof HostClientError && e.code === 'permit')
  const agent = delegateKeys()
  const g = await w.grant({ to: agent.signer.did, cols: ['foundation.forest.post'], ops: ['put'], exp: nowSeconds() + 3600 })
  const aw = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [a.url] })
  const other = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])
  assert.equal(await aw.putBlob(other, 'image/png'), blobCid(other).toString(), 'a delegate with put may upload')
  await w.revoke(g.cid)
  await assert.rejects(aw.putBlob(new Uint8Array([1, 2, 3]), 'image/png'), (e: unknown) => e instanceof HostClientError && e.code === 'permit')
})

// Claim 5. Private records later (contacts, calendar, health, an AI's memory of you) on the same
// design. Shown now: the same log, the same signatures, the same sync, with the record encrypted on
// the device and readable only by the keys it was addressed to.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanDirs, dht, nowSeconds, person, seedOf, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { delegateKeys, profileKeys, readerFromPrivateKey } from '../src/keys.ts'
import { openRecord } from '../src/private.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const CONTACTS = 'forest.contacts'

test('claim 5: a private record travels the same log; the host and the public see only ciphertext, size and an opaque key', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const secret = { name: 'Dr. Mendes', phone: '+351 900 000 000', note: 'allergic to penicillin' }
  const { key } = await w.putPrivate({ col: CONTACTS, key: 'mendes', rec: secret }, [ana.reader.did])
  const host = new HostClient(a.url)
  const disk = Buffer.concat(readdirSync(a.dir).map((f) => readFileSync(join(a.dir, f))))
  const publicText = JSON.stringify([await host.log(ana.did), await host.state(ana.did), await host.privates(ana.did)])
  for (const word of ['Mendes', '351 900', 'penicillin', CONTACTS, 'mendes']) {
    assert.equal(disk.includes(Buffer.from(word)), false, `${word} on the host's disk`)
    assert.equal(publicText.includes(word), false, `${word} in what the host serves`)
  }
  const listed = await host.privates(ana.did)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.key, key)
  assert.equal(listed[0]!.enc.to.length, 1)
  assert.equal(listed[0]!.enc.to[0]!.kid, ana.reader.did)
})

test('claim 5: the owner reads it on any device from the seed; a stranger cannot; a changed byte cannot', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const { key } = await w.putPrivate({ col: CONTACTS, key: 'mendes', rec: { name: 'Dr. Mendes' } }, [ana.reader.did])
  const stored = (await new HostClient(a.url).privates(ana.did))[0]!

  // A second device: only the seed, nothing else, derives the same reader.
  const secondDevice = await profileKeys(seedOf(1), 0)
  assert.deepEqual(await openRecord(ana.did, key, stored.enc, secondDevice.reader), { col: CONTACTS, key: 'mendes', rec: { name: 'Dr. Mendes' } })

  const stranger = await person(9)
  await assert.rejects(openRecord(ana.did, key, stored.enc, stranger.reader), /not addressed/)
  const otherReader = readerFromPrivateKey(new Uint8Array(32).fill(3))
  await assert.rejects(openRecord(ana.did, key, { ...stored.enc, to: [{ ...stored.enc.to[0]!, kid: otherReader.did }] }, otherReader), 'the wrong key cannot unwrap')
  const damaged = { ...stored.enc, ct: new Uint8Array(stored.enc.ct) }
  damaged.ct[0] ^= 0x01
  await assert.rejects(openRecord(ana.did, key, damaged, ana.reader), 'a changed byte does not open')
  await assert.rejects(openRecord(ana.did, 'another-key', stored.enc, ana.reader), 'bound to its own entry')
})

test('claim 5: an AI keeps its memory of the person as private records that it and the person can read, and nobody else', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, reader: agent.reader.did, cols: [], ops: ['put', 'del'], private: true, exp: nowSeconds() + 86_400 })
  const aw = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [a.url] })

  // The agent remembers something, addressed to itself and to the person.
  const memory = { learned: 'Ana prefers morning lessons and dislikes small talk', on: '2026-09-29' }
  const { key } = await aw.putPrivate({ col: 'forest.memory', key: 'lessons', rec: memory }, [agent.reader.did, ana.reader.did])

  // After a restart, the agent has only its own private key: it reads its memory back.
  const restarted = readerFromPrivateKey(agent.reader.privateKey)
  const stored = (await new HostClient(a.url).privates(ana.did)).find((p) => p.key === key)!
  assert.deepEqual((await openRecord(ana.did, key, stored.enc, restarted)).rec, memory)
  // The person reads what the AI remembers about them.
  assert.deepEqual((await openRecord(ana.did, key, stored.enc, ana.reader)).rec, memory)
  // Another agent of the same person cannot.
  const other = delegateKeys()
  await assert.rejects(openRecord(ana.did, key, stored.enc, other.reader))

  // The person updates it (same opaque key), now addressed to themselves only: the agent is cut out of the new version.
  await w.putPrivate({ col: 'forest.memory', key: 'lessons', rec: { learned: 'corrected by Ana' } }, [ana.reader.did], key)
  const after = (await new HostClient(a.url).privates(ana.did)).find((p) => p.key === key)!
  await assert.rejects(openRecord(ana.did, key, after.enc, restarted))
  assert.deepEqual((await openRecord(ana.did, key, after.enc, ana.reader)).rec, { learned: 'corrected by Ana' })
})

test('claim 5: private records move hosts and pass through indexes unopened, on the same path as public ones', async () => {
  const a = await startHost('a')
  const b = await startHost('b')
  started.push(a, b)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  await w.put('foundation.forest.post', 'p', { description: 'public' })
  const { key } = await w.putPrivate({ col: 'forest.health', key: 'h', rec: { bloodType: 'O-' } }, [ana.reader.did])
  await w.delPrivate(key)
  const { key: key2 } = await w.putPrivate({ col: 'forest.health', key: 'h2', rec: { bloodType: 'O-' } }, [ana.reader.did])
  const index = new Index([dht])
  index.follow(a.url)
  await index.tick()
  const s = index.state(ana.did)!
  assert.equal(s.privates.size, 1, 'one private record after a put, a delete and a put')
  assert.ok(s.privates.has(key2))
  assert.equal(JSON.stringify([...s.privates.values()]).includes('O-'), false)
  await new HostClient(b.url).pull(ana.did, a.url)
  const moved = (await new HostClient(b.url).privates(ana.did)).find((p) => p.key === key2)!
  assert.deepEqual((await openRecord(ana.did, key2, moved.enc, ana.reader)).rec, { bloodType: 'O-' })
})

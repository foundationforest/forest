// Claim 6. Nothing public links one person's profiles.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanDirs, nowSeconds, person, seedOf, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { delegateKeys, profileKeys } from '../src/keys.ts'
import { MemoryDht, signPointer } from '../src/pointer.ts'
import { toJson } from '../src/codec.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'
const PROFILE = 'foundation.forest.profile'

// Every token 16 characters or longer that could be an identifier: keys, DIDs, CIDs, hashes.
function tokens(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z0-9_-]{16,}/g) ?? [])
}

test('claim 6: two profiles of one person, on different hosts and on the same host, share no public token', async () => {
  const a = await startHost('a')
  const b = await startHost('b')
  started.push(a, b)
  const seed = seedOf(1)
  const p0 = await profileKeys(seed, 0) // a seller in one market
  const p1 = await profileKeys(seed, 1) // a buyer in another
  const dht = new MemoryDht()
  const operator = { zero: delegateKeys(), one: delegateKeys() } // one AI service, one key per profile

  async function publish(p: typeof p0, hosts: string[], agent: ReturnType<typeof delegateKeys>, market: string, role: string) {
    const w = new Writer({ did: p.did, signer: p.signer, hosts })
    await w.keys(p.reader.did)
    await w.put(PROFILE, 'self', { $type: PROFILE, name: 'A person', market, role, wallet: p.wallet.address, createdAt: 'x' })
    await w.put(POST, 'p', { $type: POST, direction: role === 'seller' ? 'offer' : 'request', description: 'something', createdAt: 'x' })
    const g = await w.grant({ to: agent.signer.did, reader: agent.reader.did, cols: [POST], ops: ['put'], private: true, exp: nowSeconds() + 3600 })
    const aw = new Writer({ did: p.did, signer: agent.signer, via: g.cid, hosts })
    await aw.put(POST, 'by-agent', { $type: POST, direction: 'offer', description: 'by the assistant', createdAt: 'x' })
    await aw.putPrivate({ col: 'forest.memory', key: 'm', rec: { note: 'remembered' } }, [agent.reader.did, p.reader.did])
    dht.put(p.did, signPointer(p.signer, hosts, 1).payload)
  }
  await publish(p0, [a.url], operator.zero, 'plumbing', 'seller')
  await publish(p1, [b.url, a.url], operator.one, 'tutoring', 'buyer') // profile 1 also mirrors on host a

  // Everything public about each profile, from every place it can be read.
  async function everything(p: typeof p0): Promise<string> {
    const parts: unknown[] = []
    for (const url of [a.url, b.url]) {
      const h = new HostClient(url)
      try {
        parts.push(await h.log(p.did), await h.state(p.did), await h.privates(p.did), toJson(await h.pointerGet(p.did)))
      } catch {
        // not on this host
      }
    }
    parts.push(toJson(dht.get(p.did)))
    return JSON.stringify(parts)
  }
  const public0 = await everything(p0)
  const public1 = await everything(p1)
  const shared = [...tokens(public0)].filter((t) => tokens(public1).has(t))
  // Only protocol constants may appear on both sides: collection names, the scheme name, field names.
  const constants = new Set(['foundation.forest.profile', 'foundation.forest.post', 'application', 'HKDF-SHA256', 'HPKE(X25519,HKDF-SHA256,A256GCM)', 'A256GCM+HPKE(X25519', 'A256GCM+HPKE'])
  const leaks = shared.filter((t) => !constants.has(t) && !t.startsWith('foundation.forest') && !t.startsWith('A256GCM'))
  assert.deepEqual(leaks, [], `tokens present in both profiles' public data: ${leaks.join(', ')}`)

  // The obvious ones, by name.
  for (const [name, value] of [['DID', p1.did], ['reader', p1.reader.did], ['wallet', p1.wallet.address], ['agent', operator.one.signer.did]]) {
    assert.equal(public0.includes(value!), false, `profile 1's ${name} appears in profile 0's public data`)
  }

  // An index that knows both cannot pair them either: it has nothing but the same public data.
  const index = new Index([dht])
  index.follow(a.url)
  index.follow(b.url)
  await index.tick()
  assert.equal(index.states.size, 2)
  const seen = JSON.stringify([...index.states.entries()].map(([did, s]) => [did, toJson([...s.records.values()]), [...s.grants.values()]]))
  assert.equal(seen.includes(seedOf(1).toString()), false)
})

test('claim 6: the keys of two profiles are unrelated outputs of one seed; neither DID hints at the other', async () => {
  const seed = seedOf(1)
  const p0 = await profileKeys(seed, 0)
  const p1 = await profileKeys(seed, 1)
  assert.notEqual(p0.did, p1.did)
  assert.notEqual(p0.reader.did, p1.reader.did)
  assert.notEqual(p0.wallet.address, p1.wallet.address)
  // The same seed gives the same profile again (determinism is what makes "any device" work).
  assert.equal((await profileKeys(seed, 1)).did, p1.did)
  // A different seed never lands on the same DID.
  assert.notEqual((await person(2, 0)).did, p0.did)
})

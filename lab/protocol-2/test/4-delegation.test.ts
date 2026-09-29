// Claim 4. AI assistants can act for a person within limits the person sets, including while the
// person's phone is off, without ever holding the person's keys, and the person can take that power
// back at any time.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDirs, dht, nowSeconds, person, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, HostClientError, Writer } from '../src/client.ts'
import { Index } from '../src/index.ts'
import { delegateKeys, signerFromPrivateKey } from '../src/keys.ts'
import { CID } from '../src/codec.ts'
import { decodeEntry } from '../src/entry.ts'
import { ed25519 } from '@noble/curves/ed25519.js'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'
const REVIEW = 'foundation.forest.review'

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (e: unknown) => e instanceof HostClientError && e.code === code, `expected refusal ${code}`)
}

test('claim 4: an agent with its own key writes while the phone is off, and never had the person\'s key', async () => {
  const a = await startHost('a')
  started.push(a)

  // On the phone: the person makes the grant. The agent's key was made on the agent's server;
  // only its public DID travels to the phone.
  const agentPrivateKey = ed25519.utils.randomSecretKey()
  const agentDid = signerFromPrivateKey(agentPrivateKey).did
  let phone: { did: string; signer: { did: string } } | null = await person(1)
  const w = new Writer({ did: phone.did, signer: (phone as Awaited<ReturnType<typeof person>>).signer, hosts: [a.url] })
  await w.keys((phone as Awaited<ReturnType<typeof person>>).reader.did)
  const g = await w.grant({ to: agentDid, cols: [POST, REVIEW], ops: ['put'], exp: nowSeconds() + 86_400, max: 100, note: 'my assistant, for a day' })
  const did = phone.did

  // The phone is off. Nothing that derives from the seed exists in this scope any more.
  phone = null

  // On the agent's server, from three things only: the profile's DID, the grant's CID, its own key.
  const agent = new Writer({ did, signer: signerFromPrivateKey(agentPrivateKey), via: g.cid, hosts: [a.url] })
  const written = await agent.put(POST, 'offer-1', { $type: POST, direction: 'offer', description: 'Two evening slots opened by my assistant', createdAt: 'x' })
  const entry = decodeEntry(written.bytes).entry
  assert.equal(entry.by, agentDid, 'the entry says who wrote it')
  assert.equal(entry.via!.toString(), g.cid.toString(), 'and under which grant')

  // Any reader sees the record, and sees it was the agent under that grant.
  const index = new Index([dht])
  index.follow(a.url)
  await index.tick()
  assert.equal(index.record(did, POST, 'offer-1')!.description, 'Two evening slots opened by my assistant')
  assert.equal(index.state(did)!.grants.get(g.cid.toString())!.used, 1)
})

test('claim 4: the limits hold: collection, operation, count, private records, and expiry', async () => {
  let clock = 1_800_000_000
  const a = await startHost('a', () => clock)
  started.push(a)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url], now: () => clock })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, cols: [POST], ops: ['put'], exp: clock + 100, max: 2 })
  const aw = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [a.url], now: () => clock })

  await refused(aw.put(REVIEW, 'r', { subject: ana.did }), 'scope') // collection
  await refused(aw.del(POST, 'x'), 'scope') // operation
  await refused(aw.putPrivate({ col: 'x', key: 'y', rec: {} }, [ana.reader.did]), 'scope') // private
  await aw.put(POST, 'p1', { description: '1' })
  await aw.put(POST, 'p2', { description: '2' })
  await refused(aw.put(POST, 'p3', { description: '3' }), 'limit') // count

  clock += 101 // the grant expired
  const w2 = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url], now: () => clock })
  const g2 = await w2.grant({ to: agent.signer.did, cols: [POST], ops: ['put'], exp: clock - 1 })
  const aw2 = new Writer({ did: ana.did, signer: agent.signer, via: g2.cid, hosts: [a.url], now: () => clock })
  await refused(aw2.put(POST, 'p4', { description: 'late' }), 'expired')
})

test('claim 4: the person takes the power back at any time; what was written before stays', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, cols: ['*'], ops: ['put', 'del'], exp: nowSeconds() + 86_400 })
  const aw = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [a.url] })
  await aw.put(POST, 'before', { description: 'written before the revocation' })
  await w.revoke(g.cid)
  await refused(aw.put(POST, 'after', { description: 'too late' }), 'revoked')
  await refused(aw.del(POST, 'before'), 'revoked')
  const host = new HostClient(a.url)
  assert.ok(await host.record(ana.did, POST, 'before'), 'the earlier record stands')
  assert.equal(await host.record(ana.did, POST, 'after'), null)
  const state = await host.state(ana.did)
  assert.equal((state.grants as { revokedAt: number | null }[])[0]!.revokedAt, 3)
})

test('claim 4: expiry is a clock rule an honest host enforces; revocation is a chain rule nobody can dodge', async () => {
  // A host whose clock stands still (or that colludes with the agent) accepts an entry dated inside
  // the grant's life after it has really expired: no reader can tell the time an entry was made.
  const frozen = 1_800_000_000
  const dishonest = await startHost('dishonest', () => frozen)
  started.push(dishonest)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [dishonest.url], now: () => frozen })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, cols: [POST], ops: ['put'], exp: frozen + 10 })
  const backdating = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [dishonest.url], now: () => frozen + 5 })
  await backdating.put(POST, 'p1', { description: 'dated inside the grant, sent long after' })
  const index = new Index([dht])
  index.follow(dishonest.url)
  await index.tick()
  assert.ok(index.record(ana.did, POST, 'p1'), 'the index has no clock to check against: it takes it')

  // The revocation is an entry in the chain. After it, no host, honest or not, can append under the grant.
  await w.revoke(g.cid)
  await refused(backdating.put(POST, 'p2', { description: 'still dated inside the grant' }), 'revoked')
  const bytesOfAll = (await new HostClient(dishonest.url).log(ana.did)).entries
  const { verifyLog } = await import('../src/entry.ts')
  assert.equal(verifyLog(ana.did, bytesOfAll).grants.get(g.cid.toString())!.revokedAt, 3)
})

test('claim 4: a grant is public and precise: anyone can read what an agent may do', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, reader: agent.reader.did, cols: [POST], ops: ['put'], private: true, exp: 1_900_000_000, max: 5, note: 'assistant' })
  const state = await new HostClient(a.url).state(ana.did)
  const grants = state.grants as Record<string, unknown>[]
  assert.equal(grants.length, 1)
  assert.equal(grants[0]!.cid, g.cid.toString())
  assert.deepEqual(grants[0]!.cols, [POST])
  assert.equal(grants[0]!.max, 5)
  assert.equal(grants[0]!.to, agent.signer.did)
  assert.ok(CID.parse(grants[0]!.cid as string))
})

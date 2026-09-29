// Claim 1. A person owns their records. Only they, or whoever they allow, can write them. Nobody can
// fake one.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDirs, nowSeconds, person, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, HostClientError, Writer } from '../src/client.ts'
import { delegateKeys } from '../src/keys.ts'
import { CID, copy } from '../src/codec.ts'
import { EntryError, decodeEntry, encodeEntry, signEntry, verifyLog } from '../src/entry.ts'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'
const PROFILE = 'foundation.forest.profile'

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (e: unknown) => e instanceof HostClientError && e.code === code, `expected refusal ${code}`)
}

test('claim 1: only the profile key writes; a stranger with a well-formed entry is refused', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const mallory = await person(9)
  const host = new HostClient(a.url)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const head = (await host.head(ana.did))!

  // Mallory signs an entry for Ana's log with Mallory's own key, claiming nothing.
  const forged = signEntry(mallory.signer, { v: 1, did: ana.did, seq: 1, prev: CID.parse(head.cid), at: nowSeconds(), op: 'put', col: POST, key: 'x', rec: { description: 'not ana' } })
  await refused(host.append(forged.bytes), 'signature')

  // Mallory claims to be a delegate under a grant that was never made.
  const pretend = signEntry(mallory.signer, { v: 1, did: ana.did, seq: 1, prev: CID.parse(head.cid), at: nowSeconds(), op: 'put', by: mallory.did, via: forged.cid, col: POST, key: 'x', rec: { description: 'not ana' } })
  await refused(host.append(pretend.bytes), 'unknown-grant')

  // Mallory takes Ana's real entry and re-signs it: the bytes then no longer verify against Ana.
  const real = decodeEntry((await host.log(ana.did)).entries[0]!).entry
  const { sig: _sig, ...unsigned } = real
  const resigned = signEntry(mallory.signer, { ...unsigned, seq: 1, prev: CID.parse(head.cid) })
  await refused(host.append(resigned.bytes), 'signature')

  assert.equal((await host.head(ana.did))!.seq, 0, 'the log holds only what Ana signed')
})

test('claim 1: nobody can fake or alter a record: one changed byte fails every reader', async () => {
  const ana = await person(1)
  const e0 = signEntry(ana.signer, { v: 1, did: ana.did, seq: 0, prev: null, at: 1_700_000_000, op: 'keys', rec: { reader: ana.reader.did } })
  const e1 = signEntry(ana.signer, { v: 1, did: ana.did, seq: 1, prev: e0.cid, at: 1_700_000_001, op: 'put', col: POST, key: 'p', rec: { description: 'ten lessons for 100' } })
  const e2 = signEntry(ana.signer, { v: 1, did: ana.did, seq: 2, prev: e1.cid, at: 1_700_000_002, op: 'put', col: POST, key: 'q', rec: { description: 'other' } })
  assert.equal(verifyLog(ana.did, [e0.bytes, e1.bytes, e2.bytes]).head!.seq, 2)

  // Change the price inside the record, keep the signature.
  const altered = { ...e1.entry, rec: { description: 'ten lessons for 1' } }
  assert.throws(() => verifyLog(ana.did, [e0.bytes, encodeEntry(altered)]), (e: unknown) => (e as EntryError).code === 'signature')

  // Flip one bit anywhere in the stored bytes.
  for (const pos of [5, Math.floor(e1.bytes.length / 2), e1.bytes.length - 1]) {
    const flipped = new Uint8Array(e1.bytes)
    flipped[pos] = flipped[pos]! ^ 0x01
    assert.throws(() => verifyLog(ana.did, [e0.bytes, flipped]), 'a flipped bit is caught')
  }

  // Drop an entry from the middle: the chain breaks at the next one.
  assert.throws(() => verifyLog(ana.did, [e0.bytes, e2.bytes]), (e: unknown) => (e as EntryError).code === 'seq')
})

test('claim 1: whoever the person allows can write, exactly within the allowance', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const agent = delegateKeys()
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  const g = await w.grant({ to: agent.signer.did, cols: [POST], ops: ['put'], exp: nowSeconds() + 3600, max: 2 })
  const aw = new Writer({ did: ana.did, signer: agent.signer, via: g.cid, hosts: [a.url] })

  await aw.put(POST, 'p1', { description: 'ok' })
  await refused(aw.put(PROFILE, 'self', { name: 'hijacked' }), 'scope')
  await refused(aw.del(POST, 'p1'), 'scope')
  await refused(aw.putPrivate({ col: 'x', key: 'y', rec: {} }, [ana.reader.did]), 'scope')
  await aw.put(POST, 'p2', { description: 'second and last' })
  await refused(aw.put(POST, 'p3', { description: 'one too many' }), 'limit')

  // A delegate can never grant, revoke or publish keys, whatever its grant says. The client refuses
  // to send such an entry; sent raw anyway, the host refuses it too.
  const head = (await new HostClient(a.url).head(ana.did))!
  for (const op of ['grant', 'revoke', 'keys'] as const) {
    const rec = { to: agent.signer.did, cols: ['*'], ops: ['put', 'del'], exp: nowSeconds() + 1, reader: ana.reader.did, grant: g.cid }
    await assert.rejects(aw.append({ op, rec }), (e: unknown) => e instanceof EntryError && e.code === 'shape')
    const raw = signEntry(agent.signer, { v: 1, did: ana.did, seq: head.seq + 1, prev: CID.parse(head.cid), at: nowSeconds(), op, by: agent.signer.did, via: g.cid, rec })
    const res = await fetch(`${a.url}/log/${ana.did}`, { method: 'POST', body: copy(raw.bytes), headers: { 'content-type': 'application/cbor' } })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: string }).error, 'shape')
  }

  // The other agent's key cannot use this grant.
  const other = delegateKeys()
  const ow = new Writer({ did: ana.did, signer: other.signer, via: g.cid, hosts: [a.url] })
  await refused(ow.put(POST, 'p9', { description: 'not me' }), 'not-granted')

  const state = await new HostClient(a.url).state(ana.did)
  assert.equal((state.collections as Record<string, number>)[POST], 2)
})

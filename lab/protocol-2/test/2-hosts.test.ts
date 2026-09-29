// Claim 2. Records live on hosts anyone can run. A person can use several and leave any of them
// freely. Hosts cannot fake records, read private ones, or hold anyone hostage.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanDirs, dht, nowSeconds, person, seedOf, startHost, stopAll, type Started } from './helpers.ts'
import { HostClient, Writer } from '../src/client.ts'
import { Host } from '../src/host.ts'
import { Index } from '../src/index.ts'
import { CID, b64 } from '../src/codec.ts'
import { EntryError, signEntry, verifyLog } from '../src/entry.ts'
import { signPointer } from '../src/pointer.ts'
import { hex } from '@scure/base'

const started: Started[] = []
after(async () => {
  await stopAll(started)
  cleanDirs()
})

const POST = 'foundation.forest.post'

function diskBytes(dir: string): Buffer {
  return Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))))
}

test('claim 2: a host holds no key: nothing on its disk is a secret of the person, in any encoding', async () => {
  const a = await startHost('a')
  started.push(a)
  const seed = seedOf(1)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  await w.put(POST, 'p', { description: 'public' })
  await w.putPrivate({ col: 'forest.notes', key: 'n', rec: { note: 'the private text' } }, [ana.reader.did])
  const disk = diskBytes(a.dir)
  assert.ok(disk.length > 500, 'the host stored something')
  const secrets: [string, Uint8Array][] = [
    ['seed', seed],
    ['signing key', (await import('@noble/curves/ed25519.js')).ed25519.utils.randomSecretKey().fill(0)], // placeholder replaced below
  ]
  secrets[1] = ['reader private key', ana.reader.privateKey]
  secrets.push(['wallet private key', ana.wallet.privateKey])
  // The signing private key is not exposed by the Signer on purpose; derive it again from the seed for the scan.
  const { hkdf } = await import('../../../keys/src/hkdf.ts')
  const { INFO } = await import('../src/keys.ts')
  secrets.push(['signing private key', await hkdf(seed, INFO.signing(0))])
  for (const [name, bytes] of secrets) {
    for (const [enc, needle] of [['raw', Buffer.from(bytes)], ['hex', Buffer.from(hex.encode(bytes))], ['base64url', Buffer.from(b64.encode(bytes))], ['base64', Buffer.from(Buffer.from(bytes).toString('base64'))]] as const) {
      assert.equal(disk.includes(needle), false, `${name} found on the host's disk as ${enc}`)
    }
  }
  assert.equal(disk.includes(Buffer.from('the private text')), false, 'the private record is not on the disk in the clear')
  assert.equal(disk.includes(Buffer.from('forest.notes')), false, 'not even its collection name')
  assert.ok(disk.includes(Buffer.from('public')), 'the public record is there, as it should be')
})

test('claim 2: a host cannot fake, alter or reorder a record: its own database is not believed by anyone', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  const mallory = await person(9) // the host operator's own key
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  await w.put(POST, 'p1', { description: 'one' })
  await w.put(POST, 'p2', { description: 'two' })
  const good = await new HostClient(a.url).log(ana.did)

  // The operator writes a forged entry straight into the database, correct seq and prev.
  const forged = signEntry(mallory.signer, { v: 1, did: ana.did, seq: 3, prev: CID.parse(good.head!.cid), at: nowSeconds(), op: 'put', col: POST, key: 'p3', rec: { description: 'forged' } })
  a.host.db.prepare('INSERT INTO entries (did, seq, cid, bytes) VALUES (?, ?, ?, ?)').run(ana.did, 3, forged.cid.toString(), forged.bytes)
  const served = await new HostClient(a.url).log(ana.did)
  assert.equal(served.entries.length, 4, 'the host now serves four entries')
  assert.throws(() => verifyLog(ana.did, served.entries), (e: unknown) => (e as EntryError).code === 'signature', 'a reader verifying the log catches it')
  const index = new Index([dht])
  index.follow(a.url)
  await index.tick()
  assert.equal(index.state(ana.did)!.head!.seq, 2, 'the index keeps the three real entries')
  assert.deepEqual(index.faults.map((f) => f.code), ['signature'])

  // The operator alters a stored entry: a reader catches it, and a fresh host over the same file refuses to serve it.
  a.host.db.prepare('DELETE FROM entries WHERE did = ? AND seq = 3').run(ana.did)
  const bytes1 = new Uint8Array(good.entries[1]!)
  bytes1[bytes1.length - 1] ^= 0x01
  a.host.db.prepare('UPDATE entries SET bytes = ? WHERE did = ? AND seq = 1').run(bytes1, ana.did)
  assert.throws(() => verifyLog(ana.did, [good.entries[0]!, bytes1, good.entries[2]!]))
  await a.host.close()
  const reopened = new Host({ path: a.path })
  assert.throws(() => reopened.state(ana.did), 'a host cannot even fold a tampered log')
  reopened.db.close()
  started.pop()

  // Reordering: entries 1 and 2 swapped break at prev.
  assert.throws(() => verifyLog(ana.did, [good.entries[0]!, good.entries[2]!, good.entries[1]!]), (e: unknown) => (e as EntryError).code === 'seq')
})

test('claim 2: a person uses several hosts at once; when one goes down the others serve the same log', async () => {
  const a = await startHost('a')
  const b = await startHost('b')
  started.push(b)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url, b.url] })
  await w.keys(ana.reader.did)
  await w.put(POST, 'p1', { description: 'one' })
  await w.put(POST, 'p2', { description: 'two' })
  const fromA = await new HostClient(a.url).log(ana.did)
  const fromB = await new HostClient(b.url).log(ana.did)
  assert.deepEqual(fromB.head, fromA.head)
  assert.deepEqual(fromB.entries.map((e) => b64.encode(e)), fromA.entries.map((e) => b64.encode(e)))
  await a.host.close()
  const w2 = new Writer({ did: ana.did, signer: ana.signer, hosts: [b.url] })
  await w2.put(POST, 'p3', { description: 'three, with a down' })
  assert.equal(verifyLog(ana.did, (await new HostClient(b.url).log(ana.did)).entries).head!.seq, 3)
})

test('claim 2: a host cannot hold anyone hostage: the log comes back from any index and the person leaves', async () => {
  const a = await startHost('a')
  const c = await startHost('c')
  started.push(c)
  const ana = await person(1)
  const w = new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] })
  await w.keys(ana.reader.did)
  await w.put(POST, 'p1', { description: 'one' })
  const priv = await w.putPrivate({ col: 'forest.notes', key: 'n', rec: { note: 'kept' } }, [ana.reader.did])
  dht.put(ana.did, signPointer(ana.signer, [a.url], 1).payload)
  const index = new Index([dht])
  index.follow(a.url)
  await index.tick()

  // Host a goes dark: it answers nothing, and will never hand the log over.
  await a.host.close()
  await assert.rejects(new HostClient(a.url).log(ana.did))

  // The person takes their log from the index and puts it on host c, then re-points.
  const copy = index.export(ana.did)
  assert.equal(copy.length, 3)
  const cc = new HostClient(c.url)
  for (const bytes of copy) await cc.append(bytes)
  assert.equal((await cc.head(ana.did))!.seq, 2)
  dht.put(ana.did, signPointer(ana.signer, [c.url], 2).payload)
  const w2 = new Writer({ did: ana.did, signer: ana.signer, hosts: [c.url] })
  await w2.put(POST, 'p2', { description: 'written after the move' })

  // The index follows the new pointer and sees the new record; the private record travelled too.
  await index.refreshAll()
  await index.tick()
  assert.equal(index.state(ana.did)!.head!.seq, 3)
  assert.deepEqual(index.record(ana.did, POST, 'p2'), { description: 'written after the move' })
  assert.ok(index.state(ana.did)!.privates.has(priv.key))
  assert.deepEqual(index.pointers.get(ana.did)!.hosts, [c.url])
})

test('claim 2: the host keeps no address log and writes nothing but its database', async () => {
  const a = await startHost('a')
  started.push(a)
  const ana = await person(1)
  await new Writer({ did: ana.did, signer: ana.signer, hosts: [a.url] }).keys(ana.reader.did)
  const source = readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8')
  for (const word of ['remoteAddress', 'x-forwarded-for', 'x-real-ip', 'socket.remote', 'console.log', 'appendFile']) {
    assert.equal(source.includes(word), false, `host.ts mentions ${word}`)
  }
  const files = readdirSync(a.dir).filter((f) => !f.startsWith('host.sqlite'))
  assert.deepEqual(files, [], 'only the database is on disk')
})

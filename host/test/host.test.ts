// The Forest host, end to end: a folder made from keys/'s DID, the four record shapes written
// through the two-phase path, no key on the host, the refusals, the firehose verified against
// the DID document, and a move to a second host. Runs a real local PLC directory and two hosts
// in this process, on SQLite files in temporary directories. Needs `./build.sh` first.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { INFO, didGenesis, hkdf, profileKeys, submitGenesis } from '../../keys/src/index.ts'
import { TestPds } from '../upstream/packages/dev-env/dist/pds.js'
import { TestPlc } from '../upstream/packages/dev-env/dist/plc.js'
import { IdResolver } from '../upstream/packages/identity/dist/index.js'
import {
  MemoryBlockstore,
  def,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepo,
} from '../upstream/packages/repo/dist/index.js'
import { Firehose } from '../upstream/packages/sync/dist/index.js'
import { Device, XrpcError, query, queryBytes, type Write } from './device.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const example = async (name: string) =>
  JSON.parse(await readFile(path.join(here, '../../shapes/examples', `${name}.json`), 'utf8'))

// A 1×1 transparent PNG, 68 bytes: a real image, so the host's type sniffing agrees with the
// declared type.
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const create = (collection: string, value: unknown, rkey?: string): Write => ({
  $type: 'com.atproto.repo.applyWrites#create',
  collection,
  ...(rkey ? { rkey } : {}),
  value,
})

const tmp = (label: string) => mkdtemp(path.join(os.tmpdir(), `forest-host-${label}-`))

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

async function waitFor(check: () => boolean, ms: number, what: string) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function makeHost(plcUrl: string, label: string) {
  const dataDirectory = await tmp(`${label}-data`)
  const blobstoreDiskLocation = await tmp(`${label}-blobs`)
  const pds = await TestPds.create({ didPlcUrl: plcUrl, dataDirectory, blobstoreDiskLocation })
  return { pds, dataDirectory, blobstoreDiskLocation }
}

test('a Forest host', async (t) => {
  // The device: a fixed seed stands in for the passkey's; profile 0's keys; the DID it makes.
  const seed = new Uint8Array(32).fill(7)
  const keys = await profileKeys(seed, 0)
  const otherKeys = await profileKeys(seed, 1)

  const plc = await TestPlc.create({})
  const host1 = await makeHost(plc.url, 'one')
  const pds = host1.pds
  const hostDid = pds.ctx.cfg.service.did

  const genesis = await didGenesis(keys, { handle: 'ana.test', pds: pds.url })
  await submitGenesis(genesis, plc.url)
  const did = genesis.did
  const device = new Device(did, keys, pds.url, hostDid)
  const didKey = keys.signing.did()

  const records: Record<string, { rkey: string; value: any }> = {}
  const hosts: { pds: TestPds; dataDirectory: string; blobstoreDiskLocation: string }[] = [host1]

  try {
    await t.test('1. a folder is made from a device-made DID, its genesis signed on the device', async () => {
      const prepared = await device.prepare([])
      assert.equal(prepared.genesis, true, 'no folder yet: this is the genesis')
      assert.equal(prepared.prev, undefined)
      assert.equal(prepared.did, did)
      assert.ok(prepared.unsignedCommit.$bytes.length > 0)

      const sig = await device.sign(prepared.unsignedCommit)
      const submitted = await device.submit({ writes: prepared.writes, rev: prepared.rev, sig })
      assert.equal(submitted.commit.rev, prepared.rev)

      const status = await query(pds.url, 'com.atproto.sync.getRepoStatus', { did })
      assert.equal(status.active, true)
      assert.equal(status.rev, prepared.rev)
      const account = await pds.ctx.accountManager.getAccount(did)
      assert.equal(account?.handle, 'ana.test', 'the handle is the one the DID document names')

      // The host wrote no key for this folder, and can produce none.
      assert.equal(await pds.ctx.actorStore.keypairIfExists(did), undefined)
      await assert.rejects(pds.ctx.actorStore.keypair(did), /no signing key/i)

      // A second genesis for the same DID is refused: the folder exists.
      const again = await device.prepare([])
      assert.equal(again.genesis, false)
    })

    await t.test('2. a post, a profile, a review and a credential, written and read back', async () => {
      const photo = await device.uploadBlob(PNG, 'image/png')
      assert.equal(photo.mimeType, 'image/png')
      assert.equal(photo.size, PNG.length)

      const post = await example('post')
      const profile = { ...(await example('profile')), photo }
      const review = await example('review')
      const credential = await example('credential')

      const { prepared, submitted } = await device.write([
        create('foundation.forest.post', post),
        create('foundation.forest.profile', profile, 'self'),
        create('foundation.forest.review', review),
        create('foundation.forest.credential', credential),
      ])
      assert.equal(prepared.genesis, false)
      assert.ok(prepared.prev, 'builds on the genesis')
      assert.equal(submitted.results.length, 4)

      for (const [i, value] of [post, profile, review, credential].entries()) {
        const uri = submitted.results[i].uri!
        const [, collection, rkey] = uri.replace('at://', '').split('/')
        records[collection] = { rkey, value }
        const got = await query(pds.url, 'com.atproto.repo.getRecord', { repo: did, collection, rkey })
        assert.deepEqual(got.value, value, `${collection} reads back as written`)
        assert.equal(got.cid, submitted.results[i].cid)
        const list = await query(pds.url, 'com.atproto.repo.listRecords', { repo: did, collection })
        assert.equal(list.records.length, 1)
      }
      assert.equal(records['foundation.forest.profile'].rkey, 'self')

      const served = await queryBytes(pds.url, 'com.atproto.sync.getBlob', { did, cid: photo.ref.$link })
      assert.deepEqual(served, PNG, 'the photo is served back byte for byte')
    })

    await t.test('3. the host holds no private key material for the folder', async () => {
      // The secrets the device holds, in every form a file could hold them.
      const signingRaw = await hkdf(seed, INFO.signing(0))
      const controlRaw = await hkdf(seed, INFO.control(0))
      const forms: [string, Buffer | string][] = []
      for (const [name, raw] of [
        ['seed', seed],
        ['signing key', signingRaw],
        ['control key', controlRaw],
      ] as const) {
        const b = Buffer.from(raw)
        forms.push([`${name} raw`, b])
        forms.push([`${name} hex`, b.toString('hex')])
        forms.push([`${name} base64`, b.toString('base64').replace(/=+$/, '')])
        forms.push([`${name} base64url`, b.toString('base64url')])
      }

      const files = [
        ...(await walk(host1.dataDirectory)),
        ...(await walk(host1.blobstoreDiskLocation)),
      ]
      assert.ok(files.some((f) => f.includes(did) && f.endsWith('store.sqlite')), "the folder's database is there")
      assert.ok(files.length > 3, `${files.length} files looked at`)
      for (const file of files) {
        assert.notEqual(path.basename(file), 'key', `a key file: ${file}`)
        assert.ok(!file.includes('reserved_keys'), `a reserved key: ${file}`)
        const bytes = await readFile(file)
        for (const [what, form] of forms) {
          assert.equal(bytes.indexOf(form), -1, `${what} found in ${file}`)
        }
      }
    })

    await t.test('4. the wrong key, a stale head, and a replay are refused', async () => {
      const post = await example('post')
      const head = (await query(pds.url, 'com.atproto.sync.getRepoStatus', { did })).rev

      // Signed by another profile's key: refused, nothing stored.
      const a = await device.prepare([create('foundation.forest.post', post)])
      const wrongSig = await otherKeys.signing.sign(
        new Uint8Array(Buffer.from(a.unsignedCommit.$bytes, 'base64')),
      )
      await assert.rejects(
        device.submit({ writes: a.writes, rev: a.rev, sig: wrongSig, swapCommit: a.prev }),
        (err: XrpcError) => err.error === 'InvalidSignature',
      )
      assert.equal((await query(pds.url, 'com.atproto.sync.getRepoStatus', { did })).rev, head)

      // Two commits prepared on the same head. The first lands; the second is stale.
      const b = await device.prepare([create('foundation.forest.post', post)])
      assert.equal(a.prev, b.prev)
      const sigA = await device.sign(a.unsignedCommit)
      const landed = await device.submit({ writes: a.writes, rev: a.rev, sig: sigA, swapCommit: a.prev })
      const sigB = await device.sign(b.unsignedCommit)
      await assert.rejects(
        device.submit({ writes: b.writes, rev: b.rev, sig: sigB, swapCommit: b.prev }),
        (err: XrpcError) => err.error === 'InvalidSwap',
        'with swapCommit: the head moved',
      )
      await assert.rejects(
        device.submit({ writes: b.writes, rev: b.rev, sig: sigB }),
        (err: XrpcError) => err.error === 'InvalidSignature',
        'without swapCommit: the rebuilt commit is not the one that was signed',
      )

      // The accepted commit again, byte for byte.
      await assert.rejects(
        device.submit({ writes: a.writes, rev: a.rev, sig: sigA, swapCommit: a.prev }),
        (err: XrpcError) => err.error === 'InvalidSwap',
      )
      await assert.rejects(
        device.submit({ writes: a.writes, rev: a.rev, sig: sigA }),
        (err: XrpcError) => err.error === 'InvalidRev',
        'a rev that is not newer than the head',
      )
      assert.equal((await query(pds.url, 'com.atproto.sync.getRepoStatus', { did })).rev, landed.commit.rev)

      // The server-signed write path cannot be used for this folder: there is no session to
      // present, and the store's stand-in key refuses to sign.
      await assert.rejects(
        device.call('com.atproto.repo.applyWrites', { repo: did, writes: a.writes }),
        (err: XrpcError) => err.status === 400 || err.status === 401,
      )
      await assert.rejects(
        pds.ctx.actorStore.transact(did, (txn) => txn.repo.processWrites([])),
        /no signing key/i,
      )
    })

    await t.test('5. the firehose carries the commits, and each verifies against the DID document', async () => {
      const events: any[] = []
      const errors: Error[] = []
      const firehose = new Firehose({
        // The resolver's default fetch refuses plain http, rightly, so the local PLC needs the
        // plain one. Handles are not checked: `ana.test` has no DNS, and a carrier checks
        // handles for itself anyway. Commits are checked: that is the point.
        idResolver: new IdResolver({ plcUrl: plc.url, fetch: globalThis.fetch }),
        unauthenticatedHandles: true,
        service: pds.url.replace(/^http/, 'ws'),
        handleEvent: (evt: any) => {
          events.push(evt)
        },
        onError: (err: Error) => {
          errors.push(err)
        },
        getCursor: () => 0,
      })
      void firehose.start()
      try {
        await waitFor(
          () => events.filter((e) => e.did === did && e.event === 'create').length >= 5,
          15_000,
          `five verified creates on the firehose (got ${JSON.stringify(events.map((e) => [e.did === did, e.event]))}; errors: ${errors.map((e) => e.stack).join('\n')})`,
        )
      } finally {
        await firehose.destroy()
      }
      assert.deepEqual(errors, [], 'nothing on the firehose failed verification')
      const kinds = new Set(events.filter((e) => e.did === did).map((e) => e.event))
      assert.ok(kinds.has('identity') && kinds.has('account') && kinds.has('create'))

      // The same check a relay makes, done by hand on the served repo.
      const car = await queryBytes(pds.url, 'com.atproto.sync.getRepo', { did })
      const { root, blocks } = await readCarWithRoot(car)
      const verified = await verifyRepo(blocks, root, did, didKey)
      assert.equal(verified.creates.length, 5)
      await assert.rejects(verifyRepo(blocks, root, did, otherKeys.signing.did()), 'another key does not verify it')
      const commit = await new MemoryBlockstore(blocks).readObj(root, def.commit)
      assert.equal(commit.did, did)
      assert.equal(await verifyCommitSig(commit, didKey), true)
      assert.equal(await verifyCommitSig(commit, otherKeys.signing.did()), false)
    })

    await t.test('6. the folder moves to a second host by CAR file and is served the same', async () => {
      const host2 = await makeHost(plc.url, 'two')
      hosts.push(host2)
      const pds2 = host2.pds

      // The device points its DID at the new host: a PLC update signed with the control key.
      await plc.getClient().updatePds(did, keys.control, pds2.url)
      const device2 = new Device(did, keys, pds2.url, pds2.ctx.cfg.service.did)

      // An empty folder there, then the old folder's contents into it.
      const fresh = await device2.write([])
      assert.equal(fresh.prepared.genesis, true)
      const car = await queryBytes(pds.url, 'com.atproto.sync.getRepo', { did })
      await device2.importRepo(car)
      await device2.uploadBlob(PNG, 'image/png')

      const head1 = await query(pds.url, 'com.atproto.sync.getLatestCommit', { did })
      const head2 = await query(pds2.url, 'com.atproto.sync.getLatestCommit', { did })
      assert.equal(head2.cid, head1.cid, 'the same head commit, still signed by the device')

      for (const collection of Object.keys(records)) {
        const one = await query(pds.url, 'com.atproto.repo.listRecords', { repo: did, collection })
        const two = await query(pds2.url, 'com.atproto.repo.listRecords', { repo: did, collection })
        assert.deepEqual(two.records, one.records, `${collection} is served the same`)
      }
      const photoCid = records['foundation.forest.profile'].value.photo.ref.$link
      assert.deepEqual(await queryBytes(pds2.url, 'com.atproto.sync.getBlob', { did, cid: photoCid }), PNG)

      const car2 = await queryBytes(pds2.url, 'com.atproto.sync.getRepo', { did })
      const { root, blocks } = await readCarWithRoot(car2)
      assert.equal((await verifyRepo(blocks, root, did, didKey)).creates.length, 5)
      assert.equal(await pds2.ctx.actorStore.keypairIfExists(did), undefined, 'no key on the second host either')

      // And the folder keeps going on the new host: the next write builds on the imported head.
      const next = await device2.write([create('foundation.forest.post', await example('post'))])
      assert.equal(next.prepared.prev, head1.cid)
      const status = await query(pds2.url, 'com.atproto.sync.getRepoStatus', { did })
      assert.equal(status.rev, next.submitted.commit.rev)
    })
  } finally {
    for (const h of hosts) {
      await h.pds.close()
      await rm(h.dataDirectory, { recursive: true, force: true })
      await rm(h.blobstoreDiskLocation, { recursive: true, force: true })
    }
    await plc.close()
  }
})

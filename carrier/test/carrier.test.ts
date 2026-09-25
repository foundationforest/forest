// The carrier, run locally: the host from host/ on http://localhost:2583 with a local directory
// of DIDs on :2582, Bluesky's relay (bin/relay) reading that host, and Jetstream (bin/jetstream)
// reading the relay. A device writes a profile and a post through the host, and a record that is
// not Forest's; an index subscribed for `foundation.forest.*` receives the two and not the third.
//
//   npm run test:local
//
// Needs ../build.sh (the relay and Jetstream), ../../host/build.sh (the host, which also installs
// keys/' dependencies), and Node 22.5 or later (node:sqlite, WebSocket). If either build is missing
// the test says which and skips.
//
// The relay and Jetstream run with the variables in relay.env.example and jetstream.env.example,
// with only the paths, the secret and the directory's address replaced for this run.
//
// One step here is for localhost only. The relay checks that a host answers before it subscribes,
// through a client that refuses loopback addresses and any port but 80 and 443 (its SSRF guard,
// with no switch), so the admin endpoint cannot add http://localhost:2583. The test shows that
// refusal, then writes the host into the relay's own host table and restarts it, which is what the
// endpoint would have written. A host on a public https address is added with the endpoint alone.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const relayBin = join(here, '../bin/relay')
const jetstreamBin = join(here, '../bin/jetstream')
const hostBuild = join(root, 'host/upstream/packages/dev-env/dist/pds.js')

const PLC_PORT = 2582
const HOST_PORT = 2583
const RELAY = 'http://localhost:2470'
const JETSTREAM = 'ws://localhost:6008/subscribe'
const HOST = `localhost:${HOST_PORT}`
const ADMIN_PASSWORD = `local-${Math.random().toString(36).slice(2)}`
const admin = { authorization: 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64') }

// A 1×1 transparent PNG, so the profile carries a real photo as a product's would.
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
)

function missing(): string | null {
  if (!existsSync(relayBin) || !existsSync(jetstreamBin)) return 'no relay or Jetstream; run ./build.sh in carrier'
  if (!existsSync(hostBuild)) return 'no host build; run ./build.sh in host'
  if (!existsSync(join(root, 'keys/node_modules'))) return 'no keys/ dependencies; run ./build.sh in host'
  return null
}

/** KEY=VALUE lines of a committed .env.example, comments and blanks skipped. */
function envExample(name: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of readFileSync(join(here, '..', name), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) vars[m[1]] = m[2]
  }
  return vars
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, ms: number, check: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

type Proc = { child: ChildProcess; log: string[] }
const procs: Proc[] = []
function start(bin: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(bin, args, { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const proc = { child, log: [] as string[] }
  child.stdout!.on('data', (b: Buffer) => proc.log.push(b.toString()))
  child.stderr!.on('data', (b: Buffer) => proc.log.push(b.toString()))
  procs.push(proc)
  return proc
}
async function stop(proc: Proc) {
  if (proc.child.exitCode !== null) return
  const exited = new Promise((r) => proc.child.once('exit', r))
  proc.child.kill('SIGTERM')
  await Promise.race([exited, sleep(10_000).then(() => proc.child.kill('SIGKILL'))])
}

type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: { operation: string; collection: string; rkey: string; record?: Record<string, unknown>; cid?: string }
  identity?: { did: string; handle?: string }
  account?: { active: boolean; did: string }
}

/** One subscriber, as an index would connect: every event it receives, in order. */
function subscribe(query: string) {
  const events: JetstreamEvent[] = []
  const socket = new WebSocket(`${JETSTREAM}${query}`)
  socket.addEventListener('message', (m) => events.push(JSON.parse(String(m.data))))
  const open = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('could not connect to Jetstream')))
  })
  return { events, socket, open }
}

let work: string | undefined
const cleanup: (() => Promise<unknown>)[] = []
after(async () => {
  for (const proc of procs) proc.child.kill('SIGKILL')
  for (const fn of cleanup.reverse()) await fn().catch(() => {})
  if (work) rmSync(work, { recursive: true, force: true })
})

test('the carrier passes Forest records from a Forest host to an index, and nothing else', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  const { DatabaseSync } = await import('node:sqlite')
  const { TestPlc } = await import(join(root, 'host/upstream/packages/dev-env/dist/plc.js'))
  const { TestPds } = await import(hostBuild)
  const { Device } = await import(join(root, 'host/test/device.ts'))
  const { didGenesis, profileKeys, submitGenesis } = await import(join(root, 'keys/src/index.ts'))
  const example = (name: string) => JSON.parse(readFileSync(join(root, 'shapes/examples', `${name}.json`), 'utf8'))

  work = mkdtempSync(join(tmpdir(), 'forest-carrier-'))

  // The directory of DIDs and the host, in this process, as host/'s own tests run them.
  const plc = await TestPlc.create({ port: PLC_PORT })
  cleanup.push(() => plc.close())
  for (const dir of ['host-data', 'host-blobs']) mkdirSync(join(work, dir))
  const host = await TestPds.create({
    port: HOST_PORT,
    didPlcUrl: plc.url,
    dataDirectory: join(work, 'host-data'),
    blobstoreDiskLocation: join(work, 'host-blobs'),
  })
  cleanup.push(() => host.close())
  assert.equal(host.url, `http://${HOST}`)

  // ---- The relay ----
  const relayEnv = {
    ...envExample('relay.env.example'),
    RELAY_ADMIN_PASSWORD: ADMIN_PASSWORD,
    RELAY_PLC_HOST: plc.url,
    DATABASE_URL: `sqlite://${join(work, 'relay.sqlite')}`,
    RELAY_PERSIST_DIR: join(work, 'relay-persist'),
  }
  assert.equal(relayEnv.RELAY_DISABLE_REQUEST_CRAWL, 'true')
  let relay = start(relayBin, ['serve'], relayEnv)
  await until('the relay', 30_000, async () => (await fetch(`${RELAY}/xrpc/_health`)).ok)

  // Nobody adds a host by asking.
  const asked = await fetch(`${RELAY}/xrpc/com.atproto.sync.requestCrawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: HOST }),
  })
  assert.equal(asked.status, 403, 'public requestCrawl is refused')
  // The admin endpoint is how a host is added; for a loopback host its reachability check refuses.
  const added = await fetch(`${RELAY}/admin/pds/requestCrawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...admin },
    body: JSON.stringify({ hostname: HOST }),
  })
  const addedBody = await added.text()
  assert.equal(added.status, 400, addedBody)
  assert.match(addedBody, /host server unreachable/, "the relay's SSRF guard refuses loopback")

  // So, for this local run only: the row the endpoint would have written, then a restart, which
  // resubscribes to every active host.
  await stop(relay)
  const db = new DatabaseSync(join(work, 'relay.sqlite'))
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO host (created_at, updated_at, hostname, no_ssl, account_limit, trusted, status, last_seq, account_count)
     VALUES (?, ?, ?, 1, 100, 0, 'active', -1, 0)`,
  ).run(now, now, HOST)
  db.close()
  relay = start(relayBin, ['serve'], relayEnv)
  await until('the relay', 30_000, async () => (await fetch(`${RELAY}/xrpc/_health`)).ok)
  await until('the relay to subscribe to the host', 30_000, async () => {
    const conns = (await (await fetch(`${RELAY}/admin/subs/getUpstreamConns`, { headers: admin })).json()) as string[]
    return conns.includes(HOST)
  })

  // ---- Jetstream, reading the relay ----
  const jetstreamEnv = {
    ...envExample('jetstream.env.example'),
    JETSTREAM_DATA_DIR: join(work, 'jetstream'),
  }
  assert.equal(jetstreamEnv.JETSTREAM_WS_URL, 'ws://localhost:2470/xrpc/com.atproto.sync.subscribeRepos')
  start(jetstreamBin, [], jetstreamEnv)
  await until('Jetstream to read the relay', 30_000, async () => {
    const consumers = (await (await fetch(`${RELAY}/admin/consumers/list`, { headers: admin })).json()) as unknown[]
    return consumers.length > 0
  })

  // Two subscribers. The index asks for Forest's records only; the other asks for everything, to
  // show where the line is drawn: in the subscription, not in the carrier.
  const index = await until('Jetstream to accept subscribers', 30_000, async () => {
    const s = subscribe('?wantedCollections=foundation.forest.*')
    await s.open
    return s
  })
  const everything = subscribe('')
  await everything.open
  cleanup.push(async () => {
    index.socket.close()
    everything.socket.close()
  })

  // ---- The device writes through the host ----
  const keys = await profileKeys(new Uint8Array(32).fill(11), 0)
  const genesis = await didGenesis(keys, { handle: 'carrier.test', pds: host.url })
  await submitGenesis(genesis, plc.url)
  const did: string = genesis.did
  const device = new Device(did, keys, host.url, host.ctx.cfg.service.did)
  const create = (collection: string, value: unknown, rkey?: string) => ({
    $type: 'com.atproto.repo.applyWrites#create',
    collection,
    ...(rkey ? { rkey } : {}),
    value,
  })

  await device.write([]) // the folder's genesis: an empty tree, signed on the device
  const photo = await device.uploadBlob(PNG, 'image/png')
  const profile = { ...example('profile'), photo }
  const post = example('post')
  const notForest = { $type: 'app.bsky.feed.post', text: 'Not a Forest record.', createdAt: new Date().toISOString() }
  const secondPost = { ...post, description: 'The same offer, written alongside a record that is not Forest’s.' }
  const alsoNotForest = { ...notForest, text: 'Not a Forest record either, in the same commit as one.' }

  await device.write([create('foundation.forest.profile', profile, 'self'), create('foundation.forest.post', post)])
  await device.write([create('app.bsky.feed.post', notForest)])
  await device.write([create('foundation.forest.post', secondPost), create('app.bsky.feed.post', alsoNotForest)])

  const mine = (events: JetstreamEvent[]) => events.filter((e) => e.did === did)
  const commits = (events: JetstreamEvent[]) =>
    mine(events).filter((e) => e.kind === 'commit').map((e) => `${e.commit!.operation} ${e.commit!.collection}`)

  // Everything the host wrote reaches the unfiltered subscriber: four Forest records, two others.
  await until('every record at the unfiltered subscriber', 30_000, () => commits(everything.events).length >= 5)
  await sleep(1_000) // anything late would arrive now

  // The index: the account and identity events, the profile and both posts, and nothing else.
  const got = mine(index.events)
  assert.ok(got.some((e) => e.kind === 'identity' && e.identity?.did === did), 'the identity event')
  assert.ok(got.some((e) => e.kind === 'account' && e.account?.did === did && e.account.active), 'the account event, active')
  assert.deepEqual(commits(index.events), [
    'create foundation.forest.profile',
    'create foundation.forest.post',
    'create foundation.forest.post',
  ])
  const records = got.filter((e) => e.kind === 'commit').map((e) => e.commit!)
  assert.equal(records[0].rkey, 'self')
  assert.deepEqual(records[0].record, profile, 'the profile, exactly as written, photo included')
  assert.deepEqual(records[1].record, post, 'the post, exactly as written')
  assert.deepEqual(records[2].record, secondPost, 'the Forest record from the mixed commit')
  assert.ok(!got.some((e) => e.commit?.collection === 'app.bsky.feed.post'), 'no record that is not Forest’s')

  // The unfiltered subscriber saw the other two: the drop is the subscription's.
  assert.deepEqual(commits(everything.events), [
    'create foundation.forest.profile',
    'create foundation.forest.post',
    'create app.bsky.feed.post',
    'create foundation.forest.post',
    'create app.bsky.feed.post',
  ])

  // The relay checked each commit's signature against the DID document and passed them on with no
  // complaint. Its log says the one thing it did not check: the first commit it saw from the folder
  // (here the genesis) has no earlier commit to follow from, so only its signature was checked;
  // every later commit's history was checked too. Nothing it logged at warning level or above.
  const relayLines = relay.log.join('').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
  const said = (msg: RegExp) => relayLines.filter((l) => msg.test(l.msg ?? ''))
  assert.equal(said(/skipping commit signature validation/).length, 0, 'no signature check skipped')
  assert.equal(said(/not verifying prevData or MST inversion for first commit/).length, 1, 'history unchecked only for the first commit')
  assert.deepEqual(relayLines.filter((l) => l.level === 'WARN' || l.level === 'ERROR'), [], 'no warnings')
  const status = (await (await fetch(`${RELAY}/xrpc/com.atproto.sync.getRepoStatus?did=${did}`)).json()) as { active: boolean }
  assert.equal(status.active, true, 'the relay holds the folder as an active account')

  console.log('\n== the carrier on this machine ==')
  console.log(`   host ${host.url} -> relay ${RELAY} -> Jetstream ${JETSTREAM}`)
  console.log(`   index (wantedCollections=foundation.forest.*): ${got.map((e) => (e.kind === 'commit' ? e.commit!.collection : e.kind)).join(', ')}`)
  console.log(`   unfiltered: ${commits(everything.events).join(', ')}\n`)
})

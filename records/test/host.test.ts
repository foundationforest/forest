// End to end over HTTP: two hosts, an owner publishing, an index reading both, updates,
// deletes, pruning, moving hosts, and hosts that misbehave.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { MAX_PAGE_BYTES, publish, readAll, readPage } from '../src/client.ts'
import { type Entry, MAX_ENTRY_BYTES, checkEntry, encodeEntry } from '../src/entry.ts'
import { DAY, type Host } from '../src/host.ts'
import { Index } from '../src/indexer.ts'
import { liveContent } from '../src/view.ts'
import { folderEntry, nextTime, ownerEntry } from '../src/write.ts'
import { MINUTE, T0, alice, aliceBuyer, bob, offerBody, profileBody, reviewBody, sizedEntry } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

describe('two hosts, one index', () => {
  const clock = new Clock(T0)
  let h1: Host
  let h2: Host
  before(async () => {
    h1 = await startHost({ now: clock.now })
    h2 = await startHost({ now: clock.now })
  })
  after(async () => {
    await h1.close()
    await h2.close()
  })

  test('publish a profile, an offer and a review to two hosts; an index reads them from both', async () => {
    const hosts = [h1.url, h2.url]
    const aliceEntries: Entry[] = [
      folderEntry(alice, { hosts }, T0),
      ownerEntry(alice, 'profile', profileBody('Alice'), T0),
      ownerEntry(alice, 'offer/maths', offerBody('30'), T0),
    ]
    const bobEntries: Entry[] = [folderEntry(bob, { hosts }, T0), ownerEntry(bob, 'review/1', reviewBody(alice.did), T0)]
    for (const outcome of await publish(hosts, [...aliceEntries, ...bobEntries])) {
      assert.equal(outcome.status, 200)
      assert.ok(outcome.results.every((r) => r.ok), JSON.stringify(outcome.results))
    }

    const index = new Index({ hosts: [h1.url], now: clock.now })
    const crawl = await index.crawl()
    assert.equal(crawl.hosts, 2, 'the second host was found in the folders, not configured')
    const a = index.view(alice.did)!
    assert.deepEqual([...liveContent(a).keys()].sort(), ['offer/maths', 'profile'])
    const reviews = [...index.views().values()].flatMap((v) => [...liveContent(v).values()]).filter((v) => v.entry.path.startsWith('review/'))
    assert.equal(reviews.length, 1)
    assert.equal((reviews[0]!.entry.body as { subject: string }).subject, alice.did)
  })

  test('an update and a delete reach the index from either host; old versions are pruned after keep days', async () => {
    clock.advance(MINUTE)
    const hosts = [h1.url, h2.url]
    const index = new Index({ hosts, now: clock.now })
    await index.crawl()
    const update = ownerEntry(alice, 'offer/maths', offerBody('35'), nextTime(clock.t, index.view(alice.did), 'offer/maths'))
    // Only host 2 gets the update; only host 1 gets the delete of the profile card.
    await publish([h2.url], [update])
    const del = ownerEntry(alice, 'profile', null, nextTime(clock.t, index.view(alice.did), 'profile'))
    await publish([h1.url], [del])

    await index.crawl()
    const v = index.view(alice.did)!
    assert.equal((v.current.get('offer/maths')!.entry.body as { price: { amount: string } }).price.amount, '35')
    assert.equal(v.current.get('profile')!.entry.body, null)

    // Host 2 still holds the old offer version as history, until keep days pass.
    const before = h2.count(alice.did)
    assert.equal(h2.prune(clock.t + 29 * DAY), 0)
    assert.ok(h2.prune(clock.t + 31 * DAY) >= 1)
    assert.equal(h2.count(alice.did), before - 1)
    // Current versions and the delete are never pruned.
    const after = await readAll(h1.url, { profile: alice.did })
    assert.ok(after.versions.some((x) => x.entry.path === 'profile' && x.entry.body === null))
  })

  test('the owner sets keep: 0 to forget old versions at once', async () => {
    clock.advance(MINUTE)
    const index = new Index({ hosts: [h1.url], now: clock.now })
    await index.crawl()
    const keep0 = folderEntry(alice, { hosts: [h1.url, h2.url], keep: 0 }, nextTime(clock.t, index.view(alice.did), 'folder'))
    const v2 = ownerEntry(alice, 'offer/maths', offerBody('40'), nextTime(clock.t, index.view(alice.did), 'offer/maths'))
    await publish([h1.url], [keep0, v2])
    const pruned = h1.prune(clock.t)
    assert.ok(pruned >= 1, 'superseded versions go at once')
  })
})

describe('feeds', () => {
  test('three filters: after a cursor, one profile, badged profiles only (the host asks the registry)', async () => {
    const badges = new Set([bob.did])
    const h = await startHost({ now: () => T0, isBadged: (did) => badges.has(did) })
    try {
      const url = h.url
      await publish([url], [folderEntry(alice, { hosts: [url] }, T0), ownerEntry(alice, 'profile', profileBody('Alice'), T0)])
      await publish([url], [folderEntry(bob, { hosts: [url] }, T0), ownerEntry(bob, 'profile', profileBody('Bob'), T0)])
      const whole = await readAll(url)
      assert.deepEqual(whole.versions.map((v) => v.entry.profile), [alice.did, alice.did, bob.did, bob.did], 'arrival order')

      assert.deepEqual((await readAll(url, { profile: alice.did })).versions.map((v) => v.entry.path), ['folder', 'profile'])
      assert.deepEqual([...new Set((await readAll(url, { badged: true })).versions.map((v) => v.entry.profile))], [bob.did])
      const since = await readPage(url, { after: 2 })
      assert.deepEqual(since.versions.map((v) => v.entry.profile), [bob.did, bob.did])
      assert.equal((await readPage(url, { after: since.cursor })).versions.length, 0, 'nothing new since the cursor')

      // Alice gets a badge: from the host's next look at the registry, her profile is in the badged feed.
      badges.add(alice.did)
      await h.refreshBadges()
      assert.deepEqual([...new Set((await readAll(url, { badged: true })).versions.map((v) => v.entry.profile))], [alice.did, bob.did])
    } finally {
      await h.close()
    }
  })
})

describe('a host that closes, or blocks a reader', () => {
  test('costs nothing lasting: readers use the other host; the app posts its own copies to a new one; the profile is the same, entry for entry', async () => {
    const clock = new Clock(T0)
    const one = await startHost({ now: clock.now })
    const two = await startHost({ now: clock.now })
    const three = await startHost({ now: clock.now })
    try {
      // The app posts every entry to every host in the folder, and keeps its own copies.
      const copies: Entry[] = [
        folderEntry(aliceBuyer, { hosts: [one.url, two.url] }, T0),
        ownerEntry(aliceBuyer, 'profile', profileBody('A.'), T0),
        ownerEntry(aliceBuyer, 'offer/wanted', offerBody('25'), T0),
      ]
      await publish([one.url, two.url], copies)
      const before = new Index({ hosts: [one.url], now: clock.now })
      await before.crawl()
      const was = [...before.view(aliceBuyer.did)!.current.values()].map((v) => v.id).sort()

      // Host one blocks this reader (every read refused), then closes altogether.
      one.read = () => {
        throw new Error('blocked')
      }
      const blocked = new Index({ hosts: [one.url, two.url], now: clock.now })
      const crawl = await blocked.crawl()
      assert.deepEqual(crawl.unreachable, [one.url])
      assert.deepEqual([...blocked.view(aliceBuyer.did)!.current.values()].map((v) => v.id).sort(), was)
      await one.close()

      // The app replaces it: a folder naming the new host, then its copies there.
      clock.advance(MINUTE)
      const moved = folderEntry(aliceBuyer, { hosts: [two.url, three.url] }, clock.t)
      copies.push(moved)
      await publish([two.url, three.url], [moved])
      const [outcome] = await publish([three.url], copies)
      assert.ok(outcome!.results.every((r) => r.ok || r.error === 'stale'), JSON.stringify(outcome!.results))

      const after = new Index({ hosts: [three.url], now: clock.now })
      await after.crawl()
      const now = [...after.view(aliceBuyer.did)!.current.values()]
      assert.deepEqual(now.filter((v) => v.entry.path !== 'folder').map((v) => v.id).sort(), was.filter((id) => id !== checkEntry(copies[0]!).id).sort())
      assert.deepEqual(after.view(aliceBuyer.did)!.folder!.hosts, [two.url, three.url])
    } finally {
      await two.close()
      await three.close()
    }
  })
})

describe('moving, and replaying after a move', () => {
  test('moving is copying: the new host serves the same, verified profile', async () => {
    const clock = new Clock(T0)
    const old = await startHost({ now: clock.now })
    const next = await startHost({ now: clock.now })
    try {
      const entries = [
        folderEntry(alice, { hosts: [old.url] }, T0),
        ownerEntry(alice, 'profile', profileBody('Alice'), T0),
        ownerEntry(alice, 'offer/maths', offerBody('30'), T0),
      ]
      await publish([old.url], entries)
      // 1. A folder naming the new host, to the new host. 2. Copy everything. 3. Tell the old host.
      clock.advance(MINUTE)
      const moving = folderEntry(alice, { hosts: [old.url, next.url] }, clock.t)
      await publish([next.url, old.url], [moving])
      const copy = await readAll(old.url, { profile: alice.did })
      const copied = await publish([next.url], copy.versions.map((v) => v.entry))
      // Everything lands; an older folder version is refused as stale, since hosts keep the newest.
      for (const r of copied[0]!.results) {
        const v = copy.versions.find((x) => x.id === r.id)!
        assert.ok(r.ok || (v.entry.path === 'folder' && r.error === 'stale'), JSON.stringify(r))
      }
      clock.advance(MINUTE)
      const moved = folderEntry(alice, { hosts: [next.url] }, clock.t)
      await publish([next.url, old.url], [moved])

      const index = new Index({ hosts: [next.url], now: clock.now })
      await index.crawl()
      assert.deepEqual([...liveContent(index.view(alice.did)!).keys()].sort(), ['offer/maths', 'profile'])

      // The old host no longer holds the profile: new entries and replays are refused...
      const replay = await publish([old.url], [ownerEntry(alice, 'offer/new', offerBody('1'), clock.t)])
      assert.equal(replay[0]!.results[0]!.error, 'not-held')
      // ...an old folder naming it again is stale...
      const stale = await publish([old.url], [entries[0]!])
      assert.equal(stale[0]!.results[0]!.ok, true, 'already stored: harmless')
      const olderFolder = folderEntry(alice, { hosts: [old.url] }, T0 + 1)
      assert.equal((await publish([old.url], [olderFolder]))[0]!.results[0]!.error, 'stale')
      // ...and after keep days it keeps only the newest folder.
      old.prune(clock.t + 31 * DAY)
      const left = await readAll(old.url, { profile: alice.did })
      assert.deepEqual(left.versions.map((v) => v.entry.path), ['folder'])
    } finally {
      await old.close()
      await next.close()
    }
  })

  test('a closed profile keeps only its closing folder, and takes nothing more', async () => {
    const clock = new Clock(T0)
    const h = await startHost({ now: clock.now })
    try {
      await publish([h.url], [folderEntry(alice, { hosts: [h.url] }, T0), ownerEntry(alice, 'profile', profileBody('A'), T0)])
      await publish([h.url], [folderEntry(alice, null, T0 + 1)])
      assert.equal((await publish([h.url], [ownerEntry(alice, 'profile', profileBody('B'), T0 + 2)]))[0]!.results[0]!.error, 'not-held')
      h.prune(T0 + 31 * DAY)
      const left = await readAll(h.url, { profile: alice.did })
      assert.deepEqual(left.versions.map((v) => [v.entry.path, v.entry.body]), [['folder', null]])
    } finally {
      await h.close()
    }
  })
})

describe('hosts that misbehave', () => {
  test('a host that withholds an update, rolls back, or serves forged lines cannot change what the index shows', async () => {
    const clock = new Clock(T0)
    const honest = await startHost({ now: clock.now })
    const bad = await startHost({ now: clock.now })
    try {
      const hosts = [honest.url, bad.url]
      await publish(hosts, [folderEntry(alice, { hosts }, T0), ownerEntry(alice, 'offer/maths', offerBody('30'), T0)])
      const newer = ownerEntry(alice, 'offer/maths', offerBody('45'), T0 + MINUTE)
      await publish([honest.url], [newer]) // the bad host "missed" it

      // The bad host also serves a forged version: same fields, price changed, old signature.
      const forged = { ...newer, body: offerBody('4500') }
      const forgedLine = encodeEntry(forged as Entry)
      const serve = bad.read.bind(bad)
      bad.read = (options) => {
        const out = serve(options)
        return out.lines.length ? { lines: [...out.lines, forgedLine], cursor: out.cursor } : out
      }

      const index = new Index({ hosts: [bad.url, honest.url], now: () => T0 + 2 * MINUTE })
      await index.crawl()
      const offer = index.view(alice.did)!.current.get('offer/maths')!
      assert.equal(offer.id, checkEntry(newer).id)
      assert.equal(index.refused.get(bad.url), 1)
    } finally {
      await honest.close()
      await bad.close()
    }
  })

  test('a host refuses what does not count: forged, stale-dated ahead, unknown profile, non-canonical', async () => {
    const h = await startHost({ now: () => T0 })
    try {
      const good = ownerEntry(alice, 'offer/a', offerBody('1'), T0)
      const results = await h.accept([
        encodeEntry(good), // profile not held yet: its folder never arrived
        encodeEntry({ ...good, body: offerBody('2') } as Entry),
        encodeEntry(ownerEntry(alice, 'offer/b', offerBody('1'), T0 + 11 * MINUTE)),
        JSON.stringify(good, null, 1),
      ])
      assert.deepEqual(results.map((r) => r.error), ['not-held', 'signature', 'future', 'canonical'])
      const notNamed = await h.accept([encodeEntry(folderEntry(alice, { hosts: ['https://elsewhere.example'] }, T0))])
      assert.equal(notNamed[0]!.error, 'not-named')
    } finally {
      await h.close()
    }
  })
})

describe('limits: 4 MB a page, the spec’s size an entry, 60 seconds a read', () => {
  const bytes = (lines: string[]) => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)

  test('a host ends a page before 4 MB; a reader still gets every entry, page by page', async () => {
    const h = await startHost({ now: () => T0 })
    try {
      const full = Array.from({ length: 66 }, (_, i) => sizedEntry(alice, `note/${i}`, MAX_ENTRY_BYTES))
      const [outcome] = await publish([h.url], [folderEntry(alice, { hosts: [h.url] }, T0), ...full])
      assert.ok(outcome!.results.every((r) => r.ok), JSON.stringify(outcome!.results.filter((r) => !r.ok)))
      const first = h.read()
      assert.ok(bytes(first.lines) <= MAX_PAGE_BYTES)
      assert.ok(bytes(first.lines) + MAX_ENTRY_BYTES + 1 > MAX_PAGE_BYTES, 'the next entry would not have fit')
      assert.ok(first.lines.length < 67)
      assert.equal((await readAll(h.url)).versions.length, 67)
    } finally {
      await h.close()
    }
  })

  test('a reader refuses a page over 4 MB, and takes one of exactly 4 MB', async () => {
    const h = await startHost({ now: () => T0 })
    try {
      h.read = () => ({ lines: ['x'.repeat(MAX_PAGE_BYTES)], cursor: 1 })
      await assert.rejects(readPage(h.url), /over 4194304 bytes/)
      h.read = () => ({ lines: ['x'.repeat(MAX_PAGE_BYTES - 1)], cursor: 1 })
      assert.equal((await readPage(h.url)).cursor, 1)
    } finally {
      await h.close()
    }
  })

  test('a reader refuses an entry over the size cap in bytes, and takes one at it', async () => {
    const h = await startHost({ now: () => T0 })
    try {
      const atCap = sizedEntry(alice, 'note/a', MAX_ENTRY_BYTES)
      const over = sizedEntry(alice, 'note/b', MAX_ENTRY_BYTES + 1, 1)
      h.read = () => ({ lines: [encodeEntry(atCap), encodeEntry(over)], cursor: 2 })
      const page = await readPage(h.url)
      assert.deepEqual(page.versions.map((v) => v.id), [checkEntry(atCap).id])
      assert.deepEqual(page.refused.map((r) => r.reason), ['size'])
    } finally {
      await h.close()
    }
  })

  test('a host refuses an entry over the size cap in bytes', async () => {
    const h = await startHost({ now: () => T0 })
    try {
      const over = sizedEntry(alice, 'note/b', MAX_ENTRY_BYTES + 1, 1)
      const [outcome] = await publish([h.url], [folderEntry(alice, { hosts: [h.url] }, T0), over])
      assert.deepEqual(outcome!.results.map((r) => r.error), [undefined, 'size'])
    } finally {
      await h.close()
    }
  })

  test('a reader gives up on a host that stalls, before its answer or during it', async () => {
    const stall = createServer((req, res) => {
      if (req.url!.includes('after=1')) res.writeHead(200, { 'forest-cursor': '1' }).write('{')
    })
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(stall.address() as { port: number }).port}`
    try {
      await assert.rejects(readPage(url, { timeout: 200 }), { name: 'TimeoutError' })
      await assert.rejects(readPage(url, { after: 1, timeout: 200 }), { name: 'TimeoutError' })
    } finally {
      stall.closeAllConnections()
      await new Promise((resolve) => stall.close(resolve))
    }
  })

  test('a host drops a request still arriving after its timeout, with 408', async () => {
    const h = await startHost({ now: () => T0, timeout: 200 })
    try {
      const { port } = new URL(h.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write('POST /v1/entries HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{"v"')
      const answer = await new Promise<string>((resolve) => {
        let got = ''
        socket.on('data', (d) => (got += d))
        socket.on('close', () => resolve(got))
      })
      assert.match(answer, /^HTTP\/1\.1 408/)
    } finally {
      await h.close()
    }
  })
})

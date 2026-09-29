// End to end over HTTP: two hosts, an owner publishing, an index reading both, updates,
// deletes, pruning, moving hosts, and hosts that misbehave.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { publish, readAll } from '../src/client.ts'
import { type Entry, checkEntry, encodeEntry } from '../src/entry.ts'
import { DAY, type Host } from '../src/host.ts'
import { Index } from '../src/indexer.ts'
import { liveContent } from '../src/view.ts'
import { folderEntry, nextTime, ownerEntry } from '../src/write.ts'
import { MINUTE, T0, alice, bob, offerBody, profileBody, reviewBody } from './fixtures.ts'
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

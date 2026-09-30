// Grants over real hosts: an always-on signer of the person's own, with its own key, publishing
// under a permission the person signed once, while the phone is off. Nothing here uses the
// profile's key after the grant is signed, until the revocation.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { publish, readAll } from '../src/client.ts'
import { checkEntry, encodeEntry } from '../src/entry.ts'
import type { Host } from '../src/host.ts'
import { Index } from '../src/indexer.ts'
import { liveContent } from '../src/view.ts'
import { delegateEntry, folderEntry, grantEntry, ownerEntry, revokeEntry } from '../src/write.ts'
import { DAY, MINUTE, T0, alice, bob, offerBody, profileBody, reviewBody, signer } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

describe('a signer of the person’s own, under a permission', () => {
  const clock = new Clock(T0)
  let h1: Host
  let h2: Host
  let hosts: string[]
  const until = T0 + 7 * DAY
  const { entry: grant, grantId } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer'], until, label: 'My signer, offers only' }, T0 + 1)
  const index = () => new Index({ hosts, now: clock.now })
  const errorsOf = async (entries: Parameters<typeof publish>[1]) => (await publish(hosts, entries)).map((o) => o.results[0]!.message ?? o.results[0]!.error ?? 'ok')

  before(async () => {
    h1 = await startHost({ now: clock.now })
    h2 = await startHost({ now: clock.now })
    hosts = [h1.url, h2.url]
    // The owner, once, with the phone: folder, profile card, an offer of their own, the grant.
    await publish(hosts, [folderEntry(alice, { hosts }, T0), ownerEntry(alice, 'profile', profileBody('Alice'), T0), ownerEntry(alice, 'offer/mine', offerBody('30'), T0), grant])
  })
  after(async () => {
    await h1.close()
    await h2.close()
  })

  test('the phone is off: the signer posts an offer with its own key, and both hosts and an index take it', async () => {
    clock.advance(MINUTE)
    const offer = delegateEntry(signer, alice.did, grantId, 'offer/physics', offerBody('40'), clock.t)
    assert.deepEqual(await errorsOf([offer]), ['ok', 'ok'])
    const i = index()
    await i.crawl()
    const shown = i.view(alice.did)!.current.get('offer/physics')!
    assert.equal(shown.entry.by, signer.did)
    assert.equal(shown.id, checkEntry(offer).id)
  })

  test('outside the permission it is refused: a review, the profile card, the owner’s own offer', async () => {
    clock.advance(MINUTE)
    const review = delegateEntry(signer, alice.did, grantId, 'review/x', reviewBody(bob.did), clock.t)
    const card = delegateEntry(signer, alice.did, grantId, 'profile', profileBody('Hacked'), clock.t)
    const overwrite = delegateEntry(signer, alice.did, grantId, 'offer/mine', null, clock.t)
    assert.deepEqual(await errorsOf([review]), ['out-of-scope', 'out-of-scope'])
    assert.deepEqual(await errorsOf([card]), ['owner-first', 'owner-first'])
    assert.deepEqual(await errorsOf([overwrite]), ['owner-first', 'owner-first'])
  })

  test('revoked: it ends from now on. What it posted stays; a stolen key posts nothing more, backdated or not; a reader that comes later agrees', async () => {
    clock.advance(MINUTE)
    assert.deepEqual(await errorsOf([revokeEntry(alice, 'mine', clock.t)]), ['ok', 'ok'])
    clock.advance(MINUTE)
    const late = delegateEntry(signer, alice.did, grantId, 'offer/spam', offerBody('1'), clock.t)
    const backdated = delegateEntry(signer, alice.did, grantId, 'offer/spam2', offerBody('1'), T0 + 2 * MINUTE)
    assert.deepEqual(await errorsOf([late]), ['grant-not-current', 'grant-not-current'])
    assert.deepEqual(await errorsOf([backdated]), ['grant-not-current', 'grant-not-current'])

    // A month later, and past every keep day, a new index reads both feeds from the start.
    clock.advance(40 * DAY)
    h1.prune()
    h2.prune()
    const later = index()
    await later.crawl()
    const live = liveContent(later.view(alice.did)!)
    assert.equal(live.get('offer/physics')!.entry.by, signer.did, 'still there, still the signer’s')
    assert.ok(!live.has('offer/spam') && !live.has('offer/spam2'))
    // Each host kept the grant version the post arrived under, so a late reader can place it.
    assert.ok((await readAll(h1.url, { profile: alice.did })).versions.some((v) => v.id === grantId))
  })

  test('at until, by each host’s own clock: new posts refused; what was posted before stays', async () => {
    const { entry: week, grantId: weekId } = grantEntry(alice, 'week', { to: signer.did, paths: ['offer'], until: clock.t + 2 * DAY }, clock.advance(MINUTE))
    await publish(hosts, [week])
    await publish(hosts, [delegateEntry(signer, alice.did, weekId, 'offer/week', offerBody('7'), clock.advance(MINUTE))])
    clock.advance(3 * DAY)
    // A thief dates it inside the grant's life; the hosts go by their own clock.
    const backdated = delegateEntry(signer, alice.did, weekId, 'offer/after', offerBody('7'), clock.t - 2 * DAY)
    assert.deepEqual(await errorsOf([backdated]), ['grant-expired', 'grant-expired'])
    const i = index()
    await i.crawl()
    assert.ok(liveContent(i.view(alice.did)!).has('offer/week'))
    assert.ok(!liveContent(i.view(alice.did)!).has('offer/after'))
  })
})

describe('trusting arrival order', () => {
  test('FINDING: a host the person chose can slip a revoked signer’s post in before the revocation, for readers that come later; the owner removes it with a delete', async () => {
    const clock = new Clock(T0)
    const honest = await startHost({ now: clock.now })
    const bad = await startHost({ now: clock.now })
    try {
      const hosts = [honest.url, bad.url]
      const { entry: grant, grantId } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer'], until: T0 + 7 * DAY }, T0 + 1)
      await publish(hosts, [folderEntry(alice, { hosts }, T0), grant])
      const revoke = revokeEntry(alice, 'mine', T0 + MINUTE)
      await publish(hosts, [revoke])
      // The signer's key is stolen; both hosts refuse its post...
      const stolen = delegateEntry(signer, alice.did, grantId, 'offer/scam', offerBody('1'), T0 + 2 * MINUTE)
      assert.ok((await publish(hosts, [stolen])).every((o) => o.results[0]!.error === 'grant'))
      // ...but the bad host serves it in its feed just before the revocation.
      const serve = bad.read.bind(bad)
      const revokeLine = encodeEntry(revoke)
      bad.read = (options) => {
        const out = serve(options)
        const at = out.lines.indexOf(revokeLine)
        return at < 0 ? out : { lines: [...out.lines.slice(0, at), encodeEntry(stolen), ...out.lines.slice(at)], cursor: out.cursor }
      }
      const late = new Index({ hosts, now: clock.now })
      await late.crawl()
      assert.ok(liveContent(late.view(alice.did)!).has('offer/scam'), 'a later reader counts it: the order is the host’s word')

      // The owner's own entry at that path outranks any delegate's.
      await publish(hosts, [ownerEntry(alice, 'offer/scam', null, T0 + 3 * MINUTE)])
      const after = new Index({ hosts, now: clock.now })
      await after.crawl()
      assert.ok(!liveContent(after.view(alice.did)!).has('offer/scam'))
    } finally {
      await honest.close()
      await bad.close()
    }
  })
})

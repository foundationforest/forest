// An AI writer acting under a rule the owner signed, over real hosts, while the owner's phone
// is off: nothing here uses the owner's key after the grant is signed, until revocation.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { publish } from '../src/client.ts'
import { checkEntry } from '../src/entry.ts'
import type { Host } from '../src/host.ts'
import { Index } from '../src/indexer.ts'
import { liveContent } from '../src/view.ts'
import { delegateEntry, folderEntry, grantEntry, keepAll, ownerEntry, revokeEntry } from '../src/write.ts'
import { DAY, MINUTE, T0, alice, assistant, bob, offerBody, profileBody, reviewBody } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

describe('an assistant under a standing rule', () => {
  const clock = new Clock(T0)
  let h1: Host
  let h2: Host
  let hosts: string[]
  const until = T0 + 7 * DAY
  const { entry: grant, grantId } = grantEntry(alice, 'claude', { to: assistant.did, paths: ['offer'], until, label: 'Claude, offers only' }, T0 + 1)
  const index = () => new Index({ hosts, now: clock.now })
  const errorsOf = async (entries: Parameters<typeof publish>[1]) => (await publish(hosts, entries)).map((o) => o.results[0]!.error ?? 'ok')

  before(async () => {
    h1 = await startHost({ now: clock.now })
    h2 = await startHost({ now: clock.now })
    hosts = [h1.url, h2.url]
    // The owner, once, with the phone: folder, profile card, an offer of their own, the grant.
    await publish(hosts, [
      folderEntry(alice, { hosts }, T0),
      ownerEntry(alice, 'profile', profileBody('Alice'), T0),
      ownerEntry(alice, 'offer/mine', offerBody('30'), T0),
      grant,
    ])
  })
  after(async () => {
    await h1.close()
    await h2.close()
  })

  test('the phone is off: the assistant posts an offer with its own key, and both hosts and the index take it', async () => {
    clock.advance(MINUTE)
    const offer = delegateEntry(assistant, alice.did, grantId, 'offer/physics', offerBody('40'), clock.t)
    assert.deepEqual(await errorsOf([offer]), ['ok', 'ok'])
    const i = index()
    await i.crawl()
    const shown = i.view(alice.did)!.current.get('offer/physics')!
    assert.equal(shown.entry.by, assistant.did)
    assert.equal(shown.id, checkEntry(offer).id)
  })

  test('outside the rule it is refused: a review, the profile card, the owner’s own offer', async () => {
    clock.advance(MINUTE)
    const review = delegateEntry(assistant, alice.did, grantId, 'review/x', reviewBody(bob.did), clock.t)
    const card = delegateEntry(assistant, alice.did, grantId, 'profile', profileBody('Hacked'), clock.t)
    const overwrite = delegateEntry(assistant, alice.did, grantId, 'offer/mine', null, clock.t)
    assert.deepEqual(await errorsOf([review]), ['grant', 'grant'])
    assert.deepEqual(await errorsOf([card]), ['grant', 'grant'])
    assert.deepEqual(await errorsOf([overwrite]), ['grant', 'grant'])
  })

  test('revoked: the assistant’s key writes nothing more, what it wrote stops showing, and one approval keeps it', async () => {
    clock.advance(MINUTE)
    const before = index()
    await before.crawl()
    const toKeep = [before.view(alice.did)!.current.get('offer/physics')!]

    // The owner revokes (phone on, one tap) and, in the same approval, keeps the offer.
    const revoke = revokeEntry(alice, 'claude', clock.t)
    const kept = keepAll(alice, toKeep, clock.t)
    assert.deepEqual(await errorsOf([revoke, ...kept]), ['ok', 'ok'])

    // A stolen assistant key keeps trying, also backdated to before the revocation.
    clock.advance(MINUTE)
    const late = delegateEntry(assistant, alice.did, grantId, 'offer/spam', offerBody('1'), clock.t)
    const backdated = delegateEntry(assistant, alice.did, grantId, 'offer/spam2', offerBody('1'), T0 + 2 * MINUTE)
    assert.deepEqual(await errorsOf([late]), ['grant', 'grant'])
    assert.deepEqual(await errorsOf([backdated]), ['grant', 'grant'])

    const after = index()
    await after.crawl()
    const live = liveContent(after.view(alice.did)!)
    assert.equal(live.get('offer/physics')!.entry.by, undefined, 'kept: now the owner’s own version')
    assert.ok(!live.has('offer/spam') && !live.has('offer/spam2'))
  })

  test('without keeping, revocation takes down what the assistant wrote', async () => {
    const { entry: g2, grantId: id2 } = grantEntry(alice, 'helper', { to: assistant.did, paths: ['offer'], until }, clock.advance(MINUTE))
    await publish(hosts, [g2])
    await publish(hosts, [delegateEntry(assistant, alice.did, id2, 'offer/temp', offerBody('5'), clock.advance(MINUTE))])
    let i = index()
    await i.crawl()
    assert.ok(liveContent(i.view(alice.did)!).has('offer/temp'))
    await publish(hosts, [revokeEntry(alice, 'helper', clock.advance(MINUTE))])
    i = index()
    await i.crawl()
    assert.ok(!liveContent(i.view(alice.did)!).has('offer/temp'))
  })

  test('at expiry, with the phone still off: new writes refused, old ones stop showing', async () => {
    const { entry: g3, grantId: id3 } = grantEntry(alice, 'week', { to: assistant.did, paths: ['offer'], until: clock.t + 2 * DAY }, clock.advance(MINUTE))
    await publish(hosts, [g3])
    await publish(hosts, [delegateEntry(assistant, alice.did, id3, 'offer/week', offerBody('7'), clock.advance(MINUTE))])
    clock.advance(3 * DAY)
    assert.deepEqual(await errorsOf([delegateEntry(assistant, alice.did, id3, 'offer/after', offerBody('7'), clock.t)]), ['grant', 'grant'])
    const i = index()
    await i.crawl()
    assert.ok(!liveContent(i.view(alice.did)!).has('offer/week'))
  })
})

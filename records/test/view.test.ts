// The merge rules: versions, deletes, owner first, grants and arrival order. All pure, no network.

import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { describe, test } from 'node:test'
import { type Entry, checkEntry } from '../src/entry.ts'
import { type Version, liveContent, viewProfile } from '../src/view.ts'
import { delegateEntry, grantEntry, nextTime, ownerEntry, revokeEntry } from '../src/write.ts'
import { DAY, MINUTE, T0, alice, bob, offerBody, profileBody, signer, stranger } from './fixtures.ts'

const checked = (...entries: Entry[]): Version[] => entries.map((e) => checkEntry(e))
/** One feed, in the order given: what one host took in. */
const view = (entries: Entry[], now = T0 + MINUTE) => viewProfile(alice.did, [checked(...entries)], now)
const idOf = (e: Entry) => checkEntry(e).id

describe('versions', () => {
  test('an update is a newer version on top; the older one stays as history', () => {
    const v1 = ownerEntry(alice, 'offer/maths', offerBody('30'), T0)
    const v2 = ownerEntry(alice, 'offer/maths', offerBody('35'), T0 + 1000)
    const v = view([v2, v1])
    assert.equal((v.current.get('offer/maths')!.entry.body as { price: { amount: string } }).price.amount, '35')
    assert.equal(v.history.get('offer/maths')!.length, 1)
  })

  test('a delete is an empty version; the live view drops the path', () => {
    const v1 = ownerEntry(alice, 'offer/maths', offerBody('30'), T0)
    const gone = ownerEntry(alice, 'offer/maths', null, T0 + 1000)
    const v = view([v1, gone])
    assert.equal(v.current.get('offer/maths')!.entry.body, null)
    assert.equal(liveContent(v).has('offer/maths'), false)
  })

  test('the writer never loses to its own older version, whatever its clock says', () => {
    const v1 = ownerEntry(alice, 'profile', profileBody('A'), T0 + 5 * MINUTE)
    const slowClock = T0 // a phone whose clock is five minutes slow
    const v2 = ownerEntry(alice, 'profile', profileBody('B'), nextTime(slowClock, view([v1]), 'profile'))
    assert.equal((view([v1, v2], T0 + 6 * MINUTE).current.get('profile')!.entry.body as { name: string }).name, 'B')
  })

  test('entries dated more than ten minutes ahead are held back until their time', () => {
    const ahead = ownerEntry(alice, 'profile', profileBody('future'), T0 + 11 * MINUTE)
    assert.equal(view([ahead], T0).current.size, 0)
    assert.equal(view([ahead], T0).ignored.get(idOf(ahead)), 'future')
    assert.equal(view([ahead], T0 + 11 * MINUTE).current.size, 1)
  })

  test('the owner’s entries in any order, over any split into feeds, with duplicates, give the same view', () => {
    const entries = [
      ownerEntry(alice, 'profile', profileBody('A'), T0),
      ownerEntry(alice, 'profile', profileBody('B'), T0), // same time: the larger id wins
      ownerEntry(alice, 'offer/a', offerBody('1'), T0),
      ownerEntry(alice, 'offer/a', null, T0 + 1),
      ownerEntry(alice, 'offer/b', offerBody('2'), T0 + 2),
    ]
    const summary = (feeds: Version[][]) => [...viewProfile(alice.did, feeds, T0 + MINUTE).current].map(([p, v]) => `${p}:${v.id}`).sort().join()
    const expected = summary([checked(...entries)])
    for (let round = 0; round < 50; round++) {
      const shuffled = checked(...entries, ...entries.slice(0, randomInt(entries.length)))
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      const cut = randomInt(shuffled.length)
      assert.equal(summary([shuffled.slice(0, cut), shuffled.slice(cut), shuffled.slice(randomInt(cut + 1))]), expected)
    }
  })
})

describe('grants', () => {
  const until = T0 + 7 * DAY
  const { entry: grant, grantId } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer'], until, label: 'My signer, offers' }, T0)
  const written = delegateEntry(signer, alice.did, grantId, 'offer/physics', offerBody('40'), T0 + MINUTE)

  test('a delegate writes under the owner’s grant, with its own key', () => {
    const v = view([grant, written], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.equal(v.current.get('offer/physics')!.entry.by, signer.did)
  })

  test('outside its paths, it counts for nothing', () => {
    const review = delegateEntry(signer, alice.did, grantId, 'review/x', { subject: bob.did }, T0 + MINUTE)
    const sneaky = delegateEntry(signer, alice.did, grantId, 'offerx', offerBody('1'), T0 + MINUTE) // prefix is per segment
    const v = view([grant, review, sneaky], T0 + 2 * MINUTE)
    assert.equal(v.ignored.get(idOf(review)), 'out-of-scope')
    assert.equal(v.ignored.get(idOf(sneaky)), 'out-of-scope')
  })

  test('another key naming the same grant counts for nothing', () => {
    const imposter = delegateEntry(stranger, alice.did, grantId, 'offer/x', offerBody('1'), T0 + MINUTE)
    assert.equal(view([grant, imposter], T0 + 2 * MINUTE).ignored.get(idOf(imposter)), 'grant-not-for-signer')
  })

  test('what you wrote yourself, a delegate cannot overwrite or delete', () => {
    const mine = ownerEntry(alice, 'offer/maths', offerBody('30'), T0)
    const overwrite = delegateEntry(signer, alice.did, grantId, 'offer/maths', null, T0 + 2 * MINUTE)
    const v = view([grant, mine, overwrite], T0 + 3 * MINUTE)
    assert.equal(v.current.get('offer/maths')!.entry.by, undefined)
    assert.equal(v.ignored.get(idOf(overwrite)), 'owner-first')
  })

  test('an entry that arrived before its grant counts for nothing', () => {
    assert.equal(view([written, grant], T0 + 2 * MINUTE).ignored.get(idOf(written)), 'grant-not-current')
  })

  test('revoking ends a grant from then on: what arrived before stays; what arrives after never counts, however it is dated', () => {
    const revoke = revokeEntry(alice, 'mine', T0 + 10 * MINUTE)
    const late = delegateEntry(signer, alice.did, grantId, 'offer/late', offerBody('9'), T0 + 11 * MINUTE)
    const backdated = delegateEntry(signer, alice.did, grantId, 'offer/old', offerBody('9'), T0 + 2 * MINUTE) // "before" the revocation
    const v = view([grant, written, revoke, late, backdated], T0 + 30 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written), 'posted before: stays, a month later too')
    assert.equal(v.ignored.get(idOf(late)), 'grant-not-current')
    assert.equal(v.ignored.get(idOf(backdated)), 'grant-not-current')
    assert.equal(v.grants.size, 0)
  })

  test('editing a grant ends the old version from then on; reviving it does not bring back what arrived in between', () => {
    const { entry: widened, grantId: widenedId } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer', 'review'], until }, T0 + 5 * MINUTE)
    const underOld = delegateEntry(signer, alice.did, grantId, 'offer/after-edit', offerBody('1'), T0 + 6 * MINUTE)
    const underNew = delegateEntry(signer, alice.did, widenedId, 'review/1', { subject: bob.did }, T0 + 6 * MINUTE)
    let v = view([grant, written, widened, underOld, underNew], T0 + 7 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.equal(v.ignored.get(idOf(underOld)), 'grant-not-current')
    assert.equal(v.current.get('review/1')!.id, idOf(underNew))

    const revoke = revokeEntry(alice, 'mine', T0 + 10 * MINUTE)
    const between = delegateEntry(signer, alice.did, widenedId, 'offer/between', offerBody('1'), T0 + 11 * MINUTE)
    const { entry: revived } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer'], until }, T0 + 20 * MINUTE)
    v = view([grant, widened, revoke, between, revived], T0 + 21 * MINUTE)
    assert.equal(v.ignored.get(idOf(between)), 'grant-not-current')
  })

  test('there is no expiry by the reader’s clock: what arrived before until still counts a year later; what is dated after never does', () => {
    const after = delegateEntry(signer, alice.did, grantId, 'offer/after', offerBody('1'), until + 1)
    const v = view([grant, written, after], until + 365 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.equal(v.ignored.get(idOf(after)), 'after-until')
  })

  test('each feed is walked in its own order: an entry counts if any feed took it in before the revocation', () => {
    const revoke = revokeEntry(alice, 'mine', T0 + 10 * MINUTE)
    const onTime = checked(grant, written, revoke) // a host that took the post, then the revocation
    const tooLate = checked(grant, revoke, written) // a host that got the post after the revocation
    const without = checked(grant, revoke) // a host that never got the post
    const counts = (feeds: Version[][]) => viewProfile(alice.did, feeds, T0 + DAY).current.has('offer/physics')
    assert.equal(counts([onTime]), true)
    assert.equal(counts([tooLate]), false)
    assert.equal(counts([without, tooLate]), false)
    assert.equal(counts([tooLate, onTime]), true)
    assert.equal(counts([onTime, tooLate]), true, 'the order the feeds are read in does not matter')
  })

  test('a grant only the owner signed counts: a delegate cannot grant itself', () => {
    // A delegate cannot even produce a control entry: the shape check refuses it.
    assert.throws(() => delegateEntry(signer, alice.did, grantId, 'grant/mine', { to: signer.did, paths: ['review'], until }, T0), /only the owner/)
  })
})

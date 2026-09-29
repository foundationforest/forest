// The merge rules: versions, deletes, owner first, grants, keep-these. All pure, no network.

import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { describe, test } from 'node:test'
import { type Entry, checkEntry } from '../src/entry.ts'
import { type Version, liveContent, viewProfile } from '../src/view.ts'
import { delegateEntry, grantEntry, keepAll, nextTime, ownerEntry, revokeEntry } from '../src/write.ts'
import { DAY, MINUTE, T0, alice, assistant, bob, offerBody, profileBody, stranger } from './fixtures.ts'

const checked = (...entries: Entry[]): Version[] => entries.map((e) => checkEntry(e))
const view = (entries: Entry[], now = T0 + MINUTE) => viewProfile(alice.did, checked(...entries), now)

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
    assert.equal(view([ahead], T0).ignored.get(checkEntry(ahead).id), 'future')
    assert.equal(view([ahead], T0 + 11 * MINUTE).current.size, 1)
  })

  test('same entries in any order, with duplicates, give the same view', () => {
    const entries = [
      ownerEntry(alice, 'profile', profileBody('A'), T0),
      ownerEntry(alice, 'profile', profileBody('B'), T0), // same time: the larger id wins
      ownerEntry(alice, 'offer/a', offerBody('1'), T0),
      ownerEntry(alice, 'offer/a', null, T0 + 1),
      ownerEntry(alice, 'offer/b', offerBody('2'), T0 + 2),
    ]
    const summary = (es: Entry[]) => [...view(es).current].map(([p, v]) => `${p}:${v.id}`).sort().join()
    const expected = summary(entries)
    for (let round = 0; round < 50; round++) {
      const shuffled = [...entries, ...entries.slice(0, randomInt(entries.length))]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      assert.equal(summary(shuffled), expected)
    }
  })
})

describe('grants', () => {
  const until = T0 + 7 * DAY
  const { entry: grant, grantId } = grantEntry(alice, 'claude', { to: assistant.did, paths: ['offer'], until, label: 'Claude, offers' }, T0)
  const written = delegateEntry(assistant, alice.did, grantId, 'offer/physics', offerBody('40'), T0 + MINUTE)
  const writtenId = checkEntry(written).id

  test('an assistant writes under the owner’s grant, with its own key', () => {
    const v = view([grant, written], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, writtenId)
    assert.equal(v.current.get('offer/physics')!.entry.by, assistant.did)
  })

  test('outside its paths, it counts for nothing', () => {
    const review = delegateEntry(assistant, alice.did, grantId, 'review/x', { subject: bob.did }, T0 + MINUTE)
    const sneaky = delegateEntry(assistant, alice.did, grantId, 'offerx', offerBody('1'), T0 + MINUTE) // prefix is per segment
    const v = view([grant, review, sneaky], T0 + 2 * MINUTE)
    assert.equal(v.ignored.get(checkEntry(review).id), 'out-of-scope')
    assert.equal(v.ignored.get(checkEntry(sneaky).id), 'out-of-scope')
  })

  test('another key naming the same grant counts for nothing', () => {
    const imposter = delegateEntry(stranger, alice.did, grantId, 'offer/x', offerBody('1'), T0 + MINUTE)
    assert.equal(view([grant, imposter], T0 + 2 * MINUTE).ignored.get(checkEntry(imposter).id), 'grant-not-for-signer')
  })

  test('what you wrote yourself, an assistant cannot overwrite or delete', () => {
    const mine = ownerEntry(alice, 'offer/maths', offerBody('30'), T0)
    const overwrite = delegateEntry(assistant, alice.did, grantId, 'offer/maths', null, T0 + 2 * MINUTE)
    const v = view([grant, mine, overwrite], T0 + 3 * MINUTE)
    assert.equal(v.current.get('offer/maths')!.entry.by, undefined)
    assert.equal(v.ignored.get(checkEntry(overwrite).id), 'owner-first')
  })

  test('at expiry everything signed under the grant stops counting, backdated or not', () => {
    const backdated = delegateEntry(assistant, alice.did, grantId, 'offer/late', offerBody('9'), until - 1) // "signed" before until
    const before = view([grant, written, backdated], until)
    assert.equal(before.current.has('offer/physics'), true)
    const after = view([grant, written, backdated], until + 1)
    assert.equal(after.ignored.get(writtenId), 'grant-expired')
    assert.equal(after.ignored.get(checkEntry(backdated).id), 'grant-expired')
    assert.equal(after.current.has('offer/physics'), false)
  })

  test('dated outside the grant: before it existed, or after until', () => {
    const early = delegateEntry(assistant, alice.did, grantId, 'offer/early', offerBody('1'), T0 - 1)
    const late = delegateEntry(assistant, alice.did, grantId, 'offer/late', offerBody('1'), until + 1)
    const v = view([grant, early, late], until)
    assert.equal(v.ignored.get(checkEntry(early).id), 'before-grant')
    assert.equal(v.ignored.get(checkEntry(late).id), 'after-until')
  })

  test('revoking ends everything signed under it at once; reviving the grant does not bring it back', () => {
    const revoke = revokeEntry(alice, 'claude', T0 + 10 * MINUTE)
    const revoked = view([grant, written, revoke], T0 + 11 * MINUTE)
    assert.equal(revoked.ignored.get(writtenId), 'grant-not-current')
    // The owner turns the assistant back on at the same path: a new version, a new id.
    const { entry: revived } = grantEntry(alice, 'claude', { to: assistant.did, paths: ['offer'], until }, T0 + 20 * MINUTE)
    const again = view([grant, written, revoke, revived], T0 + 21 * MINUTE)
    assert.equal(again.ignored.get(writtenId), 'grant-not-current')
  })

  test('editing a grant ends what was signed under the old version', () => {
    const { entry: widened } = grantEntry(alice, 'claude', { to: assistant.did, paths: ['offer', 'review'], until }, T0 + 5 * MINUTE)
    assert.equal(view([grant, written, widened], T0 + 6 * MINUTE).ignored.get(writtenId), 'grant-not-current')
  })

  test('keep these: one approval re-signs what the owner keeps, and it stays', () => {
    const revoke = revokeEntry(alice, 'claude', T0 + 10 * MINUTE)
    const before = view([grant, written], T0 + 9 * MINUTE)
    const kept = keepAll(alice, [before.current.get('offer/physics')!], T0 + 10 * MINUTE)
    const after = view([grant, written, revoke, ...kept], T0 + 30 * DAY)
    const now = after.current.get('offer/physics')!
    assert.equal(now.entry.by, undefined)
    assert.deepEqual(now.entry.body, written.body)
  })

  test('a grant only the owner signed counts: an assistant cannot grant itself', () => {
    // A delegate cannot even produce a control entry: the shape check refuses it.
    assert.throws(() => delegateEntry(assistant, alice.did, grantId, 'grant/mine', { to: assistant.did, paths: ['review'], until }, T0), /only the owner/)
  })
})

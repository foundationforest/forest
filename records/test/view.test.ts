// The view: versions, deletes, the owner first, access keys and permissions. All pure, no network.

import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { describe, test } from 'node:test'
import { type Checked, type SignedRecord, checkRecord } from '../src/record.ts'
import { liveContent, viewProfile } from '../src/view.ts'
import { accessRecord, hostsRecord, nextTime, ownerRecord, permissionsRecord } from '../src/write.ts'
import { DAY, MINUTE, T0, accessKey, alice, allow, bob, offerBody, profileBody, stranger } from './fixtures.ts'

const checked = (...records: SignedRecord[]): Checked[] => records.map((r) => checkRecord(r))
const view = (records: SignedRecord[], now = T0 + MINUTE) => viewProfile(alice.address, checked(...records), now)
const idOf = (r: SignedRecord) => checkRecord(r).id

describe('versions', () => {
  test('the newest time wins, whatever order the records come in', () => {
    const v1 = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)
    const v2 = ownerRecord(alice, 'offer/maths', offerBody('35'), T0 + 1000)
    assert.equal(view([v2, v1]).current.get('offer/maths')!.id, idOf(v2))
    assert.equal(view([v1, v2]).ignored.get(idOf(v1)), 'older')
  })

  test('a null body deletes; the live content drops the path', () => {
    const v1 = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)
    const gone = ownerRecord(alice, 'offer/maths', null, T0 + 1000)
    const v = view([v1, gone])
    assert.equal(v.current.get('offer/maths')!.record.body, null)
    assert.equal(liveContent(v).has('offer/maths'), false)
  })

  test('an edit never loses to its own older version, whatever the app’s clock says', () => {
    const v1 = ownerRecord(alice, 'profile', profileBody('A'), T0 + 5 * MINUTE)
    const slowClock = T0 // a phone whose clock is five minutes slow
    const v2 = ownerRecord(alice, 'profile', profileBody('B'), nextTime(slowClock, view([v1], T0 + 6 * MINUTE), 'profile'))
    assert.equal(view([v1, v2], T0 + 6 * MINUTE).current.get('profile')!.id, idOf(v2))
  })

  test('records dated more than ten minutes ahead are held back until their time', () => {
    const ahead = ownerRecord(alice, 'profile', profileBody('future'), T0 + 11 * MINUTE)
    assert.equal(view([ahead], T0).current.size, 0)
    assert.equal(view([ahead], T0).ignored.get(idOf(ahead)), 'future')
    assert.equal(view([ahead], T0 + 11 * MINUTE).current.size, 1)
  })

  test('the hosts record is the owner’s newest; a delete leaves no hosts', () => {
    const one = hostsRecord(alice, ['https://a.example'], T0)
    const two = hostsRecord(alice, ['https://b.example', 'https://c.example'], T0 + 1)
    assert.deepEqual(view([two, one]).hosts, ['https://b.example', 'https://c.example'])
    assert.deepEqual(view([one, two, hostsRecord(alice, null, T0 + 2)]).hosts, [])
    assert.deepEqual(view([]).hosts, [])
  })

  test('any set of records, in any order, with duplicates, gives the same view', () => {
    const records = [
      permissionsRecord(alice, [allow(accessKey, ['offer'])], T0),
      ownerRecord(alice, 'profile', profileBody('A'), T0),
      ownerRecord(alice, 'profile', profileBody('B'), T0), // same time: the larger id wins
      ownerRecord(alice, 'offer/a', offerBody('1'), T0),
      ownerRecord(alice, 'offer/a', null, T0 + 1),
      accessRecord(accessKey, alice.address, 'offer/a', offerBody('9'), T0 + 2), // the owner wrote here
      accessRecord(accessKey, alice.address, 'offer/b', offerBody('2'), T0 + 2),
      accessRecord(accessKey, alice.address, 'offer/b', offerBody('3'), T0 + 3),
      accessRecord(stranger, alice.address, 'offer/c', offerBody('4'), T0 + 3),
    ]
    const summary = (list: Checked[]) => [...viewProfile(alice.address, list, T0 + MINUTE).current].map(([p, c]) => `${p}:${c.id}`).sort().join()
    const expected = summary(checked(...records))
    for (let round = 0; round < 50; round++) {
      const shuffled = checked(...records, ...records.slice(0, randomInt(records.length)))
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      assert.equal(summary(shuffled), expected)
    }
  })
})

describe('access keys and permissions', () => {
  const permissions = permissionsRecord(alice, [allow(accessKey, ['offer'])], T0)
  const written = accessRecord(accessKey, alice.address, 'offer/physics', offerBody('40'), T0 + MINUTE)

  test('a key the permissions record lists with scope write writes at the paths it allows', () => {
    const v = view([permissions, written], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.deepEqual(v.access, [{ key: accessKey.address, scope: 'write', paths: ['offer'] }])
  })

  test('without a permissions record, or outside its paths, an access key’s record counts for nothing', () => {
    assert.equal(view([written]).ignored.get(idOf(written)), 'not-allowed')
    const review = accessRecord(accessKey, alice.address, 'review/x', { subject: bob.address }, T0 + MINUTE)
    const sneaky = accessRecord(accessKey, alice.address, 'offerx', offerBody('1'), T0 + MINUTE) // a prefix covers whole segments
    const v = view([permissions, review, sneaky], T0 + 2 * MINUTE)
    assert.equal(v.ignored.get(idOf(review)), 'not-allowed')
    assert.equal(v.ignored.get(idOf(sneaky)), 'not-allowed')
  })

  test('with no paths, a write key covers every content path but those profile and grants cover; with paths, only those', () => {
    const anywhere = permissionsRecord(alice, [allow(accessKey)], T0)
    const at = (path: string) => accessRecord(accessKey, alice.address, path, { text: path }, T0 + MINUTE)
    const v = view([anywhere, ...['offer/x', 'review/1', 'note/a/b', 'profiles', 'grantsx', 'profile', 'profile/x', 'grants', 'grants/x'].map(at)], T0 + 2 * MINUTE)
    assert.deepEqual([...liveContent(v).keys()].sort(), ['grantsx', 'note/a/b', 'offer/x', 'profiles', 'review/1'])
    const named = view([permissionsRecord(alice, [allow(accessKey, ['profile', 'grants'])], T0), at('profile'), at('grants'), at('offer/x')], T0 + 2 * MINUTE)
    assert.deepEqual([...liveContent(named).keys()].sort(), ['grants', 'profile'], 'paths can name them; then only those')
    assert.equal(liveContent(view([permissionsRecord(alice, [allow(accessKey, [])], T0), at('offer/x')])).size, 0, 'an empty list covers nothing')
  })

  test('only a write key writes: a record by a key listed as message or pay counts for nothing', () => {
    for (const scope of ['message', 'pay'] as const) {
      const v = view([permissionsRecord(alice, [allow(accessKey, undefined, scope)], T0), written], T0 + 2 * MINUTE)
      assert.equal(v.ignored.get(idOf(written)), 'not-allowed', scope)
    }
  })

  test('a key the permissions record does not list counts for nothing', () => {
    const imposter = accessRecord(stranger, alice.address, 'offer/x', offerBody('1'), T0 + MINUTE)
    assert.equal(view([permissions, imposter]).ignored.get(idOf(imposter)), 'not-allowed')
  })

  test('the owner wins: an access key cannot overwrite or delete what the owner wrote, even later', () => {
    const mine = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)
    const overwrite = accessRecord(accessKey, alice.address, 'offer/maths', null, T0 + 2 * MINUTE)
    const v = view([permissions, mine, overwrite], T0 + 3 * MINUTE)
    assert.equal(v.current.get('offer/maths')!.id, idOf(mine))
    assert.equal(v.ignored.get(idOf(overwrite)), 'owner-wins')
  })

  test('the owner overrides an access key by writing at its path, at any time', () => {
    const fix = ownerRecord(alice, 'offer/physics', null, T0) // dated before the access key's record
    const v = view([permissions, written, fix], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(fix))
  })

  test('removing a write key is setting its scope to revoked: it is still listed, so what it wrote still counts, whatever the date', () => {
    const revoked = permissionsRecord(alice, [allow(accessKey, ['offer'], 'revoked')], T0 + 10 * MINUTE)
    const v = view([permissions, written, revoked], T0 + 365 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written), 'a year later')
    const outside = accessRecord(accessKey, alice.address, 'review/1', { subject: bob.address }, T0 + MINUTE)
    assert.equal(view([revoked, outside]).ignored.get(idOf(outside)), 'not-allowed', 'a revoked key keeps its paths')
  })

  test('deleting a key’s entry, or the permissions record, disowns what it wrote: it stops counting', () => {
    const dropped = permissionsRecord(alice, [], T0 + 10 * MINUTE)
    const v = view([permissions, written, dropped], T0 + 30 * DAY)
    assert.equal(v.current.has('offer/physics'), false)
    assert.equal(v.ignored.get(idOf(written)), 'not-allowed')
    assert.equal(view([permissions, written, permissionsRecord(alice, null, T0 + 10 * MINUTE)], T0 + DAY).current.has('offer/physics'), false)
  })

  test('narrowing its paths ends what it wrote outside them; another access key is untouched', () => {
    const other = accessRecord(stranger, alice.address, 'review/1', { subject: bob.address }, T0 + MINUTE)
    const both = permissionsRecord(alice, [allow(accessKey, ['offer', 'note']), allow(stranger, ['review'])], T0 + 1)
    const note = accessRecord(accessKey, alice.address, 'note/a', { text: 'x' }, T0 + MINUTE)
    const narrowed = permissionsRecord(alice, [allow(accessKey, ['note']), allow(stranger, ['review'])], T0 + 5 * MINUTE)
    const v = view([both, written, note, other, narrowed], T0 + 6 * MINUTE)
    assert.equal(v.current.has('offer/physics'), false)
    assert.equal(v.current.get('note/a')!.id, idOf(note))
    assert.equal(v.current.get('review/1')!.id, idOf(other))
  })

  test('an access key back in the permissions record brings its records back: the view is only what is current', () => {
    const dropped = permissionsRecord(alice, [], T0 + 10 * MINUTE)
    const back = permissionsRecord(alice, [allow(accessKey, ['offer'])], T0 + 20 * MINUTE)
    assert.equal(view([permissions, written, dropped, back], T0 + DAY).current.get('offer/physics')!.id, idOf(written))
  })

  test('only the owner’s permissions count: an access key cannot list itself, or use one profile’s permissions in another', () => {
    assert.throws(() => accessRecord(accessKey, alice.address, 'permissions', { access: [allow(accessKey, ['review'])] }, T0), /only the owner/)
    const intoBob = accessRecord(accessKey, bob.address, 'offer/x', offerBody('1'), T0 + 1)
    const v = viewProfile(bob.address, checked(permissions, intoBob), T0 + MINUTE)
    assert.equal(v.ignored.get(idOf(intoBob)), 'not-allowed')
  })
})

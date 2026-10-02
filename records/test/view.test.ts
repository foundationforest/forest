// The view: versions, deletes, the owner first, writer keys and permissions. All pure, no network.

import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { describe, test } from 'node:test'
import { type Checked, type SignedRecord, checkRecord } from '../src/record.ts'
import { liveContent, viewProfile } from '../src/view.ts'
import { hostsRecord, nextTime, ownerRecord, permissionsRecord, writerRecord } from '../src/write.ts'
import { DAY, MINUTE, T0, alice, allow, bob, offerBody, profileBody, stranger, writer } from './fixtures.ts'

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

  test('the writer never loses to its own older version, whatever its clock says', () => {
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
      permissionsRecord(alice, [allow(writer, ['offer'], T0 + DAY)], T0),
      ownerRecord(alice, 'profile', profileBody('A'), T0),
      ownerRecord(alice, 'profile', profileBody('B'), T0), // same time: the larger id wins
      ownerRecord(alice, 'offer/a', offerBody('1'), T0),
      ownerRecord(alice, 'offer/a', null, T0 + 1),
      writerRecord(writer, alice.address, 'offer/a', offerBody('9'), T0 + 2), // the owner wrote here
      writerRecord(writer, alice.address, 'offer/b', offerBody('2'), T0 + 2),
      writerRecord(writer, alice.address, 'offer/b', offerBody('3'), T0 + 3),
      writerRecord(stranger, alice.address, 'offer/c', offerBody('4'), T0 + 3),
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

describe('writer keys and permissions', () => {
  const until = T0 + 7 * DAY
  const permissions = permissionsRecord(alice, [allow(writer, ['offer'], until)], T0)
  const written = writerRecord(writer, alice.address, 'offer/physics', offerBody('40'), T0 + MINUTE)

  test('a writer key the permissions record lists writes at the paths it allows', () => {
    const v = view([permissions, written], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.deepEqual(v.writers, [allow(writer, ['offer'], until)])
  })

  test('without a permissions record, or outside its paths, a writer record counts for nothing', () => {
    assert.equal(view([written]).ignored.get(idOf(written)), 'not-allowed')
    const review = writerRecord(writer, alice.address, 'review/x', { subject: bob.address }, T0 + MINUTE)
    const sneaky = writerRecord(writer, alice.address, 'offerx', offerBody('1'), T0 + MINUTE) // a prefix covers whole segments
    const v = view([permissions, review, sneaky], T0 + 2 * MINUTE)
    assert.equal(v.ignored.get(idOf(review)), 'not-allowed')
    assert.equal(v.ignored.get(idOf(sneaky)), 'not-allowed')
  })

  test('a key the permissions record does not list counts for nothing', () => {
    const imposter = writerRecord(stranger, alice.address, 'offer/x', offerBody('1'), T0 + MINUTE)
    assert.equal(view([permissions, imposter]).ignored.get(idOf(imposter)), 'not-allowed')
  })

  test('the owner wins: a writer cannot overwrite or delete what the owner wrote, even later', () => {
    const mine = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)
    const overwrite = writerRecord(writer, alice.address, 'offer/maths', null, T0 + 2 * MINUTE)
    const v = view([permissions, mine, overwrite], T0 + 3 * MINUTE)
    assert.equal(v.current.get('offer/maths')!.id, idOf(mine))
    assert.equal(v.ignored.get(idOf(overwrite)), 'owner-wins')
  })

  test('the owner overrides a writer by writing at its path, at any time', () => {
    const fix = ownerRecord(alice, 'offer/physics', null, T0) // dated before the writer's record
    const v = view([permissions, written, fix], T0 + 2 * MINUTE)
    assert.equal(v.current.get('offer/physics')!.id, idOf(fix))
  })

  test('removing a writer key is setting its until to now: what it already wrote still counts, nothing dated from then on does', () => {
    const removedAt = T0 + 10 * MINUTE
    const removed = permissionsRecord(alice, [allow(writer, ['offer'], removedAt)], removedAt)
    const atRemoval = writerRecord(writer, alice.address, 'offer/at', offerBody('1'), removedAt)
    const later = writerRecord(writer, alice.address, 'offer/later', offerBody('1'), removedAt + DAY)
    const v = view([permissions, written, removed, atRemoval, later], T0 + 30 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written), 'written before removal: still counts a month later')
    assert.equal(v.ignored.get(idOf(atRemoval)), 'not-allowed', 'dated at until is not before it')
    assert.equal(v.ignored.get(idOf(later)), 'not-allowed')
  })

  test('a writer with no until has no end', () => {
    const open = permissionsRecord(alice, [allow(writer, ['offer'])], T0)
    const years = writerRecord(writer, alice.address, 'offer/years', offerBody('1'), T0 + 3 * 365 * DAY)
    const v = view([open, written, years], T0 + 3 * 365 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written))
    assert.equal(v.current.get('offer/years')!.id, idOf(years))
  })

  test('a key left out of the permissions record, or a deleted permissions record, counts for nothing: what it wrote stops counting', () => {
    const dropped = permissionsRecord(alice, [], T0 + 10 * MINUTE)
    const v = view([permissions, written, dropped], T0 + 30 * DAY)
    assert.equal(v.current.has('offer/physics'), false)
    assert.equal(v.ignored.get(idOf(written)), 'not-allowed')
    assert.equal(view([permissions, written, permissionsRecord(alice, null, T0 + 10 * MINUTE)], T0 + DAY).current.has('offer/physics'), false)
  })

  test('narrowing its paths ends what it wrote outside them; another writer key is untouched', () => {
    const other = writerRecord(stranger, alice.address, 'review/1', { subject: bob.address }, T0 + MINUTE)
    const both = permissionsRecord(alice, [allow(writer, ['offer', 'note'], until), allow(stranger, ['review'], until)], T0 + 1)
    const note = writerRecord(writer, alice.address, 'note/a', { text: 'x' }, T0 + MINUTE)
    const narrowed = permissionsRecord(alice, [allow(writer, ['note'], until), allow(stranger, ['review'], until)], T0 + 5 * MINUTE)
    const v = view([both, written, note, other, narrowed], T0 + 6 * MINUTE)
    assert.equal(v.current.has('offer/physics'), false)
    assert.equal(v.current.get('note/a')!.id, idOf(note))
    assert.equal(v.current.get('review/1')!.id, idOf(other))
  })

  test('a writer key back in the permissions record brings its records back: the view is only what is current', () => {
    const dropped = permissionsRecord(alice, [], T0 + 10 * MINUTE)
    const back = permissionsRecord(alice, [allow(writer, ['offer'], until)], T0 + 20 * MINUTE)
    assert.equal(view([permissions, written, dropped, back], T0 + DAY).current.get('offer/physics')!.id, idOf(written))
  })

  test('until is checked against the record’s own time: no reader’s clock ends anything', () => {
    const late = writerRecord(writer, alice.address, 'offer/late', offerBody('1'), until)
    const v = view([permissions, written, late], until + 365 * DAY)
    assert.equal(v.current.get('offer/physics')!.id, idOf(written), 'dated before until: still counts a year later')
    assert.equal(v.ignored.get(idOf(late)), 'not-allowed', 'dated at until or after: never counts')
  })

  test('only the owner’s permissions count: a writer cannot list itself, or use one profile’s permissions in another', () => {
    assert.throws(() => writerRecord(writer, alice.address, 'permissions', { writers: [allow(writer, ['review'], until)] }, T0), /only the owner/)
    const intoBob = writerRecord(writer, bob.address, 'offer/x', offerBody('1'), T0 + 1)
    const v = viewProfile(bob.address, checked(permissions, intoBob), T0 + MINUTE)
    assert.equal(v.ignored.get(idOf(intoBob)), 'not-allowed')
  })
})

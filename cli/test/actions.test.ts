// Every action, against records' reference host on loopback, and every refusal: no key, a key of
// another scope, a key past its paths, the main key or the inbox key handed over, a path the owner
// wrote, a body that breaks its shape. What lands on the host is read back with the records library
// and the owners' own keys, never through this tool.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { deliver, pull, pullRequest, readProfile } from '../../records/src/index.ts'
import { message, openMessage } from '../../records/src/private.ts'
import type { MainKey } from '../../keys/src/index.ts'
import { ACTIONS, checkArgs } from '../src/actions.ts'
import { type Context, NO_KEY, Refusal } from '../src/forest.ts'
import { KEYS, MARKET, SCORES, type World, buyer, buyerInbox, messageKey, offer, quiet, seller, sellerInbox, strayKey, world, writeKey } from './setup.ts'

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

const run = (name: string, args: { [name: string]: unknown }, ctx: Context): Promise<any> => {
  const action = ACTIONS.find((a) => a.name === name)!
  return action.run(checkArgs(action, args), ctx)
}
const refused = (promise: Promise<unknown>, why: string | RegExp) =>
  assert.rejects(promise, (err: Error) => {
    assert.ok(err instanceof Refusal, err.stack)
    if (typeof why === 'string') assert.equal(err.message, why)
    else assert.match(err.message, why)
    return true
  })

/** The buyer's folder, as its host serves it now. */
const live = async () => (await readProfile([w.host.url], buyer.address, Date.now())).current

/** Every message to `owner`, pulled by its main key and opened with its inbox key. */
async function opened(owner: MainKey, identity: string) {
  const page = await pull(w.host.url, pullRequest(owner, 0, Date.now()))
  return Promise.all(page.messages.map((m) => openMessage(m.message, identity)))
}

const PAY_LINK = `https://forest.foundation/pay?v=2&offer=${seller.address}/offer/maths`

describe('no key', () => {
  test('a market, from the index, as its own word', async () => {
    assert.deepEqual(await run('market', { market: 'tutoring' }, w.ctx()), { index: w.index, market: 'tutoring', says: MARKET })
    await refused(run('market', { market: 'gardening' }, w.ctx()), /gave nothing for markets\/gardening\.json/)
    await refused(run('market', { market: 'tutoring' }, { keys: {} }), 'no index set; set --index')
  })

  test("a profile: its card and offers from its hosts, every signature checked, and the index's summary beside them", async () => {
    const p = await run('profile', { address: seller.address }, w.ctx())
    assert.deepEqual(p.hosts, [w.host.url])
    assert.equal(p.card.body.role, 'seller')
    assert.deepEqual(p.offers.map((o: { path: string }) => o.path), ['offer/maths'])
    assert.deepEqual(p.reviews, [])
    assert.deepEqual(p.index, SCORES)
    // Without an index, the hosts alone.
    assert.equal((await run('profile', { address: buyer.address }, { hosts: [w.host.url], keys: {} })).index, null)
    // An index that has nothing for it hides nothing the hosts serve.
    const own = await run('profile', { address: buyer.address }, w.ctx())
    assert.match(own.index.unread, /gave nothing/)
    assert.deepEqual(own.offers.map((o: { path: string }) => o.path), ['offer/owned'])
  })

  test('the hosts to start from: the public list when none is given; out of reach when no host there has the profile', async () => {
    assert.equal((await run('profile', { address: seller.address }, { hostsList: w.hostsList, keys: {} })).card.body.role, 'seller')
    await refused(run('profile', { address: seller.address }, { hostsList: `${w.index}/no-list.json`, keys: {} }), 'no hosts to start from; set --host')
    await refused(run('profile', { address: strayKey.address }, w.ctx()), /^no records for .*: a profile on a host outside that list is out of reach until the host is added/)
    await refused(run('profile', { address: seller.address }, { hosts: ['http://example.com'], keys: {} }), /is not a host/)
    await refused(run('profile', { address: 'nobody' }, w.ctx()), "nobody is not a profile's address")
  })
})

describe('a write key', () => {
  test("posts, updates and removes an offer, and posts a review, each landing as the access key's record", async () => {
    const write = w.ctx({ write: KEYS.write })
    const posted = await run('post-offer', { offer: offer('Physics, one hour.'), id: 'physics' }, write)
    assert.deepEqual([posted.path, posted.hosts], ['offer/physics', [w.host.url]])
    let at = (await live()).get('offer/physics')!.record
    assert.equal(at.by, writeKey.address)
    assert.equal(at.body!.description, 'Physics, one hour.')
    const createdAt = at.body!.createdAt
    assert.match(String(createdAt), /^\d{4}-\d\d-\d\dT/, 'createdAt is set when missing')

    await run('update-offer', { id: 'physics', offer: offer('Physics, ninety minutes.') }, write)
    at = (await live()).get('offer/physics')!.record
    assert.equal(at.body!.description, 'Physics, ninety minutes.')
    assert.equal(at.body!.createdAt, createdAt, 'an update keeps when the offer was made')

    await run('remove-offer', { id: 'physics' }, write)
    assert.equal((await live()).get('offer/physics')!.record.body, null)

    assert.match((await run('post-offer', { offer: offer('Chemistry.') }, write)).path, /^offer\/[0-9a-f]{16}$/)

    const review = await run('post-review', { review: { subject: seller.address, ratings: { overall: '9' }, text: 'Clear and on time.' } }, w.ctx({ write: KEYS.review }))
    assert.equal((await live()).get(review.path)!.record.body!.subject, seller.address)
  })

  test("refuses before signing: no key, another scope, past its paths, the main key, the owner's path, a broken shape", async () => {
    const others = w.ctx({ message: KEYS.message, read: KEYS.read })
    await refused(run('post-offer', { offer: offer('x') }, others), NO_KEY)
    await refused(run('update-offer', { id: 'x', offer: offer('x') }, others), NO_KEY)
    await refused(run('remove-offer', { id: 'x' }, others), NO_KEY)
    await refused(run('post-review', { review: { subject: seller.address } }, others), NO_KEY)

    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.message })), 'this key is listed as a message key, not a write key; use request')
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.stray })), `this write key is not listed in ${buyer.address}'s permissions record; use request`)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.review })), /^this write key writes only under review, not at offer\/[0-9a-f]+; use request$/)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: KEYS.main })), /main key; give an access key/)
    await refused(run('post-offer', { offer: offer('x') }, w.ctx({ write: 'not a key' })), /not 32 bytes in base64url/)

    const write = w.ctx({ write: KEYS.write })
    await refused(run('update-offer', { id: 'owned', offer: offer('x') }, write), "the owner wrote offer/owned; only the owner's app can change it; use request")
    await refused(run('remove-offer', { id: 'owned' }, write), "the owner wrote offer/owned; only the owner's app can change it; use request")
    await refused(run('remove-offer', { id: 'never' }, write), 'nothing at offer/never')
    await refused(run('post-offer', { offer: { direction: 'sideways', description: 'x' } }, write), /^the offer does not fit its shape: offer\/direction must be equal to one of the allowed values/)
    await refused(run('post-offer', { offer: offer('x'), id: 'Not/This' }, write), /^an id is/)
    await refused(run('post-offer', { offer: offer('x') }, { ...write, profile: undefined }), /^no profile given/)
    assert.equal((await live()).get('offer/owned')!.record.body!.description, 'Maths, written by the main key.')
  })
})

describe('a read key', () => {
  test('opens the private records sealed to it, and only those', async () => {
    const out = await run('private', {}, w.ctx({ read: KEYS.read }))
    assert.deepEqual(out.opened.map((r: { path: string; body: unknown }) => [r.path, r.body]), [['notes/1', { text: 'Tuesdays suit me.' }]])
    assert.equal(out.unopened, 1, 'notes/2 is sealed to the inbox key alone')
    assert.deepEqual((await run('private', { path: 'offer' }, w.ctx({ read: KEYS.read }))).opened, [])
  })

  test('refuses no key, the inbox key, and a read key the folder does not list', async () => {
    await refused(run('private', {}, w.ctx({ write: KEYS.write })), NO_KEY)
    await refused(run('private', {}, w.ctx({ read: KEYS.inbox })), /inbox key; give a read key/)
    await refused(run('private', {}, w.ctx({ read: KEYS.read }, seller.address)), `this read key is not listed in ${seller.address}'s permissions record; use request`)
    await refused(run('private', {}, w.ctx({ read: 'AGE-SECRET-KEY-1ABC' })), /not an age identity/)
  })
})

describe('a message key', () => {
  test("sends to another profile's inbox, which its owner opens with its own inbox key", async () => {
    const sent = await run('send', { to: seller.address, text: 'Is Tuesday at six free?' }, w.ctx({ message: KEYS.message }))
    assert.deepEqual(sent.hosts, [w.host.url])
    const got = await opened(seller, sellerInbox.identity)
    assert.deepEqual(got.map((m) => [m.from, m.key, m.body]), [[buyer.address, messageKey.address, { text: 'Is Tuesday at six free?' }]])
  })

  test("requests: a message to the profile's own inbox, which the person's app opens with the inbox key", async () => {
    await run('request', { what: 'pay', details: { offer: PAY_LINK, note: 'Two hours on Tuesday.' } }, w.ctx({ message: KEYS.message }))
    const mine = await opened(buyer, buyerInbox.identity)
    assert.deepEqual(mine.map((m) => [m.from, m.body]), [[buyer.address, { request: 'pay', offer: PAY_LINK, note: 'Two hours on Tuesday.' }]])
  })

  test('pulls the inbox: opened with a read key the inbox lists, sealed without one, and newer only after the cursors', async () => {
    const card = (await live()).get('profile')!.record.body!
    await deliver([w.host.url], [await message(seller, buyer.address, { text: 'Tuesday at six, yes.' }, Date.now(), card)])
    const all = await run('inbox', {}, w.ctx({ message: KEYS.message, read: KEYS.read }))
    assert.deepEqual(
      all.messages.map((m: { from: string; body: unknown }) => [m.from, m.body]),
      [
        [buyer.address, { request: 'pay', offer: PAY_LINK, note: 'Two hours on Tuesday.' }],
        [seller.address, { text: 'Tuesday at six, yes.' }],
      ],
    )
    const sealed = await run('inbox', {}, w.ctx({ message: KEYS.message }))
    assert.deepEqual(sealed.messages.map((m: { sealed?: true; body?: unknown }) => [m.sealed, m.body]), [[true, undefined], [true, undefined]])
    assert.deepEqual((await run('inbox', { after: all.cursors }, w.ctx({ message: KEYS.message }))).messages, [])
  })

  test('refuses no key, another scope, the inbox key, a grant, and a profile with no inbox', async () => {
    const others = w.ctx({ write: KEYS.write, read: KEYS.read })
    await refused(run('send', { to: seller.address, text: 'x' }, others), NO_KEY)
    await refused(run('request', { what: 'post' }, others), NO_KEY)
    await refused(run('inbox', {}, others), NO_KEY)
    await refused(run('send', { to: seller.address, text: 'x' }, w.ctx({ message: KEYS.write })), 'this key is listed as a write key, not a message key; use request')
    await refused(run('inbox', {}, w.ctx({ message: KEYS.write })), 'this key is listed as a write key, not a message key; use request')
    await refused(run('inbox', {}, w.ctx({ message: KEYS.message, read: KEYS.inbox })), /inbox key; give a read key/)
    await refused(run('inbox', { after: { [w.host.url]: 'soon' } }, w.ctx({ message: KEYS.message })), /^after holds the cursors/)
    await refused(run('send', { to: seller.address, body: { grant: { key: KEYS.write } } }, w.ctx({ message: KEYS.message })), /never carries a grant/)
    await refused(run('send', { to: quiet.address, text: 'x' }, w.ctx({ message: KEYS.message })), `${quiet.address} has no inbox this tool can read; nothing can be sent there`)
    await refused(run('send', { to: seller.address }, w.ctx({ message: KEYS.message })), 'give text or body, one of them')
    await refused(run('request', { what: 'pay', details: { request: 'post' } }, w.ctx({ message: KEYS.message })), /goes in what/)
  })
})

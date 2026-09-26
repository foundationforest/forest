import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKET_KEYS, SHAPES, SIDE_ROLES, loadLexiconDocs, rolesOf, shapeId, validateMarket, validateRecord } from '../src/validate.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const examples = join(root, 'examples')
const marketFile = join(examples, 'markets', 'online-tutors.json')

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const example = (shape) => read(join(examples, `${shape}.json`))
const market = () => read(marketFile)

function assertRejected(result, pattern) {
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n  ${result.errors.join('\n  ')}`,
  )
}

// Lexicons

test('the four lexicons load, and only those four', () => {
  const docs = loadLexiconDocs()
  assert.deepEqual(Object.keys(docs), SHAPES)
  for (const shape of SHAPES) {
    assert.equal(docs[shape].id, shapeId(shape))
    assert.equal(docs[shape].defs.main.type, 'record')
  }
  assert.equal(docs.profile.defs.main.key, 'literal:self')
})

// Records against their lexicon

for (const shape of SHAPES) {
  test(`example ${shape} is a valid ${shape}`, () => {
    assert.deepEqual(validateRecord(example(shape)), { ok: true, shape, errors: [] })
  })
}

test('a record of an unknown shape is rejected', () => {
  assertRejected(validateRecord({ $type: 'foundation.forest.lesson' }), /unknown shape/)
  assertRejected(validateRecord({ name: 'no type' }), /unknown shape/)
  assertRejected(validateRecord('not an object'), /must be a JSON object/)
})

test('a post may leave out its price; a market with money asks for one', () => {
  const post = example('post')
  delete post.price
  assert.deepEqual(validateRecord(post), { ok: true, shape: 'post', errors: [] })
  assertRejected(validateRecord(post, { market: market() }), /must have the property "price": deals in online-tutors are paid/)
  const unpaid = { ...market(), money: false }
  assert.deepEqual(validateRecord(post, { market: unpaid }), { ok: true, shape: 'post', errors: [] }, 'no money: no price needed')
  assert.deepEqual(validateRecord(example('post'), { market: unpaid }), { ok: true, shape: 'post', errors: [] }, 'and a price is not refused')
})

const LISBON = { lat: '38.72', lon: '-9.14', precisionKm: 2, area: 'Alfama, Lisbon' }

test('a post may leave out remote, with or without a location', () => {
  const post = example('post')
  delete post.remote
  assert.equal(validateRecord(post).ok, true)
  post.location = LISBON
  assert.deepEqual(validateRecord(post), { ok: true, shape: 'post', errors: [] })
})

test('a location is a point in degrees as decimal text, a precision in whole km from 0, and a place', () => {
  for (const location of [
    LISBON,
    { ...LISBON, precisionKm: 0, lat: '38.7139', lon: '-9.1394' },
    { ...LISBON, precisionKm: 20000, lat: '0', lon: '180' },
    { ...LISBON, lat: '-90', lon: '-180.0' },
  ]) {
    assert.deepEqual(validateRecord({ ...example('post'), location }), { ok: true, shape: 'post', errors: [] }, JSON.stringify(location))
  }
  const cases = [
    [{ ...LISBON, lat: 38.72 }, /location\/lat must be a string/],
    [{ ...LISBON, lat: '38.71391' }, /location\/lat must be degrees from -90 to 90 as decimal text with at most 4 decimals/],
    [{ ...LISBON, lat: '90.5' }, /location\/lat must be degrees from -90 to 90/],
    [{ ...LISBON, lon: '-180.01' }, /location\/lon must be degrees from -180 to 180/],
    [{ ...LISBON, lon: '9,14' }, /location\/lon must be degrees/],
    [{ ...LISBON, precisionKm: -1 }, /precisionKm can not be less than 0/],
    [{ ...LISBON, precisionKm: 20001 }, /precisionKm can not be greater than 20000/],
    [{ ...LISBON, precisionKm: 1.5 }, /precisionKm must be an integer/],
    [{ lat: '38.72', lon: '-9.14', precisionKm: 2 }, /location must have the property "area"/],
    ['Lisbon', /location must be an object/],
  ]
  for (const [location, pattern] of cases) {
    assertRejected(validateRecord({ ...example('post'), location }), pattern)
  }
})

test('a post priced per week is rejected', () => {
  const post = example('post')
  post.price.per = 'week'
  assertRejected(validateRecord(post), /price\/per must be one of \(hour\|day\|job\)/)
})

test('a post names its token by mint, not by symbol', () => {
  const post = example('post')
  delete post.price.mint
  post.price.token = 'USDC'
  assertRejected(validateRecord(post), /price must have the property "mint"/)
})

const ARBITER = 'FKmToEDEJAXW8Pc72r9VnkxfzyE1Z6BbhHSJGfS132ud'

test('terms are optional on an offer and on a request, and every option is off unless set', () => {
  const offer = example('post')
  assert.equal(offer.terms, undefined, 'the example offer turns on no option')
  assert.deepEqual(validateRecord(offer), { ok: true, shape: 'post', errors: [] })
  assert.deepEqual(validateRecord({ ...offer, direction: 'request' }), { ok: true, shape: 'post', errors: [] })
  for (const terms of [
    {},
    { arbiter: ARBITER },
    { timer: { days: 7, to: 'seller' } },
    { timer: { days: 30, to: 'buyer' } },
    { arbiter: ARBITER, timer: { days: 1, to: 'seller' } },
  ]) {
    assert.deepEqual(validateRecord({ ...offer, terms }), { ok: true, shape: 'post', errors: [] }, JSON.stringify(terms))
  }
})

test('terms hold an arbiter key and a timer of whole days to one named side', () => {
  const cases = [
    [{ arbiter: 'bob' }, /arbiter must not be shorter than 32 characters/],
    [{ timer: { days: 0, to: 'seller' } }, /timer\/days can not be less than 1/],
    [{ timer: { days: 65536, to: 'seller' } }, /timer\/days can not be greater than 65535/],
    [{ timer: { days: 1.5, to: 'seller' } }, /timer\/days must be an integer/],
    [{ timer: { days: 7, to: 'arbiter' } }, /timer\/to must be one of \(seller\|buyer\)/],
    [{ timer: { days: 7 } }, /timer must have the property "to"/],
    [{ timer: { to: 'seller' } }, /timer must have the property "days"/],
    [{ timer: 7 }, /timer must be an object/],
  ]
  for (const [terms, pattern] of cases) {
    assertRejected(validateRecord({ ...example('post'), terms }), pattern)
  }
})

test('ratings are decimal text from 1.0 to 10.0 with one decimal at most, under any name', () => {
  for (const ratings of [{}, { overall: '1' }, { overall: '10' }, { overall: '10.0' }, { overall: '7.5', punctuality: '9', 'on time': '8.0' }]) {
    assert.deepEqual(validateRecord({ ...example('review'), ratings }), { ok: true, shape: 'review', errors: [] }, JSON.stringify(ratings))
  }
  for (const [ratings, pattern] of [
    [{ overall: 8.5 }, /overall must be a string/],
    [{ overall: '0.5' }, /ratings\/overall must be decimal text from 1.0 to 10.0/],
    [{ overall: '10.5' }, /ratings\/overall must be decimal text from 1.0 to 10.0/],
    [{ overall: '7.25' }, /ratings\/overall must be decimal text/],
    [{ overall: '07' }, /ratings\/overall must be decimal text/],
    [{ patience: 9 }, /ratings\/patience must be decimal text/],
    [{ patience: '' }, /ratings\/patience must be decimal text/],
    [{ $type: '5' }, /ratings: "\$type" must be a name of 1 to 64 characters, not starting with "\$"/],
    [{ ['x'.repeat(65)]: '5' }, /must be a name of 1 to 64 characters/],
    [[['overall', '5']], /ratings must be an object of names/],
  ]) {
    assertRejected(validateRecord({ ...example('review'), ratings }), pattern)
  }
})

test('a review may carry photos and short videos, ten at most', () => {
  // A blob as a record holds it; the examples carry none, since a host refuses a record whose blob it does not hold.
  const photo = example('profile').photo
  const video = { ...photo, mimeType: 'video/mp4', size: 40_000_000 }
  assert.deepEqual(validateRecord({ ...example('review'), media: [photo, video] }), { ok: true, shape: 'review', errors: [] })
  assertRejected(validateRecord({ ...example('review'), media: Array(11).fill(photo) }), /media must not have more than 10 elements/)
  assertRejected(validateRecord({ ...example('review'), media: [photo, { ...photo, mimeType: 'application/pdf' }] }), /media\/1 must be one of image\/png, image\/jpeg, video\/mp4, got "application\/pdf"/)
  assertRejected(validateRecord({ ...example('review'), media: [{ ...video, size: 50_000_001 }] }), /media\/0 must be at most 50000000 bytes, got 50000001/)
  assertRejected(validateRecord({ ...example('profile'), photo: { ...example('profile').photo, mimeType: 'video/mp4' } }), /photo must be one of image\/png, image\/jpeg/)
})

test('a review of something that is not a DID is rejected', () => {
  const review = example('review')
  review.subject = 'ana'
  assertRejected(validateRecord(review), /subject must be a valid did/)
})

test('the thinnest review points at a person and says nothing else, and is valid', () => {
  // Everything but who it is about is optional: no ratings, no text, no photos, no deal. What is missing
  // weighs less; nothing is refused.
  const thin = { $type: 'foundation.forest.review', subject: 'did:plc:abcdefghijklmnopqrstuvwx', createdAt: '2026-11-02T18:30:00Z' }
  assert.deepEqual(validateRecord(thin), { ok: true, shape: 'review', errors: [] })
  for (const keep of ['ratings', 'text', 'dealId']) {
    const review = { ...thin, [keep]: example('review')[keep] }
    assert.deepEqual(validateRecord(review), { ok: true, shape: 'review', errors: [] }, `with only ${keep}`)
  }
  const nobody = { ...thin }
  delete nobody.subject
  assertRejected(validateRecord(nobody), /must have the property "subject"/)
})

test("a review's deal id is the escrow's address, or 32 random bytes as hex", () => {
  const review = example('review')
  assert.equal(review.dealId, 'FKmToEDEJAXW8Pc72r9VnkxfzyE1Z6BbhHSJGfS132ud')
  assert.deepEqual(validateRecord(review), { ok: true, shape: 'review', errors: [] }, 'an escrow address')
  review.dealId = '9f3c'.repeat(16)
  assert.deepEqual(validateRecord(review), { ok: true, shape: 'review', errors: [] }, '32 bytes as hex, for a deal with no escrow')
  for (const bad of [
    'not-a-deal-id-at-all-not-a-deal-id',
    '9f3c'.repeat(16).toUpperCase(),
    '9f3c'.repeat(16).slice(1),
    '11111111111111111111111111111111111', // base58, but 35 zero bytes
    '3cpvoZKJ28f1CDBboEmfEXMVVMcSQzBhTEMtecGWQ6v', // base58, but 31 bytes
    'szpHvMPBKt4t9PagDS68oqS8dUc1gZTUPFV5p9Wgh4rF4', // base58, but 33 bytes
  ]) {
    review.dealId = bad
    assertRejected(validateRecord(review), /dealId/)
  }
})

test('a profile with a bad photo reference or a bad date is rejected', () => {
  const profile = example('profile')
  profile.photo.ref.$link = 'not-a-cid'
  assertRejected(validateRecord(profile), /photo should be a blob ref/)
  const again = example('profile')
  again.createdAt = 'yesterday'
  assertRejected(validateRecord(again), /createdAt must be an? valid atproto datetime/)
})

test('a credential whose credential is not an object is rejected', () => {
  const credential = example('credential')
  credential.credential = 'signed elsewhere'
  assertRejected(validateRecord(credential), /credential must be an object/)
})

// The market file

test('the online-tutors market file is valid', () => {
  assert.deepEqual(validateMarket(market()), { ok: true, errors: [] })
})

test('a market file has nine required keys, two optional ones, and nothing else', () => {
  assert.deepEqual(MARKET_KEYS, ['name', 'folder', 'description', 'sides', 'money', 'evidenceTypes', 'offerFields', 'ratings', 'howDealsGo', 'labels', 'reviewFields'])
  for (const key of ['name', 'folder', 'description', 'sides', 'money', 'evidenceTypes', 'offerFields', 'ratings', 'howDealsGo']) {
    const missing = market()
    delete missing[key]
    assertRejected(validateMarket(missing), new RegExp(`missing "${key}"`))
  }
  const bare = market()
  delete bare.labels
  delete bare.reviewFields
  assert.deepEqual(validateMarket(bare), { ok: true, errors: [] }, 'no labels and no review fields')
  for (const key of ['category', 'fields', 'roles', 'credentialIssuers', 'aliases', 'pricing']) {
    assertRejected(validateMarket({ ...market(), [key]: [] }), new RegExp(`unknown key "${key}"`))
  }
})

test('a market file restricts no deal', () => {
  for (const [key, value] of [
    ['suggested', { autoReleaseDays: 7, cancellationSteps: [] }],
    ['autoReleaseDays', 7],
    ['silenceDays', 7],
    ['arbiterAllowed', false],
    ['tokens', [{ symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana' }]],
    ['reviewEvidence', 'escrow'],
  ]) {
    assertRejected(validateMarket({ ...market(), [key]: value }), new RegExp(`unknown key "${key}"`))
  }
})

test('roles come from sides: seller and buyer when two, peer when one', () => {
  assert.deepEqual(SIDE_ROLES, { two: ['seller', 'buyer'], one: ['peer'] })
  const two = market()
  assert.deepEqual(rolesOf(two), ['seller', 'buyer'])
  for (const role of ['seller', 'buyer']) {
    assert.deepEqual(validateRecord({ ...example('post'), role }, { market: two }), { ok: true, shape: 'post', errors: [] }, role)
  }
  assertRejected(validateRecord({ ...example('post'), role: 'tutor' }, { market: two }), /role must be one of \(seller\|buyer\), got "tutor"/, 'a label is a word for pages, not a role')

  const one = { ...market(), sides: 'one' }
  delete one.labels
  assert.deepEqual(validateMarket(one), { ok: true, errors: [] })
  assert.deepEqual(rolesOf(one), ['peer'])
  assert.deepEqual(validateRecord({ ...example('post'), role: 'peer' }, { market: one }), { ok: true, shape: 'post', errors: [] })
  assertRejected(validateRecord(example('post'), { market: one }), /role must be one of \(peer\), got "seller"/)

  for (const sides of ['three', 2, 'Two', null]) {
    assertRejected(validateMarket({ ...market(), sides }), /sides must be "two" \(a seller and a buyer\) or "one" \(peers\)/)
  }
})

test('labels are the plain words for seller and buyer, in a two-sided market only', () => {
  assert.deepEqual(validateMarket({ ...market(), labels: { seller: 'driver', buyer: 'rider' } }), { ok: true, errors: [] })
  assertRejected(validateMarket({ ...market(), sides: 'one' }), /labels are only for a two-sided market/)
  for (const labels of [{ seller: 'tutor' }, { seller: 'tutor', buyer: 'student', peer: 'x' }, ['tutor', 'student'], 'tutor']) {
    assertRejected(validateMarket({ ...market(), labels }), /labels must be \{ "seller": …, "buyer": … \} and nothing else/)
  }
  for (const buyer of ['', 'two\nlines', 'x'.repeat(65), 7]) {
    assertRejected(validateMarket({ ...market(), labels: { seller: 'tutor', buyer } }), /labels\/buyer must be one line of text, at most 64 characters/)
  }
})

test('money is true or false', () => {
  assert.deepEqual(validateMarket({ ...market(), money: false }), { ok: true, errors: [] })
  for (const money of ['yes', 1, null]) assertRejected(validateMarket({ ...market(), money }), /money must be true or false/)
})

test('ratings name what reviews usually rate, overall always among them', () => {
  assert.deepEqual(validateMarket({ ...market(), ratings: ['overall'] }), { ok: true, errors: [] })
  for (const [ratings, pattern] of [
    [['patience'], /ratings must include "overall"/],
    [[], /ratings must include "overall"/],
    [['overall', 'overall'], /ratings must be distinct/],
    [['overall', 'on-time'], /ratings: "on-time" must be a camelCase name/],
    [['overall', 7], /ratings: 7 must be a camelCase name/],
    ['overall', /ratings must be an array of rating names/],
  ]) {
    assertRejected(validateMarket({ ...market(), ratings }), pattern)
  }
})

test('howDealsGo is plain text, lines allowed', () => {
  assert.deepEqual(validateMarket({ ...market(), howDealsGo: 'Pay up front.\nRelease after the lesson.' }), { ok: true, errors: [] })
  assert.deepEqual(validateMarket({ ...market(), howDealsGo: 'x'.repeat(3000) }), { ok: true, errors: [] })
  for (const howDealsGo of ['', '  \n ', 'x'.repeat(3001), 42, ['a']]) {
    assertRejected(validateMarket({ ...market(), howDealsGo }), /howDealsGo must be plain text, at most 3000 characters/)
  }
})

test('offerFields and reviewFields add flat fields, never a new shape', () => {
  for (const key of ['offerFields', 'reviewFields']) {
    for (const def of [
      { type: 'ref', ref: '#syllabus' },
      { type: 'object', properties: {} },
      { type: 'union', refs: [] },
      { type: 'blob' },
      { type: 'unknown' },
    ]) {
      assertRejected(validateMarket({ ...market(), [key]: { properties: { syllabus: def } } }), /Anything structured is a new shape/)
    }
    assertRejected(validateMarket({ ...market(), [key]: { properties: {}, lesson: {} } }), new RegExp(`${key}/lesson: only "properties" and "required" belong here`))
    assertRejected(validateMarket({ ...market(), [key]: [] }), new RegExp(`${key} must be an object`))
  }
  assert.deepEqual(validateMarket({ ...market(), offerFields: {} }), { ok: true, errors: [] }, 'no extra fields is a valid block')
})

test('a market field cannot redefine a base field or start with "$"', () => {
  const m = market()
  m.offerFields.properties.price = { type: 'string' }
  assertRejected(validateMarket(m), /offerFields\/properties\/price: "price" is already a post field/)
  const r = market()
  r.reviewFields.properties.ratings = { type: 'string' }
  assertRejected(validateMarket(r), /reviewFields\/properties\/ratings: "ratings" is already a review field/)
  const n = market()
  n.offerFields.properties.$type = { type: 'string' }
  assertRejected(validateMarket(n), /no "\$"/)
})

test('a market field with a bad constraint is rejected by the lexicon library', () => {
  const m = market()
  m.offerFields.properties.subjects.maxLength = 'ten'
  assertRejected(validateMarket(m), /offerFields: .*subjects\/maxLength: Expected number/)
})

test('a market file cannot require a field it did not add', () => {
  const m = market()
  m.offerFields.required = ['nope']
  assertRejected(validateMarket(m), /"nope" is not one of this market's post fields/)
  const r = market()
  r.reviewFields.required = ['nope']
  assertRejected(validateMarket(r), /"nope" is not one of this market's review fields/)
})

test('a description is one line', () => {
  assert.deepEqual(validateMarket({ ...market(), description: 'x'.repeat(300) }), { ok: true, errors: [] })
  for (const description of ['', '   ', 'two\nlines', 'a\rb', 'x'.repeat(301), 42, null]) {
    assertRejected(validateMarket({ ...market(), description }), /description must be one line of text, at most 300 characters/)
  }
})

test('a name and a folder are any slug: a folder is a place in the directory, never code', () => {
  for (const folder of ['home-services', 'freelance-work', 'buy-and-sell', 'rides']) {
    assert.deepEqual(validateMarket({ ...market(), folder }), { ok: true, errors: [] }, folder)
  }
  assertRejected(validateMarket({ ...market(), folder: 'Home Services' }), /folder must be a lowercase slug/)
  assertRejected(validateMarket({ ...market(), name: 'online tutors' }), /name must be a lowercase slug/)
  assertRejected(validateMarket({ ...market(), name: 'x'.repeat(65) }), /name must be a lowercase slug/)
})

test('evidence types are distinct slugs', () => {
  const result = validateMarket({ ...market(), evidenceTypes: ['escrow', 'Shipment Tracking', 'escrow'] })
  assertRejected(result, /evidenceTypes: "Shipment Tracking" must be a lowercase slug/)
  assertRejected(result, /evidenceTypes must be distinct/)
  assert.deepEqual(validateMarket({ ...market(), evidenceTypes: [] }), { ok: true, errors: [] }, 'no evidence types is a valid list')
})

// Records against their lexicon plus a market file

for (const shape of SHAPES) {
  test(`example ${shape} is valid in the online-tutors market`, () => {
    assert.deepEqual(validateRecord(example(shape), { market: market() }), { ok: true, shape, errors: [] })
  })
}

test('a profile lives in one market, as one side of it', () => {
  for (const key of ['market', 'role']) {
    const p = example('profile')
    delete p[key]
    assertRejected(validateRecord(p), new RegExp(`must have the property "${key}"`))
  }
  assert.deepEqual(validateRecord({ ...example('profile'), role: 'buyer' }, { market: market() }), { ok: true, shape: 'profile', errors: [] })
  const wrong = validateRecord({ ...example('profile'), market: 'plumbing', role: 'student' }, { market: market() })
  assertRejected(wrong, /market must be "online-tutors", got "plumbing"/)
  assertRejected(wrong, /role must be one of \(seller\|buyer\), got "student"/, 'a label is not a role')
  const one = { ...market(), sides: 'one' }
  delete one.labels
  assert.deepEqual(validateRecord({ ...example('profile'), role: 'peer' }, { market: one }), { ok: true, shape: 'profile', errors: [] })
  assertRejected(validateRecord(example('profile'), { market: one }), /role must be one of \(peer\), got "seller"/)
})

test('a post must use the market name and one of its roles', () => {
  const post = example('post')
  post.market = 'plumbers'
  post.role = 'chef'
  const result = validateRecord(post, { market: market() })
  assertRejected(result, /market must be "online-tutors", got "plumbers"/)
  assertRejected(result, /role must be one of \(seller\|buyer\), got "chef"/)
})

test("a market file limits no offer's token or terms", () => {
  const post = example('post')
  post.price.mint = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr' // a mint no market file names
  post.terms = { arbiter: ARBITER, timer: { days: 30, to: 'buyer' } }
  assert.deepEqual(validateRecord(post, { market: market() }), { ok: true, shape: 'post', errors: [] })
})

test("a post must carry the market's required offer field, typed as the market says", () => {
  const post = example('post')
  delete post.subjects
  assertRejected(validateRecord(post, { market: market() }), /must have the property "subjects"/)
  const again = example('post')
  again.languages = ['not a language tag!']
  assertRejected(validateRecord(again, { market: market() }), /languages\/0 must be a well-formed BCP 47/)
})

test("a review is checked against its subject's market: its review fields, and any rating name", () => {
  const review = example('review')
  assert.equal(review.sessions, 8)
  assert.deepEqual(validateRecord(review, { market: market() }), { ok: true, shape: 'review', errors: [] })
  assertRejected(validateRecord({ ...review, sessions: 0 }, { market: market() }), /sessions can not be less than 1/)
  assertRejected(validateRecord({ ...review, sessions: 'eight' }, { market: market() }), /sessions must be an integer/)
  const requires = market()
  requires.reviewFields.required = ['sessions']
  const { sessions: _, ...without } = review
  assertRejected(validateRecord(without, { market: requires }), /must have the property "sessions"/)
  // The market file suggests names; a review may rate anything else too.
  const other = { ...review, ratings: { overall: '9', humour: '10' } }
  assert.deepEqual(market().ratings.includes('humour'), false)
  assert.deepEqual(validateRecord(other, { market: market() }), { ok: true, shape: 'review', errors: [] })
})

test('evidence weighs, never rejects: a review without an escrow is valid in an escrow market', () => {
  const review = example('review')
  delete review.dealId
  const withEscrow = market()
  assert.deepEqual(withEscrow.evidenceTypes, ['escrow'])
  assert.deepEqual(validateRecord(review, { market: withEscrow }), { ok: true, shape: 'review', errors: [] })
  assert.deepEqual(validateRecord(review, { market: { ...market(), evidenceTypes: [] } }), { ok: true, shape: 'review', errors: [] })
})

test('a broken market file fails the record, and says so', () => {
  assertRejected(validateRecord(example('post'), { market: { ...market(), sides: 'many' } }), /^market file: sides must be/)
})

// The command line

function cli(...args) {
  const run = spawnSync(process.execPath, [join(root, 'bin', 'validate.js'), ...args], { encoding: 'utf8' })
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() }
}

test('cli: valid inputs exit 0', () => {
  for (const shape of SHAPES) {
    const file = join(examples, `${shape}.json`)
    assert.equal(cli('record', file).code, 0)
    const withMarket = cli('record', file, '--market', marketFile)
    assert.equal(withMarket.code, 0)
    assert.match(withMarket.out, new RegExp(`valid ${shape} in market "online-tutors"`))
  }
  assert.equal(cli('market', marketFile).code, 0)
})

test('cli: invalid input exits 1 and lists the errors', () => {
  const bad = cli('record', join(examples, 'review.json'), '--market', join(here, 'fixtures', 'restricting-market.json'))
  assert.equal(bad.code, 1)
  assert.match(bad.err, /- market file: unknown key "arbiterAllowed"/)
})

test('cli: bad usage or unreadable input exits 2', () => {
  assert.equal(cli().code, 2)
  assert.equal(cli('record').code, 2)
  assert.equal(cli('record', join(examples, 'post.json'), '--market').code, 2)
  assert.equal(cli('market', join(examples, 'nope.json')).code, 2)
})

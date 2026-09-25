import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROLES, SHAPES, loadLexiconDocs, rolesOf, shapeId, validateMarket, validateRecord } from '../src/validate.js'

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

test('a post without its price is rejected', () => {
  const post = example('post')
  delete post.price
  assertRejected(validateRecord(post), /must have the property "price"/)
})

test('a post may leave out remote, with or without a location', () => {
  const post = example('post')
  delete post.remote
  assert.equal(validateRecord(post).ok, true)
  post.location = 'Lisbon'
  assert.equal(validateRecord(post).ok, true)
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

test('a review rated 6 is rejected', () => {
  const review = example('review')
  review.rating = 6
  assertRejected(validateRecord(review), /rating can not be greater than 5/)
})

test('a review of something that is not a DID is rejected', () => {
  const review = example('review')
  review.subject = 'ana'
  assertRejected(validateRecord(review), /subject must be a valid did/)
})

test('the thinnest review points at a person and says nothing else, and is valid', () => {
  // Everything but who it is about is optional: no rating, no text, no deal. What is missing
  // weighs less; nothing is refused.
  const thin = { $type: 'foundation.forest.review', subject: 'did:plc:abcdefghijklmnopqrstuvwx', createdAt: '2026-11-02T18:30:00Z' }
  assert.deepEqual(validateRecord(thin), { ok: true, shape: 'review', errors: [] })
  for (const keep of ['rating', 'text', 'dealId']) {
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

test('a market file cannot add a new shape', () => {
  const m = market()
  m.fields.lesson = { properties: { topic: { type: 'string' } } }
  assertRejected(validateMarket(m), /fields\/lesson: not a shape/)
})

test('a market file cannot add fields to a credential', () => {
  const m = market()
  m.fields.credential = { properties: { grade: { type: 'string' } } }
  assertRejected(validateMarket(m), /cannot add fields to a credential/)
})

test('a market field cannot be structured (ref, object, union, blob)', () => {
  for (const def of [
    { type: 'ref', ref: '#syllabus' },
    { type: 'object', properties: {} },
    { type: 'union', refs: [] },
    { type: 'blob' },
    { type: 'unknown' },
  ]) {
    const m = market()
    m.fields.post.properties.syllabus = def
    assertRejected(validateMarket(m), /Anything structured is a new shape/)
  }
})

test('a market field cannot redefine a base field or start with "$"', () => {
  const m = market()
  m.fields.post.properties.price = { type: 'string' }
  assertRejected(validateMarket(m), /"price" is already a post field/)
  const n = market()
  n.fields.post.properties.$type = { type: 'string' }
  assertRejected(validateMarket(n), /no "\$"/)
})

test('a market field with a bad constraint is rejected by the lexicon library', () => {
  const m = market()
  m.fields.post.properties.subjects.maxLength = 'ten'
  assertRejected(validateMarket(m), /subjects\/maxLength: Expected number/)
})

test('a market file cannot require a field it did not add', () => {
  const m = market()
  m.fields.post.required = ['nope']
  assertRejected(validateMarket(m), /"nope" is not one of this market's post fields/)
})

test('a market file has five required keys, two optional ones, and nothing else', () => {
  const extra = market()
  extra.pricing = 'hourly'
  assertRejected(validateMarket(extra), /unknown key "pricing"/)
  for (const key of ['name', 'category', 'fields', 'evidenceTypes', 'credentialIssuers']) {
    const missing = market()
    delete missing[key]
    assertRejected(validateMarket(missing), new RegExp(`missing "${key}"`))
  }
  const bare = market()
  delete bare.description
  delete bare.roles
  assert.deepEqual(validateMarket(bare), { ok: true, errors: [] }, 'no description and no roles')
})

test('a market file says nothing about money or time, and restricts no deal', () => {
  for (const [key, value] of [
    ['suggested', { autoReleaseDays: 7, cancellationSteps: [] }],
    ['autoReleaseDays', 7],
    ['silenceDays', 7],
    ['arbiterAllowed', false],
    ['tokens', [{ symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana' }]],
    ['reviewEvidence', 'escrow'],
  ]) {
    const m = market()
    m[key] = value
    assertRejected(validateMarket(m), new RegExp(`unknown key "${key}"`))
  }
})

test('roles default to seller and buyer; a market file may name its own', () => {
  const m = market()
  assert.equal(m.roles, undefined)
  assert.deepEqual(rolesOf(m), ['seller', 'buyer'])
  assert.deepEqual([...DEFAULT_ROLES], ['seller', 'buyer'])
  for (const role of ['seller', 'buyer']) {
    assert.deepEqual(validateRecord({ ...example('post'), role }, { market: m }), { ok: true, shape: 'post', errors: [] }, role)
  }
  assertRejected(validateRecord({ ...example('post'), role: 'tutor' }, { market: m }), /role must be one of \(seller\|buyer\), got "tutor"/)

  const own = { ...market(), roles: ['tutor', 'student'] }
  assert.deepEqual(validateMarket(own), { ok: true, errors: [] })
  assert.deepEqual(validateRecord({ ...example('post'), role: 'tutor' }, { market: own }), { ok: true, shape: 'post', errors: [] })
  assertRejected(validateRecord(example('post'), { market: own }), /role must be one of \(tutor\|student\), got "seller"/)

  for (const [roles, pattern] of [
    [[], /roles must be a non-empty array of slugs; leave it out for seller and buyer/],
    [['Seller'], /roles: "Seller" must be a lowercase slug/],
    [['seller', 'seller'], /roles must be distinct/],
  ]) {
    assertRejected(validateMarket({ ...market(), roles }), pattern)
  }
})

test('a description is optional, and one line', () => {
  assert.deepEqual(validateMarket({ ...market(), description: 'x'.repeat(300) }), { ok: true, errors: [] })
  for (const description of ['', '   ', 'two\nlines', 'a\rb', 'x'.repeat(301), 42, null]) {
    assertRejected(validateMarket({ ...market(), description }), /description must be one line of text, at most 300 characters/)
  }
})

test('a category is any slug: a folder and a page, never code', () => {
  for (const category of ['home-services', 'freelance-work', 'buy-and-sell', 'rides']) {
    const m = market()
    m.category = category
    assert.deepEqual(validateMarket(m), { ok: true, errors: [] }, category)
  }
  const m = market()
  m.category = 'Home Services'
  assertRejected(validateMarket(m), /category must be a lowercase slug/)
})

test('market scalars are checked', () => {
  const m = market()
  m.evidenceTypes = ['escrow', 'Shipment Tracking', 'escrow']
  m.credentialIssuers = ['bob']
  const result = validateMarket(m)
  assertRejected(result, /evidenceTypes: "Shipment Tracking" must be a lowercase slug/)
  assertRejected(result, /evidenceTypes must be distinct/)
  assertRejected(result, /"bob" is not a DID/)
  const none = market()
  none.evidenceTypes = []
  assert.deepEqual(validateMarket(none), { ok: true, errors: [] }, 'no evidence types is a valid list')
})

// Records against their lexicon plus a market file

for (const shape of SHAPES) {
  test(`example ${shape} is valid in the online-tutors market`, () => {
    assert.deepEqual(validateRecord(example(shape), { market: market() }), { ok: true, shape, errors: [] })
  })
}

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

test("a post must carry the market's required extra field, typed as the market says", () => {
  const post = example('post')
  delete post.subjects
  assertRejected(validateRecord(post, { market: market() }), /must have the property "subjects"/)
  const again = example('post')
  again.languages = ['not a language tag!']
  assertRejected(validateRecord(again, { market: market() }), /languages\/0 must be a well-formed BCP 47/)
})

test('evidence weighs, never rejects: a review without an escrow is valid in an escrow market', () => {
  const review = example('review')
  delete review.dealId
  const withEscrow = market()
  assert.deepEqual(withEscrow.evidenceTypes, ['escrow'])
  assert.deepEqual(validateRecord(review, { market: withEscrow }), { ok: true, shape: 'review', errors: [] })
  const none = market()
  none.evidenceTypes = []
  assert.deepEqual(validateRecord(review, { market: none }), { ok: true, shape: 'review', errors: [] })
})

test('a broken market file fails the record, and says so', () => {
  const m = market()
  m.roles = []
  assertRejected(validateRecord(example('post'), { market: m }), /^market file: roles must be/)
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHAPES, loadLexiconDocs, shapeId, validateMarket, validateRecord } from '../src/validate.js'

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

test('a post priced per week is rejected', () => {
  const post = example('post')
  post.price.per = 'week'
  assertRejected(validateRecord(post), /price\/per must be one of \(hour\|day\|job\)/)
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

test('a market file has exactly eight keys', () => {
  const extra = market()
  extra.pricing = 'hourly'
  assertRejected(validateMarket(extra), /unknown key "pricing"/)
  const missing = market()
  delete missing.tokens
  assertRejected(validateMarket(missing), /missing "tokens"/)
})

test('market scalars are checked', () => {
  const m = market()
  m.silenceDays = 0
  m.arbiterAllowed = 'no'
  m.reviewEvidence = 'photo'
  m.credentialIssuers = ['bob']
  m.tokens = [{ symbol: 'usdc', mint: 'x' }]
  const result = validateMarket(m)
  assertRejected(result, /silenceDays must be a whole number of days, at least 1/)
  assertRejected(result, /arbiterAllowed must be true or false/)
  assertRejected(result, /reviewEvidence must be one of \(escrow\|none\)/)
  assertRejected(result, /"bob" is not a DID/)
  assertRejected(result, /symbol "usdc" must be/)
  assertRejected(result, /mint for "usdc" must be a base58 public key/)
})

// Records against their lexicon plus a market file

for (const shape of SHAPES) {
  test(`example ${shape} is valid in the online-tutors market`, () => {
    assert.deepEqual(validateRecord(example(shape), { market: market() }), { ok: true, shape, errors: [] })
  })
}

test('a post must use the market name, one of its roles, and an accepted token', () => {
  const post = example('post')
  post.market = 'plumbers'
  post.role = 'chef'
  post.price.token = 'EURC'
  const result = validateRecord(post, { market: market() })
  assertRejected(result, /market must be "online-tutors", got "plumbers"/)
  assertRejected(result, /role must be one of \(tutor\|student\), got "chef"/)
  assertRejected(result, /price\/token must be one of \(USDC\), got "EURC"/)
})

test("a post must carry the market's required extra field, typed as the market says", () => {
  const post = example('post')
  delete post.subjects
  assertRejected(validateRecord(post, { market: market() }), /must have the property "subjects"/)
  const again = example('post')
  again.languages = ['not a language tag!']
  assertRejected(validateRecord(again, { market: market() }), /languages\/0 must be a well-formed BCP 47/)
})

test('review evidence: the market decides whether a review needs an escrow behind it', () => {
  const review = example('review')
  delete review.escrow
  assertRejected(validateRecord(review, { market: market() }), /escrow is required/)
  const lenient = market()
  lenient.reviewEvidence = 'none'
  assert.equal(validateRecord(review, { market: lenient }).ok, true)
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
  const bad = cli('record', join(examples, 'review.json'), '--market', join(here, 'fixtures', 'lenient-market.json'))
  assert.equal(bad.code, 1)
  assert.match(bad.err, /- market file: reviewEvidence must be one of/)
})

test('cli: bad usage or unreadable input exits 2', () => {
  assert.equal(cli().code, 2)
  assert.equal(cli('record').code, 2)
  assert.equal(cli('record', join(examples, 'post.json'), '--market').code, 2)
  assert.equal(cli('market', join(examples, 'nope.json')).code, 2)
})

// Forest record shapes.
//
// Two checks, nothing else:
//   validateRecord(record, { market })  a record against its lexicon, and
//                                       optionally against one market file
//   validateMarket(market)              a market file's structure, and the rule
//                                       "market files add fields, never new shapes"
//
// The lexicon library is @atproto/lexicon, used unchanged. Nothing here talks
// to a host, an index, or a chain.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexicons, jsonToLex, parseLexiconDoc } from '@atproto/lexicon'

const here = dirname(fileURLToPath(import.meta.url))
const LEXICON_DIR = join(here, '..', 'lexicons', 'foundation', 'forest')

/** The namespace every Forest lexicon lives under: the foundation's domain, reversed. */
export const NAMESPACE = 'foundation.forest'

/** The four shapes. Nothing else is a Forest record. */
export const SHAPES = ['profile', 'post', 'review', 'credential']

/**
 * The keys a market file must have. A market file describes a market and restricts no deal: the
 * arbiter, the timer, the token and the amount are the seller's, per offer.
 */
export const MARKET_REQUIRED_KEYS = ['name', 'folder', 'description', 'sides', 'money', 'evidenceTypes', 'offerFields', 'ratings', 'howDealsGo']

/** The keys a market file may have. Nothing else belongs in one. */
export const MARKET_KEYS = [...MARKET_REQUIRED_KEYS, 'labels', 'reviewFields']

/** A market's roles come from its sides: seller and buyer when two, peer when one. */
export const SIDE_ROLES = Object.freeze({ two: Object.freeze(['seller', 'buyer']), one: Object.freeze(['peer']) })

/** The two blocks of extra fields a market file may carry, and the shape each adds to. */
export const FIELD_BLOCKS = Object.freeze({ offerFields: 'post', reviewFields: 'review' })

/** A market file's description is one line, at most this long. */
export const MAX_DESCRIPTION = 300

/** How deals go in the market, in plain text, at most this long. */
export const MAX_HOW_DEALS_GO = 3000

/** A label, the plain word for a side, at most this long. */
export const MAX_LABEL = 64

/** Every review may rate `overall`; a market file lists it with any others it suggests. */
export const OVERALL = 'overall'

// A market field is flat data. Anything structured would be a new shape.
const EXTRA_FIELD_TYPES = ['string', 'integer', 'boolean', 'array']
const EXTRA_ITEM_TYPES = ['string', 'integer', 'boolean']

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/
// A rating: decimal text from 1.0 to 10.0, at most one decimal. A record holds no fractional numbers.
const RATING = /^(10(\.0)?|[1-9](\.[0-9])?)$/
// Degrees as decimal text, at most four decimals.
const DEGREES = /^-?[0-9]{1,3}(\.[0-9]{1,4})?$/

export function shapeId(shape) {
  return `${NAMESPACE}.${shape}`
}

/** The shape name for a record's $type, or undefined when it is not one of ours. */
export function shapeOf(type) {
  return SHAPES.find((shape) => shapeId(shape) === type)
}

let cachedDocs
/** The four lexicon docs from disk, each checked as a lexicon. Frozen; clone before mutating. */
export function loadLexiconDocs() {
  if (cachedDocs) return cachedDocs
  const docs = {}
  for (const shape of SHAPES) {
    const file = join(LEXICON_DIR, `${shape}.json`)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    parseLexiconDoc(doc) // throws when the lexicon itself is malformed
    if (doc.id !== shapeId(shape)) {
      throw new Error(`${file}: id must be ${shapeId(shape)}, got ${doc.id}`)
    }
    docs[shape] = deepFreeze(doc)
  }
  cachedDocs = Object.freeze(docs)
  return cachedDocs
}

/**
 * Check one record. Returns { ok, shape, errors }.
 * A review's deal id, when it has one, must be an escrow address or 32 bytes
 * of hex, and each of its ratings decimal text from 1.0 to 10.0 under any name.
 * A post's location, when it has one, is a point in degrees and a place name.
 * A post's terms are optional and checked by the lexicon alone.
 *
 * With a market file, the record is also checked against that market: a post
 * against the market it names (its name, a role its sides allow, its offer
 * fields, and a price when the market has money); a review against the market
 * of the profile it is about (its review fields). The caller finds that market.
 * Nothing in a market file limits a post's terms or token, a review may use
 * any rating name, and evidence is not checked: it weighs, it never rejects.
 */
export function validateRecord(record, { market } = {}) {
  if (!isPlainObject(record)) return fail(undefined, ['record must be a JSON object'])
  const shape = shapeOf(record.$type)
  if (!shape) {
    const known = SHAPES.map(shapeId).join(', ')
    return fail(undefined, [`unknown shape "${record.$type}"; Forest has four: ${known}`])
  }

  let doc = loadLexiconDocs()[shape]
  if (market !== undefined) {
    const checked = validateMarket(market)
    if (!checked.ok) return fail(shape, checked.errors.map((e) => `market file: ${e}`))
    doc = mergeMarket(doc, shape, market)
  }

  try {
    // Lexicons.add mutates the doc it is given, so hand it a copy.
    new Lexicons([structuredClone(doc)]).assertValidRecord(shapeId(shape), jsonToLex(record))
  } catch (e) {
    return fail(shape, [e.message])
  }

  const errors = blobRules(record, doc)
  if (shape === 'review') errors.push(...reviewRules(record))
  if (shape === 'post') errors.push(...postRules(record))
  if (market !== undefined) errors.push(...marketRules(shape, record, market))
  return errors.length ? fail(shape, errors) : { ok: true, shape, errors: [] }
}

/**
 * Check a market file's structure, and nothing more. Returns { ok, errors }.
 * Required: name, folder, description, sides, money, evidenceTypes,
 * offerFields, ratings, howDealsGo. Optional: labels (two sides only) and
 * reviewFields. Nothing else.
 */
export function validateMarket(market) {
  if (!isPlainObject(market)) return { ok: false, errors: ['market file must be a JSON object'] }
  const errors = []

  for (const key of MARKET_REQUIRED_KEYS) {
    if (!(key in market)) errors.push(`missing "${key}"`)
  }
  for (const key of Object.keys(market)) {
    if (!MARKET_KEYS.includes(key)) {
      errors.push(`unknown key "${key}"; a market file has only: ${MARKET_KEYS.join(', ')}`)
    }
  }
  if (errors.length) return { ok: false, errors }

  for (const key of ['name', 'folder']) {
    if (typeof market[key] !== 'string' || !SLUG.test(market[key]) || market[key].length > 64) {
      errors.push(`${key} must be a lowercase slug (letters, digits, hyphens), at most 64 characters`)
    }
  }

  if (!isOneLine(market.description, MAX_DESCRIPTION)) {
    errors.push(`description must be one line of text, at most ${MAX_DESCRIPTION} characters`)
  }

  if (!Object.hasOwn(SIDE_ROLES, market.sides)) {
    errors.push('sides must be "two" (a seller and a buyer) or "one" (peers)')
  }

  if ('labels' in market) {
    const labels = market.labels
    if (market.sides !== 'two') {
      errors.push('labels are only for a two-sided market: the plain words for seller and buyer')
    } else if (!isPlainObject(labels) || Object.keys(labels).sort().join() !== 'buyer,seller') {
      errors.push('labels must be { "seller": …, "buyer": … } and nothing else')
    } else {
      for (const side of ['seller', 'buyer']) {
        if (!isOneLine(labels[side], MAX_LABEL)) errors.push(`labels/${side} must be one line of text, at most ${MAX_LABEL} characters`)
      }
    }
  }

  if (typeof market.money !== 'boolean') {
    errors.push('money must be true or false: whether deals in this market are paid')
  }

  if (!Array.isArray(market.evidenceTypes)) {
    errors.push('evidenceTypes must be an array of slugs (escrow is the one defined so far; empty for none)')
  } else {
    for (const type of market.evidenceTypes) {
      if (typeof type !== 'string' || !SLUG.test(type) || type.length > 64) {
        errors.push(`evidenceTypes: ${JSON.stringify(type)} must be a lowercase slug, at most 64 characters`)
      }
    }
    if (new Set(market.evidenceTypes).size !== market.evidenceTypes.length) errors.push('evidenceTypes must be distinct')
  }

  for (const key of Object.keys(FIELD_BLOCKS)) {
    if (key in market) errors.push(...checkFieldBlock(key, market[key]))
  }

  if (!Array.isArray(market.ratings)) {
    errors.push(`ratings must be an array of rating names, "${OVERALL}" among them`)
  } else {
    for (const name of market.ratings) {
      if (typeof name !== 'string' || !FIELD_NAME.test(name) || name.length > 64) {
        errors.push(`ratings: ${JSON.stringify(name)} must be a camelCase name, at most 64 characters`)
      }
    }
    if (!market.ratings.includes(OVERALL)) errors.push(`ratings must include "${OVERALL}"`)
    if (new Set(market.ratings).size !== market.ratings.length) errors.push('ratings must be distinct')
  }

  if (typeof market.howDealsGo !== 'string' || market.howDealsGo.trim() === '' || market.howDealsGo.length > MAX_HOW_DEALS_GO) {
    errors.push(`howDealsGo must be plain text, at most ${MAX_HOW_DEALS_GO} characters`)
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] }
}

/** A market's roles, from its sides: seller and buyer, or peer. */
export function rolesOf(market) {
  return SIDE_ROLES[market.sides] ?? []
}

/**
 * A copy of a shape's lexicon doc with one market's extra fields for that
 * shape merged in: offer fields into a post, review fields into a review.
 * Base fields come first; a market never redefines them.
 */
export function mergeMarket(doc, shape, market) {
  const merged = structuredClone(doc)
  const key = Object.keys(FIELD_BLOCKS).find((k) => FIELD_BLOCKS[k] === shape)
  const block = key ? market[key] : undefined
  if (!isPlainObject(block)) return merged
  const record = merged.defs.main.record
  record.properties = { ...record.properties, ...(block.properties ?? {}) }
  record.required = [...(record.required ?? []), ...(block.required ?? [])]
  return merged
}

// The rule for one block of extra fields: flat fields added to one shape, never a new shape.
function checkFieldBlock(key, block) {
  const place = FIELD_BLOCKS[key]
  if (!isPlainObject(block)) {
    return [`${key} must be an object with "properties" and optional "required": the extra fields a ${place} in this market carries`]
  }
  const errors = []
  for (const k of Object.keys(block)) {
    if (k !== 'properties' && k !== 'required') errors.push(`${key}/${k}: only "properties" and "required" belong here`)
  }

  const props = block.properties ?? {}
  if (!isPlainObject(props)) return [...errors, `${key}/properties must be an object of field definitions`]
  const base = loadLexiconDocs()[place].defs.main.record.properties
  for (const [name, def] of Object.entries(props)) {
    const path = `${key}/properties/${name}`
    if (!FIELD_NAME.test(name)) {
      errors.push(`${path}: field names are camelCase letters and digits, no "$"`)
    }
    if (name in base) {
      errors.push(`${path}: "${name}" is already a ${place} field; market files add fields, they never redefine them`)
    }
    if (!isPlainObject(def)) {
      errors.push(`${path}: must be a field definition with a "type"`)
      continue
    }
    if (!EXTRA_FIELD_TYPES.includes(def.type)) {
      errors.push(
        `${path}: type ${JSON.stringify(def.type)} is not allowed; a market field is string, integer, boolean, or an array of those. Anything structured is a new shape`,
      )
    } else if (def.type === 'array' && !(isPlainObject(def.items) && EXTRA_ITEM_TYPES.includes(def.items.type))) {
      errors.push(`${path}: array items must be string, integer, or boolean`)
    }
  }

  const required = block.required ?? []
  if (!Array.isArray(required)) {
    errors.push(`${key}/required must be an array of this market's ${place} field names`)
  } else {
    for (const name of required) {
      if (!(name in props)) errors.push(`${key}/required: ${JSON.stringify(name)} is not one of this market's ${place} fields`)
    }
  }
  if (errors.length) return errors

  // Last: the merged lexicon must still be a valid lexicon. This catches bad
  // constraints inside an otherwise allowed field (maxLength: "ten").
  try {
    parseLexiconDoc(mergeMarket(loadLexiconDocs()[place], place, { [key]: block }))
  } catch (e) {
    errors.push(`${key}: ${describeLexiconError(e)}`)
  }
  return errors
}

// A review's deal id, when it has one: the escrow's address when an escrow
// exists (base58, 32 bytes), else 32 random bytes as lowercase hex. Anything
// else points at nothing, so it is refused; a review with no deal id is fine.
// Its ratings, when it has any: any name, each decimal text from 1.0 to 10.0.
function reviewRules(record) {
  const errors = []
  if (record.dealId !== undefined) {
    const id = record.dealId
    if (!(/^[0-9a-f]{64}$/.test(id) || base58Length(id) === 32)) {
      errors.push(`dealId must be the escrow's address (base58, 32 bytes) or 32 random bytes as lowercase hex, got ${JSON.stringify(id)}`)
    }
  }
  if (record.ratings !== undefined) {
    // The lexicon library takes an array for an object; a map of names is an object.
    if (!isPlainObject(record.ratings)) return [...errors, 'ratings must be an object of names, such as { "overall": "8.5" }']
    for (const [name, value] of Object.entries(record.ratings)) {
      if (name.length === 0 || name.length > 64 || name.startsWith('$')) {
        errors.push(`ratings: ${JSON.stringify(name)} must be a name of 1 to 64 characters, not starting with "$"`)
      }
      if (typeof value !== 'string' || !RATING.test(value)) {
        errors.push(`ratings/${name} must be decimal text from 1.0 to 10.0 with at most one decimal, such as "8.5", got ${JSON.stringify(value)}`)
      }
    }
  }
  return errors
}

// A post's location, when it has one: a point in degrees as decimal text, at
// most four decimals. That it is rounded to precisionKm is the app's to do;
// nothing here can tell.
function postRules(record) {
  const errors = []
  const where = record.location
  if (where !== undefined) {
    for (const [key, bound] of [['lat', 90], ['lon', 180]]) {
      const v = where[key]
      if (!DEGREES.test(v) || Math.abs(Number(v)) > bound) {
        errors.push(`location/${key} must be degrees from -${bound} to ${bound} as decimal text with at most 4 decimals, such as "38.72", got ${JSON.stringify(v)}`)
      }
    }
  }
  return errors
}

// A blob's type and size against its lexicon's accept and maxSize, for each
// blob field of the record (a profile's photo, a review's media). The lexicon
// library checks only that a blob is a blob, and a host checks nothing for a
// collection it has no lexicon for.
function blobRules(record, doc) {
  const errors = []
  for (const [name, def] of Object.entries(doc.defs.main.record.properties)) {
    const value = record[name]
    if (value === undefined) continue
    const blob = def.type === 'blob' ? def : def.type === 'array' && def.items?.type === 'blob' ? def.items : null
    if (!blob) continue
    const refs = def.type === 'array' ? value : [value]
    refs.forEach((ref, i) => {
      const path = def.type === 'array' ? `${name}/${i}` : name
      if (blob.accept && !blob.accept.includes(ref.mimeType)) {
        errors.push(`${path} must be one of ${blob.accept.join(', ')}, got ${JSON.stringify(ref.mimeType)}`)
      }
      if (blob.maxSize !== undefined && !(ref.size <= blob.maxSize)) {
        errors.push(`${path} must be at most ${blob.maxSize} bytes, got ${ref.size}`)
      }
    })
  }
  return errors
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** How many bytes a base58 string decodes to, or -1 if it is not base58. */
function base58Length(s) {
  let n = 0n
  for (const c of s) {
    const digit = BASE58.indexOf(c)
    if (digit === -1) return -1
    n = n * 58n + BigInt(digit)
  }
  let bytes = 0
  while (n > 0n) {
    n /= 256n
    bytes++
  }
  for (const c of s) {
    if (c !== '1') break
    bytes++
  }
  return bytes
}

// Cross-checks a post against the market file it names: its name, a role the
// market's sides allow, and a price when the market has money. Its extra
// fields were merged into the lexicon above. A review's are too; nothing else
// about a review is checked against its market.
function marketRules(shape, record, market) {
  const errors = []
  if (shape === 'post') {
    if (record.market !== market.name) {
      errors.push(`Record/market must be "${market.name}", got ${JSON.stringify(record.market)}`)
    }
    const roles = rolesOf(market)
    if (!roles.includes(record.role)) {
      errors.push(`Record/role must be one of (${roles.join('|')}), got ${JSON.stringify(record.role)}`)
    }
    if (market.money && record.price === undefined) {
      errors.push(`Record must have the property "price": deals in ${market.name} are paid`)
    }
  }
  return errors
}

function describeLexiconError(e) {
  if (Array.isArray(e?.issues)) {
    return e.issues.map((i) => `${i.path.join('/')}: ${i.message}`).join('; ')
  }
  return e?.message ?? String(e)
}

function fail(shape, errors) {
  return { ok: false, shape, errors }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isOneLine(v, max) {
  return typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v) && v.length <= max
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) deepFreeze(child)
    Object.freeze(v)
  }
  return v
}

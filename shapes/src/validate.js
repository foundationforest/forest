// Forest record shapes.
//
// Two checks, nothing else:
//   validateRecord(record, { market })  a record against its lexicon, and
//                                       optionally against one market file
//   validateMarket(market)              a market file against the rule
//                                       "market files add fields, never new shapes"
//
// The lexicon library is @atproto/lexicon, used unchanged. Nothing here talks
// to a host, an index, or a chain.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexicons, jsonToLex, parseLexiconDoc } from '@atproto/lexicon'
import { isValidDid } from '@atproto/syntax'

const here = dirname(fileURLToPath(import.meta.url))
const LEXICON_DIR = join(here, '..', 'lexicons', 'foundation', 'forest')

/** The namespace every Forest lexicon lives under: the foundation's domain, reversed. */
export const NAMESPACE = 'foundation.forest'

/** The four shapes. Nothing else is a Forest record. */
export const SHAPES = ['profile', 'post', 'review', 'credential']

/** Shapes a market file may add fields to. A credential is the issuer's, not the market's. */
export const MARKET_FIELD_PLACES = ['profile', 'post', 'review']

/** The eight keys of a market file, and nothing else. */
export const MARKET_KEYS = [
  'name',
  'roles',
  'fields',
  'silenceDays',
  'arbiterAllowed',
  'reviewEvidence',
  'credentialIssuers',
  'tokens',
]

/**
 * The market's review evidence rule. Metadata for indexes, which weigh a
 * review without that evidence near zero. Never a validation rule: a review
 * is valid with or without it.
 */
export const REVIEW_EVIDENCE = ['escrow', 'none']

/** Chains a market file may pin a token's mint on. */
export const CHAINS = ['solana']

// A market field is flat data. Anything structured would be a new shape.
const EXTRA_FIELD_TYPES = ['string', 'integer', 'boolean', 'array']
const EXTRA_ITEM_TYPES = ['string', 'integer', 'boolean']

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TOKEN_SYMBOL = /^[A-Z0-9]{1,16}$/

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
 * With a market file, the record is checked against the shape plus that
 * market's extra fields, and against the market's own rules (name, roles,
 * accepted tokens). The review evidence rule is not checked: it weighs,
 * it never rejects.
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

  const errors = market === undefined ? [] : marketRules(shape, record, market)
  return errors.length ? fail(shape, errors) : { ok: true, shape, errors: [] }
}

/** Check a market file. Returns { ok, errors }. */
export function validateMarket(market) {
  if (!isPlainObject(market)) return { ok: false, errors: ['market file must be a JSON object'] }
  const errors = []

  for (const key of MARKET_KEYS) {
    if (!(key in market)) errors.push(`missing "${key}"`)
  }
  for (const key of Object.keys(market)) {
    if (!MARKET_KEYS.includes(key)) {
      errors.push(`unknown key "${key}"; a market file has exactly: ${MARKET_KEYS.join(', ')}`)
    }
  }
  if (errors.length) return { ok: false, errors }

  if (typeof market.name !== 'string' || !SLUG.test(market.name) || market.name.length > 64) {
    errors.push('name must be a lowercase slug (letters, digits, hyphens), at most 64 characters')
  }

  if (!Array.isArray(market.roles) || market.roles.length === 0) {
    errors.push('roles must be a non-empty array of slugs')
  } else {
    for (const role of market.roles) {
      if (typeof role !== 'string' || !SLUG.test(role) || role.length > 64) {
        errors.push(`roles: ${JSON.stringify(role)} must be a lowercase slug, at most 64 characters`)
      }
    }
    if (new Set(market.roles).size !== market.roles.length) errors.push('roles must be distinct')
  }

  if (!Number.isInteger(market.silenceDays) || market.silenceDays < 1) {
    errors.push('silenceDays must be a whole number of days, at least 1')
  }

  if (typeof market.arbiterAllowed !== 'boolean') {
    errors.push('arbiterAllowed must be true or false')
  }

  if (!REVIEW_EVIDENCE.includes(market.reviewEvidence)) {
    errors.push(`reviewEvidence must be one of (${REVIEW_EVIDENCE.join('|')})`)
  }

  if (!Array.isArray(market.credentialIssuers)) {
    errors.push('credentialIssuers must be an array of DIDs (empty until issuers exist)')
  } else {
    for (const did of market.credentialIssuers) {
      if (!isValidDid(did)) errors.push(`credentialIssuers: ${JSON.stringify(did)} is not a DID`)
    }
  }

  if (!Array.isArray(market.tokens) || market.tokens.length === 0) {
    errors.push('tokens must be a non-empty array of { symbol, mint, chain }')
  } else {
    for (const token of market.tokens) {
      if (!isPlainObject(token) || Object.keys(token).sort().join(',') !== 'chain,mint,symbol') {
        errors.push('tokens: each entry has exactly "symbol", "mint", and "chain"; the market file is what pins a symbol to a mint')
        continue
      }
      if (typeof token.symbol !== 'string' || !TOKEN_SYMBOL.test(token.symbol)) {
        errors.push(`tokens: symbol ${JSON.stringify(token.symbol)} must be 1 to 16 uppercase letters or digits`)
      }
      if (typeof token.mint !== 'string' || !BASE58_KEY.test(token.mint)) {
        errors.push(`tokens: mint for ${JSON.stringify(token.symbol)} must be a base58 public key`)
      }
      if (!CHAINS.includes(token.chain)) {
        errors.push(`tokens: chain for ${JSON.stringify(token.symbol)} must be one of (${CHAINS.join('|')})`)
      }
    }
    const symbols = market.tokens.map((t) => t?.symbol)
    if (new Set(symbols).size !== symbols.length) errors.push('tokens: symbols must be distinct')
  }

  errors.push(...checkFields(market.fields))

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] }
}

/**
 * A copy of a shape's lexicon doc with one market's extra fields for that
 * shape merged in. Base fields come first; a market never redefines them.
 */
export function mergeMarket(doc, shape, market) {
  const merged = structuredClone(doc)
  const block = market.fields?.[shape]
  if (!isPlainObject(block)) return merged
  const record = merged.defs.main.record
  record.properties = { ...record.properties, ...(block.properties ?? {}) }
  record.required = [...(record.required ?? []), ...(block.required ?? [])]
  return merged
}

// The rule: fields only in allowed places, never a new shape.
function checkFields(fields) {
  if (!isPlainObject(fields)) {
    return [`fields must be an object keyed by shape (${MARKET_FIELD_PLACES.join(', ')})`]
  }
  const errors = []
  const docs = loadLexiconDocs()

  for (const [place, block] of Object.entries(fields)) {
    if (!MARKET_FIELD_PLACES.includes(place)) {
      errors.push(
        SHAPES.includes(place)
          ? `fields/${place}: a market file cannot add fields to a ${place}; allowed places are ${MARKET_FIELD_PLACES.join(', ')}`
          : `fields/${place}: not a shape. Market files add fields to ${MARKET_FIELD_PLACES.join(', ')}; they never add a new shape`,
      )
      continue
    }
    if (!isPlainObject(block)) {
      errors.push(`fields/${place} must be an object with "properties" and optional "required"`)
      continue
    }
    for (const key of Object.keys(block)) {
      if (key !== 'properties' && key !== 'required') {
        errors.push(`fields/${place}/${key}: only "properties" and "required" belong here`)
      }
    }

    const props = block.properties ?? {}
    if (!isPlainObject(props)) {
      errors.push(`fields/${place}/properties must be an object of field definitions`)
      continue
    }
    const base = docs[place].defs.main.record.properties
    for (const [name, def] of Object.entries(props)) {
      const path = `fields/${place}/properties/${name}`
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
      errors.push(`fields/${place}/required must be an array of this market's ${place} field names`)
    } else {
      for (const name of required) {
        if (!(name in props)) {
          errors.push(`fields/${place}/required: ${JSON.stringify(name)} is not one of this market's ${place} fields`)
        }
      }
    }
  }
  if (errors.length) return errors

  // Last: the merged lexicon must still be a valid lexicon. This catches bad
  // constraints inside an otherwise allowed field (maxLength: "ten").
  for (const place of Object.keys(fields)) {
    try {
      parseLexiconDoc(mergeMarket(docs[place], place, { fields }))
    } catch (e) {
      errors.push(`fields/${place}: ${describeLexiconError(e)}`)
    }
  }
  return errors
}

// Cross-checks a record against the market file it is meant for. A review is
// never checked against reviewEvidence: that rule weighs, it never rejects.
function marketRules(shape, record, market) {
  const errors = []
  if (shape === 'post') {
    if (record.market !== market.name) {
      errors.push(`Record/market must be "${market.name}", got ${JSON.stringify(record.market)}`)
    }
    if (!market.roles.includes(record.role)) {
      errors.push(`Record/role must be one of (${market.roles.join('|')}), got ${JSON.stringify(record.role)}`)
    }
    const symbols = market.tokens.map((t) => t.symbol)
    if (!symbols.includes(record.price?.token)) {
      errors.push(`Record/price/token must be one of (${symbols.join('|')}), got ${JSON.stringify(record.price?.token)}`)
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

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) deepFreeze(child)
    Object.freeze(v)
  }
  return v
}

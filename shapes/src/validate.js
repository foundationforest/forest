// Forest record shapes.
//
// Two checks, nothing else:
//   validateRecord(record, { market })  a record against its lexicon (a post
//                                       also against its own terms), and
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

/**
 * The seven keys of a market file, and nothing else. A market file describes
 * a deal shape and suggests starting values; it restricts no deal. The
 * arbiter, the token, the auto-release days and the cancellation steps are
 * the seller's, per offer, in the post's terms.
 */
export const MARKET_KEYS = [
  'name',
  'category',
  'roles',
  'fields',
  'evidenceTypes',
  'suggested',
  'credentialIssuers',
]

/**
 * The keys of a market file's `suggested` block: the starting values an app
 * offers a seller writing an offer's terms. Suggestions only; nothing
 * enforces them on a deal.
 */
export const SUGGESTED_KEYS = ['autoReleaseDays', 'cancellationSteps']

/** An escrow holds at most four cancellation steps. */
export const MAX_STEPS = 4

/** The largest auto-release days an escrow holds (sixteen bits). */
export const MAX_AUTO_RELEASE_DAYS = 65535

// A market field is flat data. Anything structured would be a new shape.
const EXTRA_FIELD_TYPES = ['string', 'integer', 'boolean', 'array']
const EXTRA_ITEM_TYPES = ['string', 'integer', 'boolean']

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/

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
 * A post is also checked against its own terms: an offer carries them, and
 * its cancellation steps rise and end by auto-release, as an escrow needs.
 * With a market file, the record is checked against the shape plus that
 * market's extra fields, and against the market's name and roles. Nothing in
 * a market file limits a post's terms or token, and evidence is not checked:
 * it weighs, it never rejects.
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

  const errors = shape === 'post' ? postRules(record) : []
  if (market !== undefined) errors.push(...marketRules(shape, record, market))
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

  if (typeof market.category !== 'string' || !SLUG.test(market.category) || market.category.length > 64) {
    errors.push('category must be a lowercase slug naming a deal shape (home-services, freelance-work, buy-and-sell, or a later one), at most 64 characters')
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

  errors.push(...checkSuggested(market.suggested))

  if (!Array.isArray(market.credentialIssuers)) {
    errors.push('credentialIssuers must be an array of DIDs (empty until issuers exist)')
  } else {
    for (const did of market.credentialIssuers) {
      if (!isValidDid(did)) errors.push(`credentialIssuers: ${JSON.stringify(did)} is not a DID`)
    }
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

// A market file's suggested starting values: exactly autoReleaseDays and
// cancellationSteps, each one an escrow could hold. Suggestions only.
function checkSuggested(suggested) {
  if (!isPlainObject(suggested)) {
    return [`suggested must be an object with exactly: ${SUGGESTED_KEYS.join(', ')}`]
  }
  const errors = []
  for (const key of SUGGESTED_KEYS) {
    if (!(key in suggested)) errors.push(`suggested: missing "${key}"`)
  }
  for (const key of Object.keys(suggested)) {
    if (!SUGGESTED_KEYS.includes(key)) {
      errors.push(`suggested: unknown key "${key}"; a market suggests only ${SUGGESTED_KEYS.join(' and ')}, and restricts nothing`)
    }
  }
  if (errors.length) return errors
  const days = suggested.autoReleaseDays
  if (!Number.isInteger(days) || days < 1 || days > MAX_AUTO_RELEASE_DAYS) {
    errors.push(`suggested/autoReleaseDays must be a whole number of days, 1 to ${MAX_AUTO_RELEASE_DAYS}`)
  }
  errors.push(...checkSteps(suggested.cancellationSteps, days, 'suggested/cancellationSteps', { strict: true }))
  return errors
}

// The rules an escrow holds cancellation steps to, so steps that pass here are
// steps an escrow can be created with: at most four, whole hours from the clock
// start, whole percents, deadlines strictly rising, and none after auto-release
// (or the buyer's cancellation and the seller's release race; the escrow
// client's `checkTerms` refuses the same). `strict` refuses keys beyond the two,
// as a market file does; records are open, so a post's steps are not strict.
function checkSteps(steps, autoReleaseDays, path, { strict }) {
  if (!Array.isArray(steps)) return [`${path} must be an array of { hours, refundPercent }`]
  const errors = []
  if (steps.length > MAX_STEPS) errors.push(`${path}: at most ${MAX_STEPS} steps`)
  let previous
  steps.forEach((step, i) => {
    const at = `${path}/${i}`
    if (!isPlainObject(step)) {
      errors.push(`${at} must be { hours, refundPercent }`)
      return
    }
    if (strict && Object.keys(step).sort().join(',') !== 'hours,refundPercent') {
      errors.push(`${at}: a step has exactly "hours" and "refundPercent"`)
    }
    if (!Number.isInteger(step.refundPercent) || step.refundPercent < 0 || step.refundPercent > 100) {
      errors.push(`${at}/refundPercent must be a whole percent, 0 to 100`)
    }
    if (!Number.isInteger(step.hours)) {
      errors.push(`${at}/hours must be a whole number of hours from the clock start`)
      return
    }
    if (previous !== undefined && step.hours <= previous) errors.push(`${at}: deadlines must strictly rise`)
    if (Number.isInteger(autoReleaseDays) && step.hours > autoReleaseDays * 24) {
      errors.push(
        `${at}: a deadline ${step.hours} hours out outlasts auto-release at ${autoReleaseDays * 24}; the buyer's cancellation and the seller's release would race`,
      )
    }
    previous = step.hours
  })
  return errors
}

// A post's own rules, with or without a market file: an offer carries the
// seller's terms, and its steps are ones an escrow can be created with.
function postRules(record) {
  const terms = record.terms
  if (terms === undefined) {
    return record.direction === 'offer'
      ? ["Record/terms: an offer carries the seller's terms (autoReleaseDays, and optional cancellationSteps and arbiter)"]
      : []
  }
  return checkSteps(terms.cancellationSteps ?? [], terms.autoReleaseDays, 'Record/terms/cancellationSteps', { strict: false })
}

// Cross-checks a post against the market file it is meant for: its name and
// its roles. Nothing in a market file limits a post's terms or its token, and
// evidence is never checked: it weighs, it never rejects.
function marketRules(shape, record, market) {
  const errors = []
  if (shape === 'post') {
    if (record.market !== market.name) {
      errors.push(`Record/market must be "${market.name}", got ${JSON.stringify(record.market)}`)
    }
    if (!market.roles.includes(record.role)) {
      errors.push(`Record/role must be one of (${market.roles.join('|')}), got ${JSON.stringify(record.role)}`)
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

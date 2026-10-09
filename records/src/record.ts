// A record: one signed version of one path in one profile's folder.
//
//   { v: 1, profile, path, time, body | null, by?, sig }
//
// `sig` is Ed25519 (RFC 8032, strict) over 0xff || "forest/v1/record\n" || JCS(the rest), by the
// main key, or by the access key named in `by`. 0xff can never begin a Solana transaction
// message, so a main key that also holds money cannot be made to sign a payment through this
// path, and no payment signature is a record's.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, concat, equalBytes, hex, utf8 } from './bytes.ts'
import { type Json, canonical, checkValue, parseCanonical } from './canonical.ts'
import { publicKeyFromAddress } from './keys.ts'

export const VERSION = 1
export const SIGN_PREFIX = concat(Uint8Array.of(0xff), utf8('forest/v1/record\n'))
/** Hosts refuse, and readers hold back, records dated further ahead than this. */
export const MAX_FUTURE_MS = 10 * 60 * 1000

export type Body = { [key: string]: Json }
export type UnsignedRecord = {
  v: 1
  /** The profile's address. */
  profile: string
  path: string
  time: number
  body: Body | null
  /** Present only when an access key signed: its address. */
  by?: string
}
export type SignedRecord = UnsignedRecord & { sig: string }
/** A record that passed every check, with its id. */
export type Checked = { record: SignedRecord; id: string }

export class RecordError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RecordError'
    this.code = code
  }
}
function fail(code: string, message: string): never {
  throw new RecordError(code, message)
}

// Paths: 1 to 4 segments of [a-z0-9][a-z0-9._-]{0,63}. `hosts` and `permissions` are the control
// paths only the owner writes. Everything else is content; indexes read profile, offer/<id> and
// review/<id>.
const SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}'
export const PATH = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,3}$`)
export const MAX_PATH = 256

/** A path whose first segment is a control record's: only `hosts` and `permissions` themselves are valid. */
export function isControlPath(path: string): boolean {
  const first = path.split('/')[0]
  return first === 'hosts' || first === 'permissions'
}

export function checkPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > MAX_PATH || !PATH.test(path)) fail('path', 'a path is segments of [a-z0-9][a-z0-9._-]')
  if (isControlPath(path) && path.includes('/')) fail('path', 'hosts and permissions are single paths')
}

/** Does a path prefix cover a path? Segment by segment: `offer` covers `offer/x`, not `offerx`. */
export function pathCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '/')
}

/** A private body: `{ private: <age file, base64url> }` and nothing else (private.ts opens it). */
export function isPrivate(body: Body | null): body is { private: string } {
  return body !== null && typeof body.private === 'string' && Object.keys(body).length === 1
}

const FIELDS = new Set(['v', 'profile', 'path', 'time', 'body', 'by', 'sig'])
const SIG = /^[A-Za-z0-9_-]{86}$/
const B64U = /^[A-Za-z0-9_-]+$/

/** Everything about a record but its signature. Throws RecordError. */
export function checkShape(value: unknown, signed = true): asserts value is SignedRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('shape', 'a record is an object')
  const r = value as { [key: string]: unknown }
  for (const key of Object.keys(r)) if (!FIELDS.has(key)) fail('shape', `unknown field ${key}`)
  if (r.v !== VERSION) fail('version', 'v must be 1')
  if (!publicKeyFromAddress(r.profile)) fail('key', 'profile is not a usable ed25519 address')
  checkPath(r.path)
  if (!Number.isSafeInteger(r.time) || (r.time as number) < 0) fail('time', 'time is whole milliseconds since 1970')
  if (r.body !== null) {
    if (typeof r.body !== 'object' || Array.isArray(r.body)) fail('body', 'body is an object or null')
    try {
      checkValue(r.body, 1)
    } catch (err) {
      fail('body', (err as Error).message)
    }
  }
  if ('by' in r) {
    if (!publicKeyFromAddress(r.by)) fail('key', 'by is not a usable ed25519 address')
    if (r.by === r.profile) fail('shape', 'the owner signs without by')
    if (isControlPath(r.path as string)) fail('control', 'only the owner writes hosts and permissions')
  }
  if (signed) {
    if (typeof r.sig !== 'string' || !SIG.test(r.sig)) fail('shape', 'sig is 64 bytes in base64url')
  } else if ('sig' in r) fail('shape', 'an unsigned record carries no sig')
  if (isControlPath(r.path as string) && r.body !== null) checkControlBody(r.path as string, r.body as Body)
}

export function unsignedOf(record: SignedRecord): UnsignedRecord {
  const { sig: _sig, ...rest } = record
  return rest
}

export function signingInput(unsigned: UnsignedRecord): Uint8Array {
  return concat(SIGN_PREFIX, utf8(canonical(unsigned)))
}

/** The record's id: SHA-256 of what was signed, so a re-encoded signature is not a new record. */
export function recordId(unsigned: UnsignedRecord): string {
  return hex.encode(sha256(signingInput(unsigned)))
}

export function signRecord(unsigned: UnsignedRecord, privateKey: Uint8Array): SignedRecord {
  checkShape(unsigned, false)
  const signer = publicKeyFromAddress(unsigned.by ?? unsigned.profile)!
  if (!equalBytes(ed25519.getPublicKey(privateKey), signer)) fail('key', 'the private key is not the signer the record names')
  return { ...unsigned, sig: b64u.encode(ed25519.sign(signingInput(unsigned), privateKey)) }
}

/**
 * Strict Ed25519: S below the group order, canonical encodings, and both R and the key in the
 * prime-order subgroup (the key also not of small order), then RFC 8032's cofactorless check.
 * With R and A torsion-free, every correct verifier, cofactored or not, gives the same answer.
 */
export function verifySignature(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (sig.length !== 64 || publicKey.length !== 32) return false
  try {
    const R = ed25519.Point.fromBytes(sig.subarray(0, 32), false)
    const A = ed25519.Point.fromBytes(publicKey, false)
    if (!R.isTorsionFree() || !A.isTorsionFree() || A.isSmallOrder()) return false
    return ed25519.verify(sig, message, publicKey, { zip215: false })
  } catch {
    return false
  }
}

/** Shape and signature. Returns the record with its id. Throws RecordError. How large a record to take is each host's policy, and each reader's. */
export function checkRecord(value: unknown): Checked {
  checkShape(value)
  const record = value
  const unsigned = unsignedOf(record)
  const signer = publicKeyFromAddress(record.by ?? record.profile)!
  if (!verifySignature(b64u.decode(record.sig), signingInput(unsigned), signer)) fail('signature', 'the signature does not verify')
  return { record, id: recordId(unsigned) }
}

/** A record's wire form: exactly its canonical text. */
export function encodeRecord(record: SignedRecord): string {
  return canonical(record)
}

/** Read one record off the wire: the text must be canonical, then every check. */
export function decodeRecord(text: string): Checked {
  let value: Json
  try {
    value = parseCanonical(text)
  } catch (err) {
    return fail('canonical', (err as Error).message)
  }
  return checkRecord(value)
}

// ---------------------------------------------------------------------------------------------
// Control records. Only the owner writes these. A field a reader does not know refuses the whole
// record, so a later limit can never be silently ignored.

export type HostsBody = {
  /** Where this profile's records live, as https origins (http only on loopback, for tests). */
  urls: string[]
}

/**
 * What an access key is for. write: signing records where its paths allow. message: signing
 * messages for the main key, and pulling its inbox. read: opening what is sealed to it.
 */
export type Scope = 'write' | 'message' | 'read'
export const SCOPES: readonly Scope[] = ['write', 'message', 'read']

/**
 * A listed key: one that acts, with its `scope`; or a past key, a write or message key the owner
 * removed, with `was`, the scope it had, in place of `scope`. A past key can no longer act: nothing
 * that checks a scope finds one. What a past write key wrote still counts, at its paths; a past
 * message key never counts for writing.
 */
export type AccessKey = {
  /** Its public half: an address, or a read key's age post-quantum hybrid recipient (age1pq1…). */
  key: string
  /** What it may do; on a key that acts, and only there. */
  scope?: Scope
  /** The scope a past key had; on a past key, and only there. */
  was?: 'write' | 'message'
  /**
   * Content path prefixes it works under, segment by segment: where a write key writes, and which
   * private records the owner's devices seal to a read key. Without it, every content path but
   * those `profile` and `grants` cover. Never on a message key, past or not.
   */
  paths?: string[]
}
export type PermissionsBody = {
  access: AccessKey[]
  /** The owner's notes on its keys: an envelope sealed to its own inbox key alone, base64url (makeNotes and openNotes in private.ts). */
  notes?: string
}

export const MAX_HOSTS = 8
export const MAX_ACCESS_PATHS = 16
/** An age post-quantum hybrid recipient (mlkem768x25519): an inbox key's or a read key's public half. */
export const RECIPIENT = /^age1pq1[02-9ac-hj-np-z]{1952}$/

const only = (body: object, fields: string[], code: string, what: string) => {
  for (const key of Object.keys(body)) if (!fields.includes(key)) fail(code, `unknown ${what} field ${key}`)
}

/** An access key's paths: at most MAX_ACCESS_PATHS content path prefixes. Throws RecordError with `code`. */
export function checkAccessPaths(paths: unknown, code: string): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length > MAX_ACCESS_PATHS) fail(code, `paths is at most ${MAX_ACCESS_PATHS} prefixes`)
  for (const p of paths as unknown[]) if (typeof p !== 'string' || !PATH.test(p) || isControlPath(p)) fail(code, 'an access path is a content path prefix')
}

export function checkControlBody(path: string, body: Body): void {
  if (path === 'hosts') {
    only(body, ['urls'], 'hosts', 'hosts')
    const urls = body.urls
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_HOSTS) fail('hosts', `urls is 1 to ${MAX_HOSTS} origins`)
    for (const url of urls as unknown[]) if (typeof url !== 'string' || normalizeOrigin(url) !== url) fail('hosts', 'each url is an origin, https (http only on loopback)')
    if (new Set(urls as string[]).size !== (urls as string[]).length) fail('hosts', 'urls repeat')
    return
  }
  only(body, ['access', 'notes'], 'permissions', 'permissions')
  const access = body.access
  if (!Array.isArray(access)) fail('permissions', 'access is a list of keys')
  if ('notes' in body && (typeof body.notes !== 'string' || !B64U.test(body.notes))) fail('permissions', 'notes is an envelope in base64url')
  const listed = new Set<unknown>()
  for (const k of access as unknown[]) {
    if (k === null || typeof k !== 'object' || Array.isArray(k)) fail('permissions', 'an access entry is an object')
    only(k, ['key', 'scope', 'was', 'paths'], 'permissions', 'access')
    const { key, scope, was, paths } = k as { [key: string]: unknown }
    if ('was' in (k as object) ? 'scope' in (k as object) || (was !== 'write' && was !== 'message') : !SCOPES.includes(scope as Scope)) {
      fail('permissions', `scope is one of ${SCOPES.join(', ')}; a past key has was, write or message, in its place`)
    }
    const had = (scope ?? was) as Scope
    if (had === 'read') {
      if (typeof key !== 'string' || !RECIPIENT.test(key)) fail('permissions', 'a read key is an age post-quantum hybrid recipient, age1pq1…')
    } else if (!publicKeyFromAddress(key)) fail('permissions', 'an access key is a usable ed25519 address')
    if ('paths' in (k as object)) {
      if (had === 'message') fail('permissions', 'a message key has no paths')
      checkAccessPaths(paths, 'permissions')
    }
    if (listed.has(key)) fail('permissions', 'a key is listed twice')
    listed.add(key)
  }
}

/** The origin form hosts are named by, or null. https only, except http on loopback for tests. */
export function normalizeOrigin(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  return u.origin
}

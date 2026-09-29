// An entry: one signed version of one path in one profile's folder.
//
//   { v: 1, profile, path, time, body | null, by?, grant?, sig }
//
// `sig` is Ed25519 (RFC 8032, strict) over 0xff || "forest.foundation/entry/v1\n" || JCS(the rest).
// 0xff can never begin a Solana transaction message, so a profile key that also holds money
// cannot be made to sign a payment through this path, and no payment signature is an entry's.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, concat, hex, utf8 } from './bytes.ts'
import { type Json, canonical, checkValue, parseCanonical } from './canonical.ts'
import { publicKeyFromDid } from './keys.ts'

export const VERSION = 1
export const SIGN_PREFIX = concat(Uint8Array.of(0xff), utf8('forest.foundation/entry/v1\n'))
/** The largest entry, as canonical text. Bigger things are blobs, addressed by hash. */
export const MAX_ENTRY_BYTES = 64 * 1024
/** Hosts and readers hold back entries dated further ahead than this. */
export const MAX_FUTURE_MS = 10 * 60 * 1000

export type Body = { [key: string]: Json }
export type Unsigned = {
  v: 1
  profile: string
  path: string
  time: number
  body: Body | null
  /** Present only when a delegate signed: the delegate's did:key. */
  by?: string
  /** Present only with `by`: the id of the exact grant version the delegate signs under. */
  grant?: string
}
export type Entry = Unsigned & { sig: string }
/** An entry that passed every check, with its id. */
export type Checked = { entry: Entry; id: string }

export class EntryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'EntryError'
    this.code = code
  }
}
function fail(code: string, message: string): never {
  throw new EntryError(code, message)
}

// Paths: 1 to 4 segments of [a-z0-9][a-z0-9._-]{0,63}. `folder` and `grant/<id>` are control
// paths only the owner writes. Content is everything else; indexes read profile, offer/<id>,
// review/<id> and proof/<id>.
const SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}'
export const PATH = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,3}$`)
export const MAX_PATH = 256

export function isControlPath(path: string): boolean {
  const first = path.split('/')[0]
  return first === 'folder' || first === 'grant'
}

export function checkPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > MAX_PATH || !PATH.test(path)) fail('path', 'path is not segments of [a-z0-9][a-z0-9._-]')
  const segments = path.split('/')
  if (segments[0] === 'folder' && segments.length !== 1) fail('path', 'the folder is the single path "folder"')
  if (segments[0] === 'grant' && segments.length !== 2) fail('path', 'a grant lives at grant/<id>')
}

/** Does a grant's path prefix cover a path? Segment by segment: `offer` covers `offer/x`, not `offerx`. */
export function pathCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + '/')
}

const FIELDS = new Set(['v', 'profile', 'path', 'time', 'body', 'by', 'grant', 'sig'])
const ID = /^[0-9a-f]{64}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

/** Everything about an entry but its signature. Throws EntryError. */
export function checkShape(value: unknown, signed = true): asserts value is Entry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('shape', 'an entry is an object')
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) if (!FIELDS.has(key)) fail('shape', `unknown field ${key}`)
  if (e.v !== VERSION) fail('version', 'v must be 1')
  if (!publicKeyFromDid(e.profile)) fail('key', 'profile is not a usable ed25519 did:key')
  checkPath(e.path)
  if (!Number.isSafeInteger(e.time) || (e.time as number) < 0) fail('time', 'time is whole milliseconds since 1970')
  if (e.body !== null) {
    if (typeof e.body !== 'object' || Array.isArray(e.body)) fail('body', 'body is an object or null')
    try {
      checkValue(e.body, 1)
    } catch (err) {
      fail('body', (err as Error).message)
    }
  }
  if ('by' in e || 'grant' in e) {
    if (!publicKeyFromDid(e.by)) fail('key', 'by is not a usable ed25519 did:key')
    if (e.by === e.profile) fail('shape', 'the owner signs without by and grant')
    if (typeof e.grant !== 'string' || !ID.test(e.grant)) fail('shape', 'a delegate names the grant version it signs under')
    if (isControlPath(e.path as string)) fail('control', 'only the owner writes folder and grants')
  }
  if (signed) {
    if (typeof e.sig !== 'string' || !SIG.test(e.sig)) fail('shape', 'sig is 64 bytes in base64url')
  } else if ('sig' in e) fail('shape', 'unsigned entries carry no sig')
  if (isControlPath(e.path as string) && e.body !== null) checkControlBody(e.path as string, e.body as Body)
}

export function unsignedOf(entry: Entry): Unsigned {
  const { sig: _sig, ...rest } = entry
  return rest
}

export function signingInput(unsigned: Unsigned): Uint8Array {
  return concat(SIGN_PREFIX, utf8(canonical(unsigned)))
}

/** The entry's id: SHA-256 of what was signed, so a re-encoded signature is not a new entry. */
export function entryId(unsigned: Unsigned): string {
  return hex.encode(sha256(signingInput(unsigned)))
}

export function signEntry(unsigned: Unsigned, secretKey: Uint8Array): Entry {
  checkShape(unsigned, false)
  const signer = unsigned.by ?? unsigned.profile
  const publicKey = publicKeyFromDid(signer)!
  const derived = ed25519.getPublicKey(secretKey)
  if (hex.encode(derived) !== hex.encode(publicKey)) fail('key', 'the secret key is not the signer named in the entry')
  const entry: Entry = { ...unsigned, sig: b64u.encode(ed25519.sign(signingInput(unsigned), secretKey)) }
  if (canonical(entry).length > MAX_ENTRY_BYTES) fail('size', `an entry is at most ${MAX_ENTRY_BYTES} bytes`)
  return entry
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

/** Shape, size and signature. Returns the entry's id. Throws EntryError. */
export function checkEntry(value: unknown): Checked {
  checkShape(value)
  const entry = value
  const text = canonical(entry)
  if (text.length > MAX_ENTRY_BYTES) fail('size', `an entry is at most ${MAX_ENTRY_BYTES} bytes`)
  const unsigned = unsignedOf(entry)
  const signer = publicKeyFromDid(entry.by ?? entry.profile)!
  if (!verifySignature(b64u.decode(entry.sig), signingInput(unsigned), signer)) fail('signature', 'signature does not verify')
  return { entry, id: entryId(unsigned) }
}

/** An entry's wire form: exactly its canonical text. */
export function encodeEntry(entry: Entry): string {
  return canonical(entry)
}

/** Read one entry off the wire: the text must be canonical, then every check. */
export function decodeEntry(text: string): Checked {
  if (text.length > MAX_ENTRY_BYTES) fail('size', `an entry is at most ${MAX_ENTRY_BYTES} bytes`)
  let value: Json
  try {
    value = parseCanonical(text)
  } catch (err) {
    return fail('canonical', (err as Error).message)
  }
  return checkEntry(value)
}

// ---------------------------------------------------------------------------------------------
// Control bodies. The owner writes these; a malformed one grants or names nothing.

export type FolderBody = {
  /** Where this profile's entries live, as https origins (http only for loopback, in tests). */
  hosts: string[]
  /** An age recipient others seal entries to: `age1pq1…` (post-quantum hybrid) or `age1…`. */
  box?: string
  /** Days a host keeps a version after it stops being current. Default 30. */
  keep?: number
}

export type GrantBody = {
  /** The delegate's did:key. */
  to: string
  /** Path prefixes it may write under, segment by segment. Never control paths. */
  paths: string[]
  /** Nothing it signed counts once a reader's clock passes this (milliseconds since 1970). */
  until: number
  /** Words for the owner's app: "Claude, for offers". */
  label?: string
  /** The client the grant was made for (an OAuth client id), for the owner's app to show. */
  client?: string
}

export const DEFAULT_KEEP_DAYS = 30
export const MAX_HOSTS = 8
export const MAX_GRANT_PATHS = 16

const FOLDER_FIELDS = new Set(['hosts', 'box', 'keep'])
const GRANT_FIELDS = new Set(['to', 'paths', 'until', 'label', 'client'])

export function checkControlBody(path: string, body: Body): void {
  if (path === 'folder') {
    for (const key of Object.keys(body)) if (!FOLDER_FIELDS.has(key)) fail('folder', `unknown folder field ${key}`)
    const hosts = body.hosts
    if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > MAX_HOSTS) fail('folder', `hosts is 1 to ${MAX_HOSTS} origins`)
    for (const host of hosts as unknown[]) if (typeof host !== 'string' || normalizeOrigin(host) !== host) fail('folder', 'each host is an origin, https (http only on loopback)')
    if (new Set(hosts as string[]).size !== (hosts as string[]).length) fail('folder', 'hosts repeat')
    if ('box' in body && (typeof body.box !== 'string' || !/^age1[0-9a-z]{1,4000}$/.test(body.box))) fail('folder', 'box is an age recipient')
    if ('keep' in body && (!Number.isSafeInteger(body.keep) || (body.keep as number) < 0 || (body.keep as number) > 3650)) fail('folder', 'keep is 0 to 3650 days')
    return
  }
  // grant/<id>
  for (const key of Object.keys(body)) if (!GRANT_FIELDS.has(key)) fail('grant', `unknown grant field ${key}: a grant with a field a reader does not know grants nothing`)
  if (!publicKeyFromDid(body.to)) fail('grant', 'to is a usable ed25519 did:key')
  const paths = body.paths
  if (!Array.isArray(paths) || paths.length > MAX_GRANT_PATHS) fail('grant', `paths is at most ${MAX_GRANT_PATHS} prefixes`)
  for (const p of paths as unknown[]) {
    if (typeof p !== 'string' || !PATH.test(p) || isControlPath(p)) fail('grant', 'a grant path is a content path prefix')
  }
  if (!Number.isSafeInteger(body.until) || (body.until as number) < 0) fail('grant', 'until is whole milliseconds since 1970')
  for (const key of ['label', 'client'] as const) {
    if (key in body && (typeof body[key] !== 'string' || (body[key] as string).length > 200)) fail('grant', `${key} is text of at most 200 characters`)
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

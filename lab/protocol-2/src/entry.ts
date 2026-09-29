// The log. A profile is an ordered list of signed entries; each entry names the one before it by
// content id, so nobody can insert, reorder or drop one in the middle without breaking the chain.
// Every entry is signed by the profile's key or by a delegate under a grant the profile signed
// earlier in the same log. A reader who has the entries needs nothing else to check them all.
//
// This file is the protocol: the shape of an entry, how one is signed, and the rules that make the
// next entry valid. `SPEC.md` says the same in words; when they differ, both are wrong.

import { CID, cidOf, concat, encode, decode, utf8 } from './codec.ts'
import { isProfileDid, isReaderDid, keyFromDid } from './did.ts'
import { verifySignature, type Signer } from './keys.ts'

export const ENTRY_VERSION = 1
export const SIGN_CONTEXT = utf8('forest/entry/1')
export const MAX_ENTRY_BYTES = 65_536
export const MAX_KEY_LENGTH = 512
export const MAX_COLLECTION_LENGTH = 256

export type Op = 'put' | 'del' | 'grant' | 'revoke' | 'keys'
export type WriteOp = 'put' | 'del'

/** What a delegate may do. Signed by the profile key inside a `grant` entry. */
export type Grant = {
  /** The delegate's signing key, as did:key. */
  to: string
  /** The delegate's reader key, so private records can be addressed to it. Optional. */
  reader?: string
  /** Public collections it may write; `*` for any. */
  cols: string[]
  /** `put`, `del`, or both. A delegate can never grant, revoke or publish keys. */
  ops: WriteOp[]
  /** Whether it may write private records. */
  private?: boolean
  /** Unix seconds after which the grant no longer counts. */
  exp: number
  /** At most this many entries under this grant, counted in the log. Optional. */
  max?: number
  /** For people to read. Optional. */
  note?: string
}

/** A private record's ciphertext and the content key wrapped to each reader. See private.ts. */
export type Enc = {
  alg: string
  iv: Uint8Array
  ct: Uint8Array
  to: { kid: string; enc: Uint8Array; ct: Uint8Array }[]
}

export type Unsigned = {
  v: 1
  did: string
  seq: number
  prev: CID | null
  at: number
  op: Op
  by?: string
  via?: CID
  col?: string
  key?: string
  rec?: Record<string, unknown>
  enc?: Enc
}

export type Entry = Unsigned & { sig: Uint8Array }

export type ErrorCode =
  | 'shape'
  | 'size'
  | 'seq'
  | 'prev'
  | 'signature'
  | 'unknown-grant'
  | 'not-granted'
  | 'revoked'
  | 'expired'
  | 'scope'
  | 'limit'

export class EntryError extends Error {
  code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

export type GrantState = { grant: Grant; seq: number; cid: string; used: number; revokedAt?: number }
export type RecordState = { cid: string; seq: number; rec: Record<string, unknown> }
export type PrivateState = { cid: string; seq: number; enc: Enc }

/** Everything the log says right now, folded from its entries. */
export type State = {
  did: string
  head: { seq: number; cid: CID; at: number } | null
  reader: string | null
  grants: Map<string, GrantState>
  records: Map<string, RecordState>
  privates: Map<string, PrivateState>
}

export function emptyState(did: string): State {
  return { did, head: null, reader: null, grants: new Map(), records: new Map(), privates: new Map() }
}

export function recordKey(col: string, key: string): string {
  return `${col}\u0000${key}`
}

// Signing and encoding

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v
  return out as T
}

export function signingMessage(unsigned: Unsigned): Uint8Array {
  return concat(SIGN_CONTEXT, encode(stripUndefined(unsigned)))
}

export function signEntry(signer: Signer, unsigned: Unsigned): { entry: Entry; bytes: Uint8Array; cid: CID } {
  const clean = stripUndefined(unsigned)
  const sig = signer.sign(signingMessage(clean))
  const entry: Entry = { ...clean, sig }
  const bytes = encode(entry)
  return { entry, bytes, cid: cidOf(bytes) }
}

export function encodeEntry(entry: Entry): Uint8Array {
  return encode(stripUndefined(entry))
}

export function decodeEntry(bytes: Uint8Array): { entry: Entry; cid: CID } {
  if (bytes.length > MAX_ENTRY_BYTES) throw new EntryError('size', `entry is ${bytes.length} bytes; the limit is ${MAX_ENTRY_BYTES}`)
  let entry: Entry
  try {
    entry = decode<Entry>(bytes)
  } catch (e) {
    throw new EntryError('shape', `not DAG-CBOR: ${(e as Error).message}`)
  }
  checkShape(entry)
  return { entry, cid: cidOf(bytes) }
}

// Shape: what an entry must look like before any rule about the log applies.

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof CID)
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isBytes = (v: unknown, n?: number): v is Uint8Array => v instanceof Uint8Array && (n === undefined || v.length === n)
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max

const OPS: Op[] = ['put', 'del', 'grant', 'revoke', 'keys']
const WRITE_OPS: WriteOp[] = ['put', 'del']

function shape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EntryError('shape', message)
}

export function checkGrant(rec: unknown): asserts rec is Grant {
  shape(isPlain(rec), 'a grant is an object')
  shape(isProfileDid(rec.to), 'grant.to is a did:key of an ed25519 key')
  shape(rec.reader === undefined || isReaderDid(rec.reader), 'grant.reader is a did:key of an X25519 key')
  shape(Array.isArray(rec.cols) && rec.cols.every((c) => isText(c, MAX_COLLECTION_LENGTH)), 'grant.cols is a list of collection names')
  shape(Array.isArray(rec.ops) && rec.ops.length > 0 && rec.ops.every((o) => WRITE_OPS.includes(o as WriteOp)), 'grant.ops is put, del or both')
  shape(rec.private === undefined || typeof rec.private === 'boolean', 'grant.private is a boolean')
  shape(isUint(rec.exp), 'grant.exp is unix seconds')
  shape(rec.max === undefined || (isUint(rec.max) && rec.max >= 1), 'grant.max is a count of 1 or more')
  shape(rec.note === undefined || isText(rec.note, 1000), 'grant.note is short text')
  for (const k of Object.keys(rec)) shape(['to', 'reader', 'cols', 'ops', 'private', 'exp', 'max', 'note'].includes(k), `grant has no field ${k}`)
}

function checkEnc(enc: unknown): asserts enc is Enc {
  shape(isPlain(enc), 'enc is an object')
  shape(isText(enc.alg, 64), 'enc.alg names the scheme')
  shape(isBytes(enc.iv, 12), 'enc.iv is 12 bytes')
  shape(isBytes(enc.ct) && enc.ct.length >= 16, 'enc.ct is the ciphertext')
  shape(Array.isArray(enc.to) && enc.to.length >= 1, 'enc.to lists at least one reader')
  for (const r of enc.to) {
    shape(isPlain(r) && isReaderDid(r.kid) && isBytes(r.enc, 32) && isBytes(r.ct, 48), 'each reader has kid, enc and ct')
  }
}

export function checkShape(e: unknown): asserts e is Entry {
  shape(isPlain(e), 'an entry is an object')
  shape(e.v === ENTRY_VERSION, 'v is 1')
  shape(isProfileDid(e.did), 'did is a did:key of an ed25519 key')
  shape(isUint(e.seq), 'seq is a whole number')
  shape(e.seq === 0 ? e.prev === null : e.prev instanceof CID, 'prev is null at seq 0 and a CID after')
  shape(isUint(e.at) && e.at > 0, 'at is unix seconds')
  shape(OPS.includes(e.op as Op), 'op is put, del, grant, revoke or keys')
  shape(isBytes(e.sig, 64), 'sig is 64 bytes')
  shape((e.by === undefined) === (e.via === undefined), 'by and via come together')
  if (e.by !== undefined) {
    shape(isProfileDid(e.by) && e.by !== e.did, 'by is another did:key')
    shape(e.via instanceof CID, 'via is the grant entry\'s CID')
    shape(WRITE_OPS.includes(e.op as WriteOp), 'a delegate only puts and deletes')
  }
  const allowed: Record<Op, string[]> = {
    put: ['col', 'key', 'rec', 'enc'],
    del: ['col', 'key'],
    grant: ['rec'],
    revoke: ['rec'],
    keys: ['rec'],
  }
  for (const k of Object.keys(e)) {
    shape(['v', 'did', 'seq', 'prev', 'at', 'op', 'by', 'via', 'sig', ...allowed[e.op as Op]].includes(k), `${e.op} has no field ${k}`)
  }
  switch (e.op as Op) {
    case 'put':
      shape(isText(e.key, MAX_KEY_LENGTH), 'put.key is text')
      if (e.enc !== undefined) {
        shape(e.col === undefined && e.rec === undefined, 'a private put has enc and nothing else')
        checkEnc(e.enc)
      } else {
        shape(isText(e.col, MAX_COLLECTION_LENGTH), 'put.col is the collection')
        shape(isPlain(e.rec), 'put.rec is the record')
      }
      break
    case 'del':
      shape(isText(e.key, MAX_KEY_LENGTH), 'del.key is text')
      shape(e.col === undefined || isText(e.col, MAX_COLLECTION_LENGTH), 'del.col is the collection')
      break
    case 'grant':
      checkGrant(e.rec)
      break
    case 'revoke':
      shape(isPlain(e.rec) && e.rec.grant instanceof CID && Object.keys(e.rec).length === 1, 'revoke.rec is { grant: CID }')
      break
    case 'keys':
      shape(isPlain(e.rec) && isReaderDid(e.rec.reader) && Object.keys(e.rec).length === 1, 'keys.rec is { reader: did:key }')
      break
  }
}

// The rules: is this entry the valid next one for this state?

/**
 * Checks an entry against the state and returns the new state. Throws an EntryError naming what
 * failed. The state is never mutated on failure.
 */
export function applyEntry(state: State, entry: Entry, cid: CID): State {
  checkShape(entry)
  if (entry.did !== state.did) throw new EntryError('shape', `entry is for ${entry.did}, the log is ${state.did}`)
  const expectedSeq = state.head ? state.head.seq + 1 : 0
  if (entry.seq !== expectedSeq) throw new EntryError('seq', `expected seq ${expectedSeq}, got ${entry.seq}`)
  if (state.head) {
    if (!entry.prev || !entry.prev.equals(state.head.cid)) throw new EntryError('prev', `prev must be the head ${state.head.cid}`)
  }

  // Who signed, and were they allowed to?
  const { sig, ...unsigned } = entry
  let grantState: GrantState | undefined
  if (entry.by !== undefined) {
    grantState = state.grants.get(entry.via!.toString())
    if (!grantState) throw new EntryError('unknown-grant', `no grant ${entry.via} in this log`)
    const g = grantState.grant
    if (g.to !== entry.by) throw new EntryError('not-granted', `grant ${entry.via} is for ${g.to}, not ${entry.by}`)
    if (grantState.revokedAt !== undefined) throw new EntryError('revoked', `grant ${entry.via} was revoked at seq ${grantState.revokedAt}`)
    if (entry.at > g.exp) throw new EntryError('expired', `grant ${entry.via} expired at ${g.exp}; entry says ${entry.at}`)
    if (!g.ops.includes(entry.op as WriteOp)) throw new EntryError('scope', `grant ${entry.via} does not allow ${entry.op}`)
    if (entry.enc !== undefined || (entry.op === 'del' && entry.col === undefined)) {
      if (!g.private) throw new EntryError('scope', `grant ${entry.via} does not allow private records`)
    } else if (!g.cols.includes('*') && !g.cols.includes(entry.col!)) {
      throw new EntryError('scope', `grant ${entry.via} does not cover collection ${entry.col}`)
    }
    if (g.max !== undefined && grantState.used >= g.max) throw new EntryError('limit', `grant ${entry.via} allows ${g.max} entries; all used`)
  }
  const signerDid = entry.by ?? entry.did
  const { publicKey } = keyFromDid(signerDid)
  if (!verifySignature(publicKey, signingMessage(unsigned as Unsigned), sig)) {
    throw new EntryError('signature', `signature does not verify against ${signerDid}`)
  }

  // Apply.
  const next: State = {
    did: state.did,
    head: { seq: entry.seq, cid, at: entry.at },
    reader: state.reader,
    grants: new Map(state.grants),
    records: new Map(state.records),
    privates: new Map(state.privates),
  }
  if (grantState) next.grants.set(entry.via!.toString(), { ...grantState, used: grantState.used + 1 })
  switch (entry.op) {
    case 'put':
      if (entry.enc) next.privates.set(entry.key!, { cid: cid.toString(), seq: entry.seq, enc: entry.enc })
      else next.records.set(recordKey(entry.col!, entry.key!), { cid: cid.toString(), seq: entry.seq, rec: entry.rec! })
      break
    case 'del':
      if (entry.col === undefined) next.privates.delete(entry.key!)
      else next.records.delete(recordKey(entry.col, entry.key!))
      break
    case 'grant':
      next.grants.set(cid.toString(), { grant: entry.rec as Grant, seq: entry.seq, cid: cid.toString(), used: 0 })
      break
    case 'revoke': {
      const target = (entry.rec as { grant: CID }).grant.toString()
      const g = next.grants.get(target)
      if (!g) throw new EntryError('unknown-grant', `nothing to revoke: no grant ${target}`)
      next.grants.set(target, { ...g, revokedAt: entry.seq })
      break
    }
    case 'keys':
      next.reader = (entry.rec as { reader: string }).reader
      break
  }
  return next
}

/** Folds a whole log from its encoded entries. Any reader can do this with nothing but the bytes. */
export function verifyLog(did: string, entries: Uint8Array[]): State {
  let state = emptyState(did)
  for (const bytes of entries) {
    const { entry, cid } = decodeEntry(bytes)
    state = applyEntry(state, entry, cid)
  }
  return state
}

// Encoding. Every byte anyone signs, hashes or stores is DAG-CBOR (IPLD's deterministic CBOR
// profile), and every reference is a CIDv1 over SHA-256 of those bytes. Both are used unchanged
// from the libraries the AT Protocol, IPFS and Filecoin use. Nothing here is Forest's own.

import * as dagCbor from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad, base58 } from '@scure/base'

export { CID }

export const DAG_CBOR = dagCbor.code
const SHA2_256 = 0x12

export function encode(value: unknown): Uint8Array {
  return dagCbor.encode(value)
}

export function decode<T = unknown>(bytes: Uint8Array): T {
  return dagCbor.decode(bytes) as T
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes)
}

/** CIDv1, dag-cbor, sha2-256: the content id of encoded bytes. */
export function cidOf(bytes: Uint8Array): CID {
  return CID.createV1(DAG_CBOR, Digest.create(SHA2_256, nobleSha256(bytes)))
}

/** CIDv1, raw, sha2-256: the content id of a blob (a photo, a video). */
export function blobCid(bytes: Uint8Array): CID {
  return CID.createV1(raw.code, Digest.create(SHA2_256, nobleSha256(bytes)))
}

export function parseCid(text: string): CID {
  return CID.parse(text)
}

export const b64 = {
  encode: (bytes: Uint8Array) => base64urlnopad.encode(bytes),
  decode: (text: string) => base64urlnopad.decode(text),
}

export const b58 = {
  encode: (bytes: Uint8Array) => base58.encode(bytes),
  decode: (text: string) => base58.decode(text),
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** A copy in its own plain ArrayBuffer, the shape Web Crypto and fetch accept. */
export function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view)
}

export function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/**
 * A JSON view of a decoded value: CIDs as their string form, bytes as base64url. For people and
 * AIs reading records; never the form anything is signed over.
 */
export function toJson(value: unknown): unknown {
  if (value instanceof CID) return value.toString()
  if (value instanceof Uint8Array) return b64.encode(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v)
    return out
  }
  return value
}

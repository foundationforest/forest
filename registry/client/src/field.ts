// Field elements, and the one hash the registry derives everything public from.

import { keccak_256 } from '@noble/hashes/sha3.js'

/** BN254's scalar field order. Every public signal is below it. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** BN254's base field modulus. Only used to work out a point's y sign. */
export const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n

/** The namespaces the program hashes with. Sealed: a change makes every existing code unreachable. */
export const SCOPE_NS = 'forest.foundation/market/v1/'
export const MESSAGE_NS = 'forest.foundation/profile/v1/'

export function toBytes32(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError('not a 256-bit value')
  const out = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

export function fromBytes32(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) throw new RangeError('expected 32 bytes')
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

export function isFieldElement(value: bigint): boolean {
  return value >= 0n && value < BN254_R
}

/**
 * `keccak256(namespace || bytes) >> 8`, the same bytes the program hashes.
 *
 * Semaphore's own proof package hashes a 32-byte big-endian number this way, which caps a scope
 * at 32 bytes. Hashing a namespaced string instead lets a market name or a DID be any length,
 * and keeps one namespace's values from ever colliding with another's. The shift by one byte is
 * what keeps the result below `BN254_R`.
 */
export function fieldHash(namespace: string, value: string | Uint8Array): bigint {
  const ns = new TextEncoder().encode(namespace)
  const v = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const input = new Uint8Array(ns.length + v.length)
  input.set(ns)
  input.set(v, ns.length)
  return fromBytes32(keccak_256(input)) >> 8n
}

/** The proof's scope: what makes a proof count for one market and no other. */
export function scopeOf(market: string): bigint {
  return fieldHash(SCOPE_NS, market)
}

/** The proof's message: what binds a proof to one profile, so it cannot be replayed for another. */
export function messageOf(did: string): bigint {
  return fieldHash(MESSAGE_NS, did)
}

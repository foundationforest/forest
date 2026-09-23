// Field elements, and the one hash the registry derives everything public from.

import { keccak_256 } from '@noble/hashes/sha3.js'
import type { PublicKey } from '@solana/web3.js'

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
 * `keccak256(namespace || parts...) >> 8`, the same bytes the program hashes.
 *
 * Semaphore's own proof package hashes a 32-byte big-endian number this way, which caps a scope
 * at 32 bytes. Hashing a namespaced string instead lets a market name or a DID be any length,
 * and keeps one namespace's values from ever colliding with another's. The shift by one byte is
 * what keeps the result below `BN254_R`.
 */
export function fieldHash(namespace: string, ...parts: (string | Uint8Array)[]): bigint {
  const bytes = [namespace, ...parts].map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p))
  const input = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of bytes) {
    input.set(b, at)
    at += b.length
  }
  return fromBytes32(keccak_256(input)) >> 8n
}

/** The proof's scope: what makes a proof count for one market and no other. */
export function scopeOf(market: string): bigint {
  return fieldHash(SCOPE_NS, market)
}

/**
 * The proof's message: what binds a proof to one profile, its wallet and its DID, so it cannot be
 * replayed for another profile or landed by any wallet but the one that must sign it. The wallet's
 * 32 bytes come first, then the DID.
 */
export function messageOf(wallet: PublicKey | Uint8Array, did: string): bigint {
  const w = wallet instanceof Uint8Array ? wallet : wallet.toBytes()
  if (w.length !== 32) throw new RangeError('a wallet is 32 bytes')
  return fieldHash(MESSAGE_NS, w, did)
}

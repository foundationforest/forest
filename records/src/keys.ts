// Keys from the seed, and the one way a profile key is written down.
//
// The recipe is SPEC.md §1's: a passkey's PRF output becomes the seed, and each numbered
// profile's key comes from the seed. keys/ followed it until 2 October 2026 and now mixes keys
// another way; test/keys.json pins what this one gives. One key is the profile's name, signs its
// entries, and holds its money. The box key (for sealed entries) is one more label; it is made
// in sealed.ts, so code that never opens a sealed entry carries no encryption library.

import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58, concat, equalBytes, utf8 } from './bytes.ts'

export const LABELS = {
  seed: 'forest.foundation/seed/v1',
  profile: (n: number) => `forest.foundation/profile/${n}/wallet/v1`,
  box: (n: number) => `forest.foundation/profile/${n}/box/v1`,
} as const

/** HKDF-SHA256 with an empty salt (RFC 5869: 32 zero bytes), all separation in `info`. */
export function derive(ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha256, ikm, undefined, utf8(info), length)
}

/** SPEC.md §1: the passkey's PRF output becomes the 32-byte seed. */
export function seedFromPrf(prf: Uint8Array): Uint8Array {
  if (prf.length !== 32) throw new Error('a PRF output is 32 bytes')
  return derive(prf, LABELS.seed)
}

export type ProfileKey = {
  index: number
  secretKey: Uint8Array
  publicKey: Uint8Array
  /** The profile's name: did:key of its ed25519 key. */
  did: string
  /** The same 32 bytes as a Solana address. */
  address: string
}

export function profileKey(seed: Uint8Array, n: number): ProfileKey {
  if (seed.length !== 32) throw new Error('the seed is 32 bytes')
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('a profile index is a whole number, 0 or more')
  return keyFromSecret(derive(seed, LABELS.profile(n)), n)
}

/** Any ed25519 secret (a delegate's own key, a door's agent key) in the same shape. */
export function keyFromSecret(secretKey: Uint8Array, index = -1): ProfileKey {
  const publicKey = ed25519.getPublicKey(secretKey)
  return { index, secretKey, publicKey, did: didFromPublicKey(publicKey), address: base58.encode(publicKey) }
}

// did:key for ed25519 (W3C CCG): "did:key:z" + base58btc(0xed 0x01 || key).
const DID_PREFIX = 'did:key:z'
const ED25519_PUB = Uint8Array.of(0xed, 0x01)

export function didFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('an ed25519 public key is 32 bytes')
  return DID_PREFIX + base58.encode(concat(ED25519_PUB, publicKey))
}

/**
 * The key a did:key names, or null. Strict: one spelling per key (the decoded bytes must
 * re-encode to the same text), the ed25519 prefix, 32 bytes, a canonical point in the
 * prime-order group and not of small order.
 */
export function publicKeyFromDid(did: unknown): Uint8Array | null {
  if (typeof did !== 'string' || !did.startsWith(DID_PREFIX) || did.length > 64) return null
  let bytes: Uint8Array
  try {
    bytes = base58.decode(did.slice(DID_PREFIX.length))
  } catch {
    return null
  }
  if (bytes.length !== 34 || !equalBytes(bytes.subarray(0, 2), ED25519_PUB)) return null
  const key = bytes.slice(2)
  if (didFromPublicKey(key) !== did) return null
  return isUsableKey(key) ? key : null
}

/** A key Forest accepts: canonical encoding, prime-order subgroup, not of small order. */
export function isUsableKey(publicKey: Uint8Array): boolean {
  try {
    const point = ed25519.Point.fromBytes(publicKey, false)
    return point.isTorsionFree() && !point.isSmallOrder()
  } catch {
    return false
  }
}

export function addressFromDid(did: string): string {
  const key = publicKeyFromDid(did)
  if (!key) throw new Error('not a Forest profile name')
  return base58.encode(key)
}

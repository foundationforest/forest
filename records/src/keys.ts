// Keys, and the one way a key is written down.
//
// A person's seed is 32 bytes: the entropy its 24 words encode. Every key comes from it by one
// mixer, HKDF-SHA256 with an empty salt:
//   seed + "forest/v1/profile/<label>"   -> that profile's ed25519 key
//   profile private key + "forest/v1/read" -> its X25519 reading key (made in private.ts, so code
//                                             that never opens a private record carries no
//                                             encryption library)
// A profile's base58 address is its name, the key that signs its records, and its wallet.

import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58, utf8 } from './bytes.ts'

export const INFO = {
  profile: (label: string) => `forest/v1/profile/${label}`,
  read: 'forest/v1/read',
} as const

/** HKDF-SHA256 with an empty salt (RFC 5869: 32 zero bytes), all separation in `info`. */
export function derive(ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha256, ikm, undefined, utf8(info), length)
}

export type Key = {
  secretKey: Uint8Array
  publicKey: Uint8Array
  /** The public key in base58: a profile's name and wallet, or a writer key as permissions lists it. */
  address: string
}

/**
 * The profile key for one label, such as "tutoring/seller". The label's UTF-8 bytes go into HKDF
 * as given, so an app spells it the way the markets directory does: another spelling is another
 * profile.
 */
export function profileKey(seed: Uint8Array, label: string): Key & { label: string } {
  if (seed.length !== 32) throw new Error('the seed is 32 bytes')
  if (typeof label !== 'string' || !label || !label.isWellFormed()) throw new Error('a label is text')
  return { ...keyFromSecret(derive(seed, INFO.profile(label))), label }
}

/** Any ed25519 secret, such as a writer key an app makes at random, in the same shape. */
export function keyFromSecret(secretKey: Uint8Array): Key {
  const publicKey = ed25519.getPublicKey(secretKey)
  return { secretKey, publicKey, address: base58.encode(publicKey) }
}

/**
 * The key an address names, or null. Strict: one spelling per key (the decoded bytes must
 * re-encode to the same text), 32 bytes, a canonical point in the prime-order group and not of
 * small order.
 */
export function publicKeyFromAddress(address: unknown): Uint8Array | null {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null
  let key: Uint8Array
  try {
    key = base58.decode(address)
  } catch {
    return null
  }
  if (key.length !== 32 || base58.encode(key) !== address) return null
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

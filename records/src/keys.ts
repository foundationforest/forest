// Keys, and the one way a key is written down.
//
// Records mixes no key. A profile's key and its reading key come from the person's seed by keys/
// (keys/README.md): the profile key signs the profile's records, and its base58 address is the
// profile's name and wallet. A writer key is any other ed25519 key, made by an app. Both go in as
// their 32 private bytes.

import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from './bytes.ts'

export type Key = {
  /** The 32-byte ed25519 private key: keys/'s `profileKey(...).privateKey`, or a writer key's. */
  privateKey: Uint8Array
  publicKey: Uint8Array
  /** The public key in base58: a profile's name and wallet, or a writer key as permissions lists it. */
  address: string
}

/** Any ed25519 private key, such as a writer key an app makes at random, as a Key. */
export function keyFromPrivate(privateKey: Uint8Array): Key {
  if (privateKey.length !== 32) throw new Error('a private key is 32 bytes')
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey, address: base58.encode(publicKey) }
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

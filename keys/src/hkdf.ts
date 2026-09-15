// HKDF-SHA256 over Web Crypto, and the fixed strings the recipe hangs on.
// None of these strings is secret. They separate one derivation from another,
// so no key can be turned into any other key. Changing any of them is a new
// recipe version, never an edit to this one.

/** Version tag inside every fixed string. */
export const VERSION = 'v1'

/** The WebAuthn PRF input (the extension calls it a salt), as text. */
export const PRF_INPUT_TEXT = `forest.foundation/prf/${VERSION}`

/** The same input as the bytes handed to `navigator.credentials` in `extensions.prf.eval.first`. */
export const PRF_INPUT: Uint8Array = utf8(PRF_INPUT_TEXT)

/** HKDF info strings. `n` is the profile index, written in decimal. */
export const INFO = {
  seed: `forest.foundation/seed/${VERSION}`,
  control: (n: number) => `forest.foundation/profile/${n}/control/${VERSION}`,
  signing: (n: number) => `forest.foundation/profile/${n}/signing/${VERSION}`,
  wallet: (n: number) => `forest.foundation/profile/${n}/wallet/${VERSION}`,
  seedFileKey: `forest.foundation/seed-file/key/${VERSION}`,
  seedFileLabel: `forest.foundation/seed-file/label/${VERSION}`,
  // No profile index: the registry's identity is per human, not per profile.
  identity: `forest.foundation/identity/${VERSION}`,
} as const

/** A passkey's PRF output is 32 bytes. */
export const PRF_LENGTH = 32

/** The seed is 32 bytes. */
export const SEED_LENGTH = 32

/**
 * HKDF-SHA256 (RFC 5869) with an empty salt: extract from `ikm`, then expand
 * with `info` to `length` bytes. Web Crypto, unchanged.
 */
export async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', copy(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copy(bytes)))
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** A copy in its own plain ArrayBuffer, the shape Web Crypto's types accept. */
export function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view)
}

export function assertBytes(name: string, value: unknown, length: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`${name} must be ${length} bytes`)
  }
}

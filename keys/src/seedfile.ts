// The seed file: the seed encrypted under another passkey's PRF output, so a
// second passkey opens the same seed. Stored anywhere, under a label derived
// from that PRF output. Whoever stores it learns a random-looking label and
// random-looking bytes, nothing else.

import { base64urlnopad } from '@scure/base'
import { INFO, PRF_LENGTH, SEED_LENGTH, assertBytes, copy, hkdf, utf8 } from './hkdf.ts'

export type SeedFile = {
  /** base64url, no padding, of 32 bytes derived from the passkey's PRF output. Carries no identity. */
  label: string
  /** base64url, no padding, of nonce (12 bytes) then AES-256-GCM output (seed 32 bytes, tag 16 bytes). */
  ciphertext: string
}

const NONCE_LENGTH = 12
const TAG_LENGTH = 16

/** The label a passkey's seed file is stored under. A new device computes it from the passkey alone. */
export async function seedFileLabel(prf: Uint8Array): Promise<string> {
  assertBytes('prf', prf, PRF_LENGTH)
  return base64urlnopad.encode(await hkdf(prf, INFO.seedFileLabel, 32))
}

/** Encrypts the seed under the key derived from `prf`. A fresh random nonce each time. */
export async function wrapSeed(seed: Uint8Array, prf: Uint8Array): Promise<SeedFile> {
  assertBytes('seed', seed, SEED_LENGTH)
  const label = await seedFileLabel(prf)
  const key = await fileKey(prf)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(label) }, key, copy(seed)),
  )
  const bytes = new Uint8Array(NONCE_LENGTH + sealed.length)
  bytes.set(nonce)
  bytes.set(sealed, NONCE_LENGTH)
  return { label, ciphertext: base64urlnopad.encode(bytes) }
}

/** Decrypts a seed file with the passkey that made it. Fails on any other passkey or any damage. */
export async function unwrapSeed(file: SeedFile, prf: Uint8Array): Promise<Uint8Array> {
  const label = await seedFileLabel(prf)
  if (file.label !== label) throw new Error('this seed file was not made by this passkey')
  const bytes = base64urlnopad.decode(file.ciphertext)
  if (bytes.length !== NONCE_LENGTH + SEED_LENGTH + TAG_LENGTH) throw new Error('seed file has the wrong length')
  const key = await fileKey(prf)
  try {
    const seed = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: copy(bytes.subarray(0, NONCE_LENGTH)), additionalData: utf8(label) },
      key,
      copy(bytes.subarray(NONCE_LENGTH)),
    )
    return new Uint8Array(seed)
  } catch {
    throw new Error('seed file does not open: wrong passkey or damaged file')
  }
}

async function fileKey(prf: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdf(prf, INFO.seedFileKey, 32)
  return crypto.subtle.importKey('raw', copy(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

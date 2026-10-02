// A profile's two keys: the profile key, one per label, mixed from the seed; and its reading
// key, mixed from the profile key. See README.md, "The mixing table".

import { ed25519 } from '@noble/curves/ed25519.js'
import { base58, bech32 } from '@scure/base'
import { identityToRecipient } from 'age-encryption'
import { INFO, SEED_LENGTH, assertBytes, assertText, hkdf } from './hkdf.ts'

/**
 * A profile's one key. Its address is the profile's name and its Solana wallet: the same 32
 * bytes. It signs the profile's records and its transactions. Held in memory only.
 */
export type ProfileKey = {
  label: string
  /** The 32-byte ed25519 private seed, the form Solana tooling accepts as a keypair seed. */
  privateKey: Uint8Array
  publicKey: Uint8Array
  /** The public key in base58: the profile's name and its wallet address. */
  address: string
}

/**
 * The key that opens private records sealed to a profile: age's post-quantum hybrid identity,
 * ML-KEM-768 with X25519 (mlkem768x25519).
 */
export type ReadingKey = {
  /** age's hybrid identity, `AGE-SECRET-KEY-PQ-1…`: it opens what is sealed to this profile. */
  identity: string
  /** What others seal to, `age1pq1…`. The profile's address does not give it. */
  recipient: string
}

/**
 * The profile key for `label`, from the seed. One HKDF output per label, so two labels give
 * unrelated keys, and the same seed and label always give the same key.
 */
export async function profileKey(seed: Uint8Array, label: string): Promise<ProfileKey> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertText('label', label)
  const privateKey = await hkdf(seed, INFO.profile(label))
  const publicKey = ed25519.getPublicKey(privateKey)
  return { label, privateKey, publicKey, address: base58.encode(publicKey) }
}

/**
 * The profile's reading key, from its profile key's 32 private bytes. The 32 mixed bytes are used
 * unchanged as age's hybrid identity (its seed, which age expands into the ML-KEM-768 and X25519
 * keys); age's own library computes the recipient.
 */
export async function readingKey(profilePrivateKey: Uint8Array): Promise<ReadingKey> {
  assertBytes('profile private key', profilePrivateKey, 32)
  const bytes = await hkdf(profilePrivateKey, INFO.read)
  const identity = bech32.encodeFromBytes('AGE-SECRET-KEY-PQ-', bytes).toUpperCase()
  return { identity, recipient: await identityToRecipient(identity) }
}

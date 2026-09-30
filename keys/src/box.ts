// The box key: one per profile, for sealed entries (records/SPEC.md, "Sealed entries").
//
// 32 bytes from the seed under the profile's own box label, used unchanged as age's
// post-quantum hybrid identity (ML-KEM-768 + X25519): the bytes in bech32 with the prefix
// AGE-SECRET-KEY-PQ-, in upper case. age computes from it the recipient others seal to, which
// the profile publishes in its folder. The library is age's own (age-encryption), unchanged.

import { bech32 } from '@scure/base'
import { identityToRecipient } from 'age-encryption'
import { INFO, SEED_LENGTH, assertBytes, assertProfileIndex, hkdf } from './hkdf.ts'

export type BoxKey = {
  /** age's hybrid identity: it opens what is sealed to this profile. */
  identity: string
  /** What goes in the profile's folder, for others to seal to: `age1pq1…`. */
  recipient: string
}

export async function boxKey(seed: Uint8Array, n: number): Promise<BoxKey> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertProfileIndex(n)
  const identity = bech32.encodeFromBytes('AGE-SECRET-KEY-PQ-', await hkdf(seed, INFO.box(n))).toUpperCase()
  return { identity, recipient: await identityToRecipient(identity) }
}

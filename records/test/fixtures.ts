// Shared test fixtures: a fixed test seed, a few keys, and ready-made bodies.

import { ed25519 } from '@noble/curves/ed25519.js'
import { b64u } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { keyFromSecret, profileKey, type Key } from '../src/keys.ts'
import { type Body, type SignedRecord, type UnsignedRecord, signingInput } from '../src/record.ts'

/** The test seed: bytes 00 01 … 1f, as the vectors use. */
export const SEED = Uint8Array.from({ length: 32 }, (_, i) => i)
/** A second person. */
export const OTHER_SEED = new Uint8Array(32).fill(7)

export const alice = profileKey(SEED, 'tutoring/seller')
export const aliceBuyer = profileKey(SEED, 'tutoring/buyer') // the same person, another label
export const bob = profileKey(OTHER_SEED, 'tutoring/buyer') // someone else
/** A writer key an app made: never the profile key. */
export const writer = keyFromSecret(new Uint8Array(32).fill(42))
export const stranger = keyFromSecret(new Uint8Array(32).fill(99))

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0)
export const MINUTE = 60_000
export const DAY = 86_400_000

export const profileBody = (name: string): Body => ({
  market: 'tutoring',
  role: 'seller',
  name,
  about: 'Maths and physics, secondary level.',
  createdAt: '2026-10-02T12:00:00Z',
})

export const offerBody = (price: string): Body => ({
  direction: 'offer',
  description: 'One hour of maths tutoring, online.',
  price: { amount: price, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' },
  remote: true,
  createdAt: '2026-10-02T12:00:00Z',
})

export const reviewBody = (subject: string): Body => ({
  subject,
  ratings: { overall: '9' },
  text: 'Clear and patient.',
  dealId: 'a'.repeat(64),
  createdAt: '2026-10-02T12:00:00Z',
})

/** One writer in a permissions record: this key, these paths, until then. */
export const allow = (key: Key, paths: string[], until: number) => ({ key: key.address, paths, until })

/**
 * A signed owner record whose canonical text is exactly `bytes` long, `wide` of its characters
 * two-byte (é). Signed directly, since signRecord refuses anything over the cap.
 */
export function sizedRecord(key: Key, path: string, bytes: number, wide = 0): SignedRecord {
  const unsigned = (about: string): UnsignedRecord => ({ v: 1, profile: key.address, path, time: T0, body: { about } })
  const rest = bytes - canonical({ ...unsigned(''), sig: 'x'.repeat(86) }).length - 2 * wide
  const u = unsigned('é'.repeat(wide) + 'x'.repeat(rest))
  return { ...u, sig: b64u.encode(ed25519.sign(signingInput(u), key.secretKey)) }
}

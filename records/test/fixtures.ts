// Shared test fixtures: the keys/ recipe's pinned test seed, and a few ready-made records.

import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64u, hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type Body, type Entry, type Unsigned, signingInput } from '../src/entry.ts'
import { type ProfileKey, keyFromSecret, profileKey, seedFromPrf } from '../src/keys.ts'

export const VECTORS = JSON.parse(readFileSync(new URL('../../keys/test/vectors.json', import.meta.url), 'utf8')) as {
  prf: string
  seed: string
  profiles: Array<{ index: number; did: string; wallet: string; box: { identity: string; recipient: string } }>
}

/** The keys recipe's fixed test seed: a stand-in for a passkey, in Node. */
export const SEED = seedFromPrf(hex.decode(VECTORS.prf))
/** A second person, from a different PRF output. */
export const OTHER_SEED = seedFromPrf(new Uint8Array(32).fill(7))

export const alice = profileKey(SEED, 0) // a seller profile
export const aliceBuyer = profileKey(SEED, 1) // the same person's buyer profile
export const bob = profileKey(OTHER_SEED, 0) // someone else
/** A delegate's own key, e.g. an always-on signer the person runs: never the profile's key. */
export const signer = keyFromSecret(new Uint8Array(32).fill(42))
export const stranger = keyFromSecret(new Uint8Array(32).fill(99))

export const T0 = Date.UTC(2026, 8, 29, 12, 0, 0)
export const MINUTE = 60_000
export const DAY = 86_400_000

export const profileBody = (name: string): Body => ({
  market: 'tutoring',
  role: 'seller',
  name,
  about: 'Maths and physics, secondary level.',
  createdAt: '2026-09-29T12:00:00Z',
})

export const offerBody = (price: string): Body => ({
  direction: 'offer',
  description: 'One hour of maths tutoring, online.',
  price: { amount: price, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' },
  remote: true,
  createdAt: '2026-09-29T12:00:00Z',
})

export const reviewBody = (subject: string): Body => ({
  subject,
  ratings: { overall: '9' },
  text: 'Clear and patient.',
  dealId: 'a'.repeat(64),
  createdAt: '2026-09-29T12:00:00Z',
})

/**
 * A signed owner entry whose canonical text is exactly `bytes` long, `wide` of its characters
 * two-byte (é). Signed directly, since signEntry refuses anything over the cap.
 */
export function sizedEntry(key: ProfileKey, path: string, bytes: number, wide = 0): Entry {
  const unsigned = (about: string): Unsigned => ({ v: 1, profile: key.did, path, time: T0, body: { about } })
  const rest = bytes - canonical({ ...unsigned(''), sig: 'x'.repeat(86) }).length - 2 * wide
  const u = unsigned('é'.repeat(wide) + 'x'.repeat(rest))
  return { ...u, sig: b64u.encode(ed25519.sign(signingInput(u), key.secretKey)) }
}

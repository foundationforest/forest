// The code: what makes one badge per market per human true.
//
// A code is the proof's nullifier, `Poseidon(scope, secret)`. The same person in the same market
// always produces the same one; nobody else can produce it; and it says nothing about who they
// are. The registry writes one account whose address is a hash of it, and that account existing
// is the whole rule.
//
// Deriving the code needs only the identity secret and the market name, so an app can check
// whether a badge is already taken before anyone pays for anything.

import { Identity } from '@semaphore-protocol/identity'
import { poseidon2 } from 'poseidon-lite/poseidon2'

import { scopeOf, toBytes32 } from './field.ts'

/** The Semaphore identity for a human, from the 32 bytes `keys/` derives as the identity secret. */
export function identityFrom(secret: Uint8Array | Identity): Identity {
  return secret instanceof Identity ? secret : new Identity(secret)
}

/** The identity commitment an issuer inserts into a list. */
export function commitmentOf(secret: Uint8Array | Identity): bigint {
  return identityFrom(secret).commitment
}

export function codeFor(secret: Uint8Array | Identity, market: string): bigint {
  return poseidon2([scopeOf(market), identityFrom(secret).secretScalar])
}

export function codeBytesFor(secret: Uint8Array | Identity, market: string): Uint8Array {
  return toBytes32(codeFor(secret, market))
}

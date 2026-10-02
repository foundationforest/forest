// The code: what makes one line per human per label true.
//
// A code is the proof's nullifier, `Poseidon(scope, secret)`. The same person under the same label
// always produces the same one; nobody else can produce it; and it says nothing about who they
// are. A line sits at an address derived from it, so a second line for it cannot exist.
//
// Deriving the code needs only the identity secret and the label, so an app can check whether a
// line already exists before making a proof.

import { Identity } from '@semaphore-protocol/identity'
import { poseidon2 } from 'poseidon-lite/poseidon2'

import { scopeOf, toBytes32 } from './field.ts'

/** The Semaphore identity for a human, from its 32-byte identity secret. */
export function identityFrom(secret: Uint8Array | Identity): Identity {
  return secret instanceof Identity ? secret : new Identity(secret)
}

/** The identity commitment an issuer puts in its list. */
export function commitmentOf(secret: Uint8Array | Identity): bigint {
  return identityFrom(secret).commitment
}

export function codeFor(secret: Uint8Array | Identity, label: string): bigint {
  return poseidon2([scopeOf(label), identityFrom(secret).secretScalar])
}

export function codeBytesFor(secret: Uint8Array | Identity, label: string): Uint8Array {
  return toBytes32(codeFor(secret, label))
}

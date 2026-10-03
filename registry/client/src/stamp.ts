// Stamps and market stamps: what makes one row per person per issuer per label true.
//
// A person's identity for one issuer's list comes from their seed and the issuer's address
// (`keys/`'s `listSecret`). Its commitment is their stamp on that list. Their market stamp is the
// proof's nullifier with the label as scope, `Poseidon(scope, secret)`: the same for one person on
// one list under one label, unguessable for anyone else, and saying nothing about who they are. A
// row sits at an address derived from it, so a second row for it cannot exist.
//
// Deriving a market stamp needs only the list secret and the label, so an app can check whether a
// row already exists before making a proof.

import { Identity } from '@semaphore-protocol/identity'
import { poseidon2 } from 'poseidon-lite/poseidon2'

import { scopeOf, toBytes32 } from './field.ts'

/** The Semaphore identity for one list, from the 32 bytes `keys/`'s `listSecret` returns. */
export function identityFrom(secret: Uint8Array | Identity): Identity {
  return secret instanceof Identity ? secret : new Identity(secret)
}

/** The person's stamp on the list: what the issuer puts in it. */
export function stampOf(secret: Uint8Array | Identity): bigint {
  return identityFrom(secret).commitment
}

/** The person's market stamp on this list, under this label. */
export function marketStampOf(secret: Uint8Array | Identity, label: string): bigint {
  return poseidon2([scopeOf(label), identityFrom(secret).secretScalar])
}

export function marketStampBytesOf(secret: Uint8Array | Identity, label: string): Uint8Array {
  return toBytes32(marketStampOf(secret, label))
}

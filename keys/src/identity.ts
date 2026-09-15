// The identity secret: one more output from the seed, for the registry.
//
// Per human, not per profile. The registry's list holds one commitment per
// verified human; a proof against that list shows "a verified human" without
// showing which one. A per-profile secret would put a different human on the
// list for every folder, so the info string carries no profile index.
//
// The identity itself is Semaphore's, built by Semaphore's own library from
// these 32 bytes and never changed here: what a commitment is a hash of is
// part of the sealed circuit's definition, not ours to restate.

import { Identity } from '@semaphore-protocol/identity'
import { INFO, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'

/** The identity secret is 32 bytes, like every other output of the recipe. */
export const IDENTITY_SECRET_LENGTH = 32

/** A person's Semaphore identity and the commitment that goes on the registry's list. */
export type HumanIdentity = {
  /** Semaphore's identity object. It signs nothing here; a proof is built from it on the device. */
  identity: Identity
  /** `Poseidon(2)` of the two coordinates of the identity's Baby Jubjub public key. */
  commitment: bigint
}

/**
 * The 32 bytes a person's Semaphore identity is built from. One per seed: the
 * same on every device, the same for every profile, unrelated to any profile
 * key because it is its own HKDF output with its own info string.
 */
export async function identitySecret(seed: Uint8Array): Promise<Uint8Array> {
  assertBytes('seed', seed, SEED_LENGTH)
  return hkdf(seed, INFO.identity, IDENTITY_SECRET_LENGTH)
}

/**
 * A person's identity and its commitment, from the seed. Nothing is stored and
 * nothing is sent: the commitment goes to the issuer once, after a face check,
 * and the identity is rebuilt from the seed whenever a proof is needed.
 */
export async function humanIdentity(seed: Uint8Array): Promise<HumanIdentity> {
  const identity = new Identity(await identitySecret(seed))
  return { identity, commitment: identity.commitment }
}

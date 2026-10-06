// The person's secret for one issuer: one more mix from the seed, under the issuer's name. An
// issuer is anyone who signs notes for people, such as one that checks faces.
//
// The name, not the issuer's key: an issuer that changes its key changes no one's note number or
// stamps. One secret per issuer, not per person: two issuers comparing what they hold find
// nothing in common, because the same person's note numbers for them are unrelated.
//
// The 32 bytes become the number the circuits take the way Semaphore v4 made its secret scalar,
// with zk-kit's own `deriveSecretScalar`, unchanged. So a stamp keeps the derivation it had,
// Poseidon(scope, scalar), and the reputation circuit, fixed by its setup, takes the same number.

import { deriveSecretScalar } from '@zk-kit/eddsa-poseidon'
import { poseidon1 } from 'poseidon-lite/poseidon1'
import { INFO, SEED_LENGTH, assertBytes, assertText, hkdf } from './hkdf.ts'

export type IssuerSecret = {
  /** The 32 bytes mixed from the seed. */
  secret: Uint8Array
  /** The secret as the circuits take it: a number below Baby Jubjub's subgroup order. */
  scalar: bigint
  /** The note number, `Poseidon(1)` of the scalar. The issuer signs it in the person's note. */
  noteNumber: bigint
}

/**
 * The person's secret for the issuer named `name`, and their note number for it. The name is the
 * text the issuer publishes as its own, used exactly as given.
 */
export async function issuerSecret(seed: Uint8Array, name: string): Promise<IssuerSecret> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertText('issuer name', name)
  const secret = await hkdf(seed, INFO.issuer(name))
  const scalar = deriveSecretScalar(secret)
  return { secret, scalar, noteNumber: poseidon1([scalar]) }
}

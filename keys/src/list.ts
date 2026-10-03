// The person's secret for one issuer's list: one more mix from the seed, under the issuer's
// address. An issuer is anyone who keeps a list of stamps, such as the human list.
//
// One secret per list, not per person: two issuers comparing their lists find nothing in
// common, because the same person's stamps on them are unrelated.
//
// The identity is Semaphore's, built by Semaphore's own library from these 32 bytes and
// never changed here: what a commitment is a hash of is part of the sealed circuit.

import { Identity } from '@semaphore-protocol/identity'
import { base58 } from '@scure/base'
import { INFO, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'

export type ListSecret = {
  /** The 32 bytes the identity is built from. */
  secret: Uint8Array
  /** Semaphore's identity. Proofs are made from it on the device. */
  identity: Identity
  /** The stamp: the identity's commitment, `Poseidon(2)` of its Baby Jubjub public key. */
  stamp: bigint
}

/**
 * The person's secret for the list `issuer` keeps, and the stamp it puts on that list. `issuer`
 * is the issuer's address: its 32-byte ed25519 public key in base58, in its one spelling.
 */
export async function listSecret(seed: Uint8Array, issuer: string): Promise<ListSecret> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertIssuer(issuer)
  const secret = await hkdf(seed, INFO.list(issuer))
  const identity = new Identity(secret)
  return { secret, identity, stamp: identity.commitment }
}

// Another spelling of the same key would give another secret, and the person a stamp the
// issuer never took, with nothing to say why.
function assertIssuer(issuer: unknown): asserts issuer is string {
  let bytes: Uint8Array | undefined
  try {
    if (typeof issuer === 'string') bytes = base58.decode(issuer)
  } catch {}
  if (!bytes || bytes.length !== 32 || base58.encode(bytes) !== issuer) {
    throw new Error("issuer must be an address: a 32-byte key in base58")
  }
}

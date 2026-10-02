// The person's secret for one keeper's list: one more mix from the seed, under the keeper's
// address. A keeper is anyone who keeps a list of stamps; the issuer keeps the human list.
//
// One secret per list, not per person: two keepers comparing their lists find nothing in
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
 * The person's secret for the list `keeper` keeps, and the stamp it puts on that list. `keeper`
 * is the keeper's address: its 32-byte ed25519 public key in base58, in its one spelling.
 */
export async function listSecret(seed: Uint8Array, keeper: string): Promise<ListSecret> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertKeeper(keeper)
  const secret = await hkdf(seed, INFO.list(keeper))
  const identity = new Identity(secret)
  return { secret, identity, stamp: identity.commitment }
}

// Another spelling of the same key would give another secret, and the person a stamp the
// keeper never took, with nothing to say why.
function assertKeeper(keeper: unknown): asserts keeper is string {
  let bytes: Uint8Array | undefined
  try {
    if (typeof keeper === 'string') bytes = base58.decode(keeper)
  } catch {}
  if (!bytes || bytes.length !== 32 || base58.encode(bytes) !== keeper) {
    throw new Error("keeper must be an address: a 32-byte key in base58")
  }
}

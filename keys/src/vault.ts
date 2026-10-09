// The vault key: the main key of the person's vault, a folder of its own on a host that holds what
// a new device needs and the seed alone cannot give back (records/README.md, The vault). It is
// mixed from the seed, so a new device finds the vault with nothing but the seed: its address is
// the folder's name. Its inbox key, mixed from it as any main key's is (inboxKey), opens what the
// vault holds. It belongs to no label, so no profile's key is ever the vault's.

import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { INFO, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'
import type { MainKey } from './profile.ts'

/** The vault's key: a main key with no label. Held in memory only. */
export type VaultKey = Omit<MainKey, 'label'>

/** The vault key, from the seed: the same every time, and unrelated to every profile's main key. */
export async function vaultKey(seed: Uint8Array): Promise<VaultKey> {
  assertBytes('seed', seed, SEED_LENGTH)
  const privateKey = await hkdf(seed, INFO.vault)
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey, address: base58.encode(publicKey) }
}

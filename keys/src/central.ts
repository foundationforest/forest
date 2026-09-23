import { INFO, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'
import { ed25519Wallet, type Wallet } from './profile.ts'

/**
 * The person's central wallet from the seed: where money enters from a ramp and leaves to one.
 * One per seed, with no profile index, derived like a profile wallet but under its own info
 * string, so it cannot be computed from any profile's keys, nor any profile's keys from it.
 */
export async function centralWallet(seed: Uint8Array): Promise<Wallet> {
  assertBytes('seed', seed, SEED_LENGTH)
  return ed25519Wallet(await hkdf(seed, INFO.central))
}

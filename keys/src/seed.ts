import { INFO, PRF_LENGTH, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'

/**
 * The 32-byte seed from a passkey's 32-byte PRF output. Deterministic: the
 * same passkey, evaluated with the fixed PRF input, gives the same seed on
 * every device, forever.
 */
export async function seedFromPrf(prf: Uint8Array): Promise<Uint8Array> {
  assertBytes('prf', prf, PRF_LENGTH)
  return hkdf(prf, INFO.seed, SEED_LENGTH)
}

// The second fixed test seed (keys/test/second-seed.json): the person deploy/e2e.ts runs as. Its
// profile 0's keys, and its identity for the registry, all derived by keys/.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PublicKey } from '@solana/web3.js'

import { humanIdentity, identitySecret, profileKeys } from '../../keys/src/index.ts'

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../keys/test/second-seed.json'), 'utf8'))
export const seed = new Uint8Array(Buffer.from(fixture.seed, 'hex'))
export const PROFILE = 0

export async function person() {
  const keys = await profileKeys(seed, PROFILE)
  const human = await humanIdentity(seed)
  return {
    keys,
    wallet: new PublicKey(keys.wallet.publicKey),
    secret: await identitySecret(seed),
    commitment: human.commitment,
  }
}

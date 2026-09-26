// The fixed test seeds (keys/test/second-seed.json, third-seed.json): the people deploy/e2e.ts runs
// as. A profile's keys, and the person's identity for the registry, all derived by keys/.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PublicKey } from '@solana/web3.js'

import { humanIdentity, identitySecret, profileKeys } from '../../keys/src/index.ts'

export type Seed = { name: 'seed2' | 'seed3'; file: string; bytes: Uint8Array }

function load(name: Seed['name'], file: string): Seed {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../keys/test', file), 'utf8'))
  return { name, file: `keys/test/${file}`, bytes: new Uint8Array(Buffer.from(fixture.seed, 'hex')) }
}

export const SEED2 = load('seed2', 'second-seed.json')
export const SEED3 = load('seed3', 'third-seed.json')

/** Seed 2's profile 0 is the 2026-09-25 proof's person, and the one fund.ts funds. */
export const PROFILE = 0

export async function person(seed: Seed = SEED2, profile = PROFILE) {
  const keys = await profileKeys(seed.bytes, profile)
  const human = await humanIdentity(seed.bytes)
  return {
    seed,
    profile,
    keys,
    wallet: new PublicKey(keys.wallet.publicKey),
    secret: await identitySecret(seed.bytes),
    commitment: human.commitment,
    /** The handle its DID names, under the host's name: `forest-seed2-p0.<host>`. */
    handle: (hostname: string) => `forest-${seed.name}-p${profile}.${hostname}`,
  }
}

export type Person = Awaited<ReturnType<typeof person>>

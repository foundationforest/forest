import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { INFO, SEED_LENGTH, assertBytes, assertProfileIndex, hkdf } from './hkdf.ts'

/** A Solana wallet: an ed25519 key. `privateKey` is the 32-byte seed Solana tooling accepts. */
export type Wallet = {
  privateKey: Uint8Array
  publicKey: Uint8Array
  /** The public key in base58: the wallet's address. */
  address: string
}

/**
 * A profile's one key. It is the profile's name (`did`), it signs the profile's entries
 * (records/SPEC.md), and it is the profile's Solana wallet (`address`): the same 32 bytes.
 * Held in memory only.
 */
export type ProfileKey = Wallet & {
  index: number
  /** The profile's name: the did:key of its public key. */
  did: string
}

/**
 * Profile `n`'s key from the seed: one HKDF output with its own info string, so the keys of
 * different profiles are unrelated: none can be computed from another.
 */
export async function profileKey(seed: Uint8Array, n: number): Promise<ProfileKey> {
  assertBytes('seed', seed, SEED_LENGTH)
  assertProfileIndex(n)
  const wallet = ed25519Wallet(await hkdf(seed, INFO.profile(n)))
  return { index: n, ...wallet, did: didKey(wallet.publicKey) }
}

/** An ed25519 wallet from a 32-byte HKDF output: the profile keys and the central wallet alike. */
export function ed25519Wallet(privateKey: Uint8Array): Wallet {
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey, address: base58.encode(publicKey) }
}

/** The did:key of an ed25519 public key (W3C CCG did:key): `did:key:z` + base58btc(0xed 0x01 || key). */
export function didKey(publicKey: Uint8Array): string {
  assertBytes('an ed25519 public key', publicKey, 32)
  const bytes = new Uint8Array(34)
  bytes.set([0xed, 0x01])
  bytes.set(publicKey, 2)
  return `did:key:z${base58.encode(bytes)}`
}

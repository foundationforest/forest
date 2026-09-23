import { Secp256k1Keypair } from '@atproto/crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { INFO, SEED_LENGTH, assertBytes, hkdf } from './hkdf.ts'

/** A Solana wallet: an ed25519 key. `privateKey` is the 32-byte seed Solana tooling accepts. */
export type Wallet = {
  privateKey: Uint8Array
  publicKey: Uint8Array
  /** The public key in base58: the wallet's address. */
  address: string
}

/** Everything one profile signs with. Held in memory only; nothing here is exportable. */
export type ProfileKeys = {
  index: number
  /** did:plc rotation key. secp256k1. Changes the profile's record at the directory. */
  control: Secp256k1Keypair
  /** did:plc verification key. secp256k1. Signs the profile's folder. */
  signing: Secp256k1Keypair
  /** Solana wallet. ed25519. Pays, and pays into escrow. */
  wallet: Wallet
}

/**
 * Profile `n`'s keys from the seed. Each key is one HKDF output with its own
 * info string, so the three keys of one profile, and the keys of different
 * profiles, are unrelated: none can be computed from another.
 */
export async function profileKeys(seed: Uint8Array, n: number): Promise<ProfileKeys> {
  assertBytes('seed', seed, SEED_LENGTH)
  if (!Number.isInteger(n) || n < 0) throw new Error('profile index must be a whole number, 0 or more')
  const [control, signing, wallet] = await Promise.all([
    hkdf(seed, INFO.control(n)).then(secp256k1),
    hkdf(seed, INFO.signing(n)).then(secp256k1),
    hkdf(seed, INFO.wallet(n)).then(ed25519Wallet),
  ])
  return { index: n, control, signing, wallet }
}

// Throws when the 32 bytes are not a valid secp256k1 scalar. The chance is
// below 2^-127; the recipe has no retry rule.
function secp256k1(privateKey: Uint8Array): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.import(privateKey, { exportable: false })
}

/** An ed25519 wallet from a 32-byte HKDF output: the profile wallets and the central wallet alike. */
export function ed25519Wallet(privateKey: Uint8Array): Wallet {
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey, address: base58.encode(publicKey) }
}

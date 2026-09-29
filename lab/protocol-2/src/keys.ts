// Keys. The passkey-to-seed recipe is the one in `keys/SPEC.md`, unchanged (its HKDF is imported
// from there). What changes per profile: one ed25519 signing key (the DID), one X25519 reader key
// (private records), one ed25519 wallet (Solana, unchanged label). No control key: with did:key the
// identifier is the signing key and nothing rotates it; see SPEC.md, "Identity".
//
// A delegate (an AI agent, a laptop) has keys of its own, made at random, never from the seed.

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '../../../keys/src/hkdf.ts'
import { didFromKey } from './did.ts'
import { b58 } from './codec.ts'

export const VERSION = 'v2'

export const INFO = {
  signing: (n: number) => `forest.foundation/profile/${n}/signing/${VERSION}`,
  reader: (n: number) => `forest.foundation/profile/${n}/reader/${VERSION}`,
  // The wallet keeps the v1 label: a Solana key exactly as `keys/` derives it today.
  wallet: (n: number) => `forest.foundation/profile/${n}/wallet/v1`,
} as const

/** An ed25519 signer: what signs entries, pointers and permits. */
export type Signer = {
  did: string
  publicKey: Uint8Array
  sign: (message: Uint8Array) => Uint8Array
}

/** An X25519 reader: what opens private records addressed to it. */
export type Reader = {
  did: string
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export type ProfileKeys = {
  index: number
  did: string
  signer: Signer
  reader: Reader
  wallet: { address: string; publicKey: Uint8Array; privateKey: Uint8Array }
}

export function signerFromPrivateKey(privateKey: Uint8Array): Signer {
  if (privateKey.length !== 32) throw new Error('an ed25519 private key is 32 bytes')
  const publicKey = ed25519.getPublicKey(privateKey)
  return { did: didFromKey(publicKey, 'ed25519'), publicKey, sign: (m) => ed25519.sign(m, privateKey) }
}

export function readerFromPrivateKey(privateKey: Uint8Array): Reader {
  if (privateKey.length !== 32) throw new Error('an X25519 private key is 32 bytes')
  const publicKey = x25519.getPublicKey(privateKey)
  return { did: didFromKey(publicKey, 'x25519'), publicKey, privateKey }
}

/** Profile `n`'s keys from the 32-byte seed. Deterministic: the same seed gives the same keys anywhere. */
export async function profileKeys(seed: Uint8Array, n: number): Promise<ProfileKeys> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes')
  if (!Number.isInteger(n) || n < 0) throw new Error('profile index must be a whole number, 0 or more')
  const [signing, reading, walletSeed] = await Promise.all([
    hkdf(seed, INFO.signing(n)),
    hkdf(seed, INFO.reader(n)),
    hkdf(seed, INFO.wallet(n)),
  ])
  const signer = signerFromPrivateKey(signing)
  const walletPublic = ed25519.getPublicKey(walletSeed)
  return {
    index: n,
    did: signer.did,
    signer,
    reader: readerFromPrivateKey(reading),
    wallet: { address: b58.encode(walletPublic), publicKey: walletPublic, privateKey: walletSeed },
  }
}

/** Fresh keys for a delegate. Random, never derived from anyone's seed. */
export function delegateKeys(): { signer: Signer; reader: Reader } {
  return {
    signer: signerFromPrivateKey(ed25519.utils.randomSecretKey()),
    reader: readerFromPrivateKey(x25519.utils.randomSecretKey()),
  }
}

export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

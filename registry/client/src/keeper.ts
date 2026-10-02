// A keeper's signature on a snapshot of its list: ed25519 over the root's 32 big-endian bytes.
//
// The program stores the signature and never checks it. A reader checks it here, against the
// keeper it trusts. The device checks it too, before sending: a row never changes, so a row with a
// signature no reader accepts would hold that market stamp for good.

import { ed25519 } from '@noble/curves/ed25519.js'
import type { PublicKey } from '@solana/web3.js'

import { toBytes32 } from './field.ts'

/** What a keeper signs for one snapshot: the root, as 32 big-endian bytes. */
export function rootBytes(root: bigint | Uint8Array): Uint8Array {
  const bytes = typeof root === 'bigint' ? toBytes32(root) : root
  if (bytes.length !== 32) throw new RangeError('a root is 32 bytes')
  return bytes
}

/**
 * Did this keeper sign this root? Takes a row as it is read back, or the same three fields before
 * one exists. Strict ed25519 (RFC 8032, no ZIP-215 leniency), the same check `records/` makes on
 * every record, so two readers never disagree about one signature.
 */
export function keeperSigned(input: { keeper: PublicKey | Uint8Array; root: bigint | Uint8Array; keeperSignature: Uint8Array }): boolean {
  const keeper = input.keeper instanceof Uint8Array ? input.keeper : input.keeper.toBytes()
  if (keeper.length !== 32 || input.keeperSignature.length !== 64) return false
  try {
    return ed25519.verify(input.keeperSignature, rootBytes(input.root), keeper, { zip215: false })
  } catch {
    return false
  }
}

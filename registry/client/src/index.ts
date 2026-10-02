// The Forest registry client: everything a device needs to turn a stamp on a keeper's list into a
// row, and to read rows back. It talks to no network of its own. The caller passes in the keeper's
// published list and its signature on the list's root, and a recent blockhash; the profile and the
// payer sign, and anyone sends.
//
// One row, one proof, one transaction: `register`. A row never changes after it.
//
// Nothing here is in production.

import type { Identity } from '@semaphore-protocol/identity'
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'

import { toBytes32 } from './field.ts'
import { keeperSigned } from './keeper.ts'
import { listRoot, proveStamp, type Artifacts, type StampProof } from './proof.ts'
import { MAX_LABEL, PROGRAM_ID, registerIx, rowAddress } from './program.ts'

export * from './field.ts'
export * from './compress.ts'
export * from './stamp.ts'
export * from './keeper.ts'
export * from './program.ts'
export * from './proof.ts'
export * from './rows.ts'

export type Registration = StampProof & {
  marketStampBytes: Uint8Array
  /** The row's address. */
  row: PublicKey
  instruction: TransactionInstruction
  /** Unsigned: `register`, needing the profile's signature and the payer's. */
  transaction: VersionedTransaction
}

/**
 * A row for one profile under one label, proven against one keeper's list: the keeper's published
 * stamps, in its order, the person's own among them, and the keeper's signature on that list's
 * root. The signature is checked before anything is proven: a row never changes, so a row with a
 * signature no reader accepts would hold this market stamp for good.
 */
export async function buildRegistration(input: {
  /** The 32 bytes `keys/`'s `listSecret(seed, keeper)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  label: string
  /** The profile's key. It signs the transaction. */
  profile: PublicKey
  /** The keeper's key: its address, and what its signature on the root is checked against. */
  keeper: PublicKey
  /** The keeper's list: every stamp in it, in the order the keeper published them. */
  stamps: bigint[]
  /** The keeper's ed25519 signature over this list's root, as 32 big-endian bytes. */
  keeperSignature: Uint8Array
  artifacts: Artifacts
  /** Pays the row's deposit and the transaction's fee, and signs it. May be the profile. */
  payer: PublicKey
  recentBlockhash: string
  /** Leave unset for no compute-budget instruction. */
  computeUnitLimit?: number
  programId?: PublicKey
}): Promise<Registration> {
  const programId = input.programId ?? PROGRAM_ID
  if (new TextEncoder().encode(input.label).length > MAX_LABEL) throw new RangeError(`a label is at most ${MAX_LABEL} bytes`)
  if (!keeperSigned({ keeper: input.keeper, root: listRoot(input.stamps), keeperSignature: input.keeperSignature })) {
    throw new Error("the keeper's signature is not on this list's root")
  }
  const p = await proveStamp(input)
  const instruction = registerIx({
    profile: input.profile,
    label: input.label,
    marketStamp: p.marketStamp,
    keeper: input.keeper,
    root: p.root,
    keeperSignature: input.keeperSignature,
    proof: p.proof,
    payer: input.payer,
    programId,
  })
  const instructions =
    input.computeUnitLimit === undefined ? [instruction] : [ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }), instruction]
  const transaction = new VersionedTransaction(
    new TransactionMessage({ payerKey: input.payer, recentBlockhash: input.recentBlockhash, instructions }).compileToV0Message(),
  )
  return { ...p, marketStampBytes: toBytes32(p.marketStamp), row: rowAddress(p.marketStamp, programId), instruction, transaction }
}

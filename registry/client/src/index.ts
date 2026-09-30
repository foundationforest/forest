// The Forest registry client: everything a device needs to turn an identity secret into a line,
// to read lines back, and to make and check the proofs of other issuers' lists that a profile
// keeps off chain. It talks to no network of its own. The caller passes in an issuer's published
// list of commitments and a recent blockhash; the caller has the payer sign and sends.
//
// One line, one proof, one transaction: `register`. Only the payer signs. The profile key signs
// nothing: the proof names it. A line never changes after it; more issuers are membership records
// (`membership.ts`).
//
// Nothing here is shipped.

import type { Identity } from '@semaphore-protocol/identity'
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'

import { toBytes32 } from './field.ts'
import { proveMembership, type Artifacts, type MembershipProof } from './proof.ts'
import { MAX_LABEL, PROGRAM_ID, lineAddress, registerIx } from './program.ts'

export * from './field.ts'
export * from './compress.ts'
export * from './code.ts'
export * from './program.ts'
export * from './proof.ts'
export * from './lines.ts'
export * from './membership.ts'

/** Unsigned, with the payer as fee payer. No compute-budget instruction unless one is asked for. */
function transaction(input: {
  instruction: TransactionInstruction
  payer: PublicKey
  recentBlockhash: string
  computeUnitLimit?: number
}): VersionedTransaction {
  const instructions =
    input.computeUnitLimit === undefined
      ? [input.instruction]
      : [ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }), input.instruction]
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: input.payer,
      recentBlockhash: input.recentBlockhash,
      instructions,
    }).compileToV0Message(),
  )
}

export type Registration = MembershipProof & {
  codeBytes: Uint8Array
  /** The line's address. */
  line: PublicKey
  instruction: TransactionInstruction
  /** Unsigned: `register`, needing only the payer's signature. */
  transaction: VersionedTransaction
}

/**
 * A line for one profile under one label, proven against one issuer's list: the issuer's published
 * commitments, in its order, the person's own among them. Prove against the issuer's newest list.
 */
export async function buildRegistration(input: {
  /** The 32 bytes `keys/`'s `identitySecret(seed)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  label: string
  /** The profile's key (`keys/`'s `profileKey(seed, n).publicKey`). It signs nothing here. */
  profile: PublicKey | Uint8Array
  commitments: bigint[]
  artifacts: Artifacts
  /** Pays the line's deposit and the transaction's fee, and signs it. */
  payer: PublicKey
  recentBlockhash: string
  /** Leave unset for no compute-budget instruction. */
  computeUnitLimit?: number
  programId?: PublicKey
}): Promise<Registration> {
  const programId = input.programId ?? PROGRAM_ID
  if (new TextEncoder().encode(input.label).length > MAX_LABEL) throw new RangeError(`a label is at most ${MAX_LABEL} bytes`)
  const p = await proveMembership(input)
  const instruction = registerIx({ profile: input.profile, label: input.label, code: p.code, proof: p, payer: input.payer, programId })
  return {
    ...p,
    codeBytes: toBytes32(p.code),
    line: lineAddress(p.code, programId),
    instruction,
    transaction: transaction({ instruction, payer: input.payer, recentBlockhash: input.recentBlockhash, computeUnitLimit: input.computeUnitLimit }),
  }
}

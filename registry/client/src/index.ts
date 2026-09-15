// The Forest registry client: everything a device needs to turn an identity secret into one
// registration, and nothing else. It talks to no network of its own. The caller passes in the
// list's leaves and a recent blockhash; the caller sends the transaction.
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
import { proveMembership, type Artifacts, type Leaves, type MembershipProof } from './proof.ts'
import {
  PROGRAM_ID,
  registerIx,
  usedCodeAddress,
  type RegisterAccounts,
} from './program.ts'

export * from './field.ts'
export * from './compress.ts'
export * from './code.ts'
export * from './program.ts'
export * from './proof.ts'

/**
 * A registration measured at 132,302 compute units under LiteSVM and 132,296 on a local
 * validator, rounded up with room for a runtime that prices a syscall differently. Well under
 * the 1,400,000 a transaction may ask for.
 */
export const REGISTER_COMPUTE_UNITS = 220_000

export type Registration = MembershipProof & {
  codeBytes: Uint8Array
  /** The account the program creates. Its existence is this human's badge in this market. */
  codeAccount: PublicKey
  instruction: TransactionInstruction
  /** Unsigned. The profile's wallet signs it, then the fee payer co-signs and sends it. */
  transaction: VersionedTransaction
}

export async function buildRegistration(input: {
  /** The 32 bytes `keys/`'s `identitySecret(seed)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  market: string
  did: string
  listIndex: number
  leaves: Leaves
  artifacts: Artifacts
  accounts: RegisterAccounts
  recentBlockhash: string
  /** Set to null to leave the compute budget instruction out. */
  computeUnitLimit?: number | null
  programId?: PublicKey
}): Promise<Registration> {
  const programId = input.programId ?? PROGRAM_ID
  const membership = await proveMembership({
    secret: input.secret,
    market: input.market,
    did: input.did,
    leaves: input.leaves,
    artifacts: input.artifacts,
  })

  const instruction = registerIx({
    market: input.market,
    did: input.did,
    listIndex: input.listIndex,
    root: membership.root,
    code: membership.code,
    proof: membership.proof,
    accounts: input.accounts,
    programId,
  })

  const limit = input.computeUnitLimit === undefined ? REGISTER_COMPUTE_UNITS : input.computeUnitLimit
  const instructions =
    limit === null
      ? [instruction]
      : [ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), instruction]

  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: input.accounts.payer,
      recentBlockhash: input.recentBlockhash,
      instructions,
    }).compileToV0Message(),
  )

  return {
    ...membership,
    codeBytes: toBytes32(membership.code),
    codeAccount: usedCodeAddress(membership.code, programId),
    instruction,
    transaction,
  }
}

// The Forest registry client: everything a device needs to turn an identity secret into a line,
// and to read lines back. It talks to no network of its own. The caller passes in each issuer's
// published list of commitments and a recent blockhash; the caller has the payer sign and sends.
//
// One proof per transaction: the first list's goes in `register`, every other list's in its own
// `add_proof`. Only the payer signs. The profile key signs nothing: the proof names it.
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

import { codeFor } from './code.ts'
import { toBytes32 } from './field.ts'
import { proveMembership, type Artifacts, type MembershipProof } from './proof.ts'
import { MAX_LABEL, MAX_ROOTS, PROGRAM_ID, addProofIx, lineAddress, registerIx } from './program.ts'

export * from './field.ts'
export * from './compress.ts'
export * from './code.ts'
export * from './program.ts'
export * from './proof.ts'
export * from './lines.ts'

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

export type Registration = {
  code: bigint
  codeBytes: Uint8Array
  /** The line's address. */
  line: PublicKey
  /** One per list, in the order given. */
  proofs: MembershipProof[]
  instructions: TransactionInstruction[]
  /**
   * Unsigned, one per list: `register` with the first list's proof, then one `add_proof` for each
   * other list. Send them in order; each needs only the payer's signature.
   */
  transactions: VersionedTransaction[]
}

/**
 * A line for one profile under one label, backed by one or more issuers' lists. Each list is the
 * issuer's published commitments, in its order; the person's own commitment must be in every one.
 * Prove against each issuer's newest list.
 */
export async function buildRegistration(input: {
  /** The 32 bytes `keys/`'s `identitySecret(seed)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  label: string
  /** The profile's key (`keys/`'s `profileKey(seed, n).publicKey`). It signs nothing here. */
  profile: PublicKey | Uint8Array
  lists: bigint[][]
  artifacts: Artifacts
  /** Pays the line's deposit and each transaction's fee, and signs each transaction. */
  payer: PublicKey
  recentBlockhash: string
  /** Leave unset for no compute-budget instruction. */
  computeUnitLimit?: number
  programId?: PublicKey
}): Promise<Registration> {
  const programId = input.programId ?? PROGRAM_ID
  if (input.lists.length < 1) throw new RangeError('at least one list')
  if (input.lists.length > MAX_ROOTS) throw new RangeError(`a line holds at most ${MAX_ROOTS} roots`)
  if (new TextEncoder().encode(input.label).length > MAX_LABEL) throw new RangeError(`a label is at most ${MAX_LABEL} bytes`)

  const proofs: MembershipProof[] = []
  for (const commitments of input.lists) {
    const p = await proveMembership({
      secret: input.secret,
      label: input.label,
      profile: input.profile,
      commitments,
      artifacts: input.artifacts,
    })
    if (proofs.some((q) => q.root === p.root)) throw new Error('two lists give the same root; a line holds each root once')
    proofs.push(p)
  }

  const code = codeFor(input.secret, input.label)
  const [first, ...rest] = proofs
  const instructions = [
    registerIx({ profile: input.profile, label: input.label, code, proof: first, payer: input.payer, programId }),
    ...rest.map((p) => addProofIx({ code, proof: p, payer: input.payer, programId })),
  ]
  return {
    code,
    codeBytes: toBytes32(code),
    line: lineAddress(code, programId),
    proofs,
    instructions,
    transactions: instructions.map((instruction) =>
      transaction({ instruction, payer: input.payer, recentBlockhash: input.recentBlockhash, computeUnitLimit: input.computeUnitLimit }),
    ),
  }
}

/** One more issuer's list for a line that exists: one `add_proof`, needing only the payer's signature. */
export async function buildAddProof(input: {
  secret: Uint8Array | Identity
  label: string
  profile: PublicKey | Uint8Array
  commitments: bigint[]
  artifacts: Artifacts
  payer: PublicKey
  recentBlockhash: string
  computeUnitLimit?: number
  programId?: PublicKey
}): Promise<MembershipProof & { instruction: TransactionInstruction; transaction: VersionedTransaction }> {
  const programId = input.programId ?? PROGRAM_ID
  const p = await proveMembership(input)
  const instruction = addProofIx({ code: p.code, proof: p, payer: input.payer, programId })
  return {
    ...p,
    instruction,
    transaction: transaction({ instruction, payer: input.payer, recentBlockhash: input.recentBlockhash, computeUnitLimit: input.computeUnitLimit }),
  }
}

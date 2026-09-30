// One Semaphore proof, made on the device, against an issuer's list.
//
// An issuer publishes its list outside the registry: every identity commitment it vouches for, in
// the order it took them, and the list's root. The device finds its own commitment in the list,
// builds the Merkle path, and proves membership for one label and one profile. The registry takes
// the root as given; readers decide which issuers' roots they trust.
//
// Semaphore's own `generateProof` hashes the scope and the message for you, as a 32-byte
// big-endian number, which caps a label at 32 bytes. The registry hashes a namespaced string
// instead, so this calls snarkjs directly and hands the circuit the two field values the program
// derives for itself. Nothing else about the circuit or the artifacts changes.

import { Group } from '@semaphore-protocol/group'
import type { Identity } from '@semaphore-protocol/identity'
import type { PublicKey } from '@solana/web3.js'
import { groth16 } from 'snarkjs'

import { codeFor, commitmentOf, identityFrom } from './code.ts'
import { compressProof, type CompressedProof, type SnarkjsProof } from './compress.ts'
import { messageOf, scopeOf } from './field.ts'
import { MAX_DEPTH } from './program.ts'

/** The pinned artifacts. Paths on Node, or the bytes themselves in a browser. */
export type Artifacts = {
  wasm: string | Uint8Array
  zkey: string | Uint8Array
}

export type MembershipProof = {
  /** The root of the list the proof was made against. */
  root: bigint
  /** The nullifier: the line's code. */
  code: bigint
  scope: bigint
  message: bigint
  /** The proof, points compressed the way the program reads them. */
  proof: CompressedProof
  /** The proof as snarkjs wrote it, kept so a caller can verify it with the verification key. */
  raw: SnarkjsProof
  publicSignals: string[]
}

/** The root the circuit computes for a list, in order (Semaphore's LeanIMT). Zero when empty. */
export function listRoot(commitments: bigint[]): bigint {
  return commitments.length === 0 ? 0n : new Group(commitments).root
}

export async function proveMembership(input: {
  secret: Uint8Array | Identity
  label: string
  /** The profile's 32-byte key. The proof names it; only its line can be made or extended with it. */
  profile: PublicKey | Uint8Array
  /** The issuer's list: every commitment in it, in the order the issuer published them. */
  commitments: bigint[]
  artifacts: Artifacts
}): Promise<MembershipProof> {
  const identity = identityFrom(input.secret)
  const commitment = commitmentOf(identity)

  const group = new Group(input.commitments)
  const index = group.indexOf(commitment)
  if (index === -1) throw new Error('this identity is not in the list')
  const merkleProof = group.generateMerkleProof(index)

  const scope = scopeOf(input.label)
  const message = messageOf(input.profile)

  // The circuit walks `merkleProofLength` levels; the arrays are padded to the sealed depth and
  // the padding is never read.
  const merkleProofLength = merkleProof.siblings.length
  if (merkleProofLength > MAX_DEPTH) throw new Error('the list is deeper than the sealed depth')
  const merkleProofIndices: number[] = []
  const merkleProofSiblings: bigint[] = [...merkleProof.siblings]
  for (let i = 0; i < MAX_DEPTH; i++) {
    merkleProofIndices.push((merkleProof.index >> i) & 1)
    if (merkleProofSiblings[i] === undefined) merkleProofSiblings[i] = 0n
  }

  const { proof, publicSignals } = (await groth16.fullProve(
    {
      secret: identity.secretScalar,
      merkleProofLength,
      merkleProofIndices,
      merkleProofSiblings,
      scope,
      message,
    },
    input.artifacts.wasm,
    input.artifacts.zkey,
  )) as { proof: SnarkjsProof; publicSignals: string[] }

  // Semaphore's order: root, nullifier, message, scope. Checked here so a change in the library
  // or the artifacts shows up as an error and not as a proof the program silently rejects.
  const [rootSignal, nullifier, messageSignal, scopeSignal] = publicSignals
  const code = codeFor(identity, input.label)
  if (BigInt(rootSignal) !== merkleProof.root) throw new Error('the proof is against another root')
  if (BigInt(nullifier) !== code) throw new Error('the proof carries another code')
  if (BigInt(messageSignal) !== message) throw new Error('the proof carries another message')
  if (BigInt(scopeSignal) !== scope) throw new Error('the proof carries another scope')

  return {
    root: merkleProof.root,
    code,
    scope,
    message,
    proof: compressProof(proof),
    raw: proof,
    publicSignals,
  }
}

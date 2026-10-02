// One Semaphore proof, made on the device, against a keeper's list.
//
// A keeper publishes its list its own way: every stamp in it, in the order it took them, and its
// signature on each snapshot's root. The device finds its own stamp in the list, builds the Merkle
// path, and proves "my stamp is on this list" for one label (the scope) and one profile (the
// message). The registry takes the root as given; readers decide which keepers they trust.
//
// Semaphore's own `generateProof` hashes the scope and the message for you, as a 32-byte
// big-endian number, which caps a label at 32 bytes. The registry hashes a namespaced string
// instead, so this calls snarkjs directly and hands the circuit the two field values the program
// derives for itself. Nothing else about the circuit or the artifacts changes.

import { Group } from '@semaphore-protocol/group'
import type { Identity } from '@semaphore-protocol/identity'
import type { PublicKey } from '@solana/web3.js'
import { groth16 } from 'snarkjs'

import { compressProof, type CompressedProof, type SnarkjsProof } from './compress.ts'
import { messageOf, scopeOf } from './field.ts'
import { MAX_DEPTH } from './program.ts'
import { identityFrom, marketStampOf, stampOf } from './stamp.ts'

/** The pinned artifacts. Paths on Node, or the bytes themselves in a browser. */
export type Artifacts = {
  wasm: string | Uint8Array
  zkey: string | Uint8Array
}

export type StampProof = {
  /** The root of the list the proof was made against. */
  root: bigint
  /** The nullifier: the person's market stamp on this list under this label. */
  marketStamp: bigint
  scope: bigint
  message: bigint
  /** The proof, points compressed the way the program reads them. */
  proof: CompressedProof
  /** The proof as snarkjs wrote it. */
  raw: SnarkjsProof
  publicSignals: string[]
}

/** The root the circuit computes for a list, in order (Semaphore's LeanIMT). Zero when empty. */
export function listRoot(stamps: bigint[]): bigint {
  return stamps.length === 0 ? 0n : new Group(stamps).root
}

export async function proveStamp(input: {
  /** The 32 bytes `keys/`'s `listSecret(seed, keeper)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  label: string
  /** The profile's 32-byte key. The proof names it: it counts for this profile's row only. */
  profile: PublicKey | Uint8Array
  /** The keeper's list: every stamp in it, in the order the keeper published them. */
  stamps: bigint[]
  artifacts: Artifacts
}): Promise<StampProof> {
  const identity = identityFrom(input.secret)

  const group = new Group(input.stamps)
  const index = group.indexOf(stampOf(identity))
  if (index === -1) throw new Error('this stamp is not on the list')
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
  const marketStamp = marketStampOf(identity, input.label)
  if (BigInt(rootSignal) !== merkleProof.root) throw new Error('the proof is against another root')
  if (BigInt(nullifier) !== marketStamp) throw new Error('the proof carries another market stamp')
  if (BigInt(messageSignal) !== message) throw new Error('the proof carries another message')
  if (BigInt(scopeSignal) !== scope) throw new Error('the proof carries another scope')

  return {
    root: merkleProof.root,
    marketStamp,
    scope,
    message,
    proof: compressProof(proof),
    raw: proof,
    publicSignals,
  }
}

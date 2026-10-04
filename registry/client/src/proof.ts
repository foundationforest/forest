// One Semaphore proof, made on the device, against an issuer's list.
//
// An issuer publishes its list its own way: every stamp in it, in the order it took them, and its
// signature on each snapshot's root. The device finds its own stamp in the list, builds the Merkle
// path, and proves "my stamp is on this list" for one label (the scope) and one profile (the
// message). The registry takes the root as given; readers decide which issuers they trust.
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
import { fromBytes32, isFieldElement, messageOf, scopeOf } from './field.ts'
import { MAX_DEPTH } from './program.ts'
import { identityFrom, marketStampOf, stampOf } from './stamp.ts'
import { VERIFICATION_KEY } from './verification-key.ts'

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
  /** The 32 bytes `keys/`'s `listSecret(seed, issuer)` returns, or the identity itself. */
  secret: Uint8Array | Identity
  label: string
  /** The profile's 32-byte key. The proof names it: it counts for this profile's row only. */
  profile: PublicKey | Uint8Array
  /** The issuer's list: every stamp in it, in the order the issuer published them. */
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

  // The circuit walks `merkleProofLength` levels; the siblings are padded to the sealed depth and
  // the padding is never read. The path is one number, which the circuit splits into 32 bits,
  // each forced to be 0 or 1.
  const merkleProofLength = merkleProof.siblings.length
  if (merkleProofLength > MAX_DEPTH) throw new Error('the list is deeper than the sealed depth')
  const merkleProofSiblings: bigint[] = [...merkleProof.siblings]
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (merkleProofSiblings[i] === undefined) merkleProofSiblings[i] = 0n
  }

  const { proof, publicSignals } = (await groth16.fullProve(
    {
      secret: identity.secretScalar,
      merkleProofLength,
      merkleProofIndex: merkleProof.index,
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

/**
 * Does this proof hold for this root, market stamp, label and main key? The program's own check,
 * without the chain: the scope and the message are derived from the label and the main key, every
 * public input must be a field element, and the proof is verified with the key the program has
 * baked in. Like the program, it takes the root as given: a caller checks that an issuer it trusts
 * signed it (`issuerSigned`). Anything that is not a good proof for these inputs is false.
 *
 * Soil's fee payer sponsors a row only against a proof under a `sponsor/<n>` label.
 */
export async function verifyStamp(input: {
  /** The proof as snarkjs writes it: `proveStamp`'s `raw`. */
  proof: SnarkjsProof
  root: bigint | Uint8Array
  marketStamp: bigint | Uint8Array
  label: string
  /** The main key the proof names. */
  profile: PublicKey | Uint8Array
}): Promise<boolean> {
  try {
    const value = (v: bigint | Uint8Array) => (typeof v === 'bigint' ? v : fromBytes32(v))
    const root = value(input.root)
    const marketStamp = value(input.marketStamp)
    if (!isFieldElement(root) || !isFieldElement(marketStamp)) return false
    // Semaphore's order: root, nullifier, message, scope.
    const publicSignals = [root, marketStamp, messageOf(input.profile), scopeOf(input.label)].map(String)
    return await groth16.verify(VERIFICATION_KEY, publicSignals, input.proof)
  } catch {
    return false
  }
}

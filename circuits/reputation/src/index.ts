// The reputation proof's client: the tree an index publishes, the proof an app makes from it on the
// device, and the check any reader makes. It talks to no network of its own: the caller passes in
// the index's published leaves, root, time and signature.
//
// The market stamp, the scope and the message come from the registry client unchanged, so a leaf
// names a profile exactly as its registry row does, and a proof names a main key exactly as a
// registration does.
//
// Nothing here is in production: the circuit's setup is devnet only (../README.md).

import { ed25519 } from '@noble/curves/ed25519.js'
import { Group } from '@semaphore-protocol/group'
import { poseidon4 } from 'poseidon-lite/poseidon4'
import { groth16 } from 'snarkjs'

import verificationKey from '../devnet/verification-key.json' with { type: 'json' }
import type { SnarkjsProof } from '../../../registry/client/src/compress.ts'
import { BN254_P, fromBytes32, isFieldElement, messageOf, scopeOf, toBytes32 } from '../../../registry/client/src/field.ts'
import { identityFrom, marketStampOf } from '../../../registry/client/src/stamp.ts'

/** A list secret: the 32 bytes `keys/`'s `listSecret(seed, issuer)` returns, or its identity. */
type Secret = Parameters<typeof identityFrom>[0]
/** A 32-byte ed25519 key: a main key or an index's key. */
type Key = Parameters<typeof messageOf>[0]

/** The circuit's slots: a proof counts up to this many profiles. */
export const SLOTS = 8
/** The circuit's depth: a tree holds at most 2^DEPTH leaves. */
export const DEPTH = 20
/** Every score and count is below this. */
export const BOUND = 2n ** 32n
/** What an index's signature starts with. 0xff starts no Solana message; the text no other signature. */
export const SIGNED_PREFIX = 'forest/v1/reputation\n'

/** One profile in an index's tree. */
export type Leaf = {
  /** The profile's market stamp: its registry row's seed. */
  stamp: bigint
  /** The scope of the profile's label, as the registry computes it (`scopeOf`). */
  scope: bigint
  /** The index's score for the profile, times ten. */
  score: bigint
  /** How many reviews the score comes from. */
  count: bigint
}

/** Where a leaf sits: Semaphore's Merkle proof, as the circuit reads it. */
export type Path = { length: number; index: number; siblings: bigint[] }

export type Tree = {
  /** What the index signs, with a time. */
  root: bigint
  /** The path to the leaf with this market stamp, if the tree has one. */
  pathOf(stamp: bigint): Path | undefined
}

/** The pinned setup files. Paths on Node, or the bytes themselves in a browser. */
export type Artifacts = {
  wasm: string | Uint8Array
  zkey: string | Uint8Array
}

export type ReputationProof = {
  /** The count-weighted score of the profiles counted, times ten, rounded down. */
  score: bigint
  root: bigint
  message: bigint
  /** The scope shown, or 0. */
  scope: bigint
  /** The proof as snarkjs wrote it. */
  proof: SnarkjsProof
  publicSignals: string[]
}

/** A leaf's hash: Poseidon(stamp, scope, score, count). */
export function leafHash(leaf: Leaf): bigint {
  return poseidon4([leaf.stamp, leaf.scope, leaf.score, leaf.count])
}

/**
 * The tree an index publishes: Semaphore's, the kind an issuer's list is, over the leaves' hashes in
 * the index's order. Refuses an empty tree, one deeper than the circuit, a field out of range, and
 * two leaves for one market stamp.
 */
export function buildTree(leaves: Leaf[]): Tree {
  if (leaves.length === 0) throw new RangeError('a tree has at least one leaf')
  if (leaves.length > 2 ** DEPTH) throw new RangeError(`a tree has at most 2^${DEPTH} leaves`)
  const at = new Map<bigint, number>()
  leaves.forEach((leaf, i) => {
    if (!isFieldElement(leaf.stamp) || !isFieldElement(leaf.scope)) throw new RangeError(`leaf ${i}: not a field element`)
    if (leaf.score < 0n || leaf.score >= BOUND || leaf.count < 0n || leaf.count >= BOUND) {
      throw new RangeError(`leaf ${i}: a score and a count are each from 0 to 2^32 - 1`)
    }
    if (at.has(leaf.stamp)) throw new Error(`leaf ${i}: a second leaf for one market stamp`)
    at.set(leaf.stamp, i)
  })
  const group = new Group(leaves.map(leafHash))
  return {
    root: group.root,
    pathOf(stamp) {
      const i = at.get(stamp)
      if (i === undefined) return undefined
      const proof = group.generateMerkleProof(i)
      return { length: proof.siblings.length, index: proof.index, siblings: proof.siblings }
    },
  }
}

/** What an index signs: 0xff, its text, the root as 32 big-endian bytes, the time as 8 (ms). */
export function signedBytes(root: bigint, time: bigint | number): Uint8Array {
  const ms = BigInt(time)
  if (!isFieldElement(root)) throw new RangeError('a root is a field element')
  if (ms < 0n || ms >= 2n ** 64n) throw new RangeError('a time is 0 to 2^64 - 1 ms')
  const text = new TextEncoder().encode(SIGNED_PREFIX)
  const out = new Uint8Array(1 + text.length + 32 + 8)
  out[0] = 0xff
  out.set(text, 1)
  out.set(toBytes32(root), 1 + text.length)
  new DataView(out.buffer).setBigUint64(1 + text.length + 32, ms)
  return out
}

/**
 * The circuit's input for these profiles, and the public signals it must give. `proveReputation`
 * proves it; it is exported for a caller that drives snarkjs itself.
 */
export function circuitInput(input: {
  /** The person's secret for one list. */
  secret: Secret
  /** The labels of the person's profiles on that list to count: one to eight. */
  labels: string[]
  /** The index's published leaves, in its order. */
  leaves: Leaf[]
  /** The main key the proof is shown for. The proof names it and counts for it alone. */
  profile: Key
  /** Show the label. Only with one label. */
  show?: boolean
}): { input: Record<string, unknown>; publicSignals: bigint[] } {
  const { labels } = input
  if (labels.length < 1 || labels.length > SLOTS) throw new RangeError(`one to ${SLOTS} labels`)
  if (new Set(labels).size !== labels.length) throw new Error('a label twice')
  if (input.show && labels.length !== 1) throw new Error('a label is shown only when it is the only one')

  const identity = identityFrom(input.secret)
  const tree = buildTree(input.leaves)
  const byStamp = new Map(input.leaves.map((leaf) => [leaf.stamp, leaf]))

  const slots = labels.map((label) => {
    const stamp = marketStampOf(identity, label)
    const leaf = byStamp.get(stamp)
    const path = tree.pathOf(stamp)
    if (leaf === undefined || path === undefined) throw new Error(`the tree has no leaf for ${label}`)
    return { leaf, path }
  })

  const countSum = slots.reduce((n, s) => n + s.leaf.count, 0n)
  if (countSum === 0n) throw new Error('no reviews to count')
  const score = slots.reduce((n, s) => n + s.leaf.score * s.leaf.count, 0n) / countSum

  const blank = { leaf: { stamp: 0n, scope: 0n, score: 0n, count: 0n }, path: { length: 0, index: 0, siblings: [] as bigint[] } }
  const all = [...slots, ...Array(SLOTS - slots.length).fill(blank)] as typeof slots
  const scope = input.show ? scopeOf(labels[0]) : 0n
  const message = messageOf(input.profile)

  return {
    input: {
      secret: identity.secretScalar,
      used: all.map((_, i) => (i < slots.length ? 1 : 0)),
      stamps: all.map((s) => s.leaf.stamp),
      scopes: all.map((s) => s.leaf.scope),
      scores: all.map((s) => s.leaf.score),
      counts: all.map((s) => s.leaf.count),
      pathLengths: all.map((s) => s.path.length),
      pathIndices: all.map((s) => s.path.index),
      // The circuit walks `pathLengths` levels; the rest is padding it never reads.
      pathSiblings: all.map((s) => [...s.path.siblings, ...Array(DEPTH - s.path.siblings.length).fill(0n)]),
      root: tree.root,
      message,
      scope,
    },
    publicSignals: [score, tree.root, message, scope],
  }
}

/** Make the proof, on the device. */
export async function proveReputation(input: Parameters<typeof circuitInput>[0] & { artifacts: Artifacts }): Promise<ReputationProof> {
  const { input: signals, publicSignals: want } = circuitInput(input)
  const { proof, publicSignals } = (await groth16.fullProve(signals, input.artifacts.wasm, input.artifacts.zkey)) as {
    proof: SnarkjsProof
    publicSignals: string[]
  }
  // The circuit's order: score, root, message, scope. Checked so a change in the circuit or the
  // setup files shows up here, and not as a proof every reader refuses.
  if (publicSignals.length !== 4 || publicSignals.some((s, i) => BigInt(s) !== want[i])) {
    throw new Error('the proof carries other public signals than the ones asked for')
  }
  const [score, root, message, scope] = want
  return { score, root, message, scope, proof, publicSignals }
}

/**
 * The proof as a profile record stores it (records/README.md, Proofs): its three points whole, 256
 * bytes, eight 32-byte big-endian numbers in the order Ethereum's and Solana's BN254 precompiles
 * read, each G2 pair's imaginary part first.
 */
export function proofBytes(proof: SnarkjsProof): Uint8Array {
  const { pi_a, pi_b, pi_c } = proof
  if (BigInt(pi_a[2]) !== 1n || BigInt(pi_c[2]) !== 1n || BigInt(pi_b[2][0]) !== 1n || BigInt(pi_b[2][1]) !== 0n) {
    throw new Error('a proof is three points as snarkjs writes them, each with its last coordinate 1')
  }
  const order = [pi_a[0], pi_a[1], pi_b[0][1], pi_b[0][0], pi_b[1][1], pi_b[1][0], pi_c[0], pi_c[1]]
  const out = new Uint8Array(256)
  order.forEach((s, i) => out.set(toBytes32(coordinate(BigInt(s))), i * 32))
  return out
}

/** The proof as snarkjs writes it, from its 256 bytes. */
export function proofFromBytes(bytes: Uint8Array): SnarkjsProof {
  if (bytes.length !== 256) throw new RangeError('a proof is 256 bytes')
  const n = Array.from({ length: 8 }, (_, i) => coordinate(fromBytes32(bytes.subarray(i * 32, i * 32 + 32))).toString())
  return { pi_a: [n[0], n[1], '1'], pi_b: [[n[3], n[2]], [n[5], n[4]], ['1', '0']], pi_c: [n[6], n[7], '1'] }
}

// snarkjs reads a coordinate modulo the field, so one with the modulus added would be the same
// point in other bytes. The precompiles refuse it, and so does this.
function coordinate(value: bigint): bigint {
  if (value >= BN254_P) throw new RangeError('a coordinate is below the base field modulus')
  return value
}

/**
 * Does this proof hold, under a root this index signed with this time? Checks the index's signature
 * (strict ed25519, as `records/` checks every record), that every public value is in range, then the
 * proof with the committed verification key, for this main key and, if one is given, this shown
 * label. How old a time to accept, and which indexes to trust, is the reader's choice. Anything that
 * is not a good proof for these inputs is false.
 */
export async function verifyReputation(input: {
  /** The proof as snarkjs writes it, `proveReputation`'s `proof`, or its 256 bytes (`proofBytes`). */
  proof: SnarkjsProof | Uint8Array
  root: bigint
  score: bigint
  /** The main key the proof is shown for. */
  profile: Key
  /** The label shown, if the proof shows one. */
  label?: string
  /** The index's ed25519 key. */
  index: Key
  /** The time the index signed with the root, in ms. */
  time: bigint | number
  /** The index's signature over `signedBytes(root, time)`. */
  signature: Uint8Array
}): Promise<boolean> {
  try {
    const index = input.index instanceof Uint8Array ? input.index : input.index.toBytes()
    if (index.length !== 32 || input.signature.length !== 64) return false
    if (!ed25519.verify(input.signature, signedBytes(input.root, input.time), index, { zip215: false })) return false
    if (input.score < 0n || input.score >= BOUND) return false
    const scope = input.label === undefined ? 0n : scopeOf(input.label)
    const publicSignals = [input.score, input.root, messageOf(input.profile), scope].map(String)
    const proof = input.proof instanceof Uint8Array ? proofFromBytes(input.proof) : input.proof
    return await groth16.verify(verificationKey, publicSignals, proof)
  } catch {
    return false
  }
}

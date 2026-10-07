// The reputation proof, end to end: an index's tree of made-up leaves around keys/'s test person,
// proofs with one slot and with three, and every way a proof must fail.
//
// They need the devnet setup's files: `npm run fetch` first. A missing file fails; nothing skips.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ed25519 } from '@noble/curves/ed25519.js'
import { Group } from '@semaphore-protocol/group'
import { poseidon4 } from 'poseidon-lite/poseidon4'
import { groth16 } from 'snarkjs'

import { issuerSecret } from '../../../keys/src/index.ts'
import { BN254_P, BN254_R, fromBytes32, scopeOf, toBytes32 } from '../../../registry/client/src/field.ts'
import { stampOf } from '../../../registry/client/src/stamp.ts'
import {
  BOUND,
  DEPTH,
  SIGNED_PREFIX,
  buildTree,
  circuitInput,
  leafHash,
  proofBytes,
  proofFromBytes,
  proveReputation,
  signedBytes,
  verifyReputation,
  type Leaf,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = { wasm: join(here, '../devnet/reputation.wasm'), zkey: join(here, '../devnet/reputation.zkey') }
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(keysVectors.seed, 'hex')
const secret = (await issuerSecret(seed, keysVectors.issuers[0].name)).secret
const stranger = await issuerSecret(seed, keysVectors.issuers[1].name)

// The person's three profiles from the first issuer, as an index scores them.
const labels = ['tutoring/seller', 'tutoring/buyer', 'cleaning/seller']
const mine: Leaf[] = labels.map((label, i) => ({
  stamp: stampOf(secret, label),
  scope: scopeOf(label),
  score: [47n, 39n, 50n][i],
  count: [12n, 3n, 1n][i],
}))
const field = () => BigInt('0x' + randomBytes(32).toString('hex')) % BN254_R
const madeUp = (n: number): Leaf[] =>
  Array.from({ length: n }, (_, i) => ({ stamp: field(), scope: scopeOf(`made-up/${i}`), score: BigInt(i % 51), count: BigInt(i % 40) }))
const others = madeUp(97)
const leaves = [...others.slice(0, 40), mine[0], ...others.slice(40, 70), mine[1], mine[2], ...others.slice(70)]
const tree = buildTree(leaves)

// The index signs the root with a time.
const indexKey = ed25519.utils.randomSecretKey()
const index = ed25519.getPublicKey(indexKey)
const time = 1_791_072_000_000n
const signature = ed25519.sign(signedBytes(tree.root, time), indexKey)

// The person shows the proof on a new profile.
const profile = ed25519.getPublicKey(ed25519.utils.randomSecretKey())

test('a leaf is Poseidon(stamp, scope, score, count), and the tree is Semaphore\'s over them', () => {
  assert.equal(leafHash(mine[0]), poseidon4([mine[0].stamp, mine[0].scope, 47n, 12n]))
  assert.equal(tree.root, new Group(leaves.map(leafHash)).root)
  const path = tree.pathOf(mine[1].stamp)
  assert.ok(path)
  assert.equal(path.length, path.siblings.length)
  assert.ok(path.length <= DEPTH)
  assert.equal(tree.pathOf(field()), undefined)
})

test('buildTree refuses an empty tree, one too deep, a field out of range, and two leaves for one stamp', () => {
  assert.throws(() => buildTree([]), /at least one leaf/)
  assert.throws(() => buildTree(Array(2 ** DEPTH + 1).fill(mine[0])), /at most 2\^20/)
  assert.throws(() => buildTree([{ ...mine[0], score: BOUND }]), /0 to 2\^32 - 1/)
  assert.throws(() => buildTree([{ ...mine[0], count: -1n }]), /0 to 2\^32 - 1/)
  assert.throws(() => buildTree([{ ...mine[0], stamp: BN254_R }]), /field element/)
  assert.throws(() => buildTree([mine[0], { ...mine[0], score: 50n }]), /second leaf/)
})

test('an index signs 0xff, its text, the root as 32 bytes and the time as 8, both big-endian', () => {
  const bytes = signedBytes(tree.root, time)
  const text = Buffer.from(SIGNED_PREFIX)
  assert.equal(bytes.length, 1 + text.length + 32 + 8)
  assert.equal(bytes[0], 0xff)
  assert.deepEqual(Buffer.from(bytes.subarray(1, 1 + text.length)), text)
  assert.equal(BigInt('0x' + Buffer.from(bytes.subarray(1 + text.length, -8)).toString('hex')), tree.root)
  assert.equal(Buffer.from(bytes.subarray(-8)).readBigUInt64BE(), time)
})

test('single: one profile, its label shown, its score exactly', async () => {
  const r = await proveReputation({ secret, labels: ['tutoring/seller'], leaves, profile, show: true, artifacts })
  assert.equal(r.score, 47n)
  assert.equal(r.scope, scopeOf('tutoring/seller'))
  const shown = { proof: r.proof, root: r.root, score: r.score, profile, index, time, signature }
  assert.equal(await verifyReputation({ ...shown, label: 'tutoring/seller' }), true)
  assert.equal(await verifyReputation(shown), false, 'not as a proof that shows no label')
  assert.equal(await verifyReputation({ ...shown, label: 'cleaning/seller' }), false, 'not for another label')
})

test('global: three profiles, no label shown, their count-weighted score rounded down', async () => {
  const r = await proveReputation({ secret, labels, leaves, profile, artifacts })
  assert.equal(r.score, (47n * 12n + 39n * 3n + 50n * 1n) / 16n)
  assert.equal(r.scope, 0n)
  const shown = { proof: r.proof, root: r.root, score: r.score, profile, index, time, signature }
  assert.equal(await verifyReputation(shown), true)

  // Each public value is bound: a changed output, message, root or time fails.
  assert.equal(await verifyReputation({ ...shown, score: r.score + 1n }), false, 'a changed output')
  assert.equal(await verifyReputation({ ...shown, profile: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) }), false, 'a changed message')
  assert.equal(await verifyReputation({ ...shown, time: time + 1n }), false, 'a time the index did not sign')
  const otherKey = ed25519.utils.randomSecretKey()
  const forged = { index: ed25519.getPublicKey(otherKey), signature: ed25519.sign(signedBytes(r.root, time), otherKey) }
  assert.equal(await verifyReputation({ ...shown, ...forged }), true, 'any index may sign a root; the reader picks whom to trust')
  assert.equal(await verifyReputation({ ...shown, index: forged.index }), false, 'a root this index did not sign')
  const otherRoot = buildTree([...leaves, ...madeUp(1)]).root
  const otherSigned = { root: otherRoot, signature: ed25519.sign(signedBytes(otherRoot, time), indexKey) }
  assert.equal(await verifyReputation({ ...shown, ...otherSigned }), false, 'another root, even one the index signed')
})

test('the 256 bytes a record stores: the same proof back, and it verifies from them', async () => {
  const r = await proveReputation({ secret, labels, leaves, profile, artifacts })
  const { pi_a, pi_b, pi_c } = r.proof
  const bytes = proofBytes(r.proof)
  const order = [pi_a[0], pi_a[1], pi_b[0][1], pi_b[0][0], pi_b[1][1], pi_b[1][0], pi_c[0], pi_c[1]]
  assert.deepEqual(Buffer.from(bytes), Buffer.concat(order.map((s) => toBytes32(BigInt(s)))), "records/'s order")
  assert.deepEqual(proofFromBytes(bytes), { pi_a, pi_b, pi_c })
  const shown = { root: r.root, score: r.score, profile, index, time, signature }
  assert.equal(await verifyReputation({ ...shown, proof: bytes }), true)

  // A changed byte in any of the eight numbers fails, and so does a number with the modulus added,
  // which snarkjs would read as the same point.
  for (let i = 0; i < 8; i++) {
    const flipped = bytes.slice()
    flipped[i * 32 + 31] ^= 1
    assert.equal(await verifyReputation({ ...shown, proof: flipped }), false, `number ${i}, a byte changed`)
    const plusModulus = bytes.slice()
    plusModulus.set(toBytes32(fromBytes32(bytes.subarray(i * 32, i * 32 + 32)) + BN254_P), i * 32)
    assert.equal(await verifyReputation({ ...shown, proof: plusModulus }), false, `number ${i}, the modulus added`)
  }
  assert.equal(await verifyReputation({ ...shown, proof: bytes.subarray(0, 255) }), false, 'not 256 bytes')
})

// The circuit itself refuses: each case starts from a good input and breaks one thing, past the
// client's own checks.
const good = () => circuitInput({ secret, labels: labels.slice(0, 2), leaves, profile }).input as Record<string, any>
const refused = (input: Record<string, unknown>) => assert.rejects(groth16.fullProve(input, artifacts.wasm, artifacts.zkey))

test('the circuit refuses a wrong secret', async () => {
  const input = good()
  input.secret = stranger.scalar
  await refused(input)
})

test('the circuit refuses a leaf not in the tree', async () => {
  const input = good()
  input.scores[0] = 50n
  await refused(input)
})

test('the circuit refuses one profile counted twice', async () => {
  const input = good()
  for (const key of ['stamps', 'scopes', 'scores', 'counts', 'pathLengths', 'pathIndices', 'pathSiblings']) input[key][1] = input[key][0]
  await refused(input)
})

test('the circuit refuses a label shown with two profiles', async () => {
  const input = good()
  input.scope = input.scopes[0]
  await refused(input)
})

test('the client refuses what the circuit would', () => {
  assert.throws(() => circuitInput({ secret: stranger.secret, labels: ['tutoring/seller'], leaves, profile }), /no leaf/)
  assert.throws(() => circuitInput({ secret, labels: labels.slice(0, 2), leaves, profile, show: true }), /only one/)
  assert.throws(() => circuitInput({ secret, labels: [labels[0], labels[0]], leaves, profile }), /twice/)
  assert.throws(() => circuitInput({ secret, labels: Array.from({ length: 9 }, (_, i) => `x/${i}`), leaves, profile }), /one to 8/)
})

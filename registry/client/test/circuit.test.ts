// The circuit the registry is sealed against, tried where the earlier pin was weak: a path that is
// not 32 binary digits, and a secret on no list. These make real proofs, so they need the proving
// files, which `npm test` fetches first (`registry/artifacts/fetch.mjs`, hash-checked).
//
// Semaphore 4.13.0 takes the path as one number and splits it into 32 bits, each forced to be 0 or
// 1 (zk-kit's BinaryMerkleRoot 2.0.0). The 4.0.0 circuit pinned before took 32 values and forced
// none of them.

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Group } from '@semaphore-protocol/group'
import { groth16 } from 'snarkjs'

import {
  BN254_R,
  MAX_DEPTH,
  identityFrom,
  listRoot,
  marketStampOf,
  messageOf,
  proveStamp,
  scopeOf,
  stampOf,
  verifyStamp,
  type SnarkjsProof,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
const LABEL = 'tutoring/seller'
/** Any 32 bytes: the registry does not care how a main key was made. */
const profile = new Uint8Array(32).fill(7)
const secret = (name: string) => Buffer.from(`forest registry circuit test: ${name}`)

// A list of three stamps, and an outsider on no list.
const members = ['first', 'second', 'third'].map(secret)
const stamps = members.map((m) => stampOf(m))
const root = listRoot(stamps)
const outsider = secret('outsider')

/** The circuit's inputs for `who` at `index`, with that position's real siblings in the list. */
function inputsAt(who: Uint8Array, index: number): Record<string, unknown> {
  const path = new Group(stamps).generateMerkleProof(index)
  const siblings = [...path.siblings]
  while (siblings.length < MAX_DEPTH) siblings.push(0n)
  return {
    secret: identityFrom(who).secretScalar,
    merkleProofLength: path.siblings.length,
    merkleProofIndex: path.index,
    merkleProofSiblings: siblings,
    scope: scopeOf(LABEL),
    message: messageOf(profile),
  }
}

const prove = (input: Record<string, unknown>) =>
  groth16.fullProve(input, artifacts.wasm, artifacts.zkey) as Promise<{ proof: SnarkjsProof; publicSignals: string[] }>

test('a path index that is not 32 binary digits makes no proof', async () => {
  // The control: the second member's own inputs prove, and the proof holds for the list's root.
  const good = inputsAt(members[1], 1)
  const { proof, publicSignals } = await prove(good)
  assert.equal(BigInt(publicSignals[0]), root)
  assert.equal(await verifyStamp({ proof, root, marketStamp: marketStampOf(members[1], LABEL), label: LABEL, profile }), true)

  // The same inputs with an index no 32 bits can hold: one whose low 32 bits are the member's own,
  // and the largest field element. The circuit makes no witness, so there is nothing to prove.
  for (const index of [2n ** 32n + 1n, BN254_R - 1n]) {
    await assert.rejects(prove({ ...good, merkleProofIndex: index }), /Num2Bits/, `index ${index}`)
  }
})

test('a secret on no list cannot be proven, at any position', async () => {
  await assert.rejects(proveStamp({ secret: outsider, label: LABEL, profile, stamps, artifacts }), /not on the list/)

  // In each member's place, with that member's siblings: a proof comes out, but for another root,
  // and it does not hold for the list's.
  const marketStamp = marketStampOf(outsider, LABEL)
  for (let index = 0; index < stamps.length; index++) {
    const { proof, publicSignals } = await prove(inputsAt(outsider, index))
    assert.notEqual(BigInt(publicSignals[0]), root, `position ${index}`)
    assert.equal(await verifyStamp({ proof, root, marketStamp, label: LABEL, profile }), false, `position ${index}`)
  }
})

// The note: what an issuer signs, its signature, and the circuit's input, checked without proving.
// The proofs themselves are made and refused in registry/circuit's tests.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { keccak_256 } from '@noble/hashes/sha3.js'
import { poseidon4 } from 'poseidon-lite/poseidon4'

import { issuerSecret } from '../../../keys/src/index.ts'
import {
  BN254_R,
  fromBytes32,
  issuerKeyOf,
  marketStampOf,
  messageOf,
  noteHash,
  noteNumberOf,
  noteSigned,
  personInput,
  scopeOf,
  signNote,
  type Note,
} from '../src/index.ts'
import { PERSON_KEY } from '../src/person-key.ts'

const here = dirname(fileURLToPath(import.meta.url))
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(keysVectors.seed, 'hex')
const [issuerA] = keysVectors.issuers
const secret = (await issuerSecret(seed, issuerA.name)).secret

const issuerKey = new Uint8Array(32).fill(1)
const note: Note = {
  noteNumber: noteNumberOf(secret),
  embedding: new Uint8Array(Float32Array.from([0.25, -0.5, 0.125]).buffer),
  model: 'example-face-model/1',
  tier: 2n,
}
const signed = signNote(issuerKey, note)
const profile = new Uint8Array(32).fill(7)

test("the verification key is the circuit's committed one, value for value", () => {
  const committed = JSON.parse(readFileSync(join(here, '../../circuit/devnet/verification-key.json'), 'utf8'))
  assert.deepEqual(PERSON_KEY, committed)
  assert.equal(PERSON_KEY.nPublic, 6)
})

test("the note number is keys/'s, from the same 32 bytes", async () => {
  for (const issuer of keysVectors.issuers) {
    const s = await issuerSecret(seed, issuer.name)
    assert.equal(noteNumberOf(s.secret), s.noteNumber)
    assert.equal(noteNumberOf(s.secret).toString(), issuer.noteNumber)
  }
  assert.throws(() => noteNumberOf(secret.subarray(1)), /32 bytes/)
})

test('an issuer signs Poseidon(note number, keccak256(embedding) >> 8, keccak256(model) >> 8, tier)', () => {
  const hash = (bytes: Uint8Array) => fromBytes32(keccak_256(bytes)) >> 8n
  const want = poseidon4([note.noteNumber, hash(note.embedding), hash(new TextEncoder().encode(note.model)), note.tier])
  assert.equal(noteHash(note), want)
  assert.throws(() => noteHash({ ...note, tier: BN254_R }), /field elements/)
  assert.throws(() => noteHash({ ...note, noteNumber: -1n }), /field elements/)
})

test('a signed note checks; any change to it, its issuer or its signature does not', () => {
  assert.equal(noteSigned(signed), true)
  assert.deepEqual(signed.issuer, issuerKeyOf(issuerKey))
  const other = issuerKeyOf(new Uint8Array(32).fill(2))
  const cases: [string, typeof signed][] = [
    ['another note number', { ...signed, noteNumber: noteNumberOf(new Uint8Array(32).fill(9)) }],
    ['another embedding', { ...signed, embedding: new Uint8Array(signed.embedding.length) }],
    ['another model', { ...signed, model: 'example-face-model/2' }],
    ['another tier', { ...signed, tier: 3n }],
    ['another issuer', { ...signed, issuer: other }],
    ['another S', { ...signed, signature: { ...signed.signature, S: signed.signature.S + 1n } }],
    ['S out of range', { ...signed, signature: { ...signed.signature, S: BN254_R } }],
    ['R8 off the curve', { ...signed, signature: { ...signed.signature, R8: [1n, 1n] } }],
    ['a tier out of the field', { ...signed, tier: BN254_R + 2n }],
  ]
  for (const [what, n] of cases) assert.equal(noteSigned(n), false, what)
  assert.throws(() => signNote(new Uint8Array(31), note), /32 bytes/)
})

test("the circuit's input: the stamp is the market stamp a row sits at, and the public signals are in order", () => {
  const { input, publicSignals } = personInput({ secret, note: signed, label: 'tutoring/seller', profile })
  assert.equal(publicSignals[0], marketStampOf(secret, 'tutoring/seller'))
  assert.deepEqual(publicSignals.slice(1), [signed.issuer[0], signed.issuer[1], scopeOf('tutoring/seller'), messageOf(profile), 2n])
  assert.equal(input.secret, BigInt(issuerA.scalar))
  assert.notEqual(personInput({ secret, note: signed, label: 'tutoring/buyer', profile }).publicSignals[0], publicSignals[0])
})

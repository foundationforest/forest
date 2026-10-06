// The note and the person proof (../README.md, The note and the person proof).
//
// An issuer signs a note for each person: { note number, face embedding, model name, tier }. The
// note number is Poseidon of the person's secret for that issuer (`keys/`'s `issuerSecret`), so
// the issuer never learns the secret. The issuer signs Poseidon(note number, the embedding's hash,
// the model's hash, tier) with its EdDSA key on Baby Jubjub over Poseidon: zk-kit's signer,
// unchanged, which circomlib's verifier checks inside the circuit. The embedding and the model
// enter the signed message only as their hashes, `keccak256 >> 8` like the scope and the message,
// so the circuit never reads them.
//
// The person proves on the device, from the secret and the note: "this issuer signed a note for my
// note number; my stamp for this label is Poseidon(scope, secret); this proof is for this main
// key". Public: the issuer's key, the label, the main key, the stamp and the tier. The stamp is the
// number a registry row sits at.
//
// The program still takes the membership proof (`proof.ts`); it switches to this one next.

import type { PublicKey } from '@solana/web3.js'
import { derivePublicKey, deriveSecretScalar, signMessage, verifySignature } from '@zk-kit/eddsa-poseidon'
import { poseidon1 } from 'poseidon-lite/poseidon1'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon4 } from 'poseidon-lite/poseidon4'
import { groth16 } from 'snarkjs'

import type { SnarkjsProof } from './compress.ts'
import { fieldHash, fromBytes32, isFieldElement, messageOf, scopeOf } from './field.ts'
import { PERSON_KEY } from './person-key.ts'
import type { Artifacts } from './proof.ts'

/** An issuer's key: its EdDSA public key, a point on Baby Jubjub, as two field elements. */
export type IssuerKey = [bigint, bigint]

export type Note = {
  /** The person's note number for this issuer: `keys/`'s `issuerSecret(seed, name).noteNumber`. */
  noteNumber: bigint
  /** The face embedding, in the bytes the model gives. Only its hash is signed. */
  embedding: Uint8Array
  /** The model that made the embedding. Only its hash is signed. */
  model: string
  /** The tier the issuer gives the person. Any field element; what it means is the issuer's. */
  tier: bigint
}

/** An EdDSA signature on Baby Jubjub, as zk-kit writes it. */
export type NoteSignature = { R8: [bigint, bigint]; S: bigint }

/** A note, the key of the issuer that signed it, and the signature. The person keeps it. */
export type SignedNote = Note & { issuer: IssuerKey; signature: NoteSignature }

export type PersonProof = {
  /** The stamp for this label, `Poseidon(scope, secret)`: the number a registry row sits at. */
  stamp: bigint
  issuer: IssuerKey
  scope: bigint
  message: bigint
  tier: bigint
  /** The proof as snarkjs wrote it. */
  proof: SnarkjsProof
  /** In the circuit's order: stamp, issuer x, issuer y, scope, message, tier. */
  publicSignals: string[]
}

/** The secret as the circuit takes it, from the 32 bytes `keys/`'s `issuerSecret` returns. */
function scalarOf(secret: Uint8Array): bigint {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('an issuer secret is 32 bytes')
  return deriveSecretScalar(secret)
}

/** The person's note number for one issuer: Poseidon of the secret. What the issuer signs in the note. */
export function noteNumberOf(secret: Uint8Array): bigint {
  return poseidon1([scalarOf(secret)])
}

/** What an issuer signs: Poseidon(note number, keccak256(embedding) >> 8, keccak256(model) >> 8, tier). */
export function noteHash(note: Note): bigint {
  if (!isFieldElement(note.noteNumber) || !isFieldElement(note.tier)) throw new RangeError('a note number and a tier are field elements')
  if (!(note.embedding instanceof Uint8Array) || typeof note.model !== 'string') throw new TypeError('an embedding is bytes and a model is text')
  // The registry's hash with no namespace: the place in the note keeps the two apart.
  return poseidon4([note.noteNumber, fieldHash('', note.embedding), fieldHash('', note.model), note.tier])
}

/** The issuer's key, from its 32-byte private key. */
export function issuerKeyOf(privateKey: Uint8Array): IssuerKey {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) throw new Error("an issuer's private key is 32 bytes")
  return derivePublicKey(privateKey)
}

/** For an issuer: sign a note with its 32-byte private key. */
export function signNote(privateKey: Uint8Array, note: Note): SignedNote {
  const issuer = issuerKeyOf(privateKey)
  return { ...note, issuer, signature: signMessage(privateKey, noteHash(note)) }
}

/** Did the note's issuer sign it? zk-kit's check, the same equation the circuit checks. */
export function noteSigned(note: SignedNote): boolean {
  try {
    return verifySignature(noteHash(note), note.signature, note.issuer)
  } catch {
    return false
  }
}

/**
 * The circuit's input, and the public signals it must give. `provePerson` proves it; it is
 * exported for a caller that drives snarkjs itself.
 */
export function personInput(input: {
  /** The 32 bytes `keys/`'s `issuerSecret(seed, name)` returns. */
  secret: Uint8Array
  note: SignedNote
  label: string
  /** The main key the proof is for. The proof names it and counts for it alone. */
  profile: PublicKey | Uint8Array
}): { input: Record<string, unknown>; publicSignals: bigint[] } {
  const { note } = input
  const secret = scalarOf(input.secret)
  const scope = scopeOf(input.label)
  const message = messageOf(input.profile)
  const stamp = poseidon2([scope, secret])
  return {
    input: {
      secret,
      embedding: fieldHash('', note.embedding),
      model: fieldHash('', note.model),
      R8x: note.signature.R8[0],
      R8y: note.signature.R8[1],
      S: note.signature.S,
      issuerX: note.issuer[0],
      issuerY: note.issuer[1],
      scope,
      message,
      tier: note.tier,
    },
    publicSignals: [stamp, note.issuer[0], note.issuer[1], scope, message, note.tier],
  }
}

/**
 * Make the person proof, on the device. Refuses a note for another secret, or one its issuer did
 * not sign, before proving anything.
 */
export async function provePerson(input: Parameters<typeof personInput>[0] & { artifacts: Artifacts }): Promise<PersonProof> {
  if (input.note.noteNumber !== noteNumberOf(input.secret)) throw new Error('this note is not for this secret')
  if (!noteSigned(input.note)) throw new Error("the issuer's signature is not on this note")
  const { input: signals, publicSignals: want } = personInput(input)
  const { proof, publicSignals } = (await groth16.fullProve(signals, input.artifacts.wasm, input.artifacts.zkey)) as {
    proof: SnarkjsProof
    publicSignals: string[]
  }
  // The circuit's order: stamp, issuer x, issuer y, scope, message, tier. Checked so a change in
  // the circuit or the setup files shows up here, and not as a proof every reader refuses.
  if (publicSignals.length !== 6 || publicSignals.some((s, i) => BigInt(s) !== want[i])) {
    throw new Error('the proof carries other public signals than the ones asked for')
  }
  const [stamp, x, y, scope, message, tier] = want
  return { stamp, issuer: [x, y], scope, message, tier, proof, publicSignals }
}

/**
 * Does this proof hold: did this issuer sign a note with this tier for whoever holds the secret
 * behind this stamp, for this label and this main key? Every public value must be a field element,
 * the scope and the message are derived from the label and the main key, and the proof is checked
 * with the committed verification key. Which issuers to trust is the reader's choice. Anything
 * that is not a good proof for these inputs is false.
 */
export async function verifyPerson(input: {
  /** The proof as snarkjs writes it: `provePerson`'s `proof`. */
  proof: SnarkjsProof
  issuer: IssuerKey
  label: string
  /** The main key the proof is for. */
  profile: PublicKey | Uint8Array
  stamp: bigint | Uint8Array
  tier: bigint
}): Promise<boolean> {
  try {
    const stamp = typeof input.stamp === 'bigint' ? input.stamp : fromBytes32(input.stamp)
    const values = [stamp, input.issuer[0], input.issuer[1], input.tier]
    if (input.issuer.length !== 2 || !values.every((v) => typeof v === 'bigint' && isFieldElement(v))) return false
    const publicSignals = [stamp, input.issuer[0], input.issuer[1], scopeOf(input.label), messageOf(input.profile), input.tier].map(String)
    return await groth16.verify(PERSON_KEY, publicSignals, input.proof)
  } catch {
    return false
  }
}

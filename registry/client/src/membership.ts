// Memberships: more issuers for a line, kept off chain.
//
// A line holds the root of one issuer's list and never changes. Every other issuer that vouches for
// the same human is one record in the profile's folder, at `proof/<id>`, of the `membership` kind
// (records/ defines no shape for it): the issuer's key, and a Semaphore proof for the line's own
// label and profile against that issuer's list, with the code and the root it carries. The proof is
// the same circuit, the same scope and message and the same code as the line's; only the list
// differs.
//
// A reader checks a record against the profile's line and the roots that issuer published, with the
// verification key the program is sealed with (`registry/artifacts/semaphore-32.json`). Nothing here
// writes to the chain, and nothing here checks an issuer's signature on its roots: which issuers a
// reader trusts, and how it got their roots, are the reader's.

import type { Identity } from '@semaphore-protocol/identity'
import type { PublicKey } from '@solana/web3.js'
import { packGroth16Proof, unpackGroth16Proof } from '@zk-kit/utils/proof-packing'
import { groth16 } from 'snarkjs'

import { BN254_P, fromBytes32, isFieldElement, messageOf, scopeOf, toBytes32 } from './field.ts'
import type { Line } from './program.ts'
import { proveMembership, type Artifacts } from './proof.ts'

/** The body of a `proof/<id>` record of the membership kind. */
export type Membership = {
  /** The issuer's key, as a did:key: the key its published roots are signed with. */
  issuer: string
  membership: {
    /** The line's label. */
    label: string
    /** The line's code, 64 lowercase hex. */
    code: string
    /** The root of the issuer's list the proof was made against, 64 lowercase hex. */
    root: string
    /** The Semaphore proof: its eight coordinates in Semaphore's packed order, each 64 lowercase hex. */
    proof: string[]
  }
  createdAt: string
}

const hex32 = (v: bigint) => Buffer.from(toBytes32(v)).toString('hex')

function fromHex32(text: unknown): bigint | null {
  return typeof text === 'string' && /^[0-9a-f]{64}$/.test(text) ? BigInt(`0x${text}`) : null
}

/**
 * A membership record for a line: the person proves they are on another issuer's list, for the
 * line's label and profile. Prove against the issuer's newest list. The record is then published in
 * the profile's folder like any other; the profile key signs it there, not here.
 */
export async function makeMembership(input: {
  /** The person's 32-byte identity secret, or the identity itself. */
  secret: Uint8Array | Identity
  /** The line's label. */
  label: string
  /** The line's profile key. */
  profile: PublicKey | Uint8Array
  /** The issuer's list: every commitment in it, in the order the issuer published them. */
  commitments: bigint[]
  /** The issuer's key, as a did:key. */
  issuer: string
  artifacts: Artifacts
  createdAt?: string
}): Promise<Membership> {
  const p = await proveMembership(input)
  return {
    issuer: input.issuer,
    membership: {
      label: input.label,
      code: hex32(p.code),
      root: hex32(p.root),
      proof: packGroth16Proof(p.raw as never).map((v: string) => hex32(BigInt(v))),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

/**
 * Does this record prove that the human behind `line` is on this issuer's list? True only if:
 * - the record names this issuer;
 * - the line is this profile's (the profile whose folder holds the record);
 * - the record's label and code are the line's;
 * - its root is one of the roots this issuer published;
 * - and the proof verifies for that root, the code, this profile and the label, against the
 *   verification key the program is sealed with.
 *
 * The caller has already checked that the roots are the issuer's own (signed by its key) and read
 * the line from the chain (`fetchLine` at the record's code). In Node, snarkjs keeps its worker
 * threads after verifying, as after proving: a script exits with `process.exit` when done.
 */
export async function verifyMembership(
  record: Membership,
  input: {
    /** The profile whose folder holds the record: its 32-byte key. */
    profile: PublicKey | Uint8Array
    /** The profile's line under the record's label. */
    line: Line
    /** The issuer the reader checks against: its did:key and the roots it published. */
    issuer: { key: string; roots: (bigint | Uint8Array)[] }
    /** `registry/artifacts/semaphore-32.json`, parsed. */
    verificationKey: unknown
  },
): Promise<boolean> {
  const m = record?.membership
  if (!m || record.issuer !== input.issuer.key) return false
  const profile = input.profile instanceof Uint8Array ? input.profile : input.profile.toBytes()
  if (profile.length !== 32 || !input.line.profile.toBytes().every((b, i) => b === profile[i])) return false
  if (m.label !== input.line.label) return false

  const code = fromHex32(m.code)
  const root = fromHex32(m.root)
  if (code === null || root === null || code !== fromBytes32(input.line.code)) return false
  if (!input.issuer.roots.some((r) => (typeof r === 'bigint' ? r : fromBytes32(r)) === root)) return false
  if (!isFieldElement(root) || !isFieldElement(code)) return false

  // One spelling per proof: eight coordinates, each below the base field's modulus.
  if (!Array.isArray(m.proof) || m.proof.length !== 8) return false
  const points = m.proof.map(fromHex32)
  if (points.some((x) => x === null || x >= BN254_P)) return false

  const signals = [root, code, messageOf(profile), scopeOf(m.label)].map(String)
  try {
    return await groth16.verify(input.verificationKey, signals, unpackGroth16Proof(points.map(String) as never))
  } catch {
    return false
  }
}

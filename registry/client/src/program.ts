// The wire format: the address, the discriminators, the instruction bytes and the line's bytes.
//
// Everything here is sealed with the program. These bytes are what clients and indexes read and
// write forever, so this file is written out by hand rather than generated: a reader can check it
// against `registry/program/src/` line by line, and the Rust tests encode the same bytes
// independently against the committed wire vectors, so a drift on either side fails a test.

import { sha256 } from '@noble/hashes/sha2.js'
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js'

import { toBytes32 } from './field.ts'
import type { CompressedProof } from './compress.ts'

/**
 * The program id in the source: a placeholder nobody holds a key for. A deploy substitutes its own
 * (devnet: `registry/devnet/devnet.json`); every builder takes `programId`.
 */
export const PROGRAM_ID = new PublicKey('FoRBadgeLineFreeNoFeeNoAdmin1111111111111111')

/** The circuit's depth, sealed with the verification key. */
export const MAX_DEPTH = 32
/** The longest label, in bytes. */
export const MAX_LABEL = 128
/** The most roots one line holds. */
export const MAX_ROOTS = 16

export const CODE_SEED = new TextEncoder().encode('code')

/** Anchor's discriminator: the first eight bytes of `sha256("<namespace>:<name>")`. */
export function discriminator(namespace: string, name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8)
}

export const LINE_DISCRIMINATOR = discriminator('account', 'Line')

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function readU32le(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true)
}

function readI64le(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(at, true)
}

function concat(parts: Uint8Array[]): Buffer {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return Buffer.from(out)
}

const bytes32 = (v: bigint | Uint8Array): Uint8Array => {
  const b = typeof v === 'bigint' ? toBytes32(v) : v
  if (b.length !== 32) throw new RangeError('expected 32 bytes')
  return b
}

const keyBytes = (k: PublicKey | Uint8Array): Uint8Array => bytes32(k instanceof PublicKey ? k.toBytes() : k)

/** A line's size in bytes, discriminator included, for a label of `labelBytes` bytes and `roots` roots. */
export function lineSpace(labelBytes: number, roots: number): number {
  return 8 + 32 + 32 + 32 + 8 + 1 + 4 + labelBytes + 4 + 32 * roots
}

/** A line's address: derived from its code, so one code has at most one line. */
export function lineAddress(code: bigint | Uint8Array, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(CODE_SEED), Buffer.from(bytes32(code))], programId)[0]
}

/** One proof on the wire: the list's root, then the compressed points. 160 bytes. */
export type ProofOnWire = { root: bigint | Uint8Array; proof: CompressedProof }

function proofBytes(p: ProofOnWire): Uint8Array {
  if (p.proof.a.length !== 32 || p.proof.b.length !== 64 || p.proof.c.length !== 32) {
    throw new RangeError('a compressed proof is 32, 64 and 32 bytes')
  }
  return concat([bytes32(p.root), p.proof.a, p.proof.b, p.proof.c])
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true })

/**
 * Write a line. Only the payer signs: it pays the line's deposit and is recorded for refunds. The
 * profile key signs nothing; the proof names it.
 *
 * Data: discriminator, profile (32), label (u32 length, UTF-8), code (32), proof (root 32, a 32,
 * b 64, c 32). Accounts: the line, the payer, the system program.
 */
export function registerIx(args: {
  profile: PublicKey | Uint8Array
  label: string
  code: bigint | Uint8Array
  proof: ProofOnWire
  payer: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const label = new TextEncoder().encode(args.label)
  if (label.length > MAX_LABEL) throw new RangeError(`a label is at most ${MAX_LABEL} bytes`)
  return new TransactionInstruction({
    programId,
    keys: [rw(lineAddress(args.code, programId)), rw(args.payer, true), ro(SystemProgram.programId)],
    data: concat([
      discriminator('global', 'register'),
      keyBytes(args.profile),
      u32le(label.length),
      label,
      bytes32(args.code),
      proofBytes(args.proof),
    ]),
  })
}

/**
 * Append one root to the line at `code`. Only the payer signs: it pays for the line's 32 new bytes.
 *
 * Data: discriminator, code (32), proof (160). Accounts: the line, the payer, the system program.
 */
export function addProofIx(args: {
  code: bigint | Uint8Array
  proof: ProofOnWire
  payer: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(lineAddress(args.code, programId)), rw(args.payer, true), ro(SystemProgram.programId)],
    data: concat([discriminator('global', 'add_proof'), bytes32(args.code), proofBytes(args.proof)]),
  })
}

/**
 * Move what the line holds above its rent-exempt minimum to `payer`, which must be the payer the
 * line records. Nobody signs but whoever sends the transaction.
 *
 * Data: discriminator, code (32). Accounts: the line, the recorded payer.
 */
export function refundIx(args: { code: bigint | Uint8Array; payer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(lineAddress(args.code, programId)), rw(args.payer)],
    data: concat([discriminator('global', 'refund'), bytes32(args.code)]),
  })
}

export type Line = {
  /** The profile's ed25519 key: its did:key name and its Solana wallet. */
  profile: PublicKey
  /** The proof's nullifier: one per human per label. */
  code: Uint8Array
  /** Who paid the deposit; refunds go here. */
  payer: PublicKey
  /** When the line was written, unix seconds. */
  time: bigint
  bump: number
  label: string
  /** The issuers' list roots the proofs were made against, in order, each once. Checked by nobody but readers. */
  roots: Uint8Array[]
}

/**
 * A line's bytes, read back. Offsets after the discriminator: profile 8, code 40, payer 72, time
 * 104 (i64), bump 112, label 113 (u32 length then UTF-8), then the roots (u32 count then 32 each).
 * Refuses anything that is not exactly a line.
 */
export function decodeLine(data: Uint8Array): Line {
  if (data.length < lineSpace(0, 0) || !LINE_DISCRIMINATOR.every((v, i) => data[i] === v)) {
    throw new RangeError('not a line')
  }
  const labelLength = readU32le(data, 113)
  if (labelLength > MAX_LABEL || data.length < lineSpace(labelLength, 0)) throw new RangeError('not a line: label')
  const label = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(117, 117 + labelLength))
  const count = readU32le(data, 117 + labelLength)
  if (count > MAX_ROOTS || data.length !== lineSpace(labelLength, count)) throw new RangeError('not a line: roots')
  const roots: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const at = 121 + labelLength + 32 * i
    roots.push(data.slice(at, at + 32))
  }
  return {
    profile: new PublicKey(data.subarray(8, 40)),
    code: data.slice(40, 72),
    payer: new PublicKey(data.subarray(72, 104)),
    time: readI64le(data, 104),
    bump: data[112],
    label,
    roots,
  }
}

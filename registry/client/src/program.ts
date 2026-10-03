// The wire format: the address, the discriminators, the instruction bytes and the row's bytes.
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
export const PROGRAM_ID = new PublicKey('FoRRegistryRowsFreeNoFeeNoAdmin1111111111111')

/** The circuit's depth, sealed with the verification key. */
export const MAX_DEPTH = 32
/** The longest label, in bytes. */
export const MAX_LABEL = 128

export const ROW_SEED = new TextEncoder().encode('row')

/** Anchor's discriminator: the first eight bytes of `sha256("<namespace>:<name>")`. */
export function discriminator(namespace: string, name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8)
}

export const ROW_DISCRIMINATOR = discriminator('account', 'Row')

/** Where each field of a row starts, discriminator included. The label is last. */
export const ROW_OFFSET = { profile: 8, issuer: 40, root: 72, issuerSignature: 104, payer: 168, bump: 200, label: 201 } as const

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function readU32le(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true)
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

export const keyBytes = (k: PublicKey | Uint8Array): Uint8Array => bytes32(k instanceof PublicKey ? k.toBytes() : k)

/** A row's size in bytes, discriminator included, for a label of `labelBytes` bytes. It never changes. */
export function rowSpace(labelBytes: number): number {
  return ROW_OFFSET.label + 4 + labelBytes
}

/** A row's address: derived from its market stamp, so one market stamp has at most one row. */
export function rowAddress(marketStamp: bigint | Uint8Array, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(ROW_SEED), Buffer.from(bytes32(marketStamp))], programId)[0]
}

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false })
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true })

/**
 * Write a row. The main key signs; the payer signs, pays the row's deposit and is recorded for
 * refunds. They may be one key.
 *
 * Data: discriminator, market stamp (32), issuer (32), root (32), issuer signature (64), proof
 * (a 32, b 64, c 32), label (u32 length, UTF-8). Accounts: the row, the profile, the payer, the
 * system program.
 */
export function registerIx(args: {
  profile: PublicKey
  label: string
  marketStamp: bigint | Uint8Array
  issuer: PublicKey | Uint8Array
  root: bigint | Uint8Array
  issuerSignature: Uint8Array
  proof: CompressedProof
  payer: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const label = new TextEncoder().encode(args.label)
  if (label.length > MAX_LABEL) throw new RangeError(`a label is at most ${MAX_LABEL} bytes`)
  if (args.issuerSignature.length !== 64) throw new RangeError('an issuer signature is 64 bytes')
  const p = args.proof
  if (p.a.length !== 32 || p.b.length !== 64 || p.c.length !== 32) throw new RangeError('a compressed proof is 32, 64 and 32 bytes')
  return new TransactionInstruction({
    programId,
    keys: [
      rw(rowAddress(args.marketStamp, programId)),
      ro(args.profile, true),
      rw(args.payer, true),
      ro(SystemProgram.programId),
    ],
    data: concat([
      discriminator('global', 'register'),
      bytes32(args.marketStamp),
      keyBytes(args.issuer),
      bytes32(args.root),
      args.issuerSignature,
      p.a,
      p.b,
      p.c,
      u32le(label.length),
      label,
    ]),
  })
}

/**
 * Move what the row holds above its rent-exempt minimum to `payer`, which must be the payer the
 * row records. Nobody signs but whoever sends the transaction.
 *
 * Data: the discriminator alone. Accounts: the row, the recorded payer.
 */
export function refundIx(args: { row: PublicKey; payer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [rw(args.row), rw(args.payer)],
    data: Buffer.from(discriminator('global', 'refund')),
  })
}

export type Row = {
  /** The profile's ed25519 key, which signed `register`. */
  profile: PublicKey
  /** The issuer's ed25519 key, as the row was sent. */
  issuer: PublicKey
  /** The root of the issuer's list the proof was made against. */
  root: Uint8Array
  /** The issuer's signature over the root, as sent; check it with `issuerSigned`. */
  issuerSignature: Uint8Array
  /** Who paid the deposit; refunds go here. */
  payer: PublicKey
  bump: number
  label: string
}

/** A row's bytes, read back. Refuses anything that is not exactly a row. */
export function decodeRow(data: Uint8Array): Row {
  if (data.length < rowSpace(0) || !ROW_DISCRIMINATOR.every((v, i) => data[i] === v)) throw new RangeError('not a row')
  const labelLength = readU32le(data, ROW_OFFSET.label)
  if (labelLength > MAX_LABEL || data.length !== rowSpace(labelLength)) throw new RangeError('not a row: label')
  const o = ROW_OFFSET
  return {
    profile: new PublicKey(data.subarray(o.profile, o.profile + 32)),
    issuer: new PublicKey(data.subarray(o.issuer, o.issuer + 32)),
    root: data.slice(o.root, o.root + 32),
    issuerSignature: data.slice(o.issuerSignature, o.issuerSignature + 64),
    payer: new PublicKey(data.subarray(o.payer, o.payer + 32)),
    bump: data[o.bump],
    label: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(o.label + 4)),
  }
}

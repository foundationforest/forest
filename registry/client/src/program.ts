// The wire format: addresses, discriminators, instruction bytes and account bytes.
//
// Everything here is sealed with the program. These bytes are what clients and indexes read and
// write forever, so this file is written out by hand rather than generated: a reader can check it
// against `registry/program/src/lib.rs` line by line, and the Rust tests encode the same bytes
// independently, so a drift on either side fails a test.

import { sha256 } from '@noble/hashes/sha2.js'
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js'

import { toBytes32 } from './field.ts'
import type { CompressedProof } from './compress.ts'

export const PROGRAM_ID = new PublicKey('FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

/** 0.25 in base units, at the six decimals every accepted mint must carry. */
export const REGISTRATION_FEE = 250_000n
export const TOKEN_DECIMALS = 6
/** The circuit's depth, sealed with the verification key. */
export const MAX_DEPTH = 32
/** How many recent roots a list keeps. */
export const ROOT_HISTORY = 128

export const CONFIG_SEED = new TextEncoder().encode('config')
export const LIST_SEED = new TextEncoder().encode('list')
export const CODE_TREE_SEED = new TextEncoder().encode('code-tree')
export const CODE_SEED = new TextEncoder().encode('code')

/** Anchor's discriminator: the first eight bytes of `sha256("<namespace>:<name>")`. */
export function discriminator(namespace: string, name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8)
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function readU32le(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true)
}

function readU64le(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true)
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

/** Borsh string: a four-byte little-endian length, then the UTF-8 bytes. */
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s)
  return concat([u32le(bytes.length), bytes])
}

export function configAddress(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0]
}

export function listAddress(index: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LIST_SEED), Buffer.from(u32le(index))],
    programId,
  )[0]
}

export function codeTreeAddress(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(CODE_TREE_SEED)], programId)[0]
}

export function usedCodeAddress(code: bigint | Uint8Array, programId: PublicKey = PROGRAM_ID): PublicKey {
  const bytes = typeof code === 'bigint' ? toBytes32(code) : code
  return PublicKey.findProgramAddressSync([Buffer.from(CODE_SEED), Buffer.from(bytes)], programId)[0]
}

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false })
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true })

export function initIx(args: {
  payer: PublicKey
  treasuryKey: PublicKey
  treasury: PublicKey
  usdcMint: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [
      rw(configAddress(programId)),
      rw(listAddress(0, programId)),
      rw(codeTreeAddress(programId)),
      rw(args.payer, true),
      ro(args.treasuryKey, true),
      ro(args.usdcMint),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'init'), args.treasury.toBytes()]),
  })
}

export function openListIx(args: {
  payer: PublicKey
  treasuryKey: PublicKey
  newIndex: number
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [
      rw(configAddress(programId)),
      rw(listAddress(args.newIndex, programId)),
      rw(args.payer, true),
      ro(args.treasuryKey, true),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'open_list')]),
  })
}

function issuerIx(
  name: 'add_issuer' | 'remove_issuer',
  args: { treasuryKey: PublicKey; listIndex: number; issuer: PublicKey; programId?: PublicKey },
): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [
      ro(configAddress(programId)),
      rw(listAddress(args.listIndex, programId)),
      ro(args.treasuryKey, true),
    ],
    data: concat([discriminator('global', name), u32le(args.listIndex), args.issuer.toBytes()]),
  })
}

export const addIssuerIx = (args: Parameters<typeof issuerIx>[1]) => issuerIx('add_issuer', args)
export const removeIssuerIx = (args: Parameters<typeof issuerIx>[1]) => issuerIx('remove_issuer', args)

export function insertIdentityIx(args: {
  issuer: PublicKey
  listIndex: number
  commitment: bigint | Uint8Array
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const commitment =
    typeof args.commitment === 'bigint' ? toBytes32(args.commitment) : args.commitment
  return new TransactionInstruction({
    programId,
    keys: [rw(listAddress(args.listIndex, programId)), ro(args.issuer, true)],
    data: concat([
      discriminator('global', 'insert_identity'),
      u32le(args.listIndex),
      commitment,
    ]),
  })
}

export function addTokenIx(args: {
  treasuryKey: PublicKey
  mint: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(configAddress(programId)), ro(args.treasuryKey, true), ro(args.mint)],
    data: concat([discriminator('global', 'add_token')]),
  })
}

export type SweepTarget =
  | { kind: 'config' }
  | { kind: 'codeTree' }
  | { kind: 'list'; index: number }
  | { kind: 'code'; code: bigint | Uint8Array }

function sweepTargetBytes(target: SweepTarget): Uint8Array {
  switch (target.kind) {
    case 'config':
      return new Uint8Array([0])
    case 'codeTree':
      return new Uint8Array([1])
    case 'list':
      return concat([new Uint8Array([2]), u32le(target.index)])
    case 'code':
      return concat([
        new Uint8Array([3]),
        typeof target.code === 'bigint' ? toBytes32(target.code) : target.code,
      ])
  }
}

export function sweepTargetAddress(target: SweepTarget, programId: PublicKey = PROGRAM_ID): PublicKey {
  switch (target.kind) {
    case 'config':
      return configAddress(programId)
    case 'codeTree':
      return codeTreeAddress(programId)
    case 'list':
      return listAddress(target.index, programId)
    case 'code':
      return usedCodeAddress(target.code, programId)
  }
}

export function sweepRentIx(args: {
  target: SweepTarget
  treasury: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [
      ro(configAddress(programId)),
      rw(sweepTargetAddress(args.target, programId)),
      rw(args.treasury),
    ],
    data: concat([discriminator('global', 'sweep_rent'), sweepTargetBytes(args.target)]),
  })
}

export type RegisterAccounts = {
  payer: PublicKey
  profileWallet: PublicKey
  profileTokens: PublicKey
  treasuryTokens: PublicKey
}

export function registerIx(args: {
  market: string
  did: string
  listIndex: number
  root: bigint | Uint8Array
  code: bigint | Uint8Array
  proof: CompressedProof
  accounts: RegisterAccounts
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const root = typeof args.root === 'bigint' ? toBytes32(args.root) : args.root
  const code = typeof args.code === 'bigint' ? toBytes32(args.code) : args.code
  return new TransactionInstruction({
    programId,
    keys: [
      ro(configAddress(programId)),
      ro(listAddress(args.listIndex, programId)),
      rw(codeTreeAddress(programId)),
      rw(usedCodeAddress(code, programId)),
      rw(args.accounts.payer, true),
      ro(args.accounts.profileWallet, true),
      rw(args.accounts.profileTokens),
      rw(args.accounts.treasuryTokens),
      ro(TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: concat([
      discriminator('global', 'register'),
      borshString(args.market),
      borshString(args.did),
      u32le(args.listIndex),
      root,
      code,
      args.proof.a,
      args.proof.b,
      args.proof.c,
    ]),
  })
}

export type ConfigAccount = {
  treasury: PublicKey
  treasuryKey: PublicKey
  mints: PublicKey[]
  tokenDecimals: number
  listCount: number
  bump: number
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const b = data.subarray(8)
  const mintCount = b[576]
  const mints: PublicKey[] = []
  for (let i = 0; i < mintCount; i++) mints.push(new PublicKey(b.subarray(64 + i * 32, 96 + i * 32)))
  return {
    treasury: new PublicKey(b.subarray(0, 32)),
    treasuryKey: new PublicKey(b.subarray(32, 64)),
    mints,
    tokenDecimals: b[577],
    listCount: readU32le(b, 578),
    bump: b[582],
  }
}

export type IdentityListAccount = {
  leafCount: bigint
  index: number
  bump: number
  root: Uint8Array
  roots: Uint8Array[]
  issuers: PublicKey[]
}

export function decodeIdentityList(data: Uint8Array): IdentityListAccount {
  const b = data.subarray(8)
  const issuerCount = b[12]
  const issuers: PublicKey[] = []
  for (let i = 0; i < issuerCount; i++) {
    issuers.push(new PublicKey(b.subarray(5200 + i * 32, 5232 + i * 32)))
  }
  const roots: Uint8Array[] = []
  for (let i = 0; i < ROOT_HISTORY; i++) roots.push(b.subarray(1104 + i * 32, 1136 + i * 32))
  return {
    leafCount: readU64le(b, 0),
    index: readU32le(b, 8),
    bump: b[13],
    root: b.subarray(16, 48),
    roots,
    issuers,
  }
}

export type CodeTreeAccount = { count: bigint; bump: number; root: Uint8Array }

export function decodeCodeTree(data: Uint8Array): CodeTreeAccount {
  const b = data.subarray(8)
  return { count: readU64le(b, 0), bump: b[8], root: b.subarray(16, 48) }
}

export type RegisteredEvent = {
  market: string
  did: string
  code: Uint8Array
  listIndex: number
}

/**
 * The one entry per registration, read back out of the transaction log. Anchor writes an event as
 * a `Program data:` line whose bytes are the event's discriminator followed by its fields.
 */
export function decodeRegisteredEvents(logs: string[]): RegisteredEvent[] {
  const want = discriminator('event', 'Registered')
  const out: RegisteredEvent[] = []
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue
    const bytes = new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64'))
    if (bytes.length < 8 || !want.every((v, i) => bytes[i] === v)) continue
    let at = 8
    const readString = () => {
      const len = readU32le(bytes, at)
      at += 4
      const s = new TextDecoder().decode(bytes.subarray(at, at + len))
      at += len
      return s
    }
    const market = readString()
    const did = readString()
    const code = bytes.slice(at, at + 32)
    at += 32
    out.push({ market, did, code, listIndex: readU32le(bytes, at) })
  }
  return out
}

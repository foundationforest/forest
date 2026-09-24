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

/**
 * The treasury the program starts with. `init` writes this constant whoever calls it;
 * `propose_treasury` then `accept_treasury` move it later, in two steps. PLACEHOLDER: derived
 * from the public seed below so tests can sign for it; replaced with the charter's treasury
 * address before the first deploy.
 */
export const TREASURY_PLACEHOLDER_SEED = new TextEncoder().encode('REPLACE-BEFORE-DEPLOY-treasury-0')
export const TREASURY = new PublicKey('F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s')
/**
 * The foundation's issuer key: list 0's owner and its first insert key, written at `init`. Every
 * other list is opened by anyone, who owns it. PLACEHOLDER: derived from the public seed below so
 * tests can sign for it; replaced with the foundation's issuer key before the first deploy.
 */
export const FOUNDATION_ISSUER_PLACEHOLDER_SEED = new TextEncoder().encode('REPLACE-BEFORE-DEPLOY-issuer-000')
export const FOUNDATION_ISSUER = new PublicKey('H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS')
/** USDC, `mints[0]` forever. The program names the mainnet address; a devnet build names the other. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')

/**
 * USDC's fee: 0.25 at six decimals, `fees[0]` forever. Every other accepted mint's fee is the amount
 * the treasury set at `add_token`, in that mint's own base units; read it from the config.
 */
export const USDC_FEE = 250_000n
export const USDC_DECIMALS = 6
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

function u64le(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new RangeError('not a u64')
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
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

/**
 * `init` carries nothing that chooses anything: no treasury argument, no treasury signer. The
 * mint account is the one at the program's constant (`usdcMint` only exists for a devnet build).
 */
export function initIx(args: {
  payer: PublicKey
  usdcMint?: PublicKey
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
      ro(args.usdcMint ?? USDC_MINT),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'init')]),
  })
}

/**
 * Step one of a handover: the current treasury signs and `newTreasury` is recorded as pending.
 * Nothing moves until that key signs `acceptTreasuryIx`. `null` clears a pending proposal. Borsh
 * writes an `Option<Pubkey>` as one tag byte, `0x00` for none or `0x01` followed by the key.
 */
export function proposeTreasuryIx(args: {
  treasury: PublicKey
  newTreasury: PublicKey | null
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const option =
    args.newTreasury === null
      ? new Uint8Array([0])
      : concat([new Uint8Array([1]), args.newTreasury.toBytes()])
  return new TransactionInstruction({
    programId,
    keys: [rw(configAddress(programId)), ro(args.treasury, true)],
    data: concat([discriminator('global', 'propose_treasury'), option]),
  })
}

/** Step two: the pending key signs, and only then does everything the treasury is move to it. */
export function acceptTreasuryIx(args: {
  pending: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(configAddress(programId)), ro(args.pending, true)],
    data: concat([discriminator('global', 'accept_treasury')]),
  })
}

/**
 * Open the next list. Anyone may: `payer` pays its rent, and `owner` signs and is recorded as the
 * list's owner and its first insert key (they may be one key). `newIndex` is the config's
 * `listCount` as read just before. The treasury has no say.
 */
export function openListIx(args: {
  payer: PublicKey
  owner: PublicKey
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
      ro(args.owner, true),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'open_list')]),
  })
}

function issuerIx(
  name: 'add_issuer' | 'remove_issuer',
  args: { owner: PublicKey; listIndex: number; issuer: PublicKey; programId?: PublicKey },
): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(listAddress(args.listIndex, programId)), ro(args.owner, true)],
    data: concat([discriminator('global', name), u32le(args.listIndex), args.issuer.toBytes()]),
  })
}

/** Let `issuer` insert into the list. The list's owner signs. */
export const addIssuerIx = (args: Parameters<typeof issuerIx>[1]) => issuerIx('add_issuer', args)
/** Stop `issuer` inserting into the list; nobody already in it is removed. The list's owner signs. */
export const removeIssuerIx = (args: Parameters<typeof issuerIx>[1]) => issuerIx('remove_issuer', args)

/**
 * Close a list to new members, for good. The list's owner signs. Its members, its root and its last
 * 128 roots stay: every proof against it still verifies.
 */
export function closeListIx(args: { owner: PublicKey; listIndex: number; programId?: PublicKey }): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  return new TransactionInstruction({
    programId,
    keys: [rw(listAddress(args.listIndex, programId)), ro(args.owner, true)],
    data: concat([discriminator('global', 'close_list'), u32le(args.listIndex)]),
  })
}

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

/** Accept a mint at `fee`, in its own base units, set once. The treasury signs. */
export function addTokenIx(args: {
  treasury: PublicKey
  mint: PublicKey
  fee: bigint
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  if (args.fee <= 0n) throw new RangeError('FeeZero: a fee is above zero')
  return new TransactionInstruction({
    programId,
    keys: [rw(configAddress(programId)), ro(args.treasury, true), ro(args.mint)],
    data: concat([discriminator('global', 'add_token'), u64le(args.fee)]),
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

/**
 * Who signs a registration, and what pays. The payer covers the network fee and the code account's
 * rent (a fee payer service, or the person). The profile's wallet signs for consent whoever pays,
 * and the proof names it. The fee authority owns `feeTokens`, which the fee comes from: usually the
 * profile's wallet itself. Any key may pay for another; the program cannot tell.
 */
export type RegisterAccounts = {
  payer: PublicKey
  profileWallet: PublicKey
  feeAuthority: PublicKey
  feeTokens: PublicKey
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
      ro(args.accounts.feeAuthority, true),
      rw(args.accounts.feeTokens),
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
  mints: PublicKey[]
  /** One per accepted mint, at the same index: its fee in its own base units. `fees[0]` is USDC's 0.25. */
  fees: bigint[]
  listCount: number
  bump: number
  /** The key a handover has been proposed to, or `null` when nothing is pending. */
  pendingTreasury: PublicKey | null
}

/**
 * treasury 0..32, mints 32..544, fees 544..672, mint_count 672, list_count 673..677, bump 677,
 * pending_treasury 678..710.
 */
export function decodeConfig(data: Uint8Array): ConfigAccount {
  const b = data.subarray(8)
  const mintCount = b[672]
  const mints: PublicKey[] = []
  const fees: bigint[] = []
  for (let i = 0; i < mintCount; i++) {
    mints.push(new PublicKey(b.subarray(32 + i * 32, 64 + i * 32)))
    fees.push(readU64le(b, 544 + i * 8))
  }
  const pending = new PublicKey(b.subarray(678, 710))
  return {
    treasury: new PublicKey(b.subarray(0, 32)),
    mints,
    fees,
    listCount: readU32le(b, 673),
    bump: b[677],
    pendingTreasury: pending.equals(PublicKey.default) ? null : pending,
  }
}

/** The fee a registration paying in `mint` moves, from a decoded config, or null if the mint is not accepted. */
export function feeFor(config: ConfigAccount, mint: PublicKey): bigint | null {
  const i = config.mints.findIndex((m) => m.equals(mint))
  return i === -1 ? null : config.fees[i]
}

export type IdentityListAccount = {
  leafCount: bigint
  index: number
  bump: number
  /** Closed to new members by its owner, for good. Proofs against it still verify. */
  closed: boolean
  root: Uint8Array
  roots: Uint8Array[]
  /** Its insert keys; the owner's is the first when the list opens. */
  issuers: PublicKey[]
  /** Who opened it and vouches for its members; the only key that changes its insert keys or closes it. */
  owner: PublicKey
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
    closed: b[14] !== 0,
    root: b.subarray(16, 48),
    roots,
    issuers,
    owner: new PublicKey(b.subarray(5456, 5488)),
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
  /** The profile's wallet that signed and that the proof names. A badge counts for the DID only if its profile record declares this wallet. */
  wallet: PublicKey
  code: Uint8Array
  listIndex: number
  /** The owner of the list the proof was made against: who vouched. An index weighs a badge by it. */
  listOwner: PublicKey
}

/**
 * The `Program data:` payloads that `programId` itself wrote, in order. Any program can write a
 * data line holding a `Registered` entry's exact bytes, with any DID and a real code copied from a
 * real registration, so the bytes alone prove nothing. What does is the runtime's own
 * `Program <id> invoke [n]` and `Program <id> success` or `failed` lines, which no program can
 * forge (a program's own output always starts `Program log:` or `Program data:`): a data line
 * belongs to whichever program is innermost at that point.
 */
export function programDataLines(logs: string[], programId: PublicKey = PROGRAM_ID): string[] {
  const id = programId.toBase58()
  const running: string[] = []
  const out: string[] = []
  for (const line of logs) {
    const invoked = /^Program (\S+) invoke \[\d+\]$/.exec(line)
    if (invoked) {
      running.push(invoked[1])
      continue
    }
    if (/^Program \S+ (success$|failed)/.test(line)) {
      running.pop()
      continue
    }
    if (line.startsWith('Program data: ') && running[running.length - 1] === id) {
      out.push(line.slice('Program data: '.length))
    }
  }
  return out
}

/**
 * The one entry per registration, read back out of the transaction log. Anchor writes an event as
 * a `Program data:` line whose bytes are the event's discriminator followed by its fields; only
 * lines the registry program itself wrote are read.
 */
export function decodeRegisteredEvents(logs: string[], programId: PublicKey = PROGRAM_ID): RegisteredEvent[] {
  const want = discriminator('event', 'Registered')
  const out: RegisteredEvent[] = []
  for (const payload of programDataLines(logs, programId)) {
    const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
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
    const wallet = new PublicKey(bytes.subarray(at, at + 32))
    at += 32
    const code = bytes.slice(at, at + 32)
    at += 32
    const listIndex = readU32le(bytes, at)
    at += 4
    const listOwner = new PublicKey(bytes.subarray(at, at + 32))
    out.push({ market, did, wallet, code, listIndex, listOwner })
  }
  return out
}

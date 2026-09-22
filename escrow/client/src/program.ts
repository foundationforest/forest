// The wire format: addresses, discriminators, instruction bytes, the account layout and the
// event layouts.
//
// Everything here is sealed with the program. These bytes are what clients and indexes read and
// write forever, so this file is written out by hand rather than generated: a reader can check it
// against `escrow/program/src/lib.rs` line by line, and the Rust tests encode the same bytes
// independently, so a drift on either side fails a test.

import { sha256 } from '@noble/hashes/sha2.js'
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js'

export const PROGRAM_ID = new PublicKey('FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

/** Written into every escrow. A v2 is a new program at a new address. */
export const VERSION = 1
export const MAX_STEPS = 4
/** One hundred percent. */
export const BPS = 10_000
export const SECONDS_PER_DAY = 86_400n
/** The escrow account's bytes after Anchor's eight-byte discriminator. */
export const ESCROW_LEN = 278
export const ESCROW_SEED = new TextEncoder().encode('escrow')

/**
 * One cancellation step: until `offset` seconds from the clock start, the buyer alone can cancel
 * and gets `refundBps` of the amount back. Negative offsets are before the clock start.
 */
export type Step = { offset: bigint; refundBps: number }

/** What `create` carries. */
export type Terms = {
  /** Any number the buyer has not used before. `randomId()` picks one. */
  id: bigint
  seller: PublicKey
  arbiter: PublicKey | null
  /** In the mint's base units. */
  amount: bigint
  /** Unix seconds, or null: then the clock starts when the funding is observed. */
  serviceTime: bigint | null
  silenceDays: number
  /** At most four, offsets strictly rising, refunds between 0 and 10,000. */
  steps: Step[]
}

/** `amount × bps / 10,000`, rounded down. */
export function share(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS) throw new RangeError(`${bps} is not 0..=10,000 basis points`)
  return (amount * BigInt(bps)) / BigInt(BPS)
}

/** Anchor's discriminator: the first eight bytes of `sha256("<namespace>:<name>")`. */
export function discriminator(namespace: string, name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8)
}

const u8 = (n: number) => new Uint8Array([n])
function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n, true)
  return b
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true)
  return b
}
const i64le = (n: bigint) => u64le(BigInt.asUintN(64, n))

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

class Reader {
  at = 0
  private b: Uint8Array
  private view: DataView
  constructor(b: Uint8Array) {
    this.b = b
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  u8(): number {
    return this.b[this.at++]
  }
  u16(): number {
    const v = this.view.getUint16(this.at, true)
    this.at += 2
    return v
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true)
    this.at += 4
    return v
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.at, true)
    this.at += 8
    return v
  }
  i64(): bigint {
    const v = this.view.getBigInt64(this.at, true)
    this.at += 8
    return v
  }
  key(): PublicKey {
    const v = new PublicKey(this.b.subarray(this.at, this.at + 32))
    this.at += 32
    return v
  }
  steps(): Step[] {
    const n = this.u32()
    const out: Step[] = []
    for (let i = 0; i < n; i++) out.push({ offset: this.i64(), refundBps: this.u16() })
    return out
  }
  done(): void {
    if (this.at !== this.b.length) throw new Error(`${this.b.length - this.at} trailing bytes`)
  }
}

/** A random 64-bit id, from the platform's random source. */
export function randomId(): bigint {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return new DataView(b.buffer).getBigUint64(0, true)
}

export function escrowAddress(buyer: PublicKey, id: bigint, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), buyer.toBuffer(), Buffer.from(u64le(id))],
    programId,
  )[0]
}

/**
 * The deposit address: the escrow's associated token account for the mint. The standard
 * derivation, so any wallet that sends this token "to the escrow's address" lands it here.
 */
export function vaultAddress(escrow: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [escrow.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

/**
 * The checks `create` makes, made here first so a bad set of terms fails before a transaction is
 * built. Throws with the program's own error name.
 */
export function validateTerms(terms: Terms, buyer: PublicKey): void {
  if (terms.seller.equals(buyer)) throw new Error('SameParty: the buyer and the seller must be different keys')
  if (terms.seller.equals(PublicKey.default)) throw new Error('EmptyKey: the seller cannot be the zero key')
  if (terms.arbiter) {
    if (terms.arbiter.equals(PublicKey.default)) throw new Error('EmptyKey: the arbiter cannot be the zero key')
    if (terms.arbiter.equals(buyer) || terms.arbiter.equals(terms.seller)) {
      throw new Error('ArbiterIsAParty: the arbiter cannot be the buyer or the seller')
    }
  }
  if (terms.amount <= 0n) throw new Error('AmountZero: the amount must be above zero')
  if (!Number.isInteger(terms.silenceDays) || terms.silenceDays < 1 || terms.silenceDays > 0xffff) {
    throw new Error('SilenceZero: silence days must be a whole number from 1 to 65,535')
  }
  if (terms.serviceTime !== null && terms.serviceTime <= 0n) {
    throw new Error('BadServiceTime: a service time must be a positive unix time')
  }
  if (terms.steps.length > MAX_STEPS) throw new Error('TooManySteps: an escrow holds at most four cancellation steps')
  let previous: bigint | null = null
  for (const step of terms.steps) {
    if (!Number.isInteger(step.refundBps) || step.refundBps < 0 || step.refundBps > BPS) {
      throw new Error('StepOverHundred: a refund is between 0 and 10,000 basis points')
    }
    if (previous !== null && step.offset <= previous) {
      throw new Error('StepsUnsorted: cancellation steps must have strictly rising deadlines')
    }
    previous = step.offset
  }
}

/**
 * id u64, seller, arbiter as an `Option` (0, or 1 then the key), amount u64, service_time as an
 * `Option` (0, or 1 then i64), silence_days u16, steps as a `Vec` (u32 count, then each as
 * offset i64 and refund_bps u16).
 */
export function createArgsBytes(terms: Terms): Uint8Array {
  return concat([
    u64le(terms.id),
    terms.seller.toBytes(),
    terms.arbiter ? concat([u8(1), terms.arbiter.toBytes()]) : u8(0),
    u64le(terms.amount),
    terms.serviceTime !== null ? concat([u8(1), i64le(terms.serviceTime)]) : u8(0),
    u16le(terms.silenceDays),
    u32le(terms.steps.length),
    ...terms.steps.map((s) => concat([i64le(s.offset), u16le(s.refundBps)])),
  ])
}

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false })
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true })

/** `create`: the buyer signs; the payer signs, pays both rents and is recorded to get them back. */
export function createIx(args: {
  buyer: PublicKey
  payer: PublicKey
  mint: PublicKey
  terms: Terms
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  validateTerms(args.terms, args.buyer)
  const escrow = escrowAddress(args.buyer, args.terms.id, programId)
  return new TransactionInstruction({
    programId,
    keys: [
      rw(escrow),
      rw(vaultAddress(escrow, args.mint)),
      ro(args.buyer, true),
      rw(args.payer, true),
      ro(args.mint),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'create'), createArgsBytes(args.terms)]),
  })
}

/** `mark_funded`: anyone. Records the moment the deposit account is seen holding the amount. */
export function markFundedIx(args: { escrow: PublicKey; vault: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [rw(args.escrow), ro(args.vault)],
    data: concat([discriminator('global', 'mark_funded')]),
  })
}

/** `object`: the buyer signs, before silence releases. Locks the escrow. */
export function objectIx(args: {
  escrow: PublicKey
  vault: PublicKey
  buyer: PublicKey
  programId?: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [rw(args.escrow), ro(args.vault), ro(args.buyer, true)],
    data: concat([discriminator('global', 'object')]),
  })
}

/**
 * The accounts every ending touches: the escrow, its deposit account, a token account for the
 * mint that the buyer owns, one the seller owns, and the rent payer recorded at creation.
 */
export type SettleAccounts = {
  escrow: PublicKey
  vault: PublicKey
  buyerTokens: PublicKey
  sellerTokens: PublicKey
  rentPayer: PublicKey
}

function settleKeys(s: SettleAccounts): AccountMeta[] {
  return [rw(s.escrow), rw(s.vault), rw(s.buyerTokens), rw(s.sellerTokens), rw(s.rentPayer), ro(TOKEN_PROGRAM_ID)]
}

/** `release_by_silence`: anyone, after the silence period. All to the seller. */
export function releaseBySilenceIx(args: { accounts: SettleAccounts; programId?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: settleKeys(args.accounts),
    data: concat([discriminator('global', 'release_by_silence')]),
  })
}

function settleAsIx(
  name: 'approve' | 'arbitrate' | 'cancel_buyer' | 'cancel_seller' | 'close',
  accounts: SettleAccounts,
  actor: PublicKey,
  sellerBps: number | null,
  programId: PublicKey,
): TransactionInstruction {
  if (sellerBps !== null && (!Number.isInteger(sellerBps) || sellerBps < 0 || sellerBps > BPS)) {
    throw new RangeError(`BadSplit: ${sellerBps} is not 0..=10,000 basis points`)
  }
  return new TransactionInstruction({
    programId,
    keys: [...settleKeys(accounts), ro(actor, true)],
    data: concat([discriminator('global', name), ...(sellerBps === null ? [] : [u16le(sellerBps)])]),
  })
}

/** `approve`: the buyer signs. `sellerBps` of the amount to the seller (10,000, the default, is all of it). */
export function approveIx(args: {
  accounts: SettleAccounts
  buyer: PublicKey
  sellerBps?: number
  programId?: PublicKey
}): TransactionInstruction {
  return settleAsIx('approve', args.accounts, args.buyer, args.sellerBps ?? BPS, args.programId ?? PROGRAM_ID)
}

/** `arbitrate`: the arbiter named at creation signs. Any split. */
export function arbitrateIx(args: {
  accounts: SettleAccounts
  arbiter: PublicKey
  sellerBps: number
  programId?: PublicKey
}): TransactionInstruction {
  return settleAsIx('arbitrate', args.accounts, args.arbiter, args.sellerBps, args.programId ?? PROGRAM_ID)
}

/** `cancel_buyer`: the buyer signs, before a deadline. The step in force says the refund. */
export function cancelBuyerIx(args: { accounts: SettleAccounts; buyer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return settleAsIx('cancel_buyer', args.accounts, args.buyer, null, args.programId ?? PROGRAM_ID)
}

/** `cancel_seller`: the seller signs, any time before release. Everything back to the buyer. */
export function cancelSellerIx(args: { accounts: SettleAccounts; seller: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return settleAsIx('cancel_seller', args.accounts, args.seller, null, args.programId ?? PROGRAM_ID)
}

/** `close`: a never-funded escrow, by the seller any time or the buyer after the last deadline. */
export function closeIx(args: { accounts: SettleAccounts; party: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return settleAsIx('close', args.accounts, args.party, null, args.programId ?? PROGRAM_ID)
}

/** `agree`: both keys sign any split. Any state once funded, locked included. */
export function agreeIx(args: {
  accounts: SettleAccounts
  buyer: PublicKey
  seller: PublicKey
  sellerBps: number
  programId?: PublicKey
}): TransactionInstruction {
  if (!Number.isInteger(args.sellerBps) || args.sellerBps < 0 || args.sellerBps > BPS) {
    throw new RangeError(`BadSplit: ${args.sellerBps} is not 0..=10,000 basis points`)
  }
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [...settleKeys(args.accounts), ro(args.buyer, true), ro(args.seller, true)],
    data: concat([discriminator('global', 'agree'), u16le(args.sellerBps)]),
  })
}

// ---------------------------------------------------------------------------------------------
// The account.
// ---------------------------------------------------------------------------------------------

export type Status = 'open' | 'funded' | 'locked' | 'ended'
const STATUS: Status[] = ['open', 'funded', 'locked', 'ended']

export type EscrowAccount = {
  version: number
  id: bigint
  buyer: PublicKey
  seller: PublicKey
  /** null when none was named. */
  arbiter: PublicKey | null
  mint: PublicKey
  vault: PublicKey
  rentPayer: PublicKey
  amount: bigint
  /** Unix seconds, or null. */
  serviceTime: bigint | null
  silenceDays: number
  steps: Step[]
  createdAt: bigint
  /** When the deposit account was first observed holding the amount, or null. */
  fundedAt: bigint | null
  status: Status
  bump: number
}

/**
 * version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137, vault 137..169,
 * rent_payer 169..201, amount 201..209, service_time 209..217, silence_days 217..219,
 * step_count 219, steps 220..260 (four of offset i64, refund_bps u16), created_at 260..268,
 * funded_at 268..276, status 276, bump 277.
 */
export function decodeEscrow(data: Uint8Array): EscrowAccount {
  if (data.length !== 8 + ESCROW_LEN) throw new Error(`an escrow account is ${8 + ESCROW_LEN} bytes, not ${data.length}`)
  const want = discriminator('account', 'Escrow')
  if (!want.every((v, i) => data[i] === v)) throw new Error('not an escrow account')
  const b = data.subarray(8)
  const r = new Reader(b)
  const version = r.u8()
  const id = r.u64()
  const buyer = r.key()
  const seller = r.key()
  const arbiter = r.key()
  const mint = r.key()
  const vault = r.key()
  const rentPayer = r.key()
  const amount = r.u64()
  const serviceTime = r.i64()
  const silenceDays = r.u16()
  const stepCount = r.u8()
  const steps: Step[] = []
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = { offset: r.i64(), refundBps: r.u16() }
    if (i < stepCount) steps.push(step)
  }
  const createdAt = r.i64()
  const fundedAt = r.i64()
  const status = STATUS[r.u8()]
  const bump = r.u8()
  r.done()
  if (!status) throw new Error('unknown status byte')
  return {
    version,
    id,
    buyer,
    seller,
    arbiter: arbiter.equals(PublicKey.default) ? null : arbiter,
    mint,
    vault,
    rentPayer,
    amount,
    serviceTime: serviceTime === 0n ? null : serviceTime,
    silenceDays,
    steps,
    createdAt,
    fundedAt: fundedAt === 0n ? null : fundedAt,
    status,
    bump,
  }
}

// ---------------------------------------------------------------------------------------------
// Events, from the `Program data:` lines in a transaction's log.
// ---------------------------------------------------------------------------------------------

export type Outcome =
  | 'approved'
  | 'releasedBySilence'
  | 'agreed'
  | 'arbitrated'
  | 'cancelledByBuyer'
  | 'cancelledBySeller'
  | 'neverFunded'
const OUTCOME: Outcome[] = [
  'approved',
  'releasedBySilence',
  'agreed',
  'arbitrated',
  'cancelledByBuyer',
  'cancelledBySeller',
  'neverFunded',
]

export type EscrowEvent =
  | {
      kind: 'created'
      escrow: PublicKey
      version: number
      id: bigint
      buyer: PublicKey
      seller: PublicKey
      arbiter: PublicKey | null
      mint: PublicKey
      vault: PublicKey
      rentPayer: PublicKey
      amount: bigint
      serviceTime: bigint | null
      silenceDays: number
      steps: Step[]
      createdAt: bigint
    }
  | { kind: 'funded'; escrow: PublicKey; balance: bigint; fundedAt: bigint }
  | { kind: 'approved'; escrow: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'releasedBySilence'; escrow: PublicKey; clockStart: bigint; silenceEnded: bigint; toSeller: bigint; toBuyer: bigint }
  | { kind: 'objected'; escrow: PublicKey; at: bigint; silenceEnds: bigint }
  | { kind: 'agreed'; escrow: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'arbitrated'; escrow: PublicKey; arbiter: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'cancelledByBuyer'; escrow: PublicKey; step: number; refundBps: number; toBuyer: bigint; toSeller: bigint }
  | { kind: 'cancelledBySeller'; escrow: PublicKey; seller: PublicKey; toBuyer: bigint }
  | {
      kind: 'closed'
      escrow: PublicKey
      outcome: Outcome
      amount: bigint
      balance: bigint
      toSeller: bigint
      toBuyer: bigint
      rentPayer: PublicKey
      rentLamports: bigint
    }

const EVENT_NAMES: [string, EscrowEvent['kind']][] = [
  ['Created', 'created'],
  ['Funded', 'funded'],
  ['Approved', 'approved'],
  ['ReleasedBySilence', 'releasedBySilence'],
  ['Objected', 'objected'],
  ['Agreed', 'agreed'],
  ['Arbitrated', 'arbitrated'],
  ['CancelledByBuyer', 'cancelledByBuyer'],
  ['CancelledBySeller', 'cancelledBySeller'],
  ['Closed', 'closed'],
]

export function decodeEvent(bytes: Uint8Array): EscrowEvent | null {
  if (bytes.length < 8) return null
  const found = EVENT_NAMES.find(([name]) => discriminator('event', name).every((v, i) => bytes[i] === v))
  if (!found) return null
  const kind = found[1]
  const r = new Reader(bytes.subarray(8))
  const escrow = r.key()
  let event: EscrowEvent
  switch (kind) {
    case 'created': {
      const version = r.u8()
      const id = r.u64()
      const buyer = r.key()
      const seller = r.key()
      const arbiter = r.key()
      const mint = r.key()
      const vault = r.key()
      const rentPayer = r.key()
      const amount = r.u64()
      const serviceTime = r.i64()
      const silenceDays = r.u16()
      const steps = r.steps()
      const createdAt = r.i64()
      event = {
        kind,
        escrow,
        version,
        id,
        buyer,
        seller,
        arbiter: arbiter.equals(PublicKey.default) ? null : arbiter,
        mint,
        vault,
        rentPayer,
        amount,
        serviceTime: serviceTime === 0n ? null : serviceTime,
        silenceDays,
        steps,
        createdAt,
      }
      break
    }
    case 'funded':
      event = { kind, escrow, balance: r.u64(), fundedAt: r.i64() }
      break
    case 'approved':
    case 'agreed':
      event = { kind, escrow, sellerBps: r.u16(), toSeller: r.u64(), toBuyer: r.u64() }
      break
    case 'releasedBySilence':
      event = { kind, escrow, clockStart: r.i64(), silenceEnded: r.i64(), toSeller: r.u64(), toBuyer: r.u64() }
      break
    case 'objected':
      event = { kind, escrow, at: r.i64(), silenceEnds: r.i64() }
      break
    case 'arbitrated':
      event = { kind, escrow, arbiter: r.key(), sellerBps: r.u16(), toSeller: r.u64(), toBuyer: r.u64() }
      break
    case 'cancelledByBuyer':
      event = { kind, escrow, step: r.u8(), refundBps: r.u16(), toBuyer: r.u64(), toSeller: r.u64() }
      break
    case 'cancelledBySeller':
      event = { kind, escrow, seller: r.key(), toBuyer: r.u64() }
      break
    case 'closed': {
      const outcome = OUTCOME[r.u8()]
      if (!outcome) throw new Error('unknown outcome byte')
      event = {
        kind,
        escrow,
        outcome,
        amount: r.u64(),
        balance: r.u64(),
        toSeller: r.u64(),
        toBuyer: r.u64(),
        rentPayer: r.key(),
        rentLamports: r.u64(),
      }
      break
    }
  }
  r.done()
  return event
}

/**
 * The `Program data:` payloads that `programId` itself wrote, in order. Any program can write a
 * data line holding an escrow event's exact bytes, so the bytes alone prove nothing. What does is
 * the runtime's own `Program <id> invoke [n]` and `Program <id> success` or `failed` lines, which
 * no program can forge (a program's own output always starts `Program log:` or `Program data:`):
 * a data line belongs to whichever program is innermost at that point.
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

/** Every event the escrow program wrote in a transaction's log lines, in order. */
export function decodeEvents(logs: string[], programId: PublicKey = PROGRAM_ID): EscrowEvent[] {
  const out: EscrowEvent[] = []
  for (const payload of programDataLines(logs, programId)) {
    const event = decodeEvent(new Uint8Array(Buffer.from(payload, 'base64')))
    if (event) out.push(event)
  }
  return out
}

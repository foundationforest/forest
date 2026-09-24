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
/** Wrapped SOL: a classic SPL Token mint that `create` refuses by name. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')

/** Written into every escrow. A v2 is a new program at a new address. */
export const VERSION = 1
export const MAX_STEPS = 4
/** One hundred percent. */
export const BPS = 10_000
export const SECONDS_PER_DAY = 86_400n
/** How long after the funding is observed an escrow with no steps, never accepted, waits before anyone may send everything back (`close_unaccepted`). */
export const UNACCEPTED_DAYS = 30n
/** The escrow account's bytes after Anchor's eight-byte discriminator. */
export const ESCROW_LEN = 311
export const ESCROW_SEED = new TextEncoder().encode('escrow')

/**
 * One cancellation step: until `offset` seconds from the clock start, the buyer alone can cancel
 * and gets `refundBps` of the amount back. Negative offsets are before the clock start.
 */
export type Step = { offset: bigint; refundBps: number }

/** What `create` carries, besides the buyer, whose key is passed beside it. */
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

/** An associated token account: the standard address of `owner`'s account for `mint`. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

/**
 * The deposit address: the escrow's associated token account for the mint. The standard
 * derivation, so any wallet that sends this token "to the escrow's address" lands it here.
 */
export function vaultAddress(escrow: PublicKey, mint: PublicKey): PublicKey {
  return associatedTokenAddress(escrow, mint)
}

/**
 * The buyer's refund address: the buyer's associated token account for the mint, computed from
 * two keys fixed at creation. Every ending pays the buyer here and nowhere else (session 14).
 * `recover_late` and `close_unaccepted` make it first, at the sender's cost, if it does not exist;
 * for every other ending the sender puts `makeRefundAddressIx` first in the same transaction.
 */
export function refundAddress(buyer: PublicKey, mint: PublicKey): PublicKey {
  return associatedTokenAddress(buyer, mint)
}

/**
 * Make the buyer's refund address if it is missing, and do nothing if it is there: the associated
 * token program's idempotent create, `payer` paying its rent. Put it before an ending when the
 * buyer has no standard account for the mint (a buyer may close an empty one). The account, and
 * its rent, are the buyer's from then on.
 */
export function makeRefundAddressIx(args: { payer: PublicKey; buyer: PublicKey; mint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      rw(args.payer, true),
      rw(refundAddress(args.buyer, args.mint)),
      ro(args.buyer),
      ro(args.mint),
      ro(SystemProgram.programId),
      ro(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from([1]),
  })
}

/**
 * The checks `create` makes, made here first so a bad set of terms fails before a transaction is
 * built. Throws with the program's own error name.
 */
export function validateTerms(terms: Terms, buyer: PublicKey): void {
  if (terms.seller.equals(buyer)) throw new Error('SameParty: the buyer and the seller must be different keys')
  if (terms.seller.equals(PublicKey.default)) throw new Error('EmptyKey: the seller cannot be the zero key')
  if (buyer.equals(PublicKey.default)) throw new Error('EmptyKey: the buyer cannot be the zero key')
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
 * id u64, buyer, seller, arbiter as an `Option` (0, or 1 then the key), amount u64, service_time
 * as an `Option` (0, or 1 then i64), silence_days u16, steps as a `Vec` (u32 count, then each as
 * offset i64 and refund_bps u16).
 */
export function createArgsBytes(terms: Terms, buyer: PublicKey): Uint8Array {
  return concat([
    u64le(terms.id),
    buyer.toBytes(),
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

/**
 * `create`. The creator signs: the buyer (the default), proposing a deal the seller has yet to
 * accept, or the seller, invoicing, accepted from creation (`invoiceIx`). The payer signs, pays both
 * rents, and is recorded to get back the deposit account's at the end, or both if it never held
 * the amount. The terms are checked against the program's rules (`validateTerms`) and for sense
 * (`checkTerms`) before anything is built.
 */
export function createIx(args: {
  buyer: PublicKey
  payer: PublicKey
  mint: PublicKey
  terms: Terms
  /** Who signs as creator: the buyer, unless the seller is invoicing. */
  creator?: PublicKey
  /** Unix seconds, for `checkTerms`. Default: the device's clock. */
  now?: bigint
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const creator = args.creator ?? args.buyer
  validateTerms(args.terms, args.buyer)
  if (!creator.equals(args.buyer) && !creator.equals(args.terms.seller)) {
    throw new Error('NotAParty: the buyer or the seller opens an escrow')
  }
  if (args.mint.equals(NATIVE_MINT)) throw new Error('NativeMint: wrapped SOL is not accepted')
  checkTerms(args.terms, { now: args.now, arbiter: args.terms.arbiter })
  const escrow = escrowAddress(args.buyer, args.terms.id, programId)
  return new TransactionInstruction({
    programId,
    keys: [
      rw(escrow),
      rw(vaultAddress(escrow, args.mint)),
      ro(creator, true),
      rw(args.payer, true),
      ro(args.mint),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'create'), createArgsBytes(args.terms, args.buyer)]),
  })
}

/** `create` by the seller: an invoice naming the buyer, accepted from creation. */
export function invoiceIx(args: {
  seller: PublicKey
  buyer: PublicKey
  payer: PublicKey
  mint: PublicKey
  terms: Terms
  now?: bigint
  programId?: PublicKey
}): TransactionInstruction {
  if (!args.terms.seller.equals(args.seller)) throw new Error('an invoice names its own seller in the terms')
  return createIx({ ...args, creator: args.seller })
}

/** A service time at or above this is not unix seconds: `Date.now()` today is about 1.8 × 10^12. */
export const MAX_UNIX_SECONDS = 10_000_000_000n

/**
 * What a party checks before signing anything that commits it to an escrow's terms: `create`,
 * `accept`, or paying an invoice. The program accepts all of these; nobody means them.
 *
 * - Times in seconds: a service time is unix seconds, below 10^10 (the year 2286), so a
 *   millisecond timestamp is caught; and not already past, because terms whose service time has
 *   gone by were written for another day. (Until session 12 a past one also started silence
 *   before the money landed; the clock now waits for the funding.)
 * - Steps sane: at most four, deadlines strictly rising, refunds 0 to 100%, and none after silence
 *   ends, or the buyer's cancellation and the seller's release are both live and race.
 * - An arbiter only if named: the escrow's arbiter is the one the signer expects, and none if it
 *   expects none. A key the signer did not agree to could be the other party's second key.
 *
 * Throws with the reason.
 */
export function checkTerms(
  terms: Pick<Terms, 'arbiter' | 'serviceTime' | 'silenceDays' | 'steps'>,
  expect: { arbiter: PublicKey | null; now?: bigint },
): void {
  const now = expect.now ?? BigInt(Math.floor(Date.now() / 1000))
  if (terms.serviceTime !== null) {
    if (terms.serviceTime >= MAX_UNIX_SECONDS) {
      throw new Error(`the service time ${terms.serviceTime} is not unix seconds (milliseconds?)`)
    }
    if (terms.serviceTime < now) throw new Error('the service time has already passed')
  }
  if (terms.steps.length > MAX_STEPS) throw new Error('TooManySteps: an escrow holds at most four cancellation steps')
  const silence = BigInt(terms.silenceDays) * SECONDS_PER_DAY
  let previous: bigint | null = null
  for (const step of terms.steps) {
    if (!Number.isInteger(step.refundBps) || step.refundBps < 0 || step.refundBps > BPS) {
      throw new Error('StepOverHundred: a refund is between 0 and 10,000 basis points')
    }
    if (previous !== null && step.offset <= previous) {
      throw new Error('StepsUnsorted: cancellation steps must have strictly rising deadlines')
    }
    if (step.offset > silence) {
      throw new Error('a refund step outlasts silence: the buyer\'s cancellation and the seller\'s release would race')
    }
    previous = step.offset
  }
  const want = expect.arbiter
  if (terms.arbiter === null ? want !== null : want === null || !terms.arbiter.equals(want)) {
    throw new Error(
      terms.arbiter === null
        ? 'the escrow names no arbiter, and one was expected'
        : `the escrow names an arbiter the signer did not agree to: ${terms.arbiter.toBase58()}`,
    )
  }
}

/**
 * `accept`: the seller signs, accepting the escrow as it stands. Built only from the escrow
 * account as read from the chain, after `checkTerms` against the arbiter the seller agreed to:
 * accepting is where a seller consents to terms someone else wrote.
 */
export function acceptIx(args: {
  account: EscrowAccount
  seller: PublicKey
  /** The arbiter the seller agreed to, or null for none. */
  arbiter: PublicKey | null
  now?: bigint
  programId?: PublicKey
}): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const a = args.account
  if (!a.seller.equals(args.seller)) throw new Error('NotTheSeller: this escrow names another seller')
  if (a.status === 'ended') throw new Error('Ended: this escrow has ended')
  if (a.status !== 'open') throw new Error('AlreadyAccepted: the seller has already accepted')
  checkTerms(a, { arbiter: args.arbiter, now: args.now })
  return new TransactionInstruction({
    programId,
    keys: [rw(escrowAddress(a.buyer, a.id, programId)), ro(a.vault), ro(args.seller, true)],
    data: concat([discriminator('global', 'accept')]),
  })
}

/**
 * `mark_funded`: anyone, before or after the seller accepts. Records the moment the deposit account
 * is seen holding the amount: the clock never starts before it, and an escrow nobody accepts counts
 * its timeout from it.
 */
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
 * The accounts every ending touches: the escrow, its deposit account, the buyer's refund address
 * (named from `buyer` and `mint`, so no other account can be named), a token account for the mint
 * that the seller owns, and the rent payer recorded at creation.
 */
export type SettleAccounts = {
  escrow: PublicKey
  vault: PublicKey
  buyer: PublicKey
  mint: PublicKey
  sellerTokens: PublicKey
  rentPayer: PublicKey
}

function settleKeys(s: SettleAccounts): AccountMeta[] {
  return [rw(s.escrow), rw(s.vault), rw(refundAddress(s.buyer, s.mint)), rw(s.sellerTokens), rw(s.rentPayer), ro(TOKEN_PROGRAM_ID)]
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
  name: 'approve' | 'arbitrate' | 'cancel_buyer' | 'cancel_seller',
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

/**
 * `approve`: the buyer signs. `sellerBps` of the amount to the seller (10,000, the default, is all
 * of it). Before the seller accepts, only all of it.
 */
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

/** The two exits that pay the seller nothing name no seller account. */
export type RefundAccounts = Omit<SettleAccounts, 'sellerTokens'>

function refundIx(name: 'withdraw' | 'close_unfunded', accounts: RefundAccounts, signer: PublicKey, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [rw(accounts.escrow), rw(accounts.vault), rw(refundAddress(accounts.buyer, accounts.mint)), rw(accounts.rentPayer), ro(TOKEN_PROGRAM_ID), ro(signer, true)],
    data: concat([discriminator('global', name)]),
  })
}

/** `withdraw`: the buyer signs, before the seller accepts. Everything back; the receipt stays. */
export function withdrawIx(args: { accounts: RefundAccounts; buyer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return refundIx('withdraw', args.accounts, args.buyer, args.programId ?? PROGRAM_ID)
}

/**
 * `close_unfunded`: an escrow that never held the amount, by the buyer or the seller at any time,
 * or by the rent payer after the last deadline (at once with no steps). Both accounts close.
 */
export function closeUnfundedIx(args: { accounts: RefundAccounts; closer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return refundIx('close_unfunded', args.accounts, args.closer, args.programId ?? PROGRAM_ID)
}

/**
 * `recover_late`: anyone, on an escrow that has ended. Whatever a later payment left at its deposit
 * address goes to the buyer's refund address (made first at `caller`'s cost if it does not exist);
 * the deposit account closes again and its rent goes to the buyer. The receipt does not change.
 * Built only from the escrow account as read from the chain.
 */
export function recoverLateIx(args: { account: EscrowAccount; caller: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const a = args.account
  if (a.status !== 'ended') throw new Error('NotEnded: money above the amount goes back to the buyer when the escrow ends')
  return new TransactionInstruction({
    programId,
    keys: [
      ro(escrowAddress(a.buyer, a.id, programId)),
      rw(a.vault),
      rw(a.buyer),
      rw(refundAddress(a.buyer, a.mint)),
      ro(a.mint),
      rw(args.caller, true),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'recover_late')]),
  })
}

/**
 * `sweep_rent`: anyone, on any escrow. What the escrow account holds above its current rent-exempt
 * minimum goes to the rent payer recorded at creation; the account keeps exactly the minimum and
 * its bytes. Nobody signs but the transaction's fee payer.
 */
export function sweepRentIx(args: { escrow: PublicKey; rentPayer: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId ?? PROGRAM_ID,
    keys: [rw(args.escrow), rw(args.rentPayer)],
    data: concat([discriminator('global', 'sweep_rent')]),
  })
}

/**
 * `close_unaccepted`: anyone, on a funded escrow the seller never accepted, after its timeout (the
 * last cancellation deadline from the later of the service time and the observed funding, or 30
 * days after the observed funding with no steps; `schedule().closeUnacceptedAt` says when, and the
 * program checks it). Everything goes to the buyer's refund address (made first at `caller`'s cost
 * if it does not exist), the deposit account's rent to the rent payer, and the receipt stays with
 * the outcome `neverAccepted`. Built only from the escrow account as read from the chain.
 */
export function closeUnacceptedIx(args: { account: EscrowAccount; caller: PublicKey; programId?: PublicKey }): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID
  const a = args.account
  if (a.status === 'ended') throw new Error('Ended: this escrow has ended')
  if (a.acceptedAt !== null) throw new Error('AlreadyAccepted: the seller has accepted this escrow')
  if (a.fundedAt === null) throw new Error('FundingNotObserved: send mark_funded first')
  return new TransactionInstruction({
    programId,
    keys: [
      rw(escrowAddress(a.buyer, a.id, programId)),
      rw(a.vault),
      ro(a.buyer),
      rw(refundAddress(a.buyer, a.mint)),
      ro(a.mint),
      rw(a.rentPayer),
      rw(args.caller, true),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data: concat([discriminator('global', 'close_unaccepted')]),
  })
}

/** `agree`: both keys sign any split, once the seller has accepted and it is funded, locked included. */
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

export type Status = 'open' | 'accepted' | 'funded' | 'locked' | 'ended'
const STATUS: Status[] = ['open', 'accepted', 'funded', 'locked', 'ended']

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
  /** When the deposit account was first observed holding the amount, or null. May come before the acceptance. */
  fundedAt: bigint | null
  status: Status
  bump: number
  /** When the seller accepted, or null. */
  acceptedAt: bigint | null
  /** When it ended, or null. */
  endedAt: bigint | null
  /** How it ended, or null while it has not. */
  outcome: Outcome | null
  /** What each party was paid at the end; 0 before. */
  toSeller: bigint
  toBuyer: bigint
}

/**
 * version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137, vault 137..169,
 * rent_payer 169..201, amount 201..209, service_time 209..217, silence_days 217..219,
 * step_count 219, steps 220..260 (four of offset i64, refund_bps u16), created_at 260..268,
 * funded_at 268..276, status 276, bump 277, accepted_at 278..286, ended_at 286..294, outcome 294,
 * to_seller 295..303, to_buyer 303..311.
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
  const acceptedAt = r.i64()
  const endedAt = r.i64()
  const outcomeByte = r.u8()
  const toSeller = r.u64()
  const toBuyer = r.u64()
  r.done()
  if (!status) throw new Error('unknown status byte')
  const outcome = status === 'ended' ? OUTCOME[outcomeByte] : null
  if (status === 'ended' && !outcome) throw new Error('unknown outcome byte')
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
    acceptedAt: acceptedAt === 0n ? null : acceptedAt,
    endedAt: endedAt === 0n ? null : endedAt,
    outcome,
    toSeller,
    toBuyer,
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
  | 'withdrawn'
  /** The seller never accepted; after the timeout anyone sent everything back to the buyer. */
  | 'neverAccepted'
const OUTCOME: Outcome[] = [
  'approved',
  'releasedBySilence',
  'agreed',
  'arbitrated',
  'cancelledByBuyer',
  'cancelledBySeller',
  'withdrawn',
  'neverAccepted',
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
  | { kind: 'accepted'; escrow: PublicKey; seller: PublicKey; acceptedAt: bigint }
  | { kind: 'funded'; escrow: PublicKey; balance: bigint; fundedAt: bigint }
  | { kind: 'approved'; escrow: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'releasedBySilence'; escrow: PublicKey; clockStart: bigint; silenceEnded: bigint; toSeller: bigint; toBuyer: bigint }
  | { kind: 'objected'; escrow: PublicKey; at: bigint; silenceEnds: bigint }
  | { kind: 'agreed'; escrow: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'arbitrated'; escrow: PublicKey; arbiter: PublicKey; sellerBps: number; toSeller: bigint; toBuyer: bigint }
  | { kind: 'cancelledByBuyer'; escrow: PublicKey; step: number; refundBps: number; toBuyer: bigint; toSeller: bigint }
  | { kind: 'cancelledBySeller'; escrow: PublicKey; seller: PublicKey; toBuyer: bigint }
  | { kind: 'withdrawn'; escrow: PublicKey; toBuyer: bigint }
  | {
      kind: 'ended'
      escrow: PublicKey
      outcome: Outcome
      amount: bigint
      balance: bigint
      toSeller: bigint
      toBuyer: bigint
      /** null when the seller never accepted. */
      acceptedAt: bigint | null
      endedAt: bigint
      rentPayer: PublicKey
      /** The deposit account's rent, returned. The escrow account's stays in the receipt. */
      rentLamports: bigint
    }
  | { kind: 'closed'; escrow: PublicKey; closedBy: PublicKey; toBuyer: bigint; rentPayer: PublicKey; rentLamports: bigint }
  | { kind: 'neverAccepted'; escrow: PublicKey; timeout: bigint; toBuyer: bigint }
  /** Money that came after the end went back to the buyer's refund address; the deposit account's rent to the buyer. */
  | { kind: 'recoveredLate'; escrow: PublicKey; toBuyer: bigint; rentLamports: bigint }
  /** Lamports above the minimum went to the rent payer; `left` is the minimum kept. */
  | { kind: 'rentSwept'; escrow: PublicKey; lamports: bigint; left: bigint }

const EVENT_NAMES: [string, EscrowEvent['kind']][] = [
  ['Created', 'created'],
  ['Accepted', 'accepted'],
  ['Funded', 'funded'],
  ['Approved', 'approved'],
  ['ReleasedBySilence', 'releasedBySilence'],
  ['Objected', 'objected'],
  ['Agreed', 'agreed'],
  ['Arbitrated', 'arbitrated'],
  ['CancelledByBuyer', 'cancelledByBuyer'],
  ['CancelledBySeller', 'cancelledBySeller'],
  ['Withdrawn', 'withdrawn'],
  ['Ended', 'ended'],
  ['Closed', 'closed'],
  ['NeverAccepted', 'neverAccepted'],
  ['RecoveredLate', 'recoveredLate'],
  ['RentSwept', 'rentSwept'],
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
    case 'accepted':
      event = { kind, escrow, seller: r.key(), acceptedAt: r.i64() }
      break
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
    case 'withdrawn':
      event = { kind, escrow, toBuyer: r.u64() }
      break
    case 'ended': {
      const outcome = OUTCOME[r.u8()]
      if (!outcome) throw new Error('unknown outcome byte')
      const amount = r.u64()
      const balance = r.u64()
      const toSeller = r.u64()
      const toBuyer = r.u64()
      const acceptedAt = r.i64()
      event = {
        kind,
        escrow,
        outcome,
        amount,
        balance,
        toSeller,
        toBuyer,
        acceptedAt: acceptedAt === 0n ? null : acceptedAt,
        endedAt: r.i64(),
        rentPayer: r.key(),
        rentLamports: r.u64(),
      }
      break
    }
    case 'closed':
      event = { kind, escrow, closedBy: r.key(), toBuyer: r.u64(), rentPayer: r.key(), rentLamports: r.u64() }
      break
    case 'neverAccepted':
      event = { kind, escrow, timeout: r.i64(), toBuyer: r.u64() }
      break
    case 'recoveredLate':
      event = { kind, escrow, toBuyer: r.u64(), rentLamports: r.u64() }
      break
    case 'rentSwept':
      event = { kind, escrow, lamports: r.u64(), left: r.u64() }
      break
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

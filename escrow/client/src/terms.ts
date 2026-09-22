// From a market file's defaults and the parties' choices to the terms an escrow is created with,
// and from an escrow's state to its clock: where the clock starts, when silence ends, when each
// cancellation deadline falls and which step is in force.
//
// The program does none of this reading: it stores offsets and compares the cluster clock to
// them. This file is the same arithmetic on the app's side, so a deadline the app shows is the
// deadline the program will enforce.

import type { PublicKey } from '@solana/web3.js'

import { BPS, MAX_STEPS, SECONDS_PER_DAY, randomId, share, type EscrowAccount, type Step, type Terms } from './program.ts'

/** A cancellation step as a market file writes it: hours from the clock start, and a percent. */
export type MarketStep = { hours: number; refundPercent: number }

/** The escrow defaults a market file carries. The rest of the file is not read here. */
export type MarketDefaults = {
  silenceDays: number
  arbiterAllowed: boolean
  /** Not in the market template yet (session 8 left it open); absent means no steps. */
  cancellationSteps?: MarketStep[]
  tokens: { symbol: string; mint: string; chain: string }[]
}

/** What the parties choose for one deal. Everything the market does not fix. */
export type Choices = {
  seller: PublicKey
  amount: bigint
  mint: PublicKey
  arbiter?: PublicKey | null
  /** A Date or unix seconds. Null or absent: the clock starts at funding. */
  serviceTime?: Date | bigint | number | null
  /** Overrides the market's default. */
  silenceDays?: number
  /** Overrides the market's default steps, already as offsets in seconds. */
  steps?: Step[]
  id?: bigint
}

export function toUnix(t: Date | bigint | number): bigint {
  if (t instanceof Date) return BigInt(Math.floor(t.getTime() / 1000))
  if (typeof t === 'number') return BigInt(Math.floor(t))
  return t
}

/** Hours and percent to seconds and basis points. */
export function stepFromMarket(s: MarketStep): Step {
  if (!Number.isFinite(s.hours)) throw new RangeError(`hours must be a number, not ${s.hours}`)
  if (!Number.isFinite(s.refundPercent) || s.refundPercent < 0 || s.refundPercent > 100) {
    throw new RangeError(`refundPercent must be 0 to 100, not ${s.refundPercent}`)
  }
  return { offset: BigInt(Math.round(s.hours * 3600)), refundBps: Math.round(s.refundPercent * 100) }
}

/**
 * The terms for one deal: the market's defaults, the parties' choices on top. Throws when the
 * choices break the market's rules (an arbiter where none is allowed, a token the market does
 * not accept) or the program's (see `validateTerms`).
 */
export function termsFor(market: MarketDefaults, choices: Choices): Terms {
  const accepted = market.tokens.some((t) => t.chain === 'solana' && t.mint === choices.mint.toBase58())
  if (!accepted) throw new Error(`the market does not accept mint ${choices.mint.toBase58()}`)
  const arbiter = choices.arbiter ?? null
  if (arbiter && !market.arbiterAllowed) throw new Error('the market does not allow an arbiter')
  const steps = choices.steps ?? (market.cancellationSteps ?? []).map(stepFromMarket)
  if (steps.length > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} cancellation steps`)
  return {
    id: choices.id ?? randomId(),
    seller: choices.seller,
    arbiter,
    amount: choices.amount,
    serviceTime: choices.serviceTime === undefined || choices.serviceTime === null ? null : toUnix(choices.serviceTime),
    silenceDays: choices.silenceDays ?? market.silenceDays,
    steps,
  }
}

/** Where the clock starts: the service time if set, else when funding was observed, else null. */
export function clockStart(e: Pick<EscrowAccount, 'serviceTime' | 'fundedAt'>): bigint | null {
  if (e.serviceTime !== null) return e.serviceTime
  if (e.fundedAt !== null) return e.fundedAt
  return null
}

/** When silence releases: the first second after `start + silenceDays`. */
export function silenceEnds(start: bigint, silenceDays: number): bigint {
  return start + BigInt(silenceDays) * SECONDS_PER_DAY
}

export type Deadline = { index: number; deadline: bigint; refundBps: number }

/** Every step's deadline, in order, from a clock start. */
export function deadlines(steps: Step[], start: bigint): Deadline[] {
  return steps.map((s, index) => ({ index, deadline: start + s.offset, refundBps: s.refundBps }))
}

/** The step in force at `now`: the first whose deadline is still ahead, or null. */
export function currentStep(steps: Step[], start: bigint, now: bigint): Deadline | null {
  return deadlines(steps, start).find((d) => now < d.deadline) ?? null
}

export type Schedule = {
  /** null: no service time and the funding not yet observed; nothing below can be known. */
  clockStart: bigint | null
  /** The first second at which `release_by_silence` succeeds. */
  silenceReleasesAt: bigint | null
  silenceOver: boolean
  deadlines: Deadline[]
  currentStep: Deadline | null
  /** The buyer can `cancel_buyer` now, from the clock alone (funding and the lock aside). */
  buyerCanCancel: boolean
  /** The buyer can `object` now, from the clock alone. */
  buyerCanObject: boolean
  /** For a never-funded escrow: the first second at which the buyer can `close`, or null for now. */
  buyerCanCloseUnfundedAt: bigint | null
}

/** The escrow's clock as the program will read it at `now` (unix seconds; default: now). */
export function schedule(
  e: Pick<EscrowAccount, 'serviceTime' | 'fundedAt' | 'silenceDays' | 'steps' | 'createdAt' | 'status'>,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Schedule {
  const start = clockStart(e)
  const ends = start === null ? null : silenceEnds(start, e.silenceDays)
  const silenceOver = ends !== null && now > ends
  const ds = start === null ? [] : deadlines(e.steps, start)
  const current = start === null ? null : currentStep(e.steps, start, now)
  const unfundedReference = e.serviceTime ?? e.createdAt
  const last = e.steps.length === 0 ? null : unfundedReference + e.steps[e.steps.length - 1].offset
  return {
    clockStart: start,
    silenceReleasesAt: ends === null ? null : ends + 1n,
    silenceOver,
    deadlines: ds,
    currentStep: current,
    buyerCanCancel: current !== null && e.status !== 'locked',
    buyerCanObject: start !== null && !silenceOver && e.status !== 'locked',
    buyerCanCloseUnfundedAt: last === null || now > last ? null : last + 1n,
  }
}

/** What an approval, agreement or arbitration pays: `sellerBps` of the amount, the rest and the excess back. */
export function payout(amount: bigint, balance: bigint, sellerBps: number): { toSeller: bigint; toBuyer: bigint } {
  if (balance < amount) throw new RangeError('NotFunded: the deposit account holds less than the amount')
  const toSeller = share(amount, sellerBps)
  return { toSeller, toBuyer: balance - toSeller }
}

/**
 * What a buyer's cancellation pays under a step: the refund back, the rest of the amount to the
 * seller. The seller's share rounds down, as in every split, so the buyer gets at least the step's
 * percent.
 */
export function cancelPayout(amount: bigint, balance: bigint, refundBps: number): { toSeller: bigint; toBuyer: bigint } {
  if (balance < amount) throw new RangeError('NotFunded: the deposit account holds less than the amount')
  if (!Number.isInteger(refundBps) || refundBps < 0 || refundBps > BPS) throw new RangeError(`${refundBps} is not 0..=10,000 basis points`)
  const toSeller = share(amount, BPS - refundBps)
  return { toSeller, toBuyer: balance - toSeller }
}

export { BPS }

// From an offer's terms and the deal's own choices to the terms an escrow is created with, and
// from an escrow's state to its clock: where the clock starts, when silence ends, when each
// cancellation deadline falls and which step is in force.
//
// An offer's terms are the seller's, set per offer in the post's `terms` block. A market file only
// suggests starting values for them (`suggestedTerms`); nothing here reads a market file to limit
// a deal.
//
// The program does none of this reading: it stores offsets and compares the cluster clock to
// them. This file is the same arithmetic on the app's side, so a deadline the app shows is the
// deadline the program will enforce.

import { PublicKey } from '@solana/web3.js'

import {
  BPS,
  MAX_STEPS,
  SECONDS_PER_DAY,
  UNACCEPTED_DAYS,
  checkTerms,
  randomId,
  share,
  type EscrowAccount,
  type Step,
  type Terms,
} from './program.ts'

/** A cancellation step as a post's terms write it: hours from the clock start, and a percent. */
export type OfferStep = { hours: number; refundPercent: number }

/**
 * An offer's terms, as the post's `terms` block carries them: the seller's, set per offer. The
 * program calls the auto-release days its silence days.
 */
export type OfferTerms = {
  autoReleaseDays: number
  /** Absent means none: the buyer cannot cancel alone once the seller has accepted. */
  cancellationSteps?: OfferStep[]
  /** The arbiter's key, base58. Absent or null: no arbiter. */
  arbiter?: string | null
}

/** A market file's `suggested` block: starting values an app offers a seller. Never a limit. */
export type MarketSuggestions = { autoReleaseDays: number; cancellationSteps: OfferStep[] }

/** What one deal fixes beyond the offer's terms. */
export type Choices = {
  seller: PublicKey
  amount: bigint
  /** Any classic SPL Token mint the program accepts; the post's `price.mint`. */
  mint: PublicKey
  /** A Date or unix seconds. Null or absent: the clock starts at funding. */
  serviceTime?: Date | bigint | number | null
  id?: bigint
}

/** A Date, or unix seconds. `checkTerms` refuses a number that is really milliseconds. */
export function toUnix(t: Date | bigint | number): bigint {
  if (t instanceof Date) return BigInt(Math.floor(t.getTime() / 1000))
  if (typeof t === 'number') return BigInt(Math.floor(t))
  return t
}

/** Hours and percent to seconds and basis points. */
export function stepFromOffer(s: OfferStep): Step {
  if (!Number.isFinite(s.hours)) throw new RangeError(`hours must be a number, not ${s.hours}`)
  if (!Number.isFinite(s.refundPercent) || s.refundPercent < 0 || s.refundPercent > 100) {
    throw new RangeError(`refundPercent must be 0 to 100, not ${s.refundPercent}`)
  }
  return { offset: BigInt(Math.round(s.hours * 3600)), refundBps: Math.round(s.refundPercent * 100) }
}

/**
 * Starting values for a seller writing an offer's terms: the market file's suggestions, copied,
 * with no arbiter. The seller changes any of them; nothing checks a deal against them.
 */
export function suggestedTerms(market: { suggested: MarketSuggestions }): OfferTerms {
  const { autoReleaseDays, cancellationSteps } = market.suggested
  return { autoReleaseDays, cancellationSteps: cancellationSteps.map((s) => ({ ...s })), arbiter: null }
}

/**
 * The terms for one deal, created from the offer's terms: its auto-release days, its steps and its
 * arbiter, plus the deal's own seller, amount, mint, service time and id. No market file is read:
 * any token and any arbiter work. Throws when the terms make no sense (`checkTerms`: a time in
 * milliseconds or already past, a refund step that outlasts silence), with the offer's arbiter as
 * the one agreed to. The program's own rules are checked when the instruction is built.
 */
export function termsFor(offer: OfferTerms, choices: Choices, now?: bigint): Terms {
  const arbiter = offer.arbiter ? new PublicKey(offer.arbiter) : null
  const steps = (offer.cancellationSteps ?? []).map(stepFromOffer)
  if (steps.length > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} cancellation steps`)
  const terms: Terms = {
    id: choices.id ?? randomId(),
    seller: choices.seller,
    arbiter,
    amount: choices.amount,
    serviceTime: choices.serviceTime === undefined || choices.serviceTime === null ? null : toUnix(choices.serviceTime),
    silenceDays: offer.autoReleaseDays,
    steps,
  }
  checkTerms(terms, { arbiter, now })
  return terms
}

const later = (a: bigint, b: bigint): bigint => (a > b ? a : b)

/**
 * Where the clock starts: the latest of the service time (if set), the observed funding and the
 * seller's acceptance; null until the seller has accepted and the funding has been observed.
 * Funding always counts, so an invoice paid late has its whole silence period after the money.
 */
export function clockStart(e: Pick<EscrowAccount, 'serviceTime' | 'fundedAt' | 'acceptedAt'>): bigint | null {
  if (e.acceptedAt === null || e.fundedAt === null) return null
  return later(later(e.serviceTime ?? 0n, e.fundedAt), e.acceptedAt)
}

/**
 * When anyone may send back an escrow the seller never accepted (`close_unaccepted` succeeds from
 * the second after): the last cancellation deadline, counted from the later of the service time
 * and the observed funding, or 30 days after the observed funding when there are no steps. Null
 * until the funding has been observed.
 */
export function unacceptedTimeout(e: Pick<EscrowAccount, 'serviceTime' | 'fundedAt' | 'steps'>): bigint | null {
  if (e.fundedAt === null) return null
  const last = e.steps[e.steps.length - 1]
  if (last === undefined) return e.fundedAt + UNACCEPTED_DAYS * SECONDS_PER_DAY
  return later(e.serviceTime ?? 0n, e.fundedAt) + last.offset
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
  /** The seller has accepted. Until then only a full approval or the buyer's withdrawal can happen. */
  accepted: boolean
  /** null: not accepted yet, or the funding not yet observed; nothing below can be known. */
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
  /**
   * For a never-funded escrow: the first second at which the rent payer can `close_unfunded`, or
   * null for now. The buyer and the seller can at any time.
   */
  rentPayerCanCloseUnfundedAt: bigint | null
  /**
   * For a funded escrow the seller has not accepted: the first second at which anyone can
   * `close_unaccepted` and send everything back to the buyer. Null once accepted or ended, or
   * while the funding has not been observed (send `mark_funded`).
   */
  closeUnacceptedAt: bigint | null
}

/** The escrow's clock as the program will read it at `now` (unix seconds; default: now). */
export function schedule(
  e: Pick<EscrowAccount, 'serviceTime' | 'fundedAt' | 'acceptedAt' | 'silenceDays' | 'steps' | 'createdAt' | 'status'>,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Schedule {
  const start = clockStart(e)
  const ends = start === null ? null : silenceEnds(start, e.silenceDays)
  const silenceOver = ends !== null && now > ends
  const ds = start === null ? [] : deadlines(e.steps, start)
  const current = start === null ? null : currentStep(e.steps, start, now)
  const unfundedReference = e.serviceTime ?? e.createdAt
  const last = e.steps.length === 0 ? null : unfundedReference + e.steps[e.steps.length - 1].offset
  const timeout = e.acceptedAt === null && e.status !== 'ended' ? unacceptedTimeout(e) : null
  return {
    accepted: e.acceptedAt !== null,
    clockStart: start,
    silenceReleasesAt: ends === null ? null : ends + 1n,
    silenceOver,
    deadlines: ds,
    currentStep: current,
    buyerCanCancel: current !== null && e.status !== 'locked' && e.status !== 'ended',
    buyerCanObject: start !== null && !silenceOver && e.status !== 'locked' && e.status !== 'ended',
    rentPayerCanCloseUnfundedAt: last === null || now > last ? null : last + 1n,
    closeUnacceptedAt: timeout === null ? null : timeout + 1n,
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

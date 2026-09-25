// Plain words for people. Everything a person reads on a page goes through here or is the
// people's own text; none of it says wallet, USDC, chain, gas, token or any other crypto word.
// The JSON twins keep the records' own field names, which are for machines.

import type { CurrencyConfig } from '../config.ts'

// -----------------------------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------------------------

/** A market or category slug as a heading: `online-tutors` → `Online tutors`. */
export function title(slug: string): string {
  const s = slug.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// -----------------------------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------------------------

/** `12.5` → `12.50`, `25` → `25`, `25.000` → `25`: whole units as a price is written. */
function tidy(decimal: string): string {
  const [whole, frac = ''] = decimal.split('.')
  const f = frac.replace(/0+$/, '')
  if (!f) return whole.replace(/^0+(?=\d)/, '')
  return `${whole.replace(/^0+(?=\d)/, '')}.${f.length === 1 ? `${f}0` : f}`
}

/** Base units to whole units as decimal text: 25000000 at 6 decimals → "25". */
export function fromBaseUnits(base: string | bigint, decimals: number): string {
  const s = BigInt(base).toString().padStart(decimals + 1, '0')
  return tidy(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`)
}

export type Money = { known: true; code: string; text: string; decimal: string } | { known: false; text: string }

/** A price as a post writes it: whole units as decimal text, and the token that names the currency. */
export function money(amount: string, mint: string, currencies: CurrencyConfig): Money {
  const c = currencies[mint]
  if (!c || !/^\d+(\.\d+)?$/.test(amount)) return { known: false, text: 'a price in a currency this index doesn’t show' }
  const decimal = tidy(amount)
  return { known: true, code: c.code, text: `${c.symbol}${decimal}`, decimal }
}

/** An amount a receipt records, in base units. */
export function moneyFromBase(base: string, mint: string, currencies: CurrencyConfig): Money {
  const c = currencies[mint]
  if (!c) return { known: false, text: 'an amount in a currency this index doesn’t show' }
  return money(fromBaseUnits(base, c.decimals), mint, currencies)
}

export const PER: Record<string, string> = { hour: 'per hour', day: 'per day', job: 'for the job' }

export function price(p: { amount: string; mint: string; per: string }, currencies: CurrencyConfig): string {
  const m = money(p.amount, p.mint, currencies)
  return m.known ? `${m.text} ${PER[p.per] ?? ''}`.trim() : m.text.charAt(0).toUpperCase() + m.text.slice(1)
}

// -----------------------------------------------------------------------------------------------
// Dates and numbers
// -----------------------------------------------------------------------------------------------

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** `25 Sept 2026`: the same everywhere, whatever the reader's country. */
export function date(iso: string | null): string {
  return iso ? DATE.format(new Date(iso)) : ''
}

/** A score for reading: two decimals, or four when it is that small, with a real minus sign. */
export function score(v: number): string {
  if (v === 0) return '0'
  const s = Math.abs(v) >= 0.01 ? v.toFixed(2) : v.toFixed(4)
  return s.replace('-', '−')
}

export function signed(v: number): string {
  return v > 0 ? `+${score(v)}` : score(v)
}

export function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function stars(rating: number | null): string {
  return rating === null ? 'No rating' : `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${rating} of 5`
}

// -----------------------------------------------------------------------------------------------
// Badges, evidence, receipts
// -----------------------------------------------------------------------------------------------

export const BADGE = 'Verified real person, one per market'

export function badgeWhyNot(why: string | null): string {
  switch (why) {
    case 'walletNotDeclared':
      return 'Not counted: this profile doesn’t name the key the badge was registered with.'
    case 'notInDirectory':
      return 'Not counted: registered under a name that isn’t a market in this index’s directory.'
    default:
      return 'Not counted.'
  }
}

export function evidence(kind: string, note: string | null): string {
  switch (kind) {
    case 'both':
      return 'Backed by a payment both sides agreed to.'
    case 'oneSidedConfirmed':
      return 'Backed by a payment, and both sides reviewed it.'
    case 'oneSided':
      return 'Backed by a payment from one side only; it counts in full once the other side reviews it too.'
  }
  switch (note) {
    case 'noDealId':
      return 'No payment behind it, so it counts for little.'
    case 'noReceipt':
      return 'Names a payment this index can’t find, so it counts for little.'
    case 'notTheParties':
      return 'Names a payment between other people, so it counts for little.'
    case 'tokenNotCounted':
      return 'Backed by a payment in a currency this index doesn’t count, so it counts for little.'
    case 'notPaid':
      return 'Names a payment that hasn’t been made, so it counts for little.'
    default:
      return 'Counts for little.'
  }
}

export function skipped(why: string | null): string | null {
  if (why === 'self') return 'Not counted: a review of oneself.'
  if (why === 'replaced') return 'Not counted: a later review by the same person replaces it.'
  return null
}

/**
 * How a receipt ended, as a sentence. `buyer` and `seller` are the names to use; the amounts are
 * already money text.
 */
export function outcome(o: string, n: { buyer: string; seller: string; toSeller: string; toBuyer: string }): string {
  switch (o) {
    case 'releasedToSeller':
      return `${n.buyer} released the payment to ${n.seller}.`
    case 'releasedToBuyer':
      return `${n.seller} sent the payment back to ${n.buyer}.`
    case 'split':
      return `They agreed to split it: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    case 'arbitrated':
      return `The person they chose to decide split it: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    case 'timerReleased':
      return `The timer they set ran out: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    default:
      return `It ended: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
  }
}

export function timer(t: { days: number; to: string }, n: { buyer: string; seller: string }): string {
  return `A timer: ${plural(t.days, 'day')} after the payment is marked, everything goes to ${t.to === 'seller' ? n.seller : n.buyer}.`
}

export const ARBITER = 'Someone they both named may decide how to split it.'
export const NO_OPTIONS = 'Money moves only when both sides agree.'

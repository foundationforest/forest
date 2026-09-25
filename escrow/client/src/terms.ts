// From a post's terms to the terms an escrow is created with, and back: what a person checks
// before they work or pay, when the timer is due, and what a split pays.
//
// A post's `terms` block is optional and holds only the escrow's two options, each off unless set
// (`shapes/lexicons/foundation/forest/post.json`, `#terms`): `arbiter`, a key that may decide any
// split, and `timer`, `{ days, to }`. Everything else about a deal (the seller, the amount, the
// token) comes from the deal itself. Nothing here reads a market file: a market says nothing about
// money or time.

import { PublicKey } from '@solana/web3.js'

import {
  BPS,
  MAX_TIMER_DAYS,
  SECONDS_PER_DAY,
  randomId,
  share,
  type EscrowAccount,
  type Side,
  type Terms,
  type Timer,
} from './program.ts'

/**
 * A post's `terms` block, as `shapes/` defines it. Records stay open, so a block may carry other
 * keys (an old post's `autoReleaseDays`, say): they are ignored and mean nothing to an escrow.
 */
export type PostTerms = {
  /** A Solana key, base58, that may decide any split. Absent: no arbiter. */
  arbiter?: string
  /** Absent: no timer. */
  timer?: { days: number; to: Side }
  [other: string]: unknown
}

/** The two options, as an escrow holds them. */
export type Options = { arbiter: PublicKey | null; timer: Timer | null }

/**
 * The options a post's terms turn on. Absent, null or empty terms turn on nothing. Throws on a
 * malformed option rather than guess: a key that is not a key, days that are not a whole number
 * from 1 to 65,535, or a side that is neither party.
 */
export function optionsFromPost(terms: PostTerms | null | undefined): Options {
  if (terms === null || terms === undefined) return { arbiter: null, timer: null }
  if (typeof terms !== 'object' || Array.isArray(terms)) throw new TypeError('a post\'s terms are an object')
  let arbiter: PublicKey | null = null
  if (terms.arbiter !== undefined) {
    if (typeof terms.arbiter !== 'string') throw new TypeError('terms.arbiter is a base58 key')
    arbiter = new PublicKey(terms.arbiter)
    if (arbiter.equals(PublicKey.default)) throw new Error('EmptyKey: the arbiter cannot be the zero key')
  }
  let timer: Timer | null = null
  if (terms.timer !== undefined) {
    const t = terms.timer
    if (typeof t !== 'object' || t === null) throw new TypeError('terms.timer is { days, to }')
    if (!Number.isInteger(t.days) || t.days < 1 || t.days > MAX_TIMER_DAYS) {
      throw new RangeError(`terms.timer.days is a whole number from 1 to ${MAX_TIMER_DAYS}, not ${String(t.days)}`)
    }
    if (t.to !== 'seller' && t.to !== 'buyer') throw new RangeError(`terms.timer.to is "seller" or "buyer", not ${String(t.to)}`)
    timer = { days: t.days, to: t.to }
  }
  return { arbiter, timer }
}

/**
 * The terms for one deal: the post's options, plus the deal's own seller, amount and id (a fresh
 * random one unless given). Per hour or per job is the app multiplying before this; any token the
 * program accepts works. The program's own rules are checked when the instruction is built.
 */
export function termsFor(post: PostTerms | null | undefined, deal: { seller: PublicKey; amount: bigint; id?: bigint }): Terms {
  const { arbiter, timer } = optionsFromPost(post)
  return { id: deal.id ?? randomId(), seller: deal.seller, amount: deal.amount, arbiter, timer }
}

/**
 * One way an escrow's options differ from what a person agreed to. `added`: the escrow turns on
 * an option the person did not set. `changed`: it names another arbiter, or another timer, than the
 * person set. `removed`: the person set an option the escrow does not carry.
 *
 * `holder` says whose key an arbiter is: the person's own, the other party's (who could then
 * decide any split alone), or a third key. `favours` says which side a timer pays: the person, or
 * the other party. These are facts for the app to put in words; none of them is copy.
 */
export type OptionDifference =
  | { option: 'arbiter'; kind: 'added' | 'changed'; arbiter: PublicKey; holder: 'me' | 'otherParty' | 'thirdParty' }
  | { option: 'arbiter'; kind: 'removed'; expected: PublicKey }
  | { option: 'timer'; kind: 'added' | 'changed'; timer: Timer; favours: 'me' | 'otherParty' }
  | { option: 'timer'; kind: 'removed'; expected: Timer }

/**
 * What a person checks before they work (the seller) or pay (the buyer): whether the escrow, as
 * read from the chain, names an arbiter or a timer they did not set. The program accepts any
 * option its creator chose; this is where the other side sees them. Returns every difference,
 * or an empty list when the escrow carries exactly the options agreed.
 *
 * `agreed` is what the person set or accepted: the options of the post they answered, or of the
 * offer they wrote. Null means they agreed to none.
 */
export function optionsNotAgreed(args: {
  escrow: Pick<EscrowAccount, 'buyer' | 'seller' | 'arbiter' | 'timer'>
  me: Side
  agreed: Options | PostTerms | null
}): OptionDifference[] {
  const { escrow, me } = args
  const agreed = isOptions(args.agreed) ? args.agreed : optionsFromPost(args.agreed)
  const myKey = me === 'buyer' ? escrow.buyer : escrow.seller
  const theirKey = me === 'buyer' ? escrow.seller : escrow.buyer
  const out: OptionDifference[] = []

  if (escrow.arbiter && !(agreed.arbiter && agreed.arbiter.equals(escrow.arbiter))) {
    const holder = escrow.arbiter.equals(myKey) ? 'me' : escrow.arbiter.equals(theirKey) ? 'otherParty' : 'thirdParty'
    out.push({ option: 'arbiter', kind: agreed.arbiter ? 'changed' : 'added', arbiter: escrow.arbiter, holder })
  } else if (!escrow.arbiter && agreed.arbiter) {
    out.push({ option: 'arbiter', kind: 'removed', expected: agreed.arbiter })
  }

  const same = (a: Timer, b: Timer) => a.days === b.days && a.to === b.to
  if (escrow.timer && !(agreed.timer && same(agreed.timer, escrow.timer))) {
    out.push({ option: 'timer', kind: agreed.timer ? 'changed' : 'added', timer: { ...escrow.timer }, favours: escrow.timer.to === me ? 'me' : 'otherParty' })
  } else if (!escrow.timer && agreed.timer) {
    out.push({ option: 'timer', kind: 'removed', expected: { ...agreed.timer } })
  }
  return out
}

/** `Options` carry both keys, the arbiter as a key object or null; a post's terms carry a string or nothing. */
function isOptions(x: Options | PostTerms | null): x is Options {
  return x !== null && 'timer' in x && (x.arbiter === null || x.arbiter instanceof PublicKey)
}

/** The same check, throwing with every difference: for code paths that must not continue. */
export function assertOptionsAgreed(args: Parameters<typeof optionsNotAgreed>[0]): void {
  const diffs = optionsNotAgreed(args)
  if (diffs.length === 0) return
  const say = (d: OptionDifference) =>
    d.option === 'arbiter'
      ? d.kind === 'removed'
        ? `no arbiter, though ${d.expected.toBase58()} was agreed`
        : `an arbiter not agreed (${d.holder}): ${d.arbiter.toBase58()}`
      : d.kind === 'removed'
        ? `no timer, though ${d.expected.days} days to the ${d.expected.to} was agreed`
        : `a timer not agreed: ${d.timer.days} days to the ${d.timer.to} (${d.favours})`
  throw new Error(`the escrow's options differ from what was agreed: ${diffs.map(say).join('; ')}`)
}

/** A field an escrow read off the chain can differ in from the one a person meant. */
export type Field = 'buyer' | 'seller' | 'mint' | 'amount' | 'arbiter' | 'timer'

/**
 * What an escrow read off the chain differs in from the one a person meant to open or pay: its
 * buyer, seller, mint, amount or options. Empty when it is the one.
 *
 * Anyone can open the address a buyer is about to use: the address is the buyer's key and an id,
 * and whoever opens it names the seller. A buyer paying in one tap loses nothing to that (the
 * whole transaction fails), but an app that pays in a transaction apart from its own `create`
 * checks this first. The buyer can close such an escrow, which never held anything, and reopen.
 */
export function whatDiffers(
  account: Pick<EscrowAccount, 'buyer' | 'seller' | 'mint' | 'amount' | 'arbiter' | 'timer'>,
  meant: { buyer: PublicKey; mint: PublicKey; terms: Terms },
): Field[] {
  const out: Field[] = []
  if (!account.buyer.equals(meant.buyer)) out.push('buyer')
  if (!account.seller.equals(meant.terms.seller)) out.push('seller')
  if (!account.mint.equals(meant.mint)) out.push('mint')
  if (account.amount !== meant.terms.amount) out.push('amount')
  const a = account.arbiter
  const b = meant.terms.arbiter
  if (a === null ? b !== null : b === null || !a.equals(b)) out.push('arbiter')
  const t = account.timer
  const u = meant.terms.timer
  if (t === null ? u !== null : u === null || t.days !== u.days || t.to !== u.to) out.push('timer')
  return out
}

/**
 * When the timer is due, in unix seconds: `timer_release` succeeds from this second on. Null with
 * no timer, before the funding is marked, or once the escrow has ended.
 */
export function timerDueAt(e: Pick<EscrowAccount, 'timer' | 'fundedAt' | 'status'>): bigint | null {
  if (!e.timer || e.status !== 'funded' || e.fundedAt === null) return null
  return e.fundedAt + BigInt(e.timer.days) * SECONDS_PER_DAY
}

/** Whether `timer_release` succeeds at `now` (unix seconds; default: now), the balance aside. */
export function timerDue(e: Pick<EscrowAccount, 'timer' | 'fundedAt' | 'status'>, now: bigint = BigInt(Math.floor(Date.now() / 1000))): boolean {
  const due = timerDueAt(e)
  return due !== null && now >= due
}

/**
 * What a split or an arbitration pays: `sellerBps` of the whole balance to the seller, rounded
 * down, the rest to the buyer. A release is the same at 10,000 (to the seller) or 0 (to the buyer).
 */
export function payout(balance: bigint, sellerBps: number): { toSeller: bigint; toBuyer: bigint } {
  const toSeller = share(balance, sellerBps)
  return { toSeller, toBuyer: balance - toSeller }
}

/** Whether a deposit account's balance funds an escrow: at least the amount. */
export function funds(balance: bigint, amount: bigint): boolean {
  return balance >= amount
}

export { BPS }

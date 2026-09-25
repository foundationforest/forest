// The scoring rules, on plain data: every evidence class, how badges count and combine, the
// dedupe, and trust as a fixed point. No database, no chain, no host.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { INDEX_ROOT } from '../src/config.ts'
import { Directory } from '../src/markets.ts'
import {
  type BadgeIn,
  type Inputs,
  type ReceiptIn,
  type ReviewIn,
  badgeStatus,
  compute,
  evidenceFor,
  reviewerWeight,
  uniqueness,
} from '../src/scores/compute.ts'

const tutors = JSON.parse(readFileSync(join(INDEX_ROOT, '../shapes/examples/markets/online-tutors.json'), 'utf8'))
const directory = new Directory([{ file: 'online-tutors.json', market: tutors }], { 'online-tutors': ['online-tutor'] })
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const FOUNDATION = 'H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS'
const OTHER_ISSUER = 'Other1ssuer11111111111111111111111111111111'
const scoring = {
  evidence: { both: 1, oneSided: 0.5, none: 0.05 },
  unbadgedReviewer: 0.05,
  countedMints: [USDC],
  maxRounds: 100,
  tolerance: 1e-9,
}
const settings = { directory, issuers: { [FOUNDATION]: { name: 'Forest Foundation', weight: 1 } }, scoring }

const ana = { did: 'did:plc:ana', wallet: 'AnaWallet' }
const ben = { did: 'did:plc:ben', wallet: 'BenWallet' }
const cleo = { did: 'did:plc:cleo', wallet: 'CleoDeclared' }
const badge = (did: string, wallet: string, scope = 'online-tutors', listOwner = FOUNDATION): BadgeIn => ({ did, wallet, scope, listOwner })
// Ana invoiced Ben (the seller created it), and Ben paid in one tap: no funding mark, released.
const receipt = (over: Partial<ReceiptIn> = {}): ReceiptIn => ({
  escrow: 'Deal1111111111111111111111111111111111111111',
  buyer: ben.wallet,
  seller: ana.wallet,
  creator: 'seller',
  mint: USDC,
  funded: false,
  outcome: 'releasedToSeller',
  closed: false,
  ...over,
})
let n = 0
const review = (reviewer: string, subject: string, over: Partial<ReviewIn> = {}): ReviewIn => ({
  uri: `at://${reviewer}/foundation.forest.review/${String(++n).padStart(4, '0')}`,
  reviewer,
  subject,
  rating: 5,
  dealId: null,
  createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
  ...over,
})

function evidence(v: ReviewIn, receipts: ReceiptIn[], reviews: ReviewIn[] = [v]) {
  return evidenceFor(v, {
    receipts: new Map(receipts.map((r) => [r.escrow, r])),
    wallets: new Map([ana, ben, cleo].map((p) => [p.did, p.wallet])),
    reviews,
    scoring,
  })
}

test('evidence: the seller created it (an invoice) and it was paid: full, however it ended', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 })
  assert.deepEqual(evidence(review(ana.did, ben.did, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 }, 'the other way round')
  const marked = receipt({ funded: true, outcome: null })
  assert.equal(evidence(review(ben.did, ana.did, { dealId: marked.escrow }), [marked]).kind, 'both', 'funding marked, not ended yet')
  for (const outcome of ['releasedToBuyer', 'split', 'arbitrated', 'timerReleased']) {
    const ended = receipt({ outcome })
    assert.equal(evidence(review(ben.did, ana.did, { dealId: ended.escrow }), [ended]).kind, 'both', `an ending proves the payment: ${outcome}`)
  }
})

test('evidence: the buyer created it: one-sided until the seller reviews the same deal', () => {
  const r = receipt({ creator: 'buyer' })
  const byBuyer = review(ben.did, ana.did, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r]), { kind: 'oneSided', weight: 0.5 })
  const bySeller = review(ana.did, ben.did, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r], [byBuyer, bySeller]), { kind: 'oneSidedConfirmed', weight: 1 })
  assert.deepEqual(evidence(bySeller, [r], [bySeller]), { kind: 'oneSidedConfirmed', weight: 1 }, 'the seller reviewing the deal is the seller saying yes')
})

test('evidence: what counts little', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.did, ana.did), [r]), { kind: 'none', weight: 0.05, note: 'noDealId' })
  assert.equal(evidence(review(ben.did, ana.did, { dealId: 'ab'.repeat(32) }), [r]).note, 'noReceipt')
  assert.equal(evidence(review(cleo.did, ana.did, { dealId: r.escrow }), [r]).note, 'notTheParties', "someone else's receipt")
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ mint: 'SelfMinted111111111111111111111111111111111' })]).note, 'tokenNotCounted')
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ funded: false, outcome: null })]).note, 'notPaid', 'invoiced, never paid')
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ closed: true, funded: false, outcome: null })]).note, 'noReceipt', 'closed, never funded')
})

test('a badge counts only under a directory name, and only for the wallet the profile declares', () => {
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet), ana.wallet, directory), { counted: true, market: 'online-tutors', role: null })
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet, 'online-tutors/seller'), ana.wallet, directory), { counted: true, market: 'online-tutors', role: 'seller' }, 'market/role; a file with no roles has seller and buyer')
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet, 'online-tutors:seller'), ana.wallet, directory), { counted: false, why: 'notInDirectory' }, 'only the slash separates a role')
  assert.deepEqual(badgeStatus(badge(ana.did, 'NotDeclared'), ana.wallet, directory), { counted: false, why: 'walletNotDeclared' })
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet), null, directory), { counted: false, why: 'walletNotDeclared' })
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet, 'online-tutor'), ana.wallet, directory), { counted: false, why: 'notInDirectory' }, 'an alias never counts for a badge')
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet, 'Online-Tutors'), ana.wallet, directory), { counted: false, why: 'notInDirectory' }, 'byte for byte')
  assert.deepEqual(badgeStatus(badge(ana.did, ana.wallet, 'online-tutors/plumber'), ana.wallet, directory), { counted: false, why: 'notInDirectory' }, 'a role the market does not have')
})

test('uniqueness: issuers combine, an issuer at 0 adds nothing', () => {
  const one = uniqueness({ profiles: [ana], badges: [badge(ana.did, ana.wallet)] }, settings)
  assert.equal(one.length, 1)
  assert.equal(one[0].value, 1)
  assert.deepEqual(one[0].issuers, [{ owner: FOUNDATION, name: 'Forest Foundation', weight: 1 }])

  const unknown = uniqueness({ profiles: [ana], badges: [badge(ana.did, ana.wallet, 'online-tutors', OTHER_ISSUER)] }, settings)
  assert.equal(unknown[0].value, 0, 'others start at 0')

  const halves = { ...settings, issuers: { [FOUNDATION]: { name: 'F', weight: 0.5 }, [OTHER_ISSUER]: { name: 'O', weight: 0.5 } } }
  const two = uniqueness(
    { profiles: [ana], badges: [badge(ana.did, ana.wallet), badge(ana.did, ana.wallet, 'online-tutors', OTHER_ISSUER)] },
    halves,
  )
  assert.equal(two[0].value, 0.75, 'two issuers at 0.5: 1 − 0.5 × 0.5')

  assert.deepEqual(uniqueness({ profiles: [cleo], badges: [badge(cleo.did, 'CleoOther')] }, settings), [], 'wallet not declared')
})

test('trust: everyone starts at zero; the scenario the end-to-end test runs', () => {
  const deal = receipt()
  const inputs: Inputs = {
    profiles: [ana, ben, cleo],
    badges: [badge(ana.did, ana.wallet), badge(ben.did, ben.wallet), badge(cleo.did, 'CleoUndeclared')],
    receipts: [deal],
    reviews: [
      review(ben.did, ana.did, { dealId: deal.escrow, rating: 5 }),
      review(ana.did, ben.did, { dealId: deal.escrow, rating: 5 }),
      review(cleo.did, ana.did, { dealId: 'cd'.repeat(32), rating: 1 }),
    ],
  }
  assert.deepEqual(compute({ ...inputs, reviews: [] }, settings).trust.map((t) => t.value), [0, 0, 0])

  const s = compute(inputs, settings)
  const t = Object.fromEntries(s.trust.map((x) => [x.did, x.value]))
  // Ana and Ben vouch for each other, both badged at 1: each converges to x = 1 + x / (x + 1),
  // the golden ratio, less Cleo's small negative on Ana. Cleo counts at the floor, with no receipt.
  const cleoPart = 0.05 * 0.05 * -1
  assert.ok(Math.abs(t[ben.did] - 1.618034) < 1e-3, `Ben ${t[ben.did]}`)
  assert.ok(t[ana.did] < t[ben.did] && t[ana.did] > t[ben.did] + cleoPart - 1e-3, `Ana ${t[ana.did]}`)
  assert.equal(t[cleo.did], 0)
  // The exact fixed point, recomputed from the rule itself.
  const wBen = reviewerWeight(1, t[ben.did], scoring)
  const wAna = reviewerWeight(1, t[ana.did], scoring)
  assert.ok(Math.abs(t[ana.did] - (wBen + cleoPart)) < 1e-6)
  assert.ok(Math.abs(t[ben.did] - wAna) < 1e-6)
  assert.ok(s.rounds < 100, `converged in ${s.rounds} rounds`)
  const cleoReview = s.reviews.find((v) => v.reviewer === cleo.did)!
  assert.equal(cleoReview.evidence.note, 'noReceipt')
  assert.equal(cleoReview.reviewerWeight, 0.05, 'her badge is not counted, so the floor')
  assert.deepEqual(s.trust.find((x) => x.did === ana.did)!.reviews, { received: 2, counted: 2, withReceipt: 1 })
})

test('trust: repeating yourself or inventing deal ids adds nothing; self-reviews are ignored', () => {
  const spam = Array.from({ length: 20 }, (_, i) => review(ben.did, ana.did, { dealId: i.toString(16).padStart(64, '0'), rating: 5 }))
  const s = compute({ profiles: [ana, ben], badges: [badge(ben.did, ben.wallet)], receipts: [], reviews: spam }, settings)
  assert.equal(s.reviews.filter((v) => v.counted).length, 1, 'only the latest no-receipt review counts')
  assert.ok(Math.abs(s.trust.find((x) => x.did === ana.did)!.value - 0.05) < 1e-9, '1 × 0.05 × 1')

  const self = review(ana.did, ana.did)
  const t = compute({ profiles: [ana], badges: [badge(ana.did, ana.wallet)], receipts: [], reviews: [self] }, settings)
  assert.equal(t.trust[0].value, 0)
  assert.equal(t.reviews[0].skipped, 'self')
})

test('trust: a bad review with a receipt lowers trust below zero; no rating is neutral', () => {
  const deal = receipt()
  const bad = compute(
    { profiles: [ana, ben], badges: [badge(ben.did, ben.wallet)], receipts: [deal], reviews: [review(ben.did, ana.did, { dealId: deal.escrow, rating: 1 })] },
    settings,
  )
  assert.equal(bad.trust.find((x) => x.did === ana.did)!.value, -1)
  const thin = compute(
    { profiles: [ana, ben], badges: [badge(ben.did, ben.wallet)], receipts: [deal], reviews: [review(ben.did, ana.did, { dealId: deal.escrow, rating: null })] },
    settings,
  )
  assert.equal(thin.trust.find((x) => x.did === ana.did)!.value, 0)
})

// What the client computes, with no chain: the bytes it writes, the bytes it reads back, the
// options check, the timer, and the pay link. The LiteSVM tests write the same bytes by hand in
// Rust, and the validator test sends these through the real program; if either side drifted, one
// of the three fails.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPS,
  ESCROW_LEN,
  MAX_TIMER_DAYS,
  NATIVE_MINT,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  VERSION,
  arbitrateIx,
  assertOptionsAgreed,
  associatedTokenAddress,
  awaitingPayment,
  closeUnfundedIx,
  creatorKey,
  createArgsBytes,
  createAndFund,
  createIx,
  decodeEscrow,
  decodeEvent,
  decodeEvents,
  depositAddress,
  discriminator,
  escrowAddress,
  formatAmount,
  funds,
  invoice,
  invoiceIx,
  keysFor,
  keysOf,
  makeDepositAddressIx,
  makeRefundAddressIx,
  markFundedIx,
  optionsFromPost,
  optionsNotAgreed,
  payInOneTap,
  payoutAddress,
  payout,
  randomId,
  recoverLateIx,
  refundAddress,
  releaseToBuyerIx,
  releaseToSellerIx,
  share,
  solanaPayUrl,
  splitIx,
  sweepRentIx,
  termsFor,
  timerDue,
  timerDueAt,
  timerReleaseIx,
  validateTerms,
  vaultAddress,
  type EscrowAccount,
  type Terms,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const DAY = 86_400n
const T0 = 1_800_000_000n

const buyer = Keypair.generate().publicKey
const seller = Keypair.generate().publicKey
const arbiter = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const payer = Keypair.generate().publicKey
const stranger = Keypair.generate().publicKey

/** An escrow account as `decodeEscrow` would return it: the buyer's, open, unfunded, every option off. */
function escrowAccount(over: Partial<EscrowAccount> = {}): EscrowAccount {
  const escrow = escrowAddress(buyer, 7n)
  return {
    version: 1,
    id: 7n,
    buyer,
    seller,
    arbiter: null,
    mint,
    vault: vaultAddress(escrow, mint),
    rentRecipient: buyer,
    amount: 1_000_000n,
    creator: 'buyer',
    timer: null,
    createdAt: T0,
    fundedAt: null,
    status: 'open',
    bump: 255,
    endedAt: null,
    outcome: null,
    toSeller: 0n,
    toBuyer: 0n,
    ...over,
  }
}

/** The same, opened by the seller: an invoice, at the seller's address, its rent back to the seller. */
function invoiceAccount(over: Partial<EscrowAccount> = {}): EscrowAccount {
  const escrow = escrowAddress(seller, 7n)
  return escrowAccount({ creator: 'seller', vault: vaultAddress(escrow, mint), rentRecipient: seller, ...over })
}

function terms(over: Partial<Terms> = {}): Terms {
  return { id: 7n, seller, amount: 1_000_000n, arbiter: null, timer: null, ...over }
}

const meta = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])

test('the program id, the seed and the size are the ones the program bakes in', () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  const state = readFileSync(join(here, '../../program/src/state.rs'), 'utf8')
  assert.ok(lib.includes(`declare_id!("${PROGRAM_ID.toBase58()}")`))
  assert.ok(lib.includes(`pub const VERSION: u8 = ${VERSION};`))
  assert.ok(lib.includes('pub const ESCROW_SEED: &[u8] = b"escrow";'))
  assert.ok(lib.includes(`pub const NATIVE_MINT: Pubkey = pubkey!("${NATIVE_MINT.toBase58()}");`))
  assert.ok(lib.includes(`assert!(Escrow::LEN == ${ESCROW_LEN});`))
  assert.ok(state.includes('pub const BPS: u16 = 10_000;'))
  assert.ok(state.includes('pub timer_days: u16,'), 'the timer is sixteen bits of days')
  assert.equal(BPS, 10_000)
  assert.equal(MAX_TIMER_DAYS, 0xffff)
})

test('the discriminators are pinned', () => {
  const ixs: Record<string, string> = {
    create: '181ec828051c0777',
    mark_funded: '9a19863dc8b81d38',
    release_to_seller: 'da5329093136ff38',
    release_to_buyer: '91d4dc55139c198a',
    split: '7cbd1b2bd8289342',
    arbitrate: '695b6e96d80b8e8e',
    timer_release: '6121b42562d607cf',
    close_unfunded: '06d9705bfa5c6746',
    recover_late: '525629b57534cce3',
    sweep_rent: '11ea3af1fb9487b9',
  }
  for (const [name, want] of Object.entries(ixs)) assert.equal(hex(discriminator('global', name)), want, name)
  const events: Record<string, string> = {
    Created: '41fe44f56694f44c',
    Funded: '43543858c00cc9b1',
    Ended: '467b96d69c092dc5',
    Closed: '321f579b87dcc3ef',
    RecoveredLate: 'bd249dc10194f8ce',
    RentSwept: 'cb5605b151a70c19',
  }
  for (const [name, want] of Object.entries(events)) assert.equal(hex(discriminator('event', name)), want, name)
  assert.equal(hex(discriminator('account', 'Escrow')), '1fd57bbbba16da9b')
})

test('the deposit address is the standard associated token account of the escrow', () => {
  const escrow = escrowAddress(buyer, 7n)
  assert.ok(!PublicKey.isOnCurve(escrow.toBytes()), 'a program-derived address')
  const vault = vaultAddress(escrow, mint)
  assert.deepEqual(vault, getAssociatedTokenAddressSync(mint, escrow, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
  assert.deepEqual(depositAddress(escrow, mint), vault)
  assert.deepEqual(refundAddress(buyer, mint), getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
  assert.deepEqual(payoutAddress(seller, mint), getAssociatedTokenAddressSync(mint, seller, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
  // Distinct per id and per creator.
  assert.notDeepEqual(escrowAddress(buyer, 8n), escrow)
  assert.notDeepEqual(escrowAddress(seller, 7n), escrow)
  // Random ids are 64 bits and do not repeat.
  const ids = new Set(Array.from({ length: 100 }, () => randomId()))
  assert.equal(ids.size, 100)
  for (const id of ids) assert.ok(id >= 0n && id < 1n << 64n)
})

test('create carries exactly the bytes the program reads', () => {
  const t = terms({ arbiter, timer: { days: 14, to: 'seller' } })
  const bytes = createArgsBytes(t, buyer)
  // id 8, buyer 32, seller 32, amount 8, arbiter 1+32, timer 1+2+1.
  assert.equal(bytes.length, 8 + 32 + 32 + 8 + 33 + 4)
  const v = new DataView(bytes.buffer, bytes.byteOffset)
  assert.equal(v.getBigUint64(0, true), 7n)
  assert.deepEqual(new PublicKey(bytes.subarray(8, 40)), buyer)
  assert.deepEqual(new PublicKey(bytes.subarray(40, 72)), seller)
  assert.equal(v.getBigUint64(72, true), 1_000_000n)
  assert.equal(bytes[80], 1)
  assert.deepEqual(new PublicKey(bytes.subarray(81, 113)), arbiter)
  assert.equal(bytes[113], 1)
  assert.equal(v.getUint16(114, true), 14)
  assert.equal(bytes[116], 1, 'the seller is side 1')
  assert.equal(createArgsBytes(terms({ timer: { days: 1, to: 'buyer' } }), buyer).at(-1), 0, 'the buyer is side 0')

  // Every option off: one byte each.
  const bare = createArgsBytes(terms(), buyer)
  assert.equal(bare.length, 8 + 32 + 32 + 8 + 1 + 1)
  assert.deepEqual([bare[80], bare[81]], [0, 0])

  const ix = createIx({ buyer, payer, mint, terms: t })
  assert.deepEqual(ix.programId, PROGRAM_ID)
  assert.equal(hex(ix.data.subarray(0, 8)), '181ec828051c0777')
  assert.equal(hex(ix.data.subarray(8)), hex(bytes))
  const escrow = escrowAddress(buyer, 7n)
  assert.deepEqual(meta(ix), [
    [escrow.toBase58(), false, true],
    [vaultAddress(escrow, mint).toBase58(), false, true],
    [buyer.toBase58(), true, false],
    [payer.toBase58(), true, true],
    [mint.toBase58(), false, false],
    [TOKEN_PROGRAM_ID.toBase58(), false, false],
    [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
    ['11111111111111111111111111111111', false, false],
  ])

  // An invoice: the same bytes, with the seller in the creator's slot, at the seller's address.
  const inv = invoiceIx({ seller, buyer, payer, mint, terms: t })
  assert.equal(hex(inv.data), hex(ix.data))
  const invoiced = escrowAddress(seller, 7n)
  assert.notDeepEqual(invoiced, escrow)
  assert.deepEqual(inv.keys[0].pubkey, invoiced)
  assert.deepEqual(inv.keys[1].pubkey, vaultAddress(invoiced, mint))
  assert.deepEqual([inv.keys[2].pubkey.toBase58(), inv.keys[2].isSigner], [seller.toBase58(), true])
  assert.throws(() => createIx({ buyer, payer, mint, terms: t, creator: arbiter }), /NotAParty/)
  assert.throws(() => createIx({ buyer, payer, mint: NATIVE_MINT, terms: t }), /NativeMint/)
  assert.throws(() => invoiceIx({ seller: arbiter, buyer, payer, mint, terms: t }), /its own seller/)

  // Neither party may be the escrow itself or its deposit address, from either creator.
  for (const party of [escrow, vaultAddress(escrow, mint)]) {
    assert.throws(() => createIx({ buyer, payer, mint, terms: terms({ seller: party }) }), /PartyIsTheEscrow/)
  }
  for (const party of [invoiced, vaultAddress(invoiced, mint)]) {
    assert.throws(() => invoiceIx({ seller, buyer: party, payer, mint, terms: t }), /PartyIsTheEscrow/)
  }
})

test('bad terms fail before a transaction is built, with the program\'s own error names', () => {
  const cases: [string, Terms, PublicKey, RegExp][] = [
    ['buyer is seller', terms({ seller: buyer }), buyer, /SameParty/],
    ['zero buyer', terms(), PublicKey.default, /EmptyKey/],
    ['zero seller', terms({ seller: PublicKey.default }), buyer, /EmptyKey/],
    ['zero arbiter', terms({ arbiter: PublicKey.default }), buyer, /EmptyKey/],
    ['amount zero', terms({ amount: 0n }), buyer, /AmountZero/],
    ['a timer of 0 days', terms({ timer: { days: 0, to: 'seller' } }), buyer, /TimerZero/],
    ['a timer of 65,536 days', terms({ timer: { days: 65_536, to: 'seller' } }), buyer, /TimerZero/],
    ['a timer of 1.5 days', terms({ timer: { days: 1.5, to: 'seller' } }), buyer, /TimerZero/],
    ['a timer to nobody', terms({ timer: { days: 1, to: 'arbiter' as 'seller' } }), buyer, /buyer or the seller/],
    ['an amount over 64 bits', terms({ amount: 1n << 64n }), buyer, /64 bits/],
  ]
  for (const [what, t, b, want] of cases) assert.throws(() => validateTerms(t, b), want, what)
  // The arbiter may be either party; the longest timer is fine.
  validateTerms(terms({ arbiter: buyer, timer: { days: MAX_TIMER_DAYS, to: 'buyer' } }), buyer)
  validateTerms(terms({ arbiter: seller }), buyer)
})

test('each way out names the accounts it pays and the keys that sign it', () => {
  const account = escrowAccount({ arbiter })
  const k = keysOf(account)
  const escrow = escrowAddress(buyer, 7n)
  assert.deepEqual(k, { escrow, vault: vaultAddress(escrow, mint), buyer, seller, mint, rentRecipient: buyer })
  assert.deepEqual(keysFor({ buyer, mint, terms: terms() }), k, 'from the terms, the same keys')
  // An invoice's keys: its address and its rent recipient are the seller's.
  const invoiced = escrowAddress(seller, 7n)
  const ik = { escrow: invoiced, vault: vaultAddress(invoiced, mint), buyer, seller, mint, rentRecipient: seller }
  assert.deepEqual(keysOf(invoiceAccount()), ik)
  assert.deepEqual(keysFor({ buyer, mint, terms: terms(), creator: seller }), ik)
  assert.deepEqual([creatorKey(account), creatorKey(invoiceAccount())], [buyer, seller])
  const refund = refundAddress(buyer, mint).toBase58()
  const sellers = payoutAddress(seller, mint).toBase58()
  const head = [
    [escrow.toBase58(), false, true],
    [vaultAddress(escrow, mint).toBase58(), false, true],
  ]
  // Every rent refund to the creator: the buyer, here.
  const tail = [
    [buyer.toBase58(), false, true],
    [TOKEN_PROGRAM_ID.toBase58(), false, false],
  ]

  const toSeller = releaseToSellerIx({ keys: k })
  assert.equal(hex(toSeller.data), 'da5329093136ff38')
  assert.deepEqual(meta(toSeller), [...head, [sellers, false, true], ...tail, [buyer.toBase58(), true, false]], 'the seller paid at its standard account')

  const toBuyer = releaseToBuyerIx({ keys: k })
  assert.equal(hex(toBuyer.data), '91d4dc55139c198a')
  assert.deepEqual(meta(toBuyer), [...head, [refund, false, true], ...tail, [seller.toBase58(), true, false]])

  const split = splitIx({ keys: k, sellerBps: 7_000 })
  assert.equal(hex(split.data), '7cbd1b2bd8289342' + '581b')
  assert.deepEqual(meta(split), [...head, [refund, false, true], [sellers, false, true], ...tail, [buyer.toBase58(), true, false], [seller.toBase58(), true, false]])

  const arb = arbitrateIx({ keys: k, arbiter, sellerBps: 2_500 })
  assert.equal(hex(arb.data), '695b6e96d80b8e8e' + 'c409')
  assert.deepEqual(meta(arb), [...head, [refund, false, true], [sellers, false, true], ...tail, [arbiter.toBase58(), true, false]])
  for (const bps of [-1, 10_001, 1.5]) {
    assert.throws(() => splitIx({ keys: k, sellerBps: bps }), /BadSplit/)
    assert.throws(() => arbitrateIx({ keys: k, arbiter, sellerBps: bps }), /BadSplit/)
  }

  const close = closeUnfundedIx({ keys: k, closer: seller })
  assert.equal(hex(close.data), '06d9705bfa5c6746')
  assert.deepEqual(meta(close), [...head, [refund, false, true], ...tail, [seller.toBase58(), true, false]])
  assert.deepEqual(meta(closeUnfundedIx({ keys: k, closer: buyer })).at(-1), [buyer.toBase58(), true, false], 'the buyer closing: its key twice')
  for (const closer of [payer, arbiter, stranger]) assert.throws(() => closeUnfundedIx({ keys: k, closer }), /NotACloser/)

  const mark = markFundedIx({ escrow, vault: k.vault })
  assert.deepEqual(meta(mark), [[escrow.toBase58(), false, true], [k.vault.toBase58(), false, false]])
  assert.deepEqual(meta(sweepRentIx({ escrow, rentRecipient: buyer })), [[escrow.toBase58(), false, true], [buyer.toBase58(), false, true]])
})

test('the timer pays the side it names, and its builder refuses what the program would', () => {
  const k = keysOf(escrowAccount())
  const funded = { status: 'funded' as const, fundedAt: T0 }
  const toSeller = timerReleaseIx({ account: escrowAccount({ ...funded, timer: { days: 3, to: 'seller' } }) })
  assert.equal(hex(toSeller.data), '6121b42562d607cf')
  assert.deepEqual(
    meta(toSeller),
    [
      [k.escrow.toBase58(), false, true],
      [k.vault.toBase58(), false, true],
      [payoutAddress(seller, mint).toBase58(), false, true],
      [buyer.toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ],
    'no signer: anyone may send it; the seller paid at its standard account',
  )
  const toBuyer = timerReleaseIx({ account: escrowAccount({ ...funded, timer: { days: 3, to: 'buyer' } }) })
  assert.deepEqual(toBuyer.keys[2].pubkey, refundAddress(buyer, mint))
  // An invoice's timer: its address and its rent recipient are the seller's.
  const inv = timerReleaseIx({ account: invoiceAccount({ ...funded, timer: { days: 1, to: 'seller' } }) })
  assert.deepEqual([inv.keys[0].pubkey, inv.keys[2].pubkey, inv.keys[3].pubkey], [escrowAddress(seller, 7n), payoutAddress(seller, mint), seller])
  assert.throws(() => timerReleaseIx({ account: escrowAccount(funded) }), /NoTimer/)
  assert.throws(() => timerReleaseIx({ account: escrowAccount({ timer: { days: 3, to: 'seller' } }) }), /FundingNotMarked/)
  assert.throws(() => timerReleaseIx({ account: escrowAccount({ status: 'ended', timer: { days: 3, to: 'seller' } }) }), /Ended/)

  // Due to the second, from the mark.
  const e = escrowAccount({ ...funded, timer: { days: 3, to: 'seller' } })
  assert.equal(timerDueAt(e), T0 + 3n * DAY)
  assert.equal(timerDue(e, T0 + 3n * DAY - 1n), false)
  assert.equal(timerDue(e, T0 + 3n * DAY), true)
  assert.equal(timerDueAt(escrowAccount({ timer: { days: 3, to: 'seller' } })), null, 'not marked')
  assert.equal(timerDueAt(escrowAccount(funded)), null, 'no timer')
  assert.equal(timerDueAt(escrowAccount({ ...funded, status: 'ended', timer: { days: 3, to: 'seller' } })), null, 'ended')
})

test('pay in one tap: the deposit address made first, create, a plain transfer of the amount, and the buyer\'s release', () => {
  const t = terms()
  const k = keysFor({ buyer, mint, terms: t })
  const ixs = payInOneTap({ buyer, payer, mint, terms: t })
  assert.equal(ixs.length, 4)
  const [deposit, create, transfer, release] = ixs
  // The deposit address, made by the associated token program at the top of the transaction, the
  // payer paying: a fee payer that checks every transfer's destination finds it made.
  assert.deepEqual(deposit.programId, ASSOCIATED_TOKEN_PROGRAM_ID)
  assert.equal(hex(deposit.data), '01', 'the idempotent create')
  assert.deepEqual(meta(deposit), [
    [payer.toBase58(), true, true],
    [k.vault.toBase58(), false, true],
    [k.escrow.toBase58(), false, false],
    [mint.toBase58(), false, false],
    ['11111111111111111111111111111111', false, false],
    [TOKEN_PROGRAM_ID.toBase58(), false, false],
  ])
  assert.deepEqual(meta(deposit), meta(makeDepositAddressIx({ payer, escrow: k.escrow, mint })))
  assert.equal(hex(create.data), hex(createIx({ buyer, payer, mint, terms: t }).data))
  assert.deepEqual(meta(create), meta(createIx({ buyer, payer, mint, terms: t })))
  assert.deepEqual(transfer.programId, TOKEN_PROGRAM_ID)
  assert.equal(hex(transfer.data), '03' + '40420f0000000000')
  assert.deepEqual(meta(transfer), [
    [associatedTokenAddress(buyer, mint).toBase58(), false, true],
    [k.vault.toBase58(), false, true],
    [buyer.toBase58(), true, false],
  ])
  assert.deepEqual(meta(release), meta(releaseToSellerIx({ keys: k })))
  const from = Keypair.generate().publicKey
  assert.deepEqual(payInOneTap({ buyer, payer, mint, terms: t, from })[2].keys[0].pubkey, from)

  // Funding in the same transaction without releasing: the same first three.
  const funded = createAndFund({ buyer, payer, mint, terms: t })
  assert.deepEqual(funded.map(meta), ixs.slice(0, 3).map(meta))
  assert.deepEqual(createAndFund({ buyer, payer, mint, terms: t, from })[2].keys[0].pubkey, from)

  // The buyer's standard account, made when a way out pays the buyer.
  const make = makeRefundAddressIx({ payer, buyer, mint })
  assert.deepEqual(make.programId, ASSOCIATED_TOKEN_PROGRAM_ID)
  assert.deepEqual(make.keys[1].pubkey, refundAddress(buyer, mint))
  assert.equal(hex(make.data), '01')
})

test('late money and the rent sweep: their accounts, and what the builders refuse', () => {
  const ended = escrowAccount({ status: 'ended', outcome: 'releasedToSeller', endedAt: T0 })
  const ix = recoverLateIx({ account: ended, caller: stranger })
  assert.equal(hex(ix.data), '525629b57534cce3')
  const escrow = escrowAddress(buyer, 7n)
  assert.deepEqual(meta(ix), [
    [escrow.toBase58(), false, false],
    [ended.vault.toBase58(), false, true],
    [buyer.toBase58(), false, true],
    [refundAddress(buyer, mint).toBase58(), false, true],
    [mint.toBase58(), false, false],
    [stranger.toBase58(), true, true],
    [TOKEN_PROGRAM_ID.toBase58(), false, false],
    [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
    ['11111111111111111111111111111111', false, false],
  ])
  assert.throws(() => recoverLateIx({ account: escrowAccount(), caller: stranger }), /NotEnded/)
  // An invoice's late money: the escrow at the seller's address, still back to the buyer.
  const late = recoverLateIx({ account: invoiceAccount({ status: 'ended', outcome: 'releasedToSeller', endedAt: T0 }), caller: stranger })
  assert.deepEqual([late.keys[0].pubkey, late.keys[2].pubkey, late.keys[3].pubkey], [escrowAddress(seller, 7n), buyer, refundAddress(buyer, mint)])
})

/** An escrow account's bytes, at the pinned offsets. */
function escrowBytes(o: {
  arbiter?: PublicKey
  rentRecipient?: PublicKey
  creator?: number
  timerDays?: number
  timerTo?: number
  fundedAt?: bigint
  status?: number
  endedAt?: bigint
  outcome?: number
  toSeller?: bigint
  toBuyer?: bigint
} = {}): Uint8Array {
  const data = Buffer.alloc(8 + ESCROW_LEN)
  Buffer.from(discriminator('account', 'Escrow')).copy(data, 0)
  const b = data.subarray(8)
  const escrow = escrowAddress(buyer, 7n)
  b[0] = 1
  b.writeBigUInt64LE(7n, 1)
  buyer.toBuffer().copy(b, 9)
  seller.toBuffer().copy(b, 41)
  ;(o.arbiter ?? PublicKey.default).toBuffer().copy(b, 73)
  mint.toBuffer().copy(b, 105)
  vaultAddress(escrow, mint).toBuffer().copy(b, 137)
  ;(o.rentRecipient ?? buyer).toBuffer().copy(b, 169)
  b.writeBigUInt64LE(1_000_000n, 201)
  b[209] = o.creator ?? 0
  b.writeUInt16LE(o.timerDays ?? 0, 210)
  b[212] = o.timerTo ?? 0
  b.writeBigInt64LE(T0, 213)
  b.writeBigInt64LE(o.fundedAt ?? 0n, 221)
  b[229] = o.status ?? 0
  b[230] = 254
  b.writeBigInt64LE(o.endedAt ?? 0n, 231)
  b[239] = o.outcome ?? 0
  b.writeBigUInt64LE(o.toSeller ?? 0n, 240)
  b.writeBigUInt64LE(o.toBuyer ?? 0n, 248)
  return new Uint8Array(data)
}

test('the escrow account decodes at the pinned offsets', () => {
  assert.deepEqual(decodeEscrow(escrowBytes()), escrowAccount({ bump: 254 }))
  const e = decodeEscrow(
    escrowBytes({ arbiter, rentRecipient: seller, creator: 1, timerDays: 7, timerTo: 1, fundedAt: T0 + 60n, status: 2, endedAt: T0 + DAY, outcome: 4, toSeller: 1_000_003n, toBuyer: 0n }),
  )
  assert.deepEqual(e, {
    ...escrowAccount({ bump: 254 }),
    arbiter,
    rentRecipient: seller,
    creator: 'seller',
    timer: { days: 7, to: 'seller' },
    fundedAt: T0 + 60n,
    status: 'ended',
    endedAt: T0 + DAY,
    outcome: 'timerReleased',
    toSeller: 1_000_003n,
  })
  // Each outcome, by its byte.
  const outcomes = ['releasedToSeller', 'releasedToBuyer', 'split', 'arbitrated', 'timerReleased']
  outcomes.forEach((name, i) => assert.equal(decodeEscrow(escrowBytes({ status: 2, outcome: i })).outcome, name))
  // An ended receipt nobody marked: no funding time.
  assert.equal(decodeEscrow(escrowBytes({ status: 2 })).fundedAt, null)
  assert.equal(decodeEscrow(escrowBytes({ status: 1, fundedAt: T0 })).status, 'funded')
  // Refusals.
  assert.throws(() => decodeEscrow(escrowBytes().subarray(1)), /bytes/)
  const wrong = escrowBytes()
  wrong[0] ^= 1
  assert.throws(() => decodeEscrow(wrong), /not an escrow/)
  assert.throws(() => decodeEscrow(escrowBytes({ status: 3 })), /status/)
  assert.throws(() => decodeEscrow(escrowBytes({ status: 2, outcome: 5 })), /outcome/)
  assert.throws(() => decodeEscrow(escrowBytes({ creator: 2 })), /side/)
})

function eventBytes(name: string, size: number, fill: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(size)
  Buffer.from(discriminator('event', name)).copy(b, 0)
  escrowAddress(buyer, 7n).toBuffer().copy(b, 8)
  fill(b)
  return b
}

test('events decode from the log, in order', () => {
  const escrow = escrowAddress(buyer, 7n)
  const vault = vaultAddress(escrow, mint)
  const created = eventBytes('Created', 261, (b) => {
    b[40] = 1
    b.writeBigUInt64LE(7n, 41)
    buyer.toBuffer().copy(b, 49)
    seller.toBuffer().copy(b, 81)
    b[113] = 1
    arbiter.toBuffer().copy(b, 114)
    mint.toBuffer().copy(b, 146)
    vault.toBuffer().copy(b, 178)
    seller.toBuffer().copy(b, 210)
    b.writeBigUInt64LE(1_000_000n, 242)
    b.writeUInt16LE(3, 250)
    b[252] = 0
    b.writeBigInt64LE(T0, 253)
  })
  const funded = eventBytes('Funded', 56, (b) => {
    b.writeBigUInt64LE(1_000_000n, 40)
    b.writeBigInt64LE(T0 + 60n, 48)
  })
  const ended = eventBytes('Ended', 121, (b) => {
    b[40] = 2
    b.writeBigUInt64LE(1_000_000n, 41)
    b.writeBigUInt64LE(1_000_003n, 49)
    b.writeBigUInt64LE(700_002n, 57)
    b.writeBigUInt64LE(300_001n, 65)
    b.writeBigInt64LE(T0 + DAY, 73)
    seller.toBuffer().copy(b, 81)
    b.writeBigUInt64LE(2_039_280n, 113)
  })
  const closed = eventBytes('Closed', 120, (b) => {
    seller.toBuffer().copy(b, 40)
    b.writeBigUInt64LE(5n, 72)
    seller.toBuffer().copy(b, 80)
    b.writeBigUInt64LE(4_767_600n, 112)
  })
  const late = eventBytes('RecoveredLate', 56, (b) => {
    b.writeBigUInt64LE(400_000n, 40)
    b.writeBigUInt64LE(2_039_280n, 48)
  })
  const swept = eventBytes('RentSwept', 56, (b) => {
    b.writeBigUInt64LE(2_455_488n, 40)
    b.writeBigUInt64LE(272_832n, 48)
  })
  const id = PROGRAM_ID.toBase58()
  const logs = [
    `Program ${id} invoke [1]`,
    `Program data: ${created.toString('base64')}`,
    'Program log: something else',
    `Program data: ${funded.toString('base64')}`,
    `Program data: ${ended.toString('base64')}`,
    `Program data: ${closed.toString('base64')}`,
    `Program data: ${late.toString('base64')}`,
    `Program data: ${swept.toString('base64')}`,
    'Program data: AAAA',
    `Program ${id} success`,
  ]
  assert.deepEqual(decodeEvents(logs), [
    {
      kind: 'created',
      escrow,
      version: 1,
      id: 7n,
      buyer,
      seller,
      creator: 'seller',
      arbiter,
      mint,
      vault,
      rentRecipient: seller,
      amount: 1_000_000n,
      timer: { days: 3, to: 'buyer' },
      createdAt: T0,
    },
    { kind: 'funded', escrow, balance: 1_000_000n, fundedAt: T0 + 60n },
    {
      kind: 'ended',
      escrow,
      outcome: 'split',
      amount: 1_000_000n,
      balance: 1_000_003n,
      toSeller: 700_002n,
      toBuyer: 300_001n,
      endedAt: T0 + DAY,
      rentRecipient: seller,
      rentLamports: 2_039_280n,
    },
    { kind: 'closed', escrow, closedBy: seller, toBuyer: 5n, rentRecipient: seller, rentLamports: 4_767_600n },
    { kind: 'recoveredLate', escrow, toBuyer: 400_000n, rentLamports: 2_039_280n },
    { kind: 'rentSwept', escrow, lamports: 2_455_488n, left: 272_832n },
  ])
  // A Created with no options.
  const bare = Buffer.from(created)
  PublicKey.default.toBuffer().copy(bare, 114)
  bare.writeUInt16LE(0, 250)
  const e = decodeEvent(new Uint8Array(bare))
  assert.ok(e?.kind === 'created' && e.arbiter === null && e.timer === null)
  assert.equal(decodeEvent(new Uint8Array(7)), null)
  assert.throws(() => decodeEvent(new Uint8Array([...ended, 0])), /trailing/)
})

test('an event only counts when the escrow program itself wrote it', () => {
  // Any program can write a `Program data:` line with an escrow event's exact bytes: a receipt
  // for a deal that never happened, at any address. The runtime's own invoke and success lines
  // say which program wrote each line, and no program can forge those.
  const ended = eventBytes('Ended', 121, (b) => {
    b.writeBigUInt64LE(10_000_000_000n, 41)
    b.writeBigUInt64LE(10_000_000_000n, 49)
    b.writeBigUInt64LE(10_000_000_000n, 57)
  })
  const line = `Program data: ${ended.toString('base64')}`
  const forger = 'Forger1111111111111111111111111111111111111'
  const token = TOKEN_PROGRAM_ID.toBase58()
  const id = PROGRAM_ID.toBase58()

  // Written by another program, alone or around a real escrow instruction.
  assert.deepEqual(decodeEvents([`Program ${forger} invoke [1]`, line, `Program ${forger} success`]), [])
  assert.deepEqual(decodeEvents([`Program ${id} invoke [1]`, `Program ${id} success`, `Program ${forger} invoke [1]`, line, `Program ${forger} success`]), [])
  // Written by a program the escrow called, while the escrow waits.
  assert.deepEqual(decodeEvents([`Program ${id} invoke [1]`, `Program ${token} invoke [2]`, line, `Program ${token} success`, `Program ${id} success`]), [])
  // A line with no program open at all.
  assert.deepEqual(decodeEvents([line]), [])
  // The escrow's own, after its call into the token program returned, counts; so does the
  // escrow's own when another program called it.
  assert.equal(decodeEvents([`Program ${id} invoke [1]`, `Program ${token} invoke [2]`, `Program ${token} success`, line, `Program ${id} success`]).length, 1)
  assert.equal(decodeEvents([`Program ${forger} invoke [1]`, `Program ${id} invoke [2]`, line, `Program ${id} success`, `Program ${forger} success`]).length, 1)
  // Another deployment of the same code, at another address, is another program.
  assert.deepEqual(decodeEvents([`Program ${id} invoke [1]`, line, `Program ${id} success`], new PublicKey(token)), [])
})

test('terms come from a post\'s optional terms block: every option off unless set', () => {
  assert.deepEqual(optionsFromPost(undefined), { arbiter: null, timer: null })
  assert.deepEqual(optionsFromPost(null), { arbiter: null, timer: null })
  assert.deepEqual(optionsFromPost({}), { arbiter: null, timer: null })
  assert.deepEqual(optionsFromPost({ arbiter: arbiter.toBase58() }), { arbiter, timer: null })
  assert.deepEqual(optionsFromPost({ timer: { days: 7, to: 'seller' } }), { arbiter: null, timer: { days: 7, to: 'seller' } })
  // An old post's leftover keys pass and mean nothing.
  assert.deepEqual(optionsFromPost({ autoReleaseDays: 7, cancellationSteps: [] }), { arbiter: null, timer: null })
  for (const [what, bad, want] of [
    ['an arbiter that is not a key', { arbiter: 'not a key' }, /./],
    ['an arbiter that is not a string', { arbiter: 7 }, /base58/],
    ['the zero key', { arbiter: PublicKey.default.toBase58() }, /EmptyKey/],
    ['zero days', { timer: { days: 0, to: 'seller' } }, /whole number/],
    ['too many days', { timer: { days: 65_536, to: 'buyer' } }, /whole number/],
    ['half a day', { timer: { days: 0.5, to: 'buyer' } }, /whole number/],
    ['a timer to the arbiter', { timer: { days: 1, to: 'arbiter' } }, /seller" or "buyer/],
    ['a timer with no side', { timer: { days: 1 } }, /seller" or "buyer/],
  ] as const) {
    assert.throws(() => optionsFromPost(bad as never), want, what)
  }
  const t = termsFor({ arbiter: arbiter.toBase58(), timer: { days: 3, to: 'buyer' } }, { seller, amount: 5n, id: 9n })
  assert.deepEqual(t, { id: 9n, seller, amount: 5n, arbiter, timer: { days: 3, to: 'buyer' } })
  const fresh = termsFor(undefined, { seller, amount: 5n })
  assert.deepEqual([fresh.arbiter, fresh.timer], [null, null])
  assert.ok(fresh.id >= 0n)
})

test('before working or paying, a person sees every option they did not set', () => {
  const none = { arbiter: null, timer: null }
  // Nothing set, nothing there.
  assert.deepEqual(optionsNotAgreed({ escrow: escrowAccount(), me: 'seller', agreed: none }), [])
  assert.deepEqual(optionsNotAgreed({ escrow: escrowAccount(), me: 'buyer', agreed: null }), [])

  // The buyer names itself arbiter and a one-day timer back to itself; the seller agreed to none.
  const rigged = escrowAccount({ arbiter: buyer, timer: { days: 1, to: 'buyer' } })
  assert.deepEqual(optionsNotAgreed({ escrow: rigged, me: 'seller', agreed: null }), [
    { option: 'arbiter', kind: 'added', arbiter: buyer, holder: 'otherParty' },
    { option: 'timer', kind: 'added', timer: { days: 1, to: 'buyer' }, favours: 'otherParty' },
  ])
  // The same escrow, seen by the buyer who made it from its own post: nothing to show.
  const post = { arbiter: buyer.toBase58(), timer: { days: 1, to: 'buyer' as const } }
  assert.deepEqual(optionsNotAgreed({ escrow: rigged, me: 'buyer', agreed: post }), [])

  // An invoice with a shorter timer than the offer said, and a third-party arbiter the buyer
  // expected but another one named.
  const offer = { arbiter: arbiter.toBase58(), timer: { days: 7, to: 'seller' as const } }
  const invoiced = escrowAccount({ creator: 'seller', arbiter: stranger, timer: { days: 1, to: 'seller' } })
  assert.deepEqual(optionsNotAgreed({ escrow: invoiced, me: 'buyer', agreed: offer }), [
    { option: 'arbiter', kind: 'changed', arbiter: stranger, holder: 'thirdParty' },
    { option: 'timer', kind: 'changed', timer: { days: 1, to: 'seller' }, favours: 'otherParty' },
  ])
  // An option agreed and missing.
  assert.deepEqual(optionsNotAgreed({ escrow: escrowAccount(), me: 'buyer', agreed: offer }), [
    { option: 'arbiter', kind: 'removed', expected: arbiter },
    { option: 'timer', kind: 'removed', expected: { days: 7, to: 'seller' } },
  ])
  // The person's own key as arbiter, and a timer in their favour, are still shown if not set.
  assert.deepEqual(optionsNotAgreed({ escrow: escrowAccount({ arbiter: seller, timer: { days: 2, to: 'seller' } }), me: 'seller', agreed: none }), [
    { option: 'arbiter', kind: 'added', arbiter: seller, holder: 'me' },
    { option: 'timer', kind: 'added', timer: { days: 2, to: 'seller' }, favours: 'me' },
  ])
  assert.throws(() => assertOptionsAgreed({ escrow: rigged, me: 'seller', agreed: null }), /arbiter not agreed \(otherParty\).*timer not agreed: 1 days to the buyer/)
  assertOptionsAgreed({ escrow: rigged, me: 'buyer', agreed: optionsFromPost(post) })
})

test('payouts: the whole balance, the seller\'s share of a split rounded down', () => {
  assert.deepEqual(payout(1_000_003n, 5_000), { toSeller: 500_001n, toBuyer: 500_002n })
  assert.deepEqual(payout(1_000_003n, 10_000), { toSeller: 1_000_003n, toBuyer: 0n })
  assert.deepEqual(payout(1_000_003n, 0), { toSeller: 0n, toBuyer: 1_000_003n })
  assert.deepEqual(payout(1n, 9_999), { toSeller: 0n, toBuyer: 1n })
  const max = (1n << 64n) - 1n
  const { toSeller, toBuyer } = payout(max, 7_777)
  assert.equal(toSeller + toBuyer, max)
  assert.equal(share(max, 10_000), max)
  assert.throws(() => share(1n, 10_001), RangeError)
  assert.equal(funds(999_999n, 1_000_000n), false)
  assert.equal(funds(1_000_000n, 1_000_000n), true)
})

test('the pay link asks only for what is missing, and only while the escrow waits for money', () => {
  const e = escrowAccount()
  const escrow = escrowAddress(buyer, 7n)
  const url = solanaPayUrl({ account: e, balance: 0n, decimals: 6, label: 'Forest', message: 'Lessons' })
  assert.equal(
    url,
    `solana:${escrow.toBase58()}?amount=1&spl-token=${mint.toBase58()}&reference=${escrow.toBase58()}&label=Forest&message=Lessons`,
  )
  assert.ok(solanaPayUrl({ account: e, balance: 250_000n, decimals: 6 }).includes('amount=0.75&'), 'a part paid: the rest')
  assert.equal(awaitingPayment(e, 999_999n), true)
  for (const [what, account, balance] of [
    ['covered', e, 1_000_000n],
    ['overpaid', e, 2_000_000n],
    ['marked', escrowAccount({ status: 'funded', fundedAt: T0 }), 1_000_000n],
    ['ended', escrowAccount({ status: 'ended', outcome: 'releasedToSeller' }), 0n],
  ] as const) {
    assert.equal(awaitingPayment(account, balance), false, what)
    assert.throws(() => solanaPayUrl({ account, balance, decimals: 6 }), /one-time/, what)
  }
  assert.equal(formatAmount(1_500_000n, 6), '1.5')
  assert.equal(formatAmount(1n, 6), '0.000001')
  assert.equal(formatAmount(25n, 0), '25')
  assert.throws(() => formatAmount(-1n, 6), RangeError)

  // An invoice: the seller's create and the link to send the buyer, for the whole amount.
  const t = terms({ timer: { days: 7, to: 'seller' } })
  const inv = invoice({ seller, buyer, payer, mint, decimals: 6, terms: t })
  const invoiced = escrowAddress(seller, 7n)
  assert.deepEqual(inv.escrow, invoiced, 'the seller\'s address')
  assert.deepEqual(inv.deposit, vaultAddress(invoiced, mint))
  assert.deepEqual(meta(inv.instruction), meta(invoiceIx({ seller, buyer, payer, mint, terms: t })))
  assert.equal(hex(inv.instruction.data), hex(invoiceIx({ seller, buyer, payer, mint, terms: t }).data))
  assert.ok(inv.url.startsWith(`solana:${invoiced.toBase58()}?amount=1&`))
  // The link built later from the chain names the same address.
  assert.ok(solanaPayUrl({ account: invoiceAccount(), balance: 0n, decimals: 6 }).startsWith(`solana:${invoiced.toBase58()}?`))
})

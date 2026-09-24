// What the client computes, with no chain: the bytes it writes, the bytes it reads back, the
// clock arithmetic, and the pay link. The LiteSVM tests write the same bytes by hand in Rust,
// and the validator test sends these through the real program; if either side drifted, one of
// the three fails.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPS,
  ESCROW_LEN,
  NATIVE_MINT,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  UNACCEPTED_DAYS,
  VERSION,
  acceptIx,
  awaitingPayment,
  agreeIx,
  approveIx,
  cancelBuyerIx,
  cancelPayout,
  cancelSellerIx,
  checkTerms,
  clockStart,
  closeUnacceptedIx,
  closeUnfundedIx,
  createArgsBytes,
  createIx,
  currentStep,
  decodeEscrow,
  decodeEvent,
  decodeEvents,
  depositAddress,
  discriminator,
  escrowAddress,
  formatAmount,
  invoice,
  invoiceIx,
  markFundedIx,
  objectIx,
  payout,
  randomId,
  recoverLateIx,
  refundAddress,
  makeRefundAddressIx,
  releaseBySilenceIx,
  schedule,
  share,
  silenceEnds,
  solanaPayUrl,
  stepFromOffer,
  suggestedTerms,
  sweepRentIx,
  termsFor,
  unacceptedTimeout,
  validateTerms,
  vaultAddress,
  withdrawIx,
  type EscrowAccount,
  type OfferTerms,
  type Step,
  type Terms,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const DAY = 86_400n
const T0 = 1_800_000_000n
/** The clock the terms checks read in these tests: a day before T0. */
const NOW = T0 - DAY

const buyer = Keypair.generate().publicKey
const seller = Keypair.generate().publicKey
const arbiter = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
const payer = Keypair.generate().publicKey

/** An escrow account as `decodeEscrow` would return it: open, unfunded, the standard terms. */
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
    rentPayer: payer,
    amount: 1_000_000n,
    serviceTime: null,
    silenceDays: 7,
    steps: [],
    createdAt: T0,
    fundedAt: null,
    status: 'open',
    bump: 255,
    acceptedAt: null,
    endedAt: null,
    outcome: null,
    toSeller: 0n,
    toBuyer: 0n,
    ...over,
  }
}

function terms(over: Partial<Terms> = {}): Terms {
  return {
    id: 7n,
    seller,
    arbiter: null,
    amount: 1_000_000n,
    serviceTime: null,
    silenceDays: 7,
    steps: [
      { offset: DAY, refundBps: 10_000 },
      { offset: 3n * DAY, refundBps: 5_000 },
    ],
    ...over,
  }
}

test('the program id, the seed and the size are the ones the program bakes in', () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  const state = readFileSync(join(here, '../../program/src/state.rs'), 'utf8')
  assert.ok(lib.includes(`declare_id!("${PROGRAM_ID.toBase58()}")`))
  assert.ok(lib.includes(`pub const VERSION: u8 = ${VERSION};`))
  assert.ok(lib.includes('pub const ESCROW_SEED: &[u8] = b"escrow";'))
  assert.ok(lib.includes(`pub const NATIVE_MINT: Pubkey = pubkey!("${NATIVE_MINT.toBase58()}");`))
  assert.ok(lib.includes(`assert!(Escrow::LEN == ${ESCROW_LEN});`))
  assert.ok(state.includes('pub const MAX_STEPS: usize = 4;'))
  assert.ok(state.includes('pub const BPS: u16 = 10_000;'))
  assert.ok(state.includes(`pub const UNACCEPTED_DAYS: i64 = ${UNACCEPTED_DAYS};`))
  assert.equal(BPS, 10_000)
  assert.equal(UNACCEPTED_DAYS, 30n)
})

test('the discriminators are pinned', () => {
  const ixs: Record<string, string> = {
    create: '181ec828051c0777',
    accept: '419646d885066b04',
    mark_funded: '9a19863dc8b81d38',
    approve: '454ad9247375614c',
    release_by_silence: '30c52c966e7a5822',
    object: '2351ffae3d579786',
    agree: 'd24a26e1bfd12265',
    arbitrate: '695b6e96d80b8e8e',
    cancel_buyer: '5387a78fe8b163f5',
    cancel_seller: 'd11d75c3f77f09a3',
    withdraw: 'b712469c946da122',
    close_unfunded: '06d9705bfa5c6746',
    recover_late: '525629b57534cce3',
    sweep_rent: '11ea3af1fb9487b9',
    close_unaccepted: '8582b3216b0acfae',
  }
  for (const [name, want] of Object.entries(ixs)) assert.equal(hex(discriminator('global', name)), want, name)
  const events: Record<string, string> = {
    Created: '41fe44f56694f44c',
    Accepted: '36a28ca7b3be5f46',
    Funded: '43543858c00cc9b1',
    Approved: '11e09689ae68075b',
    ReleasedBySilence: 'e92671208e065438',
    Objected: 'e8d59f3063e1e34a',
    Agreed: '367c553aa9731be6',
    Arbitrated: '45c47f6b8dab3ae2',
    CancelledByBuyer: '98aa1e87b1d8de49',
    CancelledBySeller: '4582b9a7fdf2512f',
    Withdrawn: '1459dfc6c27cdb0d',
    Ended: '467b96d69c092dc5',
    Closed: '321f579b87dcc3ef',
    NeverAccepted: 'a22d3e52bc62fd89',
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
  // Distinct per id and per buyer.
  assert.notDeepEqual(escrowAddress(buyer, 8n), escrow)
  assert.notDeepEqual(escrowAddress(seller, 7n), escrow)
  // Random ids are 64 bits and do not repeat.
  const ids = new Set(Array.from({ length: 100 }, () => randomId()))
  assert.equal(ids.size, 100)
  for (const id of ids) assert.ok(id >= 0n && id < 1n << 64n)
})

test('create carries exactly the bytes the program reads', () => {
  const t = terms({ arbiter, serviceTime: T0 + 10n * DAY })
  const bytes = createArgsBytes(t, buyer)
  // id 8, buyer 32, seller 32, arbiter 1+32, amount 8, service_time 1+8, silence_days 2, steps 4 + 2×10.
  assert.equal(bytes.length, 8 + 32 + 32 + 33 + 8 + 9 + 2 + 4 + 20)
  const v = new DataView(bytes.buffer, bytes.byteOffset)
  assert.equal(v.getBigUint64(0, true), 7n)
  assert.deepEqual(new PublicKey(bytes.subarray(8, 40)), buyer)
  assert.deepEqual(new PublicKey(bytes.subarray(40, 72)), seller)
  assert.equal(bytes[72], 1)
  assert.deepEqual(new PublicKey(bytes.subarray(73, 105)), arbiter)
  assert.equal(v.getBigUint64(105, true), 1_000_000n)
  assert.equal(bytes[113], 1)
  assert.equal(v.getBigInt64(114, true), T0 + 10n * DAY)
  assert.equal(v.getUint16(122, true), 7)
  assert.equal(v.getUint32(124, true), 2)
  assert.equal(v.getBigInt64(128, true), DAY)
  assert.equal(v.getUint16(136, true), 10_000)
  assert.equal(v.getBigInt64(138, true), 3n * DAY)
  assert.equal(v.getUint16(146, true), 5_000)

  // No arbiter, no service time, no steps: one byte each for the options, four for the count.
  const bare = createArgsBytes(terms({ steps: [] }), buyer)
  assert.equal(bare.length, 8 + 32 + 32 + 1 + 8 + 1 + 2 + 4)
  assert.equal(bare[72], 0)
  assert.equal(bare[81], 0)

  const ix = createIx({ buyer, payer, mint, terms: t, now: NOW })
  assert.deepEqual(ix.programId, PROGRAM_ID)
  assert.equal(hex(ix.data.subarray(0, 8)), '181ec828051c0777')
  assert.equal(hex(ix.data.subarray(8)), hex(bytes))
  const escrow = escrowAddress(buyer, 7n)
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [escrow.toBase58(), false, true],
      [vaultAddress(escrow, mint).toBase58(), false, true],
      [buyer.toBase58(), true, false],
      [payer.toBase58(), true, true],
      [mint.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
      ['11111111111111111111111111111111', false, false],
    ],
  )

  // An invoice: the same bytes and the same address, with the seller in the creator's slot.
  const inv = invoiceIx({ seller, buyer, payer, mint, terms: t, now: NOW })
  assert.equal(hex(inv.data), hex(ix.data))
  assert.deepEqual(inv.keys[0].pubkey, escrow)
  assert.deepEqual([inv.keys[2].pubkey.toBase58(), inv.keys[2].isSigner], [seller.toBase58(), true])
  assert.throws(() => createIx({ buyer, payer, mint, terms: t, creator: arbiter, now: NOW }), /NotAParty/)
  assert.throws(() => createIx({ buyer, payer, mint: NATIVE_MINT, terms: t, now: NOW }), /NativeMint/)
  assert.throws(() => invoiceIx({ seller: arbiter, buyer, payer, mint, terms: t, now: NOW }), /its own seller/)
})

test('the endings share one account list and add their signers after it', () => {
  const escrow = escrowAddress(buyer, 7n)
  const accounts = {
    escrow,
    vault: vaultAddress(escrow, mint),
    buyer,
    mint,
    sellerTokens: Keypair.generate().publicKey,
    rentPayer: payer,
  }
  // The buyer's slot is always its refund address: the client cannot name another.
  const refund = refundAddress(buyer, mint)
  const common = [accounts.escrow, accounts.vault, refund, accounts.sellerTokens, accounts.rentPayer, TOKEN_PROGRAM_ID].map((k) => k.toBase58())
  const keys = (ix: { keys: { pubkey: PublicKey; isSigner: boolean }[] }) => ix.keys.map((k) => k.pubkey.toBase58())
  const signers = (ix: { keys: { pubkey: PublicKey; isSigner: boolean }[] }) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())

  const release = releaseBySilenceIx({ accounts })
  assert.deepEqual(keys(release), common)
  assert.deepEqual(signers(release), [])
  assert.equal(release.data.length, 8)

  const approve = approveIx({ accounts, buyer, sellerBps: 7_000 })
  assert.deepEqual(keys(approve), [...common, buyer.toBase58()])
  assert.deepEqual(signers(approve), [buyer.toBase58()])
  assert.equal(approve.data.length, 10)
  assert.equal(approve.data.readUInt16LE(8), 7_000)
  assert.equal(approveIx({ accounts, buyer }).data.readUInt16LE(8), 10_000, 'the default is all to the seller')

  assert.equal(arbitrateIxLen(arbiter), 10)
  function arbitrateIxLen(a: PublicKey) {
    const ix = agreeIx({ accounts, buyer, seller, sellerBps: 1 })
    assert.deepEqual(signers(ix), [buyer.toBase58(), seller.toBase58()])
    return ix.data.length
  }
  for (const [ix, who] of [
    [cancelBuyerIx({ accounts, buyer }), buyer],
    [cancelSellerIx({ accounts, seller }), seller],
  ] as const) {
    assert.deepEqual(keys(ix), [...common, who.toBase58()])
    assert.equal(ix.data.length, 8)
  }
  // The two exits that pay the seller nothing name no seller account.
  const short = [accounts.escrow, accounts.vault, refund, accounts.rentPayer, TOKEN_PROGRAM_ID].map((k) => k.toBase58())
  for (const [ix, who, name] of [
    [withdrawIx({ accounts, buyer }), buyer, 'withdraw'],
    [closeUnfundedIx({ accounts, closer: payer }), payer, 'close_unfunded'],
  ] as const) {
    assert.deepEqual(keys(ix), [...short, who.toBase58()])
    assert.deepEqual(signers(ix), [who.toBase58()])
    assert.equal(hex(ix.data), hex(discriminator('global', name)))
  }
  assert.deepEqual(keys(markFundedIx({ escrow, vault: accounts.vault })), [escrow.toBase58(), accounts.vault.toBase58()])
  assert.deepEqual(signers(objectIx({ escrow, vault: accounts.vault, buyer })), [buyer.toBase58()])

  // A missing refund address is made first, the standard idempotent way, by whoever sends.
  const make = makeRefundAddressIx({ payer, buyer, mint })
  assert.equal(make.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
  assert.deepEqual(keys(make), [payer, refund, buyer, mint, SystemProgram.programId, TOKEN_PROGRAM_ID].map((k) => k.toBase58()))
  assert.deepEqual(signers(make), [payer.toBase58()])
  assert.deepEqual([...make.data], [1])

  assert.throws(() => approveIx({ accounts, buyer, sellerBps: 10_001 }), /BadSplit/)
  assert.throws(() => agreeIx({ accounts, buyer, seller, sellerBps: -1 }), /BadSplit/)
})

test('late money, the rent sweep and the unaccepted timeout: their accounts, and what the builders refuse', () => {
  const escrow = escrowAddress(buyer, 7n)
  const caller = Keypair.generate().publicKey
  const refund = refundAddress(buyer, mint)
  assert.deepEqual(refund, getAssociatedTokenAddressSync(mint, buyer), "the buyer's refund address is its standard token account")
  const metas = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? ' signer' : ''}${k.isWritable ? ' w' : ''}`)
  const system = '11111111111111111111111111111111'

  const ended = escrowAccount({ status: 'ended', fundedAt: T0, acceptedAt: T0, endedAt: T0 + DAY, outcome: 'approved', toSeller: 1_000_000n })
  const late = recoverLateIx({ account: ended, caller })
  assert.deepEqual(metas(late), [
    escrow.toBase58(),
    `${ended.vault.toBase58()} w`,
    `${buyer.toBase58()} w`,
    `${refund.toBase58()} w`,
    mint.toBase58(),
    `${caller.toBase58()} signer w`,
    TOKEN_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    system,
  ])
  assert.equal(hex(late.data), hex(discriminator('global', 'recover_late')))
  for (const status of ['open', 'accepted', 'funded', 'locked'] as const) {
    assert.throws(() => recoverLateIx({ account: escrowAccount({ status }), caller }), /NotEnded/, status)
  }

  const sweep = sweepRentIx({ escrow, rentPayer: payer })
  assert.deepEqual(metas(sweep), [`${escrow.toBase58()} w`, `${payer.toBase58()} w`])
  assert.equal(hex(sweep.data), hex(discriminator('global', 'sweep_rent')))

  const unaccepted = escrowAccount({ fundedAt: T0 })
  const close = closeUnacceptedIx({ account: unaccepted, caller })
  assert.deepEqual(metas(close), [
    `${escrow.toBase58()} w`,
    `${unaccepted.vault.toBase58()} w`,
    buyer.toBase58(),
    `${refund.toBase58()} w`,
    mint.toBase58(),
    `${payer.toBase58()} w`,
    `${caller.toBase58()} signer w`,
    TOKEN_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    system,
  ])
  assert.equal(hex(close.data), hex(discriminator('global', 'close_unaccepted')))
  assert.throws(() => closeUnacceptedIx({ account: escrowAccount(), caller }), /FundingNotObserved/)
  assert.throws(() => closeUnacceptedIx({ account: escrowAccount({ fundedAt: T0, acceptedAt: T0, status: 'funded' }), caller }), /AlreadyAccepted/)
  assert.throws(() => closeUnacceptedIx({ account: { ...ended, acceptedAt: null }, caller }), /Ended/)
})

test('bad terms fail before a transaction is built, with the program\'s own error names', () => {
  const bad: [string, Partial<Terms>, RegExp][] = [
    ['buyer equals seller', { seller: buyer }, /SameParty/],
    ['zero seller', { seller: PublicKey.default }, /EmptyKey/],
    ['buyer as arbiter', { arbiter: buyer }, /ArbiterIsAParty/],
    ['seller as arbiter', { arbiter: seller }, /ArbiterIsAParty/],
    ['amount zero', { amount: 0n }, /AmountZero/],
    ['silence zero', { silenceDays: 0 }, /SilenceZero/],
    ['service time zero', { serviceTime: 0n }, /BadServiceTime/],
    ['five steps', { steps: [1n, 2n, 3n, 4n, 5n].map((d) => ({ offset: d * DAY, refundBps: 5_000 })) }, /TooManySteps/],
    ['unsorted', { steps: [{ offset: 3n * DAY, refundBps: 5_000 }, { offset: DAY, refundBps: 10_000 }] }, /StepsUnsorted/],
    ['same deadline twice', { steps: [{ offset: DAY, refundBps: 5_000 }, { offset: DAY, refundBps: 10_000 }] }, /StepsUnsorted/],
    ['over 100%', { steps: [{ offset: DAY, refundBps: 10_001 }] }, /StepOverHundred/],
  ]
  for (const [what, over, want] of bad) {
    assert.throws(() => validateTerms(terms(over), buyer), want, what)
    assert.throws(() => createIx({ buyer, payer, mint, terms: terms(over), now: NOW }), want, what)
  }
  assert.throws(() => validateTerms(terms(), PublicKey.default), /EmptyKey/, 'the zero key as buyer')
  assert.doesNotThrow(() => validateTerms(terms({ arbiter, serviceTime: T0, steps: [{ offset: -DAY, refundBps: 10_000 }, { offset: 0n, refundBps: 7_500 }, { offset: DAY, refundBps: 2_500 }, { offset: 2n * DAY, refundBps: 0 }] }), buyer))
})

test('the escrow account decodes at the pinned offsets', () => {
  const escrow = escrowAddress(buyer, 7n)
  const vault = vaultAddress(escrow, mint)
  const b = Buffer.alloc(8 + ESCROW_LEN)
  Buffer.from('1fd57bbbba16da9b', 'hex').copy(b, 0)
  const d = b.subarray(8)
  d[0] = VERSION
  d.writeBigUInt64LE(7n, 1)
  buyer.toBuffer().copy(d, 9)
  seller.toBuffer().copy(d, 41)
  arbiter.toBuffer().copy(d, 73)
  mint.toBuffer().copy(d, 105)
  vault.toBuffer().copy(d, 137)
  payer.toBuffer().copy(d, 169)
  d.writeBigUInt64LE(1_000_000n, 201)
  d.writeBigInt64LE(T0 + 10n * DAY, 209)
  d.writeUInt16LE(7, 217)
  d[219] = 2
  d.writeBigInt64LE(-DAY, 220)
  d.writeUInt16LE(10_000, 228)
  d.writeBigInt64LE(0n, 230)
  d.writeUInt16LE(5_000, 238)
  d.writeBigInt64LE(999n, 240) // an unused slot: ignored
  d.writeBigInt64LE(T0, 260)
  d.writeBigInt64LE(T0 + DAY, 268)
  d[276] = 3 // locked
  d[277] = 254
  d.writeBigInt64LE(T0 + DAY / 2n, 278)
  const e = decodeEscrow(new Uint8Array(b))
  assert.deepEqual(e, {
    version: 1,
    id: 7n,
    buyer,
    seller,
    arbiter,
    mint,
    vault,
    rentPayer: payer,
    amount: 1_000_000n,
    serviceTime: T0 + 10n * DAY,
    silenceDays: 7,
    steps: [
      { offset: -DAY, refundBps: 10_000 },
      { offset: 0n, refundBps: 5_000 },
    ],
    createdAt: T0,
    fundedAt: T0 + DAY,
    status: 'locked',
    bump: 254,
    acceptedAt: T0 + DAY / 2n,
    endedAt: null,
    outcome: null,
    toSeller: 0n,
    toBuyer: 0n,
  } satisfies EscrowAccount)

  // The receipt: ended, with how and what, at 286..311.
  d[276] = 4
  d.writeBigInt64LE(T0 + 2n * DAY, 286)
  d[294] = 6 // withdrawn
  d.writeBigUInt64LE(0n, 295)
  d.writeBigUInt64LE(1_000_000n, 303)
  const r = decodeEscrow(new Uint8Array(b))
  assert.deepEqual([r.status, r.endedAt, r.outcome, r.toSeller, r.toBuyer], ['ended', T0 + 2n * DAY, 'withdrawn', 0n, 1_000_000n])
  // The outcome byte means nothing before the end.
  d[276] = 2
  assert.equal(decodeEscrow(new Uint8Array(b)).outcome, null)
  d[276] = 1
  assert.equal(decodeEscrow(new Uint8Array(b)).status, 'accepted')

  // The zero key and zero times read back as null.
  PublicKey.default.toBuffer().copy(d, 73)
  d.writeBigInt64LE(0n, 209)
  d.writeBigInt64LE(0n, 268)
  d.writeBigInt64LE(0n, 278)
  d.writeBigInt64LE(0n, 286)
  d[276] = 0
  const bare = decodeEscrow(new Uint8Array(b))
  assert.equal(bare.arbiter, null)
  assert.equal(bare.serviceTime, null)
  assert.equal(bare.fundedAt, null)
  assert.equal(bare.acceptedAt, null)
  assert.equal(bare.endedAt, null)
  assert.equal(bare.status, 'open')

  assert.throws(() => decodeEscrow(new Uint8Array(10)), /319 bytes/)
  b[0] ^= 1
  assert.throws(() => decodeEscrow(new Uint8Array(b)), /not an escrow/)
})

/** An `Ended` event's bytes: outcome, amount, balance, to_seller, to_buyer, accepted_at, ended_at, rent payer, rent. */
function endedBytes(escrow: PublicKey, over: { outcome?: number; amounts?: bigint[]; acceptedAt?: bigint } = {}): Buffer {
  const b = Buffer.alloc(8 + 32 + 1 + 8 * 4 + 8 + 8 + 32 + 8)
  Buffer.from('467b96d69c092dc5', 'hex').copy(b, 0)
  escrow.toBuffer().copy(b, 8)
  b[40] = over.outcome ?? 4
  const [amount, balance, toSeller, toBuyer] = over.amounts ?? [1_000_000n, 1_000_001n, 500_000n, 500_001n]
  b.writeBigUInt64LE(amount, 41)
  b.writeBigUInt64LE(balance, 49)
  b.writeBigUInt64LE(toSeller, 57)
  b.writeBigUInt64LE(toBuyer, 65)
  b.writeBigInt64LE(over.acceptedAt ?? T0, 73)
  b.writeBigInt64LE(T0 + DAY, 81)
  payer.toBuffer().copy(b, 89)
  b.writeBigUInt64LE(2_039_280n, 121)
  return b
}

test('events decode from the log, in order', () => {
  const escrow = escrowAddress(buyer, 7n)
  const ended = endedBytes(escrow)

  const cancelled = Buffer.alloc(8 + 32 + 1 + 2 + 8 + 8)
  Buffer.from('98aa1e87b1d8de49', 'hex').copy(cancelled, 0)
  escrow.toBuffer().copy(cancelled, 8)
  cancelled[40] = 1
  cancelled.writeUInt16LE(5_000, 41)
  cancelled.writeBigUInt64LE(500_001n, 43)
  cancelled.writeBigUInt64LE(500_000n, 51)

  const created = Buffer.alloc(8 + 32 + 1 + 8 + 32 * 6 + 8 + 8 + 2 + 4 + 10 + 8)
  Buffer.from('41fe44f56694f44c', 'hex').copy(created, 0)
  escrow.toBuffer().copy(created, 8)
  created[40] = 1
  created.writeBigUInt64LE(7n, 41)
  buyer.toBuffer().copy(created, 49)
  seller.toBuffer().copy(created, 81)
  PublicKey.default.toBuffer().copy(created, 113)
  mint.toBuffer().copy(created, 145)
  vaultAddress(escrow, mint).toBuffer().copy(created, 177)
  payer.toBuffer().copy(created, 209)
  created.writeBigUInt64LE(1_000_000n, 241)
  created.writeBigInt64LE(0n, 249)
  created.writeUInt16LE(7, 257)
  created.writeUInt32LE(1, 259)
  created.writeBigInt64LE(DAY, 263)
  created.writeUInt16LE(10_000, 271)
  created.writeBigInt64LE(T0, 273)

  const accepted = Buffer.alloc(8 + 32 + 32 + 8)
  Buffer.from('36a28ca7b3be5f46', 'hex').copy(accepted, 0)
  escrow.toBuffer().copy(accepted, 8)
  seller.toBuffer().copy(accepted, 40)
  accepted.writeBigInt64LE(T0, 72)

  const logs = [
    'Program FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT invoke [1]',
    `Program data: ${created.toString('base64')}`,
    `Program data: ${accepted.toString('base64')}`,
    'Program log: something else',
    `Program data: ${cancelled.toString('base64')}`,
    `Program data: ${ended.toString('base64')}`,
    'Program data: AAAA',
  ]
  const events = decodeEvents(logs)
  assert.equal(events.length, 4)
  assert.deepEqual(events[0], {
    kind: 'created',
    escrow,
    version: 1,
    id: 7n,
    buyer,
    seller,
    arbiter: null,
    mint,
    vault: vaultAddress(escrow, mint),
    rentPayer: payer,
    amount: 1_000_000n,
    serviceTime: null,
    silenceDays: 7,
    steps: [{ offset: DAY, refundBps: 10_000 }],
    createdAt: T0,
  })
  assert.deepEqual(events[1], { kind: 'accepted', escrow, seller, acceptedAt: T0 })
  assert.deepEqual(events[2], { kind: 'cancelledByBuyer', escrow, step: 1, refundBps: 5_000, toBuyer: 500_001n, toSeller: 500_000n })
  assert.deepEqual(events[3], {
    kind: 'ended',
    escrow,
    outcome: 'cancelledByBuyer',
    amount: 1_000_000n,
    balance: 1_000_001n,
    toSeller: 500_000n,
    toBuyer: 500_001n,
    acceptedAt: T0,
    endedAt: T0 + DAY,
    rentPayer: payer,
    rentLamports: 2_039_280n,
  })
  // A full approval before the seller accepted: the receipt says so.
  const unaccepted = decodeEvent(new Uint8Array(endedBytes(escrow, { outcome: 0, acceptedAt: 0n })))
  assert.ok(unaccepted?.kind === 'ended' && unaccepted.acceptedAt === null && unaccepted.outcome === 'approved')

  // A withdrawal, and the close of an escrow that never held the amount.
  const withdrawn = Buffer.alloc(8 + 32 + 8)
  Buffer.from('1459dfc6c27cdb0d', 'hex').copy(withdrawn, 0)
  escrow.toBuffer().copy(withdrawn, 8)
  withdrawn.writeBigUInt64LE(1_000_000n, 40)
  assert.deepEqual(decodeEvent(new Uint8Array(withdrawn)), { kind: 'withdrawn', escrow, toBuyer: 1_000_000n })
  const closed = Buffer.alloc(8 + 32 + 32 + 8 + 32 + 8)
  Buffer.from('321f579b87dcc3ef', 'hex').copy(closed, 0)
  escrow.toBuffer().copy(closed, 8)
  seller.toBuffer().copy(closed, 40)
  closed.writeBigUInt64LE(400_000n, 72)
  payer.toBuffer().copy(closed, 80)
  closed.writeBigUInt64LE(4_000_000n, 112)
  assert.deepEqual(decodeEvent(new Uint8Array(closed)), { kind: 'closed', escrow, closedBy: seller, toBuyer: 400_000n, rentPayer: payer, rentLamports: 4_000_000n })

  // Session 12: an escrow nobody accepted, sent back; late money; a rent sweep.
  const never = Buffer.alloc(8 + 32 + 8 + 8)
  Buffer.from('a22d3e52bc62fd89', 'hex').copy(never, 0)
  escrow.toBuffer().copy(never, 8)
  never.writeBigInt64LE(T0 + 30n * DAY, 40)
  never.writeBigUInt64LE(1_000_005n, 48)
  assert.deepEqual(decodeEvent(new Uint8Array(never)), { kind: 'neverAccepted', escrow, timeout: T0 + 30n * DAY, toBuyer: 1_000_005n })
  const neverEnded = Buffer.from(ended)
  neverEnded[40] = 7
  assert.equal((decodeEvent(new Uint8Array(neverEnded)) as { outcome: string }).outcome, 'neverAccepted')
  const recovered = Buffer.alloc(8 + 32 + 8 + 8)
  Buffer.from('bd249dc10194f8ce', 'hex').copy(recovered, 0)
  escrow.toBuffer().copy(recovered, 8)
  recovered.writeBigUInt64LE(400_000n, 40)
  recovered.writeBigUInt64LE(2_039_280n, 48)
  assert.deepEqual(decodeEvent(new Uint8Array(recovered)), { kind: 'recoveredLate', escrow, toBuyer: 400_000n, rentLamports: 2_039_280n })
  const swept = Buffer.alloc(8 + 32 + 8 + 8)
  Buffer.from('cb5605b151a70c19', 'hex').copy(swept, 0)
  escrow.toBuffer().copy(swept, 8)
  swept.writeBigUInt64LE(2_800_008n, 40)
  swept.writeBigUInt64LE(311_112n, 48)
  assert.deepEqual(decodeEvent(new Uint8Array(swept)), { kind: 'rentSwept', escrow, lamports: 2_800_008n, left: 311_112n })

  assert.equal(decodeEvent(new Uint8Array(7)), null)
  assert.throws(() => decodeEvent(new Uint8Array([...ended, 0])), /trailing/)
})

test('an event only counts when the escrow program itself wrote it', () => {
  // Any program can write a `Program data:` line with an escrow event's exact bytes: a receipt
  // for a deal that never happened, at any address. The runtime's own invoke and success lines
  // say which program wrote each line, and no program can forge those.
  const escrow = escrowAddress(buyer, 7n)
  const ended = endedBytes(escrow, { outcome: 0, amounts: [10_000_000_000n, 10_000_000_000n, 10_000_000_000n, 0n] })
  const line = `Program data: ${ended.toString('base64')}`
  const forger = 'Forger1111111111111111111111111111111111111'
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const id = PROGRAM_ID.toBase58()

  // Written by another program, alone or around a real escrow instruction.
  assert.deepEqual(decodeEvents([`Program ${forger} invoke [1]`, line, `Program ${forger} success`]), [])
  assert.deepEqual(
    decodeEvents([`Program ${id} invoke [1]`, `Program ${id} success`, `Program ${forger} invoke [1]`, line, `Program ${forger} success`]),
    [],
  )
  // Written by a program the escrow called, while the escrow waits.
  assert.deepEqual(decodeEvents([`Program ${id} invoke [1]`, `Program ${token} invoke [2]`, line, `Program ${token} success`, `Program ${id} success`]), [])
  // A line with no program open at all.
  assert.deepEqual(decodeEvents([line]), [])
  // The escrow's own, after its call into the token program returned, counts; so does the
  // escrow's own when another program called it.
  assert.equal(decodeEvents([`Program ${id} invoke [1]`, `Program ${token} invoke [2]`, `Program ${token} success`, line, `Program ${id} success`]).length, 1)
  assert.equal(decodeEvents([`Program ${forger} invoke [1]`, `Program ${id} invoke [2]`, line, `Program ${id} success`, `Program ${forger} success`]).length, 1)
  // Another deployment of the same code, at another address, is another program.
  assert.equal(decodeEvents([`Program ${id} invoke [1]`, line, `Program ${id} success`], PROGRAM_ID).length, 1)
  assert.deepEqual(decodeEvents([`Program ${id} invoke [1]`, line, `Program ${id} success`], new PublicKey(token)), [])
})

test('terms come from the offer; a market file only suggests them and limits nothing', () => {
  const offer: OfferTerms = {
    autoReleaseDays: 7,
    cancellationSteps: [
      { hours: -24, refundPercent: 100 },
      { hours: 0, refundPercent: 50 },
    ],
  }
  const t = termsFor(offer, { seller, amount: 1_000_000n, mint, serviceTime: new Date(Number(T0) * 1000), id: 7n }, NOW)
  assert.deepEqual(t, {
    id: 7n,
    seller,
    arbiter: null,
    amount: 1_000_000n,
    serviceTime: T0,
    silenceDays: 7,
    steps: [
      { offset: -DAY, refundBps: 10_000 },
      { offset: 0n, refundBps: 5_000 },
    ],
  })
  // The offer's arbiter is the deal's, and any mint works: no market file is read.
  const withArbiter = termsFor({ autoReleaseDays: 3, arbiter: arbiter.toBase58() }, { seller, amount: 1n, mint: Keypair.generate().publicKey }, NOW)
  assert.deepEqual(withArbiter.arbiter, arbiter)
  assert.equal(withArbiter.silenceDays, 3)
  assert.deepEqual(withArbiter.steps, [])
  assert.equal(withArbiter.serviceTime, null)
  assert.ok(withArbiter.id >= 0n)
  assert.equal(termsFor({ autoReleaseDays: 3, arbiter: null }, { seller, amount: 1n, mint }, NOW).arbiter, null)
  // A market file's suggestions are starting values for the seller's offer, copied, never a limit.
  const market = { suggested: { autoReleaseDays: 7, cancellationSteps: [{ hours: -24, refundPercent: 100 }] } }
  const suggested = suggestedTerms(market)
  assert.deepEqual(suggested, { autoReleaseDays: 7, cancellationSteps: [{ hours: -24, refundPercent: 100 }], arbiter: null })
  suggested.cancellationSteps![0].hours = -48
  assert.equal(market.suggested.cancellationSteps[0].hours, -24, 'editing the offer leaves the market file alone')
  assert.deepEqual(termsFor({ ...suggested, autoReleaseDays: 14 }, { seller, amount: 1n, mint, id: 1n }, NOW).silenceDays, 14)
  assert.deepEqual(stepFromOffer({ hours: 1.5, refundPercent: 12.5 }), { offset: 5_400n, refundBps: 1_250 })
  assert.throws(() => stepFromOffer({ hours: 1, refundPercent: 101 }), /0 to 100/)
})

test('terms the program accepts but nobody meant are refused before signing', () => {
  // Adversarial review 1, finding 13: termsFor used to build each of these, and create accepts
  // them. They are now refused by `checkTerms`, which termsFor, createIx and acceptIx all run.
  const offer: OfferTerms = { autoReleaseDays: 7, cancellationSteps: [{ hours: 240, refundPercent: 100 }] }
  const sane: OfferTerms = { autoReleaseDays: 7, cancellationSteps: [{ hours: 24, refundPercent: 100 }] }
  // Times in seconds: `Date.now()` is milliseconds, and would put the service time some 55,000
  // years out, where silence never comes.
  assert.throws(() => termsFor(sane, { seller, amount: 1n, mint, serviceTime: 1_800_000_000_000 }, NOW), /not unix seconds/)
  // A service time already past: the clock has started before the money lands.
  assert.throws(() => termsFor(sane, { seller, amount: 1n, mint, serviceTime: new Date(1000) }, NOW), /already passed/)
  assert.doesNotThrow(() => termsFor(sane, { seller, amount: 1n, mint, serviceTime: T0 }, NOW))
  // Steps sane: a refund step that outlasts silence races the seller's release.
  assert.throws(() => termsFor(offer, { seller, amount: 1n, mint }, NOW), /outlasts silence/)
  assert.doesNotThrow(() => termsFor({ ...offer, autoReleaseDays: 10 }, { seller, amount: 1n, mint }, NOW), 'a step on the last second of silence is fine')
  // And the same through createIx, whoever builds the terms.
  assert.throws(() => createIx({ buyer, payer, mint, terms: terms({ serviceTime: 1_800_000_000_000n }), now: NOW }), /not unix seconds/)
  assert.throws(() => createIx({ buyer, payer, mint, terms: terms({ steps: [{ offset: 8n * DAY, refundBps: 10_000 }] }), now: NOW }), /outlasts silence/)
  assert.throws(() => createIx({ buyer, payer, mint, terms: terms({ serviceTime: NOW - 1n }), now: NOW }), /already passed/)

  // An arbiter only if named: the escrow's arbiter must be the one the signer expects.
  const t = terms({ arbiter })
  assert.doesNotThrow(() => checkTerms(t, { arbiter, now: NOW }))
  assert.throws(() => checkTerms(t, { arbiter: null, now: NOW }), /did not agree to/)
  assert.throws(() => checkTerms(t, { arbiter: Keypair.generate().publicKey, now: NOW }), /did not agree to/)
  assert.throws(() => checkTerms(terms(), { arbiter, now: NOW }), /names no arbiter/)
  assert.doesNotThrow(() => checkTerms(terms(), { arbiter: null, now: NOW }))
})

test('the seller accepts only an escrow read from the chain, after checking its terms', () => {
  const escrow = escrowAddress(buyer, 7n)
  const account: EscrowAccount = {
    version: 1,
    id: 7n,
    buyer,
    seller,
    arbiter: null,
    mint,
    vault: vaultAddress(escrow, mint),
    rentPayer: payer,
    amount: 1_000_000n,
    serviceTime: T0,
    silenceDays: 7,
    steps: [{ offset: -DAY, refundBps: 10_000 }],
    createdAt: NOW,
    fundedAt: null,
    status: 'open',
    bump: 255,
    acceptedAt: null,
    endedAt: null,
    outcome: null,
    toSeller: 0n,
    toBuyer: 0n,
  }
  const ix = acceptIx({ account, seller, arbiter: null, now: NOW })
  assert.equal(hex(ix.data), '419646d885066b04')
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [escrow.toBase58(), false, true],
      [account.vault.toBase58(), false, false],
      [seller.toBase58(), true, false],
    ],
  )
  assert.throws(() => acceptIx({ account, seller: buyer, arbiter: null, now: NOW }), /NotTheSeller/)
  assert.throws(() => acceptIx({ account: { ...account, status: 'accepted' }, seller, arbiter: null, now: NOW }), /AlreadyAccepted/)
  assert.throws(() => acceptIx({ account: { ...account, status: 'ended' }, seller, arbiter: null, now: NOW }), /Ended/)
  // The buyer named an arbiter the seller never agreed to: its second key, perhaps.
  assert.throws(() => acceptIx({ account: { ...account, arbiter: Keypair.generate().publicKey }, seller, arbiter: null, now: NOW }), /did not agree to/)
  assert.throws(() => acceptIx({ account: { ...account, serviceTime: 1_800_000_000_000n }, seller, arbiter: null, now: NOW }), /not unix seconds/)
  assert.throws(() => acceptIx({ account: { ...account, steps: [{ offset: 30n * DAY, refundBps: 10_000 }] }, seller, arbiter: null, now: NOW }), /outlasts silence/)
})

test('an invoice is the seller\'s create, and its pay link', () => {
  const t = terms({ serviceTime: T0 })
  const inv = invoice({ seller, buyer, payer, mint, decimals: 6, terms: t, label: 'Forest', message: 'Maths, Tuesday 4pm', now: NOW })
  const escrow = escrowAddress(buyer, 7n)
  assert.deepEqual(inv.escrow, escrow)
  assert.deepEqual(inv.deposit, vaultAddress(escrow, mint))
  assert.deepEqual([inv.instruction.keys[2].pubkey.toBase58(), inv.instruction.keys[2].isSigner], [seller.toBase58(), true])
  assert.equal(hex(inv.instruction.data), hex(createIx({ buyer, payer, mint, terms: t, now: NOW }).data))
  const url = new URL(inv.url)
  assert.equal(url.pathname, escrow.toBase58())
  assert.equal(url.searchParams.get('amount'), '1')
  assert.equal(url.searchParams.get('reference'), escrow.toBase58())
  assert.throws(() => invoice({ seller, buyer, payer, mint, decimals: 6, terms: terms({ serviceTime: NOW - DAY }), now: NOW }), /already passed/)
})

test('the clock start, silence and each deadline, as the program will read them', () => {
  const steps: Step[] = [
    { offset: DAY, refundBps: 10_000 },
    { offset: 3n * DAY, refundBps: 5_000 },
  ]
  const base = { serviceTime: null, fundedAt: null, acceptedAt: null, silenceDays: 7, steps, createdAt: T0, status: 'open' as const }

  // Not yet funded, no service time: no clock.
  let s = schedule(base, T0 + DAY)
  assert.equal(s.accepted, false)
  assert.equal(s.clockStart, null)
  assert.equal(s.silenceReleasesAt, null)
  assert.deepEqual(s.deadlines, [])
  assert.equal(s.buyerCanCancel, false)
  assert.equal(s.buyerCanObject, false)
  assert.equal(s.rentPayerCanCloseUnfundedAt, T0 + 3n * DAY + 1n, 'measured from creation when there is no service time')
  assert.equal(schedule(base, T0 + 3n * DAY + 1n).rentPayerCanCloseUnfundedAt, null, 'now')
  assert.equal(schedule({ ...base, steps: [] }, T0).rentPayerCanCloseUnfundedAt, null, 'no steps: now')
  // Funded but not accepted: still no clock.
  assert.equal(clockStart({ ...base, fundedAt: T0 }), null)
  assert.equal(schedule({ ...base, serviceTime: T0 }, T0 + DAY).clockStart, null, 'not even from a service time')

  // Accepted at T0, funded at T0 + 1 day.
  const funded = { ...base, acceptedAt: T0, fundedAt: T0 + DAY, status: 'funded' as const }
  assert.equal(clockStart(funded), T0 + DAY)
  s = schedule(funded, T0 + DAY)
  assert.equal(s.accepted, true)
  assert.equal(s.clockStart, T0 + DAY)
  assert.equal(s.silenceReleasesAt, T0 + 8n * DAY + 1n)
  assert.equal(silenceEnds(T0 + DAY, 7), T0 + 8n * DAY)
  assert.deepEqual(s.deadlines, [
    { index: 0, deadline: T0 + 2n * DAY, refundBps: 10_000 },
    { index: 1, deadline: T0 + 4n * DAY, refundBps: 5_000 },
  ])
  assert.deepEqual(s.currentStep, s.deadlines[0])
  assert.equal(s.buyerCanCancel, true)
  assert.equal(s.buyerCanObject, true)
  assert.deepEqual(currentStep(steps, T0 + DAY, T0 + 2n * DAY), { index: 1, deadline: T0 + 4n * DAY, refundBps: 5_000 }, 'on the deadline the next step is in force')
  assert.equal(currentStep(steps, T0 + DAY, T0 + 4n * DAY), null, 'on the last deadline none is')
  assert.equal(schedule(funded, T0 + 4n * DAY).buyerCanCancel, false)
  assert.equal(schedule(funded, T0 + 8n * DAY).silenceOver, false, 'the last second of silence')
  assert.equal(schedule(funded, T0 + 8n * DAY).buyerCanObject, true)
  assert.equal(schedule(funded, T0 + 8n * DAY + 1n).silenceOver, true)
  assert.equal(schedule(funded, T0 + 8n * DAY + 1n).buyerCanObject, false)
  assert.equal(schedule({ ...funded, status: 'locked' }, T0 + DAY).buyerCanCancel, false)
  assert.equal(schedule({ ...funded, status: 'locked' }, T0 + DAY).buyerCanObject, false)
  assert.equal(schedule({ ...funded, status: 'ended' }, T0 + DAY).buyerCanCancel, false)
  // Funded first, accepted ten days later: the clock starts at the acceptance.
  assert.equal(clockStart({ ...funded, fundedAt: T0, acceptedAt: T0 + 10n * DAY }), T0 + 10n * DAY)

  // A service time wins over the funding time, and negative offsets fall before it.
  const timed = { ...funded, serviceTime: T0 + 30n * DAY, steps: [{ offset: -DAY, refundBps: 10_000 }, { offset: 0n, refundBps: 5_000 }] }
  s = schedule(timed, T0 + DAY)
  assert.equal(s.clockStart, T0 + 30n * DAY)
  assert.equal(s.silenceReleasesAt, T0 + 37n * DAY + 1n)
  assert.deepEqual(s.deadlines.map((d) => d.deadline), [T0 + 29n * DAY, T0 + 30n * DAY])
  assert.equal(schedule({ ...timed, fundedAt: null, status: 'open' }, T0).rentPayerCanCloseUnfundedAt, T0 + 30n * DAY + 1n)
  // A service time the seller accepted after: the clock starts at the acceptance.
  assert.equal(clockStart({ ...timed, acceptedAt: T0 + 40n * DAY }), T0 + 40n * DAY)

  // Funding always counts: an invoice due on day 1 and paid on day 30 starts its clock on day 30,
  // and a service time with the funding not yet observed starts nothing.
  const invoice = { ...base, acceptedAt: T0, serviceTime: T0 + DAY, fundedAt: T0 + 30n * DAY, status: 'funded' as const }
  assert.equal(clockStart(invoice), T0 + 30n * DAY)
  assert.equal(schedule(invoice, T0 + 30n * DAY).silenceReleasesAt, T0 + 37n * DAY + 1n)
  assert.equal(clockStart({ ...invoice, fundedAt: null }), null)

  // Never accepted: anyone may send it back after its timeout, once the funding is observed.
  const open = { ...base, steps: [] as Step[], fundedAt: T0 + DAY }
  assert.equal(unacceptedTimeout(open), T0 + DAY + 30n * DAY, 'no steps: thirty days after the funding')
  assert.equal(schedule(open, T0 + DAY).closeUnacceptedAt, T0 + 31n * DAY + 1n)
  assert.equal(unacceptedTimeout({ ...open, steps }), T0 + DAY + 3n * DAY, 'steps: the last deadline from the funding')
  assert.equal(unacceptedTimeout({ ...open, steps, serviceTime: T0 + 10n * DAY }), T0 + 13n * DAY, 'or from a later service time')
  assert.equal(unacceptedTimeout({ ...open, fundedAt: null }), null, 'not before the funding is observed')
  assert.equal(schedule({ ...open, fundedAt: null }, T0).closeUnacceptedAt, null)
  assert.equal(schedule({ ...open, acceptedAt: T0 + 2n * DAY, status: 'funded' }, T0).closeUnacceptedAt, null, 'not once accepted')
  assert.equal(schedule({ ...open, status: 'ended' }, T0).closeUnacceptedAt, null, 'not once ended')
})

test('payouts: the seller\'s share rounds down, the buyer gets the rest and the excess', () => {
  assert.equal(share(1_000_000n, 10_000), 1_000_000n)
  assert.equal(share(1_000_000n, 0), 0n)
  assert.equal(share(1_000_001n, 5_000), 500_000n)
  assert.equal(share(3n, 3_333), 0n)
  assert.throws(() => share(1n, 10_001), RangeError)
  assert.deepEqual(payout(1_000_000n, 1_500_000n, 7_000), { toSeller: 700_000n, toBuyer: 800_000n })
  assert.deepEqual(payout(1_000_000n, 1_000_000n, 10_000), { toSeller: 1_000_000n, toBuyer: 0n })
  // A cancellation's remainder is the seller's share, and it rounds down like every other: the
  // buyer gets at least the step's percent.
  assert.deepEqual(cancelPayout(1_000_001n, 1_000_002n, 5_000), { toSeller: 500_000n, toBuyer: 500_002n })
  assert.deepEqual(cancelPayout(3n, 3n, 5_000), { toSeller: 1n, toBuyer: 2n })
  assert.deepEqual(cancelPayout(1n, 1n, 9_999), { toSeller: 0n, toBuyer: 1n })
  assert.deepEqual(cancelPayout(1_000_000n, 1_000_000n, 10_000), { toSeller: 0n, toBuyer: 1_000_000n })
  assert.throws(() => payout(2n, 1n, 10_000), /NotFunded/)
  assert.throws(() => cancelPayout(2n, 1n, 10_000), /NotFunded/)
})

test('the pay link names the escrow, the token and the amount, and only while the escrow waits for its money', () => {
  const escrow = escrowAddress(buyer, 7n)
  assert.equal(formatAmount(1_000_000n, 6), '1')
  assert.equal(formatAmount(1_500_000n, 6), '1.5')
  assert.equal(formatAmount(1n, 6), '0.000001')
  assert.equal(formatAmount(0n, 6), '0')
  assert.equal(formatAmount(123_456_789n, 8), '1.23456789')
  assert.equal(formatAmount(5n, 0), '5')
  const account = escrowAccount({ amount: 1_500_000n })
  const url = solanaPayUrl({ account, decimals: 6, label: 'Forest', message: 'Maths, Tuesday 4pm' })
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'solana:')
  assert.equal(parsed.pathname, escrow.toBase58())
  assert.equal(parsed.searchParams.get('amount'), '1.5')
  assert.equal(parsed.searchParams.get('spl-token'), mint.toBase58())
  assert.equal(parsed.searchParams.get('reference'), escrow.toBase58())
  assert.equal(parsed.searchParams.get('label'), 'Forest')
  assert.equal(parsed.searchParams.get('message'), 'Maths, Tuesday 4pm')
  assert.ok(!/wallet|USDC|chain|gas/i.test(url.replace(mint.toBase58(), '')), 'no crypto words in what a person reads')

  // One-time: an accepted invoice still waiting is fine; anything funded or ended is refused.
  assert.ok(awaitingPayment(account))
  assert.doesNotThrow(() => solanaPayUrl({ account: { ...account, status: 'accepted', acceptedAt: T0 }, decimals: 6 }))
  for (const over of [
    { status: 'funded' as const, fundedAt: T0, acceptedAt: T0 },
    { status: 'locked' as const, fundedAt: T0, acceptedAt: T0 },
    { status: 'ended' as const, fundedAt: T0, endedAt: T0 },
    { status: 'open' as const, fundedAt: T0 },
    { status: 'accepted' as const, fundedAt: T0, acceptedAt: T0 },
  ]) {
    assert.equal(awaitingPayment({ ...account, ...over }), false, over.status)
    assert.throws(() => solanaPayUrl({ account: { ...account, ...over }, decimals: 6 }), /one-time/, over.status)
  }
})

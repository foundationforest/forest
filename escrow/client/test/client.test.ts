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
import { Keypair, PublicKey } from '@solana/web3.js'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPS,
  ESCROW_LEN,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  VERSION,
  agreeIx,
  approveIx,
  cancelBuyerIx,
  cancelPayout,
  cancelSellerIx,
  clockStart,
  closeIx,
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
  markFundedIx,
  objectIx,
  payout,
  randomId,
  releaseBySilenceIx,
  schedule,
  share,
  silenceEnds,
  solanaPayUrl,
  stepFromMarket,
  termsFor,
  validateTerms,
  vaultAddress,
  type EscrowAccount,
  type MarketDefaults,
  type Step,
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
  assert.ok(lib.includes(`assert!(Escrow::LEN == ${ESCROW_LEN});`))
  assert.ok(state.includes('pub const MAX_STEPS: usize = 4;'))
  assert.ok(state.includes('pub const BPS: u16 = 10_000;'))
  assert.equal(BPS, 10_000)
})

test('the discriminators are pinned', () => {
  const ixs: Record<string, string> = {
    create: '181ec828051c0777',
    mark_funded: '9a19863dc8b81d38',
    approve: '454ad9247375614c',
    release_by_silence: '30c52c966e7a5822',
    object: '2351ffae3d579786',
    agree: 'd24a26e1bfd12265',
    arbitrate: '695b6e96d80b8e8e',
    cancel_buyer: '5387a78fe8b163f5',
    cancel_seller: 'd11d75c3f77f09a3',
    close: '62a5c9b16c41ce60',
  }
  for (const [name, want] of Object.entries(ixs)) assert.equal(hex(discriminator('global', name)), want, name)
  const events: Record<string, string> = {
    Created: '41fe44f56694f44c',
    Funded: '43543858c00cc9b1',
    Approved: '11e09689ae68075b',
    ReleasedBySilence: 'e92671208e065438',
    Objected: 'e8d59f3063e1e34a',
    Agreed: '367c553aa9731be6',
    Arbitrated: '45c47f6b8dab3ae2',
    CancelledByBuyer: '98aa1e87b1d8de49',
    CancelledBySeller: '4582b9a7fdf2512f',
    Closed: '321f579b87dcc3ef',
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
  const bytes = createArgsBytes(t)
  // id 8, seller 32, arbiter 1+32, amount 8, service_time 1+8, silence_days 2, steps 4 + 2×10.
  assert.equal(bytes.length, 8 + 32 + 33 + 8 + 9 + 2 + 4 + 20)
  const v = new DataView(bytes.buffer, bytes.byteOffset)
  assert.equal(v.getBigUint64(0, true), 7n)
  assert.deepEqual(new PublicKey(bytes.subarray(8, 40)), seller)
  assert.equal(bytes[40], 1)
  assert.deepEqual(new PublicKey(bytes.subarray(41, 73)), arbiter)
  assert.equal(v.getBigUint64(73, true), 1_000_000n)
  assert.equal(bytes[81], 1)
  assert.equal(v.getBigInt64(82, true), T0 + 10n * DAY)
  assert.equal(v.getUint16(90, true), 7)
  assert.equal(v.getUint32(92, true), 2)
  assert.equal(v.getBigInt64(96, true), DAY)
  assert.equal(v.getUint16(104, true), 10_000)
  assert.equal(v.getBigInt64(106, true), 3n * DAY)
  assert.equal(v.getUint16(114, true), 5_000)

  // No arbiter, no service time, no steps: one byte each for the options, four for the count.
  const bare = createArgsBytes(terms({ steps: [] }))
  assert.equal(bare.length, 8 + 32 + 1 + 8 + 1 + 2 + 4)
  assert.equal(bare[40], 0)
  assert.equal(bare[49], 0)

  const ix = createIx({ buyer, payer, mint, terms: t })
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
})

test('the endings share one account list and add their signers after it', () => {
  const escrow = escrowAddress(buyer, 7n)
  const accounts = {
    escrow,
    vault: vaultAddress(escrow, mint),
    buyerTokens: Keypair.generate().publicKey,
    sellerTokens: Keypair.generate().publicKey,
    rentPayer: payer,
  }
  const common = [accounts.escrow, accounts.vault, accounts.buyerTokens, accounts.sellerTokens, accounts.rentPayer, TOKEN_PROGRAM_ID].map((k) => k.toBase58())
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
    [closeIx({ accounts, party: seller }), seller],
  ] as const) {
    assert.deepEqual(keys(ix), [...common, who.toBase58()])
    assert.equal(ix.data.length, 8)
  }
  assert.deepEqual(keys(markFundedIx({ escrow, vault: accounts.vault })), [escrow.toBase58(), accounts.vault.toBase58()])
  assert.deepEqual(signers(objectIx({ escrow, vault: accounts.vault, buyer })), [buyer.toBase58()])

  assert.throws(() => approveIx({ accounts, buyer, sellerBps: 10_001 }), /BadSplit/)
  assert.throws(() => agreeIx({ accounts, buyer, seller, sellerBps: -1 }), /BadSplit/)
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
    assert.throws(() => createIx({ buyer, payer, mint, terms: terms(over) }), want, what)
  }
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
  d[276] = 2
  d[277] = 254
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
  } satisfies EscrowAccount)

  // The zero key and zero times read back as null.
  PublicKey.default.toBuffer().copy(d, 73)
  d.writeBigInt64LE(0n, 209)
  d.writeBigInt64LE(0n, 268)
  d[276] = 0
  const bare = decodeEscrow(new Uint8Array(b))
  assert.equal(bare.arbiter, null)
  assert.equal(bare.serviceTime, null)
  assert.equal(bare.fundedAt, null)
  assert.equal(bare.status, 'open')

  assert.throws(() => decodeEscrow(new Uint8Array(10)), /286 bytes/)
  b[0] ^= 1
  assert.throws(() => decodeEscrow(new Uint8Array(b)), /not an escrow/)
})

test('events decode from the log, in order', () => {
  const escrow = escrowAddress(buyer, 7n)
  const closed = Buffer.alloc(8 + 32 + 1 + 8 * 4 + 32 + 8)
  Buffer.from('321f579b87dcc3ef', 'hex').copy(closed, 0)
  escrow.toBuffer().copy(closed, 8)
  closed[40] = 4 // CancelledByBuyer
  closed.writeBigUInt64LE(1_000_000n, 41)
  closed.writeBigUInt64LE(1_000_001n, 49)
  closed.writeBigUInt64LE(500_000n, 57)
  closed.writeBigUInt64LE(500_001n, 65)
  payer.toBuffer().copy(closed, 73)
  closed.writeBigUInt64LE(4_000_000n, 105)

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

  const logs = [
    'Program FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT invoke [1]',
    `Program data: ${created.toString('base64')}`,
    'Program log: something else',
    `Program data: ${cancelled.toString('base64')}`,
    `Program data: ${closed.toString('base64')}`,
    'Program data: AAAA',
  ]
  const events = decodeEvents(logs)
  assert.equal(events.length, 3)
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
  assert.deepEqual(events[1], { kind: 'cancelledByBuyer', escrow, step: 1, refundBps: 5_000, toBuyer: 500_001n, toSeller: 500_000n })
  assert.deepEqual(events[2], {
    kind: 'closed',
    escrow,
    outcome: 'cancelledByBuyer',
    amount: 1_000_000n,
    balance: 1_000_001n,
    toSeller: 500_000n,
    toBuyer: 500_001n,
    rentPayer: payer,
    rentLamports: 4_000_000n,
  })
  assert.equal(decodeEvent(new Uint8Array(7)), null)
  assert.throws(() => decodeEvent(new Uint8Array([...closed, 0])), /trailing/)
})

test('an event only counts when the escrow program itself wrote it', () => {
  // Any program can write a `Program data:` line with an escrow event's exact bytes: a receipt
  // for a deal that never happened, at any address. The runtime's own invoke and success lines
  // say which program wrote each line, and no program can forge those.
  const escrow = escrowAddress(buyer, 7n)
  const closed = Buffer.alloc(8 + 32 + 1 + 8 * 4 + 32 + 8)
  Buffer.from('321f579b87dcc3ef', 'hex').copy(closed, 0)
  escrow.toBuffer().copy(closed, 8)
  closed[40] = 0 // Approved
  closed.writeBigUInt64LE(10_000_000_000n, 41)
  closed.writeBigUInt64LE(10_000_000_000n, 49)
  closed.writeBigUInt64LE(10_000_000_000n, 57)
  payer.toBuffer().copy(closed, 73)
  const line = `Program data: ${closed.toString('base64')}`
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

test('terms come from the market file\'s defaults and the parties\' choices', () => {
  const market: MarketDefaults = {
    silenceDays: 7,
    arbiterAllowed: false,
    cancellationSteps: [
      { hours: -24, refundPercent: 100 },
      { hours: 0, refundPercent: 50 },
    ],
    tokens: [{ symbol: 'USDC', mint: mint.toBase58(), chain: 'solana' }],
  }
  const t = termsFor(market, { seller, amount: 1_000_000n, mint, serviceTime: new Date(Number(T0) * 1000), id: 7n })
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
  assert.throws(() => termsFor(market, { seller, amount: 1n, mint, arbiter }), /does not allow an arbiter/)
  assert.throws(() => termsFor(market, { seller, amount: 1n, mint: Keypair.generate().publicKey }), /does not accept mint/)
  const allowed = termsFor({ ...market, arbiterAllowed: true }, { seller, amount: 1n, mint, arbiter, silenceDays: 3, steps: [] })
  assert.deepEqual(allowed.arbiter, arbiter)
  assert.equal(allowed.silenceDays, 3)
  assert.deepEqual(allowed.steps, [])
  assert.equal(allowed.serviceTime, null)
  const noSteps = termsFor({ ...market, cancellationSteps: undefined }, { seller, amount: 1n, mint })
  assert.deepEqual(noSteps.steps, [])
  assert.ok(noSteps.id >= 0n)
  assert.deepEqual(stepFromMarket({ hours: 1.5, refundPercent: 12.5 }), { offset: 5_400n, refundBps: 1_250 })
  assert.throws(() => stepFromMarket({ hours: 1, refundPercent: 101 }), /0 to 100/)
})

test('finding: termsFor builds terms the program accepts but no buyer meant', () => {
  // Adversarial review 1. Each of these passes termsFor and validateTerms, and create accepts it.
  // Pinned so a change that refuses or warns shows up here.
  const market: MarketDefaults = {
    silenceDays: 7,
    arbiterAllowed: true,
    cancellationSteps: [{ hours: 240, refundPercent: 100 }],
    tokens: [{ symbol: 'USDC', mint: mint.toBase58(), chain: 'solana' }],
  }
  // A number is read as unix seconds, so `Date.now()` (milliseconds) puts the service time some
  // 55,000 years out: silence never comes, and the buyer can cancel for a full refund until then.
  const ms = termsFor(market, { seller, amount: 1n, mint, serviceTime: 1_800_000_000_000 })
  assert.equal(ms.serviceTime, 1_800_000_000_000n)
  validateTerms(ms, buyer)
  // A market whose refund step outlasts its silence: from day seven both the seller's release and
  // the buyer's full cancellation are valid, and whichever lands first wins.
  const race = termsFor(market, { seller, amount: 1n, mint })
  assert.ok(race.steps[0].offset > BigInt(race.silenceDays) * 86_400n)
  validateTerms(race, buyer)
  // A service time already past: funding that arrives after silence releases in the same second.
  const past = termsFor(market, { seller, amount: 1n, mint, serviceTime: new Date(0 + 1000) })
  validateTerms(past, buyer)
})

test('the clock start, silence and each deadline, as the program will read them', () => {
  const steps: Step[] = [
    { offset: DAY, refundBps: 10_000 },
    { offset: 3n * DAY, refundBps: 5_000 },
  ]
  const base = { serviceTime: null, fundedAt: null, silenceDays: 7, steps, createdAt: T0, status: 'open' as const }

  // Not yet funded, no service time: no clock.
  let s = schedule(base, T0 + DAY)
  assert.equal(s.clockStart, null)
  assert.equal(s.silenceReleasesAt, null)
  assert.deepEqual(s.deadlines, [])
  assert.equal(s.buyerCanCancel, false)
  assert.equal(s.buyerCanObject, false)
  assert.equal(s.buyerCanCloseUnfundedAt, T0 + 3n * DAY + 1n, 'measured from creation when there is no service time')
  assert.equal(schedule(base, T0 + 3n * DAY + 1n).buyerCanCloseUnfundedAt, null, 'now')
  assert.equal(schedule({ ...base, steps: [] }, T0).buyerCanCloseUnfundedAt, null, 'no steps: now')

  // Funded at T0 + 1 day.
  const funded = { ...base, fundedAt: T0 + DAY, status: 'funded' as const }
  assert.equal(clockStart(funded), T0 + DAY)
  s = schedule(funded, T0 + DAY)
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

  // A service time wins over the funding time, and negative offsets fall before it.
  const timed = { ...funded, serviceTime: T0 + 30n * DAY, steps: [{ offset: -DAY, refundBps: 10_000 }, { offset: 0n, refundBps: 5_000 }] }
  s = schedule(timed, T0 + DAY)
  assert.equal(s.clockStart, T0 + 30n * DAY)
  assert.equal(s.silenceReleasesAt, T0 + 37n * DAY + 1n)
  assert.deepEqual(s.deadlines.map((d) => d.deadline), [T0 + 29n * DAY, T0 + 30n * DAY])
  assert.equal(schedule({ ...timed, fundedAt: null, status: 'open' }, T0).buyerCanCloseUnfundedAt, T0 + 30n * DAY + 1n)
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

test('the pay link names the escrow, the token and the amount', () => {
  const escrow = escrowAddress(buyer, 7n)
  assert.equal(formatAmount(1_000_000n, 6), '1')
  assert.equal(formatAmount(1_500_000n, 6), '1.5')
  assert.equal(formatAmount(1n, 6), '0.000001')
  assert.equal(formatAmount(0n, 6), '0')
  assert.equal(formatAmount(123_456_789n, 8), '1.23456789')
  assert.equal(formatAmount(5n, 0), '5')
  const url = solanaPayUrl({ escrow, mint, amount: 1_500_000n, decimals: 6, label: 'Forest', message: 'Maths, Tuesday 4pm' })
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'solana:')
  assert.equal(parsed.pathname, escrow.toBase58())
  assert.equal(parsed.searchParams.get('amount'), '1.5')
  assert.equal(parsed.searchParams.get('spl-token'), mint.toBase58())
  assert.equal(parsed.searchParams.get('reference'), escrow.toBase58())
  assert.equal(parsed.searchParams.get('label'), 'Forest')
  assert.equal(parsed.searchParams.get('message'), 'Maths, Tuesday 4pm')
  assert.ok(!/wallet|USDC|chain|gas/i.test(url.replace(mint.toBase58(), '')), 'no crypto words in what a person reads')
})

// The client against a real validator: start one, load the program, and run two deals end to
// end. In the first the buyer opens the escrow, the seller reads it off the chain and accepts,
// money arrives by a plain token transfer any wallet could make, anyone marks it funded, and the
// buyer approves a split. In the second the seller opens it as an invoice and the buyer pays and
// approves in one transaction. Then the balances, the rent, the receipts and the events are checked.
// Last, the invoice's old pay link is paid again: a stranger sends that money back to the buyer's
// refund address, and SOL sent to the receipt is swept back to the rent payer.
//
//   npm run test:validator
//
// Needs `solana-test-validator` on the PATH and the program built (`cargo build-sbf` in
// ../program). If either is missing the test says which and skips.
//
// Everything here polls `getSignatureStatuses` rather than calling `confirmTransaction`, which
// opens a websocket subscription that keeps Node alive long after the test has passed.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
} from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'

import {
  PROGRAM_ID,
  acceptIx,
  approveIx,
  checkTerms,
  createIx,
  decodeEscrow,
  decodeEvents,
  depositAddress,
  escrowAddress,
  invoice,
  markFundedIx,
  payout,
  recoverLateIx,
  refundAddress,
  makeRefundAddressIx,
  schedule,
  solanaPayUrl,
  sweepRentIx,
  termsFor,
  type OfferTerms,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const soPath = join(here, '../../program/target/deploy/forest_escrow.so')
const RPC = 'http://127.0.0.1:8899'

function missing(): string | null {
  if (!existsSync(soPath)) return `no program at ${soPath}; run \`cargo build-sbf\` in escrow/program`
  return null
}

let validator: ChildProcess | undefined
let ledger: string | undefined
let connection: Connection

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function confirm(signature: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return
    await sleep(250)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function send(instructions: Transaction['instructions'], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  return signature
}

async function logsOf(signature: string): Promise<string[]> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  return tx?.meta?.logMessages ?? []
}

before(
  async () => {
    if (missing()) return
    ledger = mkdtempSync(join(tmpdir(), 'forest-escrow-ledger-'))
    validator = spawn(
      'solana-test-validator',
      ['--reset', '--quiet', '--ledger', ledger, '--bpf-program', PROGRAM_ID.toBase58(), soPath],
      { stdio: 'ignore' },
    )
    validator.on('error', () => {
      validator = undefined
    })
    connection = new Connection(RPC, 'confirmed')
    for (let i = 0; i < 90 && validator; i++) {
      try {
        await connection.getVersion()
        return
      } catch {
        await sleep(1000)
      }
    }
    validator = undefined
  },
  { timeout: 150_000 },
)

after(() => {
  validator?.kill('SIGKILL')
  if (ledger) rmSync(ledger, { recursive: true, force: true })
})

test('two deals go through a real validator: a proposal the seller accepts, and an invoice paid in one tap', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  // The fee payer and rent payer (a fee payer service in production). Buyer and seller are two keys.
  const payer = Keypair.generate()
  const buyer = Keypair.generate()
  const seller = Keypair.generate()
  const airdrop = await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL)
  await confirm(airdrop)

  // A six-decimal classic SPL Token mint, and a token account each. The buyer holds 10.00.
  const mint = Keypair.generate()
  const buyerTokens = Keypair.generate()
  const sellerTokens = Keypair.generate()
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
  const accountRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
  const newAccount = (key: PublicKey, space: number, lamports: number) =>
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: key, space, lamports, programId: TOKEN_PROGRAM_ID })
  await send(
    [
      newAccount(mint.publicKey, MINT_SIZE, mintRent),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
      newAccount(buyerTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(buyerTokens.publicKey, mint.publicKey, buyer.publicKey),
      newAccount(sellerTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(sellerTokens.publicKey, mint.publicKey, seller.publicKey),
      createMintToInstruction(mint.publicKey, buyerTokens.publicKey, payer.publicKey, 10_000_000),
    ],
    [payer, mint, buyerTokens, sellerTokens],
  )

  // The offer's terms, as the seller set them in the post, plus the deal's own choices.
  const offer: OfferTerms = {
    autoReleaseDays: 7,
    cancellationSteps: [
      { hours: -24, refundPercent: 100 },
      { hours: 0, refundPercent: 50 },
    ],
  }
  const inTenDays = BigInt(Math.floor(Date.now() / 1000)) + 10n * 86_400n
  const terms = termsFor(offer, { seller: seller.publicKey, amount: 1_000_000n, mint: mint.publicKey, serviceTime: inTenDays })
  const escrow = escrowAddress(buyer.publicKey, terms.id)
  const vault = depositAddress(escrow, mint.publicKey)

  const payerBefore = await connection.getBalance(payer.publicKey)
  const created = await send([createIx({ buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, terms })], [payer, buyer])
  const [createdEvent] = decodeEvents(await logsOf(created))
  assert.equal(createdEvent.kind, 'created')
  assert.deepEqual(createdEvent.escrow, escrow)

  let e = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  assert.equal(e.status, 'open')
  assert.deepEqual(e.vault, vault)
  assert.equal(e.serviceTime, inTenDays)
  assert.deepEqual(e.steps, terms.steps)
  const escrowRent = await connection.getBalance(escrow)
  const vaultRent = await connection.getBalance(vault)
  assert.ok(escrowRent > 0 && vaultRent > 0)

  // The seller reads the escrow off the chain, checks its terms, and accepts.
  const accepted = await send([acceptIx({ account: e, seller: seller.publicKey, arbiter: null })], [payer, seller])
  assert.deepEqual(decodeEvents(await logsOf(accepted)).map((ev) => ev.kind), ['accepted'])
  e = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  assert.equal(e.status, 'accepted')
  assert.ok(e.acceptedAt !== null)

  // The pay link points at the escrow; the money arrives by a plain transfer to the deposit
  // address, the way any wallet would send it. Half a dollar too much, on purpose.
  const link = solanaPayUrl({ account: e, decimals: 6 })
  assert.ok(link.startsWith(`solana:${escrow.toBase58()}?amount=1&`))
  await send([createTransferInstruction(buyerTokens.publicKey, vault, buyer.publicKey, 1_500_000)], [payer, buyer])
  assert.equal((await getAccount(connection, vault)).amount, 1_500_000n)

  // Anyone marks it funded: only the fee payer signs.
  const marked = await send([markFundedIx({ escrow, vault })], [payer])
  const [fundedEvent] = decodeEvents(await logsOf(marked))
  assert.equal(fundedEvent.kind, 'funded')
  e = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  assert.equal(e.status, 'funded')
  assert.ok(e.fundedAt !== null)
  assert.throws(() => solanaPayUrl({ account: e, decimals: 6 }), /one-time/, 'no second link once the money is in')
  const s = schedule(e)
  assert.equal(s.clockStart, inTenDays, 'the service time, later than the funding and the acceptance, is the clock start')
  assert.deepEqual(s.deadlines.map((d) => d.deadline), [inTenDays - 86_400n, inTenDays])
  assert.equal(s.silenceReleasesAt, inTenDays + 7n * 86_400n + 1n)
  assert.equal(s.buyerCanCancel, true)

  // The buyer approves 70/30. Balances, rent and events, exact. The buyer's share goes to its
  // refund address, its standard account for the mint, and nowhere else; this buyer holds its
  // tokens in another account and has none yet, so it is made first in the same transaction.
  const expected = payout(terms.amount, 1_500_000n, 7_000)
  const refund = refundAddress(buyer.publicKey, mint.publicKey)
  assert.equal(await connection.getAccountInfo(refund), null, 'no refund address yet')
  const accounts = { escrow, vault, buyer: buyer.publicKey, mint: mint.publicKey, sellerTokens: sellerTokens.publicKey, rentPayer: payer.publicKey }
  const approved = await send(
    [
      makeRefundAddressIx({ payer: payer.publicKey, buyer: buyer.publicKey, mint: mint.publicKey }),
      approveIx({ accounts, buyer: buyer.publicKey, sellerBps: 7_000 }),
    ],
    [payer, buyer],
  )
  const events = decodeEvents(await logsOf(approved))
  assert.deepEqual(
    events.map((ev) => ev.kind),
    ['approved', 'ended'],
  )
  assert.deepEqual(events[0], { kind: 'approved', escrow, sellerBps: 7_000, toSeller: 700_000n, toBuyer: 800_000n })
  assert.equal(events[1].kind, 'ended')
  if (events[1].kind === 'ended') {
    assert.equal(events[1].outcome, 'approved')
    assert.equal(events[1].balance, 1_500_000n)
    assert.equal(events[1].acceptedAt, e.acceptedAt)
    assert.equal(events[1].rentLamports, BigInt(vaultRent))
    assert.deepEqual(events[1].rentPayer, payer.publicKey)
  }
  assert.equal((await getAccount(connection, sellerTokens.publicKey)).amount, expected.toSeller)
  assert.equal((await getAccount(connection, buyerTokens.publicKey)).amount, 10_000_000n - 1_500_000n, 'nothing back here')
  assert.equal((await getAccount(connection, refund)).amount, expected.toBuyer, "the buyer's share, at its refund address")
  const refundRent = await connection.getBalance(refund)
  assert.equal(await connection.getAccountInfo(vault), null, 'the deposit account is closed')
  // The escrow account stays: the receipt, with how it ended and who got what.
  const receipt = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  assert.deepEqual([receipt.status, receipt.outcome, receipt.toSeller, receipt.toBuyer], ['ended', 'approved', 700_000n, 800_000n])
  assert.equal(await connection.getBalance(escrow), escrowRent, 'the receipt keeps its rent')
  // The rent payer paid the transaction fees and the receipt's rent, and got the deposit account's back.
  const fees = 10 * 5_000 // generously: five transactions of at most two signatures
  const payerAfter = await connection.getBalance(payer.publicKey)
  const spent = payerBefore - payerAfter - escrowRent - refundRent
  assert.ok(spent > 0 && spent <= fees, `only fees, the receipt's rent and the refund address's left the payer: ${payerBefore - payerAfter} lamports`)

  // An invoice: the seller opens it naming the buyer, accepted from creation; the buyer reads it,
  // checks its terms, and pays and approves in one tap.
  const invoiceTerms = termsFor(offer, { seller: seller.publicKey, amount: 2_000_000n, mint: mint.publicKey, serviceTime: inTenDays })
  const inv = invoice({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, decimals: 6, terms: invoiceTerms })
  const invoiced = await send([inv.instruction], [payer, seller])
  assert.deepEqual(decodeEvents(await logsOf(invoiced)).map((ev) => ev.kind), ['created', 'accepted'])
  const onChain = decodeEscrow(new Uint8Array((await connection.getAccountInfo(inv.escrow))!.data))
  checkTerms(onChain, { arbiter: null })
  const invoiceAccounts = { escrow: inv.escrow, vault: inv.deposit, buyer: buyer.publicKey, mint: mint.publicKey, sellerTokens: sellerTokens.publicKey, rentPayer: payer.publicKey }
  const paid = await send(
    [createTransferInstruction(buyerTokens.publicKey, inv.deposit, buyer.publicKey, 2_000_000), approveIx({ accounts: invoiceAccounts, buyer: buyer.publicKey })],
    [payer, buyer],
  )
  const paidEvents = decodeEvents(await logsOf(paid))
  assert.deepEqual(paidEvents.map((ev) => ev.kind), ['approved', 'ended'])
  assert.ok(paidEvents[1].kind === 'ended' && paidEvents[1].acceptedAt === onChain.acceptedAt, 'the receipt says the seller accepted')
  assert.equal((await getAccount(connection, sellerTokens.publicKey)).amount, expected.toSeller + 2_000_000n)

  // The invoice's link is paid again, after the end: the deposit account is made again (here the
  // app pays for it; the buyer holds no SOL in this test) and the buyer sends. A stranger sends it
  // back to the buyer's refund address, where the first deal's share already sits; the deposit
  // account's rent goes to the buyer.
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, inv.deposit, inv.escrow, mint.publicKey),
      createTransferInstruction(buyerTokens.publicKey, inv.deposit, buyer.publicKey, 300_000),
    ],
    [payer, buyer],
  )
  const stranger = Keypair.generate()
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], [payer])
  const ended = decodeEscrow(new Uint8Array((await connection.getAccountInfo(inv.escrow))!.data))
  const receiptBytes = (await connection.getAccountInfo(inv.escrow))!.data
  const recovered = await send([recoverLateIx({ account: ended, caller: stranger.publicKey })], [payer, stranger])
  const [late] = decodeEvents(await logsOf(recovered))
  assert.equal(late.kind, 'recoveredLate')
  assert.equal(late.kind === 'recoveredLate' && late.toBuyer, 300_000n)
  assert.equal((await getAccount(connection, refund)).amount, expected.toBuyer + 300_000n, "at the buyer's refund address")
  assert.equal(await connection.getAccountInfo(inv.deposit), null, 'the deposit account is closed again')
  assert.deepEqual((await connection.getAccountInfo(inv.escrow))!.data, receiptBytes, 'the receipt does not change')

  // SOL sent to the receipt goes back to the rent payer, and the receipt keeps exactly its minimum.
  const minimum = await connection.getBalance(inv.escrow)
  await send([SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: inv.escrow, lamports: 1_000_000 })], [payer, stranger])
  const payerBeforeSweep = await connection.getBalance(payer.publicKey)
  const swept = await send([sweepRentIx({ escrow: inv.escrow, rentPayer: payer.publicKey })], [payer])
  const [sweep] = decodeEvents(await logsOf(swept))
  assert.deepEqual(sweep, { kind: 'rentSwept', escrow: inv.escrow, lamports: 1_000_000n, left: BigInt(minimum) })
  assert.equal(await connection.getBalance(inv.escrow), minimum)
  assert.equal(await connection.getBalance(payer.publicKey), payerBeforeSweep + 1_000_000 - 5_000, 'the rent payer, less this fee')

  console.log(`  escrow ${escrow.toBase58()}: accepted, funded 1.5 by plain transfer, approved 70/30, ${vaultRent} lamports of rent returned, ${escrowRent} kept in the receipt`)
  console.log(`  invoice ${inv.escrow.toBase58()}: paid and approved in one tap; paid again later and sent back to the buyer by a stranger; a SOL tip swept to the rent payer`)
})

// The client against a real validator: start one, load the program, and run two deals end to
// end. In the first the buyer opens the escrow, the seller reads it off the chain and accepts,
// money arrives by a plain token transfer any wallet could make, anyone marks it funded, and the
// buyer approves a split. In the second the seller opens it as an invoice and the buyer pays and
// approves in one transaction. Then the balances, the rent, the receipts and the events are checked.
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
  schedule,
  solanaPayUrl,
  termsFor,
  type MarketDefaults,
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

  // The fee payer and rent payer; a sponsor in production. Buyer and seller are two keys.
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

  // The market's defaults, as its file would carry them, plus the parties' choices.
  const market: MarketDefaults = {
    silenceDays: 7,
    arbiterAllowed: false,
    cancellationSteps: [
      { hours: -24, refundPercent: 100 },
      { hours: 0, refundPercent: 50 },
    ],
    tokens: [{ symbol: 'USDC', mint: mint.publicKey.toBase58(), chain: 'solana' }],
  }
  const inTenDays = BigInt(Math.floor(Date.now() / 1000)) + 10n * 86_400n
  const terms = termsFor(market, { seller: seller.publicKey, amount: 1_000_000n, mint: mint.publicKey, serviceTime: inTenDays })
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
  const link = solanaPayUrl({ escrow, mint: mint.publicKey, amount: terms.amount, decimals: 6 })
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
  const s = schedule(e)
  assert.equal(s.clockStart, inTenDays, 'the service time is the clock start')
  assert.deepEqual(s.deadlines.map((d) => d.deadline), [inTenDays - 86_400n, inTenDays])
  assert.equal(s.silenceReleasesAt, inTenDays + 7n * 86_400n + 1n)
  assert.equal(s.buyerCanCancel, true)

  // The buyer approves 70/30. Balances, rent and events, exact.
  const expected = payout(terms.amount, 1_500_000n, 7_000)
  const accounts = { escrow, vault, buyerTokens: buyerTokens.publicKey, sellerTokens: sellerTokens.publicKey, rentPayer: payer.publicKey }
  const approved = await send([approveIx({ accounts, buyer: buyer.publicKey, sellerBps: 7_000 })], [payer, buyer])
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
  assert.equal((await getAccount(connection, buyerTokens.publicKey)).amount, 10_000_000n - 1_500_000n + expected.toBuyer)
  assert.equal(await connection.getAccountInfo(vault), null, 'the deposit account is closed')
  // The escrow account stays: the receipt, with how it ended and who got what.
  const receipt = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  assert.deepEqual([receipt.status, receipt.outcome, receipt.toSeller, receipt.toBuyer], ['ended', 'approved', 700_000n, 800_000n])
  assert.equal(await connection.getBalance(escrow), escrowRent, 'the receipt keeps its rent')
  // The rent payer paid the transaction fees and the receipt's rent, and got the deposit account's back.
  const fees = 10 * 5_000 // generously: five transactions of at most two signatures
  const payerAfter = await connection.getBalance(payer.publicKey)
  const spent = payerBefore - payerAfter - escrowRent
  assert.ok(spent > 0 && spent <= fees, `only fees and the receipt's rent left the payer: ${payerBefore - payerAfter} lamports`)

  // An invoice: the seller opens it naming the buyer, accepted from creation; the buyer reads it,
  // checks its terms, and pays and approves in one tap.
  const invoiceTerms = termsFor(market, { seller: seller.publicKey, amount: 2_000_000n, mint: mint.publicKey, serviceTime: inTenDays })
  const inv = invoice({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, decimals: 6, terms: invoiceTerms })
  const invoiced = await send([inv.instruction], [payer, seller])
  assert.deepEqual(decodeEvents(await logsOf(invoiced)).map((ev) => ev.kind), ['created', 'accepted'])
  const onChain = decodeEscrow(new Uint8Array((await connection.getAccountInfo(inv.escrow))!.data))
  checkTerms(onChain, { arbiter: null })
  const invoiceAccounts = { escrow: inv.escrow, vault: inv.deposit, buyerTokens: buyerTokens.publicKey, sellerTokens: sellerTokens.publicKey, rentPayer: payer.publicKey }
  const paid = await send(
    [createTransferInstruction(buyerTokens.publicKey, inv.deposit, buyer.publicKey, 2_000_000), approveIx({ accounts: invoiceAccounts, buyer: buyer.publicKey })],
    [payer, buyer],
  )
  const paidEvents = decodeEvents(await logsOf(paid))
  assert.deepEqual(paidEvents.map((ev) => ev.kind), ['approved', 'ended'])
  assert.ok(paidEvents[1].kind === 'ended' && paidEvents[1].acceptedAt === onChain.acceptedAt, 'the receipt says the seller accepted')
  assert.equal((await getAccount(connection, sellerTokens.publicKey)).amount, expected.toSeller + 2_000_000n)

  console.log(`  escrow ${escrow.toBase58()}: accepted, funded 1.5 by plain transfer, approved 70/30, ${vaultRent} lamports of rent returned, ${escrowRent} kept in the receipt`)
  console.log(`  invoice ${inv.escrow.toBase58()}: paid and approved in one tap`)
})

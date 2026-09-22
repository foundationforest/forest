// The client against a real validator: start one, load the program, and run one deal end to
// end. The buyer opens the escrow, money arrives by a plain token transfer any wallet could
// make, anyone marks it funded, and the buyer approves a split. Then the balances, the rent and
// the events are checked.
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
  approveIx,
  createIx,
  decodeEscrow,
  decodeEvents,
  depositAddress,
  escrowAddress,
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

test('one deal goes through a real validator: create, fund by plain transfer, mark, approve a split', { timeout: 300_000 }, async (t) => {
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
  const rentHeld = (await connection.getBalance(escrow)) + (await connection.getBalance(vault))
  assert.ok(rentHeld > 0)

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
    ['approved', 'closed'],
  )
  assert.deepEqual(events[0], { kind: 'approved', escrow, sellerBps: 7_000, toSeller: 700_000n, toBuyer: 800_000n })
  assert.equal(events[1].kind, 'closed')
  if (events[1].kind === 'closed') {
    assert.equal(events[1].outcome, 'approved')
    assert.equal(events[1].balance, 1_500_000n)
    assert.equal(events[1].rentLamports, BigInt(rentHeld))
    assert.deepEqual(events[1].rentPayer, payer.publicKey)
  }
  assert.equal((await getAccount(connection, sellerTokens.publicKey)).amount, expected.toSeller)
  assert.equal((await getAccount(connection, buyerTokens.publicKey)).amount, 10_000_000n - 1_500_000n + expected.toBuyer)
  assert.equal(await connection.getAccountInfo(escrow), null, 'the escrow account is closed')
  assert.equal(await connection.getAccountInfo(vault), null, 'the deposit account is closed')
  // The rent payer paid three transaction fees (create, mark, approve) and the transfer's, and
  // got every lamport of rent back.
  const fees = 4 * 5_000 + 5_000 // four signatures on the first three, two on the transfer and approve
  const payerAfter = await connection.getBalance(payer.publicKey)
  assert.ok(payerBefore - payerAfter <= fees * 2, `only fees left the payer: ${payerBefore - payerAfter} lamports`)

  console.log(`  escrow ${escrow.toBase58()}: funded 1.5 by plain transfer, approved 70/30, ${rentHeld} lamports of rent returned`)
})

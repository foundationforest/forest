// The client against a real validator: start one, load the program, and run three deals end to
// end, every instruction built by the client.
//
// 1. A proposal settled by a split: the buyer opens the escrow from a post with no options, the
//    seller reads it off the chain and checks its options, money arrives by a plain token
//    transfer any wallet could make (a half over the amount, on purpose), anyone marks it funded,
//    and both sign a 70/30 split of the whole balance.
// 2. An invoice paid in one tap: the seller opens it at its own address, the buyer reads it,
//    checks its options, and pays and releases in one transaction.
// 3. A refund: the buyer opens one from a post with a timer to the seller, the deposit address
//    made first and the money sent in the same transaction, and marks it; the seller gives
//    everything back before the timer is due.
// Then the balances, the rent, the receipts and the events are checked. A payer fronts every
// rent; the buyer and the seller hold no SOL at all, and every rent refund reaches the creator
// anyway. Last, the invoice's old pay link is paid again: a stranger sends that money back to the
// buyer's standard account, and SOL sent to a receipt is swept back to its creator.
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
  createAndFund,
  decodeEscrow,
  decodeEvents,
  depositAddress,
  invoice,
  keysFor,
  keysOf,
  makeRefundAddressIx,
  makeStandardAccountIx,
  markFundedIx,
  createIx,
  optionsNotAgreed,
  payout,
  payoutAddress,
  recoverLateIx,
  refundAddress,
  releaseToBuyerIx,
  releaseToSellerIx,
  solanaPayUrl,
  splitIx,
  sweepRentIx,
  termsFor,
  timerDue,
  timerDueAt,
  type EscrowAccount,
  type PostTerms,
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

async function escrowAt(address: PublicKey): Promise<EscrowAccount> {
  return decodeEscrow(new Uint8Array((await connection.getAccountInfo(address))!.data))
}

async function tokens(address: PublicKey): Promise<bigint> {
  return (await getAccount(connection, address)).amount
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

test('three deals go through a real validator: a split, an invoice paid in one tap, and a refund', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  // The fee payer, which fronts every rent (a fee payer service in production). Buyer and seller
  // are two keys with no SOL.
  const payer = Keypair.generate()
  const buyer = Keypair.generate()
  const seller = Keypair.generate()
  await confirm(await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL))

  // A six-decimal classic SPL Token mint. The buyer holds 10.00 in an account that is not its
  // standard one; the seller holds nothing yet.
  const mint = Keypair.generate()
  const buyerTokens = Keypair.generate()
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
      createMintToInstruction(mint.publicKey, buyerTokens.publicKey, payer.publicKey, 10_000_000),
    ],
    [payer, mint, buyerTokens],
  )
  const refund = refundAddress(buyer.publicKey, mint.publicKey)
  const sellers = payoutAddress(seller.publicKey, mint.publicKey)
  const sol = (key: Keypair) => connection.getBalance(key.publicKey)
  assert.deepEqual([await sol(buyer), await sol(seller)], [0, 0])

  // ------------------------------------------------------------------------------------------
  // 1. A proposal settled by a split.

  // The seller's post carries no terms: every option off.
  const post: PostTerms | undefined = undefined
  const terms = termsFor(post, { seller: seller.publicKey, amount: 1_000_000n })
  const k = keysFor({ buyer: buyer.publicKey, mint: mint.publicKey, terms })
  const payerBefore = await connection.getBalance(payer.publicKey)
  const created = await send([createIx({ buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, terms })], [payer, buyer])
  const [createdEvent] = decodeEvents(await logsOf(created))
  assert.ok(createdEvent.kind === 'created' && createdEvent.escrow.equals(k.escrow) && createdEvent.creator === 'buyer')

  let e = await escrowAt(k.escrow)
  assert.deepEqual([e.status, e.creator, e.arbiter, e.timer], ['open', 'buyer', null, null])
  assert.deepEqual(e.vault, k.vault)
  assert.deepEqual(keysOf(e), k)
  const escrowRent = await connection.getBalance(k.escrow)
  const vaultRent = await connection.getBalance(k.vault)
  assert.ok(escrowRent > 0 && vaultRent > 0)

  // The seller reads the escrow off the chain before working: no option it did not set.
  assert.deepEqual(optionsNotAgreed({ escrow: e, me: 'seller', agreed: post ?? null }), [])

  // The pay link asks for the amount; the money arrives by a plain transfer to the deposit
  // address, the way any wallet would send it. Half a dollar too much, on purpose.
  const link = solanaPayUrl({ account: e, balance: 0n, decimals: 6 })
  assert.ok(link.startsWith(`solana:${k.escrow.toBase58()}?amount=1&`))
  await send([createTransferInstruction(buyerTokens.publicKey, k.vault, buyer.publicKey, 1_500_000)], [payer, buyer])
  assert.equal(await tokens(k.vault), 1_500_000n)
  assert.throws(() => solanaPayUrl({ account: e, balance: 1_500_000n, decimals: 6 }), /one-time/, 'no second link once the money is in')

  // Anyone marks it funded: only the fee payer signs.
  const marked = await send([markFundedIx({ escrow: k.escrow, vault: k.vault })], [payer])
  const [fundedEvent] = decodeEvents(await logsOf(marked))
  assert.ok(fundedEvent.kind === 'funded' && fundedEvent.balance === 1_500_000n)
  e = await escrowAt(k.escrow)
  assert.equal(e.status, 'funded')
  assert.ok(e.fundedAt !== null)

  // Both sign 70/30 of the whole balance. Each share goes to that side's standard account, which
  // neither has yet: both made first in the same transaction.
  const expected = payout(1_500_000n, 7_000)
  assert.equal(await connection.getAccountInfo(refund), null, 'no standard account yet')
  assert.equal(await connection.getAccountInfo(sellers), null, 'no standard account yet')
  const split = await send(
    [
      makeRefundAddressIx({ payer: payer.publicKey, buyer: buyer.publicKey, mint: mint.publicKey }),
      makeStandardAccountIx({ payer: payer.publicKey, owner: seller.publicKey, mint: mint.publicKey }),
      splitIx({ keys: k, sellerBps: 7_000 }),
    ],
    [payer, buyer, seller],
  )
  const [ended] = decodeEvents(await logsOf(split))
  assert.deepEqual(ended, {
    kind: 'ended',
    escrow: k.escrow,
    outcome: 'split',
    amount: 1_000_000n,
    balance: 1_500_000n,
    toSeller: 1_050_000n,
    toBuyer: 450_000n,
    endedAt: ended.kind === 'ended' ? ended.endedAt : 0n,
    rentRecipient: buyer.publicKey,
    rentLamports: BigInt(vaultRent),
  })
  assert.equal(await tokens(sellers), expected.toSeller, "the seller's share, at its standard account")
  assert.equal(await tokens(buyerTokens.publicKey), 10_000_000n - 1_500_000n, 'nothing back here')
  assert.equal(await tokens(refund), expected.toBuyer, "the buyer's share, at its standard account")
  const refundRent = await connection.getBalance(refund)
  const sellersRent = await connection.getBalance(sellers)
  assert.equal(await connection.getAccountInfo(k.vault), null, 'the deposit account is closed')
  assert.equal(await sol(buyer), vaultRent, "the deposit account's rent went to the buyer, who opened it, not to the payer")
  // The escrow account stays: the receipt, with how it ended and who got what.
  const receipt = await escrowAt(k.escrow)
  assert.deepEqual([receipt.status, receipt.outcome, receipt.toSeller, receipt.toBuyer], ['ended', 'split', 1_050_000n, 450_000n])
  assert.equal(await connection.getBalance(k.escrow), escrowRent, 'the receipt keeps its rent')
  // The payer fronted the fees, both rents and both new standard accounts, and got nothing back:
  // in production it charges the person for each, once.
  const fees = 4 * 3 * 5_000 // generously: four transactions of at most three signatures
  const spent = payerBefore - (await connection.getBalance(payer.publicKey)) - escrowRent - vaultRent - refundRent - sellersRent
  assert.ok(spent > 0 && spent <= fees, `only fees, both rents and the two standard accounts left the payer: ${spent} lamports besides`)

  // ------------------------------------------------------------------------------------------
  // 2. An invoice paid in one tap.

  const invoiceTerms = termsFor(undefined, { seller: seller.publicKey, amount: 2_000_000n })
  const inv = invoice({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, decimals: 6, terms: invoiceTerms })
  const invoiced = await send([inv.instruction], [payer, seller])
  assert.deepEqual(decodeEvents(await logsOf(invoiced)).map((ev) => ev.kind), ['created'])
  const onChain = await escrowAt(inv.escrow)
  assert.equal(onChain.creator, 'seller')
  assert.deepEqual([onChain.rentRecipient, keysOf(onChain).escrow], [seller.publicKey, inv.escrow], "the seller's address, its rent back to the seller")
  assert.ok(onChain.buyer.equals(buyer.publicKey), 'the buyer checks the invoice names it: every refund goes there')
  assert.deepEqual(optionsNotAgreed({ escrow: onChain, me: 'buyer', agreed: null }), [], 'the buyer checks before paying')
  const invoiceVaultRent = await connection.getBalance(inv.deposit)
  const sellerSol = await sol(seller)
  const paid = await send(
    [
      createTransferInstruction(buyerTokens.publicKey, inv.deposit, buyer.publicKey, 2_000_000),
      releaseToSellerIx({ keys: keysOf(onChain) }),
    ],
    [payer, buyer],
  )
  const paidEvents = decodeEvents(await logsOf(paid))
  assert.ok(paidEvents.length === 1 && paidEvents[0].kind === 'ended' && paidEvents[0].outcome === 'releasedToSeller')
  assert.equal(await tokens(sellers), expected.toSeller + 2_000_000n)
  assert.equal(await sol(seller), sellerSol + invoiceVaultRent, "the invoice's deposit rent went to the seller, who opened it")
  const invoiceReceipt = await escrowAt(inv.escrow)
  assert.deepEqual([invoiceReceipt.creator, invoiceReceipt.outcome, invoiceReceipt.fundedAt], ['seller', 'releasedToSeller', null])

  // ------------------------------------------------------------------------------------------
  // 3. A refund before a timer is due.

  const timedPost: PostTerms = { timer: { days: 3, to: 'seller' } }
  const timedTerms = termsFor(timedPost, { seller: seller.publicKey, amount: 500_000n })
  const tk = keysFor({ buyer: buyer.publicKey, mint: mint.publicKey, terms: timedTerms })
  await send(
    [
      ...createAndFund({ buyer: buyer.publicKey, payer: payer.publicKey, mint: mint.publicKey, terms: timedTerms, from: buyerTokens.publicKey }),
      markFundedIx({ escrow: tk.escrow, vault: tk.vault }),
    ],
    [payer, buyer],
  )
  const timed = await escrowAt(tk.escrow)
  assert.deepEqual(timed.timer, { days: 3, to: 'seller' })
  assert.deepEqual(optionsNotAgreed({ escrow: timed, me: 'seller', agreed: timedPost }), [], 'the seller set that timer')
  assert.deepEqual(optionsNotAgreed({ escrow: timed, me: 'buyer', agreed: null }).map((d) => [d.option, d.kind]), [['timer', 'added']])
  assert.equal(timerDueAt(timed), timed.fundedAt! + 3n * 86_400n)
  assert.equal(timerDue(timed), false)
  const refundBefore = await tokens(refund)
  const buyerSol = await sol(buyer)
  const timedVaultRent = await connection.getBalance(tk.vault)
  const given = await send([releaseToBuyerIx({ keys: tk })], [payer, seller])
  const [refunded] = decodeEvents(await logsOf(given))
  assert.ok(refunded.kind === 'ended' && refunded.outcome === 'releasedToBuyer' && refunded.toBuyer === 500_000n)
  assert.equal(await tokens(refund), refundBefore + 500_000n)
  assert.equal(await sol(buyer), buyerSol + timedVaultRent, "the deposit account's rent back to the buyer")

  // ------------------------------------------------------------------------------------------
  // Money after the end, and SOL at a receipt.

  // The invoice's link is paid again, after the end: the deposit account is made again (here the
  // app pays for it) and the buyer sends. A stranger sends it back to the buyer's standard
  // account; the deposit account's rent goes to the buyer.
  await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, inv.deposit, inv.escrow, mint.publicKey),
      createTransferInstruction(buyerTokens.publicKey, inv.deposit, buyer.publicKey, 300_000),
    ],
    [payer, buyer],
  )
  const stranger = Keypair.generate()
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], [payer])
  const receiptBytes = (await connection.getAccountInfo(inv.escrow))!.data
  const recovered = await send([recoverLateIx({ account: invoiceReceipt, caller: stranger.publicKey })], [payer, stranger])
  const [late] = decodeEvents(await logsOf(recovered))
  assert.ok(late.kind === 'recoveredLate' && late.toBuyer === 300_000n)
  assert.equal(await tokens(refund), refundBefore + 500_000n + 300_000n, "at the buyer's standard account")
  assert.equal(await connection.getAccountInfo(depositAddress(inv.escrow, mint.publicKey)), null, 'the deposit account is closed again')
  assert.deepEqual((await connection.getAccountInfo(inv.escrow))!.data, receiptBytes, 'the receipt does not change')

  // SOL sent to the receipt goes back to its creator, the seller, and the receipt keeps exactly its
  // minimum. Named to the payer, which fronted the rent, the sweep is refused.
  const minimum = await connection.getBalance(inv.escrow)
  await send([SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: inv.escrow, lamports: 1_000_000 })], [payer, stranger])
  await assert.rejects(send([sweepRentIx({ escrow: inv.escrow, rentRecipient: payer.publicKey })], [payer]), /ConstraintHasOne|0x7d1/)
  const sellerBeforeSweep = await sol(seller)
  const swept = await send([sweepRentIx({ escrow: inv.escrow, rentRecipient: seller.publicKey })], [payer])
  const [sweep] = decodeEvents(await logsOf(swept))
  assert.deepEqual(sweep, { kind: 'rentSwept', escrow: inv.escrow, lamports: 1_000_000n, left: BigInt(minimum) })
  assert.equal(await connection.getBalance(inv.escrow), minimum)
  assert.equal(await sol(seller), sellerBeforeSweep + 1_000_000, 'the creator; the payer paid only the fee')

  console.log(`  escrow ${k.escrow.toBase58()}: funded 1.5 by plain transfer, split 70/30 of the whole balance, ${vaultRent} lamports of rent returned to the buyer, ${escrowRent} kept in the receipt`)
  console.log(`  invoice ${inv.escrow.toBase58()}: at the seller's address, paid and released in one tap; paid again later and sent back to the buyer by a stranger; a SOL tip swept to the seller`)
  console.log(`  escrow ${tk.escrow.toBase58()}: a timer to the seller, given back by the seller before it was due`)
})

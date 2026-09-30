// The escrow, v2, on devnet, used for real: two deals between the devnet parties, in the test
// dollar the registry script made, through escrow/v2/devnet/deploy.sh's deploy.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts        (after escrow/v2/devnet/deploy.sh)
//
// 1. The seller invoices; the buyer reads it, checks its options, and pays with one tap (the
//    deposit address made first, a plain transfer and the release, in one transaction). Nobody
//    marks it: the receipt records the funding time anyway, the ending's.
// 2. The buyer opens an escrow with a one-day timer to the seller and funds it in the same
//    transaction; anyone marks it; the buyer objects before the timer is due, so the timer is off;
//    both sign a 60/40 split. The receipt keeps the objection.
//
// A payer key pays every network fee and fronts every rent, the way a fee payer would, and is
// recorded as the escrow's payer. <dir> holds payer.json, buyer.json and seller.json, read and never
// printed; the mint and the keys are the ones devnet/devnet.json names, which this only reads.
// Everything public goes into escrow/v2/devnet/devnet.json. Each step checks the chain first, so
// the script can be run again after a failure. FOREST_DEVNET_RPC points it at another devnet RPC.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'

import {
  assertOptionsAgreed,
  canObject,
  createAndFund,
  decodeEscrow,
  decodeEvents,
  escrowAddress,
  invoiceIx,
  keysFor,
  markFundedIx,
  objectIx,
  payInvoiceInOneTap,
  randomId,
  splitIx,
  termsFor,
  timerReleaseIx,
  vaultAddress,
  type EscrowAccount,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))

const keysDir = process.env.FOREST_DEVNET_KEYS
if (!keysDir) throw new Error('set FOREST_DEVNET_KEYS to the directory holding the devnet keypairs')
const recordPath = resolve(join(here, '../../devnet/devnet.json'))
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
const base = JSON.parse(readFileSync(resolve(join(here, '../../../../devnet/devnet.json')), 'utf8'))
const connection = new Connection(process.env.FOREST_DEVNET_RPC ?? record.rpc, 'confirmed')
const programId = new PublicKey(record.escrow.programId)
if (programId.toBase58() === base.escrow.programId) throw new Error('that is v1\'s program id')
const mint = new PublicKey(base.testDollar.mint)

function key(name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir!, `${name}.json`), 'utf8'))))
}
const payer = key('payer')
const buyer = key('buyer')
const seller = key('seller')
for (const [name, k] of [['payer', payer], ['buyer', buyer], ['seller', seller]] as const) {
  if (k.publicKey.toBase58() !== base.keys[name]) throw new Error(`the ${name} key is not the one devnet/devnet.json names`)
}
const sellerTokens = getAssociatedTokenAddressSync(mint, seller.publicKey)

function save(): void {
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}

function note(deal: Record<string, unknown>, what: string, signature: string): void {
  record.transactions ??= []
  record.transactions.push({ program: 'escrow-v2', what, signature })
  ;(deal.signatures as Record<string, string>)[what.split(':')[0]] = signature
  save()
  console.log(`  ${signature}  ${what}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  for (let i = 0; i < 240; i++) {
    let value
    try {
      ;({ value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
    } catch (e) {
      if (!String(e).includes('429')) throw e
      await sleep(5_000)
      continue
    }
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature
    await sleep(500)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function kinds(signature: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const tx = await connection
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .catch((e) => (String(e).includes('429') ? null : Promise.reject(e)))
    if (tx?.meta?.logMessages) return decodeEvents(tx.meta.logMessages, programId).map((e) => e.kind).join()
    await sleep(3_000)
  }
  throw new Error(`no log for ${signature}`)
}

async function escrowAt(address: PublicKey): Promise<EscrowAccount | null> {
  const info = await connection.getAccountInfo(address)
  if (info && !info.owner.equals(programId)) throw new Error(`${address.toBase58()} is not owned by the v2 program`)
  return info ? decodeEscrow(new Uint8Array(info.data)) : null
}

async function tokens(address: PublicKey): Promise<bigint> {
  return (await getAccount(connection, address)).amount
}

function receipt(e: EscrowAccount) {
  return {
    status: e.status,
    outcome: e.outcome,
    amount: e.amount.toString(),
    toSeller: e.toSeller.toString(),
    toBuyer: e.toBuyer.toString(),
    creator: e.creator,
    createdAt: e.createdAt.toString(),
    fundedAt: e.fundedAt?.toString() ?? null,
    endedAt: e.endedAt?.toString() ?? null,
    objection: e.objection,
    objectedAt: e.objectedAt?.toString() ?? null,
    rentRecipient: e.rentRecipient.toBase58(),
    payer: e.payer.toBase58(),
  }
}

function deal(name: string, what: string): Record<string, any> {
  record.deals ??= {}
  record.deals[name] ??= { what, id: randomId().toString(), signatures: {} }
  save()
  return record.deals[name]
}

console.log(`escrow v2 ${programId.toBase58()}`)

// ---------------------------------------------------------------------------------------------
// 1. An invoice, paid with one tap; nobody marks it.

{
  const d = deal('invoice', 'the seller invoices 1.00; the buyer checks it, then, in one transaction, the deposit address made first, pays and releases; nobody marks it')
  const terms = termsFor(undefined, { seller: seller.publicKey, amount: 1_000_000n, id: BigInt(d.id) })
  const escrow = escrowAddress(seller.publicKey, terms.id, programId)
  d.escrow = escrow.toBase58()
  save()
  if (!(await escrowAt(escrow))) {
    const sig = await send([invoiceIx({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint, terms, programId })], [payer, seller])
    if ((await kinds(sig)) !== 'created') throw new Error('the invoice logged something else')
    note(d, 'invoice: the seller opens an escrow naming the buyer, 1.00 test dollar, no options, the payer fronting the rent', sig)
  }
  let e = (await escrowAt(escrow))!
  if (e.status !== 'ended') {
    assertOptionsAgreed({ escrow: e, me: 'buyer', agreed: null })
    if (!e.buyer.equals(buyer.publicKey)) throw new Error('the invoice names another buyer')
    const sig = await send(payInvoiceInOneTap({ escrow: e, payer: payer.publicKey, programId }), [payer, buyer])
    if ((await kinds(sig)) !== 'ended') throw new Error('the one tap logged something else')
    note(d, 'one tap: the deposit address made first, then the buyer pays 1.00 into it and releases it to the seller, in one transaction', sig)
    e = (await escrowAt(escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'releasedToSeller' || e.creator !== 'seller') throw new Error('not ended, released to the seller, created by the seller')
  if (e.fundedAt === null || e.fundedAt !== e.endedAt) throw new Error('nobody marked it, so the funding time must be the ending\'s')
  if (!e.payer.equals(payer.publicKey)) throw new Error('the payer is not recorded')
  d.receipt = receipt(e)
  save()
  console.log(`  receipt ${escrow.toBase58()}: ${e.outcome}, funded at ${e.fundedAt}, ended at ${e.endedAt}`)
}

// ---------------------------------------------------------------------------------------------
// 2. A timer, an objection, and a split.

{
  const d = deal('objection', 'the buyer opens 2.00 with a one-day timer to the seller and funds it at once; anyone marks it; the buyer objects before the timer is due; both sign a 60/40 split')
  const terms = termsFor({ timer: { days: 1, to: 'seller' } }, { seller: seller.publicKey, amount: 2_000_000n, id: BigInt(d.id) })
  const k = keysFor({ buyer: buyer.publicKey, mint, terms, programId })
  d.escrow = k.escrow.toBase58()
  save()
  if (!(await escrowAt(k.escrow))) {
    const sig = await send(createAndFund({ buyer: buyer.publicKey, payer: payer.publicKey, mint, terms, programId }), [payer, buyer])
    if ((await kinds(sig)) !== 'created') throw new Error('create and fund logged something else')
    note(d, 'create and fund: the deposit address made first, the buyer opens 2.00 with a one-day timer to the seller and pays it in, in one transaction', sig)
  }
  let e = (await escrowAt(k.escrow))!
  if (e.status === 'open') {
    const sig = await send([markFundedIx({ escrow: k.escrow, vault: vaultAddress(k.escrow, mint), programId })], [payer])
    if ((await kinds(sig)) !== 'funded') throw new Error('the mark logged something else')
    note(d, 'mark_funded: the payer marks the funding; the timer is due a day later', sig)
    e = (await escrowAt(k.escrow))!
  }
  if (e.status === 'funded' && !e.objection) {
    if (!canObject(e)) throw new Error('the timer is already due: too late to object')
    const sig = await send([objectIx({ account: e, party: buyer.publicKey, programId })], [payer, buyer])
    if ((await kinds(sig)) !== 'objected') throw new Error('the objection logged something else')
    note(d, 'object: the buyer objects before the timer is due; the timer is off', sig)
    e = (await escrowAt(k.escrow))!
  }
  if (e.status === 'funded') {
    let refused = ''
    try {
      timerReleaseIx({ account: e, programId })
    } catch (err) {
      refused = String(err)
    }
    if (!refused.includes('Objected')) throw new Error('the timer is not refused after the objection')
    const sellerBefore = await tokens(sellerTokens)
    const sig = await send([splitIx({ keys: k, sellerBps: 6_000, programId })], [payer, buyer, seller])
    if ((await kinds(sig)) !== 'ended') throw new Error('the split logged something else')
    if ((await tokens(sellerTokens)) !== sellerBefore + 1_200_000n) throw new Error('the seller was not paid 60%')
    note(d, 'split: buyer and seller both sign 60/40; 1.20 to the seller, 0.80 back to the buyer', sig)
    e = (await escrowAt(k.escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'split' || e.objection !== 'buyer' || e.toSeller !== 1_200_000n || e.toBuyer !== 800_000n) {
    throw new Error('not ended, split 1.20 and 0.80, objected by the buyer')
  }
  d.receipt = receipt(e)
  save()
  console.log(`  receipt ${k.escrow.toBase58()}: ${e.outcome}, objected by the ${e.objection} at ${e.objectedAt}, funded at ${e.fundedAt}`)
}

console.log('done')

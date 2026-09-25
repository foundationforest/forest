// The escrow on devnet, used for real: two deals between two throwaway parties, in the test
// dollar the registry script made.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts        (after registry/client/scripts/devnet.ts)
//
// 1. The seller invoices; the buyer reads it, checks its options, and pays with one tap
//    (`payInvoiceInOneTap`: the deposit address made first, so a fee payer that checks every
//    transfer's destination could sign it, then a plain transfer to it and the release, in one
//    transaction); the receipt stays.
// 2. The buyer proposes, with every option off; pays by a plain transfer; anyone marks it funded;
//    both sign a 60/40 split of the whole balance; the receipt stays.
//
// A payer key pays every network fee and fronts every rent, the way a fee payer would, so the
// parties hold only test dollars; every rent refund goes to the party who opened the escrow. <dir> holds the devnet keypairs (payer, buyer, seller), read and never printed.
// Everything public goes into devnet/devnet.json (FOREST_DEVNET_RECORD, FOREST_DEVNET_RPC as in the
// registry script). Each step checks the chain first, so the script can be run again after a failure.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTransferInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'

import {
  assertOptionsAgreed,
  createIx,
  decodeEscrow,
  decodeEvents,
  invoice,
  keysFor,
  markFundedIx,
  payInvoiceInOneTap,
  randomId,
  splitIx,
  termsFor,
  type EscrowAccount,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))

const keysDir = process.env.FOREST_DEVNET_KEYS
if (!keysDir) throw new Error('set FOREST_DEVNET_KEYS to the directory holding the devnet keypairs')
const recordPath = resolve(process.env.FOREST_DEVNET_RECORD ?? join(here, '../../../devnet/devnet.json'))
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
const rpc = process.env.FOREST_DEVNET_RPC ?? record.rpc
const connection = new Connection(rpc, 'confirmed')
const programId = new PublicKey(record.escrow.programId)
const mint = new PublicKey(record.testDollar.mint)

function key(name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir!, `${name}.json`), 'utf8'))))
}
const payer = key('payer')
const buyer = key('buyer')
const seller = key('seller')
for (const [name, k] of [['payer', payer], ['buyer', buyer], ['seller', seller]] as const) {
  if (k.publicKey.toBase58() !== record.keys[name]) throw new Error(`the ${name} key is not the one the record names`)
}
const buyerTokens = getAssociatedTokenAddressSync(mint, buyer.publicKey)
const sellerTokens = getAssociatedTokenAddressSync(mint, seller.publicKey)

function save(): void {
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}

function note(deal: Record<string, unknown>, what: string, signature: string): void {
  record.transactions.push({ program: 'escrow', what, signature })
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
    // A rate limit while polling is waited out, not thrown: the transaction is already sent, and
    // throwing would lose its signature from the record.
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

async function events(signature: string) {
  for (let i = 0; i < 20; i++) {
    const tx = await connection
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .catch((e) => (String(e).includes('429') ? null : Promise.reject(e)))
    if (tx?.meta?.logMessages) return decodeEvents(tx.meta.logMessages, programId)
    await sleep(3_000)
  }
  throw new Error(`no log for ${signature}`)
}

async function escrowAt(address: PublicKey): Promise<EscrowAccount | null> {
  const info = await connection.getAccountInfo(address)
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
    createdAt: e.createdAt.toString(),
    fundedAt: e.fundedAt?.toString() ?? null,
    creator: e.creator,
    endedAt: e.endedAt?.toString() ?? null,
    rentRecipient: e.rentRecipient.toBase58(),
  }
}

/** The one deal record, made the first time with a fresh id so a rerun resumes the same escrow. */
function deal(name: string, what: string): Record<string, any> {
  record.deals ??= {}
  record.deals[name] ??= { what, id: randomId().toString(), signatures: {} }
  save()
  return record.deals[name]
}

// The seller's post carries no terms: every option off.
const post = undefined

console.log(`escrow ${programId.toBase58()} on ${rpc}`)
record.escrow.testDollar = mint.toBase58()
record.transactions ??= []
save()

// ---------------------------------------------------------------------------------------------
// 1. An invoice, paid with one tap.

{
  const d = deal('invoice', 'the seller invoices 2.00; the buyer checks it, then, in one transaction, the deposit address made first, pays and releases')
  const terms = termsFor(post, { seller: seller.publicKey, amount: 2_000_000n, id: BigInt(d.id) })
  const inv = invoice({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint, decimals: 6, terms, label: 'Forest devnet', programId })
  d.escrow = inv.escrow.toBase58()
  d.deposit = inv.deposit.toBase58()
  d.payLink = inv.url
  save()

  if (!(await escrowAt(inv.escrow))) {
    const sig = await send([inv.instruction], [payer, seller])
    const kinds = (await events(sig)).map((e) => e.kind)
    if (kinds.join() !== 'created') throw new Error(`the invoice logged ${kinds}`)
    note(d, 'invoice: the seller opens an escrow naming the buyer, 2.00 test dollars, no options', sig)
  }
  let e = (await escrowAt(inv.escrow))!
  if (e.status !== 'ended') {
    // The buyer's app reads the invoice off the chain and checks it before paying: its options,
    // that it names the buyer's own key (every refund goes there), and that nothing has been paid
    // into it yet (the one tap sends the whole amount).
    assertOptionsAgreed({ escrow: e, me: 'buyer', agreed: post ?? null })
    if (!e.buyer.equals(buyer.publicKey)) throw new Error('the invoice names another buyer')
    if ((await tokens(inv.deposit)) !== 0n) throw new Error('something was already paid into the invoice')
    const sellerBefore = await tokens(sellerTokens)
    const sig = await send(payInvoiceInOneTap({ escrow: e, payer: payer.publicKey, programId }), [payer, buyer])
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'ended') throw new Error(`the one tap logged ${kinds}`)
    if ((await tokens(sellerTokens)) !== sellerBefore + e.amount) throw new Error('the seller was not paid the amount')
    note(d, 'one tap: the deposit address made first, then the buyer pays 2.00 into it and releases it to the seller, in one transaction', sig)
    e = (await escrowAt(inv.escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'releasedToSeller' || e.creator !== 'seller') throw new Error('the invoice receipt is not ended, released to the seller, created by the seller')
  d.receipt = receipt(e)
  d.depositClosed = (await connection.getAccountInfo(inv.deposit)) === null
  save()
  console.log(`  receipt ${inv.escrow.toBase58()}: ${e.outcome}, ${e.toSeller} to the seller`)
}

// ---------------------------------------------------------------------------------------------
// 2. A proposal, funded, marked, and split by both.

{
  const d = deal('split', 'the buyer proposes 3.00 and pays; anyone marks it funded; both sign a 60/40 split')
  const terms = termsFor(post, { seller: seller.publicKey, amount: 3_000_000n, id: BigInt(d.id) })
  const k = keysFor({ buyer: buyer.publicKey, mint, terms, programId })
  d.escrow = k.escrow.toBase58()
  d.deposit = k.vault.toBase58()
  save()

  if (!(await escrowAt(k.escrow))) {
    const sig = await send([createIx({ buyer: buyer.publicKey, payer: payer.publicKey, mint, terms, programId })], [payer, buyer])
    note(d, 'create: the buyer proposes an escrow of 3.00 test dollars to the seller, no options', sig)
  }
  let e = (await escrowAt(k.escrow))!
  if (e.status === 'open' && (await tokens(k.vault)) < e.amount) {
    // The seller reads the escrow off the chain and checks its options before working.
    assertOptionsAgreed({ escrow: e, me: 'seller', agreed: post ?? null })
    const sig = await send([createTransferInstruction(buyerTokens, k.vault, buyer.publicKey, e.amount)], [payer, buyer])
    note(d, "fund: the buyer sends 3.00 to the escrow's deposit address by a plain transfer", sig)
  }
  if (e.status === 'open') {
    const sig = await send([markFundedIx({ escrow: k.escrow, vault: k.vault, programId })], [payer])
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'funded') throw new Error(`the mark logged ${kinds}`)
    note(d, 'mark_funded: the payer marks the funding; nobody else signs', sig)
    e = (await escrowAt(k.escrow))!
  }
  if (e.status === 'funded') {
    const sellerBefore = await tokens(sellerTokens)
    const sig = await send([splitIx({ keys: k, sellerBps: 6_000, programId })], [payer, buyer, seller])
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'ended') throw new Error(`the split logged ${kinds}`)
    if ((await tokens(sellerTokens)) !== sellerBefore + 1_800_000n) throw new Error('the seller was not paid 60%')
    note(d, 'split: buyer and seller both sign 60/40; 1.80 to the seller, 1.20 back to the buyer', sig)
    e = (await escrowAt(k.escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'split' || e.toSeller !== 1_800_000n || e.toBuyer !== 1_200_000n) {
    throw new Error('the second receipt is not ended, split, 1.80 and 1.20')
  }
  d.receipt = receipt(e)
  d.depositClosed = (await connection.getAccountInfo(k.vault)) === null
  save()
  console.log(`  receipt ${k.escrow.toBase58()}: ${e.outcome}, ${e.toSeller} to the seller, ${e.toBuyer} to the buyer`)
}

console.log('done')

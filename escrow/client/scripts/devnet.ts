// The escrow on devnet, used for real (session 15): two deals between two throwaway parties, in the
// test dollar the registry script made.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts        (after registry/client/scripts/devnet.ts)
//
// 1. The seller invoices; the buyer pays with one tap (a plain transfer to the deposit address and
//    the approval, in one transaction); the receipt stays on chain.
// 2. The buyer proposes; pays by a plain transfer; the seller accepts; the buyer objects; both sign
//    a 60/40 split; the receipt stays on chain.
//
// A payer key pays every network fee and every rent, the way a fee payer would, so the parties hold
// only test dollars. <dir> holds the devnet keypairs (payer, buyer, seller), read and never printed.
// Everything public goes into devnet/devnet.json (FOREST_DEVNET_RECORD, FOREST_DEVNET_RPC as in the
// registry script). Each step checks the chain first, so the script can be run again after a failure.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTransferInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'

import {
  acceptIx,
  agreeIx,
  approveIx,
  checkTerms,
  createIx,
  decodeEscrow,
  decodeEvents,
  depositAddress,
  escrowAddress,
  invoice,
  objectIx,
  randomId,
  termsFor,
  type EscrowAccount,
  type OfferTerms,
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
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature
    await sleep(500)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function events(signature: string) {
  for (let i = 0; i < 20; i++) {
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    if (tx?.meta?.logMessages) return decodeEvents(tx.meta.logMessages, programId)
    await sleep(500)
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
    acceptedAt: e.acceptedAt?.toString() ?? null,
    endedAt: e.endedAt?.toString() ?? null,
    rentPayer: e.rentPayer.toBase58(),
  }
}

/** The one deal record, made the first time with a fresh id so a rerun resumes the same escrow. */
function deal(name: string, what: string): Record<string, any> {
  record.deals ??= {}
  record.deals[name] ??= { what, id: randomId().toString(), signatures: {} }
  save()
  return record.deals[name]
}

// The seller's offer, as a post would carry it: silence (auto-release) after 7 days, no
// cancellation steps, no arbiter. No service time: the clock starts at funding and acceptance.
const offer: OfferTerms = { autoReleaseDays: 7 }

console.log(`escrow ${programId.toBase58()} on ${rpc}`)
record.escrow.testDollar = mint.toBase58()
record.transactions ??= []
save()

// ---------------------------------------------------------------------------------------------
// 1. An invoice, paid with one tap.

{
  const d = deal('invoice', 'the seller invoices 2.00; the buyer pays and approves in one transaction')
  const terms = termsFor(offer, { seller: seller.publicKey, amount: 2_000_000n, mint, id: BigInt(d.id) })
  const inv = invoice({ seller: seller.publicKey, buyer: buyer.publicKey, payer: payer.publicKey, mint, decimals: 6, terms, label: 'Forest devnet', programId })
  d.escrow = inv.escrow.toBase58()
  d.deposit = inv.deposit.toBase58()
  d.payLink = inv.url
  save()

  if (!(await escrowAt(inv.escrow))) {
    const sig = await send([inv.instruction], [payer, seller])
    const kinds = (await events(sig)).map((e) => e.kind)
    if (kinds.join() !== 'created,accepted') throw new Error(`the invoice logged ${kinds}`)
    note(d, 'invoice: the seller opens an escrow naming the buyer, 2.00 test dollars, accepted from creation', sig)
  }
  let e = (await escrowAt(inv.escrow))!
  if (e.status !== 'ended') {
    // The buyer's app reads the invoice off the chain and checks its terms before paying.
    checkTerms(e, { arbiter: null })
    const sellerBefore = await tokens(sellerTokens)
    const accounts = { escrow: inv.escrow, vault: inv.deposit, buyer: buyer.publicKey, mint, sellerTokens, rentPayer: payer.publicKey }
    const sig = await send(
      [createTransferInstruction(buyerTokens, inv.deposit, buyer.publicKey, e.amount), approveIx({ accounts, buyer: buyer.publicKey, programId })],
      [payer, buyer],
    )
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'approved,ended') throw new Error(`the one tap logged ${kinds}`)
    if ((await tokens(sellerTokens)) !== sellerBefore + e.amount) throw new Error('the seller was not paid the amount')
    note(d, 'one tap: the buyer pays 2.00 to the deposit address and approves, in one transaction; the seller is paid', sig)
    e = (await escrowAt(inv.escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'approved' || e.acceptedAt === null) throw new Error('the invoice receipt is not ended, approved and accepted')
  d.receipt = receipt(e)
  d.depositClosed = (await connection.getAccountInfo(inv.deposit)) === null
  save()
  console.log(`  receipt ${inv.escrow.toBase58()}: ${e.outcome}, ${e.toSeller} to the seller`)
}

// ---------------------------------------------------------------------------------------------
// 2. A proposal, funded, accepted, objected to, and settled by agreement.

{
  const d = deal('agreed', 'the buyer proposes 3.00 and pays; the seller accepts; the buyer objects; both agree to 60/40')
  const terms = termsFor(offer, { seller: seller.publicKey, amount: 3_000_000n, mint, id: BigInt(d.id) })
  const escrow = escrowAddress(buyer.publicKey, terms.id, programId)
  const vault = depositAddress(escrow, mint)
  d.escrow = escrow.toBase58()
  d.deposit = vault.toBase58()
  save()

  if (!(await escrowAt(escrow))) {
    const sig = await send([createIx({ buyer: buyer.publicKey, payer: payer.publicKey, mint, terms, programId })], [payer, buyer])
    note(d, 'create: the buyer proposes an escrow of 3.00 test dollars to the seller', sig)
  }
  let e = (await escrowAt(escrow))!
  if (e.status === 'open' && (await connection.getAccountInfo(vault)) && (await tokens(vault)) < e.amount) {
    const sig = await send([createTransferInstruction(buyerTokens, vault, buyer.publicKey, e.amount)], [payer, buyer])
    note(d, "fund: the buyer sends 3.00 to the escrow's deposit address by a plain transfer", sig)
  }
  if (e.status === 'open') {
    checkTerms(e, { arbiter: null })
    const sig = await send([acceptIx({ account: e, seller: seller.publicKey, arbiter: null, programId })], [payer, seller])
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'accepted,funded') throw new Error(`the acceptance logged ${kinds}`)
    note(d, 'accept: the seller reads the escrow, checks its terms and accepts; the funding is observed', sig)
    e = (await escrowAt(escrow))!
  }
  if (e.status === 'funded') {
    const sig = await send([objectIx({ escrow, vault, buyer: buyer.publicKey, programId })], [payer, buyer])
    note(d, 'object: the buyer objects before silence runs out; the escrow locks', sig)
    e = (await escrowAt(escrow))!
  }
  if (e.status === 'locked') {
    const sellerBefore = await tokens(sellerTokens)
    const accounts = { escrow, vault, buyer: buyer.publicKey, mint, sellerTokens, rentPayer: payer.publicKey }
    const sig = await send([agreeIx({ accounts, buyer: buyer.publicKey, seller: seller.publicKey, sellerBps: 6_000, programId })], [payer, buyer, seller])
    const kinds = (await events(sig)).map((ev) => ev.kind)
    if (kinds.join() !== 'agreed,ended') throw new Error(`the agreement logged ${kinds}`)
    if ((await tokens(sellerTokens)) !== sellerBefore + 1_800_000n) throw new Error('the seller was not paid 60%')
    note(d, 'agree: buyer and seller both sign a 60/40 split; 1.80 to the seller, 1.20 back to the buyer', sig)
    e = (await escrowAt(escrow))!
  }
  if (e.status !== 'ended' || e.outcome !== 'agreed' || e.toSeller !== 1_800_000n || e.toBuyer !== 1_200_000n) {
    throw new Error('the second receipt is not ended, agreed, 1.80 and 1.20')
  }
  d.receipt = receipt(e)
  d.depositClosed = (await connection.getAccountInfo(vault)) === null
  save()
  console.log(`  receipt ${escrow.toBase58()}: ${e.outcome}, ${e.toSeller} to the seller, ${e.toBuyer} to the buyer`)
}

console.log('done')

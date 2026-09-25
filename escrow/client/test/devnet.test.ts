// Smoke tests against the escrow's devnet deploy, as `devnet/devnet.json` records it.
//
//   npm run test:devnet          (FOREST_DEVNET=1; skipped otherwise, so `npm test` never needs a network)
//
// Read-only: they hold no key and send nothing, so they keep working after the machine that made
// the deploy is gone, for as long as devnet keeps the accounts and the transaction history.
// FOREST_DEVNET_RPC and FOREST_DEVNET_RECORD point them elsewhere (a local rehearsal, another RPC).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Connection, PublicKey } from '@solana/web3.js'

import { decodeEscrow, decodeEvents, depositAddress, escrowAddress } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const enabled = process.env.FOREST_DEVNET === '1'
const skip = enabled ? false : 'set FOREST_DEVNET=1 to run against devnet'
const record = JSON.parse(readFileSync(resolve(process.env.FOREST_DEVNET_RECORD ?? join(here, '../../../devnet/devnet.json')), 'utf8'))
const connection = new Connection(process.env.FOREST_DEVNET_RPC ?? record.rpc, 'confirmed')
const programId = new PublicKey(record.escrow.programId)
const mint = new PublicKey(record.testDollar.mint)
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'

async function account(address: PublicKey | string) {
  const info = await connection.getAccountInfo(new PublicKey(address))
  assert.ok(info, `no account at ${address}`)
  return info
}

async function kinds(signature: string): Promise<string[]> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  assert.ok(tx?.meta, `no transaction ${signature}`)
  assert.equal(tx.meta.err, null, signature)
  return decodeEvents(tx.meta.logMessages!, programId).map((e) => e.kind)
}

test('the escrow is deployed at its recorded id, its upgrade key still the deploy key', { skip }, async () => {
  const program = await account(programId)
  assert.equal(program.executable, true)
  assert.equal(program.owner.toBase58(), UPGRADEABLE_LOADER)
  const programData = new PublicKey(program.data.subarray(4, 36))
  assert.equal(programData.toBase58(), record.escrow.programData)
  const data = (await account(programData)).data
  assert.equal(data[12], 1, 'an upgrade authority is set: devnet is not sealed (mainnet is, at deploy)')
  assert.equal(new PublicKey(data.subarray(13, 45)).toBase58(), record.keys.deploy)
})

test('the invoice paid with one tap left its receipt: ended, released to the seller, created by the seller', { skip }, async () => {
  const d = record.deals.invoice
  const escrow = escrowAddress(new PublicKey(record.keys.buyer), BigInt(d.id), programId)
  assert.equal(escrow.toBase58(), d.escrow)
  const e = decodeEscrow(new Uint8Array((await account(escrow)).data))
  assert.equal(e.seller.toBase58(), record.keys.seller)
  assert.equal(e.mint.toBase58(), mint.toBase58())
  assert.deepEqual([e.status, e.outcome, e.amount, e.toSeller, e.toBuyer], ['ended', 'releasedToSeller', 2_000_000n, 2_000_000n, 0n])
  assert.deepEqual([e.creator, e.arbiter, e.timer], ['seller', null, null], 'an invoice, every option off')
  assert.equal(await connection.getAccountInfo(depositAddress(escrow, mint)), null, 'the deposit account is closed')
  assert.deepEqual(await kinds(d.signatures.invoice), ['created'])
  assert.deepEqual(await kinds(d.signatures['one tap']), ['ended'], 'paid and released in one transaction')
})

test('the split deal left its receipt: ended, split 60/40 of the whole balance', { skip }, async () => {
  const d = record.deals.split
  const escrow = escrowAddress(new PublicKey(record.keys.buyer), BigInt(d.id), programId)
  assert.equal(escrow.toBase58(), d.escrow)
  const e = decodeEscrow(new Uint8Array((await account(escrow)).data))
  assert.deepEqual([e.status, e.outcome, e.amount, e.toSeller, e.toBuyer], ['ended', 'split', 3_000_000n, 1_800_000n, 1_200_000n])
  assert.equal(e.creator, 'buyer')
  assert.ok(e.fundedAt !== null, 'marked funded')
  assert.equal(await connection.getAccountInfo(depositAddress(escrow, mint)), null, 'the deposit account is closed')
  assert.deepEqual(await kinds(d.signatures.create), ['created'])
  assert.deepEqual(await kinds(d.signatures['mark_funded']), ['funded'])
  assert.deepEqual(await kinds(d.signatures.split), ['ended'])
})

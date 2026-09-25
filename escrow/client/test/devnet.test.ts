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
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

async function account(address: PublicKey | string) {
  const info = await connection.getAccountInfo(new PublicKey(address))
  assert.ok(info, `no account at ${address}`)
  return info
}

/** One transaction, read back. Devnet's public endpoint limits `getTransaction` per client, so a
 * 429 is waited out (the web3 client's own retries give up after about eight seconds). */
async function transaction(signature: string) {
  for (let i = 0; ; i++) {
    try {
      return await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    } catch (e) {
      if (!String(e).includes('429') || i >= 10) throw e
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

async function kinds(signature: string): Promise<string[]> {
  const tx = await transaction(signature)
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

test('the invoice paid with one tap left its receipt at the seller\'s address: ended, released to the seller, created by the seller', { skip }, async () => {
  const d = record.deals.invoice
  const escrow = escrowAddress(new PublicKey(record.keys.seller), BigInt(d.id), programId)
  assert.equal(escrow.toBase58(), d.escrow)
  const e = decodeEscrow(new Uint8Array((await account(escrow)).data))
  assert.equal(e.seller.toBase58(), record.keys.seller)
  assert.equal(e.mint.toBase58(), mint.toBase58())
  assert.deepEqual([e.status, e.outcome, e.amount, e.toSeller, e.toBuyer], ['ended', 'releasedToSeller', 2_000_000n, 2_000_000n, 0n])
  assert.deepEqual([e.creator, e.arbiter, e.timer], ['seller', null, null], 'an invoice, every option off')
  assert.equal(e.rentRecipient.toBase58(), record.keys.seller, 'its rent back to the seller, who opened it')
  assert.equal(await connection.getAccountInfo(depositAddress(escrow, mint)), null, 'the deposit account is closed')
  assert.deepEqual(await kinds(d.signatures.invoice), ['created'])
  assert.deepEqual(await kinds(d.signatures['one tap']), ['ended'], 'paid and released in one transaction')

  // The one tap's instructions, in order: the deposit address made first (the associated token
  // program's idempotent create, so a fee payer that checks every transfer's destination finds it
  // made), a plain transfer of the amount into it, and the buyer's release.
  const tx = await transaction(d.signatures['one tap'])
  assert.ok(tx, 'the one tap is on chain')
  const message = tx.transaction.message
  const keys = message.staticAccountKeys
  const steps = message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex].toBase58(), accounts: ix.accountKeyIndexes.map((i) => keys[i].toBase58()), data: Buffer.from(ix.data) }))
  assert.deepEqual(steps.map((s) => s.program), [ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, programId.toBase58()])
  assert.deepEqual([steps[0].accounts[1], steps[0].accounts[2], steps[0].data.toString('hex')], [d.deposit, d.escrow, '01'], 'the deposit address, made if missing')
  assert.equal(steps[1].data[0], 3, 'a plain transfer')
  assert.equal(steps[1].data.readBigUInt64LE(1), 2_000_000n, 'of the whole amount')
  assert.equal(steps[1].accounts[1], d.deposit, 'into the deposit address')
})

test('the split deal left its receipt: ended, split 60/40 of the whole balance', { skip }, async () => {
  const d = record.deals.split
  const escrow = escrowAddress(new PublicKey(record.keys.buyer), BigInt(d.id), programId)
  assert.equal(escrow.toBase58(), d.escrow)
  const e = decodeEscrow(new Uint8Array((await account(escrow)).data))
  assert.deepEqual([e.status, e.outcome, e.amount, e.toSeller, e.toBuyer], ['ended', 'split', 3_000_000n, 1_800_000n, 1_200_000n])
  assert.equal(e.creator, 'buyer')
  assert.equal(e.rentRecipient.toBase58(), record.keys.buyer, 'its rent back to the buyer, who opened it')
  assert.ok(e.fundedAt !== null, 'marked funded')
  assert.equal(await connection.getAccountInfo(depositAddress(escrow, mint)), null, 'the deposit account is closed')
  assert.deepEqual(await kinds(d.signatures.create), ['created'])
  assert.deepEqual(await kinds(d.signatures['mark_funded']), ['funded'])
  assert.deepEqual(await kinds(d.signatures.split), ['ended'])
})

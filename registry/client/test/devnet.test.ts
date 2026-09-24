// Smoke tests against the registry's devnet deploy, as `devnet/devnet.json` records it.
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

import {
  USDC_FEE,
  USDC_MINT_DEVNET,
  configAddress,
  decodeConfig,
  decodeIdentityList,
  decodeRegisteredEvents,
  fetchListLeaves,
  listAddress,
  usedCodeAddress,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const enabled = process.env.FOREST_DEVNET === '1'
const skip = enabled ? false : 'set FOREST_DEVNET=1 to run against devnet'
const record = JSON.parse(readFileSync(resolve(process.env.FOREST_DEVNET_RECORD ?? join(here, '../../../devnet/devnet.json')), 'utf8'))
const connection = new Connection(process.env.FOREST_DEVNET_RPC ?? record.rpc, 'confirmed')
const programId = new PublicKey(record.registry.programId)
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'

async function account(address: PublicKey | string) {
  const info = await connection.getAccountInfo(new PublicKey(address))
  assert.ok(info, `no account at ${address}`)
  return info
}

async function landed(signature: string) {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  assert.ok(tx?.meta, `no transaction ${signature}`)
  return tx
}

test('the registry is deployed at its recorded id, its upgrade key still the deploy key', { skip }, async () => {
  const program = await account(programId)
  assert.equal(program.executable, true)
  assert.equal(program.owner.toBase58(), UPGRADEABLE_LOADER)
  // The program account names its program data account; that account names the upgrade authority.
  const programData = new PublicKey(program.data.subarray(4, 36))
  assert.equal(programData.toBase58(), record.registry.programData)
  const data = (await account(programData)).data
  assert.equal(data[12], 1, 'an upgrade authority is set: devnet is not sealed (mainnet is, at deploy)')
  assert.equal(new PublicKey(data.subarray(13, 45)).toBase58(), record.keys.deploy)
})

test('init wrote this build\'s constants, and the test dollar is accepted at 0.25', { skip }, async () => {
  const config = decodeConfig(new Uint8Array((await account(configAddress(programId))).data))
  assert.equal(config.treasury.toBase58(), record.keys.treasury)
  assert.equal(config.pendingTreasury, null)
  assert.deepEqual(config.mints.map((m) => m.toBase58()), [USDC_MINT_DEVNET.toBase58(), record.testDollar.mint])
  assert.deepEqual(config.fees, [USDC_FEE, BigInt(record.testDollar.fee)])
  const list = decodeIdentityList(new Uint8Array((await account(listAddress(0, programId))).data))
  assert.equal(list.owner.toBase58(), record.keys.foundationIssuer, "list 0 is the devnet foundation issuer's")
  assert.equal(list.pendingOwner, null)
  assert.equal(configAddress(programId).toBase58(), record.registry.config)
  assert.equal(listAddress(0, programId).toBase58(), record.registry.list0)
})

test("list 0's members, read from the log the way a phone reads them, give its root and hold the person", { skip, timeout: 120_000 }, async () => {
  const { leaves, root } = await fetchListLeaves(connection, 0, { programId })
  assert.ok(leaves.includes(BigInt(record.registration.commitment)))
  const list = decodeIdentityList(new Uint8Array((await account(listAddress(0, programId))).data))
  assert.equal(BigInt(leaves.length), list.leafCount)
  assert.equal(root.toString(16).padStart(64, '0'), Buffer.from(list.root).toString('hex'))
})

test('the registration is on chain, and the same one sent again was refused', { skip }, async () => {
  const r = record.registration
  const tx = await landed(r.signature)
  assert.equal(tx.meta!.err, null)
  const [event] = decodeRegisteredEvents(tx.meta!.logMessages!, programId)
  assert.equal(event.market, r.market)
  assert.equal(event.did, r.did)
  assert.equal(event.wallet.toBase58(), r.wallet)
  assert.equal(Buffer.from(event.code).toString('hex'), r.code)
  assert.equal(event.listIndex, 0)
  assert.equal(event.listOwner.toBase58(), record.keys.foundationIssuer)
  const code = await account(usedCodeAddress(Buffer.from(r.code, 'hex'), programId))
  assert.equal(code.owner.toBase58(), programId.toBase58(), "the code account, the badge's whole rule")
  assert.equal(usedCodeAddress(Buffer.from(r.code, 'hex'), programId).toBase58(), r.codeAccount)

  const refused = await landed(r.refusedSignature)
  assert.notEqual(refused.meta!.err, null, 'the second attempt failed')
  assert.ok(refused.meta!.logMessages!.some((l) => l.includes(`${r.codeAccount}`) && l.includes('already in use')))
  assert.equal(decodeRegisteredEvents(refused.meta!.logMessages!, programId).length, 0, 'and wrote no entry')
})

test('every registry transaction the record lists landed, and only the refusal failed', { skip, timeout: 120_000 }, async () => {
  for (const { program, what, signature } of record.transactions) {
    if (program !== 'registry') continue
    const tx = await landed(signature)
    if (signature === record.registration.refusedSignature) assert.notEqual(tx.meta!.err, null, what)
    else assert.equal(tx.meta!.err, null, what)
  }
})

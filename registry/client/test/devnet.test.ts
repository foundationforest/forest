// Read-only smoke tests against the registry's devnet deploy, as registry/devnet/devnet.json
// records it. They send nothing.
//
//   npm run test:devnet          (FOREST_DEVNET_RPC for another endpoint)
//
// Skipped unless FOREST_DEVNET=1 (the npm script sets it), so `npm test` never needs a network.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Connection, PublicKey } from '@solana/web3.js'

import { fetchRow, fetchRows, issuerSigned, listRoot, rowAddress, rowSpace, toBytes32 } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const record = JSON.parse(readFileSync(join(here, '../../devnet/devnet.json'), 'utf8'))
const skip = process.env.FOREST_DEVNET === '1' ? false : 'set FOREST_DEVNET=1 (npm run test:devnet)'
const connection = new Connection(process.env.FOREST_DEVNET_RPC ?? record.rpc, 'confirmed')
const programId = new PublicKey(record.registry.programId)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The public RPC rate-limits; wait it out rather than fail. */
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (i >= 8 || !String(e).includes('429')) throw e
      await sleep(2_000 * (i + 1))
    }
  }
}

test('the registry is deployed at its recorded id, its bytes the build, its upgrade key the deploy key', { skip }, async () => {
  const program = await retry(() => connection.getAccountInfo(programId))
  assert.ok(program?.executable, 'an executable program')
  const data = await retry(() => connection.getAccountInfo(new PublicKey(record.registry.programData)))
  assert.ok(data)
  // The program data account: 4 bytes of kind, 8 of slot, 1 + 32 of upgrade authority, then the program.
  assert.equal(new PublicKey(data.data.subarray(13, 45)).toBase58(), record.registry.upgradeAuthority)
  const so = data.data.subarray(45, 45 + record.registry.soBytes)
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(so).digest('hex'), record.registry.soSha256)
})

test("the row is on chain as recorded, the issuer's signature checks, never changed", { skip }, async () => {
  const r = record.row
  const marketStamp = Buffer.from(r.marketStamp, 'hex')
  assert.equal(rowAddress(marketStamp, programId).toBase58(), r.address)
  const row = await retry(() => fetchRow(connection, marketStamp, { programId }))
  assert.ok(row, 'the row exists')
  assert.equal(row.profile.toBase58(), r.profile)
  assert.equal(row.issuer.toBase58(), r.issuer)
  assert.equal(row.label, r.label)
  assert.equal(hex(row.root), r.list.root)
  assert.equal(hex(row.root), hex(toBytes32(listRoot(r.list.stamps.map(BigInt)))), "the root is the list's")
  assert.equal(hex(row.issuerSignature), r.list.issuerSignature)
  assert.equal(issuerSigned(row), true)
  assert.equal(row.payer.toBase58(), r.onChain.payer)
  const info = await retry(() => connection.getAccountInfo(new PublicKey(r.address)))
  assert.equal(info?.data.length, rowSpace(Buffer.byteLength(r.label)))
  assert.equal(info?.lamports, await retry(() => connection.getMinimumBalanceForRentExemption(info!.data.length)), 'exactly rent exempt after the refund')
})

test('the profile has one row and the issuer one, read the way any reader reads', { skip }, async () => {
  const byProfile = await retry(() => fetchRows(connection, { profile: new PublicKey(record.row.profile), programId }))
  assert.equal(byProfile.length, 1)
  assert.equal(byProfile[0].address.toBase58(), record.row.address)
  // The stand-in issuer's rows: this one, and any earlier test person's on the same issuer's list.
  const byIssuer = await retry(() => fetchRows(connection, { issuer: new PublicKey(record.row.issuer), programId }))
  const earlier = (record.earlierRows ?? []).filter((r: { issuer: string }) => r.issuer === record.row.issuer).map((r: { address: string }) => r.address)
  assert.deepEqual(byIssuer.map((r) => r.address.toBase58()).sort(), [record.row.address, ...earlier].sort())
})

test("an earlier test person's row is still on chain, unchanged, at its minimum: rows never close", { skip }, async () => {
  for (const r of record.earlierRows ?? []) {
    const row = await retry(() => fetchRow(connection, Buffer.from(r.marketStamp, 'hex'), { programId }))
    assert.ok(row, `${r.address}: the row exists`)
    assert.equal(row.profile.toBase58(), r.profile)
    assert.equal(hex(row.root), r.list.root)
    assert.equal(issuerSigned(row), true)
    const info = await retry(() => connection.getAccountInfo(new PublicKey(r.address)))
    assert.equal(info?.lamports, await retry(() => connection.getMinimumBalanceForRentExemption(info!.data.length)))
  }
})

test('every recorded transaction landed, and only the refusal failed', { skip, timeout: 300_000 }, async () => {
  const refused = new Set([record.row.refused.signature, ...(record.earlierRows ?? []).map((r: { refused?: { signature: string } }) => r.refused?.signature)])
  for (const { what, signature } of record.transactions.filter((t: { signature?: string }) => t.signature)) {
    const { value } = await retry(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
    assert.ok(value[0], `${what}: not found`)
    assert.equal(value[0].err !== null, refused.has(signature), `${what}: ${JSON.stringify(value[0].err)}`)
    await sleep(300)
  }
})

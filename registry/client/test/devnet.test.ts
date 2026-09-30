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

import { fetchLine, fetchLines, lineAddress, lineSpace } from '../src/index.ts'

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

test("the line is on chain as recorded: the profile, the label, both roots, the relayer as payer", { skip }, async () => {
  const code = Buffer.from(record.line.code, 'hex')
  assert.equal(lineAddress(code, programId).toBase58(), record.line.address)
  const line = await retry(() => fetchLine(connection, code, { programId }))
  assert.ok(line, 'the line exists')
  assert.equal(line.profile.toBase58(), record.line.profile)
  assert.equal(line.label, record.line.label)
  assert.deepEqual(line.roots.map(hex), [record.line.lists.A.root, record.line.lists.B.root])
  assert.equal(line.payer.toBase58(), record.line.onChain.payer)
  const info = await retry(() => connection.getAccountInfo(new PublicKey(record.line.address)))
  assert.equal(info?.data.length, lineSpace(Buffer.byteLength(record.line.label), 2))
  assert.equal(info?.lamports, await retry(() => connection.getMinimumBalanceForRentExemption(info!.data.length)), 'exactly rent exempt after the refund')
})

test('the profile has one line, read the way any reader reads', { skip }, async () => {
  const lines = await retry(() => fetchLines(connection, { profile: new PublicKey(record.line.profile), programId }))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].address.toBase58(), record.line.address)
})

test('every recorded transaction landed, and only the two refusals failed', { skip, timeout: 300_000 }, async () => {
  const refused = new Set([record.line.refused.secondRegister.signature, record.line.refused.replayedRoot.signature])
  for (const { what, signature } of record.transactions.filter((t: { signature?: string }) => t.signature)) {
    const { value } = await retry(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
    assert.ok(value[0], `${what}: not found`)
    assert.equal(value[0].err !== null, refused.has(signature), `${what}: ${JSON.stringify(value[0].err)}`)
    await sleep(300)
  }
})

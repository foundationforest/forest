// The client against a real validator: start one, load the program, and make rows end to end, from
// the keys recipe's seed and a keeper's signed list to rows on the chain.
//
//   npm run test:validator
//
// Needs `solana-test-validator` on the PATH, the program built (`cargo build-sbf` in
// ../program) and the artifacts fetched (`npm run fetch` in ../artifacts). If any of the three
// is missing the test says which and skips, rather than failing for the wrong reason.
//
// Everything here polls `getSignatureStatuses` rather than calling `confirmTransaction`, which
// opens a websocket subscription that keeps Node alive long after the test has passed.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'

import { listSecret } from '../../../keys/src/index.ts'
import {
  PROGRAM_ID,
  buildRegistration,
  fetchRow,
  fetchRows,
  keeperSigned,
  listRoot,
  refundIx,
  rootBytes,
  rowSpace,
  stampOf,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const soPath = join(here, '../../program/target/deploy/forest_registry.so')
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
const RPC = 'http://127.0.0.1:8899'
const LABEL = 'tutoring/seller'

function missing(): string | null {
  if (!existsSync(soPath)) return `no program at ${soPath}; run \`cargo build-sbf\` in registry/program`
  if (!existsSync(artifacts.zkey)) return 'no artifacts; run `npm run fetch` in registry/artifacts'
  return null
}

let validator: ChildProcess | undefined
let ledger: string | undefined
let connection: Connection

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait for a signature without opening a websocket. Returns its error, if it failed. */
async function settle(signature: string): Promise<unknown> {
  for (let i = 0; i < 120; i++) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return status.err
    await sleep(250)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function sendVersioned(tx: VersionedTransaction, signers: Keypair[], skipPreflight = false): Promise<{ signature: string; err: unknown }> {
  tx.sign(signers)
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  return { signature, err: await settle(signature) }
}

async function sendLegacy(tx: Transaction, signer: Keypair): Promise<{ signature: string; err: unknown }> {
  tx.feePayer = signer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(signer)
  const signature = await connection.sendRawTransaction(tx.serialize())
  return { signature, err: await settle(signature) }
}

async function fund(key: PublicKey): Promise<void> {
  const err = await settle(await connection.requestAirdrop(key, 10 * LAMPORTS_PER_SOL))
  if (err) throw new Error(`airdrop failed: ${JSON.stringify(err)}`)
}

before(
  async () => {
    if (missing()) return
    ledger = mkdtempSync(join(tmpdir(), 'forest-registry-ledger-'))
    validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', ledger, '--bpf-program', PROGRAM_ID.toBase58(), soPath], {
      stdio: 'ignore',
    })
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

test('rows go through a real validator: the profile signs, a relayer pays, one row per keeper per label', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  // The person: the keys recipe's pinned test seed, and two profiles they hold.
  const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
  const seed = Buffer.from(vectors.seed, 'hex')
  const profile = Keypair.generate()
  const second = Keypair.generate()

  // Two keepers. Each publishes its list, the person's stamp for that keeper among strangers', and
  // signs the list's root.
  const keepers = [Keypair.generate(), Keypair.generate()]
  const lists = await Promise.all(
    keepers.map(async (k, i) => {
      const secret = await listSecret(seed, k.publicKey.toBase58())
      const stamps = [stampOf(Buffer.from(`stranger ${i} 1`)), stampOf(secret), stampOf(Buffer.from(`stranger ${i} 2`))]
      return { keeper: k, secret, stamps, signature: ed25519.sign(rootBytes(listRoot(stamps)), k.secretKey.subarray(0, 32)) }
    }),
  )

  // A relayer pays for everything; the profile signs its own row.
  const relayer = Keypair.generate()
  await fund(relayer.publicKey)
  const build = async (who: Keypair, list: (typeof lists)[number]) =>
    buildRegistration({
      secret: list.secret,
      label: LABEL,
      profile: who.publicKey,
      keeper: list.keeper.publicKey,
      stamps: list.stamps,
      keeperSignature: list.signature,
      artifacts,
      payer: relayer.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    })

  const reg = await build(profile, lists[0])
  const tx = reg.transaction
  assert.equal(tx.message.header.numRequiredSignatures, 2, 'the relayer and the profile sign')
  assert.ok(!tx.message.staticAccountKeys.some((k) => k.equals(ComputeBudgetProgram.programId)), 'no compute-budget instruction')
  const { signature, err } = await sendVersioned(tx, [relayer, profile])
  assert.equal(err, null, signature)
  const meta = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  const units = meta?.meta?.computeUnitsConsumed ?? 0

  const row = await fetchRow(connection, reg.marketStamp)
  assert.ok(row)
  assert.equal(row.profile.toBase58(), profile.publicKey.toBase58())
  assert.equal(row.keeper.toBase58(), keepers[0].publicKey.toBase58())
  assert.equal(row.label, LABEL)
  assert.equal(row.payer.toBase58(), relayer.publicKey.toBase58())
  assert.equal(Buffer.from(row.root).toString('hex'), Buffer.from(toBytes32(listRoot(lists[0].stamps))).toString('hex'))
  assert.equal(keeperSigned(row), true, "a reader checks the keeper's signature")
  const written = (await connection.getAccountInfo(reg.row))!.data
  assert.equal(written.length, rowSpace(Buffer.byteLength(LABEL)))

  // Refused on chain: the same keeper and label for the person's second profile, the same market
  // stamp. Through the second keeper, it is another market stamp, and lands.
  const again = await build(second, lists[0])
  assert.equal(again.row.toBase58(), reg.row.toBase58())
  assert.notEqual((await sendVersioned(again.transaction, [relayer, second], true)).err, null, 'a second row for the market stamp')
  const other = await build(second, lists[1])
  assert.equal((await sendVersioned(other.transaction, [relayer, second])).err, null, 'the second profile, through the second keeper')
  const rows = await fetchRows(connection, { label: LABEL })
  assert.deepEqual(rows.map((r) => r.row.profile.toBase58()).sort(), [profile.publicKey.toBase58(), second.publicKey.toBase58()].sort())
  assert.equal((await fetchRows(connection, { keeper: keepers[1].publicKey })).length, 1)

  // Refund: someone sends the row lamports; anyone sends refund; the relayer, its recorded payer,
  // gets exactly them back, and the row is byte for byte what register wrote.
  const stranger = Keypair.generate()
  await fund(stranger.publicKey)
  const gift = new Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: reg.row, lamports: 1_000_000 }))
  assert.equal((await sendLegacy(gift, stranger)).err, null)
  const before = await connection.getBalance(relayer.publicKey)
  assert.equal((await sendLegacy(new Transaction().add(refundIx({ row: reg.row, payer: relayer.publicKey })), stranger)).err, null)
  assert.equal((await connection.getBalance(relayer.publicKey)) - before, 1_000_000)
  assert.deepEqual((await connection.getAccountInfo(reg.row))!.data, written)

  console.log(`register ${units} compute units on a local validator; two rows through two keepers, one refused, a refund to the relayer`)
})

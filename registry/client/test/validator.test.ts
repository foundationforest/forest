// The client against a real validator: start one, load the program, and make a line end to end,
// from the keys recipe's seed to a line on the chain backed by two issuers' lists.
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

import { Identity } from '@semaphore-protocol/identity'
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

import { identitySecret, profileKey } from '../../../keys/src/index.ts'
import {
  PROGRAM_ID,
  addProofIx,
  buildAddProof,
  buildRegistration,
  commitmentOf,
  fetchLine,
  fetchLines,
  listRoot,
  refundIx,
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

async function sendLegacy(tx: Transaction, signer: Keypair, skipPreflight = false): Promise<{ signature: string; err: unknown }> {
  tx.feePayer = signer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(signer)
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
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

test('a line goes through a real validator, the profile key signing nothing', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  // The person: the keys recipe's pinned test seed, its profile 0 and its identity secret.
  const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
  const seed = Buffer.from(vectors.seed, 'hex')
  const profile = new PublicKey((await profileKey(seed, 0)).publicKey)
  const secret = await identitySecret(seed)
  const mine = commitmentOf(secret)

  // Two issuers' published lists, the person in both.
  const stranger = (n: number) => commitmentOf(new Identity(Buffer.from(`validator test stranger ${n}`)))
  const listA = [stranger(1), stranger(2), mine, stranger(3)]
  const listB = [mine, stranger(4)]
  const listC = [stranger(5), mine]

  // A relayer pays for everything; the person's profile key never signs.
  const relayer = Keypair.generate()
  const other = Keypair.generate()
  await fund(relayer.publicKey)
  await fund(other.publicKey)

  const reg = await buildRegistration({
    secret,
    label: LABEL,
    profile,
    lists: [listA, listB],
    artifacts,
    payer: relayer.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  assert.equal(reg.transactions.length, 2, 'register, then one add_proof')
  for (const tx of reg.transactions) {
    assert.equal(tx.message.header.numRequiredSignatures, 1, 'only the payer signs')
    assert.ok(!tx.message.staticAccountKeys.some((k) => k.equals(profile)), 'the profile key is not in the transaction')
    assert.ok(!tx.message.staticAccountKeys.some((k) => k.equals(ComputeBudgetProgram.programId)), 'no compute-budget instruction')
  }
  const units: number[] = []
  for (const tx of reg.transactions) {
    const { signature, err } = await sendVersioned(tx, [relayer])
    assert.equal(err, null, signature)
    const meta = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    units.push(meta?.meta?.computeUnitsConsumed ?? 0)
  }

  const line = await fetchLine(connection, reg.code)
  assert.ok(line)
  assert.equal(line.profile.toBase58(), profile.toBase58())
  assert.equal(line.label, LABEL)
  assert.equal(line.payer.toBase58(), relayer.publicKey.toBase58())
  assert.deepEqual(line.roots.map((r) => Buffer.from(r).toString('hex')), [listA, listB].map((l) => Buffer.from(toBytes32(listRoot(l))).toString('hex')))
  const lines = await fetchLines(connection, { profile })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].address.toBase58(), reg.line.toBase58())

  // A third issuer's list, added by anyone: here the other key pays.
  const third = await buildAddProof({
    secret,
    label: LABEL,
    profile,
    commitments: listC,
    artifacts,
    payer: other.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  assert.equal((await sendVersioned(third.transaction, [other])).err, null)
  assert.equal((await fetchLine(connection, reg.code))?.roots.length, 3)

  // Refused on chain: a second register for the same code, and list B's proof replayed.
  const again = await buildRegistration({
    secret,
    label: LABEL,
    profile,
    lists: [listC],
    artifacts,
    payer: other.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  assert.notEqual((await sendVersioned(again.transactions[0], [other], true)).err, null, 'a second line for the code')
  const replay = new Transaction().add(addProofIx({ code: reg.code, proof: reg.proofs[1], payer: other.publicKey }))
  assert.notEqual((await sendLegacy(replay, other, true)).err, null, 'a root already in the line')

  // Refund: someone sends the line lamports; anyone sends refund; the relayer, its recorded payer,
  // gets exactly them back.
  const gift = new Transaction().add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: reg.line, lamports: 1_000_000 }))
  assert.equal((await sendLegacy(gift, other)).err, null)
  const before = await connection.getBalance(relayer.publicKey)
  assert.equal((await sendLegacy(new Transaction().add(refundIx({ code: reg.code, payer: relayer.publicKey })), other)).err, null)
  assert.equal((await connection.getBalance(relayer.publicKey)) - before, 1_000_000)

  console.log(`register ${units[0]} and add_proof ${units[1]} compute units on a local validator; three roots; a refund to the relayer`)
})

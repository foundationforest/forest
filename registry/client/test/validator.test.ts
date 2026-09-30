// The client against a real validator: start one, load the program, and make a line end to end,
// from the keys recipe's seed to a line on the chain, then a second issuer's membership checked
// against it off chain.
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

import { didKey, identitySecret, profileKey } from '../../../keys/src/index.ts'
import {
  PROGRAM_ID,
  buildRegistration,
  commitmentOf,
  fetchLine,
  fetchLines,
  lineSpace,
  listRoot,
  makeMembership,
  refundIx,
  registerIx,
  toBytes32,
  verifyMembership,
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

test('a line goes through a real validator, the profile key signing nothing, and never changes', { timeout: 300_000 }, async (t) => {
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

  // A relayer pays for everything; the person's profile key never signs.
  const relayer = Keypair.generate()
  const other = Keypair.generate()
  await fund(relayer.publicKey)
  await fund(other.publicKey)

  const reg = await buildRegistration({
    secret,
    label: LABEL,
    profile,
    commitments: listA,
    artifacts,
    payer: relayer.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  const tx = reg.transaction
  assert.equal(tx.message.header.numRequiredSignatures, 1, 'only the payer signs')
  assert.ok(!tx.message.staticAccountKeys.some((k) => k.equals(profile)), 'the profile key is not in the transaction')
  assert.ok(!tx.message.staticAccountKeys.some((k) => k.equals(ComputeBudgetProgram.programId)), 'no compute-budget instruction')
  const { signature, err } = await sendVersioned(tx, [relayer])
  assert.equal(err, null, signature)
  const meta = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  const units = meta?.meta?.computeUnitsConsumed ?? 0

  const line = await fetchLine(connection, reg.code)
  assert.ok(line)
  assert.equal(line.profile.toBase58(), profile.toBase58())
  assert.equal(line.label, LABEL)
  assert.equal(line.payer.toBase58(), relayer.publicKey.toBase58())
  assert.equal(Buffer.from(line.root).toString('hex'), Buffer.from(toBytes32(listRoot(listA))).toString('hex'))
  const lines = await fetchLines(connection, { profile })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].address.toBase58(), reg.line.toBase58())
  const written = (await connection.getAccountInfo(reg.line))!.data
  assert.equal(written.length, lineSpace(Buffer.byteLength(LABEL)))

  // Refused on chain: a second register for the same code, from the other issuer's list.
  const again = await buildRegistration({
    secret,
    label: LABEL,
    profile,
    commitments: listB,
    artifacts,
    payer: other.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  })
  assert.notEqual((await sendVersioned(again.transaction, [other], true)).err, null, 'a second line for the code')
  const replay = new Transaction().add(registerIx({ profile, label: LABEL, code: reg.code, proof: reg, payer: other.publicKey }))
  assert.notEqual((await sendLegacy(replay, other, true)).err, null, 'the same proof again')

  // Refund: someone sends the line lamports; anyone sends refund; the relayer, its recorded payer,
  // gets exactly them back.
  const gift = new Transaction().add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: reg.line, lamports: 1_000_000 }))
  assert.equal((await sendLegacy(gift, other)).err, null)
  const before = await connection.getBalance(relayer.publicKey)
  assert.equal((await sendLegacy(new Transaction().add(refundIx({ code: reg.code, payer: relayer.publicKey })), other)).err, null)
  assert.equal((await connection.getBalance(relayer.publicKey)) - before, 1_000_000)
  assert.deepEqual((await connection.getAccountInfo(reg.line))!.data, written, 'the line is byte for byte what register wrote')

  // A second issuer, off chain: the person proves they are on list B for the same label and
  // profile, and a reader checks the record against the line on chain and B's published root.
  const issuerB = didKey(Keypair.generate().publicKey.toBytes())
  const record = await makeMembership({ secret, label: LABEL, profile, commitments: listB, issuer: issuerB, artifacts })
  const verificationKey = JSON.parse(readFileSync(join(here, '../../artifacts/semaphore-32.json'), 'utf8'))
  const onChain = (await fetchLine(connection, Buffer.from(record.membership.code, 'hex')))!
  const issuer = { key: issuerB, roots: [listRoot(listB)] }
  assert.equal(await verifyMembership(record, { profile, line: onChain, issuer, verificationKey }), true, 'B vouches, off chain')
  assert.equal(await verifyMembership(record, { profile, line: onChain, issuer: { key: issuerB, roots: [listRoot(listA)] }, verificationKey }), false, 'a root B did not publish')

  console.log(`register ${units} compute units on a local validator; one root, a refund to the relayer, and a second issuer off chain`)
})

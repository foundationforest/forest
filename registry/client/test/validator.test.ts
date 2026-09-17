// The client against a real validator: start one, load the program, and run a registration end
// to end, from the identity secret to a badge on the chain.
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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Identity } from '@semaphore-protocol/identity'
import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
} from '@solana/spl-token'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'

import {
  PROGRAM_ID,
  REGISTRATION_FEE,
  addIssuerIx,
  buildRegistration,
  codeFor,
  codeTreeAddress,
  commitmentOf,
  configAddress,
  decodeCodeTree,
  decodeConfig,
  decodeIdentityList,
  decodeRegisteredEvents,
  fromBytes32,
  initIx,
  insertIdentityIx,
  listAddress,
  usedCodeAddress,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const soPath = join(here, '../../program/target/deploy/forest_registry.so')
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
const RPC = 'http://127.0.0.1:8899'
const MARKET = 'online-tutors'
const DID = 'did:plc:wece24yzukt4pj6hqvmb2fn4'

function missing(): string | null {
  if (!existsSync(soPath)) return `no program at ${soPath}; run \`cargo build-sbf\` in registry/program`
  if (!existsSync(artifacts.zkey)) return 'no artifacts; run `npm run fetch` in registry/artifacts'
  return null
}

let validator: ChildProcess | undefined
let ledger: string | undefined
let connection: Connection

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait for a signature without opening a websocket. */
async function confirm(signature: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return
    }
    await sleep(250)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function send(instructions: Transaction['instructions'], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  return signature
}

before(
  async () => {
    if (missing()) return
    ledger = mkdtempSync(join(tmpdir(), 'forest-registry-ledger-'))
    validator = spawn(
      'solana-test-validator',
      ['--reset', '--quiet', '--ledger', ledger, '--bpf-program', PROGRAM_ID.toBase58(), soPath],
      { stdio: 'ignore' },
    )
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

test('a registration goes through a real validator', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  const payer = Keypair.generate() // the fee payer; Kora in production
  const treasuryKey = Keypair.generate()
  const treasury = Keypair.generate()
  const issuer = Keypair.generate()
  const profileWallet = Keypair.generate()

  const airdrop = await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL)
  await confirm(airdrop)

  // A dollar stablecoin with six decimals, and the two accounts the fee moves between.
  const usdc = Keypair.generate()
  const treasuryTokens = Keypair.generate()
  const profileTokens = Keypair.generate()
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
  const accountRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
  const newAccount = (key: PublicKey, space: number, lamports: number) =>
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: key,
      space,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    })
  await send(
    [
      newAccount(usdc.publicKey, MINT_SIZE, mintRent),
      createInitializeMint2Instruction(usdc.publicKey, 6, payer.publicKey, null),
      newAccount(treasuryTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(treasuryTokens.publicKey, usdc.publicKey, treasury.publicKey),
      newAccount(profileTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(profileTokens.publicKey, usdc.publicKey, profileWallet.publicKey),
      createMintToInstruction(usdc.publicKey, profileTokens.publicKey, payer.publicKey, 1_000_000),
    ],
    [payer, usdc, treasuryTokens, profileTokens],
  )

  await send(
    [
      initIx({
        payer: payer.publicKey,
        treasuryKey: treasuryKey.publicKey,
        treasury: treasury.publicKey,
        usdcMint: usdc.publicKey,
      }),
    ],
    [payer, treasuryKey],
  )
  await send(
    [addIssuerIx({ treasuryKey: treasuryKey.publicKey, listIndex: 0, issuer: issuer.publicKey })],
    [payer, treasuryKey],
  )

  const config = decodeConfig(new Uint8Array((await connection.getAccountInfo(configAddress()))!.data))
  assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58())
  assert.equal(config.treasuryKey.toBase58(), treasuryKey.publicKey.toBase58())
  assert.equal(config.tokenDecimals, 6)
  assert.deepEqual(
    config.mints.map((m) => m.toBase58()),
    [usdc.publicKey.toBase58()],
  )
  assert.equal(config.listCount, 1)

  // The issuer inserts the list, commitments only. Alice's secret is the one keys/ pins.
  const alice = new Identity(
    Buffer.from('54684ed3bd15671b1a07bd8ed840a049c60ce847afd7d8da73b4f71cc6884d85', 'hex'),
  )
  const others = [1, 2, 3].map((n) => new Identity(Buffer.from(`validator filler ${n}`)))
  const leaves = [
    commitmentOf(others[0]),
    commitmentOf(alice),
    commitmentOf(others[1]),
    commitmentOf(others[2]),
  ]
  for (const commitment of leaves) {
    await send([insertIdentityIx({ issuer: issuer.publicKey, listIndex: 0, commitment })], [payer, issuer])
  }

  const list = decodeIdentityList(new Uint8Array((await connection.getAccountInfo(listAddress(0)))!.data))
  assert.equal(list.leafCount, BigInt(leaves.length))
  assert.equal(list.issuers[0].toBase58(), issuer.publicKey.toBase58())

  // Everything above is the foundation's. This is the only part a person's device ever does.
  const accounts = {
    payer: payer.publicKey,
    profileWallet: profileWallet.publicKey,
    profileTokens: profileTokens.publicKey,
    treasuryTokens: treasuryTokens.publicKey,
  }
  const build = async () =>
    buildRegistration({
      secret: alice,
      market: MARKET,
      did: DID,
      listIndex: 0,
      leaves,
      artifacts,
      accounts,
      recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    })

  const started = performance.now()
  const registration = await build()
  const proveMs = Math.round(performance.now() - started)

  assert.equal(registration.code, codeFor(alice, MARKET))
  assert.equal(registration.root, fromBytes32(list.root), 'the proof is against the root on the chain')

  // The device signs with the profile's wallet; the fee payer co-signs and sends.
  registration.transaction.sign([profileWallet])
  registration.transaction.sign([payer])
  const wire = registration.transaction.serialize()
  const signature = await connection.sendRawTransaction(wire)
  await confirm(signature)

  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  assert.ok(tx, 'the registration landed')

  console.log('\n== one registration on a local validator ==')
  console.log(`   proof on this machine   : ${proveMs} ms (depth 32, snarkjs in Node)`)
  console.log(`   transaction on the wire : ${wire.length} bytes of the 1,232 limit (v0, with a compute budget instruction)`)
  console.log(`   compute units consumed  : ${tx.meta?.computeUnitsConsumed}\n`)
  assert.ok(wire.length < 1232, 'a registration fits in one standard transaction')

  const [entry] = decodeRegisteredEvents(tx.meta?.logMessages ?? [])
  assert.equal(entry.market, MARKET)
  assert.equal(entry.did, DID)
  assert.equal(entry.listIndex, 0)
  assert.deepEqual(Buffer.from(entry.code), Buffer.from(registration.codeBytes))

  const code = await connection.getAccountInfo(usedCodeAddress(registration.code))
  assert.ok(code, 'the code account exists')
  assert.equal(code.data.length, 9)
  assert.equal(code.owner.toBase58(), PROGRAM_ID.toBase58())
  assert.equal(usedCodeAddress(registration.code).toBase58(), registration.codeAccount.toBase58())

  const tree = decodeCodeTree(new Uint8Array((await connection.getAccountInfo(codeTreeAddress()))!.data))
  assert.equal(tree.count, 1n)

  assert.equal((await getAccount(connection, treasuryTokens.publicKey)).amount, REGISTRATION_FEE)
  assert.equal((await getAccount(connection, profileTokens.publicKey)).amount, 1_000_000n - REGISTRATION_FEE)

  // The same badge a second time cannot be bought.
  const again = await build()
  again.transaction.sign([profileWallet])
  again.transaction.sign([payer])
  await assert.rejects(
    async () => {
      const sig = await connection.sendRawTransaction(again.transaction.serialize(), {
        skipPreflight: true,
      })
      await confirm(sig)
    },
    /already in use|custom program error|failed/i,
    'one badge per market per human',
  )
  assert.equal((await getAccount(connection, treasuryTokens.publicKey)).amount, REGISTRATION_FEE)
  console.log('the same badge a second time: refused, and the treasury still holds exactly one fee')
})

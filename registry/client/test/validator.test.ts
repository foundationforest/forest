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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import {
  PROGRAM_ID,
  TREASURY_PLACEHOLDER_SEED,
  USDC_MINT,
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
  registerIx,
  USDC_FEE,
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
/** 0.25 at USDC's six decimals: the program's constant. */
const QUARTER_USDC = USDC_FEE

// The fee payer; Kora in production. Made before the validator starts, because the validator is
// handed a USDC-shaped mint at the program's constant address whose mint authority is this key.
const payer = Keypair.generate()

/**
 * A classic SPL Token mint account in the validator's `--account` JSON form, planted at
 * USDC's address: six decimals, initialized, mint authority `payer`, no freeze authority.
 */
function usdcAccountJson(): string {
  const data = Buffer.alloc(MINT_SIZE)
  data.writeUInt32LE(1, 0) // mint_authority: Some
  payer.publicKey.toBuffer().copy(data, 4)
  data.writeBigUInt64LE(0n, 36) // supply
  data[44] = 6 // decimals
  data[45] = 1 // is_initialized
  return JSON.stringify({
    pubkey: USDC_MINT.toBase58(),
    account: {
      lamports: 1_461_600,
      data: [data.toString('base64'), 'base64'],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: MINT_SIZE,
    },
  })
}

function missing(): string | null {
  if (!existsSync(soPath)) return `no program at ${soPath}; run \`cargo build-sbf\` in registry/program`
  if (!existsSync(artifacts.zkey)) return 'no artifacts; run `npm run fetch` in registry/artifacts'
  return null
}

let validator: ChildProcess | undefined
let ledger: string | undefined
let accounts: string | undefined
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
    // Not inside the ledger directory: `--reset` empties that before `--account` files are read.
    accounts = mkdtempSync(join(tmpdir(), 'forest-registry-accounts-'))
    const usdcJson = join(accounts, 'usdc.json')
    writeFileSync(usdcJson, usdcAccountJson())
    validator = spawn(
      'solana-test-validator',
      [
        '--reset',
        '--quiet',
        '--ledger',
        ledger,
        '--bpf-program',
        PROGRAM_ID.toBase58(),
        soPath,
        '--account',
        USDC_MINT.toBase58(),
        usdcJson,
      ],
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
  if (accounts) rmSync(accounts, { recursive: true, force: true })
})

test('a registration goes through a real validator', { timeout: 300_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)
  if (!validator) return t.skip('solana-test-validator did not start (is it on the PATH?)')

  // The treasury is the program's placeholder constant, which this seed signs for.
  const treasury = Keypair.fromSeed(TREASURY_PLACEHOLDER_SEED)
  const issuer = Keypair.generate()
  const profileWallet = Keypair.generate()

  const airdrop = await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL)
  await confirm(airdrop)

  // The mint at USDC's address was planted when the validator started. The two accounts the fee
  // moves between are made here.
  const usdc = USDC_MINT
  const treasuryTokens = Keypair.generate()
  const profileTokens = Keypair.generate()
  // The sponsor's own tokens: on the sponsored path the fee payer also pays the fee.
  const sponsorTokens = Keypair.generate()
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
      newAccount(treasuryTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(treasuryTokens.publicKey, usdc, treasury.publicKey),
      newAccount(profileTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(profileTokens.publicKey, usdc, profileWallet.publicKey),
      createMintToInstruction(usdc, profileTokens.publicKey, payer.publicKey, 1_000_000),
      newAccount(sponsorTokens.publicKey, ACCOUNT_SIZE, accountRent),
      createInitializeAccount3Instruction(sponsorTokens.publicKey, usdc, payer.publicKey),
      createMintToInstruction(usdc, sponsorTokens.publicKey, payer.publicKey, 1_000_000),
    ],
    [payer, treasuryTokens, profileTokens, sponsorTokens],
  )

  // init carries nothing that chooses anything, and only the payer signs it.
  await send([initIx({ payer: payer.publicKey })], [payer])
  await send(
    [addIssuerIx({ treasury: treasury.publicKey, listIndex: 0, issuer: issuer.publicKey })],
    [payer, treasury],
  )

  const config = decodeConfig(new Uint8Array((await connection.getAccountInfo(configAddress()))!.data))
  assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58())
  assert.deepEqual(config.mints.map((m) => m.toBase58()), [usdc.toBase58()])
  assert.deepEqual(config.fees, [QUARTER_USDC], "USDC at the program's constant fee")
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

  // Everything above is the foundation's. This is the only part a person's device ever does. The
  // sponsored path: the fee payer (Kora, in production) pays the network fee, the rent and the
  // fee; the profile's wallet signs for consent.
  const sponsored = {
    payer: payer.publicKey,
    profileWallet: profileWallet.publicKey,
    feeAuthority: payer.publicKey,
    feeTokens: sponsorTokens.publicKey,
    treasuryTokens: treasuryTokens.publicKey,
  }
  const build = async (accounts: typeof sponsored) =>
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
  const registration = await build(sponsored)
  const proveMs = Math.round(performance.now() - started)

  assert.equal(registration.code, codeFor(alice, MARKET))
  assert.equal(registration.root, fromBytes32(list.root), 'the proof is against the root on the chain')

  // The sponsor saw the proof first. It tries to land it under its own key as the profile's
  // wallet: the proof names the profile's wallet, so it does not verify, and the code is not burned.
  const stolen = registerIx({
    market: MARKET,
    did: DID,
    listIndex: 0,
    root: registration.root,
    code: registration.code,
    proof: registration.proof,
    accounts: { ...sponsored, profileWallet: payer.publicKey },
  })
  const frontRun = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
      instructions: [stolen],
    }).compileToV0Message(),
  )
  frontRun.sign([payer])
  await assert.rejects(
    async () => confirm(await connection.sendRawTransaction(frontRun.serialize(), { skipPreflight: true })),
    /failed/i,
    'a proof cannot land under another wallet',
  )
  assert.equal(await connection.getAccountInfo(usedCodeAddress(registration.code)), null, 'and the code is still unused')

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
  assert.equal(entry.wallet.toBase58(), profileWallet.publicKey.toBase58(), 'the entry names the profile wallet')
  assert.equal(entry.listIndex, 0)
  assert.deepEqual(Buffer.from(entry.code), Buffer.from(registration.codeBytes))

  const code = await connection.getAccountInfo(usedCodeAddress(registration.code))
  assert.ok(code, 'the code account exists')
  assert.equal(code.data.length, 9)
  assert.equal(code.owner.toBase58(), PROGRAM_ID.toBase58())
  assert.equal(usedCodeAddress(registration.code).toBase58(), registration.codeAccount.toBase58())

  const tree = decodeCodeTree(new Uint8Array((await connection.getAccountInfo(codeTreeAddress()))!.data))
  assert.equal(tree.count, 1n)

  assert.equal((await getAccount(connection, treasuryTokens.publicKey)).amount, QUARTER_USDC)
  assert.equal((await getAccount(connection, sponsorTokens.publicKey)).amount, 1_000_000n - QUARTER_USDC, 'the sponsor paid the fee')
  assert.equal((await getAccount(connection, profileTokens.publicKey)).amount, 1_000_000n, 'the profile paid nothing')

  // The same badge a second time cannot be bought, on the paid path either.
  const again = await build({ ...sponsored, feeAuthority: profileWallet.publicKey, feeTokens: profileTokens.publicKey })
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
  assert.equal((await getAccount(connection, treasuryTokens.publicKey)).amount, QUARTER_USDC)
  console.log('the same badge a second time: refused, and the treasury still holds exactly one fee')
})

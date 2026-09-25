// The registry on devnet, used for real: init, a test dollar accepted, one person inserted into
// list 0 by the foundation's devnet issuer, and one registration in `freelance/seller`, then the
// same registration again, refused.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts
//
// <dir> holds the throwaway devnet keypairs, as `solana-keygen` writes them: deploy (only to fund
// the payer, once), payer, treasury, issuer, test-dollar-mint, test-dollar-authority, buyer,
// seller. They are read, never printed and never written anywhere. Everything public (addresses,
// signatures, what each did) goes into devnet/devnet.json (FOREST_DEVNET_RECORD overrides the path;
// FOREST_DEVNET_RPC the endpoint, for a rehearsal on a local validator). Each step checks the chain
// first and is skipped if it is done, so the script can be run again after a failure.
//
// The person is the keys recipe's pinned test seed (`keys/test/vectors.json`): profile 0, its wallet
// and its DID, and the identity secret, all derived here through `keys/` itself. The list's members
// are read back from the chain the way a phone would (`fetchListLeaves`), the proof is made with the
// pinned ceremony files, a payer key pays the network fee and the code account's rent, and profile
// 0's wallet signs and pays the 0.25 in the test dollar.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'

import { didGenesis, humanIdentity, identitySecret, profileKeys } from '../../../keys/src/index.ts'
import {
  REGISTER_COMPUTE_UNITS,
  USDC_FEE,
  USDC_MINT_DEVNET,
  addTokenIx,
  buildRegistration,
  codeTreeAddress,
  configAddress,
  decodeConfig,
  decodeIdentityList,
  decodeRegisteredEvents,
  feeFor,
  fetchListLeaves,
  initIx,
  insertIdentityIx,
  listAddress,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** A badge scope as `market/role`, the recommended shape: this profile sells in `freelance`. */
const MARKET = 'freelance/seller'
/** The test dollar's fee: 0.25 at its six decimals, set once by the treasury at `add_token`. */
const TEST_DOLLAR_FEE = 250_000n

const keysDir = process.env.FOREST_DEVNET_KEYS
if (!keysDir) throw new Error('set FOREST_DEVNET_KEYS to the directory holding the devnet keypairs')
const recordPath = resolve(process.env.FOREST_DEVNET_RECORD ?? join(here, '../../../devnet/devnet.json'))
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
const rpc = process.env.FOREST_DEVNET_RPC ?? record.rpc
const connection = new Connection(rpc, 'confirmed')
const programId = new PublicKey(record.registry.programId)

function key(name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir!, `${name}.json`), 'utf8'))))
}
const deployKey = key('deploy')
const payer = key('payer')
const treasury = key('treasury')
const issuer = key('issuer')
const mint = key('test-dollar-mint')
const mintAuthority = key('test-dollar-authority')
for (const [name, k] of [['deploy', deployKey], ['payer', payer], ['treasury', treasury], ['foundationIssuer', issuer], ['testDollarAuthority', mintAuthority]] as const) {
  if (k.publicKey.toBase58() !== record.keys[name]) throw new Error(`the ${name} key is not the one the record names`)
}
if (mint.publicKey.toBase58() !== record.testDollar.mint) throw new Error('the test dollar key is not the one the record names')

function save(): void {
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}

function note(what: string, signature: string): void {
  record.transactions ??= []
  record.transactions.push({ program: 'registry', what, signature })
  save()
  console.log(`  ${signature}  ${what}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls rather than subscribing: nothing here needs a websocket. Returns the error, if it failed.
 * A rate limit while polling is waited out, not thrown: the transaction is already sent, and
 * throwing would lose its signature from the record. */
async function settle(signature: string): Promise<unknown> {
  for (let i = 0; i < 240; i++) {
    let value
    try {
      ;({ value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
    } catch (e) {
      if (!String(e).includes('429')) throw e
      await sleep(5_000)
      continue
    }
    const status = value[0]
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return status.err
    await sleep(500)
  }
  throw new Error(`${signature} was never confirmed`)
}

async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  const err = await settle(signature)
  if (err) throw new Error(`${signature} failed: ${JSON.stringify(err)}`)
  return signature
}

async function logsOf(signature: string): Promise<string[]> {
  for (let i = 0; i < 20; i++) {
    const tx = await connection
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .catch((e) => (String(e).includes('429') ? null : Promise.reject(e)))
    if (tx?.meta?.logMessages) return tx.meta.logMessages
    await sleep(3_000)
  }
  throw new Error(`no log for ${signature}`)
}

async function exists(address: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(address)) !== null
}

async function tokens(address: PublicKey): Promise<bigint> {
  return (await getAccount(connection, address)).amount
}

// ---------------------------------------------------------------------------------------------

console.log(`registry ${programId.toBase58()} on ${rpc}`)
const config = configAddress(programId)
record.registry.config = config.toBase58()
record.registry.list0 = listAddress(0, programId).toBase58()
record.registry.codeTree = codeTreeAddress(programId).toBase58()
record.registry.usdcMint = USDC_MINT_DEVNET.toBase58()
save()

// The payer plays the fee payer: every network fee and every rent after the deploy. It starts with
// nothing; the deploy key sends it 0.2 SOL once.
if ((await connection.getBalance(payer.publicKey)) < 0.05 * LAMPORTS_PER_SOL) {
  const sig = await send([SystemProgram.transfer({ fromPubkey: deployKey.publicKey, toPubkey: payer.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })], [deployKey])
  note('0.2 SOL from the deploy key to the payer, which pays every network fee and rent from here on', sig)
}

// A little SOL for the two keys a sweep pays: the treasury (config and code tree) and list 0's
// owner (list 0). The runtime refuses to credit an empty account less than its own rent.
for (const [name, who] of [['treasury', treasury.publicKey], ['foundation issuer', issuer.publicKey]] as const) {
  if ((await connection.getBalance(who)) < 0.005 * LAMPORTS_PER_SOL) {
    const sig = await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: who, lamports: 0.01 * LAMPORTS_PER_SOL })], [payer])
    note(`0.01 SOL from the payer to the ${name}, so a rent sweep can land there`, sig)
  }
}

// init: anyone sends it, and it writes only constants: this build's treasury, devnet USDC at 0.25,
// and list 0 owned by this build's foundation issuer key.
if (!(await exists(config))) {
  const sig = await send([initIx({ payer: payer.publicKey, usdcMint: USDC_MINT_DEVNET, programId })], [payer])
  note('init: the config (treasury, devnet USDC at 0.25), list 0 owned by the foundation issuer, the code tree', sig)
}
let cfg = decodeConfig(new Uint8Array((await connection.getAccountInfo(config))!.data))
if (!cfg.treasury.equals(treasury.publicKey)) throw new Error('the config names another treasury')
if (!cfg.mints[0].equals(USDC_MINT_DEVNET) || cfg.fees[0] !== USDC_FEE) throw new Error('mints[0] is not devnet USDC at 0.25')
const list0 = decodeIdentityList(new Uint8Array((await connection.getAccountInfo(listAddress(0, programId)))!.data))
if (!list0.owner.equals(issuer.publicKey)) throw new Error("list 0's owner is not the devnet foundation issuer")

// The test dollar: a classic SPL Token mint with six decimals whose mint authority is a throwaway
// key. Devnet USDC was not used: Circle's faucet sits behind a captcha.
if (!(await exists(mint.publicKey))) {
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
  const sig = await send(
    [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, mintAuthority.publicKey, null),
    ],
    [payer, mint],
  )
  note('the test dollar: a classic SPL Token mint, 6 decimals, a throwaway mint authority', sig)
}
record.testDollar.authority = mintAuthority.publicKey.toBase58()
record.testDollar.fee = TEST_DOLLAR_FEE.toString()
save()

if (feeFor(cfg, mint.publicKey) === null) {
  const sig = await send([addTokenIx({ treasury: treasury.publicKey, mint: mint.publicKey, fee: TEST_DOLLAR_FEE, programId })], [payer, treasury])
  note('add_token: the treasury accepts the test dollar at 250,000 base units (0.25)', sig)
  cfg = decodeConfig(new Uint8Array((await connection.getAccountInfo(config))!.data))
}
if (feeFor(cfg, mint.publicKey) !== TEST_DOLLAR_FEE) throw new Error('the test dollar is not accepted at 0.25')

// The person: profile 0 of the keys recipe's pinned test seed.
const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(vectors.seed, 'hex')
const profile = await profileKeys(seed, 0)
const wallet = Keypair.fromSeed(profile.wallet.privateKey)
const { did } = await didGenesis(profile, { handle: vectors.handle, pds: vectors.pds })
const human = await humanIdentity(seed)
const secret = await identitySecret(seed)
if (wallet.publicKey.toBase58() !== vectors.profiles[0].wallet || did !== vectors.profiles[0].did || human.commitment.toString() !== vectors.identity.commitment) {
  throw new Error('the keys library no longer gives the pinned vectors')
}

// Token accounts: the treasury's (where fees land), profile 0's wallet's, and the two parties'
// for the deals. Then 1.00 to the profile and 10.00 to the buyer.
const buyer = new PublicKey(record.keys.buyer)
const seller = new PublicKey(record.keys.seller)
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner)
const holders = [treasury.publicKey, wallet.publicKey, buyer, seller]
if (!(await Promise.all(holders.map((h) => exists(ata(h))))).every(Boolean)) {
  const sig = await send(
    holders.map((h) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(h), h, mint.publicKey)),
    [payer],
  )
  note("token accounts for the test dollar: the treasury's, profile 0's wallet's, the buyer's and the seller's", sig)
}
record.tokenAccounts = {
  treasury: ata(treasury.publicKey).toBase58(),
  profile0: ata(wallet.publicKey).toBase58(),
  buyer: ata(buyer).toBase58(),
  seller: ata(seller).toBase58(),
}
save()
if ((await tokens(ata(wallet.publicKey))) < TEST_DOLLAR_FEE && !record.registration?.signature) {
  const sig = await send(
    [
      createMintToInstruction(mint.publicKey, ata(wallet.publicKey), mintAuthority.publicKey, 1_000_000),
      createMintToInstruction(mint.publicKey, ata(buyer), mintAuthority.publicKey, 10_000_000),
    ],
    [payer, mintAuthority],
  )
  note('test dollars minted: 1.00 to profile 0\'s wallet, 10.00 to the buyer', sig)
}

// The issuer inserts the person's commitment into list 0. The commitment is all it ever sees.
let read = await fetchListLeaves(connection, 0, { programId })
if (!read.leaves.includes(human.commitment)) {
  const sig = await send([insertIdentityIx({ issuer: issuer.publicKey, listIndex: 0, commitment: human.commitment, programId })], [payer, issuer])
  note("insert_identity: the foundation issuer adds profile 0's person to list 0 (the commitment only)", sig)
  read = await fetchListLeaves(connection, 0, { programId })
}

// The registration, the way a phone makes it: the members read from the chain, the Merkle path
// and the proof built here, the transaction signed by the profile's wallet and the payer.
const accounts = {
  payer: payer.publicKey,
  profileWallet: wallet.publicKey,
  feeAuthority: wallet.publicKey,
  feeTokens: ata(wallet.publicKey),
  treasuryTokens: ata(treasury.publicKey),
}
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
const started = Date.now()
const reg = await buildRegistration({
  secret,
  market: MARKET,
  did,
  listIndex: 0,
  leaves: read.leaves,
  artifacts,
  accounts,
  recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
  programId,
})
const provingMs = Date.now() - started

record.registration = {
  ...(record.registration ?? {}),
  market: MARKET,
  did,
  wallet: wallet.publicKey.toBase58(),
  commitment: human.commitment.toString(),
  listIndex: 0,
  membersRead: read.leaves.length,
  transactionsRead: read.transactionsRead,
  root: Buffer.from(toBytes32(reg.root)).toString('hex'),
  code: Buffer.from(reg.codeBytes).toString('hex'),
  codeAccount: reg.codeAccount.toBase58(),
}
save()

if (!(await exists(reg.codeAccount))) {
  const feeBefore = await tokens(ata(wallet.publicKey))
  const treasuryBefore = await tokens(ata(treasury.publicKey))
  reg.transaction.sign([payer, wallet])
  const signature = await connection.sendRawTransaction(reg.transaction.serialize())
  const err = await settle(signature)
  if (err) throw new Error(`the registration failed: ${JSON.stringify(err)}\n${(await logsOf(signature)).join('\n')}`)
  const [event] = decodeRegisteredEvents(await logsOf(signature), programId)
  if (!event || event.market !== MARKET || event.did !== did || !event.wallet.equals(wallet.publicKey) || !event.listOwner.equals(issuer.publicKey)) {
    throw new Error('the Registered entry is not what was sent')
  }
  if ((await tokens(ata(wallet.publicKey))) !== feeBefore - TEST_DOLLAR_FEE) throw new Error('the profile did not pay exactly 0.25')
  if ((await tokens(ata(treasury.publicKey))) !== treasuryBefore + TEST_DOLLAR_FEE) throw new Error('the treasury did not receive exactly 0.25')
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  record.registration.signature = signature
  record.registration.provingMs = provingMs
  record.registration.computeUnits = tx?.meta?.computeUnitsConsumed ?? null
  record.registration.bytes = reg.transaction.serialize().length
  note(`register: profile 0 in "${MARKET}" on list 0; the payer paid the network fee and the code account's rent, the profile's wallet signed and paid 0.25 test dollars`, signature)
}

// The same registration again: same market, same person, same profile. It lands (sent without a
// preflight, so the refusal is on the chain with a signature) and fails, because the account at the
// code's address already exists.
if (!record.registration.refusedSignature) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: REGISTER_COMPUTE_UNITS }), reg.instruction],
  }).compileToV0Message()
  const again = new VersionedTransaction(message)
  again.sign([payer, wallet])
  const signature = await connection.sendRawTransaction(again.serialize(), { skipPreflight: true })
  const err = await settle(signature)
  if (!err) throw new Error('the second registration was accepted')
  const logs = await logsOf(signature)
  record.registration.refusedSignature = signature
  record.registration.refusedError = err
  record.registration.refusedLog = logs.filter((l) => /already in use|failed|Error/.test(l))
  note('register again, the same person in the same market: refused, the code account already exists (code used)', signature)
}

console.log('done')
// snarkjs leaves worker threads running; nothing else is pending.
process.exit(0)

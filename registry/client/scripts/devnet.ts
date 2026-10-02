// The registry on devnet, used for real: a relayer pays for one row, which the profile signs, for a
// person on a stand-in keeper's list; then the refusal of a second row for the same market stamp,
// and a refund.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts        (after registry/devnet/deploy.sh)
//
// <dir> holds payer.json, as registry/devnet/deploy.sh writes it: the relayer, which pays every
// fee and every deposit. It is read, never printed and never written anywhere. Everything public
// (addresses, signatures, what each did) goes into registry/devnet/devnet.json
// (FOREST_DEVNET_RECORD overrides the path; FOREST_DEVNET_RPC the endpoint). Each step checks the
// chain first and is skipped if it is done, so the script can be run again after a failure.
//
// The person is the keys recipe's pinned test seed (`keys/test/vectors.json`): their secret for
// the keeper's list comes from it through `keys/` itself. The keeper, its list and the profiles are
// stand-ins this script makes, each key from a fixed text, and are recorded as such: no keeper
// publishes a list yet, and the registry does not care how a profile key was made.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'

import { listIdentity, listSecret } from '../../../keys/src/index.ts'
import {
  buildRegistration,
  fetchRow,
  fetchRows,
  keeperSigned,
  listRoot,
  marketStampOf,
  refundIx,
  rootBytes,
  rowAddress,
  rowSpace,
  stampOf,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** A label as `market/role`, the recommended shape: this profile sells in `freelance`. */
const LABEL = 'freelance/seller'

const keysDir = process.env.FOREST_DEVNET_KEYS
if (!keysDir) throw new Error('set FOREST_DEVNET_KEYS to the directory holding the devnet keypairs')
const recordPath = resolve(process.env.FOREST_DEVNET_RECORD ?? join(here, '../../devnet/devnet.json'))
const record = JSON.parse(readFileSync(recordPath, 'utf8'))
const rpc = process.env.FOREST_DEVNET_RPC ?? record.rpc
const connection = new Connection(rpc, 'confirmed')
const programId = new PublicKey(record.registry.programId)
const base = JSON.parse(readFileSync(join(here, '../../../devnet/devnet.json'), 'utf8'))

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir, 'payer.json'), 'utf8'))))
if (payer.publicKey.toBase58() !== base.keys.payer) throw new Error('the payer key is not the one devnet/devnet.json names')

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A stand-in key: its private seed is sha256 of this text. Public on purpose; devnet only. */
const standInSeed = (name: string) => sha256(new TextEncoder().encode(`forest devnet stand-in: ${name}`))
const standIn = (name: string) => Keypair.fromSeed(standInSeed(name))

function save(): void {
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}

function note(what: string, signature: string): void {
  record.transactions ??= []
  record.transactions.push({ what, signature })
  save()
  console.log(`  ${signature}  ${what}`)
}

/** Polls rather than subscribing. A rate limit while polling is waited out, not thrown: the
 * transaction is already sent, and throwing would lose its signature from the record. */
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

async function meta(signature: string) {
  for (let i = 0; i < 20; i++) {
    const tx = await connection
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .catch((e) => (String(e).includes('429') ? null : Promise.reject(e)))
    if (tx?.meta) return tx.meta
    await sleep(3_000)
  }
  throw new Error(`no transaction for ${signature}`)
}

async function sendVersioned(tx: VersionedTransaction, signers: Keypair[], skipPreflight = false): Promise<{ signature: string; err: unknown }> {
  tx.sign(signers)
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  return { signature, err: await settle(signature) }
}

async function sendLegacy(tx: Transaction): Promise<{ signature: string; err: unknown }> {
  tx.feePayer = payer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(payer)
  const signature = await connection.sendRawTransaction(tx.serialize())
  return { signature, err: await settle(signature) }
}

const blockhash = async () => (await connection.getLatestBlockhash('confirmed')).blockhash

// ---------------------------------------------------------------------------------------------

console.log(`registry ${programId.toBase58()} on ${rpc}`)

// The person: the keys recipe's pinned test seed, and their secret for the stand-in keeper's list.
const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(vectors.seed, 'hex')
const keeper = standIn('keeper')
const secret = await listSecret(seed, keeper.publicKey.toBase58())
const { stamp } = await listIdentity(seed, keeper.publicKey.toBase58())
if (stampOf(secret) !== stamp) throw new Error('keys/ and the client disagree on the stamp')

// The keeper's list: strangers' stamps around the person's, and the keeper's signature on its root.
const stranger = (n: number) => stampOf(Buffer.from(`forest devnet stand-in keeper: member ${n}`))
const stamps = [stranger(1), stranger(2), stamp, stranger(3), stranger(4)]
const root = listRoot(stamps)
const keeperSignature = ed25519.sign(rootBytes(root), standInSeed('keeper'))

// Two profiles the person holds: the row's, and a second one the registry refuses on this list.
const profile = standIn(`profile ${LABEL}`)
const second = standIn(`second profile ${LABEL}`)
const marketStamp = marketStampOf(secret, LABEL)
const address = rowAddress(marketStamp, programId)
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
record.row = {
  ...(record.row ?? {}),
  what: "one row: the keys recipe's test seed, on a stand-in keeper's list, under freelance/seller, for a stand-in profile; the profile signs, a relayer (the payer) pays",
  label: LABEL,
  profile: profile.publicKey.toBase58(),
  keeper: keeper.publicKey.toBase58(),
  list: { standIn: true, stamps: stamps.map(String), root: hex(toBytes32(root)), keeperSignature: hex(keeperSignature) },
  marketStamp: hex(toBytes32(marketStamp)),
  address: address.toBase58(),
  standInKeys: "each stand-in key's private seed is sha256 of `forest devnet stand-in: <name>`, the names `keeper`, `profile freelance/seller` and `second profile freelance/seller`",
}
save()

const build = async (who: Keypair) =>
  buildRegistration({
    secret,
    label: LABEL,
    profile: who.publicKey,
    keeper: keeper.publicKey,
    stamps,
    keeperSignature,
    artifacts,
    payer: payer.publicKey,
    recentBlockhash: await blockhash(),
    programId,
  })

// register: the profile signs, the relayer pays.
if (!(await fetchRow(connection, marketStamp, { programId }))) {
  const started = Date.now()
  const reg = await build(profile)
  const provingMs = Date.now() - started
  const bytes = reg.transaction.serialize().length
  const { signature, err } = await sendVersioned(reg.transaction, [payer, profile])
  if (err) throw new Error(`register failed: ${JSON.stringify(err)}`)
  const m = await meta(signature)
  record.row.register = { signature, provingMs, bytes, computeUnits: m.computeUnitsConsumed ?? null, fee: m.fee }
  note(`register: a row under "${LABEL}", the profile signing, the relayer paying`, signature)
}
const written = (await connection.getAccountInfo(address, 'confirmed'))!.data

// Refused on chain, sent without a preflight so the refusal has a signature: the same person, list
// and label for their second profile. The same market stamp, so the row already exists.
if (!record.row.refused) {
  const again = await build(second)
  if (!again.row.equals(address)) throw new Error('the second profile has another market stamp')
  const sent = await sendVersioned(again.transaction, [payer, second], true)
  if (!sent.err) throw new Error('a second row for the market stamp landed')
  const logs = ((await meta(sent.signature)).logMessages ?? []).filter((l) => /already in use|Error Code|failed/.test(l))
  record.row.refused = { secondProfile: second.publicKey.toBase58(), signature: sent.signature, err: sent.err, log: logs }
  note("register again for the same market stamp, for the person's second profile: refused, the row already exists", sent.signature)
}

// Refund: 0.001 SOL sent to the row, then refund, which anyone may send, pays exactly that back to
// the payer the row records.
if (!record.row.refund) {
  const gift = await sendLegacy(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: address, lamports: 1_000_000 })))
  if (gift.err) throw new Error(`the gift failed: ${JSON.stringify(gift.err)}`)
  note('0.001 SOL sent to the row, above its minimum', gift.signature)
  const before = await connection.getBalance(address, 'confirmed')
  const refund = await sendLegacy(new Transaction().add(refundIx({ row: address, payer: payer.publicKey, programId })))
  if (refund.err) throw new Error(`refund failed: ${JSON.stringify(refund.err)}`)
  const m = await meta(refund.signature)
  const after = await connection.getBalance(address, 'confirmed')
  if (before - after !== 1_000_000) throw new Error(`refund moved ${before - after}, not the gift`)
  record.row.refund = { gift: gift.signature, signature: refund.signature, lamports: before - after, computeUnits: m.computeUnitsConsumed ?? null }
  note('refund: exactly the 0.001 SOL above the minimum, back to the payer the row records', refund.signature)
}

// Read back the way any reader would: every row of this profile, and the keeper's signature.
const read = await fetchRows(connection, { profile: profile.publicKey, programId }).catch((e) => {
  console.log(`  getProgramAccounts refused by this RPC (${String(e).slice(0, 80)}); read the one row directly`)
  return null
})
const final = await fetchRow(connection, marketStamp, { programId })
if (!final) throw new Error('the row is gone')
const account = (await connection.getAccountInfo(address, 'confirmed'))!
if (!account.data.equals(written) || account.data.length !== rowSpace(Buffer.byteLength(LABEL))) throw new Error('the row changed')
if (!keeperSigned(final)) throw new Error("the keeper's signature does not check")
record.row.onChain = {
  readBy: read ? 'getProgramAccounts, filtered by profile' : "getAccountInfo at the market stamp's address",
  rowsOfThisProfile: read?.length ?? null,
  profile: final.profile.toBase58(),
  keeper: final.keeper.toBase58(),
  payer: final.payer.toBase58(),
  label: final.label,
  root: hex(final.root),
  keeperSigned: true,
  bytes: account.data.length,
  lamports: account.lamports,
}
save()
if (hex(final.root) !== record.row.list.root || !final.profile.equals(profile.publicKey) || !final.payer.equals(payer.publicKey)) {
  throw new Error('the row is not what was sent')
}
console.log('done')
// snarkjs leaves worker threads running; nothing else is pending.
process.exit(0)

// The registry on devnet, used for real: a relayer writes one line for profile 0 of the keys
// recipe's test seed, backed by two issuers' lists, then shows what the program refuses and what a
// refund does.
//
//   FOREST_DEVNET_KEYS=<dir> node scripts/devnet.ts        (after registry/devnet/deploy.sh)
//
// <dir> holds payer.json, as registry/devnet/deploy.sh writes it: the relayer, which pays every
// fee and every deposit. It is read, never printed and never written anywhere. Everything public
// (addresses, signatures, what each did) goes into registry/devnet/devnet.json
// (FOREST_DEVNET_RECORD overrides the path; FOREST_DEVNET_RPC the endpoint). Each step checks the
// chain first and is skipped if it is done, so the script can be run again after a failure.
//
// The person is the keys recipe's pinned test seed (`keys/test/vectors.json`): profile 0's key and
// the identity secret, both derived here through `keys/` itself. The profile key signs nothing. The
// two issuers' lists are stand-ins this script makes (strangers' commitments around the person's),
// because issuers publish their lists outside the registry and no issuer publishes one yet; they are
// recorded as such.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Identity } from '@semaphore-protocol/identity'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'

import { humanIdentity, identitySecret, profileKey } from '../../../keys/src/index.ts'
import {
  addProofIx,
  buildAddProof,
  buildRegistration,
  codeFor,
  commitmentOf,
  fetchLine,
  fetchLines,
  lineAddress,
  listRoot,
  refundIx,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** A badge label as `market/role`, the recommended shape: this profile sells in `freelance`. */
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

async function sendVersioned(tx: VersionedTransaction, skipPreflight = false): Promise<{ signature: string; err: unknown }> {
  tx.sign([payer])
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  return { signature, err: await settle(signature) }
}

async function sendLegacy(tx: Transaction, skipPreflight = false): Promise<{ signature: string; err: unknown }> {
  tx.feePayer = payer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(payer)
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  return { signature, err: await settle(signature) }
}

const blockhash = async () => (await connection.getLatestBlockhash('confirmed')).blockhash

// ---------------------------------------------------------------------------------------------

console.log(`registry ${programId.toBase58()} on ${rpc}`)

// The person: profile 0 of the keys recipe's pinned test seed.
const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(vectors.seed, 'hex')
const profile = new PublicKey((await profileKey(seed, 0)).publicKey)
const secret = await identitySecret(seed)
const human = await humanIdentity(seed)
if (profile.toBase58() !== vectors.profiles[0].wallet || human.commitment.toString() !== vectors.identity.commitment) {
  throw new Error('the keys library no longer gives the pinned vectors')
}
const mine = commitmentOf(secret)

// Two issuers' lists, stand-ins: strangers' commitments around the person's.
const stranger = (issuer: string, n: number) => commitmentOf(new Identity(Buffer.from(`forest devnet stand-in issuer ${issuer}: member ${n}`)))
const lists = {
  A: [stranger('A', 1), stranger('A', 2), mine, stranger('A', 3), stranger('A', 4)],
  B: [stranger('B', 1), mine, stranger('B', 2)],
}
const code = codeFor(secret, LABEL)
const address = lineAddress(code, programId)
const artifacts = {
  wasm: join(here, '../../artifacts/semaphore-32.wasm'),
  zkey: join(here, '../../artifacts/semaphore-32.zkey'),
}
record.line = {
  ...(record.line ?? {}),
  what: "profile 0 of the keys recipe's test seed, one verified human under freelance/seller, backed by two stand-in issuers' lists; a relayer (the payer) sends everything, the profile key signs nothing",
  label: LABEL,
  profile: profile.toBase58(),
  code: hex(toBytes32(code)),
  address: address.toBase58(),
  lists: Object.fromEntries(
    Object.entries(lists).map(([name, l]) => [name, { standIn: true, commitments: l.map(String), root: hex(toBytes32(listRoot(l))) }]),
  ),
}
save()

// register, with list A's proof.
let line = await fetchLine(connection, code, { programId })
if (!line) {
  const started = Date.now()
  const reg = await buildRegistration({ secret, label: LABEL, profile, lists: [lists.A], artifacts, payer: payer.publicKey, recentBlockhash: await blockhash(), programId })
  const provingMs = Date.now() - started
  const bytes = reg.transactions[0].serialize().length
  const { signature, err } = await sendVersioned(reg.transactions[0])
  if (err) throw new Error(`register failed: ${JSON.stringify(err)}`)
  const m = await meta(signature)
  record.line.register = { signature, provingMs, bytes, computeUnits: m.computeUnitsConsumed ?? null, fee: m.fee }
  note(`register: profile 0 under "${LABEL}", list A's proof, the relayer paying; the profile key signed nothing`, signature)
  line = await fetchLine(connection, code, { programId })
}

// add_proof, with list B's proof.
const rootB = toBytes32(listRoot(lists.B))
if (!line!.roots.some((r) => hex(r) === hex(rootB))) {
  const add = await buildAddProof({ secret, label: LABEL, profile, commitments: lists.B, artifacts, payer: payer.publicKey, recentBlockhash: await blockhash(), programId })
  const bytes = add.transaction.serialize().length
  const { signature, err } = await sendVersioned(add.transaction)
  if (err) throw new Error(`add_proof failed: ${JSON.stringify(err)}`)
  const m = await meta(signature)
  record.line.addProof = { signature, bytes, computeUnits: m.computeUnitsConsumed ?? null, fee: m.fee }
  note('add_proof: list B\'s proof appended to the same line, the relayer paying the 32 new bytes', signature)
  line = await fetchLine(connection, code, { programId })
}

// Refused on chain, sent without a preflight so each refusal has a signature: a second register for
// the same code (list B's proof this time), and list B's proof replayed into the line.
if (!record.line.refused) {
  const again = await buildRegistration({ secret, label: LABEL, profile, lists: [lists.B], artifacts, payer: payer.publicKey, recentBlockhash: await blockhash(), programId })
  const second = await sendVersioned(again.transactions[0], true)
  if (!second.err) throw new Error('a second register for the code landed')
  const replay = await sendLegacy(new Transaction().add(addProofIx({ code, proof: again.proofs[0], payer: payer.publicKey, programId })), true)
  if (!replay.err) throw new Error('a replayed root landed')
  const logs = async (s: string) => ((await meta(s)).logMessages ?? []).filter((l) => /already in use|Error Code|failed/.test(l))
  record.line.refused = {
    secondRegister: { signature: second.signature, err: second.err, log: await logs(second.signature) },
    replayedRoot: { signature: replay.signature, err: replay.err, log: await logs(replay.signature) },
  }
  note('register again for the same code: refused, the line already exists', second.signature)
  note("add_proof with list B's proof again: refused, the root is already in the line", replay.signature)
}

// Refund: 0.001 SOL sent to the line, then refund, which anyone may send, pays exactly that back
// to the payer the line records. Devnet charges today's rate, so nothing else is above the minimum.
if (!record.line.refund) {
  const gift = await sendLegacy(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: address, lamports: 1_000_000 })))
  if (gift.err) throw new Error(`the gift failed: ${JSON.stringify(gift.err)}`)
  note('0.001 SOL sent to the line, above its minimum', gift.signature)
  const lineBefore = await connection.getBalance(address, 'confirmed')
  const refund = await sendLegacy(new Transaction().add(refundIx({ code, payer: payer.publicKey, programId })))
  if (refund.err) throw new Error(`refund failed: ${JSON.stringify(refund.err)}`)
  const m = await meta(refund.signature)
  const lineAfter = await connection.getBalance(address, 'confirmed')
  if (lineBefore - lineAfter !== 1_000_000) throw new Error(`refund moved ${lineBefore - lineAfter}, not the gift`)
  record.line.refund = { gift: gift.signature, signature: refund.signature, lamports: lineBefore - lineAfter, computeUnits: m.computeUnitsConsumed ?? null }
  note('refund: exactly the 0.001 SOL above the minimum, back to the payer the line records', refund.signature)
}

// Read back the way any reader would: every line of this profile.
const read = await fetchLines(connection, { profile, programId }).catch((e) => {
  console.log(`  getProgramAccounts refused by this RPC (${String(e).slice(0, 80)}); read the one line directly`)
  return null
})
const final = await fetchLine(connection, code, { programId })
if (!final) throw new Error('the line is gone')
record.line.onChain = {
  readBy: read ? 'getProgramAccounts, filtered by profile' : 'getAccountInfo at the code\'s address',
  linesOfThisProfile: read?.length ?? null,
  profile: final.profile.toBase58(),
  payer: final.payer.toBase58(),
  time: Number(final.time),
  label: final.label,
  roots: final.roots.map(hex),
  lamports: await connection.getBalance(address, 'confirmed'),
}
save()
if (final.roots.length !== 2 || final.profile.toBase58() !== profile.toBase58() || !final.payer.equals(payer.publicKey)) {
  throw new Error('the line is not what was sent')
}
console.log('done')
// snarkjs leaves worker threads running; nothing else is pending.
process.exit(0)

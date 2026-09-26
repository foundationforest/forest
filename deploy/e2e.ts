// The loop, on the public URLs in deploy/services.json: verify, register, post, get found, get
// paid, get reviewed. Three profiles of two public test seeds (keys/test/), and one real person's
// face check:
//
//   1. the 2026-09-25 proof's profile (seed 2, profile 0) on markets v1: its record rewritten to
//      name `tutoring/seller`, so the badge it already holds counts; seen on the index
//   2. the seller (seed 3, profile 0): its DID sent to plc.directory, its profile in
//      `tutoring/seller` and one offer with a price, written through the host; seen on the index
//   3. the seller's face check: Didit's, on the issuer's workflow, done by a person on a phone; the
//      script submits the session with seed 3's commitment until the issuer accepts it, then waits
//      for the issuer's batch to put it on list 0
//   4. the seller's badge in `tutoring/seller`, proved here, paid in test dollars through the public
//      fee payer (Kora); counted on its profile page
//   5. the buyer (seed 2, profile 1, already on list 0 as seed 2): its DID, a `tutoring/buyer`
//      profile, and that badge through the fee payer; counted on its profile page
//   6. the deal: the seller invoices the buyer for one hour of the offer, through the fee payer;
//      the buyer checks the invoice, then pays and releases it in one transaction, through the fee
//      payer; the receipt read on chain and on the index's deal page
//   7. reviews both ways on the deal, rated overall and on the market's other rating, each written
//      to its author's folder through the host; the index shows them, a rating and a standing on
//      both profiles, and the deal as agreed by both sides
//   8. every DID document names the host's public URL
//
// Needs: `npm ci` in keys/, shapes/, registry/client, registry/artifacts (then `npm run fetch`),
// escrow/client and deploy/; host/build.sh run (for host/test/device.ts); devnet/keys.sh run (the
// deploy key and the test-dollar authority mint test dollars to a wallet that is short); and, the
// first time, a face check: FACE_CHECK_SESSION names a Didit session the issuer opened, or the
// script opens one and prints its page. The session id is never written down.
//
// Each step checks the host, the issuer or the chain first and sends only what is missing, so a
// second run sends nothing new. Every URL, signature and charge, and how long each step took when
// it sent something, goes into deploy/services.json under `loop`.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'

import { assertOptionsAgreed, decodeEscrow, escrowAddress, invoice, makeDepositAddressIx, payInvoiceInOneTap, termsFor } from '../escrow/client/src/index.ts'
import { didGenesis, submitGenesis } from '../keys/src/index.ts'
import {
  buildRegistration,
  codeFor,
  decodeIdentityInsertedEvents,
  fetchListLeaves,
  fromBytes32,
  listAddress,
  usedCodeAddress,
} from '../registry/client/src/index.ts'
import { validateRecord } from '../shapes/src/validate.js'
import { Device, query, XrpcError, type Write } from '../host/test/device.ts'

import { DEVNET, b64, confirm, connection, devnetKey, redactRpc, rpcName, send, sleep } from './lib/chain.ts'
import { SEED2, SEED3, person, type Person } from './lib/person.ts'
import { readRecord, updateRecord } from './lib/record.ts'

const MARKET = 'tutoring'
const PLC = 'https://plc.directory'
const MARKETS_URL = 'https://raw.githubusercontent.com/foundationforest/markets/main'
/** How long a person has to do the face check before the script gives up. */
const FACE_CHECK_MINUTES = 60
/** The deal's escrow id: fixed, so a second run finds the same escrow at the same address. */
const DEAL_ID = BigInt('0x' + createHash('sha256').update('forest.foundation/test/loop/v1').digest('hex').slice(0, 16))
/** What each send costs a wallet at most, in test-dollar base units, for topping it up. */
const BUDGET = {
  registration: 1_000_000n, // the 0.25 and Kora's charge (0.71 on 2026-09-25)
  invoice: 4_000_000n, // Kora fronts the escrow's and its deposit address's storage (3.48) and the fee
  payFee: 100_000n, // Kora's charge for the one tap: the network fee
}
const artifacts = {
  wasm: join(import.meta.dirname, '../registry/artifacts/semaphore-32.wasm'),
  zkey: join(import.meta.dirname, '../registry/artifacts/semaphore-32.zkey'),
}

const svc = readRecord().railway.services
const url = { host: svc.host.url, index: svc.index.url, issuer: svc.issuer.url, feepayer: svc.feepayer.url }
const hostname = new URL(url.host).host
const loop = (patch: Record<string, unknown>) => updateRecord({ loop: patch })
const profilePage = (did: string) => `${url.index}/profiles/${did}`
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(DEVNET.testDollar, owner, true)

// ---- steps and their times -----------------------------------------------------------------------

const steps: { key: string; started: number; sent: boolean }[] = []
function step(key: string, text: string) {
  finishStep()
  steps.push({ key, started: Date.now(), sent: false })
  console.log(`\n${steps.length}. ${text}`)
}
let anySent = false
/** The current step sent something: its time is worth keeping. */
const sent = () => (anySent = steps[steps.length - 1].sent = true)
function finishStep() {
  const s = steps[steps.length - 1]
  if (!s) return
  const seconds = Math.round((Date.now() - s.started) / 1000)
  console.log(`   (${seconds} s${s.sent ? '' : ', nothing sent'})`)
  if (s.sent) loop({ seconds: { [s.key]: seconds } })
}

// ---- reading -------------------------------------------------------------------------------------

async function getJson(u: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(u, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body }
}

/** Polls `check` until it returns something, or gives up after `seconds`. */
async function until<T>(what: string, seconds: number, check: () => Promise<T | undefined | null | false>, everyMs = 5000): Promise<T> {
  const end = Date.now() + seconds * 1000
  for (let i = 0; Date.now() < end; i++) {
    const got = await check()
    if (got) return got
    if (i % Math.max(1, Math.round(30_000 / everyMs)) === 0) console.log(`   waiting: ${what}`)
    await sleep(everyMs)
  }
  throw new Error(`gave up after ${seconds} s: ${what}`)
}

/** The profile page's twin, once `ready` says it shows what is expected. */
const onIndex = (what: string, did: string, ready: (body: any) => unknown, seconds = 600) =>
  until(what, seconds, async () => {
    const { status, body } = await getJson(`${profilePage(did)}.json`)
    return status === 200 && ready(body) ? body : null
  })

/** A market file, found where the markets repo's directory says it is. */
async function marketFile(name: string) {
  const directory = await (await fetch(`${MARKETS_URL}/directory.md`)).text()
  const path = directory.match(new RegExp(`\\[\`${name}\`\\]\\(([a-z0-9-]+/${name}\\.json)\\)`))?.[1]
  if (!path) throw new Error(`the markets directory lists no ${name}`)
  return { path, file: await (await fetch(`${MARKETS_URL}/${path}`)).json() }
}

// ---- the host ------------------------------------------------------------------------------------

let hostDid = ''

async function hasFolder(did: string): Promise<boolean> {
  try {
    await query(url.host, 'com.atproto.repo.describeRepo', { repo: did })
    return true
  } catch (err) {
    if (err instanceof XrpcError && err.status === 400) return false
    throw err
  }
}

async function listed(did: string, collection: string): Promise<{ uri: string; cid: string; value: any }[]> {
  if (!(await hasFolder(did))) return []
  return (await query(url.host, 'com.atproto.repo.listRecords', { repo: did, collection, limit: '100' })).records
}

/** The DID, made here from the profile's keys and naming the public host; sent once. */
async function ensureDid(p: Person): Promise<string> {
  const genesis = await didGenesis(p.keys, { handle: p.handle(hostname), pds: url.host })
  const res = await fetch(`${PLC}/${genesis.did}`)
  if (res.status === 404) {
    await submitGenesis(genesis, PLC)
    sent()
    console.log(`   DID sent to ${PLC}: ${genesis.did}`)
  } else if (res.ok) {
    console.log(`   DID already in ${PLC}: ${genesis.did}`)
  } else {
    throw new Error(`${PLC} answered ${res.status} for ${genesis.did}`)
  }
  return genesis.did
}

/** Records compared field by field, whatever order their keys came back in. */
const canonical = (v: any): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)

/**
 * The profile as `profile` says (created, or rewritten when any field but its date differs) and,
 * when there is none yet, `post`; each checked against the market first, written through the host,
 * signed here.
 */
async function ensureFolder(p: Person, did: string, market: any, profile: Record<string, unknown>, post?: Record<string, unknown>) {
  for (const [record, m] of [[profile, market], ...(post ? [[post, market]] : [])] as const) {
    const checked = validateRecord(record, { market: m })
    if (!checked.ok) throw new Error(`${record.$type} does not validate: ${checked.errors.join('; ')}`)
  }
  const writes: Write[] = []
  const stored = (await listed(did, 'foundation.forest.profile'))[0]
  if (!stored) {
    writes.push({ $type: 'com.atproto.repo.applyWrites#create', collection: 'foundation.forest.profile', rkey: 'self', value: profile })
  } else if (canonical({ ...stored.value, createdAt: null }) !== canonical({ ...profile, createdAt: null })) {
    writes.push({ $type: 'com.atproto.repo.applyWrites#update', collection: 'foundation.forest.profile', rkey: 'self', value: { ...profile, createdAt: stored.value.createdAt } })
  }
  if (post && !(await listed(did, 'foundation.forest.post')).length) {
    writes.push({ $type: 'com.atproto.repo.applyWrites#create', collection: 'foundation.forest.post', value: post })
  }
  let commit: string | undefined
  if (writes.length) {
    const device = new Device(did, p.keys, url.host, hostDid)
    const { submitted } = await device.write(writes)
    sent()
    commit = submitted.commit.cid
    console.log(`   ${writes.map((w) => w.$type.split('#')[1]).join(' and ')}: ${submitted.results.map((r) => r.uri).join(', ')} (commit ${commit})`)
  } else {
    console.log(post ? '   profile and post already as they should be' : '   profile already as it should be')
  }
  const posts = await listed(did, 'foundation.forest.post')
  return {
    profile: `at://${did}/foundation.forest.profile/self`,
    post: posts[0]?.uri ?? null,
    postValue: posts[0]?.value ?? null,
    folder: `${url.host}/xrpc/com.atproto.sync.getRepo?did=${did}`,
    ...(commit ? { commit } : {}),
  }
}

// ---- the fee payer -------------------------------------------------------------------------------

async function kora<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { body } = await getJson(url.feepayer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (body.error) throw new Error(`Kora ${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
  return body.result as T
}

let signer: PublicKey

/**
 * What a person's device does (feepayer/test's `throughKora`): build the transaction with the fee
 * payer as its payer, ask Kora what it costs in the test dollar, add one transfer of exactly that,
 * sign with the profile's wallet, and hand it to Kora, which checks it, co-signs and sends it.
 */
async function throughKora(ixs: TransactionInstruction[], p: Person) {
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const compile = (list: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: list }).compileToV0Message())
  const estimate = await kora<{ fee_in_lamports: number; fee_in_token: number }>('estimateTransactionFee', {
    transaction: b64(compile(ixs)),
    fee_token: DEVNET.testDollar.toBase58(),
    sig_verify: false,
  })
  const tx = compile([...ixs, createTransferInstruction(ata(p.wallet), ata(signer), p.wallet, BigInt(estimate.fee_in_token))])
  tx.sign([Keypair.fromSeed(p.keys.wallet.privateKey)])
  const { signature } = await kora<{ signature: string }>('signAndSendTransaction', { transaction: b64(tx) })
  await confirm(signature)
  sent()
  const landed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  return {
    signature,
    charge: `${estimate.fee_in_token} test-dollar base units (${estimate.fee_in_lamports} lamports at the mock price)`,
    bytes: tx.serialize().length,
    computeUnits: landed?.meta?.computeUnitsConsumed ?? null,
    networkFee: landed?.meta?.fee ?? null,
  }
}

/** Test dollars minted to the wallet, only when what it still has to pay is more than it holds. */
async function ensureDollars(p: Person, need: bigint, who: string) {
  const tokens = ata(p.wallet)
  const balance = await getAccount(connection, tokens).then((a) => a.amount, () => 0n)
  if (need === 0n || balance >= need) {
    console.log(`   ${who}'s wallet holds ${Number(balance) / 1e6} test dollars; needs ${Number(need) / 1e6} more at most: nothing minted`)
    return
  }
  const amount = ((need - balance + 999_999n) / 1_000_000n) * 1_000_000n
  const deploy = devnetKey('deploy')
  const authority = devnetKey('test-dollar-authority')
  const signature = await send(
    [
      createAssociatedTokenAccountIdempotentInstruction(deploy.publicKey, tokens, p.wallet, DEVNET.testDollar),
      createMintToInstruction(DEVNET.testDollar, tokens, authority.publicKey, amount),
    ],
    [deploy, authority],
  )
  sent()
  console.log(`   ${Number(amount) / 1e6} test dollars minted to ${who}'s wallet (it held ${Number(balance) / 1e6}): ${signature}`)
  loop({ [who]: { funding: { tokens: tokens.toBase58(), minted: amount.toString(), signature } } })
}

// ---- the registry --------------------------------------------------------------------------------

const registered = async (p: Person, scope: string) => Boolean(await connection.getAccountInfo(usedCodeAddress(codeFor(p.secret, scope), DEVNET.registry)))

/** The badge: proved here against list 0 as read from devnet, paid through the fee payer; once. */
async function ensureBadge(p: Person, did: string, scope: string, who: string) {
  const codeAccount = usedCodeAddress(codeFor(p.secret, scope), DEVNET.registry)
  if (await connection.getAccountInfo(codeAccount)) {
    console.log(`   ${scope} already registered: code account ${codeAccount.toBase58()}`)
    loop({ [who]: { badge: { scope, codeAccount: codeAccount.toBase58() } } })
    return
  }
  const leaves = await fetchListLeaves(connection, 0, { programId: DEVNET.registry })
  if (leaves.leaves.indexOf(p.commitment) < 0) throw new Error(`${who}'s commitment is not on list 0`)
  const started = Date.now()
  const reg = await buildRegistration({
    secret: p.secret,
    market: scope,
    did,
    listIndex: 0,
    leaves: leaves.leaves,
    artifacts,
    accounts: { payer: signer, profileWallet: p.wallet, feeAuthority: p.wallet, feeTokens: ata(p.wallet), treasuryTokens: ata(DEVNET.treasury) },
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    computeUnitLimit: null, // the fee payer allows no compute budget program
    programId: DEVNET.registry,
  })
  const provingSeconds = (Date.now() - started) / 1000
  const paid = await throughKora([reg.instruction], p)
  console.log(`   registered through Kora: ${paid.signature}; Kora charged ${paid.charge}; the proof took ${provingSeconds.toFixed(1)} s`)
  loop({
    [who]: {
      badge: {
        scope,
        registration: paid.signature,
        charge: paid.charge,
        bytes: paid.bytes,
        computeUnits: paid.computeUnits,
        networkFee: paid.networkFee,
        provingSeconds,
        code: Buffer.from(reg.codeBytes).toString('hex'),
        codeAccount: codeAccount.toBase58(),
        root: reg.root.toString(16).padStart(64, '0'),
      },
    },
  })
}

// ---- the issuer ----------------------------------------------------------------------------------

const issuer = (path: string, body: unknown) =>
  getJson(`${url.issuer}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Refusals that mean "not done yet": the check not started, under way, or not yet approved. */
const NOT_YET = new Set(['no_liveness', 'liveness_not_passed', 'not_approved'])

/**
 * The face check: the session submitted with the commitment until the issuer accepts it, then the
 * issuer's batch awaited until the commitment is on list 0. Returns how long each took.
 */
async function ensureListed(p: Person, who: string) {
  const commitment = p.commitment.toString()
  let status: string = (await issuer('/status', { commitment })).body.status
  console.log(`   the issuer has ${who}'s commitment as: ${status}`)
  const began = Date.now()
  const timing: Record<string, number> = {}
  if (status === 'unknown') {
    let sessionId = process.env.FACE_CHECK_SESSION
    let page = 'the page opened with that session (docs/services.md, "The face check")'
    if (!sessionId) {
      const session = await issuer('/session', {})
      if (session.status !== 201) throw new Error(`/session answered ${session.status} ${JSON.stringify(session.body)}`)
      sessionId = session.body.sessionId as string
      page = session.body.url
    }
    console.log('\nCarlos: do the face check now on your phone\n')
    console.log(`   the check page: ${page}`)
    let last = ''
    await until(
      `the face check to be approved (${FACE_CHECK_MINUTES} minutes at most)`,
      FACE_CHECK_MINUTES * 60,
      async () => {
        const r = await issuer('/submit', { sessionId, commitment })
        if (r.status === 202) return true
        const code = String(r.body?.error ?? r.status)
        if (r.status === 409 && (code === 'commitment_queued' || code === 'already_listed')) return true
        if (code !== last) console.log(`   the issuer: ${code} (${Math.round((Date.now() - began) / 1000)} s)`)
        last = code
        if ((r.status === 403 && NOT_YET.has(code)) || r.status === 502) return false
        throw new Error(`the issuer refused the face check: ${r.status} ${code}`)
      },
      20_000,
    )
    sent()
    timing.acceptedAfterSeconds = Math.round((Date.now() - began) / 1000)
    console.log(`   accepted after ${timing.acceptedAfterSeconds} s: the commitment is queued`)
    status = 'queued'
  }
  if (status !== 'listed') {
    const queued = Date.now()
    await until('the issuer to insert the commitment (it batches every 120 s on devnet)', 900, async () => (await issuer('/status', { commitment })).body.status === 'listed')
    timing.listedAfterSeconds = Math.round((Date.now() - queued) / 1000)
    console.log(`   listed ${timing.listedAfterSeconds} s after it was queued`)
  }

  // The insert: a transaction on list 0 whose registry entry names this commitment.
  const list0 = listAddress(0, DEVNET.registry)
  let insert = readRecord().loop?.[who]?.issuer?.insert as string | undefined
  let member: string | undefined
  if (!insert) {
    for (const s of await connection.getSignaturesForAddress(list0, { limit: 50 })) {
      if (s.err) continue
      const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      const entry = decodeIdentityInsertedEvents(tx?.meta?.logMessages ?? [], DEVNET.registry).find((e) => fromBytes32(e.commitment) === p.commitment)
      if (entry) {
        insert = s.signature
        member = entry.leafIndex.toString()
        break
      }
    }
  }
  console.log(`   on list 0${member ? ` as member ${member}` : ''}; insert ${insert ?? '(not among the last 50 transactions)'}`)
  loop({ [who]: { issuer: { url: url.issuer, list: list0.toBase58(), ...(member ? { member: Number(member) } : {}), insert: insert ?? null, ...timing } } })
}

// ---- the loop ------------------------------------------------------------------------------------

async function main() {
  console.log(`RPC: ${rpcName}`)
  hostDid = (await query(url.host, 'com.atproto.server.describeServer', {})).did
  signer = new PublicKey((await kora<{ signer_address: string }>('getPayerSigner', {})).signer_address)
  const decimals = (await getMint(connection, DEVNET.testDollar)).decimals
  const { path: marketPath, file: market } = await marketFile(MARKET)
  console.log(`market: ${MARKETS_URL}/${marketPath}; fee payer signs as ${signer.toBase58()}`)
  loop({ market: `${MARKETS_URL}/${marketPath}`, host: { url: url.host, did: hostDid }, feePayer: { url: url.feepayer, key: signer.toBase58() } })

  const proof = await person(SEED2, 0)
  const seller = await person(SEED3, 0)
  const buyer = await person(SEED2, 1)
  const who = (p: Person, name: string, did: string) => ({
    person: `${p.seed.file}, profile ${p.profile}`,
    did,
    handle: p.handle(hostname),
    wallet: p.wallet.toBase58(),
    commitment: p.commitment.toString(),
    plc: `${PLC}/${did}`,
    profilePage: profilePage(did),
    profileJson: `${profilePage(did)}.json`,
    name,
  })

  // ---- 1. the 2026-09-25 proof's profile, on markets v1 ------------------------------------------
  step('proof', 'the 2026-09-25 proof\'s profile names tutoring/seller, so its badge counts')
  const proofDid = await ensureDid(proof)
  const proofProfile = {
    $type: 'foundation.forest.profile',
    name: 'Devnet test person 2',
    market: MARKET,
    role: 'seller',
    contact: 'A test profile on devnet; nobody answers here.',
    about: 'Made by deploy/e2e.ts from a public test seed, to show the services working end to end.',
    wallet: proof.wallet.toBase58(),
    createdAt: '2026-09-25T00:00:00Z',
  }
  const proofPost = {
    $type: 'foundation.forest.post',
    direction: 'offer',
    description: 'Test offer on devnet: one-hour lessons in Portuguese, online. Not a real offer.',
    price: { amount: '10', mint: DEVNET.testDollar.toBase58(), per: 'hour' },
    remote: true,
    createdAt: '2026-09-25T00:00:00Z',
    subjects: ['portuguese'],
    languages: ['pt', 'en'],
  }
  const proofFolder = await ensureFolder(proof, proofDid, market, proofProfile, proofPost)
  const proofOnIndex = await onIndex('the index to show the profile in tutoring/seller, its badge counted', proofDid, (b) =>
    b.profile?.market === MARKET && b.profile?.role === 'seller' && b.badges?.some((x: any) => x.scope === 'tutoring/seller' && x.counted),
  )
  console.log(`   ${profilePage(proofDid)}: tutoring/seller, badge counted, ${proofOnIndex.offers.length} offer(s) listed`)
  loop({ proof: { ...who(proof, proofProfile.name, proofDid), host: { profile: proofFolder.profile, post: proofFolder.post, folder: proofFolder.folder, ...(proofFolder.commit ? { commit: proofFolder.commit } : {}) }, index: { market: MARKET, role: 'seller', badgeCounted: true, offersListed: proofOnIndex.offers.length, marketPage: `${url.index}/markets/${MARKET}` } } })

  // ---- 2. the seller's profile and offer ----------------------------------------------------------
  step('sellerProfile', 'the seller (seed 3): its DID, a tutoring/seller profile and one offer, through the host')
  const sellerDid = await ensureDid(seller)
  const sellerProfile = {
    $type: 'foundation.forest.profile',
    name: 'Devnet test seller',
    market: MARKET,
    role: 'seller',
    contact: 'A test profile on devnet; nobody answers here.',
    about: 'Made by deploy/e2e.ts from a public test seed: the seller in the loop over the public services.',
    wallet: seller.wallet.toBase58(),
    createdAt: '2026-09-26T00:00:00Z',
  }
  const sellerPost = {
    $type: 'foundation.forest.post',
    direction: 'offer',
    description: 'Test offer on devnet: one-hour maths lessons, online. Not a real offer.',
    price: { amount: '10', mint: DEVNET.testDollar.toBase58(), per: 'hour' },
    remote: true,
    createdAt: '2026-09-26T00:00:00Z',
    subjects: ['maths'],
    languages: ['en'],
  }
  const sellerFolder = await ensureFolder(seller, sellerDid, market, sellerProfile, sellerPost)
  await onIndex('the index to show the seller\'s profile and offer', sellerDid, (b) =>
    b.profile?.name === sellerProfile.name && b.profile?.market === MARKET && b.offers?.some((o: any) => o.description === sellerPost.description),
  )
  console.log(`   ${profilePage(sellerDid)} shows the profile and the offer`)
  loop({ seller: { ...who(seller, sellerProfile.name, sellerDid), host: { profile: sellerFolder.profile, post: sellerFolder.post, folder: sellerFolder.folder, ...(sellerFolder.commit ? { commit: sellerFolder.commit } : {}) } } })

  // ---- 3. the seller's face check -----------------------------------------------------------------
  step('faceCheck', 'the seller\'s face check, then the issuer\'s insert into list 0')
  await ensureListed(seller, 'seller')

  // ---- 4. the seller's badge ----------------------------------------------------------------------
  step('sellerBadge', 'the seller\'s badge in tutoring/seller, through the public fee payer')
  const offer = sellerFolder.postValue
  const amount = BigInt(offer.price.amount) * 10n ** BigInt(decimals) // one hour at the offer's price
  const escrow = escrowAddress(seller.wallet, DEAL_ID, DEVNET.escrow)
  const escrowInfo = await connection.getAccountInfo(escrow)
  await ensureDollars(seller, ((await registered(seller, 'tutoring/seller')) ? 0n : BUDGET.registration) + (escrowInfo ? 0n : BUDGET.invoice), 'seller')
  await ensureBadge(seller, sellerDid, 'tutoring/seller', 'seller')
  await onIndex('the index to count the seller\'s badge (it reads finalized transactions)', sellerDid, (b) => b.badges?.some((x: any) => x.scope === 'tutoring/seller' && x.counted))
  console.log(`   ${profilePage(sellerDid)}: tutoring/seller counted`)
  loop({ seller: { index: { badgeCounted: true } } })

  // ---- 5. the buyer ---------------------------------------------------------------------------
  step('buyer', 'the buyer (seed 2, profile 1): its DID, a tutoring/buyer profile, and that badge through the fee payer')
  const buyerDid = await ensureDid(buyer)
  const buyerProfile = {
    $type: 'foundation.forest.profile',
    name: 'Devnet test buyer',
    market: MARKET,
    role: 'buyer',
    contact: 'A test profile on devnet; nobody answers here.',
    about: 'Made by deploy/e2e.ts from a public test seed: the buyer in the loop over the public services.',
    wallet: buyer.wallet.toBase58(),
    createdAt: '2026-09-26T00:00:00Z',
  }
  const buyerFolder = await ensureFolder(buyer, buyerDid, market, buyerProfile)
  const ended = escrowInfo ? decodeEscrow(new Uint8Array(escrowInfo.data)).status === 'ended' : false
  await ensureDollars(buyer, ((await registered(buyer, 'tutoring/buyer')) ? 0n : BUDGET.registration) + (ended ? 0n : amount + BUDGET.payFee), 'buyer')
  await ensureBadge(buyer, buyerDid, 'tutoring/buyer', 'buyer')
  await onIndex('the index to show the buyer\'s profile, its badge counted', buyerDid, (b) =>
    b.profile?.market === MARKET && b.profile?.role === 'buyer' && b.badges?.some((x: any) => x.scope === 'tutoring/buyer' && x.counted),
  )
  console.log(`   ${profilePage(buyerDid)}: tutoring/buyer counted`)
  loop({ buyer: { ...who(buyer, buyerProfile.name, buyerDid), host: { profile: buyerFolder.profile, folder: buyerFolder.folder, ...(buyerFolder.commit ? { commit: buyerFolder.commit } : {}) }, index: { badgeCounted: true } } })

  // ---- 6. the deal ------------------------------------------------------------------------------
  step('invoice', 'the seller invoices the buyer for one hour of the offer, through the fee payer')
  const terms = termsFor(offer.terms ?? null, { seller: seller.wallet, amount, id: DEAL_ID })
  const bill = invoice({ seller: seller.wallet, buyer: buyer.wallet, payer: signer, mint: DEVNET.testDollar, decimals, terms, programId: DEVNET.escrow })
  if (!bill.escrow.equals(escrow)) throw new Error('the invoice is not at the address the deal id gives')
  const dealPage = `${url.index}/deals/${escrow.toBase58()}`
  loop({ deal: { escrow: escrow.toBase58(), deposit: bill.deposit.toBase58(), id: DEAL_ID.toString(), amount: amount.toString(), offer: sellerFolder.post, payLink: bill.url, page: dealPage, pageJson: `${dealPage}.json` } })
  if (escrowInfo) {
    console.log(`   already invoiced: ${escrow.toBase58()}`)
  } else {
    const made = await throughKora([makeDepositAddressIx({ payer: signer, escrow, mint: DEVNET.testDollar }), bill.instruction], seller)
    console.log(`   invoice ${escrow.toBase58()} for ${Number(amount) / 10 ** decimals} test dollars: ${made.signature}; Kora charged ${made.charge}`)
    loop({ deal: { invoice: made } })
  }

  step('pay', 'the buyer checks the invoice, then pays and releases it in one transaction, through the fee payer')
  let account = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  if (account.status === 'ended') {
    console.log('   already paid and released')
  } else {
    // What the buyer's app checks before paying: the invoice names the buyer's own key (every
    // refund goes there), the seller, the amount, and no option the offer did not set.
    if (!account.buyer.equals(buyer.wallet) || !account.seller.equals(seller.wallet) || account.amount !== amount) {
      throw new Error('the invoice does not name this buyer, this seller and this amount')
    }
    assertOptionsAgreed({ escrow: account, me: 'buyer', agreed: offer.terms ?? null })
    const paid = await throughKora(payInvoiceInOneTap({ escrow: account, payer: signer, programId: DEVNET.escrow }), buyer)
    console.log(`   paid and released: ${paid.signature}; Kora charged ${paid.charge}`)
    loop({ deal: { pay: paid } })
    account = decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
  }
  if (account.status !== 'ended' || account.outcome !== 'releasedToSeller' || account.creator !== 'seller' || account.toSeller !== amount) {
    throw new Error(`the receipt reads ${account.status}, ${account.outcome}, created by the ${account.creator}, ${account.toSeller} to the seller`)
  }
  console.log(`   the receipt on chain: ended, released to the seller, ${Number(account.toSeller) / 10 ** decimals} to the seller, created by the seller`)
  const dealShown = await until('the index\'s deal page to show the receipt', 600, async () => {
    const { status, body } = await getJson(`${dealPage}.json`)
    const r = status === 200 ? body.receipt : null
    return r && r.outcome === 'releasedToSeller' && r.creator === 'seller' ? body : null
  })
  console.log(`   ${dealPage}: released to the seller, created by the seller; the ${dealShown.receipt.sides.seller} and the ${dealShown.receipt.sides.buyer} named`)
  loop({ deal: { receipt: { status: account.status, outcome: account.outcome, creator: account.creator, toSeller: account.toSeller.toString(), toBuyer: account.toBuyer.toString(), transaction: dealShown.receipt.transaction } } })

  // ---- 7. reviews both ways ---------------------------------------------------------------------
  step('reviews', 'reviews both ways on the deal, each written to its author\'s folder through the host')
  const reviews = [
    { key: 'byBuyer', author: buyer, authorDid: buyerDid, subject: sellerDid, ratings: { overall: '9', clarity: '8.5' }, text: 'Test review on devnet: the lesson was held on time and explained clearly. Not a real lesson.' },
    { key: 'bySeller', author: seller, authorDid: sellerDid, subject: buyerDid, ratings: { overall: '10', clarity: '9' }, text: 'Test review on devnet: paid on time and came prepared. Not a real lesson.' },
  ]
  for (const r of reviews) {
    const existing = (await listed(r.authorDid, 'foundation.forest.review')).find((v) => v.value.subject === r.subject && v.value.dealId === escrow.toBase58())
    if (existing) {
      console.log(`   ${r.key}: already written, ${existing.uri}`)
      loop({ reviews: { [r.key]: existing.uri } })
      continue
    }
    const review = { $type: 'foundation.forest.review', subject: r.subject, ratings: r.ratings, text: r.text, dealId: escrow.toBase58(), createdAt: new Date().toISOString() }
    const checked = validateRecord(review, { market })
    if (!checked.ok) throw new Error(`the review does not validate: ${checked.errors.join('; ')}`)
    const { submitted } = await new Device(r.authorDid, r.author.keys, url.host, hostDid).write([
      { $type: 'com.atproto.repo.applyWrites#create', collection: 'foundation.forest.review', value: review },
    ])
    sent()
    console.log(`   ${r.key}: ${submitted.results[0].uri} (commit ${submitted.commit.cid})`)
    loop({ reviews: { [r.key]: submitted.results[0].uri } })
  }
  const scored: Record<string, unknown> = {}
  for (const r of reviews) {
    const body = await onIndex(`the index to weigh the review of ${r.subject}: counted, backed by both sides, a rating and a standing`, r.subject, (b) =>
      b.reviews?.received?.some((v: any) => v.reviewer === r.authorDid && v.dealId === escrow.toBase58() && v.counted && v.evidence?.kind === 'both') &&
      b.scores?.rating && b.scores?.standing?.value > 0,
    )
    const got = body.reviews.received.find((v: any) => v.reviewer === r.authorDid && v.dealId === escrow.toBase58())
    const out = { review: got.uri, ratings: got.ratings, evidence: got.evidence.kind, contribution: got.contribution, rating: body.scores.rating.value, standing: body.scores.standing.value }
    console.log(`   ${profilePage(r.subject)}: ${JSON.stringify(out)}`)
    scored[r.subject === sellerDid ? 'seller' : 'buyer'] = out
  }
  const dealReviews = (await getJson(`${dealPage}.json`)).body.reviews?.length ?? 0
  console.log(`   ${dealPage} lists ${dealReviews} reviews`)
  loop({ index: { ...scored, dealReviews } })

  // ---- 8. identities name the public URL --------------------------------------------------------
  step('identity', 'every DID document names the host\'s public URL')
  for (const did of [proofDid, sellerDid, buyerDid]) {
    const doc = await (await fetch(`${PLC}/${did}`)).json()
    const endpoint = doc.service?.find((s: any) => s.id === '#atproto_pds')?.serviceEndpoint
    if (endpoint !== url.host) throw new Error(`${did}'s document names ${endpoint}, not ${url.host}`)
  }
  if (hostDid !== `did:web:${hostname}`) throw new Error(`the host calls itself ${hostDid}`)
  console.log(`   all three name ${url.host}; the host is ${hostDid}`)
  finishStep()
  // A run that sent nothing leaves the record as it was.
  if (anySent) loop({ finishedAt: new Date().toISOString() })
  console.log('\nthe loop passed')
}

try {
  await main()
  // The prover's worker threads keep Node alive once everything is done.
  process.exit(0)
} catch (err) {
  finishStep()
  console.error(redactRpc(String((err as Error).stack ?? err)))
  process.exit(1)
}

// The end-to-end proof, on the public URLs in deploy/services.json, as seed 2's person
// (keys/test/second-seed.json), profile 0:
//
//   1. its DID, made on this machine, naming the public host; sent to plc.directory (permanent and
//      public, and since the seed is public, anyone can change it later)
//   2. its profile (declaring its wallet) and one post in `tutoring`, validated with shapes/ and
//      written through the host's two phases, signed here
//   3. both, seen on the index's pages
//   4. a face check with the issuer (the stand-in Didit when the issuer has no Didit key), its
//      commitment submitted, and the issuer's insert into list 0 seen on devnet
//   5. a badge in `tutoring/seller`, proved here from list 0 as read from devnet, paid in test dollars
//      through the public fee payer (Kora), which signs as payer and sends
//   6. the badge, seen on the index's profile page
//   7. the host's identity and the DID document, both naming the host's public URL
//
// Needs: `npm ci` in keys/, shapes/, registry/client and registry/artifacts (then `npm run fetch`),
// host/build.sh run (for host/test/device.ts), `node fund.ts` done. Each step checks first and skips
// what is done, so a second run sends nothing new. Every URL, address and signature goes into
// deploy/services.json under `e2e`.

import { createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'
import { join } from 'node:path'

import { didGenesis, submitGenesis } from '../keys/src/index.ts'
import { buildRegistration, fetchListLeaves, listAddress, usedCodeAddress } from '../registry/client/src/index.ts'
import { validateRecord } from '../shapes/src/validate.js'
import { Device, query, XrpcError } from '../host/test/device.ts'

import { DEVNET, b64, confirm, connection, redactRpc, rpcName, sleep } from './lib/chain.ts'
import { PROFILE, person } from './lib/person.ts'
import { readRecord, updateRecord } from './lib/record.ts'

const MARKET = 'tutoring'
const ROLE = 'seller'
const SCOPE = `${MARKET}/${ROLE}`
const PLC = 'https://plc.directory'
const MARKETS_URL = 'https://raw.githubusercontent.com/foundationforest/markets/main'
const artifacts = {
  wasm: join(import.meta.dirname, '../registry/artifacts/semaphore-32.wasm'),
  zkey: join(import.meta.dirname, '../registry/artifacts/semaphore-32.zkey'),
}

const svc = readRecord().railway.services
const url = { host: svc.host.url, index: svc.index.url, issuer: svc.issuer.url, feepayer: svc.feepayer.url, carrier: svc.carrier.url }
const e2e = (patch: Record<string, unknown>) => updateRecord({ e2e: patch })
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`)

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
async function until<T>(what: string, seconds: number, check: () => Promise<T | undefined | null | false>): Promise<T> {
  const end = Date.now() + seconds * 1000
  for (let i = 0; Date.now() < end; i++) {
    const got = await check()
    if (got) return got
    if (i % 6 === 0) console.log(`   waiting: ${what}`)
    await sleep(5000)
  }
  throw new Error(`gave up after ${seconds} s: ${what}`)
}

async function main() {
  console.log(`RPC: ${rpcName}`)
  const me = await person()
  const hostname = new URL(url.host).host
  const handle = `forest-seed2-p${PROFILE}.${hostname}`

  // ---- 1. the DID -------------------------------------------------------------------------------
  step(1, 'the DID, made here, naming the public host')
  const genesis = await didGenesis(me.keys, { handle, pds: url.host })
  const did = genesis.did
  const existing = await fetch(`${PLC}/${did}`)
  if (existing.status === 404) {
    await submitGenesis(genesis, PLC)
    console.log(`   sent to ${PLC}: ${did}`)
  } else {
    console.log(`   already in ${PLC}: ${did}`)
  }
  e2e({ person: 'keys/test/second-seed.json, profile 0', did, handle, wallet: me.wallet.toBase58(), commitment: me.commitment.toString(), plc: `${PLC}/${did}` })

  // ---- 2. profile and post, written through the host ---------------------------------------------
  step(2, 'profile and post, signed here, stored by the host')
  const server = await query(url.host, 'com.atproto.server.describeServer', {})
  const hostDid: string = server.did
  const device = new Device(did, me.keys, url.host, hostDid)
  const market = await (await fetch(`${MARKETS_URL}/freelance-work/${MARKET}.json`)).json()

  const profile = {
    $type: 'foundation.forest.profile',
    name: 'Devnet test person 2',
    contact: 'A test profile on devnet; nobody answers here.',
    about: 'Made by deploy/e2e.ts from a public test seed, to show the services working end to end.',
    wallet: me.wallet.toBase58(),
    createdAt: '2026-09-25T00:00:00Z',
  }
  const post = {
    $type: 'foundation.forest.post',
    direction: 'offer',
    market: MARKET,
    role: ROLE,
    description: 'Test offer on devnet: one-hour lessons in Portuguese, online. Not a real offer.',
    price: { amount: '10', mint: DEVNET.testDollar.toBase58(), per: 'hour' },
    remote: true,
    createdAt: '2026-09-25T00:00:00Z',
    subjects: ['portuguese'],
    languages: ['pt', 'en'],
  }
  for (const [record, m] of [[profile, undefined], [post, market]] as const) {
    const checked = validateRecord(record, m ? { market: m } : {})
    if (!checked.ok) throw new Error(`${record.$type} does not validate: ${checked.errors.join('; ')}`)
  }

  let hasFolder = true
  try {
    await query(url.host, 'com.atproto.repo.describeRepo', { repo: did })
  } catch (err) {
    if (err instanceof XrpcError && err.status === 400) hasFolder = false
    else throw err
  }
  const listed = async (collection: string) =>
    hasFolder ? (await query(url.host, 'com.atproto.repo.listRecords', { repo: did, collection })).records : []
  const writes: any[] = []
  if (!(await listed('foundation.forest.profile')).length) {
    writes.push({ $type: 'com.atproto.repo.applyWrites#create', collection: 'foundation.forest.profile', rkey: 'self', value: profile })
  }
  const posts = await listed('foundation.forest.post')
  if (!posts.length) writes.push({ $type: 'com.atproto.repo.applyWrites#create', collection: 'foundation.forest.post', value: post })
  if (writes.length) {
    const { submitted } = await device.write(writes)
    console.log(`   ${hasFolder ? 'written' : 'folder created with'}: ${submitted.results.map((r) => r.uri).join(', ')} (commit ${submitted.commit.cid})`)
  } else {
    console.log('   already there')
  }
  const postUri = (await query(url.host, 'com.atproto.repo.listRecords', { repo: did, collection: 'foundation.forest.post' })).records[0].uri
  e2e({ host: { url: url.host, did: hostDid, profile: `at://${did}/foundation.forest.profile/self`, post: postUri, folder: `${url.host}/xrpc/com.atproto.sync.getRepo?did=${did}` } })

  // ---- 3. seen on the index ------------------------------------------------------------------
  step(3, 'profile and post on the index')
  const page = `${url.index}/profiles/${did}`
  const seen = await until('the index to show the profile and the post', 300, async () => {
    const { status, body } = await getJson(`${page}.json`)
    if (status !== 200) return null
    const text = JSON.stringify(body)
    return text.includes(profile.name) && text.includes(post.description) ? body : null
  })
  console.log(`   ${page} shows "${profile.name}" and the post`)
  e2e({ index: { profilePage: page, profileJson: `${page}.json`, marketPage: `${url.index}/markets/${MARKET}` } })
  void seen

  // ---- 4. the issuer ------------------------------------------------------------------------
  step(4, 'the issuer: a face check, the commitment, the insert into list 0')
  const post4 = (path: string, body: unknown) =>
    getJson(`${url.issuer}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const commitment = me.commitment.toString()
  let status = (await post4('/status', { commitment })).body.status
  if (status === 'unknown') {
    const session = await post4('/session', {})
    if (session.status !== 201) throw new Error(`/session answered ${session.status} ${JSON.stringify(session.body)}`)
    const submitted = await post4('/submit', { sessionId: session.body.sessionId, commitment })
    if (submitted.status !== 202) throw new Error(`/submit answered ${submitted.status} ${JSON.stringify(submitted.body)}`)
    console.log(`   face check opened (${new URL(session.body.url).host}), commitment queued`)
    status = 'queued'
  }
  if (status !== 'listed') {
    await until('the issuer to insert the commitment (it batches every 120 s on devnet)', 600, async () => (await post4('/status', { commitment })).body.status === 'listed')
  }
  const list0 = listAddress(0, DEVNET.registry)
  const leaves = await fetchListLeaves(connection, 0, { programId: DEVNET.registry })
  const position = leaves.leaves.indexOf(me.commitment)
  if (position < 0) throw new Error('the issuer says listed, but list 0 on devnet does not hold the commitment')
  let insert = readRecord().e2e?.issuer?.insert as string | undefined
  if (!insert) {
    // The insert is a transaction on list 0 signed by the issuer key whose log names this commitment.
    for (const s of await connection.getSignaturesForAddress(list0, { limit: 50 })) {
      const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      const signers = tx?.transaction.message.staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures) ?? []
      if (!s.err && signers.some((k) => k.equals(DEVNET.issuer)) && tx?.meta?.logMessages?.some((l) => l.includes('InsertIdentity') || l.includes('insert_identity'))) {
        const after = await fetchListLeaves(connection, 0, { programId: DEVNET.registry })
        if (after.leaves.indexOf(me.commitment) === position) {
          insert = s.signature
          break
        }
      }
    }
  }
  console.log(`   listed: member ${position} of ${leaves.leaves.length} in list 0; insert ${insert ?? '(not found in the last 50 transactions)'}`)
  e2e({ issuer: { url: url.issuer, list: list0.toBase58(), member: position, insert: insert ?? null } })

  // ---- 5. the badge, through the public fee payer ------------------------------------------------
  step(5, `the badge in ${SCOPE}, paid through the public fee payer`)
  const kora = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const { body } = await getJson(url.feepayer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (body.error) throw new Error(`Kora ${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? '')}`)
    return body.result as T
  }
  const signer = new PublicKey((await kora<{ signer_address: string }>('getPayerSigner', {})).signer_address)
  const walletKey = Keypair.fromSeed(me.keys.wallet.privateKey)
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(DEVNET.testDollar, owner)
  const accounts = { payer: signer, profileWallet: me.wallet, feeAuthority: me.wallet, feeTokens: ata(me.wallet), treasuryTokens: ata(DEVNET.treasury) }

  let registration = readRecord().e2e?.badge?.registration as string | undefined
  const fresh = await fetchListLeaves(connection, 0, { programId: DEVNET.registry })
  const started = Date.now()
  const reg = await buildRegistration({
    secret: me.secret,
    market: SCOPE,
    did,
    listIndex: 0,
    leaves: fresh.leaves,
    artifacts,
    accounts,
    recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
    computeUnitLimit: null, // the fee payer allows no compute budget program
    programId: DEVNET.registry,
  })
  const provingMs = Date.now() - started
  const codeAccount = usedCodeAddress(reg.code, DEVNET.registry)
  let charge: string | undefined
  if (await connection.getAccountInfo(codeAccount)) {
    console.log(`   already registered: code account ${codeAccount.toBase58()}`)
  } else {
    const compile = (ixs: TransactionInstruction[], blockhash: string) =>
      new VersionedTransaction(new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
    const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    const estimate = await kora<{ fee_in_lamports: number; fee_in_token: number }>('estimateTransactionFee', {
      transaction: b64(compile([reg.instruction], blockhash)),
      fee_token: DEVNET.testDollar.toBase58(),
      sig_verify: false,
    })
    const pay = createTransferInstruction(ata(me.wallet), ata(signer), me.wallet, BigInt(estimate.fee_in_token))
    const tx = compile([reg.instruction, pay], blockhash)
    tx.sign([walletKey])
    const { signature } = await kora<{ signature: string }>('signAndSendTransaction', { transaction: b64(tx) })
    await confirm(signature)
    registration = signature
    charge = `${estimate.fee_in_token} test-dollar base units (${estimate.fee_in_lamports} lamports at the mock price)`
    console.log(`   registered through Kora: ${signature}; Kora charged ${charge}; the proof took ${(provingMs / 1000).toFixed(1)} s`)
    const landed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    e2e({ badge: { bytes: tx.serialize().length, computeUnits: landed?.meta?.computeUnitsConsumed ?? null, networkFee: landed?.meta?.fee ?? null } })
  }
  e2e({
    badge: {
      scope: SCOPE,
      feePayer: url.feepayer,
      feePayerKey: signer.toBase58(),
      code: Buffer.from(reg.codeBytes).toString('hex'),
      codeAccount: codeAccount.toBase58(),
      root: reg.root.toString(16).padStart(64, '0'),
      ...(registration ? { registration } : {}),
      ...(charge ? { charge } : {}),
    },
  })

  // ---- 6. the badge on the index ------------------------------------------------------------
  step(6, 'the badge on the index')
  const badge = await until('the index to show the badge (it reads finalized transactions)', 600, async () => {
    const { status, body } = await getJson(`${page}.json`)
    if (status !== 200) return null
    const found = JSON.stringify(body).includes(SCOPE) ? body : null
    return found
  })
  const badges = JSON.stringify(badge).match(new RegExp(`[^{}]*${SCOPE.replace('/', '\\/')}[^{}]*`))?.[0]
  console.log(`   ${page} shows the badge: ${badges?.slice(0, 300)}`)
  e2e({ index: { badgeShown: true, badgeEntry: badges ?? null } })

  // ---- 7. identities name the public URL -----------------------------------------------------
  step(7, 'the host and the DID document name the public URL')
  const doc = await (await fetch(`${PLC}/${did}`)).json()
  const endpoint = doc.service?.find((s: any) => s.id === '#atproto_pds')?.serviceEndpoint
  if (endpoint !== url.host) throw new Error(`the DID document names ${endpoint}, not ${url.host}`)
  if (hostDid !== `did:web:${hostname}`) throw new Error(`the host calls itself ${hostDid}`)
  console.log(`   ${did}'s document names ${endpoint}; the host is ${hostDid}`)
  e2e({ identity: { didDocumentEndpoint: endpoint, hostDid }, finishedAt: new Date().toISOString() })
  console.log('\nall seven steps passed')
}

try {
  await main()
  // The prover's worker threads keep Node alive once everything is done.
  process.exit(0)
} catch (err) {
  console.error(redactRpc(String((err as Error).stack ?? err)))
  process.exit(1)
}

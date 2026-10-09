// Forest credits, a service's side: its credit key, its directory, how many credits a buy holds and
// what they cost, whether a payment for a buy landed, the blind signatures it answers a paid buy
// with, and its spent list. See README.md, "Selling credits".
//
// Node only, like records' host: the spent list is SQLite (node:sqlite). It talks to no network of
// its own: the payment check asks the RPC the service passes it. The signatures are privacypass-ts's
// type 2 issuer, unchanged, one request at a time: its batch issuer logs every request it cannot
// sign, and a service here logs nothing of what it is sent.

import { DatabaseSync } from 'node:sqlite'

import { genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad } from '@scure/base'

import { CREDIT_TYPE, DIRECTORY_PATH, amountOf } from './index.ts'

const { BlindRSAMode, Issuer, getPublicKeyBytes } = publicVerif

/** Bytes in an array of their own: privacypass-ts reads a view's whole underlying buffer from its start. */
const own = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

/** A service's credit key: what it signs with, and the bytes its directory publishes (SubjectPublicKeyInfo, RSASSA-PSS). */
export type CreditKey = { privateKey: CryptoKey; publicKey: CryptoKey; published: Uint8Array }

/**
 * The service's credit key from its private key, RSA-2048 in PKCS #8 (DER), as `openssl genpkey
 * -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -outform DER` writes one. Throws on any other size.
 */
export async function keyFrom(pkcs8: Uint8Array): Promise<CreditKey> {
  const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' }
  const privateKey = await crypto.subtle.importKey('pkcs8', own(pkcs8) as Uint8Array<ArrayBuffer>, algorithm, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, algorithm, true, ['verify'])
  if ((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 2048) throw new Error('a credit key is RSA-2048')
  return { privateKey, publicKey, published: await getPublicKeyBytes(publicKey) }
}

/**
 * The directory a service serves at DIRECTORY_PATH (RFC 9578 §4), with its `forest-credit` entry:
 * where a buy goes, each key with when it starts to count, and what one credit buys, where it is
 * paid, in what and at what price.
 */
export function directoryOf(input: {
  requestUri: string
  keys: { key: Uint8Array; notBefore?: number }[]
  credit: { unit: string; address: string; mint: string; price: string }
}): Record<string, unknown> {
  return {
    'issuer-request-uri': input.requestUri,
    'token-keys': input.keys.map((k) => ({ 'token-type': CREDIT_TYPE, 'token-key': base64urlnopad.encode(k.key), ...(k.notBefore === undefined ? {} : { 'not-before': k.notBefore }) })),
    'forest-credit': { ...input.credit },
  }
}

/** How many credits a buy asks for: its requests, each one credit. Throws on bytes that are not a batch of requests. */
export function countOf(buy: Uint8Array): number {
  let requests: genericBatched.TokenRequest[]
  try {
    requests = [...genericBatched.BatchedTokenRequest.deserialize(own(buy))]
  } catch {
    throw new Error('not a buy')
  }
  if (!requests.length) throw new Error('a buy holds one credit or more')
  return requests.length
}

/** The service's answer to a paid buy: a blind signature for each request under `key`, an empty slot for any other. Deterministic: the same buy gets the same answer. */
export async function answer(buy: Uint8Array, key: CreditKey, origin: string): Promise<Uint8Array> {
  const issuer = new Issuer(BlindRSAMode.PSS, new URL(origin).host, key.privateKey, key.publicKey)
  const id = await issuer.tokenKeyID()
  const responses: genericBatched.OptionalTokenResponse[] = []
  for (const request of genericBatched.BatchedTokenRequest.deserialize(own(buy))) {
    let response = null
    if (request.tokenType === CREDIT_TYPE && request.truncatedTokenKeyId === id[id.length - 1]) {
      try {
        response = await issuer.issue(request.tokenRequest as InstanceType<typeof publicVerif.TokenRequest>)
      } catch {
        // A blinded message the key cannot sign: an empty slot, as for any other request.
      }
    }
    responses.push(new genericBatched.OptionalTokenResponse(response))
  }
  return new genericBatched.GenericBatchTokenResponse(responses).serialize()
}

/** A JSON-RPC call to a Solana RPC the service chooses: `method` with `params`, giving the result. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
type Transaction = {
  meta: { err: unknown; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; loadedAddresses?: { writable?: string[] } } | null
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } }
}

/** `amount`, decimal text in whole units, in units of 10^-decimals; null if it has more decimal places than that. */
function baseUnits(amount: string, decimals: number): bigint | null {
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole! + fraction.padEnd(decimals, '0'))
}

/** What `address` gained in `mint` (or SOL) in this transaction, in base units, and the decimals they are in. */
function received(tx: Transaction, address: string, mint: string): { units: bigint; decimals: number } {
  const meta = tx.meta!
  if (mint === 'SOL') {
    const keys = [...tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(meta.loadedAddresses?.writable ?? [])]
    const i = keys.indexOf(address)
    if (i < 0) return { units: 0n, decimals: 9 }
    return { units: BigInt(meta.postBalances?.[i] ?? 0) - BigInt(meta.preBalances?.[i] ?? 0), decimals: 9 }
  }
  const mine = (balances: TokenBalance[] | undefined) => (balances ?? []).filter((b) => b.owner === address && b.mint === mint)
  const after = mine(meta.postTokenBalances)
  const sum = (balances: TokenBalance[]) => balances.reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n)
  return { units: sum(after) - sum(mine(meta.preTokenBalances)), decimals: after[0]?.uiTokenAmount.decimals ?? 0 }
}

/**
 * Did a buy's payment land? The signature of a finalized transaction that names `reference` (as a
 * Solana Pay payment does) and paid `address` at least `amount` (decimal text, whole units) of `mint`
 * (or SOL), or null if none has yet. Two calls through `rpc`: the transactions naming the reference,
 * then each one. Throws when the RPC does; its error is the RPC's to word.
 */
export async function paid(rpc: Rpc, payment: { reference: string; address: string; mint: string; amount: string }): Promise<string | null> {
  if (base58.decode(payment.reference).length !== 32) throw new Error('a reference is a Solana address')
  const named = (await rpc('getSignaturesForAddress', [payment.reference, { commitment: 'finalized', limit: 20 }])) as { signature: string; err: unknown }[]
  if (!Array.isArray(named)) throw new Error('the RPC answered no list')
  for (const { signature, err } of named) {
    if (err !== null) continue
    const tx = (await rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }])) as Transaction | null
    if (!tx?.meta || tx.meta.err !== null) continue
    const got = received(tx, payment.address, payment.mint)
    const owed = baseUnits(payment.amount, got.decimals)
    if (owed !== null && got.units >= owed) return signature
  }
  return null
}

/** What a request showing a credit is told: the credit is held for it now, or it was spent, or another request holds it. */
export type Hold = 'held' | 'spent' | 'busy'

/**
 * The spent list: every credit id the service took, held while its action is in flight, spent once
 * it lands, freed if it fails or can no longer land. One SQLite file, ids only, and, for a hold, a
 * note the service writes for itself (what to look for to know whether the action landed) and when.
 */
export class SpentList {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, spent INTEGER NOT NULL, note TEXT, at INTEGER) WITHOUT ROWID')
  }

  /** Hold `id` for a request now: `held` if it was free, `spent` if it was spent, `busy` if another request holds it. */
  hold(id: string, note: string | null = null, at: number = Date.now()): Hold {
    const taken = this.#db.prepare('INSERT OR IGNORE INTO credits (id, spent, note, at) VALUES (?, 0, ?, ?)').run(id, note, at).changes === 1
    if (taken) return 'held'
    const row = this.#db.prepare('SELECT spent FROM credits WHERE id = ?').get(id) as { spent: number } | undefined
    return row?.spent ? 'spent' : 'busy'
  }

  /** The action landed: `id` is spent, for good. */
  land(id: string): void {
    this.#db.prepare('UPDATE credits SET spent = 1, note = NULL, at = NULL WHERE id = ?').run(id)
  }

  /** The action failed, or can no longer land: `id` is free to be shown again. A spent id stays spent. */
  free(id: string): void {
    this.#db.prepare('DELETE FROM credits WHERE id = ? AND spent = 0').run(id)
  }

  /** Every id held now, with its note and when: what a service settles when it starts again. */
  holds(): { id: string; note: string | null; at: number }[] {
    const rows = this.#db.prepare('SELECT id, note, at FROM credits WHERE spent = 0 ORDER BY at').all() as { id: string; note: string | null; at: number }[]
    return rows.map(({ id, note, at }) => ({ id, note, at }))
  }

  close(): void {
    this.#db.close()
  }
}

export { DIRECTORY_PATH, amountOf }

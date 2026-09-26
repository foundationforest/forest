// Devnet, for the deploy scripts: the RPC (Helius's when HELIUS_API_KEY is set, since its URL holds the
// key it is never printed), the keys devnet/keys.sh writes, and sending with confirmation. Everything
// is polled, not subscribed, so nothing keeps Node alive afterwards.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js'

import { keysDir } from './secrets.ts'

const helius = process.env.HELIUS_API_KEY
export const rpcUrl = helius ? `https://devnet.helius-rpc.com/?api-key=${helius}` : 'https://api.devnet.solana.com'
export const rpcName = helius ? 'Helius devnet' : 'api.devnet.solana.com'

/** Any text with the RPC's key taken out. */
export function redactRpc(text: string): string {
  return helius ? text.split(helius).join('<helius-key>') : text
}

export const connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false })

// docs/devnet.md
export const DEVNET = {
  registry: new PublicKey('8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i'),
  escrow: new PublicKey('3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR'),
  testDollar: new PublicKey('J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'),
  treasury: new PublicKey('CkzCrVbQEDwex643ncFFnFwAZ3EJ6YHgnarHmrJWo5w9'),
  issuer: new PublicKey('7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7'),
  payer: new PublicKey('9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd'),
}

/** A key devnet/keys.sh wrote, by its label. */
export function devnetKey(label: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir, `${label}.json`), 'utf8'))))
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits until the signature is confirmed (or fails), polling. */
export async function confirm(signature: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    const s = value[0]
    if (s?.err) throw new Error(`${signature} failed: ${JSON.stringify(s.err)}`)
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return
    await sleep(1500)
  }
  throw new Error(`${signature} not confirmed in ${timeoutMs / 1000} s`)
}

/** A legacy transaction from these instructions, the first signer paying, sent and confirmed. */
export async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...instructions)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(...signers)
  const signature = await connection.sendRawTransaction(tx.serialize())
  await confirm(signature)
  return signature
}

export const b64 = (tx: VersionedTransaction | Uint8Array) =>
  Buffer.from(tx instanceof Uint8Array ? tx : tx.serialize()).toString('base64')

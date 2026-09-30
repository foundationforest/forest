// Discovery, optional: a Pkarr packet (signed DNS records on the Mainline DHT, no operator) that
// maps a profile's key to its hosts. The folder entry stays the authority; this is a hint for a
// reader that has only a key (from a badge on chain, or a review's subject).
//
// The packet is signed by the profile's own ed25519 key over BEP-44's bencoded
// "3:seqi<t>e1:v<n>:<dns packet>", which can never be an entry's signing input (0xff first)
// nor a Solana transaction (its header would ask for 51 signatures).
//
// A phone hands the signed packet to its hosts, which republish it; it never talks to the DHT
// or a relay itself, which would put its address next to each of its keys. The official
// JavaScript client only speaks to HTTP relays; hosts and indexes can use the DHT natively.

import { ed25519 } from '@noble/curves/ed25519.js'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, Keypair, ResolvePolicy, SignedPacket } from '@synonymdev/pkarr'
import { concat, utf8 } from './bytes.ts'
import { normalizeOrigin } from './entry.ts'
import { type ProfileKey, isUsableKey, publicKeyFromDid } from './keys.ts'

export const RECORD = '_forest'
export const TTL = 3600

// z-base-32 (Pkarr's key encoding).
const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
export function z32encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += Z32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += Z32[(value << (5 - bits)) & 31]
  return out
}
export function z32decode(text: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text) {
    const i = Z32.indexOf(ch)
    if (i < 0) return null
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** The relay payload for a profile's hosts: signature(64) || timestamp µs (8, big-endian) || DNS packet. */
export function hostsPayload(key: ProfileKey, hosts: string[], timestampMs: number): Uint8Array {
  const builder = SignedPacket.builder()
  for (const host of hosts) builder.addTxtRecord(RECORD, `host=${host}`, TTL)
  builder.setTimestamp(timestampMs)
  const packet = builder.buildAndSign(Keypair.fromSecretKey(key.secretKey))
  // bytes() is last_seen(8) || public key(32) || the relay payload.
  return packet.bytes().slice(8 + 32)
}

/** Check a relay payload ourselves: the library's fromBytes does not verify signatures. */
export function checkPayload(publicKey: Uint8Array, payload: Uint8Array): { timestamp: bigint } | null {
  if (payload.length < 72 || payload.length > 72 + 1000 || !isUsableKey(publicKey)) return null
  const sig = payload.subarray(0, 64)
  const timestamp = new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0)
  const packet = payload.subarray(72)
  const signed = concat(utf8(`3:seqi${timestamp}e1:v${packet.length}:`), packet)
  return ed25519.verify(sig, signed, publicKey, { zip215: false }) ? { timestamp } : null
}

/** Hosts named in a verified payload. */
export function hostsFromPayload(publicKey: Uint8Array, payload: Uint8Array): string[] | null {
  if (!checkPayload(publicKey, payload)) return null
  const packet = SignedPacket.fromBytes(concat(new Uint8Array(8), publicKey, payload))
  return hostsFromRecords(packet.records)
}

function hostsFromRecords(records: Array<{ name: string; rdata: { type: string; value?: string } }>): string[] {
  const hosts: string[] = []
  for (const r of records) {
    if (!r.name.startsWith(RECORD + '.') || r.rdata.type !== 'TXT' || !r.rdata.value?.startsWith('host=')) continue
    const origin = normalizeOrigin(r.rdata.value.slice(5))
    if (origin && !hosts.includes(origin)) hosts.push(origin)
  }
  return hosts
}

/** Resolve a profile's hosts through Pkarr relays, with the official client. */
export async function resolveHosts(relays: string[], did: string): Promise<string[] | null> {
  const key = publicKeyFromDid(did)
  if (!key) return null
  const client = new Client(relays, 2000)
  const packet = await client.resolve(z32encode(key), ResolvePolicy.NetworkOnly)
  return packet ? hostsFromRecords(packet.records) : null
}

export async function publishPayload(relays: string[], did: string, payload: Uint8Array): Promise<number[]> {
  const key = publicKeyFromDid(did)
  if (!key) throw new Error('not a profile name')
  return Promise.all(relays.map(async (relay) => (await fetch(`${relay}/${z32encode(key)}`, { method: 'PUT', body: Buffer.from(payload) })).status))
}

/**
 * A stand-in for a Pkarr relay, speaking the relay HTTP API (PUT/GET /<z-base-32 key>) and
 * checking every payload. In tests it stands for the DHT, which needs UDP this sandbox lacks.
 */
export class Relay {
  private readonly store = new Map<string, Uint8Array>()
  private server?: Server
  /** For attack tests: change what the relay serves. */
  tamper?: (payload: Uint8Array) => Uint8Array

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req)
        .then(({ status, body }) => {
          res.writeHead(status, body ? { 'content-type': 'application/pkarr.org/relays#payload' } : {})
          res.end(body ? Buffer.from(body) : undefined)
        })
        .catch(() => res.writeHead(500).end())
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async close() {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: Uint8Array }> {
    const name = new URL(req.url ?? '/', 'http://relay.invalid').pathname.slice(1)
    const key = z32decode(name)
    if (!key || key.length !== 32) return { status: 400 }
    if (req.method === 'GET') {
      const stored = this.store.get(name)
      if (!stored) return { status: 404 }
      return { status: 200, body: this.tamper ? this.tamper(stored) : stored }
    }
    if (req.method !== 'PUT') return { status: 405 }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const payload = new Uint8Array(Buffer.concat(chunks))
    if (payload.length > 1072) return { status: 413 }
    const checked = checkPayload(key, payload)
    if (!checked) return { status: 400 }
    const stored = this.store.get(name)
    if (stored && checkPayload(key, stored)!.timestamp >= checked.timestamp) return { status: 409 }
    this.store.set(name, payload)
    return { status: 204 }
  }
}

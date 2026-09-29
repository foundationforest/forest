// The pointer: where a profile's log lives, signed by the profile key. Its form is a BEP44 mutable
// item (the BitTorrent DHT's signed, sequenced value), carrying a DNS packet, exactly as Pkarr does,
// so the same bytes can sit on the Mainline DHT through any Pkarr relay, on any host, or in any
// index. Whoever serves it cannot change it; the newest sequence wins. Nothing here is Forest's own
// except the name of the TXT record.
//
// seq is a unix timestamp in microseconds, as Pkarr uses, so two devices never tie.

import dnsPacket from 'dns-packet'
import { concat, copy, utf8, text as decodeText } from './codec.ts'
import { keyFromDid } from './did.ts'
import { verifySignature, type Signer } from './keys.ts'

export type Pointer = { did: string; hosts: string[]; seq: number }

export const MAX_PACKET_BYTES = 1000
export const RECORD_NAME = '_forest'

// z-base32, the alphabet Pkarr uses for keys in URLs.
const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

export function z32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      out += Z32[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += Z32[(acc << (5 - bits)) & 31]
  return out
}

export function z32Decode(text: string): Uint8Array {
  const out: number[] = []
  let bits = 0
  let acc = 0
  for (const c of text) {
    const v = Z32.indexOf(c)
    if (v < 0) throw new Error(`not z-base32: ${c}`)
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function pointerName(publicKey: Uint8Array): string {
  return `${RECORD_NAME}.${z32Encode(publicKey)}`
}

/** The DNS packet: one TXT record naming the hosts. */
export function packetFor(publicKey: Uint8Array, hosts: string[]): Uint8Array {
  const packet = new Uint8Array(
    dnsPacket.encode({
      type: 'response',
      id: 0,
      flags: 0,
      questions: [],
      answers: [{ name: pointerName(publicKey), type: 'TXT', class: 'IN', ttl: 300, data: [`v=1`, `hosts=${hosts.join(',')}`] }],
    }),
  )
  if (packet.length > MAX_PACKET_BYTES) throw new Error(`pointer packet is ${packet.length} bytes; the DHT limit is ${MAX_PACKET_BYTES}`)
  return packet
}

export function hostsFromPacket(publicKey: Uint8Array, packet: Uint8Array): string[] {
  const decoded = dnsPacket.decode(Buffer.from(packet))
  const name = pointerName(publicKey)
  for (const a of decoded.answers ?? []) {
    if (a.type !== 'TXT' || a.name !== name) continue
    const parts = (Array.isArray(a.data) ? a.data : [a.data]).map((d) => (typeof d === 'string' ? d : decodeText(new Uint8Array(d))))
    if (!parts.includes('v=1')) continue
    const hosts = parts.find((p) => p.startsWith('hosts='))
    if (hosts) return hosts.slice('hosts='.length).split(',').filter((h) => h.length > 0)
  }
  throw new Error('no pointer record in packet')
}

/** BEP44: the bytes a mutable item's signature covers. */
export function bep44Message(seq: number, v: Uint8Array): Uint8Array {
  return concat(utf8(`3:seqi${seq}e1:v${v.length}:`), v)
}

/** The relay payload: signature (64) || seq as big-endian u64 (8) || packet. */
export function signPointer(signer: Signer, hosts: string[], seq = nowMicros()): { payload: Uint8Array; pointer: Pointer } {
  const packet = packetFor(signer.publicKey, hosts)
  const sig = signer.sign(bep44Message(seq, packet))
  const seqBytes = new Uint8Array(8)
  new DataView(seqBytes.buffer).setBigUint64(0, BigInt(seq))
  return { payload: concat(sig, seqBytes, packet), pointer: { did: signer.did, hosts, seq } }
}

/** Checks a payload against the profile's key and returns the pointer. Throws on any fault. */
export function verifyPointer(did: string, payload: Uint8Array): Pointer {
  const { type, publicKey } = keyFromDid(did)
  if (type !== 'ed25519') throw new Error('a pointer is signed by a profile key')
  if (payload.length < 72 || payload.length > 72 + MAX_PACKET_BYTES) throw new Error('pointer payload has the wrong length')
  const sig = payload.subarray(0, 64)
  const seq = Number(new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0))
  const packet = payload.subarray(72)
  if (!verifySignature(publicKey, bep44Message(seq, packet), sig)) throw new Error('pointer signature does not verify')
  return { did, hosts: hostsFromPacket(publicKey, packet), seq }
}

export function nowMicros(): number {
  return Date.now() * 1000
}

/** A stand-in for the DHT with BEP44's one rule: a lower or equal seq is refused. */
export class MemoryDht {
  private items = new Map<string, Uint8Array>()
  put(did: string, payload: Uint8Array): void {
    const pointer = verifyPointer(did, payload)
    const current = this.items.get(did)
    if (current && verifyPointer(did, current).seq >= pointer.seq) throw new Error('DHT: seq must be higher than the stored one')
    this.items.set(did, payload)
  }
  get(did: string): Uint8Array | null {
    return this.items.get(did) ?? null
  }
}

/** A Pkarr relay over HTTP: PUT and GET /<z-base32 public key>. Anyone can run one. */
export class PkarrRelay {
  url: string
  constructor(url: string) {
    this.url = url
  }
  private path(did: string): string {
    return `${this.url.replace(/\/+$/, '')}/${z32Encode(keyFromDid(did).publicKey)}`
  }
  async put(did: string, payload: Uint8Array): Promise<void> {
    verifyPointer(did, payload)
    const res = await fetch(this.path(did), { method: 'PUT', body: copy(payload), headers: { 'content-type': 'application/octet-stream' } })
    if (!res.ok) throw new Error(`relay refused: ${res.status} ${await res.text()}`)
  }
  async get(did: string): Promise<Uint8Array | null> {
    const res = await fetch(this.path(did))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`relay error: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

export type PointerSource = { get(did: string): Promise<Uint8Array | null> | Uint8Array | null }

/** Asks every source and keeps the newest pointer that verifies. Sources can lie; the signature cannot. */
export async function resolvePointer(did: string, sources: PointerSource[]): Promise<{ pointer: Pointer; payload: Uint8Array } | null> {
  let best: { pointer: Pointer; payload: Uint8Array } | null = null
  for (const source of sources) {
    let payload: Uint8Array | null
    try {
      payload = await source.get(did)
    } catch {
      continue
    }
    if (!payload) continue
    let pointer: Pointer
    try {
      pointer = verifyPointer(did, payload)
    } catch {
      continue
    }
    if (!best || pointer.seq > best.pointer.seq) best = { pointer, payload }
  }
  return best
}

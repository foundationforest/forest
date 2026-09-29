// Private records. The record is encrypted on the writer's device under a fresh content key; that
// key is wrapped to each reader with HPKE (RFC 9180, X25519 + HKDF-SHA256 + AES-256-GCM), used
// unchanged from a library that passes the RFC's test vectors. The host stores the ciphertext and
// sees only its size, its opaque key and when it arrived. Who can read is decided at write time; a
// reader added later cannot open older records, and a reader removed later keeps what it already
// could open, as with any encryption.

import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { copy, decode, encode, utf8 } from './codec.ts'
import { keyFromDid } from './did.ts'
import type { Enc } from './entry.ts'
import type { Reader } from './keys.ts'

export const ALG = 'A256GCM+HPKE(X25519,HKDF-SHA256,A256GCM)'
const HPKE_INFO = utf8('forest/private/1')

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() })

/** What a private entry hides: the real collection, the real key, and the record. */
export type PrivatePayload = { col: string; key: string; rec: Record<string, unknown> }

function aad(did: string, opaqueKey: string): Uint8Array<ArrayBuffer> {
  return utf8(`forest/private/1|${did}|${opaqueKey}`)
}

/** Encrypts a payload for the given readers (X25519 did:keys). Returns the `enc` block of an entry. */
export async function sealRecord(did: string, opaqueKey: string, payload: PrivatePayload, readers: string[]): Promise<Enc> {
  if (readers.length === 0) throw new Error('a private record needs at least one reader')
  const cek = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(did, opaqueKey) }, key, copy(encode(payload))))
  const to: Enc['to'] = []
  for (const kid of readers) {
    const { type, publicKey } = keyFromDid(kid)
    if (type !== 'x25519') throw new Error(`${kid} is not a reader key`)
    const recipientPublicKey = await suite.kem.deserializePublicKey(copy(publicKey))
    const sender = await suite.createSenderContext({ recipientPublicKey, info: HPKE_INFO })
    const wrapped = new Uint8Array(await sender.seal(copy(cek), utf8(kid)))
    to.push({ kid, enc: new Uint8Array(sender.enc), ct: wrapped })
  }
  return { alg: ALG, iv, ct, to }
}

/** Opens a private entry with one reader's key. Throws when the reader is not among its readers. */
export async function openRecord(did: string, opaqueKey: string, enc: Enc, reader: Reader): Promise<PrivatePayload> {
  if (enc.alg !== ALG) throw new Error(`unknown scheme ${enc.alg}`)
  const mine = enc.to.find((r) => r.kid === reader.did)
  if (!mine) throw new Error('this record is not addressed to this reader')
  const recipientKey = await suite.kem.deserializePrivateKey(copy(reader.privateKey))
  const recipient = await suite.createRecipientContext({ recipientKey, enc: copy(mine.enc), info: HPKE_INFO })
  const cek = new Uint8Array(await recipient.open(copy(mine.ct), utf8(reader.did)))
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copy(enc.iv), additionalData: aad(did, opaqueKey) }, key, copy(enc.ct)))
  return decode<PrivatePayload>(plain)
}

/** An opaque key for a private record: 16 random bytes, base64url. Says nothing about the record. */
export function opaqueKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Buffer.from(bytes).toString('base64url')
}

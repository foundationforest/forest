// did:key, for two key types. A profile is named by its ed25519 signing key; a reader (for private
// records) by its X25519 key. The method is the W3C did:key method, unchanged: "did:key:z" + base58btc
// of a multicodec prefix and the raw public key. The identifier is the key, so there is no directory
// to ask and nothing to register.

import { b58, concat } from './codec.ts'

const ED25519_PREFIX = new Uint8Array([0xed, 0x01])
const X25519_PREFIX = new Uint8Array([0xec, 0x01])

export type KeyType = 'ed25519' | 'x25519'

export function didFromKey(publicKey: Uint8Array, type: KeyType = 'ed25519'): string {
  if (publicKey.length !== 32) throw new Error('a public key is 32 bytes')
  const prefix = type === 'ed25519' ? ED25519_PREFIX : X25519_PREFIX
  return `did:key:z${b58.encode(concat(prefix, publicKey))}`
}

export function keyFromDid(did: string): { type: KeyType; publicKey: Uint8Array } {
  if (!did.startsWith('did:key:z')) throw new Error(`not a did:key: ${did}`)
  const bytes = b58.decode(did.slice('did:key:z'.length))
  if (bytes.length !== 34) throw new Error(`did:key has the wrong length: ${did}`)
  if (bytes[0] === 0xed && bytes[1] === 0x01) return { type: 'ed25519', publicKey: bytes.subarray(2) }
  if (bytes[0] === 0xec && bytes[1] === 0x01) return { type: 'x25519', publicKey: bytes.subarray(2) }
  throw new Error(`did:key of an unsupported key type: ${did}`)
}

export function isProfileDid(did: unknown): did is string {
  if (typeof did !== 'string') return false
  try {
    return keyFromDid(did).type === 'ed25519'
  } catch {
    return false
  }
}

export function isReaderDid(did: unknown): did is string {
  if (typeof did !== 'string') return false
  try {
    return keyFromDid(did).type === 'x25519'
  } catch {
    return false
  }
}

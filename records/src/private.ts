// Private records: a body only chosen reading keys open. The body on a host is
// `{ private: <age file, base64url> }`. The age file is the envelope: it wraps one random file key
// to each reading key (X25519) and names none of them. The record around it is signed as usual, so
// no reader can forge content for the others.
//
// What this does not hide: that a private record exists, its path, time and size, and how many
// reading keys it was made for (one stanza each). Removing a reader means a new version made for
// the rest; a reader keeps whatever it already opened. No forward secrecy: a reading key that
// leaks later opens every envelope ever made for it.

import { bech32 } from '@scure/base'
import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption'
import { b64u } from './bytes.ts'
import { canonical, parseCanonical } from './canonical.ts'
import { INFO, derive } from './keys.ts'
import { type Body, isPrivate } from './record.ts'

export { isPrivate }

export type ReadingKey = {
  /** age's X25519 identity: what opens envelopes. Kept on the device, like the profile key. */
  identity: string
  /** Its age recipient, `age1…`: what the profile record's `read` field publishes. */
  recipient: string
}

/** A profile's reading key: HKDF of the profile's private key, used as an age X25519 identity. */
export async function readingKey(profileSecret: Uint8Array): Promise<ReadingKey> {
  if (profileSecret.length !== 32) throw new Error('a profile private key is 32 bytes')
  const identity = bech32.encodeFromBytes('AGE-SECRET-KEY-', derive(profileSecret, INFO.read)).toUpperCase()
  return { identity, recipient: await identityToRecipient(identity) }
}

/** A private body: `body` in an envelope only these reading keys (age recipients) open. */
export async function makePrivate(body: Body, readers: string[]): Promise<{ private: string }> {
  if (!readers.length) throw new Error('make it for at least one reading key')
  const encrypter = new Encrypter()
  for (const reader of readers) {
    if (!/^age1[02-9ac-hj-np-z]{58}$/.test(reader)) throw new Error('a reading key is an age X25519 recipient, age1…')
    encrypter.addRecipient(reader)
  }
  return { private: b64u.encode(await encrypter.encrypt(canonical(body))) }
}

/** Open a private body with a reading key's identity. Throws if the envelope was not made for it. */
export async function openPrivate(body: Body, identity: string): Promise<Body> {
  if (!isPrivate(body)) throw new Error('not a private body')
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  const value = parseCanonical(await decrypter.decrypt(b64u.decode(body.private), 'text'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('a private body holds an object')
  return value
}

/** How many reading keys an envelope was made for: visible to anyone, hosts included. */
export function readerCount(body: { private: string }): number {
  const bytes = b64u.decode(body.private)
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).split('\n---')[0] ?? ''
  return header.split('\n').filter((line) => line.startsWith('-> ')).length
}

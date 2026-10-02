// Private records: a body only chosen reading keys open. The body on a host is
// `{ private: <age file, base64url> }`. The age file is the envelope: it wraps one random file key
// to each reading key and names none of them. A reading key is age's post-quantum hybrid
// (mlkem768x25519: ML-KEM-768 with X25519), which keys/ mixes from the profile key; its recipient,
// `age1pq1…`, is what the profile record's `read` field publishes. The record around the envelope
// is signed as usual, so no reader can forge content for the others.
//
// What this does not hide: that a private record exists, its path, time and size, and how many
// reading keys it was made for (one stanza each). Removing a reader means a new version made for
// the rest; a reader keeps whatever it already opened. No forward secrecy: a reading key that
// leaks later opens every envelope ever made for it.

import { Decrypter, Encrypter } from 'age-encryption'
import { b64u } from './bytes.ts'
import { canonical, parseCanonical } from './canonical.ts'
import { type Body, isPrivate } from './record.ts'

export { isPrivate }

/** A private body: `body` in an envelope only these reading keys (age recipients) open. */
export async function makePrivate(body: Body, readers: string[]): Promise<{ private: string }> {
  if (!readers.length) throw new Error('make it for at least one reading key')
  const encrypter = new Encrypter()
  for (const reader of readers) {
    // age checks the rest of the recipient when it is added.
    if (typeof reader !== 'string' || !reader.startsWith('age1pq1')) throw new Error('a reading key is an age post-quantum hybrid recipient, age1pq1…')
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

// Sealed entries: a body only chosen readers can open. The body on the host is
// `{ sealed: <age file, base64url> }`; the age file wraps one random key to each reader's
// recipient (post-quantum hybrid by default) and names none of them. The entry around it is
// signed as usual, so no reader can forge content for the others.
//
// What this does not hide: that a sealed entry exists, its path, time and size, and how many
// readers it has (one header line each). Removing a reader means a new version sealed to the
// rest; a reader keeps whatever it already opened. No forward secrecy: a box key that leaks
// later opens every past entry sealed to it.

import { bech32 } from '@scure/base'
import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption'
import { b64u } from './bytes.ts'
import { canonical, parseCanonical } from './canonical.ts'
import { type Body, isSealed } from './entry.ts'
import { LABELS, derive } from './keys.ts'

export { isSealed }

export type BoxKey = {
  /** age's post-quantum hybrid identity (ML-KEM-768 + X25519), from a 32-byte seed. */
  identity: string
  /** What goes in the folder, for others to seal entries to: `age1pq1…`. */
  recipient: string
}

/** The profile's box key: one label from the seed, used as age's hybrid identity. */
export async function boxKey(seed: Uint8Array, n: number): Promise<BoxKey> {
  const identity = bech32.encodeFromBytes('AGE-SECRET-KEY-PQ-', derive(seed, LABELS.box(n))).toUpperCase()
  return { identity, recipient: await identityToRecipient(identity) }
}

export async function seal(body: Body, recipients: string[]): Promise<Body> {
  if (!recipients.length) throw new Error('seal to at least one reader')
  const encrypter = new Encrypter()
  for (const recipient of recipients) encrypter.addRecipient(recipient)
  return { sealed: b64u.encode(await encrypter.encrypt(canonical(body))) }
}

/** Open a sealed body with a box identity. Throws if this identity is not among its readers. */
export async function open(body: Body, identity: string): Promise<Body> {
  if (!isSealed(body)) throw new Error('not a sealed body')
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  const text = await decrypter.decrypt(b64u.decode(body.sealed), 'text')
  const value = parseCanonical(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('a sealed body holds an object')
  return value
}

/** How many readers a sealed body has: visible to anyone, hosts included. */
export function readerCount(body: { sealed: string }): number {
  const bytes = b64u.decode(body.sealed)
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).split('\n---')[0] ?? ''
  return header.split('\n').filter((line) => line.startsWith('-> ')).length
}

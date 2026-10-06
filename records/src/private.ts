// Private records: a body only chosen keys open. The body on a host is
// `{ private: <age file, base64url> }`. The age file is the envelope: one random file key per
// record, sealed once to each key, naming none of them. Each key is age's post-quantum hybrid
// (mlkem768x25519: ML-KEM-768 with X25519); its public half is `age1pq1…`. The keys are read keys
// the owner's app makes, one for each reader, and usually the owner's own inbox key, which keys/
// mixes from the main key and the profile record's `inboxKey` field publishes. The record around
// the envelope is signed as usual, so no reader can forge content for the others.
//
// What this does not hide: that a private record exists, its path, time and size, and how many
// keys it was made for (one stanza each). Removing a reader means a new version made for the rest;
// a reader keeps whatever it already opened. No forward secrecy: a key that leaks later opens every
// envelope ever made for it.
//
// A message's body is one of these envelopes, made for the recipient's inbox key and its inbox's
// readers. message() seals and signs one; openMessage() checks one and opens it. The grants a
// person received are one private record at `grants`, made for their own inbox key alone.

import { Decrypter, Encrypter } from 'age-encryption'
import { b64u } from './bytes.ts'
import { type Json, canonical, parseCanonical } from './canonical.ts'
import { GRANTS_PATH, type Grant, checkGrant } from './grant.ts'
import type { Key } from './keys.ts'
import { type Sender, type SignedMessage, decodeMessage, encodeMessage, sealedTo, signMessage } from './message.ts'
import { type Body, RecordError, type SignedRecord, isPrivate } from './record.ts'
import { ownerRecord } from './write.ts'

export { isPrivate }

/** A private body: `body` in an envelope only these keys (age recipients) open. */
export async function makePrivate(body: Body, readers: string[]): Promise<{ private: string }> {
  if (!readers.length) throw new Error('make it for at least one key')
  const encrypter = new Encrypter()
  for (const reader of readers) {
    // age checks the rest of the recipient when it is added.
    if (typeof reader !== 'string' || !reader.startsWith('age1pq1')) throw new Error('a key is an age post-quantum hybrid recipient, age1pq1…')
    encrypter.addRecipient(reader)
  }
  return { private: b64u.encode(await encrypter.encrypt(canonical(body))) }
}

/** Open a private body with a key's identity. Throws if the envelope was not made for it. */
export async function openPrivate(body: Body, identity: string): Promise<Body> {
  if (!isPrivate(body)) throw new Error('not a private body')
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  const value = parseCanonical(await decrypter.decrypt(b64u.decode(body.private), 'text'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('a private body holds an object')
  return value
}

/** How many keys an envelope was made for: visible to anyone, hosts included. */
export function readerCount(body: { private: string }): number {
  const bytes = b64u.decode(body.private)
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).split('\n---')[0] ?? ''
  return header.split('\n').filter((line) => line.startsWith('-> ')).length
}

/**
 * A message to `to`'s inbox: `body` sealed, in one envelope, to the inbox key and every reader
 * `card` (to's profile record body) gives, and nothing else; then signed by the sender's own key,
 * or by a message key for its main key.
 */
export async function message(sender: Sender, to: string, body: Body, time: number, card: Body): Promise<SignedMessage> {
  return signMessage(sender, to, await makePrivate(body, sealedTo(card)), time)
}

/**
 * A message, as wire text or signed, checked, then its body opened with the identity of the
 * recipient's inbox key or of one of its readers. `key` is there when a message key sent it.
 */
export async function openMessage(message: SignedMessage | string, identity: string): Promise<{ id: string; from: string; to: string; time: number; body: Body; key?: string }> {
  const { message: m, id } = decodeMessage(typeof message === 'string' ? message : encodeMessage(message))
  return { id, from: m.from, to: m.to, time: m.time, body: await openPrivate(m.body, identity), ...(m.key !== undefined && { key: m.key }) }
}

/** The grants record: the grants a profile received, at `grants`, sealed to its own inbox key alone. */
export async function grantsRecord(owner: Key, inboxKey: string, grants: Grant[], time: number): Promise<SignedRecord> {
  for (const grant of grants) checkGrant(grant)
  return ownerRecord(owner, GRANTS_PATH, await makePrivate({ grants: grants as unknown as Json[] }, [inboxKey]), time)
}

/** The grants in a grants record's body, opened with the profile's inbox key identity, each checked. */
export async function openGrants(body: Body, identity: string): Promise<Grant[]> {
  const inside = await openPrivate(body, identity)
  if (Object.keys(inside).length !== 1 || !Array.isArray(inside.grants)) throw new RecordError('grant', 'a grants record holds { grants: [ … ] } and nothing else')
  for (const grant of inside.grants) checkGrant(grant)
  return inside.grants as unknown as Grant[]
}

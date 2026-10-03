// A message: a sealed note any key delivers to a profile's inbox, on that profile's hosts. It is not
// a record: no path, no versions, no newest-wins, and a host serves it only to its recipient.
//
//   { v: 1, to, from, time, body: { private }, sig }
//
// `sig` is Ed25519 (RFC 8032, strict) by `from` over 0xff || "forest/v1/message\n" || JCS(the
// rest). A pull request, `{ v: 1, profile, after, time, sig }`, is signed the same way by the
// profile's main key over 0xff || "forest/v1/pull\n" || JCS(the rest). Each prefix differs from a
// record's, so no signature is ever two of them, and none is a Solana transaction's.
//
// Nothing here seals or opens a body: that needs age, and is message() and openMessage() in
// private.ts.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64u, concat, equalBytes, hex, utf8 } from './bytes.ts'
import { type Json, canonical, parseCanonical } from './canonical.ts'
import { type Key, publicKeyFromAddress } from './keys.ts'
import { type Body, MAX_FUTURE_MS, MAX_RECORD_BYTES, RecordError, verifySignature } from './record.ts'

export const MESSAGE_PREFIX = concat(Uint8Array.of(0xff), utf8('forest/v1/message\n'))
export const PULL_PREFIX = concat(Uint8Array.of(0xff), utf8('forest/v1/pull\n'))
/** The largest message, as canonical text: the same cap as a record's. */
export const MAX_MESSAGE_BYTES = MAX_RECORD_BYTES

/** A sealed body: an age file, base64url, that only the recipient's reading key opens. */
export type SealedBody = { private: string }
export type UnsignedMessage = {
  v: 1
  /** The recipient profile's address. */
  to: string
  /** The sender's address: its main key, or any ed25519 key. */
  from: string
  time: number
  body: SealedBody
}
export type SignedMessage = UnsignedMessage & { sig: string }
/** A message whose shape and size checked, with its id. */
export type CheckedMessage = { message: SignedMessage; id: string }

export type UnsignedPull = {
  v: 1
  /** The profile whose inbox is pulled; its main key signs. */
  profile: string
  /** The cursor: messages that arrived after it. 0 for all. */
  after: number
  time: number
}
export type SignedPull = UnsignedPull & { sig: string }

function fail(code: string, message: string): never {
  throw new RecordError(code, message)
}

const isObject = (value: unknown): value is { [key: string]: unknown } => value !== null && typeof value === 'object' && !Array.isArray(value)
const only = (value: object, fields: string[], what: string) => {
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail('shape', `unknown ${what} field ${key}`)
}
const SIG = /^[A-Za-z0-9_-]{86}$/
const B64U = /^[A-Za-z0-9_-]+$/

function checkSize(text: string) {
  if (text.length > MAX_MESSAGE_BYTES || utf8(text).length > MAX_MESSAGE_BYTES) fail('size', `a message is at most ${MAX_MESSAGE_BYTES} bytes`)
}

function checkSig(value: { [key: string]: unknown }, signed: boolean) {
  if (signed) {
    if (typeof value.sig !== 'string' || !SIG.test(value.sig)) fail('shape', 'sig is 64 bytes in base64url')
  } else if ('sig' in value) fail('shape', 'an unsigned message carries no sig')
}

// ---------------------------------------------------------------------------------------------
// Messages

/** Everything about a message but its signature and size. Throws RecordError. */
export function checkMessageShape(value: unknown, signed = true): asserts value is SignedMessage {
  if (!isObject(value)) fail('shape', 'a message is an object')
  only(value, ['v', 'to', 'from', 'time', 'body', 'sig'], 'message')
  if (value.v !== 1) fail('version', 'v must be 1')
  if (!publicKeyFromAddress(value.to)) fail('key', 'to is not a usable ed25519 address')
  if (!publicKeyFromAddress(value.from)) fail('key', 'from is not a usable ed25519 address')
  if (!Number.isSafeInteger(value.time) || (value.time as number) < 0) fail('time', 'time is whole milliseconds since 1970')
  const body = value.body
  if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.private !== 'string' || !B64U.test(body.private)) {
    fail('body', 'a message body is { private: <age file, base64url> } and nothing else')
  }
  checkSig(value, signed)
}

export function unsignedMessageOf(message: SignedMessage): UnsignedMessage {
  const { sig: _sig, ...rest } = message
  return rest
}

export function messageSigningInput(unsigned: UnsignedMessage): Uint8Array {
  return concat(MESSAGE_PREFIX, utf8(canonical(unsigned)))
}

/** The message's id: lowercase hex of SHA-256 of what was signed, as a record's id is. */
export function messageId(unsigned: UnsignedMessage): string {
  return hex.encode(sha256(messageSigningInput(unsigned)))
}

/** Sign a sealed body to `to`. Sealing it is message() in private.ts. */
export function signMessage(from: Key, to: string, body: SealedBody, time: number): SignedMessage {
  const unsigned: UnsignedMessage = { v: 1, to, from: from.address, time, body }
  checkMessageShape(unsigned, false)
  if (!equalBytes(ed25519.getPublicKey(from.privateKey), publicKeyFromAddress(from.address)!)) fail('key', 'the private key is not the address from names')
  const message: SignedMessage = { ...unsigned, sig: b64u.encode(ed25519.sign(messageSigningInput(unsigned), from.privateKey)) }
  checkSize(canonical(message))
  return message
}

/** A message's wire form: exactly its canonical text. */
export function encodeMessage(message: SignedMessage): string {
  return canonical(message)
}

/**
 * Read one message off the wire without checking its signature: size, canonical text, shape, id.
 * A host runs its cheap checks before the signature. Throws RecordError.
 */
export function readMessage(text: string): CheckedMessage {
  checkSize(text)
  let value: Json
  try {
    value = parseCanonical(text)
  } catch (err) {
    return fail('canonical', (err as Error).message)
  }
  checkMessageShape(value)
  return { message: value, id: messageId(unsignedMessageOf(value)) }
}

/** Whether `from` signed the message: strict Ed25519, as a record's. */
export function verifyMessage({ message }: CheckedMessage): boolean {
  return verifySignature(b64u.decode(message.sig), messageSigningInput(unsignedMessageOf(message)), publicKeyFromAddress(message.from)!)
}

/** Read one message off the wire: every check, the signature included. Throws RecordError. */
export function decodeMessage(text: string): CheckedMessage {
  const checked = readMessage(text)
  if (!verifyMessage(checked)) fail('signature', 'the signature does not verify')
  return checked
}

// ---------------------------------------------------------------------------------------------
// Pull requests

export function pullSigningInput(unsigned: UnsignedPull): Uint8Array {
  return concat(PULL_PREFIX, utf8(canonical(unsigned)))
}

function checkPullShape(value: unknown, signed = true): asserts value is SignedPull {
  if (!isObject(value)) fail('shape', 'a pull request is an object')
  only(value, ['v', 'profile', 'after', 'time', 'sig'], 'pull')
  if (value.v !== 1) fail('version', 'v must be 1')
  if (!publicKeyFromAddress(value.profile)) fail('key', 'profile is not a usable ed25519 address')
  if (!Number.isSafeInteger(value.after) || (value.after as number) < 0) fail('shape', 'after is a cursor: a whole number')
  if (!Number.isSafeInteger(value.time) || (value.time as number) < 0) fail('time', 'time is whole milliseconds since 1970')
  checkSig(value, signed)
}

/** A request for the messages to `owner`'s profile that arrived after the cursor, signed by its main key at `time`. */
export function pullRequest(owner: Key, after: number, time: number): SignedPull {
  const unsigned: UnsignedPull = { v: 1, profile: owner.address, after, time }
  checkPullShape(unsigned, false)
  if (!equalBytes(ed25519.getPublicKey(owner.privateKey), publicKeyFromAddress(owner.address)!)) fail('key', 'the private key is not the profile’s')
  return { ...unsigned, sig: b64u.encode(ed25519.sign(pullSigningInput(unsigned), owner.privateKey)) }
}

/**
 * A pull request off the wire, at the host's clock `now`: canonical text and shape, then its time
 * within ten minutes of `now` either way [stale], then the profile's main key's signature
 * [signature]. Throws RecordError.
 */
export function checkPull(text: string, now: number): SignedPull {
  let value: Json
  try {
    value = parseCanonical(text)
  } catch (err) {
    return fail('canonical', (err as Error).message)
  }
  checkPullShape(value)
  if (Math.abs(value.time - now) > MAX_FUTURE_MS) fail('stale', 'a pull is signed within ten minutes of the host’s clock')
  const { sig, ...unsigned } = value
  if (!verifySignature(b64u.decode(sig), pullSigningInput(unsigned), publicKeyFromAddress(value.profile)!)) fail('signature', 'the profile’s main key did not sign this pull')
  return value
}

// ---------------------------------------------------------------------------------------------
// The inbox a profile declares

export type Inbox = {
  /** Who may deliver: anyone, or a key holding a registry row from this issuer, under any label. */
  senders: 'anyone' | { issuer: string }
  /** One message from each sender, ever. */
  once?: true
  /** The largest message it takes, as canonical text in bytes. */
  maxBytes?: number
}

/**
 * The inbox a profile record's body declares: null when it declares none (no `inbox` field, or a
 * deleted or private card), 'unsupported' when it holds a rule, a field or a value this code does
 * not know. A host refuses deliveries to an inbox it cannot read rather than guess: a field it
 * skipped could be a limit the profile set, so a new kind of rule can be added later without an
 * old host taking what it should refuse.
 */
export function inboxOf(body: Body | null | undefined): Inbox | null | 'unsupported' {
  if (!body || !('inbox' in body)) return null
  const inbox = body.inbox
  if (!isObject(inbox) || Object.keys(inbox).some((key) => !['senders', 'once', 'maxBytes'].includes(key))) return 'unsupported'
  const { senders, once, maxBytes } = inbox
  let rule: Inbox['senders']
  if (senders === 'anyone') rule = 'anyone'
  else if (isObject(senders) && Object.keys(senders).length === 1 && publicKeyFromAddress(senders.issuer)) rule = { issuer: senders.issuer as string }
  else return 'unsupported'
  if ('once' in inbox && once !== true) return 'unsupported'
  if ('maxBytes' in inbox && (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 0)) return 'unsupported'
  return { senders: rule, ...(once === true && { once }), ...('maxBytes' in inbox && { maxBytes: maxBytes as number }) }
}

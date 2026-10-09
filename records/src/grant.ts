// A grant: how an access key reaches the one it is for. Its private half and what it is for,
// handed over as a message body `{ grant }`, sealed to the recipient's inbox key alone, and kept by
// whoever received it in the private record at `grants`, sealed to their profile's own inbox key
// (grantsRecord and openGrants in private.ts). It holds a private key, and may hold the names,
// dates and reasons the permissions record never carries, so it is never public.
//
// A note: the owner's own record of a key it handed out, in the grant shape, but naming the key by
// its public half, as the permissions record lists it. Who holds a key, until when and why needs
// nothing private, so a leaked inbox key never leaks the keys the notes are about. The notes ride
// in the permissions record, sealed to the owner's own inbox key alone (makeNotes and openNotes in
// private.ts).

import { b64u } from './bytes.ts'
import { publicKeyFromAddress } from './keys.ts'
import { RECIPIENT, RecordError, checkAccessPaths } from './record.ts'

/** The fixed path of the private record where a person keeps the grants they received. */
export const GRANTS_PATH = 'grants'
/** A read key's private half: an age post-quantum hybrid identity, as age writes it. */
export const IDENTITY = /^AGE-SECRET-KEY-PQ-1[02-9AC-HJ-NP-Z]{58}$/

export type Grant = {
  /** The private half: a read key's age identity (AGE-SECRET-KEY-PQ-1…), or any other key's 32 bytes in base64url. */
  key: string
  /** The profile whose permissions record lists the key. */
  folder: string
  scope: 'write' | 'message' | 'read'
  /** As in the permissions record: only for a write or read key. */
  paths?: string[]
  /** Who handed it over. */
  from: string
  /** When, in ms since 1970. */
  since: number
  note?: string
}

/** A note on one key the owner handed out: a grant whose `key` is its public half, as the permissions record lists it. */
export type Note = Grant

function fail(message: string): never {
  throw new RecordError('grant', message)
}

/** 32 bytes in base64url without padding, in their one spelling. */
function isPrivateHalf(key: unknown): boolean {
  if (typeof key !== 'string' || key.length !== 43) return false
  try {
    const bytes = b64u.decode(key)
    return bytes.length === 32 && b64u.encode(bytes) === key
  } catch {
    return false
  }
}

/** A grant's shape: every field as above, and nothing else. Throws RecordError with code `grant`. */
export function checkGrant(value: unknown): asserts value is Grant {
  checkShape(value, 'grant', (g) => {
    if (g.scope === 'read' ? typeof g.key !== 'string' || !IDENTITY.test(g.key) : !isPrivateHalf(g.key)) {
      fail(g.scope === 'read' ? 'a read key is an age post-quantum hybrid identity' : 'a key is its 32 private bytes in base64url')
    }
  })
}

/** A note's shape: a grant's, with the key's public half. Throws RecordError with code `grant`. */
export function checkNote(value: unknown): asserts value is Note {
  checkShape(value, 'note', (n) => {
    if (n.scope === 'read' ? typeof n.key !== 'string' || !RECIPIENT.test(n.key) : !publicKeyFromAddress(n.key)) {
      fail(n.scope === 'read' ? 'a note names a read key by its age recipient, age1pq1…' : 'a note names a key by its address')
    }
  })
}

function checkShape(value: unknown, what: string, checkKey: (g: { [key: string]: unknown }) => void) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`a ${what} is an object`)
  const g = value as { [key: string]: unknown }
  for (const key of Object.keys(g)) if (!['key', 'folder', 'scope', 'paths', 'from', 'since', 'note'].includes(key)) fail(`unknown ${what} field ${key}`)
  if (!['write', 'message', 'read'].includes(g.scope as string)) fail('scope is one of write, message, read')
  checkKey(g)
  if (!publicKeyFromAddress(g.folder)) fail('folder is not a usable ed25519 address')
  if ('paths' in g) {
    if (g.scope === 'message') fail('a message key has no paths')
    checkAccessPaths(g.paths, 'grant')
  }
  if (!publicKeyFromAddress(g.from)) fail('from is not a usable ed25519 address')
  if (!Number.isSafeInteger(g.since) || (g.since as number) < 0) fail('since is whole milliseconds since 1970')
  if ('note' in g && typeof g.note !== 'string') fail('note is text')
}

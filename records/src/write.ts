// Making records: what an app does before publishing them.

import type { Key } from './keys.ts'
import { type Body, type SignedRecord, type Writer, signRecord } from './record.ts'
import type { View } from './view.ts'

/**
 * The time for a new version: the clock, but always after the newest version the writer knows
 * at that path, so a slow clock cannot make an edit lose to what it replaces.
 */
export function nextTime(now: number, view: View | undefined, path: string): number {
  const top = view?.current.get(path)
  return top ? Math.max(now, top.record.time + 1) : now
}

/** A record signed by the profile key itself. */
export function ownerRecord(owner: Key, path: string, body: Body | null, time: number): SignedRecord {
  return signRecord({ v: 1, profile: owner.address, path, time, body }, owner.privateKey)
}

/** A record signed by a writer key, into a profile whose permissions record lists it. */
export function writerRecord(writer: Key, profile: string, path: string, body: Body | null, time: number): SignedRecord {
  return signRecord({ v: 1, profile, path, time, body, by: writer.address }, writer.privateKey)
}

/** Where the profile's records live. */
export function hostsRecord(owner: Key, urls: string[] | null, time: number): SignedRecord {
  return ownerRecord(owner, 'hosts', urls && { urls }, time)
}

/**
 * Which writer keys may write, where, and until when. To remove a writer, set its `until` to now:
 * what it wrote before then still counts. A key left out of the list counts for nothing, so what it
 * wrote stops counting too.
 */
export function permissionsRecord(owner: Key, writers: Writer[] | null, time: number): SignedRecord {
  return ownerRecord(owner, 'permissions', writers && { writers }, time)
}

// Making entries: what an owner's app and a delegate do before publishing.

import { type Body, type Entry, type FolderBody, type GrantBody, entryId, signEntry, unsignedOf } from './entry.ts'
import type { ProfileKey } from './keys.ts'
import type { ProfileView, Version } from './view.ts'

/**
 * The time for a new version: the clock, but always after the newest version the writer knows
 * at that path, so a slow clock cannot make an edit lose to what it replaces.
 */
export function nextTime(now: number, view: ProfileView | undefined, path: string): number {
  const top = view?.current.get(path)
  return top ? Math.max(now, top.entry.time + 1) : now
}

export function ownerEntry(owner: ProfileKey, path: string, body: Body | null, time: number): Entry {
  return signEntry({ v: 1, profile: owner.did, path, time, body }, owner.secretKey)
}

export function delegateEntry(delegate: ProfileKey, profile: string, grant: string, path: string, body: Body | null, time: number): Entry {
  return signEntry({ v: 1, profile, path, time, body, by: delegate.did, grant }, delegate.secretKey)
}

export function folderEntry(owner: ProfileKey, folder: FolderBody | null, time: number): Entry {
  return ownerEntry(owner, 'folder', folder, time)
}

/** A grant, and its id: the id a delegate names in every entry it signs under this version. */
export function grantEntry(owner: ProfileKey, id: string, grant: GrantBody, time: number): { entry: Entry; grantId: string } {
  const entry = ownerEntry(owner, `grant/${id}`, grant, time)
  return { entry, grantId: entryId(unsignedOf(entry)) }
}

/** Revoke: the owner deletes the grant. Everything signed under it stops counting. */
export function revokeEntry(owner: ProfileKey, id: string, time: number): Entry {
  return ownerEntry(owner, `grant/${id}`, null, time)
}

/**
 * "Keep these": after a revocation or an expiry, the owner re-signs, in one approval, the
 * delegate's versions it wants to keep. Owner versions win at their paths from then on.
 */
export function keepAll(owner: ProfileKey, kept: Version[], now: number): Entry[] {
  return kept.map((v) => ownerEntry(owner, v.entry.path, v.entry.body, Math.max(now, v.entry.time + 1)))
}

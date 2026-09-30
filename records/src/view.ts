// The merge: what a profile's folder says, from the entries a reader holds, in the order they
// arrived, at the reader's clock.
//
// A pure function. Its input is one or more feeds: entries in the order one source took them in
// (a host's feed, read by cursor, or an app's own copies). Two readers holding the same feeds at
// the same time compute the same view, whatever order they read the feeds in.
//
// Rules:
//   1. `folder` and `grant/<id>` count only when the owner signed them. Newest wins.
//   2. At a content path, the newest owner version is current if the owner ever wrote there;
//      otherwise the newest delegate version that counts. What you write yourself, a delegate
//      cannot overwrite.
//   3. A delegate version counts if, in some feed, it arrived while the exact grant version it
//      names was current there: after that version, before anything newer at its path (an edit
//      or a revocation). It must be signed by the grant's `to`, at a path the grant covers, and
//      dated no later than `until`. So revoking ends a grant from then on: what arrived before
//      stays, and what arrives after never counts, however it is dated.
//   4. A null body is a delete. Entries dated more than MAX_FUTURE_MS ahead are held back.

import {
  type Checked,
  type FolderBody,
  type GrantBody,
  DEFAULT_KEEP_DAYS,
  MAX_FUTURE_MS,
  isControlPath,
  pathCovers,
} from './entry.ts'

export type Version = Checked
/** Entries in the order one source took them in. */
export type Feed = readonly Version[]

export type Grant = { id: string; path: string; time: number; body: GrantBody }

export type ProfileView = {
  profile: string
  /** The current version of every path. A null body means the path is deleted. */
  current: Map<string, Version>
  /** Older versions that still count, per path, newest first. */
  history: Map<string, Version[]>
  /** undefined: no folder yet. null: the owner closed the profile. */
  folder: FolderBody | null | undefined
  keepDays: number
  /** Current grants (not deleted), by the id of the grant version. One past its `until` is still here. */
  grants: Map<string, Grant>
  /** Entries present that do not count, by id, with the reason. */
  ignored: Map<string, string>
}

/** Newer: later time, then the larger id. */
export function isNewer(a: Version, b: Version): boolean {
  if (a.entry.time !== b.entry.time) return a.entry.time > b.entry.time
  return a.id > b.id
}

const newestFirst = (a: Version, b: Version): number => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0)

/**
 * Whether a delegate version is taken in, given the grants current where it arrives, by version
 * id. A host asks this of each delegate entry as it arrives (and checks `until` by its own clock);
 * the merge asks it at the place each delegate entry holds in a feed.
 */
export function admission(v: Version, grants: ReadonlyMap<string, Grant>): string | null {
  const g = grants.get(v.entry.grant!)
  if (!g) return 'grant-not-current'
  if (g.body.to !== v.entry.by) return 'grant-not-for-signer'
  if (!g.body.paths.some((prefix) => pathCovers(prefix, v.entry.path))) return 'out-of-scope'
  if (v.entry.time > g.body.until) return 'after-until'
  return null
}

export function viewProfile(profile: string, feeds: Iterable<Feed>, now: number): ProfileView {
  const ignored = new Map<string, string>()
  const byPath = new Map<string, Map<string, Version>>()
  const admitted = new Set<string>()
  const refused = new Map<string, string>()

  for (const feed of feeds) {
    // Walking this feed in its order: the grants current so far, and the newest owner version at
    // each grant path so far.
    const live = new Map<string, Grant>()
    const newest = new Map<string, Version>()
    for (const v of feed) {
      const { entry } = v
      if (entry.profile !== profile) continue
      if (entry.time > now + MAX_FUTURE_MS) {
        ignored.set(v.id, 'future')
        continue
      }
      let atPath = byPath.get(entry.path)
      if (!atPath) byPath.set(entry.path, (atPath = new Map()))
      atPath.set(v.id, v)
      if (entry.by === undefined) {
        if (!entry.path.startsWith('grant/')) continue
        const top = newest.get(entry.path)
        if (top && !isNewer(v, top)) continue
        if (top) live.delete(top.id)
        newest.set(entry.path, v)
        if (entry.body !== null) live.set(v.id, { id: v.id, path: entry.path, time: entry.time, body: entry.body as GrantBody })
      } else if (!admitted.has(v.id)) {
        const reason = admission(v, live)
        if (reason === null) admitted.add(v.id)
        else if (!refused.has(v.id)) refused.set(v.id, reason)
      }
    }
  }

  const current = new Map<string, Version>()
  const history = new Map<string, Version[]>()
  const grants = new Map<string, Grant>()
  for (const [path, atPath] of byPath) {
    const all = [...atPath.values()]
    const owned = all.filter((v) => v.entry.by === undefined)
    let winners = owned
    if (owned.length) {
      for (const v of all) if (v.entry.by !== undefined) ignored.set(v.id, 'owner-first')
    } else {
      winners = all.filter((v) => admitted.has(v.id))
      for (const v of all) if (!admitted.has(v.id)) ignored.set(v.id, refused.get(v.id) ?? 'grant-not-current')
    }
    winners.sort(newestFirst)
    if (winners.length) current.set(path, winners[0]!)
    if (winners.length > 1) history.set(path, winners.slice(1))
    const top = current.get(path)
    if (path.startsWith('grant/') && top && top.entry.body !== null) grants.set(top.id, { id: top.id, path, time: top.entry.time, body: top.entry.body as GrantBody })
  }

  const folderVersion = current.get('folder')
  const folder = folderVersion === undefined ? undefined : (folderVersion.entry.body as FolderBody | null)
  const keepDays = folder?.keep ?? DEFAULT_KEEP_DAYS
  return { profile, current, history, folder, keepDays, grants, ignored }
}

/** Views of every profile present in a set of feeds. Each feed keeps its order within each profile. */
export function viewAll(feeds: Iterable<Feed>, now: number): Map<string, ProfileView> {
  const byProfile = new Map<string, Version[][]>()
  for (const feed of feeds) {
    const parts = new Map<string, Version[]>()
    for (const v of feed) {
      let part = parts.get(v.entry.profile)
      if (!part) parts.set(v.entry.profile, (part = []))
      part.push(v)
    }
    for (const [profile, part] of parts) {
      let list = byProfile.get(profile)
      if (!list) byProfile.set(profile, (list = []))
      list.push(part)
    }
  }
  const views = new Map<string, ProfileView>()
  for (const [profile, list] of byProfile) views.set(profile, viewProfile(profile, list, now))
  return views
}

/** The live content of a view: current versions that are not deletes, control paths left out. */
export function liveContent(view: ProfileView): Map<string, Version> {
  const out = new Map<string, Version>()
  for (const [path, v] of view.current) if (!isControlPath(path) && v.entry.body !== null) out.set(path, v)
  return out
}

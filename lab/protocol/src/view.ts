// The merge: what a profile's folder says, from any set of checked entries, at a reader's clock.
//
// A pure function. Two readers holding the same entries at the same time compute the same view,
// whatever order or hosts the entries came from. Hosts use it to decide what to keep; indexes
// and apps use it to decide what to show.
//
// Rules:
//   1. `folder` and `grant/<id>` count only when the owner signed them. Newest wins.
//   2. At a content path, the newest owner version is current if the owner ever wrote there;
//      otherwise the newest delegate version that counts. What you write yourself, an assistant
//      cannot overwrite.
//   3. A delegate version counts only while the exact grant version it names is current at its
//      path, names the signer, covers the path segment by segment, and the reader's clock is not
//      past the grant's `until`. Revoking, editing or reviving a grant, and expiry, all end what
//      was signed under it. Nothing depends on the signer's clock but the order of its own versions.
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

export type LiveGrant = { id: string; path: string; time: number; body: GrantBody }

export type ProfileView = {
  profile: string
  /** The current version of every path. A null body means the path is deleted. */
  current: Map<string, Version>
  /** Older versions that still count, per path, newest first. */
  history: Map<string, Version[]>
  /** undefined: no folder yet. null: the owner closed the profile. */
  folder: FolderBody | null | undefined
  keepDays: number
  /** Live grants, by the id of the grant version. */
  grants: Map<string, LiveGrant>
  /** Entries present that do not count, by id, with the reason. */
  ignored: Map<string, string>
}

/** Newer: later time, then the larger id. */
export function isNewer(a: Version, b: Version): boolean {
  if (a.entry.time !== b.entry.time) return a.entry.time > b.entry.time
  return a.id > b.id
}

const newestFirst = (a: Version, b: Version): number => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0)

export function delegateReason(v: Version, grants: Map<string, LiveGrant>, now: number): string | null {
  const g = grants.get(v.entry.grant!)
  if (!g) return 'grant-not-current'
  if (g.body.to !== v.entry.by) return 'grant-not-for-signer'
  if (!g.body.paths.some((prefix) => pathCovers(prefix, v.entry.path))) return 'out-of-scope'
  if (v.entry.time < g.time) return 'before-grant'
  if (v.entry.time > g.body.until) return 'after-until'
  if (now > g.body.until) return 'grant-expired'
  return null
}

export function viewProfile(profile: string, versions: Iterable<Version>, now: number): ProfileView {
  const ignored = new Map<string, string>()
  const byPath = new Map<string, Map<string, Version>>()
  for (const v of versions) {
    if (v.entry.profile !== profile) continue
    if (v.entry.time > now + MAX_FUTURE_MS) {
      ignored.set(v.id, 'future')
      continue
    }
    let atPath = byPath.get(v.entry.path)
    if (!atPath) byPath.set(v.entry.path, (atPath = new Map()))
    atPath.set(v.id, v)
  }

  const current = new Map<string, Version>()
  const history = new Map<string, Version[]>()
  const settle = (path: string, winners: Version[]) => {
    winners.sort(newestFirst)
    if (winners.length) current.set(path, winners[0]!)
    if (winners.length > 1) history.set(path, winners.slice(1))
  }

  // Control paths first: grants decide which delegate versions count.
  const grants = new Map<string, LiveGrant>()
  for (const [path, atPath] of byPath) {
    if (!isControlPath(path)) continue
    const owned = [...atPath.values()].filter((v) => v.entry.by === undefined)
    settle(path, owned)
    const top = current.get(path)
    if (path.startsWith('grant/') && top && top.entry.body !== null) {
      grants.set(top.id, { id: top.id, path, time: top.entry.time, body: top.entry.body as GrantBody })
    }
  }

  for (const [path, atPath] of byPath) {
    if (isControlPath(path)) continue
    const all = [...atPath.values()]
    const owned = all.filter((v) => v.entry.by === undefined)
    if (owned.length) {
      settle(path, owned)
      for (const v of all) if (v.entry.by !== undefined) ignored.set(v.id, 'owner-first')
      continue
    }
    const counting: Version[] = []
    for (const v of all) {
      const reason = delegateReason(v, grants, now)
      if (reason) ignored.set(v.id, reason)
      else counting.push(v)
    }
    settle(path, counting)
  }

  const folderVersion = current.get('folder')
  const folder = folderVersion === undefined ? undefined : (folderVersion.entry.body as FolderBody | null)
  const keepDays = folder?.keep ?? DEFAULT_KEEP_DAYS
  return { profile, current, history, folder, keepDays, grants, ignored }
}

/** Views of every profile present in a set of entries. */
export function viewAll(versions: Iterable<Version>, now: number): Map<string, ProfileView> {
  const byProfile = new Map<string, Version[]>()
  for (const v of versions) {
    let list = byProfile.get(v.entry.profile)
    if (!list) byProfile.set(v.entry.profile, (list = []))
    list.push(v)
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

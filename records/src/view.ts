// The view: what a profile's folder says, from whatever records a reader holds, at the reader's
// clock. A pure function of the set of records: where they came from and in what order does not
// matter, so two readers holding the same records agree.
//
// Rules:
//   1. Records dated more than MAX_FUTURE_MS ahead of the reader's clock are held back.
//   2. `hosts` and `permissions` are the owner's alone (the shape check refuses a writer there).
//      The newest is current.
//   3. At a content path, if the owner ever wrote there, the owner's newest version is current and
//      no writer record counts. Otherwise the newest writer record the current permissions record
//      allows: its key is listed, one of its paths covers the record's path, and the record is
//      dated no later than `until`. Nothing else about a writer record matters: not when it
//      arrived, not which permissions version was current then. So removing a writer from
//      permissions makes every record it signed stop counting at once.
//   4. Newest: the later time, then the larger id. A null body is a delete.

import { type Checked, type HostsBody, MAX_FUTURE_MS, type PermissionsBody, type SignedRecord, type Writer, isControlPath, pathCovers } from './record.ts'

export type View = {
  profile: string
  /** The current version of every path. A null body means the path is deleted. */
  current: Map<string, Checked>
  /** The current hosts record's urls; empty if there is none, or it was deleted. */
  hosts: string[]
  /** The current permissions record's writers; empty if there is none, or it was deleted. */
  writers: Writer[]
  /** Records present that do not count, by id, with the reason. */
  ignored: Map<string, 'future' | 'older' | 'owner-wins' | 'not-allowed'>
}

/** Newer: later time, then the larger id. */
export function isNewer(a: Checked, b: Checked): boolean {
  if (a.record.time !== b.record.time) return a.record.time > b.record.time
  return a.id > b.id
}

/**
 * Whether the writers listed allow a writer record: its key, a path that covers it, and a time no
 * later than `until`. A host also passes its own clock, so nothing arriving after `until` is taken.
 */
export function allows(writers: readonly Writer[], record: SignedRecord, now = 0): boolean {
  return writers.some((w) => w.key === record.by && w.paths.some((p) => pathCovers(p, record.path)) && Math.max(record.time, now) <= w.until)
}

export function viewProfile(profile: string, records: Iterable<Checked>, now: number): View {
  const ignored: View['ignored'] = new Map()
  const byPath = new Map<string, Map<string, Checked>>()
  for (const c of records) {
    if (c.record.profile !== profile) continue
    if (c.record.time > now + MAX_FUTURE_MS) {
      ignored.set(c.id, 'future')
      continue
    }
    let atPath = byPath.get(c.record.path)
    if (!atPath) byPath.set(c.record.path, (atPath = new Map()))
    atPath.set(c.id, c)
  }

  const newest = (list: Checked[]) => list.reduce((a, b) => (isNewer(b, a) ? b : a))
  const permissions = byPath.get('permissions')
  const writers = permissions ? ((newest([...permissions.values()]).record.body as PermissionsBody | null)?.writers ?? []) : []

  const current = new Map<string, Checked>()
  for (const [path, atPath] of byPath) {
    const all = [...atPath.values()]
    let candidates = all.filter((c) => c.record.by === undefined)
    if (candidates.length) {
      for (const c of all) if (c.record.by !== undefined) ignored.set(c.id, 'owner-wins')
    } else {
      candidates = all.filter((c) => allows(writers, c.record))
      for (const c of all) if (!candidates.includes(c)) ignored.set(c.id, 'not-allowed')
    }
    if (!candidates.length) continue
    const top = newest(candidates)
    current.set(path, top)
    for (const c of candidates) if (c !== top) ignored.set(c.id, 'older')
  }

  const hosts = (current.get('hosts')?.record.body as HostsBody | null | undefined)?.urls ?? []
  return { profile, current, hosts, writers, ignored }
}

/** The live content of a view: current versions that are not deletes, control records left out. */
export function liveContent(view: View): Map<string, Checked> {
  const out = new Map<string, Checked>()
  for (const [path, c] of view.current) if (!isControlPath(path) && c.record.body !== null) out.set(path, c)
  return out
}

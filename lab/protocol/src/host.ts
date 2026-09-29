// A host: plain HTTP and one SQLite file. It holds no keys, has no accounts and asks for no
// login: an entry's signature is its only credential. It checks every entry, stores the ones
// that count, serves them to anyone in the order it took them in, and forgets old versions after
// the owner's `keep` days.
//
//   POST /v1/entries                               NDJSON of canonical entries; one NDJSON result each
//   GET  /v1/entries?after=&profile=&badged=1      NDJSON of stored entries in arrival order;
//                                                  header forest-cursor: the last sequence number
//
// Anything it refuses beyond the protocol's checks is its own policy, from two things: the
// signature on every entry (which key wrote what) and the public registry (which keys hold a
// badge). It logs nothing about who asks.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import {
  type Checked,
  type Entry,
  EntryError,
  type FolderBody,
  MAX_ENTRY_BYTES,
  MAX_FUTURE_MS,
  decodeEntry,
  encodeEntry,
  normalizeOrigin,
} from './entry.ts'
import { type ProfileView, type Version, admission, viewProfile } from './view.ts'

export const DAY = 86_400_000
/** Entries per request. */
export const MAX_BATCH = 100
const MAX_REQUEST_BYTES = MAX_BATCH * (MAX_ENTRY_BYTES + 1)

/** What a host's own policy can go on, besides the entry itself. */
export type Facts = {
  /** The registry's answer for this profile's key. */
  badged: boolean
  /** The first folder of a profile this host never held. */
  newProfile: boolean
  /** What this host already stores for the profile. */
  stored: { entries: number; bytes: number }
}
/** A host's own policy: null takes the entry; a reason refuses it. Folders of held profiles always pass. */
export type Policy = (entry: Entry, facts: Facts) => string | null | Promise<string | null>

export type HostOptions = {
  /** This host's origin, exactly as folders name it. */
  url: string
  /** SQLite file; in memory when omitted. */
  file?: string
  now?: () => number
  /** The public registry: does this key hold a badge? The key is the wallet the badge names. */
  isBadged?: (did: string) => boolean | Promise<boolean>
  policy?: Policy
}

export type Result = { i: number; id?: string; ok: boolean; error?: string; message?: string }
export type ReadOptions = { after?: number; profile?: string; badged?: boolean; limit?: number }

type ProfileRow = { profile: string; state: 'held' | 'left' | 'closed'; badged: number }

export class Host {
  readonly url: string
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly isBadged: (did: string) => boolean | Promise<boolean>
  private readonly policy?: Policy
  private server?: Server

  constructor(options: HostOptions) {
    const url = normalizeOrigin(options.url)
    if (!url) throw new Error('a host is named by an https origin (http only on loopback)')
    this.url = url
    this.now = options.now ?? Date.now
    this.isBadged = options.isBadged ?? (() => false)
    this.policy = options.policy
    this.db = new DatabaseSync(options.file ?? ':memory:')
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        profile TEXT NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        keep INTEGER NOT NULL DEFAULT 1,   -- 1: current and counting, or held for good
        stale_since INTEGER                -- this host's clock when it stopped counting
      );
      CREATE INDEX IF NOT EXISTS entries_by_profile ON entries (profile, seq);
      CREATE TABLE IF NOT EXISTS profiles (
        profile TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        badged INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  // ------------------------------------------------------------------------------------------
  // Writing

  /** Take a batch of entries (wire text), check each, store what counts. */
  async accept(lines: string[]): Promise<Result[]> {
    if (lines.length > MAX_BATCH) return [{ i: 0, ok: false, error: 'batch', message: `at most ${MAX_BATCH} entries a request` }]
    const now = this.now()
    const results: Result[] = []
    const decoded: Array<{ i: number; checked: Checked }> = []
    lines.forEach((line, i) => {
      try {
        const checked = decodeEntry(line)
        if (checked.entry.time > now + MAX_FUTURE_MS) results.push({ i, id: checked.id, ok: false, error: 'future', message: 'dated more than ten minutes ahead' })
        else decoded.push({ i, checked })
      } catch (err) {
        const code = err instanceof EntryError ? err.code : 'invalid'
        results.push({ i, ok: false, error: code, message: (err as Error).message })
      }
    })
    // Folders first, so a new profile can arrive in one request; the rest in the order sent,
    // which is the order the feed will show.
    decoded.sort((a, b) => Number(b.checked.entry.path === 'folder') - Number(a.checked.entry.path === 'folder') || a.i - b.i)
    for (const { i, checked } of decoded) results.push({ i, id: checked.id, ...(await this.acceptOne(checked, now)) })
    return results.sort((a, b) => a.i - b.i)
  }

  private async acceptOne({ entry, id }: Checked, now: number): Promise<{ ok: boolean; error?: string; message?: string }> {
    if (this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(id)) return { ok: true, message: 'already here' }
    const profile = this.profileRow(entry.profile)

    if (entry.path === 'folder') {
      const folder = entry.body as FolderBody | null
      if (!profile) {
        // A profile this host never held: its first folder must name this host.
        if (!folder || !folder.hosts.includes(this.url)) return { ok: false, error: 'not-named', message: 'the folder does not name this host' }
        const badged = await this.isBadged(entry.profile)
        const refused = await this.policy?.(entry, { badged, newProfile: true, stored: { entries: 0, bytes: 0 } })
        if (refused) return { ok: false, error: 'policy', message: refused }
        this.db.prepare('INSERT INTO profiles (profile, state, badged) VALUES (?, ?, ?)').run(entry.profile, 'held', badged ? 1 : 0)
      } else {
        // A profile it holds or held: a newer folder always passes, so a person can always leave.
        const top = this.view(entry.profile, now).current.get('folder')
        if (top && !isNewerVersion(entry.time, id, top)) return { ok: false, error: 'stale', message: 'a newer folder is already here' }
      }
      this.insert(entry, id)
      this.settle(entry.profile, now)
      return { ok: true }
    }

    if (!profile || profile.state !== 'held') return { ok: false, error: 'not-held', message: 'this host does not hold that profile: send its folder naming this host first' }
    if (entry.by !== undefined) {
      // A delegate entry is taken in only while its grant version is current here, and not past
      // `until` by this host's clock. What arrived before a revocation stays.
      const view = this.view(entry.profile, now)
      const top = view.current.get(entry.path)
      if (top && top.entry.by === undefined) return { ok: false, error: 'grant', message: 'owner-first' }
      const reason = admission({ entry, id }, view.grants) ?? (now > view.grants.get(entry.grant!)!.body.until ? 'grant-expired' : null)
      if (reason) return { ok: false, error: 'grant', message: reason }
    }
    const badged = await this.isBadged(entry.profile)
    if (badged !== Boolean(profile.badged)) this.db.prepare('UPDATE profiles SET badged = ? WHERE profile = ?').run(badged ? 1 : 0, entry.profile)
    if (this.policy) {
      const stored = this.db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM entries WHERE profile = ?').get(entry.profile) as Facts['stored']
      const refused = await this.policy(entry, { badged, newProfile: false, stored })
      if (refused) return { ok: false, error: 'policy', message: refused }
    }
    this.insert(entry, id)
    this.settle(entry.profile, now)
    return { ok: true }
  }

  private insert(entry: Entry, id: string) {
    const text = encodeEntry(entry)
    this.db.prepare('INSERT INTO entries (id, profile, text, bytes) VALUES (?, ?, ?, ?)').run(id, entry.profile, text, Buffer.byteLength(text))
  }

  /**
   * Recompute which of a profile's entries count, after any change. Current versions are kept,
   * and so is every grant version a delegate version here arrived under, so a reader that comes
   * later can still place it. The rest get a stale date and are pruned `keep` days later. A
   * profile this host no longer holds keeps only its newest folder and its deletes, so an old
   * folder or old entries replayed here after a move are refused or pruned.
   */
  private settle(profile: string, now: number) {
    const view = this.view(profile, now)
    const folder = view.folder
    const state: ProfileRow['state'] = folder === null ? 'closed' : folder?.hosts.includes(this.url) ? 'held' : 'left'
    this.db.prepare('UPDATE profiles SET state = ? WHERE profile = ?').run(state, profile)
    const keepForGood = new Set<string>()
    for (const [path, v] of view.current) {
      if (state === 'held' || path === 'folder' || v.entry.body === null) keepForGood.add(v.id)
    }
    if (state === 'held') {
      for (const v of [...view.current.values(), ...[...view.history.values()].flat()]) if (v.entry.grant) keepForGood.add(v.entry.grant)
    }
    const rows = this.db.prepare('SELECT id, keep FROM entries WHERE profile = ?').all(profile) as Array<{ id: string; keep: number }>
    const mark = this.db.prepare('UPDATE entries SET keep = ?, stale_since = ? WHERE id = ?')
    for (const row of rows) {
      const keep = keepForGood.has(row.id)
      if (keep && row.keep === 0) mark.run(1, null, row.id)
      else if (!keep && row.keep === 1) mark.run(0, now, row.id)
    }
  }

  /** Delete what stopped counting more than `keep` days ago (the owner's folder sets `keep`). */
  prune(now = this.now()): number {
    let removed = 0
    const profiles = this.db.prepare('SELECT profile FROM profiles').all() as Array<{ profile: string }>
    for (const { profile } of profiles) {
      const keepDays = this.view(profile, now).keepDays
      const result = this.db
        .prepare('DELETE FROM entries WHERE profile = ? AND keep = 0 AND stale_since IS NOT NULL AND stale_since <= ?')
        .run(profile, now - keepDays * DAY)
      removed += Number(result.changes)
    }
    return removed
  }

  /** Ask the registry again about every profile here, for the badged feed. */
  async refreshBadges(): Promise<void> {
    for (const { profile } of this.db.prepare('SELECT profile FROM profiles').all() as Array<{ profile: string }>) {
      this.db.prepare('UPDATE profiles SET badged = ? WHERE profile = ?').run((await this.isBadged(profile)) ? 1 : 0, profile)
    }
  }

  // ------------------------------------------------------------------------------------------
  // Reading

  /**
   * Stored entries in arrival order, as canonical text, after a cursor; for one profile, or only
   * profiles the registry says hold a badge. A profile badged later shows from then on; a reader
   * that wants its earlier entries reads it by profile.
   */
  read(options: ReadOptions = {}): { lines: string[]; cursor: number } {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000)
    const where: string[] = ['seq > ?']
    const args: Array<string | number> = [options.after ?? 0]
    if (options.profile) {
      where.push('profile = ?')
      args.push(options.profile)
    }
    if (options.badged) where.push('profile IN (SELECT profile FROM profiles WHERE badged = 1)')
    const rows = this.db.prepare(`SELECT seq, text FROM entries WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, limit) as Array<{ seq: number; text: string }>
    return { lines: rows.map((r) => r.text), cursor: rows.length ? rows[rows.length - 1]!.seq : (options.after ?? 0) }
  }

  /** This host's own view of a profile, from its feed in arrival order: what it uses to decide what to keep. */
  view(profile: string, now = this.now()): ProfileView {
    const rows = this.db.prepare('SELECT id, text FROM entries WHERE profile = ? ORDER BY seq').all(profile) as Array<{ id: string; text: string }>
    const feed: Version[] = rows.map((r) => ({ id: r.id, entry: JSON.parse(r.text) as Entry }))
    return viewProfile(profile, [feed], now)
  }

  count(profile?: string): number {
    const row = (profile
      ? this.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE profile = ?').get(profile)
      : this.db.prepare('SELECT COUNT(*) AS n FROM entries').get()) as { n: number }
    return row.n
  }

  /** Every stored entry's text: what a host operator can see on its own disk. */
  dump(): string[] {
    return (this.db.prepare('SELECT text FROM entries ORDER BY seq').all() as Array<{ text: string }>).map((r) => r.text)
  }

  private profileRow(profile: string): ProfileRow | undefined {
    return this.db.prepare('SELECT profile, state, badged FROM profiles WHERE profile = ?').get(profile) as ProfileRow | undefined
  }

  // ------------------------------------------------------------------------------------------
  // HTTP

  async listen(port = 0, hostname = '127.0.0.1'): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, hostname, resolve))
    return (this.server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.db.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://host.invalid')
    res.setHeader('access-control-allow-origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end()
      return
    }
    if (url.pathname !== '/v1/entries') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'GET') {
      const num = (name: string) => {
        const v = url.searchParams.get(name)
        return v === null ? undefined : Number.parseInt(v, 10)
      }
      const out = this.read({
        after: num('after'),
        profile: url.searchParams.get('profile') ?? undefined,
        badged: url.searchParams.get('badged') === '1',
        limit: num('limit'),
      })
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'forest-cursor': String(out.cursor), 'access-control-expose-headers': 'forest-cursor' })
      res.end(out.lines.map((l) => l + '\n').join(''))
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req, MAX_REQUEST_BYTES)
      if (body === null) {
        res.writeHead(413).end()
        return
      }
      const results = await this.accept(body.split('\n').filter((l) => l.length > 0))
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(results.map((r) => JSON.stringify(r) + '\n').join(''))
      return
    }
    res.writeHead(405).end()
  }
}

function isNewerVersion(time: number, id: string, than: Version): boolean {
  return time !== than.entry.time ? time > than.entry.time : id > than.id
}

async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// A host: plain HTTP and one SQLite file. It holds no keys, has no accounts and asks for no
// login: an entry's signature is its only credential. It checks every entry, stores the ones
// that count, serves them to anyone, and forgets old versions after the owner's `keep` days.
//
//   POST /v1/entries                         NDJSON of canonical entries; one NDJSON result each
//   GET  /v1/entries?profile=&path=&after=   NDJSON of stored entries in arrival order;
//                                            header forest-cursor: the last sequence number
//   GET  /.well-known/forest                 this host's name, version and limits
//
// It logs nothing about who asks. Per-address budgets for new profiles live in memory only,
// under a keyed hash with a key made at start, and are dropped every hour.

import { createHmac, randomBytes } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import {
  type Checked,
  type Entry,
  EntryError,
  type FolderBody,
  MAX_FUTURE_MS,
  decodeEntry,
  encodeEntry,
  normalizeOrigin,
} from './entry.ts'
import { type ProfileView, type Version, delegateReason, viewProfile } from './view.ts'

export const DAY = 86_400_000
const HOUR = 3_600_000

export type Quota = { entries: number; bytes: number; writesPerMinute: number }
export type Limits = {
  /** A key with no badge: enough for a profile card, a folder, a few offers and reviews. */
  unbadged: Quota
  badged: Quota
  /** New profiles without a badge this host admits per hour, from everyone together. */
  newProfilesPerHour: number
  /** ...and from any one network address. */
  newProfilesPerAddressPerHour: number
  /** Entries per request. */
  batch: number
  /** Bytes per request. */
  requestBytes: number
}

export const DEFAULT_LIMITS: Limits = {
  unbadged: { entries: 100, bytes: 256 * 1024, writesPerMinute: 30 },
  badged: { entries: 20_000, bytes: 64 * 1024 * 1024, writesPerMinute: 600 },
  newProfilesPerHour: 1_000,
  newProfilesPerAddressPerHour: 5,
  batch: 100,
  requestBytes: 8 * 1024 * 1024,
}

export type HostOptions = {
  /** This host's origin, exactly as folders name it. */
  url: string
  /** SQLite file; in memory when omitted. */
  file?: string
  now?: () => number
  /** Does this key hold a badge? The key is the wallet, so a host can ask the registry. */
  isBadged?: (did: string) => boolean | Promise<boolean>
  limits?: Partial<Limits>
  /** Read the first address of X-Forwarded-For (behind a proxy you run). */
  trustProxy?: boolean
}

export type Result = { i: number; id?: string; ok: boolean; error?: string; message?: string }

type Row = { id: string; text: string }
type ProfileRow = { profile: string; state: 'held' | 'left' | 'closed'; badged: number }

export class Host {
  readonly url: string
  readonly limits: Limits
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly isBadged: (did: string) => boolean | Promise<boolean>
  private readonly trustProxy: boolean
  private server?: Server
  // In memory only: hourly budgets for new profiles, and per-key write rates.
  private hour = 0
  private newThisHour = 0
  private readonly newByAddress = new Map<string, number>()
  private addressKey = randomBytes(32)
  private readonly writes = new Map<string, number[]>()

  constructor(options: HostOptions) {
    const url = normalizeOrigin(options.url)
    if (!url) throw new Error('a host is named by an https origin (http only on loopback)')
    this.url = url
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.isBadged = options.isBadged ?? (() => false)
    this.trustProxy = options.trustProxy ?? false
    this.db = new DatabaseSync(options.file ?? ':memory:')
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        profile TEXT NOT NULL,
        path TEXT NOT NULL,
        time INTEGER NOT NULL,
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
  async accept(lines: string[], address = ''): Promise<Result[]> {
    if (lines.length > this.limits.batch) return [{ i: 0, ok: false, error: 'batch', message: `at most ${this.limits.batch} entries a request` }]
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
    // Folders first, then grants, then content: a new profile can arrive in one request.
    const rank = (c: Checked) => (c.entry.path === 'folder' ? 0 : c.entry.path.startsWith('grant/') ? 1 : 2)
    decoded.sort((a, b) => rank(a.checked) - rank(b.checked) || a.i - b.i)
    for (const { i, checked } of decoded) {
      results.push({ i, id: checked.id, ...(await this.acceptOne(checked, now, address)) })
    }
    return results.sort((a, b) => a.i - b.i)
  }

  private async acceptOne({ entry, id }: Checked, now: number, address: string): Promise<{ ok: boolean; error?: string; message?: string }> {
    if (this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(id)) return { ok: true, message: 'already here' }
    const profile = this.profileRow(entry.profile)

    if (entry.path === 'folder') {
      const folder = entry.body as FolderBody | null
      if (!profile) {
        // A profile this host never held: its first folder must name this host, and new
        // profiles without a badge are admitted within an hourly budget.
        if (!folder || !folder.hosts.includes(this.url)) return { ok: false, error: 'not-named', message: 'the folder does not name this host' }
        const badged = await this.isBadged(entry.profile)
        if (!badged && !this.admitNewProfile(now, address)) return { ok: false, error: 'busy', message: 'too many new profiles; try later or another host' }
        this.db.prepare('INSERT INTO profiles (profile, state, badged) VALUES (?, ?, ?)').run(entry.profile, 'held', badged ? 1 : 0)
      } else {
        const top = this.view(entry.profile, now).current.get('folder')
        if (top && !isNewerVersion(entry.time, id, top)) return { ok: false, error: 'stale', message: 'a newer folder is already here' }
      }
      this.insert(entry, id)
      this.settle(entry.profile, now)
      return { ok: true }
    }

    if (!profile || profile.state !== 'held') return { ok: false, error: 'not-held', message: 'this host does not hold that profile: send its folder naming this host first' }
    const quota = profile.badged ? this.limits.badged : this.limits.unbadged
    if (!this.withinRate(entry.profile, quota.writesPerMinute, now)) return { ok: false, error: 'rate', message: 'too many writes this minute' }
    const used = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM entries WHERE profile = ?').get(entry.profile) as { n: number; b: number }
    const bytes = Buffer.byteLength(encodeEntry(entry))
    if (used.n + 1 > quota.entries || used.b + bytes > quota.bytes) return { ok: false, error: 'quota', message: 'this profile is full on this host' }

    if (entry.by !== undefined) {
      const view = this.view(entry.profile, now)
      const reason = delegateReason({ entry, id }, view.grants, now)
      if (reason) return { ok: false, error: 'grant', message: reason }
      const top = view.current.get(entry.path)
      if (top && top.entry.by === undefined) return { ok: false, error: 'grant', message: 'owner-first' }
    }
    this.insert(entry, id)
    this.settle(entry.profile, now)
    return { ok: true }
  }

  private insert(entry: Entry, id: string) {
    const text = encodeEntry(entry)
    this.db
      .prepare('INSERT INTO entries (id, profile, path, time, text, bytes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, entry.profile, entry.path, entry.time, text, Buffer.byteLength(text))
  }

  /**
   * Recompute which of a profile's entries count, after any change. Current versions are kept;
   * the rest get a stale date and are pruned `keep` days later. A profile this host no longer
   * holds keeps only its newest folder and its deletes, so an old folder or old entries replayed
   * here after a move are refused or pruned.
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

  // ------------------------------------------------------------------------------------------
  // Reading

  /** Stored entries in arrival order, as canonical text, after a cursor. */
  read(options: { profile?: string; path?: string; after?: number; limit?: number } = {}): { lines: string[]; cursor: number } {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000)
    const where: string[] = ['seq > ?']
    const args: Array<string | number> = [options.after ?? 0]
    if (options.profile) {
      where.push('profile = ?')
      args.push(options.profile)
    }
    if (options.path) {
      where.push('(path = ? OR substr(path, 1, ?) = ?)')
      args.push(options.path, options.path.length + 1, options.path + '/')
    }
    const rows = this.db.prepare(`SELECT seq, text FROM entries WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, limit) as Array<{ seq: number; text: string }>
    return { lines: rows.map((r) => r.text), cursor: rows.length ? rows[rows.length - 1]!.seq : (options.after ?? 0) }
  }

  /** This host's own view of a profile: what it uses to decide what to keep. */
  view(profile: string, now = this.now()): ProfileView {
    const rows = this.db.prepare('SELECT id, text FROM entries WHERE profile = ?').all(profile) as Row[]
    const versions: Version[] = rows.map((r) => ({ id: r.id, entry: JSON.parse(r.text) as Entry }))
    return viewProfile(profile, versions, now)
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
  // Budgets (memory only)

  private admitNewProfile(now: number, address: string): boolean {
    const hour = Math.floor(now / HOUR)
    if (hour !== this.hour) {
      this.hour = hour
      this.newThisHour = 0
      this.newByAddress.clear()
      this.addressKey = randomBytes(32)
    }
    if (this.newThisHour >= this.limits.newProfilesPerHour) return false
    const tag = createHmac('sha256', this.addressKey).update(address).digest('base64url')
    const fromAddress = this.newByAddress.get(tag) ?? 0
    if (fromAddress >= this.limits.newProfilesPerAddressPerHour) return false
    this.newThisHour++
    this.newByAddress.set(tag, fromAddress + 1)
    return true
  }

  private withinRate(profile: string, perMinute: number, now: number): boolean {
    const recent = (this.writes.get(profile) ?? []).filter((t) => t > now - 60_000)
    if (recent.length >= perMinute) {
      this.writes.set(profile, recent)
      return false
    }
    recent.push(now)
    this.writes.set(profile, recent)
    return true
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
    if (req.method === 'GET' && url.pathname === '/.well-known/forest') {
      json(res, 200, { host: this.url, protocol: 'forest.foundation/entry/v1', limits: this.limits })
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
        profile: url.searchParams.get('profile') ?? undefined,
        path: url.searchParams.get('path') ?? undefined,
        after: num('after'),
        limit: num('limit'),
      })
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'forest-cursor': String(out.cursor), 'access-control-expose-headers': 'forest-cursor' })
      res.end(out.lines.map((l) => l + '\n').join(''))
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req, this.limits.requestBytes)
      if (body === null) {
        res.writeHead(413).end()
        return
      }
      const lines = body.split('\n').filter((l) => l.length > 0)
      const address = this.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : (req.socket.remoteAddress ?? '')
      const results = await this.accept(lines, address)
      const status = results.some((r) => r.error === 'busy' || r.error === 'rate') ? 429 : 200
      res.writeHead(status, { 'content-type': 'application/x-ndjson' })
      res.end(results.map((r) => JSON.stringify(r) + '\n').join(''))
      return
    }
    res.writeHead(405).end()
  }
}

function isNewerVersion(time: number, id: string, than: Version): boolean {
  return time !== than.entry.time ? time > than.entry.time : id > than.id
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
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


// A host: plain HTTP and one SQLite file. It holds no keys, has no accounts and asks for no
// login: a record's signature is its only credential. It is open: it takes signed records for any
// profile and serves them to anyone. It keeps the newest version at each path, and forgets the
// versions that stop being newest after `keepDays`.
//
//   POST /v1/records                      NDJSON of canonical records; one NDJSON result each
//   GET  /v1/records?profile=&after=      NDJSON of stored records in the order taken;
//                                         header forest-cursor: the last sequence number
//
// It logs nothing about who asks.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { MAX_PAGE_BYTES, READ_TIMEOUT_MS } from './client.ts'
import { type Checked, MAX_FUTURE_MS, MAX_RECORD_BYTES, RecordError, type SignedRecord, decodeRecord, encodeRecord, isControlPath } from './record.ts'
import { type View, allowsArrival, viewProfile } from './view.ts'

export const DAY = 86_400_000
/** Records per request. */
export const MAX_BATCH = 100
/** Records per page. */
export const MAX_PAGE_RECORDS = 1000
/** Days a version is kept after it stops being the newest at its path, unless the operator says otherwise. */
export const DEFAULT_KEEP_DAYS = 30
const MAX_REQUEST_BYTES = MAX_BATCH * (MAX_RECORD_BYTES + 1)

/**
 * A host's own policy for content records: null takes the record, a reason refuses it. It is
 * never asked about a hosts or permissions record, so a person can always move and always remove
 * an access key.
 */
export type Policy = (record: SignedRecord, stored: { records: number; bytes: number }) => string | null | Promise<string | null>

export type HostOptions = {
  /** SQLite file; in memory when omitted. */
  file?: string
  now?: () => number
  /** The operator's choice; DEFAULT_KEEP_DAYS when omitted. */
  keepDays?: number
  policy?: Policy
  /** Milliseconds a request may take to arrive in full; past that it gets 408. READ_TIMEOUT_MS when omitted. */
  timeout?: number
}

export type Result = { i: number; id?: string; ok: boolean; error?: string; message?: string }
export type ReadOptions = { after?: number; profile?: string }

export class Host {
  /** Where it listens, once it does. */
  url = ''
  readonly keepDays: number
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly policy?: Policy
  private readonly timeout: number
  private server?: Server
  private pruning?: NodeJS.Timeout

  constructor(options: HostOptions = {}) {
    this.now = options.now ?? Date.now
    this.keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
    this.policy = options.policy
    this.timeout = options.timeout ?? READ_TIMEOUT_MS
    this.db = new DatabaseSync(options.file ?? ':memory:')
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        profile TEXT NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        older_since INTEGER   -- this host's clock when it stopped being the newest at its path
      );
      CREATE INDEX IF NOT EXISTS records_by_profile ON records (profile, seq);
    `)
  }

  // ------------------------------------------------------------------------------------------
  // Writing

  /** Take a request's records (wire text), check each, store what is newest at its path. */
  async accept(lines: string[]): Promise<Result[]> {
    if (lines.length > MAX_BATCH) return [{ i: 0, ok: false, error: 'batch', message: `at most ${MAX_BATCH} records a request` }]
    const now = this.now()
    const results: Result[] = []
    const decoded: Array<{ i: number; checked: Checked }> = []
    lines.forEach((line, i) => {
      try {
        const checked = decodeRecord(line)
        if (checked.record.time > now + MAX_FUTURE_MS) results.push({ i, id: checked.id, ok: false, error: 'future', message: 'dated more than ten minutes ahead' })
        else decoded.push({ i, checked })
      } catch (err) {
        results.push({ i, ok: false, error: err instanceof RecordError ? err.code : 'invalid', message: (err as Error).message })
      }
    })
    // Hosts and permissions records first, so access keys' records sent with their permissions in
    // one request are checked against them; the rest in the order sent.
    const control = (c: Checked) => Number(isControlPath(c.record.path))
    decoded.sort((a, b) => control(b.checked) - control(a.checked) || a.i - b.i)
    for (const { i, checked } of decoded) results.push({ i, id: checked.id, ...(await this.acceptOne(checked, now)) })
    return results.sort((a, b) => a.i - b.i)
  }

  private async acceptOne(c: Checked, now: number): Promise<Omit<Result, 'i' | 'id'>> {
    if (this.db.prepare('SELECT 1 FROM records WHERE id = ?').get(c.id)) return { ok: true, message: 'already here' }
    const { record } = c
    // Kept only if it becomes the newest at its path, with the protocol's own rules.
    const view = viewProfile(record.profile, [...this.stored(record.profile), c], now)
    if (view.current.get(record.path)?.id !== c.id) {
      const reason = view.ignored.get(c.id)
      if (reason === 'owner-wins') return { ok: false, error: 'permission', message: 'the owner wrote at this path' }
      if (reason === 'not-allowed') return { ok: false, error: 'permission', message: 'the permissions record does not allow this access key here' }
      return { ok: false, error: 'older', message: 'a newer version is already here' }
    }
    // An access key's record also needs the key listed for its path now, and its until not passed
    // by this host's clock: a reader checks only the record's own date.
    if (record.by !== undefined && !allowsArrival(view.access, record, now)) return { ok: false, error: 'permission', message: 'this access key is past its until' }
    if (this.policy && !isControlPath(record.path)) {
      const stored = this.db.prepare('SELECT COUNT(*) AS records, COALESCE(SUM(bytes), 0) AS bytes FROM records WHERE profile = ?').get(record.profile) as { records: number; bytes: number }
      const refused = await this.policy(record, stored)
      if (refused) return { ok: false, error: 'policy', message: refused }
    }
    const text = encodeRecord(record)
    this.db.prepare('INSERT INTO records (id, profile, text, bytes) VALUES (?, ?, ?, ?)').run(c.id, record.profile, text, Buffer.byteLength(text))
    this.settle(record.profile, now)
    return { ok: true }
  }

  /** After a change: what is current is kept; what stopped being current gets a date, and goes `keepDays` later. */
  private settle(profile: string, now: number) {
    const current = new Set([...this.view(profile, now).current.values()].map((c) => c.id))
    const rows = this.db.prepare('SELECT id, older_since FROM records WHERE profile = ?').all(profile) as Array<{ id: string; older_since: number | null }>
    const mark = this.db.prepare('UPDATE records SET older_since = ? WHERE id = ?')
    for (const row of rows) {
      if (current.has(row.id) && row.older_since !== null) mark.run(null, row.id)
      else if (!current.has(row.id) && row.older_since === null) mark.run(now, row.id)
    }
  }

  /** Delete what stopped being the newest at its path more than `keepDays` ago. */
  prune(now = this.now()): number {
    return Number(this.db.prepare('DELETE FROM records WHERE older_since IS NOT NULL AND older_since <= ?').run(now - this.keepDays * DAY).changes)
  }

  // ------------------------------------------------------------------------------------------
  // Reading

  /**
   * Stored records in the order taken, as canonical text, after a cursor, for one profile if
   * asked. A page ends before a line that would take it past MAX_PAGE_BYTES; one record always fits.
   */
  read(options: ReadOptions = {}): { lines: string[]; cursor: number } {
    const where = ['seq > ?']
    const args: Array<string | number> = [options.after ?? 0]
    if (options.profile !== undefined) {
      where.push('profile = ?')
      args.push(options.profile)
    }
    const rows = this.db.prepare(`SELECT seq, text, bytes FROM records WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, MAX_PAGE_RECORDS) as Array<{ seq: number; text: string; bytes: number }>
    const lines: string[] = []
    let cursor = options.after ?? 0
    let size = 0
    for (const row of rows) {
      size += row.bytes + 1
      if (size > MAX_PAGE_BYTES) break
      lines.push(row.text)
      cursor = row.seq
    }
    return { lines, cursor }
  }

  /** This host's view of a profile, from what it stores. */
  view(profile: string, now = this.now()): View {
    return viewProfile(profile, this.stored(profile), now)
  }

  /** A profile's stored records. They were checked on the way in. */
  private stored(profile: string): Checked[] {
    const rows = this.db.prepare('SELECT id, text FROM records WHERE profile = ? ORDER BY seq').all(profile) as Array<{ id: string; text: string }>
    return rows.map((r) => ({ id: r.id, record: JSON.parse(r.text) as SignedRecord }))
  }

  count(profile?: string): number {
    const row = (profile === undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM records').get()
      : this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE profile = ?').get(profile)) as { n: number }
    return row.n
  }

  /** Every stored record's text: what a host operator can see on its own disk. */
  dump(): string[] {
    return (this.db.prepare('SELECT text FROM records ORDER BY seq').all() as Array<{ text: string }>).map((r) => r.text)
  }

  // ------------------------------------------------------------------------------------------
  // HTTP

  /** Listen on loopback unless told otherwise, and prune every hour. Returns the url. */
  async listen(port = 0, hostname = '127.0.0.1'): Promise<string> {
    // Node looks for requests past the timeout every 30 seconds by default; every second keeps it near.
    this.server = createServer({ requestTimeout: this.timeout, connectionsCheckingInterval: 1000 }, (req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, hostname, resolve))
    this.pruning = setInterval(() => this.prune(), DAY / 24).unref()
    this.url = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async close(): Promise<void> {
    clearInterval(this.pruning)
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
    if (url.pathname !== '/v1/records') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'GET') {
      const after = url.searchParams.get('after')
      const cursor = after === null ? 0 : Number(after)
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        res.writeHead(400).end()
        return
      }
      const out = this.read({ after: cursor, profile: url.searchParams.get('profile') ?? undefined })
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

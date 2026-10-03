// A host: plain HTTP and one SQLite file. It holds no keys, has no accounts and asks for no
// login: a record's signature is its only credential, and a pull's is the recipient's. It is open:
// it takes signed records for any profile and serves them to anyone; it takes messages for any
// profile whose card here declares an inbox, and serves them only to that profile's main key; it
// takes the bytes a current record names, and serves them to anyone. It keeps the newest version
// at each path; versions that stop being newest, messages, and bytes no current record names any
// more go after `keepDays`.
//
//   POST /v1/records                      NDJSON of canonical records; one NDJSON result each
//   GET  /v1/records?profile=&after=      NDJSON of stored records in the order taken;
//                                         header forest-cursor: the last sequence number
//   POST /v1/inbox                        NDJSON of canonical messages; one NDJSON result each
//   POST /v1/inbox/pull                   a signed pull request; NDJSON of that profile's messages
//                                         after the cursor, in arrival order; header forest-cursor
//   PUT  /v1/blobs/<sha256>               raw bytes, content-type the type a current record names
//   GET  /v1/blobs/<sha256>               the bytes, with that type
//
// How many lines a request or a page holds is this host's choice (maxBatch, maxPageRecords,
// maxPageBytes); a client handles any size. It logs nothing about who asks.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from './bytes.ts'
import { READ_TIMEOUT_MS } from './client.ts'
import { type CheckedMessage, type Inbox, MAX_MESSAGE_BYTES, type SignedMessage, checkPull, inboxOf, readMessage, verifyMessage } from './message.ts'
import { type Body, type Checked, MAX_FUTURE_MS, MAX_RECORD_BYTES, RecordError, type SignedRecord, decodeRecord, encodeRecord, isControlPath } from './record.ts'
import { type View, allowsArrival, viewProfile } from './view.ts'

export const DAY = 86_400_000
/** Records or messages a request carries, unless the operator says otherwise. */
export const DEFAULT_MAX_BATCH = 100
/** Records or messages a page holds, unless the operator says otherwise. */
export const DEFAULT_MAX_PAGE_RECORDS = 1000
/** Bytes a page holds, unless the operator says otherwise. A page always holds at least one line. */
export const DEFAULT_MAX_PAGE_BYTES = 4 * 1024 * 1024
/** Days a replaced version, a message, or bytes no current record names are kept, unless the operator says otherwise. */
export const DEFAULT_KEEP_DAYS = 30
/** The largest blob it reads, unless the operator says otherwise: the largest the record shapes name. */
export const DEFAULT_MAX_BLOB_BYTES = 50_000_000
/** The blob types it takes, unless the operator says otherwise: the ones the record shapes name. */
export const DEFAULT_BLOB_TYPES = ['image/png', 'image/jpeg', 'video/mp4']
/** A pull request is about 200 bytes. */
const MAX_PULL_BYTES = 1024
const HASH = /^[0-9a-f]{64}$/
const BLOB_PATH = /^\/v1\/blobs\/([0-9a-f]{64})$/

/**
 * A host's own policy for content records: null takes the record, a reason refuses it. It is
 * never asked about a hosts or permissions record, so a person can always move and always remove
 * an access key.
 */
export type Policy = (record: SignedRecord, stored: { records: number; bytes: number }) => string | null | Promise<string | null>
/** A host's own policy for messages, from the message and what it holds for that recipient. */
export type MessagePolicy = (message: SignedMessage, stored: { messages: number; bytes: number }) => string | null | Promise<string | null>
/** A host's own policy for blobs, past its size cap. */
export type BlobPolicy = (blob: { sha256: string; type: string; size: number }) => string | null | Promise<string | null>

export const defaultBlobPolicy: BlobPolicy = (blob) => (DEFAULT_BLOB_TYPES.includes(blob.type) ? null : `this host takes ${DEFAULT_BLOB_TYPES.join(', ')}`)

export type HostOptions = {
  /** SQLite file; in memory when omitted. */
  file?: string
  now?: () => number
  /** The operator's choice; DEFAULT_KEEP_DAYS when omitted. */
  keepDays?: number
  policy?: Policy
  /** Milliseconds a request may take to arrive in full; past that it gets 408. READ_TIMEOUT_MS when omitted. */
  timeout?: number
  /** Records or messages a request may carry; DEFAULT_MAX_BATCH when omitted. */
  maxBatch?: number
  /** Records or messages a page holds at most; DEFAULT_MAX_PAGE_RECORDS when omitted. */
  maxPageRecords?: number
  /** Bytes a page holds at most, though always one line; DEFAULT_MAX_PAGE_BYTES when omitted. */
  maxPageBytes?: number
  /**
   * Whether `from` holds a registry row from `issuer`, under any label: a registry lookup, over an
   * RPC the host chooses. Without one, the host takes messages only for inboxes open to anyone.
   */
  rowLookup?: (from: string, issuer: string) => Promise<boolean>
  messagePolicy?: MessagePolicy
  /** The largest blob it reads; DEFAULT_MAX_BLOB_BYTES when omitted. */
  maxBlobBytes?: number
  /** defaultBlobPolicy when omitted. */
  blobPolicy?: BlobPolicy
}

export type Result = { i: number; id?: string; ok: boolean; error?: string; message?: string }
export type ReadOptions = { after?: number; profile?: string }
type Answer = Omit<Result, 'i'>

export class Host {
  /** Where it listens, once it does. */
  url = ''
  readonly keepDays: number
  readonly maxBatch: number
  readonly maxPageRecords: number
  readonly maxPageBytes: number
  readonly maxBlobBytes: number
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly policy?: Policy
  private readonly messagePolicy?: MessagePolicy
  private readonly blobPolicy: BlobPolicy
  private readonly rowLookup?: HostOptions['rowLookup']
  private readonly timeout: number
  private server?: Server
  private pruning?: NodeJS.Timeout

  constructor(options: HostOptions = {}) {
    this.now = options.now ?? Date.now
    this.keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH
    this.maxPageRecords = options.maxPageRecords ?? DEFAULT_MAX_PAGE_RECORDS
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
    this.policy = options.policy
    this.messagePolicy = options.messagePolicy
    this.blobPolicy = options.blobPolicy ?? defaultBlobPolicy
    this.rowLookup = options.rowLookup
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
      CREATE TABLE IF NOT EXISTS blob_names (   -- the bytes each stored record names, by hash and type
        record TEXT NOT NULL,
        profile TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blob_names_by_hash ON blob_names (sha256);
      CREATE INDEX IF NOT EXISTS blob_names_by_profile ON blob_names (profile);
      CREATE INDEX IF NOT EXISTS blob_names_by_record ON blob_names (record);
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data BLOB NOT NULL,
        unnamed_since INTEGER   -- this host's clock when no current record named it any more
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        arrived INTEGER NOT NULL   -- this host's clock
      );
      CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages (recipient, seq);
      -- Who has written to an inbox that takes one message from each sender. Recorded only while
      -- the inbox says so, so who wrote to whom is not kept past the messages for other inboxes.
      -- Kept for as long as the profile is: this host never deletes a current record.
      CREATE TABLE IF NOT EXISTS once_pairs (
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        PRIMARY KEY (sender, recipient)
      ) WITHOUT ROWID;
    `)
  }

  // ------------------------------------------------------------------------------------------
  // Records

  /** Take a request's records (wire text), check each, store what is newest at its path. */
  async accept(lines: string[]): Promise<Result[]> {
    if (lines.length > this.maxBatch) return [{ i: 0, ok: false, error: 'batch', message: `at most ${this.maxBatch} records a request` }]
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
    const name = this.db.prepare('INSERT INTO blob_names (record, profile, sha256, type) VALUES (?, ?, ?, ?)')
    for (const blob of blobNames(record.body)) name.run(c.id, record.profile, blob.sha256, blob.type)
    this.settle(record.profile, now)
    return { ok: true }
  }

  /**
   * After a change: what is current is kept; what stopped being current gets a date, and goes
   * `keepDays` later. So do the bytes this profile's records name, once no current record names them.
   */
  private settle(profile: string, now: number) {
    const current = new Set([...this.view(profile, now).current.values()].map((c) => c.id))
    const rows = this.db.prepare('SELECT id, older_since FROM records WHERE profile = ?').all(profile) as Array<{ id: string; older_since: number | null }>
    const mark = this.db.prepare('UPDATE records SET older_since = ? WHERE id = ?')
    for (const row of rows) {
      if (current.has(row.id) && row.older_since !== null) mark.run(null, row.id)
      else if (!current.has(row.id) && row.older_since === null) mark.run(now, row.id)
    }
    const named = 'EXISTS (SELECT 1 FROM blob_names n JOIN records r ON r.id = n.record WHERE n.sha256 = blobs.sha256 AND n.type = blobs.type AND r.older_since IS NULL)'
    const its = 'sha256 IN (SELECT sha256 FROM blob_names WHERE profile = ?)'
    this.db.prepare(`UPDATE blobs SET unnamed_since = ? WHERE unnamed_since IS NULL AND ${its} AND NOT ${named}`).run(now, profile)
    this.db.prepare(`UPDATE blobs SET unnamed_since = NULL WHERE unnamed_since IS NOT NULL AND ${its} AND ${named}`).run(profile)
  }

  /**
   * Delete what stopped being the newest at its path, the messages that arrived, and the bytes no
   * current record has named, more than `keepDays` ago. Returns how many it deleted.
   */
  prune(now = this.now()): number {
    const before = now - this.keepDays * DAY
    this.db.prepare('DELETE FROM blob_names WHERE record IN (SELECT id FROM records WHERE older_since IS NOT NULL AND older_since <= ?)').run(before)
    const records = this.db.prepare('DELETE FROM records WHERE older_since IS NOT NULL AND older_since <= ?').run(before).changes
    const messages = this.db.prepare('DELETE FROM messages WHERE arrived <= ?').run(before).changes
    const blobs = this.db.prepare('DELETE FROM blobs WHERE unnamed_since IS NOT NULL AND unnamed_since <= ?').run(before).changes
    return Number(records) + Number(messages) + Number(blobs)
  }

  /**
   * Stored records in the order taken, as canonical text, after a cursor, for one profile if
   * asked: at most maxPageRecords, and a page ends before a line that would take it past
   * maxPageBytes, though it always holds one.
   */
  read(options: ReadOptions = {}): { lines: string[]; cursor: number } {
    const where = ['seq > ?']
    const args: Array<string | number> = [options.after ?? 0]
    if (options.profile !== undefined) {
      where.push('profile = ?')
      args.push(options.profile)
    }
    const rows = this.db.prepare(`SELECT seq, text, bytes FROM records WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, this.maxPageRecords) as Row[]
    return this.page(rows, options.after ?? 0)
  }

  private page(rows: Row[], after: number): { lines: string[]; cursor: number } {
    const lines: string[] = []
    let cursor = after
    let size = 0
    for (const row of rows) {
      size += row.bytes + 1
      if (size > this.maxPageBytes && lines.length) break
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

  /** Every stored record's and message's text: what a host operator can see on its own disk. */
  dump(): string[] {
    return (this.db.prepare('SELECT text FROM records UNION ALL SELECT text FROM messages').all() as Array<{ text: string }>).map((r) => r.text)
  }

  // ------------------------------------------------------------------------------------------
  // Messages

  /** Take a request's messages (wire text), check each in the standard's order, store what passes. */
  async deliver(lines: string[]): Promise<Result[]> {
    if (lines.length > this.maxBatch) return [{ i: 0, ok: false, error: 'batch', message: `at most ${this.maxBatch} messages a request` }]
    const now = this.now()
    const inboxes = new Map<string, Inbox | null | 'unsupported'>()
    const results: Result[] = []
    for (const [i, line] of lines.entries()) results.push({ i, ...(await this.deliverOne(line, now, inboxes)) })
    return results
  }

  private async deliverOne(line: string, now: number, inboxes: Map<string, Inbox | null | 'unsupported'>): Promise<Answer> {
    let c: CheckedMessage
    try {
      c = readMessage(line)
    } catch (err) {
      return { ok: false, error: err instanceof RecordError ? err.code : 'invalid', message: (err as Error).message }
    }
    const { message: m, id } = c
    const refuse = (error: string, message: string): Answer => ({ id, ok: false, error, message })
    if (m.time > now + MAX_FUTURE_MS) return refuse('future', 'dated more than ten minutes ahead')
    if (this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return refuse('duplicate', 'this message is already here')
    let inbox = inboxes.get(m.to)
    if (inbox === undefined) inboxes.set(m.to, (inbox = inboxOf(this.view(m.to, now).current.get('profile')?.record.body)))
    if (inbox === null) return refuse('no_inbox', 'the profile record here declares no inbox')
    if (!verifyMessage(c)) return refuse('signature', 'the signature does not verify')
    if (inbox === 'unsupported') return refuse('rule_unsupported', 'this host does not know the inbox’s rule')
    if (inbox.senders !== 'anyone') {
      if (!this.rowLookup) return refuse('rule_unsupported', 'this host has no registry lookup')
      let held: boolean
      try {
        held = await this.rowLookup(m.from, inbox.senders.issuer)
      } catch (err) {
        return refuse('lookup', `the registry lookup failed, try again: ${(err as Error).message}`)
      }
      if (!held) return refuse('sender', 'from holds no registry row from the inbox’s issuer')
    }
    const pair = [m.from, m.to]
    if (inbox.once && this.db.prepare('SELECT 1 FROM once_pairs WHERE sender = ? AND recipient = ?').get(...pair)) return refuse('once', 'this inbox takes one message from each sender')
    const bytes = Buffer.byteLength(line)
    if (inbox.maxBytes !== undefined && bytes > inbox.maxBytes) return refuse('too_big', `this inbox takes messages of at most ${inbox.maxBytes} bytes`)
    if (this.messagePolicy) {
      const stored = this.db.prepare('SELECT COUNT(*) AS messages, COALESCE(SUM(bytes), 0) AS bytes FROM messages WHERE recipient = ?').get(m.to) as { messages: number; bytes: number }
      const refused = await this.messagePolicy(m, stored)
      if (refused) return refuse('policy', refused)
    }
    // Checked again here, with no wait in between: another request may have taken the same id or
    // pair during a lookup or the policy.
    if (inbox.once && !this.db.prepare('INSERT OR IGNORE INTO once_pairs (sender, recipient) VALUES (?, ?)').run(...pair).changes) return refuse('once', 'this inbox takes one message from each sender')
    if (!this.db.prepare('INSERT OR IGNORE INTO messages (id, recipient, text, bytes, arrived) VALUES (?, ?, ?, ?, ?)').run(id, m.to, line, bytes, now).changes) return refuse('duplicate', 'this message is already here')
    return { id, ok: true }
  }

  /**
   * A pull (wire text): checked at this host's clock, then a page of that profile's messages after
   * the cursor, in arrival order, paged as records are. Throws RecordError.
   */
  pull(text: string, now = this.now()): { lines: string[]; cursor: number } {
    const request = checkPull(text, now)
    const rows = this.db.prepare('SELECT seq, text, bytes FROM messages WHERE recipient = ? AND seq > ? ORDER BY seq LIMIT ?').all(request.profile, request.after, this.maxPageRecords) as Row[]
    return this.page(rows, request.after)
  }

  // ------------------------------------------------------------------------------------------
  // Blobs

  /**
   * Take bytes: they must hash to `sha256` [hash], a current record here must name that hash as
   * `type` [unnamed], and this host must take their size and type [policy].
   */
  async putBlob(name: string, type: string, bytes: Uint8Array): Promise<Answer> {
    if (hex.encode(sha256(bytes)) !== name) return { ok: false, error: 'hash', message: 'the bytes do not hash to their name' }
    if (!this.named(name, type)) return { ok: false, error: 'unnamed', message: 'no current record here names these bytes as this type' }
    if (this.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(name)) return { ok: true, message: 'already here' }
    const refused = bytes.length > this.maxBlobBytes ? `at most ${this.maxBlobBytes} bytes` : await this.blobPolicy({ sha256: name, type, size: bytes.length })
    if (refused) return { ok: false, error: 'policy', message: refused }
    this.db.prepare('INSERT OR IGNORE INTO blobs (sha256, type, data) VALUES (?, ?, ?)').run(name, type, bytes)
    return { ok: true }
  }

  /** Held bytes and their type, or undefined. */
  getBlob(name: string): { type: string; bytes: Uint8Array } | undefined {
    const row = this.db.prepare('SELECT type, data FROM blobs WHERE sha256 = ?').get(name) as { type: string; data: Uint8Array } | undefined
    return row && { type: row.type, bytes: row.data }
  }

  private named(name: string, type: string): boolean {
    return this.db.prepare('SELECT 1 FROM blob_names n JOIN records r ON r.id = n.record WHERE n.sha256 = ? AND n.type = ? AND r.older_since IS NULL').get(name, type) !== undefined
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
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT', 'access-control-allow-headers': 'content-type' }).end()
      return
    }
    const blob = BLOB_PATH.exec(url.pathname)?.[1]
    const methods = url.pathname === '/v1/records' ? ['GET', 'POST'] : url.pathname === '/v1/inbox' || url.pathname === '/v1/inbox/pull' ? ['POST'] : blob ? ['GET', 'PUT'] : []
    if (!methods.length) {
      res.writeHead(404).end()
      return
    }
    if (!methods.includes(req.method ?? '')) {
      res.writeHead(405, { allow: methods.join(', ') }).end()
      return
    }

    if (blob && req.method === 'GET') {
      const held = this.getBlob(blob)
      if (!held) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': held.type, 'content-length': held.bytes.length }).end(held.bytes)
      return
    }
    if (blob) {
      const tooBig = { ok: false, error: 'policy', message: `at most ${this.maxBlobBytes} bytes` }
      if (Number(req.headers['content-length'] ?? 0) > this.maxBlobBytes) return sendJson(res, 413, tooBig)
      const bytes = await readBody(req, this.maxBlobBytes)
      if (bytes === null) return sendJson(res, 413, tooBig)
      const answer = await this.putBlob(blob, (req.headers['content-type'] ?? '').trim(), bytes)
      return sendJson(res, answer.ok ? 200 : 400, answer)
    }

    if (url.pathname === '/v1/inbox/pull') {
      const body = await readBody(req, MAX_PULL_BYTES)
      if (body === null) return sendJson(res, 413, { ok: false, error: 'size', message: `a pull request is at most ${MAX_PULL_BYTES} bytes` })
      let out: { lines: string[]; cursor: number }
      try {
        out = this.pull(body.toString('utf8'))
      } catch (err) {
        if (!(err instanceof RecordError)) throw err
        return sendJson(res, 400, { ok: false, error: err.code, message: err.message })
      }
      return sendLines(res, out)
    }

    if (req.method === 'GET') {
      const after = url.searchParams.get('after')
      const cursor = after === null ? 0 : Number(after)
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        res.writeHead(400).end()
        return
      }
      return sendLines(res, this.read({ after: cursor, profile: url.searchParams.get('profile') ?? undefined }))
    }

    // POST /v1/records or /v1/inbox: NDJSON in, one NDJSON result a line out.
    const inbox = url.pathname === '/v1/inbox'
    const body = await readBody(req, this.maxBatch * ((inbox ? MAX_MESSAGE_BYTES : MAX_RECORD_BYTES) + 1))
    if (body === null) {
      res.writeHead(413).end()
      return
    }
    const lines = body.toString('utf8').split('\n').filter((l) => l.length > 0)
    const results = inbox ? await this.deliver(lines) : await this.accept(lines)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.end(results.map((r) => JSON.stringify(r) + '\n').join(''))
  }
}

type Row = { seq: number; text: string; bytes: number }

/** The bytes a record's body names: its photo, and each of its media. */
function blobNames(body: Body | null): Array<{ sha256: string; type: string }> {
  if (!body) return []
  const refs = [body.photo, ...(Array.isArray(body.media) ? body.media : [])]
  const names: Array<{ sha256: string; type: string }> = []
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) continue
    if (typeof ref.sha256 === 'string' && HASH.test(ref.sha256) && typeof ref.mimeType === 'string') names.push({ sha256: ref.sha256, type: ref.mimeType })
  }
  return names
}

function sendJson(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

function sendLines(res: ServerResponse, out: { lines: string[]; cursor: number }) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'forest-cursor': String(out.cursor), 'access-control-expose-headers': 'forest-cursor' })
  res.end(out.lines.map((l) => l + '\n').join(''))
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

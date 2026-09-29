// The host. Stores logs, pointers and blobs; verifies every entry with the same rules any reader
// uses; signs nothing; has no accounts, no sessions and no log of who called. Anyone can run one.
// It is one HTTP server over one SQLite file. Everything it serves is public bytes (private records
// are ciphertext), so anyone can copy a log out of it and take it elsewhere.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { b64, blobCid, cidOf, decode, encode, toJson } from './codec.ts'
import { EntryError, MAX_ENTRY_BYTES, applyEntry, decodeEntry, emptyState, type State } from './entry.ts'
import { keyFromDid } from './did.ts'
import { verifySignature } from './keys.ts'
import { verifyPointer } from './pointer.ts'
import { signingMessage as permitMessage, checkPermit, type Permit } from './permit.ts'

export const CLOCK_SKEW_SECONDS = 300
export const MAX_BLOB_BYTES = 50_000_000

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void> | void

export class HostError extends Error {
  status: number
  code: string
  extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export type HostOptions = {
  /** SQLite file, or ':memory:'. */
  path: string
  /** Its own public URL, as it would appear in a pointer. Informational. */
  url?: string
  /** A clock, for tests. Unix seconds. */
  now?: () => number
}

export class Host {
  db: DatabaseSync
  server: Server
  now: () => number
  url: string
  private states = new Map<string, State>()
  private stmts

  constructor(opts: HostOptions) {
    this.db = new DatabaseSync(opts.path)
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.url = opts.url ?? ''
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        did TEXT NOT NULL, seq INTEGER NOT NULL, cid TEXT NOT NULL, bytes BLOB NOT NULL,
        UNIQUE (did, seq)
      );
      CREATE TABLE IF NOT EXISTS pointers (did TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (did TEXT NOT NULL, cid TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (did, cid));
    `)
    this.stmts = {
      log: this.db.prepare('SELECT seq, cid, bytes FROM entries WHERE did = ? AND seq >= ? ORDER BY seq'),
      insert: this.db.prepare('INSERT INTO entries (did, seq, cid, bytes) VALUES (?, ?, ?, ?)'),
      changes: this.db.prepare('SELECT cursor, did, seq, cid, bytes FROM entries WHERE cursor > ? ORDER BY cursor LIMIT ?'),
      pointerGet: this.db.prepare('SELECT seq, payload FROM pointers WHERE did = ?'),
      pointerPut: this.db.prepare('INSERT INTO pointers (did, seq, payload) VALUES (?, ?, ?) ON CONFLICT (did) DO UPDATE SET seq = excluded.seq, payload = excluded.payload'),
      blobPut: this.db.prepare('INSERT OR IGNORE INTO blobs (did, cid, mime, bytes) VALUES (?, ?, ?, ?)'),
      blobGet: this.db.prepare('SELECT mime, bytes FROM blobs WHERE did = ? AND cid = ?'),
      dids: this.db.prepare('SELECT DISTINCT did FROM entries'),
    }
    this.server = createServer((req, res) => void this.handle(req, res))
  }

  listen(port = 0): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server.address()
        const actual = typeof address === 'object' && address ? address.port : port
        if (!this.url) this.url = `http://127.0.0.1:${actual}`
        resolve(this.url)
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        this.db.close()
        resolve()
      })
    })
  }

  // State per profile, folded from the stored entries once and kept.

  state(did: string): State {
    const cached = this.states.get(did)
    if (cached) return cached
    keyFromDid(did)
    let state = emptyState(did)
    for (const row of this.stmts.log.all(did, 0) as { bytes: Uint8Array }[]) {
      const { entry, cid } = decodeEntry(row.bytes)
      state = applyEntry(state, entry, cid)
    }
    this.states.set(did, state)
    return state
  }

  /** The one write. Verifies, then stores; the same for a profile key, a delegate, or a mirror. */
  append(bytes: Uint8Array): { seq: number; cid: string } {
    const { entry, cid } = decodeEntry(bytes)
    const drift = Math.abs(entry.at - this.now())
    if (drift > CLOCK_SKEW_SECONDS) throw new HostError(400, 'clock', `entry.at is ${drift} seconds from this host's clock; the limit is ${CLOCK_SKEW_SECONDS}`)
    const state = this.state(entry.did)
    let next: State
    try {
      next = applyEntry(state, entry, cid)
    } catch (e) {
      if (e instanceof EntryError) {
        const head = state.head ? { seq: state.head.seq, cid: state.head.cid.toString() } : null
        throw new HostError(e.code === 'seq' || e.code === 'prev' ? 409 : 400, e.code, e.message, { head })
      }
      throw e
    }
    this.stmts.insert.run(entry.did, entry.seq, cid.toString(), bytes)
    this.states.set(entry.did, next)
    return { seq: entry.seq, cid: cid.toString() }
  }

  log(did: string, since = 0): { seq: number; cid: string; bytes: Uint8Array }[] {
    return this.stmts.log.all(did, since) as { seq: number; cid: string; bytes: Uint8Array }[]
  }

  dids(): string[] {
    return (this.stmts.dids.all() as { did: string }[]).map((r) => r.did)
  }

  /** Copies a log from another host, verifying every entry as if the writer had sent it. */
  async pull(did: string, from: string): Promise<{ seq: number; cid: string } | null> {
    const state = this.state(did)
    const since = state.head ? state.head.seq + 1 : 0
    const res = await fetch(`${from.replace(/\/+$/, '')}/log/${did}?since=${since}`)
    if (!res.ok) throw new HostError(502, 'pull', `${from} answered ${res.status}`)
    const body = (await res.json()) as { entries: string[] }
    let last: { seq: number; cid: string } | null = state.head ? { seq: state.head.seq, cid: state.head.cid.toString() } : null
    for (const b of body.entries) last = this.append(b64.decode(b))
    return last
  }

  // HTTP. No address is read, kept or logged anywhere in this file.

  private routes: [string, RegExp, Handler][] = [
    ['GET', /^\/$/, (_req, res) => json(res, 200, { ok: true, url: this.url })],
    ['GET', /^\/log\/([^/]+)$/, (_req, res, [did], url) => {
      const since = Number(url.searchParams.get('since') ?? 0)
      const rows = this.log(did!, since)
      const head = this.state(did!).head
      json(res, 200, { did, head: head ? { seq: head.seq, cid: head.cid.toString() } : null, entries: rows.map((r) => b64.encode(r.bytes)) })
    }],
    ['POST', /^\/log\/([^/]+)$/, async (req, res, [did]) => {
      const bytes = await body(req, MAX_ENTRY_BYTES)
      if (decodeEntry(bytes).entry.did !== did) throw new HostError(400, 'shape', 'entry is for another profile')
      json(res, 201, this.append(bytes))
    }],
    ['GET', /^\/state\/([^/]+)$/, (_req, res, [did]) => {
      const s = this.state(did!)
      const collections: Record<string, number> = {}
      for (const k of s.records.keys()) {
        const col = k.split('\u0000')[0]!
        collections[col] = (collections[col] ?? 0) + 1
      }
      json(res, 200, {
        did,
        head: s.head ? { seq: s.head.seq, cid: s.head.cid.toString(), at: s.head.at } : null,
        reader: s.reader,
        grants: [...s.grants.values()].map((g) => ({ cid: g.cid, seq: g.seq, used: g.used, revokedAt: g.revokedAt ?? null, ...g.grant })),
        collections,
        privates: s.privates.size,
      })
    }],
    ['GET', /^\/record\/([^/]+)\/([^/]+)\/([^/]+)$/, (_req, res, [did, col, key]) => {
      const r = this.state(did!).records.get(`${col}\u0000${decodeURIComponent(key!)}`)
      if (!r) throw new HostError(404, 'not-found', 'no such record')
      json(res, 200, { did, col, key: decodeURIComponent(key!), seq: r.seq, cid: r.cid, rec: toJson(r.rec) })
    }],
    ['GET', /^\/records\/([^/]+)\/([^/]+)$/, (_req, res, [did, col]) => {
      const out = []
      for (const [k, r] of this.state(did!).records) {
        const [c, key] = k.split('\u0000')
        if (c === col) out.push({ key, seq: r.seq, cid: r.cid, rec: toJson(r.rec) })
      }
      json(res, 200, { did, col, records: out })
    }],
    ['GET', /^\/private\/([^/]+)$/, (_req, res, [did]) => {
      const out = []
      for (const [key, p] of this.state(did!).privates) out.push({ key, seq: p.seq, cid: p.cid, enc: toJson(p.enc) })
      json(res, 200, { did, privates: out })
    }],
    ['GET', /^\/pointer\/([^/]+)$/, (_req, res, [did]) => {
      const row = this.stmts.pointerGet.get(did!) as { payload: Uint8Array } | undefined
      if (!row) throw new HostError(404, 'not-found', 'no pointer for this profile')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(row.payload)
    }],
    ['PUT', /^\/pointer\/([^/]+)$/, async (req, res, [did]) => {
      const payload = await body(req, 1072)
      const pointer = verifyPointer(did!, payload)
      const row = this.stmts.pointerGet.get(did!) as { seq: number } | undefined
      if (row && row.seq >= pointer.seq) throw new HostError(409, 'seq', 'a newer pointer is already stored')
      this.stmts.pointerPut.run(did!, pointer.seq, payload)
      res.writeHead(204)
      res.end()
    }],
    ['GET', /^\/changes$/, (_req, res, _p, url) => {
      const since = Number(url.searchParams.get('since') ?? 0)
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000)
      const rows = this.stmts.changes.all(since, limit) as { cursor: number; did: string; seq: number; cid: string; bytes: Uint8Array }[]
      json(res, 200, { cursor: rows.length ? rows[rows.length - 1]!.cursor : since, changes: rows.map((r) => ({ cursor: r.cursor, did: r.did, seq: r.seq, cid: r.cid, entry: b64.encode(r.bytes) })) })
    }],
    ['POST', /^\/pull$/, async (req, res) => {
      const { did, from } = JSON.parse(new TextDecoder().decode(await body(req, 4096))) as { did: string; from: string }
      json(res, 200, { did, head: await this.pull(did, from) })
    }],
    ['POST', /^\/blob\/([^/]+)$/, async (req, res, [did]) => {
      const permitHeader = req.headers['x-forest-permit']
      if (typeof permitHeader !== 'string') throw new HostError(401, 'permit', 'a blob upload carries a signed permit')
      const bytes = await body(req, MAX_BLOB_BYTES)
      const cid = blobCid(bytes)
      const permit = decode<Permit>(b64.decode(permitHeader))
      checkPermit(permit)
      if (permit.did !== did || permit.cid !== cid.toString()) throw new HostError(403, 'permit', 'the permit names another profile or another blob')
      if (permit.exp < this.now()) throw new HostError(403, 'permit', 'the permit expired')
      const state = this.state(did!)
      let signerDid = did!
      if (permit.by !== undefined) {
        const g = state.grants.get(permit.via!)
        if (!g || g.grant.to !== permit.by || g.revokedAt !== undefined || g.grant.exp < this.now() || !g.grant.ops.includes('put')) {
          throw new HostError(403, 'permit', 'no live grant lets this key upload for this profile')
        }
        signerDid = permit.by
      }
      const { sig, ...unsigned } = permit
      if (!verifySignature(keyFromDid(signerDid).publicKey, permitMessage(unsigned), sig)) throw new HostError(403, 'permit', 'permit signature does not verify')
      this.stmts.blobPut.run(did!, cid.toString(), req.headers['content-type'] ?? 'application/octet-stream', bytes)
      json(res, 201, { did, cid: cid.toString(), size: bytes.length })
    }],
    ['GET', /^\/blob\/([^/]+)\/([^/]+)$/, (_req, res, [did, cid]) => {
      const row = this.stmts.blobGet.get(did!, cid!) as { mime: string; bytes: Uint8Array } | undefined
      if (!row) throw new HostError(404, 'not-found', 'no such blob')
      res.writeHead(200, { 'content-type': row.mime })
      res.end(row.bytes)
    }],
  ]

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host')
    try {
      for (const [method, pattern, handler] of this.routes) {
        const m = url.pathname.match(pattern)
        if (m && req.method === method) {
          await handler(req, res, m.slice(1), url)
          return
        }
      }
      throw new HostError(404, 'not-found', 'no such route')
    } catch (e) {
      if (e instanceof HostError) json(res, e.status, { error: e.code, message: e.message, ...e.extra })
      else if (e instanceof EntryError) json(res, 400, { error: e.code, message: e.message })
      else json(res, 400, { error: 'bad-request', message: (e as Error).message })
    }
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function body(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    req.on('data', (chunk: Uint8Array) => {
      size += chunk.length
      if (size > limit) {
        reject(new HostError(413, 'size', `body over ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

export { encode as encodeForTests, cidOf as cidForTests }

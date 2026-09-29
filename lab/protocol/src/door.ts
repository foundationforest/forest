// The door: an MCP server that lets an AI assistant read, draft, and write for a person, and
// never holds the person's keys.
//
// - Connect (in production, the MCP OAuth flow; here, its core): the person approves on the
//   approval page with one tap; the page signs a grant naming a key the door derives for this
//   connection. The door answers with a token that seals the connection. It keeps no database:
//   the agent key is derived from the door's master key and a nonce that lives only inside the
//   sealed token the assistant's client holds.
// - Standing rule: the assistant writes within the grant, signed with the agent key, while the
//   person's phone is off.
// - Per action: anything the grant does not cover becomes a draft; the tool answers
//   `input_required` with a URL-mode elicitation (MCP 2026-07-28) to the approval page; the page
//   signs with the profile key; the client retries and the door answers "published".
//
// Trust: while it runs, the door's operator can act within every grant it serves (it sees the
// tokens). A leaked master key alone signs nothing under any existing grant.

import { createHash, randomBytes } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer, createMcpHandler, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import * as z from 'zod'
import { type ApprovalRequest, type ConnectRequest, type DraftRequest, describe, readFolder } from './approve.ts'
import { b64u, fromUtf8, hex, utf8 } from './bytes.ts'
import { publish } from './client.ts'
import { type Body, type Entry, type GrantBody, checkEntry, checkShape, normalizeOrigin } from './entry.ts'
import { type ProfileKey, derive, keyFromSecret } from './keys.ts'
import { delegateReason, liveContent } from './view.ts'
import { delegateEntry, nextTime } from './write.ts'

const DAY = 86_400_000
const PENDING_MS = 10 * 60_000

export type Session = {
  v: 1
  profile: string
  /** The grant version this connection writes under, or null for drafts only. */
  grantId: string | null
  nonce: string
  hosts: string[]
  client: string
  exp: number
}

type PendingConnect = { request: ConnectRequest; nonce: string; verifier: string; exp: number; grantId?: string | null }
type PendingDraft = { request: DraftRequest; session: string; exp: number; done?: { id: string; hosts: string[] }; reported?: boolean }

export type DoorOptions = {
  /** The approval page, e.g. https://forest.foundation/approve. */
  approvalPage: string
  master?: Uint8Array
  now?: () => number
  /** How long a retried tool call waits for the person before asking again. */
  waitMs?: number
}

export class Door {
  url = ''
  readonly approvalPage: string
  private readonly master: Uint8Array
  private readonly tokenKey: Uint8Array
  private readonly now: () => number
  private readonly waitMs: number
  private readonly codec: ReturnType<typeof createRequestStateCodec<{ draft: string }>>
  private readonly connects = new Map<string, PendingConnect>()
  private readonly drafts = new Map<string, PendingDraft>()
  private server?: Server

  constructor(options: DoorOptions) {
    this.approvalPage = options.approvalPage
    this.master = options.master ?? randomBytes(32)
    this.tokenKey = derive(this.master, 'forest.door/token/v1')
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? 60_000
    this.codec = createRequestStateCodec<{ draft: string }>({ key: derive(this.master, 'forest.door/state/v1'), ttlSeconds: 600 })
  }

  /** The key this door signs with for one connection: from the master key and that connection's nonce. */
  agentKey(nonce: string): ProfileKey {
    return keyFromSecret(derive(this.master, `forest.door/agent/v1/${nonce}`))
  }

  // ------------------------------------------------------------------------------------------
  // Connecting: the core of the OAuth flow. The verifier (PKCE) keeps the token from anyone who
  // only intercepts the approval. It does not stop consent phishing: a person who approves a
  // connection someone else started, for a client of theirs, connects that client. The page's
  // defence is to show plainly who is asking; the app's is to list and revoke connections.

  startConnect(options: { profile: string; hosts: string[]; client: string; paths: string[]; days: number }): { id: string; url: string; verifier: string } {
    const id = hex.encode(randomBytes(8))
    const nonce = hex.encode(randomBytes(16))
    const verifier = b64u.encode(randomBytes(32))
    const request: ConnectRequest = {
      kind: 'connect',
      id,
      door: this.url,
      profile: options.profile,
      agent: this.agentKey(nonce).did,
      client: options.client,
      paths: options.paths,
      until: this.now() + options.days * DAY,
      hosts: options.hosts,
    }
    this.connects.set(id, { request, nonce, verifier: sha256(verifier), exp: this.now() + PENDING_MS })
    return { id, url: `${this.approvalPage}#connect=${this.url}/connect/${id}`, verifier }
  }

  /** The page hands back the signed grant (or, for drafts only, the signed proof). */
  finishConnect(id: string, entry: Entry): void {
    const pending = this.live(this.connects, id)
    const { entry: e, id: entryId } = checkEntry(entry)
    const r = pending.request
    const body = e.body as GrantBody | null
    if (e.profile !== r.profile || e.path !== `grant/${r.id}` || e.by !== undefined || !body) throw new Error('not the grant this connection asked for')
    if (body.to !== r.agent || body.until !== r.until || JSON.stringify(body.paths) !== JSON.stringify(r.paths)) throw new Error('the grant differs from the request')
    pending.grantId = r.paths.length ? entryId : null
  }

  /** The client that started the connection trades its verifier for the token, once. */
  exchange(id: string, verifier: string): string {
    const pending = this.live(this.connects, id)
    if (pending.grantId === undefined) throw new Error('not approved yet')
    if (sha256(verifier) !== pending.verifier) throw new Error('wrong verifier')
    this.connects.delete(id)
    const r = pending.request
    return this.sealToken({ v: 1, profile: r.profile, grantId: pending.grantId, nonce: pending.nonce, hosts: r.hosts, client: r.client, exp: r.paths.length ? r.until : this.now() + 30 * DAY })
  }

  // ------------------------------------------------------------------------------------------
  // Tokens: XChaCha20-Poly1305 under a key from the master key. The client can hold one but
  // not read it; the door can read it but stores none.

  sealToken(session: Session): string {
    const nonce = randomBytes(24)
    return b64u.encode(new Uint8Array([...nonce, ...xchacha20poly1305(this.tokenKey, nonce).encrypt(utf8(JSON.stringify(session)))]))
  }

  openToken(token: string): Session | null {
    try {
      const bytes = b64u.decode(token)
      const session = JSON.parse(fromUtf8(xchacha20poly1305(this.tokenKey, bytes.subarray(0, 24)).decrypt(bytes.subarray(24)))) as Session
      return session.v === 1 && session.exp > this.now() ? session : null
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------------------------------
  // MCP over HTTP at /mcp, through the SDK's own entry: the 2026-07-28 revision (stateless; an
  // approval comes back to the client as input_required), with the SDK's stateless fallback for
  // 2025-era clients. Each request carries the connection's token as a bearer token; the door
  // opens it and builds a server for that connection alone.

  private readonly mcp = createMcpHandler((ctx) => {
    const session = ctx.authInfo?.extra?.session as Session | undefined
    const tag = ctx.authInfo?.extra?.tag as string | undefined
    if (!session || !tag) throw new Error('no connection')
    return this.mcpServer(session, tag)
  })

  mcpServer(session: Session, sessionTag: string): McpServer {
    const server = new McpServer(
      { name: 'forest-door', version: '0.0.0' },
      {
        // 2026-07-28 (stateless; approvals return to the client as input_required), and 2025-11-25
        // for older clients, where the SDK's shim sends the same URL elicitation from the server.
        supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
        requestState: { verify: (state, ctx) => this.codec.verify(state, ctx) },
      },
    )

    server.registerTool(
      'forest_read',
      {
        description: 'Read a Forest profile: its card, offers, reviews and proofs. Public; anyone can read these.',
        inputSchema: z.object({ profile: z.string().optional() }),
      },
      async ({ profile }) => {
        const did = profile ?? session.profile
        const found = await readFolder(did, session.hosts, this.now())
        if (!found) return text(`Nothing found for ${did}.`)
        const live = Object.fromEntries([...liveContent(found.view)].map(([path, v]) => [path, { body: v.entry.body, by: v.entry.by ?? 'owner' }]))
        return text(JSON.stringify(live, null, 1))
      },
    )

    server.registerTool(
      'forest_write',
      {
        description:
          'Write to the person’s Forest profile: an offer, a review, a proof, or the profile card. Within the person’s standing rule it is published at once; anything else waits for the person to approve it on their phone.',
        inputSchema: z.object({ path: z.string(), body: z.record(z.string(), z.unknown()).nullable() }),
      },
      async ({ path, body }, ctx) => {
        const state = ctx.mcpReq.requestState<{ draft: string }>()
        if (state?.draft) return this.awaitDraft(state.draft, sessionTag)
        try {
          checkShape({ v: 1, profile: session.profile, path, time: this.now(), body: body as Body | null }, false)
        } catch (err) {
          return text(`That cannot be written: ${(err as Error).message}`, true)
        }
        if (session.grantId) {
          const done = await this.writeUnderGrant(session, path, body as Body | null)
          if (done) return text(`Published ${path}, signed by the assistant under the person's rule, on ${done.join(', ')}.`)
        }
        const draft = this.createDraft(session, sessionTag, path, body as Body | null)
        return inputRequired({
          inputRequests: {
            approve: inputRequired.elicitUrl({ message: `Please approve on your phone: ${describe(draft.request).join(' ')}`, url: draft.url }),
          },
          requestState: await this.codec.mint({ draft: draft.request.id }),
        })
      },
    )
    return server
  }

  private async writeUnderGrant(session: Session, path: string, body: Body | null): Promise<string[] | null> {
    const found = await readFolder(session.profile, session.hosts, this.now())
    if (!found) return null
    const agent = this.agentKey(session.nonce)
    const entry = delegateEntry(agent, session.profile, session.grantId!, path, body, nextTime(this.now(), found.view, path))
    const checked = checkEntry(entry)
    if (delegateReason(checked, found.view.grants, this.now())) return null
    const top = found.view.current.get(path)
    if (top && top.entry.by === undefined) return null // the owner's own: owner first
    const outcomes = await publish(found.folder.hosts, [entry])
    const took = outcomes.filter((o) => o.results[0]?.ok).map((o) => o.host)
    return took.length ? took : null
  }

  // ------------------------------------------------------------------------------------------
  // Drafts

  private createDraft(session: Session, sessionTag: string, path: string, body: Body | null): { request: DraftRequest; url: string } {
    const id = hex.encode(randomBytes(12))
    const request: DraftRequest = { kind: 'draft', id, door: this.url, profile: session.profile, path, body, hosts: session.hosts }
    this.drafts.set(id, { request, session: sessionTag, exp: this.now() + PENDING_MS })
    return { request, url: `${this.approvalPage}#draft=${this.url}/drafts/${id}` }
  }

  /** The page hands back what it signed; it counts only if it is the draft, signed by the profile's own key. */
  finishDraft(id: string, entry: Entry): void {
    const pending = this.live(this.drafts, id)
    const { entry: e, id: entryId } = checkEntry(entry)
    const r = pending.request
    if (e.profile !== r.profile || e.by !== undefined) throw new Error('not signed by the profile this draft is for')
    if (e.path !== r.path || JSON.stringify(e.body) !== JSON.stringify(r.body)) throw new Error('not the draft that was shown')
    pending.done = { id: entryId, hosts: r.hosts }
  }

  private async awaitDraft(id: string, sessionTag: string) {
    const pending = this.drafts.get(id)
    if (!pending || pending.session !== sessionTag) return text('That approval belongs to another connection or has expired.', true)
    const deadline = this.now() + this.waitMs
    const started = Date.now()
    while (!pending.done && Date.now() - started < this.waitMs && this.now() <= deadline) await sleep(50)
    if (!pending.done) {
      return inputRequired({
        inputRequests: { approve: inputRequired.elicitUrl({ message: `Still waiting: ${describe(pending.request).join(' ')}`, url: `${this.approvalPage}#draft=${this.url}/drafts/${id}` }) },
        requestState: await this.codec.mint({ draft: id }),
      })
    }
    if (pending.reported) return text('Already reported: that approval was used once.', true)
    pending.reported = true
    return text(`Approved and published ${pending.request.path} (${pending.done.id.slice(0, 12)}…), signed by the person's own key.`)
  }

  private live<T extends { exp: number }>(map: Map<string, T>, id: string): T {
    const pending = map.get(id)
    if (!pending || pending.exp < this.now()) throw new Error('unknown or expired request')
    return pending
  }

  // ------------------------------------------------------------------------------------------
  // HTTP, for the approval page

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: Error) => {
        if (!res.headersSent) res.writeHead(400, cors()).end(err.message)
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    this.url = normalizeOrigin(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`)!
    return this.url
  }

  async close() {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (new URL(req.url ?? '/', 'http://door.invalid').pathname === '/mcp') return this.serveMcp(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors(), 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end()
      return
    }
    const match = /^\/(drafts|connect)\/([0-9a-f]+)(\/done)?$/.exec(new URL(req.url ?? '/', 'http://door.invalid').pathname)
    if (!match) {
      res.writeHead(404, cors()).end()
      return
    }
    const [, kind, id, done] = match
    if (req.method === 'GET' && !done) {
      const request: ApprovalRequest = kind === 'drafts' ? this.live(this.drafts, id!).request : this.live(this.connects, id!).request
      res.writeHead(200, { ...cors(), 'content-type': 'application/json' }).end(JSON.stringify(request))
      return
    }
    if (req.method === 'POST' && done) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const { entry } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { entry: Entry }
      if (kind === 'drafts') this.finishDraft(id!, entry)
      else this.finishConnect(id!, entry)
      res.writeHead(200, cors()).end('ok')
      return
    }
    res.writeHead(405, cors()).end()
  }

  /** Bearer token in, MCP out. No token, a bad one or an expired one: 401. */
  private async serveMcp(req: IncomingMessage, res: ServerResponse) {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
    const session = bearer ? this.openToken(bearer) : null
    if (!bearer || !session) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource"` }).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
    const request = new Request(`${this.url}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) })
    const response = await this.mcp.fetch(request, {
      authInfo: { token: bearer, clientId: session.client, scopes: [], extra: { session, tag: sha256(bearer) } },
    })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      const reader = response.body.getReader()
      for (let part = await reader.read(); !part.done; part = await reader.read()) res.write(part.value)
    }
    res.end()
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('base64url')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const cors = () => ({ 'access-control-allow-origin': '*' })
const text = (message: string, isError = false) => ({ content: [{ type: 'text' as const, text: message }], isError })

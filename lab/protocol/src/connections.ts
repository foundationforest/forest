// Connections: how apps and assistants work for a person. The protocol does not know what an
// assistant is. Any program reads public notes, drafts, and hands the person an approval link
// (request.ts); the person's device shows the exact note, signs it and posts it.
//
// This file is one such program, a service for assistants: an MCP server (protocol revision
// 2026-07-28, stateless). It holds no key, no grant and no draft, and asks for no login:
//   - forest_read   the public notes of a profile;
//   - forest_draft  a note for the person to approve. The answer is `input_required` with the
//                   approval link (URL mode). When the client comes back, the service reads the
//                   profile's hosts: the note is there, signed by the person, or it is not yet.
//                   Either way the draft lives only in its link, and waits until the person
//                   returns. A second copy of this service, which never saw the draft, gives
//                   the same answer.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer, createMcpHandler, inputRequired, inputResponse } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { type Body, isSealed } from './entry.ts'
import { type ApprovalRequest, checkRequest, describe, isPublished, readProfile, requestLink } from './request.ts'
import { liveContent } from './view.ts'

export type ConnectionsOptions = {
  /** The approval page, e.g. https://forest.foundation/approve. */
  approvalPage: string
  /** Hosts this service reads to find a profile (an index would do the same). */
  hosts: string[]
  now?: () => number
  /** How long a returning call reads the hosts for the person's approval before answering. */
  waitMs?: number
}

export class Connections {
  url = ''
  readonly approvalPage: string
  private readonly hosts: string[]
  private readonly now: () => number
  private readonly waitMs: number
  private server?: Server
  private readonly mcp = createMcpHandler(() => this.mcpServer())

  constructor(options: ConnectionsOptions) {
    this.approvalPage = options.approvalPage
    this.hosts = options.hosts
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? 30_000
  }

  /** A profile as its hosts show it: the hosts this service knows, then those its folder names. */
  private async find(profile: string) {
    const first = await readProfile(profile, this.hosts, this.now())
    const more = first?.folder.hosts.filter((h) => !this.hosts.includes(h)) ?? []
    return more.length ? readProfile(profile, [...this.hosts, ...more], this.now()) : first
  }

  private async published(request: ApprovalRequest): Promise<boolean> {
    const found = await this.find(request.profile)
    return Boolean(found && isPublished(found.view, request))
  }

  mcpServer(): McpServer {
    const server = new McpServer({ name: 'forest', version: '0.0.0' }, { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] })

    server.registerTool(
      'forest_read',
      {
        description: 'Read the public notes of a Forest profile: its card, offers, reviews and proofs. Anyone can read these.',
        inputSchema: z.object({ profile: z.string() }),
      },
      async ({ profile }) => {
        const found = await this.find(profile)
        if (!found) return text(`Nothing found for ${profile}.`)
        const live = Object.fromEntries(
          [...liveContent(found.view)].map(([path, v]) => [path, isSealed(v.entry.body) ? '(sealed: only its readers can open it)' : v.entry.body]),
        )
        return text(JSON.stringify(live, null, 1))
      },
    )

    server.registerTool(
      'forest_draft',
      {
        description:
          'Draft a note for a person’s Forest profile: a card, an offer, a review or a proof, or a delete (body null). Nothing is published until the person approves it on their own device; the draft waits in its approval link until they do.',
        inputSchema: z.object({ profile: z.string(), path: z.string(), body: z.record(z.string(), z.unknown()).nullable() }),
      },
      async ({ profile, path, body }, ctx) => {
        const found = await this.find(profile)
        if (!found) return text(`No profile ${profile} on the hosts this service reads.`, true)
        const request: ApprovalRequest = { v: 1, profile, path, body: body as Body | null, hosts: found.folder.hosts }
        try {
          checkRequest(request)
        } catch (err) {
          return text(`That cannot be drafted: ${(err as Error).message}`, true)
        }
        const link = requestLink(this.approvalPage, request)
        if (isPublished(found.view, request)) return text(`Published: ${path} is on the profile’s hosts, signed by the person.`)
        if (inputResponse(ctx.mcpReq.inputResponses, 'approve').kind === 'missing') {
          return inputRequired({ inputRequests: { approve: inputRequired.elicitUrl({ message: `Approve on your phone: ${describe(request).join(' ')}`, url: link }) } })
        }
        // The person was shown the link. Read the hosts for a little while, then let the draft wait.
        for (const started = Date.now(); Date.now() - started < this.waitMs; await sleep(100)) {
          if (await this.published(request)) return text(`Published: ${path} is on the profile’s hosts, signed by the person.`)
        }
        return text(`Not approved yet, and nothing is published. The draft waits in its link until the person opens it: ${link}`)
      },
    )
    return server
  }

  // ------------------------------------------------------------------------------------------
  // HTTP: MCP at /mcp, through the SDK's own entry, with no login.

  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async close() {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (new URL(req.url ?? '/', 'http://service.invalid').pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
    const request = new Request(`${this.url}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) })
    const response = await this.mcp.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      const reader = response.body.getReader()
      for (let part = await reader.read(); !part.done; part = await reader.read()) res.write(part.value)
    }
    res.end()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (message: string, isError = false) => ({ content: [{ type: 'text' as const, text: message }], isError })

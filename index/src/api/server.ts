// The endpoints on node:http, for running locally and on any plain server. Part two can mount
// `handle` elsewhere instead.

import { createServer, type Server } from 'node:http'

import type { Api } from './routes.ts'

export function serve(api: Api, port: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
    const response = await api.handle(new Request(url, { method: req.method }))
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}

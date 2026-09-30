// Test helpers: real HTTP hosts on loopback ports, and a clock tests can move.

import { createServer } from 'node:net'
import { Host, type HostOptions } from '../src/host.ts'

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export async function startHost(options: Omit<HostOptions, 'url'> = {}): Promise<Host> {
  const port = await freePort()
  const host = new Host({ ...options, url: `http://127.0.0.1:${port}` })
  await host.listen(port)
  return host
}

export class Clock {
  t: number
  constructor(t: number) {
    this.t = t
  }
  now = () => this.t
  advance(ms: number) {
    this.t += ms
    return this.t
  }
}

// Test helpers: real HTTP hosts on loopback ports, and a clock tests can move.

import { Host, type HostOptions } from '../src/host.ts'

export async function startHost(options: HostOptions = {}): Promise<Host> {
  const host = new Host(options)
  await host.listen()
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

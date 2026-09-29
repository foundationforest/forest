// Shared test setup: hosts on random ports over SQLite files in a temporary directory, people from
// fixed seeds, and a stand-in DHT. Nothing here touches the network beyond 127.0.0.1.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../src/host.ts'
import { profileKeys, type ProfileKeys } from '../src/keys.ts'
import { MemoryDht } from '../src/pointer.ts'

export type Started = { host: Host; url: string; dir: string; path: string }

const dirs: string[] = []

export async function startHost(name = 'host', now?: () => number): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), `forest-p2-${name}-`))
  dirs.push(dir)
  const path = join(dir, 'host.sqlite')
  const host = new Host({ path, now })
  const url = await host.listen(0)
  return { host, url, dir, path }
}

export async function stopAll(started: Started[]): Promise<void> {
  for (const s of started) await s.host.close()
}

export function cleanDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** A seed from one byte, for tests. Real seeds come from a passkey (`keys/SPEC.md`). */
export function seedOf(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte)
}

export function person(byte: number, profile = 0): Promise<ProfileKeys> {
  return profileKeys(seedOf(byte), profile)
}

export const dht = new MemoryDht()

export const nowSeconds = () => Math.floor(Date.now() / 1000)

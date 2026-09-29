// Talking to hosts over HTTP: publish entries, read them back. Every entry read is checked
// here, whatever host it came from: a reader trusts no host.

import { type Entry, EntryError, decodeEntry, encodeEntry } from './entry.ts'
import type { Result } from './host.ts'
import type { Version } from './view.ts'

export type PublishOutcome = { host: string; status: number; results: Result[]; error?: string }

/** Send entries to each host; one request per host. A host that fails does not stop the others. */
export async function publish(hosts: string[], entries: Entry[]): Promise<PublishOutcome[]> {
  const body = entries.map((e) => encodeEntry(e) + '\n').join('')
  return Promise.all(
    hosts.map(async (host): Promise<PublishOutcome> => {
      try {
        const res = await fetch(`${host}/v1/entries`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body })
        const text = await res.text()
        const results = text
          .split('\n')
          .filter((l) => l)
          .map((l) => JSON.parse(l) as Result)
        return { host, status: res.status, results }
      } catch (err) {
        return { host, status: 0, results: [], error: (err as Error).message }
      }
    }),
  )
}

export type Page = { versions: Version[]; cursor: number; refused: Array<{ line: string; reason: string }> }

/** One page of a host's entries after a cursor, each one checked. */
export async function readPage(host: string, options: { profile?: string; path?: string; after?: number; limit?: number } = {}): Promise<Page> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
  const res = await fetch(`${host}/v1/entries?${query}`)
  if (!res.ok) throw new Error(`${host} answered ${res.status}`)
  const cursor = Number.parseInt(res.headers.get('forest-cursor') ?? '0', 10)
  const versions: Version[] = []
  const refused: Page['refused'] = []
  for (const line of (await res.text()).split('\n')) {
    if (!line) continue
    try {
      versions.push(decodeEntry(line))
    } catch (err) {
      refused.push({ line, reason: err instanceof EntryError ? err.code : 'invalid' })
    }
  }
  return { versions, cursor, refused }
}

/** Everything a host serves for one profile (or the whole host), page by page. */
export async function readAll(host: string, options: { profile?: string; path?: string } = {}): Promise<Page> {
  const out: Page = { versions: [], cursor: 0, refused: [] }
  for (;;) {
    const page = await readPage(host, { ...options, after: out.cursor })
    out.versions.push(...page.versions)
    out.refused.push(...page.refused)
    if (page.cursor === out.cursor) return out
    out.cursor = page.cursor
  }
}

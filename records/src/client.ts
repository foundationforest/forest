// Talking to hosts over HTTP: publish entries, read them back. Every entry read is checked
// here, whatever host it came from: a reader trusts no host.

import { type Entry, EntryError, decodeEntry, encodeEntry } from './entry.ts'
import type { ReadOptions, Result } from './host.ts'
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

/** The largest page a reader takes, and a host serves. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024
/** A read that has not finished by then is given up. */
export const READ_TIMEOUT_MS = 60_000

/**
 * One page of a host's feed after a cursor, in the host's order, each entry checked. It throws
 * on a page over MAX_PAGE_BYTES, or one not read within `timeout` ms (READ_TIMEOUT_MS when omitted).
 */
export async function readPage(host: string, options: ReadOptions & { timeout?: number } = {}): Promise<Page> {
  const query = new URLSearchParams()
  if (options.after !== undefined) query.set('after', String(options.after))
  if (options.profile !== undefined) query.set('profile', options.profile)
  if (options.badged) query.set('badged', '1')
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const res = await fetch(`${host}/v1/entries?${query}`, { signal: AbortSignal.timeout(options.timeout ?? READ_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${host} answered ${res.status}`)
  const cursor = Number.parseInt(res.headers.get('forest-cursor') ?? '0', 10)
  const text = await readText(res, MAX_PAGE_BYTES)
  if (text === null) throw new Error(`${host} served a page over ${MAX_PAGE_BYTES} bytes`)
  const versions: Version[] = []
  const refused: Page['refused'] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      versions.push(decodeEntry(line))
    } catch (err) {
      refused.push({ line, reason: err instanceof EntryError ? err.code : 'invalid' })
    }
  }
  return { versions, cursor, refused }
}

/** A response's text, or null as soon as it passes `max` bytes. */
async function readText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** A host's whole feed (for one profile, or badged profiles only), page by page, in its order. */
export async function readAll(host: string, options: Omit<ReadOptions, 'after' | 'limit'> = {}): Promise<Page> {
  const out: Page = { versions: [], cursor: 0, refused: [] }
  for (;;) {
    const page = await readPage(host, { ...options, after: out.cursor })
    out.versions.push(...page.versions)
    out.refused.push(...page.refused)
    if (page.cursor === out.cursor) return out
    out.cursor = page.cursor
  }
}

// Talking to hosts over HTTP: publish records, read them back. Every record read is checked
// here, whatever host it came from: a reader trusts no host.

import type { ReadOptions, Result } from './host.ts'
import { type Checked, RecordError, type SignedRecord, decodeRecord, encodeRecord } from './record.ts'
import { type View, viewProfile } from './view.ts'

export type PublishOutcome = { host: string; status: number; results: Result[]; error?: string }

/** Send records to each host; one request per host. A host that fails does not stop the others. */
export async function publish(hosts: string[], records: SignedRecord[]): Promise<PublishOutcome[]> {
  const body = records.map((r) => encodeRecord(r) + '\n').join('')
  return Promise.all(
    hosts.map(async (host): Promise<PublishOutcome> => {
      try {
        const res = await fetch(`${host}/v1/records`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body })
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

export type Page = { records: Checked[]; cursor: number; refused: Array<{ line: string; reason: string }> }

/** The largest page a reader takes, and a host serves. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024
/** A read that has not finished by then is given up. */
export const READ_TIMEOUT_MS = 60_000

/**
 * One page of what a host stores, after a cursor, in the order it took them, each record checked.
 * It throws on a page over MAX_PAGE_BYTES, or one not read within `timeout` ms (READ_TIMEOUT_MS
 * when omitted).
 */
export async function readPage(host: string, options: ReadOptions & { timeout?: number } = {}): Promise<Page> {
  const query = new URLSearchParams()
  if (options.after !== undefined) query.set('after', String(options.after))
  if (options.profile !== undefined) query.set('profile', options.profile)
  const res = await fetch(`${host}/v1/records?${query}`, { signal: AbortSignal.timeout(options.timeout ?? READ_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${host} answered ${res.status}`)
  const cursor = Number.parseInt(res.headers.get('forest-cursor') ?? '0', 10)
  const text = await readText(res, MAX_PAGE_BYTES)
  if (text === null) throw new Error(`${host} served a page over ${MAX_PAGE_BYTES} bytes`)
  const records: Checked[] = []
  const refused: Page['refused'] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      records.push(decodeRecord(line))
    } catch (err) {
      refused.push({ line, reason: err instanceof RecordError ? err.code : 'invalid' })
    }
  }
  return { records, cursor, refused }
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

/** Everything a host stores (for one profile, if asked), page by page. */
export async function readAll(host: string, options: Omit<ReadOptions, 'after'> = {}): Promise<Page> {
  const out: Page = { records: [], cursor: 0, refused: [] }
  for (;;) {
    const page = await readPage(host, { ...options, after: out.cursor })
    out.records.push(...page.records)
    out.refused.push(...page.refused)
    if (page.cursor === out.cursor) return out
    out.cursor = page.cursor
  }
}

/**
 * A profile as its hosts show it: the hosts given, then every host its current hosts record names,
 * until no new one turns up. A host that does not answer is skipped: the others still count.
 */
export async function readProfile(hosts: string[], profile: string, now: number): Promise<View> {
  const read = new Set<string>()
  const found: Checked[] = []
  for (let next = hosts; next.length; ) {
    for (const host of next) {
      read.add(host)
      try {
        found.push(...(await readAll(host, { profile })).records)
      } catch {
        // Skipped.
      }
    }
    next = viewProfile(profile, found, now).hosts.filter((h) => !read.has(h))
  }
  return viewProfile(profile, found, now)
}

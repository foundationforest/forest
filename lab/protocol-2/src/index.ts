// An index. Follows hosts, verifies every entry itself against its own copy of each log, keeps the
// state, and finds new profiles by following references in records to their pointers. It needs no
// directory: a host it is told about, or a DID it sees, is enough. Anyone can run one; two indexes
// following the same hosts reach the same state. It also keeps every entry, so a person whose host
// went dark can get their log back from any index.

import { CID, b64 } from './codec.ts'
import { HostClient } from './client.ts'
import { EntryError, applyEntry, decodeEntry, emptyState, recordKey, type State } from './entry.ts'
import { isProfileDid } from './did.ts'
import { resolvePointer, type Pointer, type PointerSource } from './pointer.ts'

export type Fault = { host: string; did: string; seq: number; code: string; message: string }

export class Index {
  hosts = new Map<string, { client: HostClient; cursor: number }>()
  states = new Map<string, State>()
  logs = new Map<string, Uint8Array[]>()
  pointers = new Map<string, Pointer>()
  faults: Fault[] = []
  forks = new Set<string>()
  private sources: PointerSource[]
  private pending = new Set<string>()

  /** `sources` are where pointers are looked up besides the hosts it follows: a DHT, a relay, another index. */
  constructor(sources: PointerSource[] = []) {
    this.sources = sources
  }

  follow(url: string): void {
    const clean = url.replace(/\/+$/, '')
    if (!this.hosts.has(clean)) this.hosts.set(clean, { client: new HostClient(clean), cursor: 0 })
  }

  /** One pass over every host, then over every profile discovered on the way. Returns entries taken. */
  async tick(): Promise<number> {
    let taken = 0
    for (const [url, h] of this.hosts) {
      try {
        for (;;) {
          const page = await h.client.changes(h.cursor, 500)
          if (page.changes.length === 0) break
          for (const c of page.changes) if (this.take(url, c.did, c.seq, c.cid, c.entry)) taken++
          h.cursor = page.cursor
        }
      } catch (e) {
        // A host that is down or gone is skipped; every other host is still read.
        this.faults.push({ host: url, did: '', seq: -1, code: 'unreachable', message: (e as Error).message })
      }
    }
    while (this.pending.size > 0) {
      const did = this.pending.values().next().value as string
      this.pending.delete(did)
      taken += await this.discover(did)
    }
    return taken
  }

  /** Verifies one entry against this index's own state and keeps it. Returns whether it was new. */
  take(host: string, did: string, seq: number, cid: string, bytes: Uint8Array): boolean {
    const state = this.states.get(did) ?? emptyState(did)
    if (state.head && seq <= state.head.seq) {
      const known = this.logs.get(did)![seq]
      if (known && CID.parse(cid).equals(decodeEntry(known).cid)) return false
      this.forks.add(did)
      this.faults.push({ host, did, seq, code: 'fork', message: `a second entry at seq ${seq}` })
      return false
    }
    try {
      const { entry, cid: actual } = decodeEntry(bytes)
      if (!actual.equals(CID.parse(cid))) throw new EntryError('shape', 'the cid does not match the bytes')
      const next = applyEntry(state, entry, actual)
      const isNew = !this.states.has(did)
      this.states.set(did, next)
      const log = this.logs.get(did) ?? []
      log.push(bytes)
      this.logs.set(did, log)
      // A profile met for the first time: learn where it lives, so this index can say so to others.
      if (isNew && !this.pointers.has(did)) this.pending.add(did)
      for (const ref of referencedDids(entry.rec)) if (ref !== did && !this.states.has(ref)) this.pending.add(ref)
      return true
    } catch (e) {
      const err = e as EntryError
      this.faults.push({ host, did, seq, code: err.code ?? 'error', message: err.message })
      return false
    }
  }

  /** Finds a profile from its DID alone: resolve the pointer, follow its hosts, take its log. */
  async discover(did: string): Promise<number> {
    const sources: PointerSource[] = [...this.sources, ...[...this.hosts.values()].map((h) => h.client.pointers)]
    const found = await resolvePointer(did, sources)
    if (!found) return 0
    const { pointer, payload } = found
    this.pointers.set(did, pointer)
    this.pointerPayloads.set(did, payload)
    let taken = 0
    for (const url of pointer.hosts) {
      // A host already followed delivers this log through its changes; only a new host is read now.
      if (this.hosts.has(url.replace(/\/+$/, ''))) continue
      this.follow(url)
      const h = this.hosts.get(url.replace(/\/+$/, ''))!
      const state = this.states.get(did)
      const since = state?.head ? state.head.seq + 1 : 0
      try {
        const { entries } = await h.client.log(did, since)
        for (const bytes of entries) {
          const { entry, cid } = decodeEntry(bytes)
          if (this.take(url, did, entry.seq, cid.toString(), bytes)) taken++
        }
      } catch {
        // an unreachable host: another in the pointer may serve it
      }
    }
    return taken
  }

  state(did: string): State | undefined {
    return this.states.get(did)
  }

  record(did: string, col: string, key: string): Record<string, unknown> | undefined {
    return this.states.get(did)?.records.get(recordKey(col, key))?.rec
  }

  /** Every current record in a collection across every profile, with its profile. */
  search(col: string, where: (rec: Record<string, unknown>, did: string) => boolean = () => true): { did: string; key: string; rec: Record<string, unknown> }[] {
    const out = []
    for (const [did, s] of this.states) {
      for (const [k, r] of s.records) {
        const [c, key] = k.split('\u0000')
        if (c === col && where(r.rec, did)) out.push({ did, key: key!, rec: r.rec })
      }
    }
    return out
  }

  /** The log as this index holds it. What a person takes to a new host when the old one is gone. */
  export(did: string): Uint8Array[] {
    return [...(this.logs.get(did) ?? [])]
  }

  /** Re-resolves every known profile's pointer, so a move to a new host is followed. */
  async refreshAll(): Promise<number> {
    let taken = 0
    for (const did of [...this.states.keys()]) taken += await this.discover(did)
    return taken
  }

  /** Serves as a pointer source for other indexes and for people whose host went dark. */
  get pointerSource(): PointerSource {
    return { get: (did) => this.pointerPayloads.get(did) ?? null }
  }
  private pointerPayloads = new Map<string, Uint8Array>()
}

/** Every profile DID mentioned anywhere in a record's values. How an index finds profiles it has not seen. */
export function referencedDids(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (isProfileDid(value)) out.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) referencedDids(v, out)
  } else if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof CID)) {
    for (const v of Object.values(value)) referencedDids(v, out)
  }
  return out
}

export { b64 }

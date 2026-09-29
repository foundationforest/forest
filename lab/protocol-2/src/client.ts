// The client side: what a device or a delegate runs. A Writer holds one signer and appends entries
// to a profile's log at its hosts; a HostClient is the plain HTTP calls. Nothing here needs an
// account, a session or a cookie: every write is authorised by the signature on it.

import { CID, b64, blobCid, cidOf, copy, encode, toJson } from './codec.ts'
import { decodeEntry, signEntry, type Enc, type Grant, type Op, type Unsigned } from './entry.ts'
import type { Signer } from './keys.ts'
import { opaqueKey, sealRecord, type PrivatePayload } from './private.ts'
import { signPermit } from './permit.ts'

export class HostClientError extends Error {
  status: number
  code: string
  head: { seq: number; cid: string } | null
  constructor(status: number, code: string, message: string, head: { seq: number; cid: string } | null = null) {
    super(`${status} ${code}: ${message}`)
    this.status = status
    this.code = code
    this.head = head
  }
}

export type Head = { seq: number; cid: string } | null

export class HostClient {
  url: string
  constructor(url: string) {
    this.url = url.replace(/\/+$/, '')
  }

  private async call(method: string, path: string, body?: Uint8Array | string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(`${this.url}${path}`, { method, body: body instanceof Uint8Array ? copy(body) : body, headers })
    if (!res.ok) {
      let payload: { error?: string; message?: string; head?: Head } = {}
      try {
        payload = (await res.json()) as typeof payload
      } catch {
        // not JSON
      }
      throw new HostClientError(res.status, payload.error ?? 'error', payload.message ?? res.statusText, payload.head ?? null)
    }
    return res
  }

  async log(did: string, since = 0): Promise<{ head: Head; entries: Uint8Array[] }> {
    const res = await this.call('GET', `/log/${did}?since=${since}`)
    const body = (await res.json()) as { head: Head; entries: string[] }
    return { head: body.head, entries: body.entries.map((e) => b64.decode(e)) }
  }

  async head(did: string): Promise<Head> {
    const res = await this.call('GET', `/state/${did}`)
    return ((await res.json()) as { head: Head }).head
  }

  async append(bytes: Uint8Array): Promise<{ seq: number; cid: string }> {
    const did = decodeEntry(bytes).entry.did
    const res = await this.call('POST', `/log/${did}`, bytes, { 'content-type': 'application/cbor' })
    return (await res.json()) as { seq: number; cid: string }
  }

  async state(did: string): Promise<Record<string, unknown>> {
    return (await (await this.call('GET', `/state/${did}`)).json()) as Record<string, unknown>
  }

  async record(did: string, col: string, key: string): Promise<{ seq: number; cid: string; rec: Record<string, unknown> } | null> {
    try {
      return (await (await this.call('GET', `/record/${did}/${col}/${encodeURIComponent(key)}`)).json()) as { seq: number; cid: string; rec: Record<string, unknown> }
    } catch (e) {
      if (e instanceof HostClientError && e.status === 404) return null
      throw e
    }
  }

  async records(did: string, col: string): Promise<{ key: string; seq: number; cid: string; rec: Record<string, unknown> }[]> {
    return ((await (await this.call('GET', `/records/${did}/${col}`)).json()) as { records: { key: string; seq: number; cid: string; rec: Record<string, unknown> }[] }).records
  }

  async privates(did: string): Promise<{ key: string; seq: number; cid: string; enc: Enc }[]> {
    const body = (await (await this.call('GET', `/private/${did}`)).json()) as { privates: { key: string; seq: number; cid: string; enc: Record<string, unknown> }[] }
    return body.privates.map((p) => ({ ...p, enc: encFromJson(p.enc) }))
  }

  async pointerGet(did: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await this.call('GET', `/pointer/${did}`)).arrayBuffer())
    } catch (e) {
      if (e instanceof HostClientError && e.status === 404) return null
      throw e
    }
  }

  /** Makes this host a pointer source, for `resolvePointer`. */
  get pointers(): { get: (did: string) => Promise<Uint8Array | null> } {
    return { get: (did) => this.pointerGet(did) }
  }

  async pointerPut(did: string, payload: Uint8Array): Promise<void> {
    await this.call('PUT', `/pointer/${did}`, payload, { 'content-type': 'application/octet-stream' })
  }

  async changes(since = 0, limit = 1000): Promise<{ cursor: number; changes: { cursor: number; did: string; seq: number; cid: string; entry: Uint8Array }[] }> {
    const body = (await (await this.call('GET', `/changes?since=${since}&limit=${limit}`)).json()) as { cursor: number; changes: { cursor: number; did: string; seq: number; cid: string; entry: string }[] }
    return { cursor: body.cursor, changes: body.changes.map((c) => ({ ...c, entry: b64.decode(c.entry) })) }
  }

  async pull(did: string, from: string): Promise<Head> {
    return ((await (await this.call('POST', '/pull', JSON.stringify({ did, from }), { 'content-type': 'application/json' })).json()) as { head: Head }).head
  }

  async putBlob(did: string, bytes: Uint8Array, mime: string, permit: Uint8Array): Promise<{ cid: string; size: number }> {
    return (await (await this.call('POST', `/blob/${did}`, bytes, { 'content-type': mime, 'x-forest-permit': b64.encode(permit) })).json()) as { cid: string; size: number }
  }

  async blob(did: string, cid: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
    try {
      const res = await this.call('GET', `/blob/${did}/${cid}`)
      return { mime: res.headers.get('content-type') ?? '', bytes: new Uint8Array(await res.arrayBuffer()) }
    } catch (e) {
      if (e instanceof HostClientError && e.status === 404) return null
      throw e
    }
  }
}

function encFromJson(j: Record<string, unknown>): Enc {
  return {
    alg: j.alg as string,
    iv: b64.decode(j.iv as string),
    ct: b64.decode(j.ct as string),
    to: (j.to as { kid: string; enc: string; ct: string }[]).map((r) => ({ kid: r.kid, enc: b64.decode(r.enc), ct: b64.decode(r.ct) })),
  }
}

export type WriterOptions = {
  /** The profile written to. */
  did: string
  /** The profile's own signer, or a delegate's. */
  signer: Signer
  /** The grant entry's CID, when the signer is a delegate. */
  via?: CID
  /** The first is written to; the rest are asked to pull from it. */
  hosts: string[]
  now?: () => number
}

type Partial = { op: Op; col?: string; key?: string; rec?: Record<string, unknown>; enc?: Enc }

/** Appends entries to one profile's log. Retries when the head moved under it, as two devices race. */
export class Writer {
  did: string
  signer: Signer
  via?: CID
  hosts: HostClient[]
  now: () => number

  constructor(opts: WriterOptions) {
    this.did = opts.did
    this.signer = opts.signer
    this.via = opts.via
    this.hosts = opts.hosts.map((h) => new HostClient(h))
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    if (this.signer.did !== this.did && !this.via) throw new Error('a delegate writes under a grant: pass via')
  }

  get primary(): HostClient {
    return this.hosts[0]!
  }

  async append(partial: Partial, tries = 3): Promise<{ seq: number; cid: CID; bytes: Uint8Array }> {
    let head = await this.primary.head(this.did)
    for (let attempt = 0; ; attempt++) {
      const unsigned: Unsigned = {
        v: 1,
        did: this.did,
        seq: head ? head.seq + 1 : 0,
        prev: head ? CID.parse(head.cid) : null,
        at: this.now(),
        op: partial.op,
        ...(this.signer.did !== this.did ? { by: this.signer.did, via: this.via } : {}),
        ...(partial.col !== undefined ? { col: partial.col } : {}),
        ...(partial.key !== undefined ? { key: partial.key } : {}),
        ...(partial.rec !== undefined ? { rec: partial.rec } : {}),
        ...(partial.enc !== undefined ? { enc: partial.enc } : {}),
      }
      const { bytes, cid } = signEntry(this.signer, unsigned)
      try {
        const result = await this.primary.append(bytes)
        for (const mirror of this.hosts.slice(1)) await mirror.pull(this.did, this.primary.url)
        return { seq: result.seq, cid, bytes }
      } catch (e) {
        if (e instanceof HostClientError && e.status === 409 && attempt + 1 < tries) {
          head = e.head ?? (await this.primary.head(this.did))
          continue
        }
        throw e
      }
    }
  }

  put(col: string, key: string, rec: Record<string, unknown>) {
    return this.append({ op: 'put', col, key, rec })
  }
  del(col: string, key: string) {
    return this.append({ op: 'del', col, key })
  }
  grant(grant: Grant) {
    return this.append({ op: 'grant', rec: grant as unknown as Record<string, unknown> })
  }
  revoke(grant: CID) {
    return this.append({ op: 'revoke', rec: { grant } })
  }
  keys(reader: string) {
    return this.append({ op: 'keys', rec: { reader } })
  }
  /** Writes a private record for the given readers. Returns the opaque key it is stored under. */
  async putPrivate(payload: PrivatePayload, readers: string[], key = opaqueKey()) {
    const enc = await sealRecord(this.did, key, payload, readers)
    const result = await this.append({ op: 'put', key, enc })
    return { ...result, key }
  }
  delPrivate(key: string) {
    return this.append({ op: 'del', key })
  }
  /** Stores a blob at the primary host and returns its CID, for a record to point at. */
  async putBlob(bytes: Uint8Array, mime: string, ttlSeconds = 600): Promise<string> {
    const cid = blobCid(bytes).toString()
    const permit = signPermit(this.signer, this.did, cid, this.now() + ttlSeconds, this.via)
    const result = await this.primary.putBlob(this.did, bytes, mime, permit)
    return result.cid
  }
}

/** Every entry of a log, as bytes, from any host or index that serves it. */
export async function exportLog(from: string, did: string): Promise<Uint8Array[]> {
  return (await new HostClient(from).log(did)).entries
}

export { toJson, cidOf, encode }

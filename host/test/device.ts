// The device side of a Forest folder, as a product has to build it. This is the reference for
// "what a product must do", and what the tests use:
//
//   - the DID is made on the device with keys/ (didGenesis, submitGenesis), pointing at the host;
//   - every call to the host carries a service token signed with the folder's signing key
//     (issuer the DID, audience the host's DID, method the endpoint), never a password or a
//     session;
//   - every commit is prepared by the host, signed on the device, and submitted back. The host
//     holds no key and never signs.
//
// Talks to nothing but the host it is given. Runs in Node; a browser needs only `fetch`.

import type { ProfileKeys } from '../../keys/src/index.ts'
import { createServiceJwt } from '../upstream/packages/xrpc-server/dist/index.js'

export type Write =
  | {
      $type: 'com.atproto.repo.applyWrites#create'
      collection: string
      rkey?: string
      value: unknown
    }
  | {
      $type: 'com.atproto.repo.applyWrites#update'
      collection: string
      rkey: string
      value: unknown
    }
  | { $type: 'com.atproto.repo.applyWrites#delete'; collection: string; rkey: string }

export type Prepared = {
  did: string
  genesis: boolean
  rev: string
  prev?: string
  since?: string
  data: string
  unsignedCommit: { $bytes: string }
  writes: Write[]
  results: { uri?: string; cid?: string }[]
}

export type Submitted = {
  commit: { cid: string; rev: string }
  results: { uri?: string; cid?: string }[]
}

export type BlobRef = {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

/** What the host answered with when it refused: the lexicon's error name and its message. */
export class XrpcError extends Error {
  status: number
  error: string
  constructor(status: number, error: string, message: string) {
    super(`${error}: ${message}`)
    this.status = status
    this.error = error
  }
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

export class Device {
  readonly did: string
  readonly keys: ProfileKeys
  /** The host's public URL, the one the DID document names. */
  readonly host: string
  /** The host's own DID, the audience of every token. `did:web:<hostname>` by default. */
  readonly hostDid: string

  constructor(did: string, keys: ProfileKeys, host: string, hostDid: string) {
    this.did = did
    this.keys = keys
    this.host = host
    this.hostDid = hostDid
  }

  /** A service token for one call: signed by the folder's signing key, good for a minute. */
  token(lxm: string): Promise<string> {
    return createServiceJwt({
      iss: this.did,
      aud: this.hostDid,
      lxm,
      keypair: this.keys.signing,
    })
  }

  /** An authenticated procedure call. JSON in and out, or raw bytes in with `encoding`. */
  async call<T = any>(
    nsid: string,
    body?: unknown,
    encoding?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token(nsid)}`,
    }
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array) {
      headers['content-type'] = encoding ?? 'application/octet-stream'
      payload = body as BodyInit
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(`${this.host}/xrpc/${nsid}`, {
      method: 'POST',
      headers,
      body: payload,
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : {}
    if (!res.ok) {
      throw new XrpcError(res.status, json.error ?? 'Unknown', json.message ?? text)
    }
    return json as T
  }

  /** Phase one: the host applies the writes and returns the unsigned commit to sign. */
  prepare(
    writes: Write[],
    opts: { swapCommit?: string; validate?: boolean } = {},
  ): Promise<Prepared> {
    return this.call('foundation.forest.host.prepareCommit', { writes, ...opts })
  }

  /** The device's part: the signing key over exactly the bytes the host returned. */
  sign(unsignedCommit: { $bytes: string }): Promise<Uint8Array> {
    return this.keys.signing.sign(fromBase64(unsignedCommit.$bytes))
  }

  /** Phase two: the same writes and rev, plus the signature. */
  submit(args: {
    writes: Write[]
    rev: string
    sig: Uint8Array
    swapCommit?: string
    validate?: boolean
  }): Promise<Submitted> {
    const { sig, ...rest } = args
    return this.call('foundation.forest.host.submitCommit', {
      ...rest,
      sig: { $bytes: toBase64(sig) },
    })
  }

  /** One write, start to finish, building on the head prepare saw (`swapCommit = prev`). */
  async write(
    writes: Write[],
    opts: { validate?: boolean } = {},
  ): Promise<{ prepared: Prepared; submitted: Submitted }> {
    const prepared = await this.prepare(writes, opts)
    const sig = await this.sign(prepared.unsignedCommit)
    const submitted = await this.submit({
      writes: prepared.writes,
      rev: prepared.rev,
      sig,
      swapCommit: prepared.prev,
      validate: opts.validate,
    })
    return { prepared, submitted }
  }

  /** A photo: uploaded as upstream uploads it, referenced from a record afterwards. */
  async uploadBlob(bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
    const res = await this.call<{ blob: BlobRef }>('com.atproto.repo.uploadBlob', bytes, mimeType)
    return res.blob
  }

  /** The whole folder, as a CAR file from another host, into this one. */
  importRepo(car: Uint8Array): Promise<void> {
    return this.call('com.atproto.repo.importRepo', car, 'application/vnd.ipld.car')
  }
}

/** An unauthenticated query, the way anyone (a relay, an index, a browser) reads a folder. */
export async function query<T = any>(
  host: string,
  nsid: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${host}/xrpc/${nsid}?${new URLSearchParams(params)}`)
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new XrpcError(res.status, json.error ?? 'Unknown', json.message ?? text)
  }
  return json as T
}

export async function queryBytes(
  host: string,
  nsid: string,
  params: Record<string, string>,
): Promise<Uint8Array> {
  const res = await fetch(`${host}/xrpc/${nsid}?${new URLSearchParams(params)}`)
  if (!res.ok) {
    throw new XrpcError(res.status, 'Unknown', await res.text())
  }
  return new Uint8Array(await res.arrayBuffer())
}

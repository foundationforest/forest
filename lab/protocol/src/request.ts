// Approval requests: how any app or assistant asks a person to publish something while holding
// nothing of theirs. A request is the entry it proposes, without a time or a signature, plus
// hints where the profile's folder can be read:
//
//   { "v": 1, "profile": <did:key>, "path": <path>, "body": <object> | null, "hosts": [<origin>, …] }
//
// It travels in a link, after the `#`, as base64url of its canonical text, so it reaches no
// server and waits as long as the person takes. The approval page shows it as text; one tap and
// a passkey sign it with the profile's own key; the page posts it to every host the profile's
// signed folder names. Whoever asked finds it there: there is no reply.
//
// A request at `grant/<id>` asks for a permission, which nobody has unless the person approves
// one. The folder is never requested: a person changes where they live in their own app. A
// sealed body cannot be requested: the page must show what it signs.

import { b64u, fromUtf8, utf8 } from './bytes.ts'
import { canonical, parseCanonical } from './canonical.ts'
import { publish, readAll } from './client.ts'
import { type Body, type Entry, type FolderBody, type GrantBody, MAX_HOSTS, checkShape, isSealed, normalizeOrigin } from './entry.ts'
import { type ProfileKey, profileKey } from './keys.ts'
import { type ProfileView, type Version, viewProfile } from './view.ts'
import { nextTime, ownerEntry } from './write.ts'

export type ApprovalRequest = { v: 1; profile: string; path: string; body: Body | null; hosts: string[] }

/** Profiles the page looks through for the one a request is for: 0 to 15. */
export const MAX_PROFILES = 16

export function checkRequest(value: unknown): asserts value is ApprovalRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('a request is an object')
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join() !== 'body,hosts,path,profile,v') throw new Error('a request has exactly v, profile, path, body and hosts')
  if (r.v !== 1) throw new Error('v must be 1')
  checkShape({ v: 1, profile: r.profile, path: r.path, time: 0, body: r.body }, false)
  if (r.path === 'folder') throw new Error('the folder is changed in the person’s own app, not by request')
  if (isSealed(r.body as Body | null)) throw new Error('a sealed body cannot be shown, so it cannot be approved here')
  const hosts = r.hosts
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > MAX_HOSTS || hosts.some((h) => typeof h !== 'string' || normalizeOrigin(h) !== h)) {
    throw new Error(`hosts is 1 to ${MAX_HOSTS} origins`)
  }
}

/** The link that carries a request: the approval page, then `#` and the request. */
export function requestLink(page: string, request: ApprovalRequest): string {
  checkRequest(request)
  return `${page}#${b64u.encode(utf8(canonical(request)))}`
}

/** The request in a link (or in the text after its `#`), checked. Its text must be canonical. */
export function requestFromLink(link: string): ApprovalRequest {
  const value = parseCanonical(fromUtf8(b64u.decode(link.slice(link.indexOf('#') + 1))))
  checkRequest(value)
  return value
}

/** What the page shows, line by line, as plain text, before the tap. */
export function describe(request: ApprovalRequest): string[] {
  const { path, body } = request
  if (path.startsWith('grant/')) {
    if (body === null) return [`Take back the permission at ${path}.`, 'What it published before stays.']
    const grant = body as GrantBody
    return [
      `${grant.label ? `“${grant.label}”` : 'A program'} asks to publish for you on its own, until ${new Date(grant.until).toISOString().slice(0, 10)}.`,
      `Only: ${grant.paths.join(', ') || 'nothing'}. Never over what you wrote yourself.`,
      'You can take this back at any time. What it published before then stays.',
    ]
  }
  if (body === null) return [`Delete ${path}.`]
  return [`Publish ${path}:`, ...Object.entries(body).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)]
}

/** Which of the person's profiles a request is for. The other keys are wiped. */
export function findProfile(seed: Uint8Array, did: string): ProfileKey | null {
  for (let n = 0; n < MAX_PROFILES; n++) {
    const key = profileKey(seed, n)
    if (key.did === did) return key
    key.secretKey.fill(0)
  }
  return null
}

/** A profile as its hosts show it, each host's feed in its own order, every entry checked. */
export async function readProfile(did: string, hosts: string[], now: number): Promise<{ folder: FolderBody; view: ProfileView } | null> {
  const feeds: Version[][] = []
  for (const host of hosts) {
    try {
      feeds.push((await readAll(host, { profile: did })).versions)
    } catch {
      // A host that does not answer is skipped.
    }
  }
  const view = viewProfile(did, feeds, now)
  return view.folder ? { folder: view.folder, view } : null
}

/** The owner's current version at the request's path, if it is exactly what was asked. */
export function isPublished(view: ProfileView, request: ApprovalRequest): Version | null {
  const top = view.current.get(request.path)
  return top && top.entry.by === undefined && canonical(top.entry.body) === canonical(request.body) ? top : null
}

export type Approval = { entry: Entry; published: string[]; refused: string[] }

/** Sign a request with the profile's own key and post it to every host its signed folder names. */
export async function approve(seed: Uint8Array, request: ApprovalRequest, now: number): Promise<Approval> {
  checkRequest(request)
  const key = findProfile(seed, request.profile)
  if (!key) throw new Error('This is for a profile you do not hold.')
  try {
    const found = await readProfile(request.profile, request.hosts, now)
    if (!found) throw new Error('The profile could not be found on its hosts.')
    const entry = ownerEntry(key, request.path, request.body, nextTime(now, found.view, request.path))
    const outcomes = await publish(found.folder.hosts, [entry])
    const published = outcomes.filter((o) => o.results[0]?.ok).map((o) => o.host)
    const refused = outcomes.filter((o) => !o.results[0]?.ok).map((o) => `${o.host}: ${o.results[0]?.message ?? o.error ?? o.status}`)
    if (!published.length) throw new Error(`No host took it: ${refused.join('; ')}`)
    return { entry, published, refused }
  } finally {
    key.secretKey.fill(0)
  }
}

// What the approval page does, the same in a browser and in a test: find the profile the request
// is for among the person's own, show it, sign it with the profile's key, publish it to the hosts
// the profile's own signed folder names, and tell the door. The page never sends a key anywhere.

import { publish, readAll } from './client.ts'
import { type Body, type Entry, type FolderBody, type GrantBody, checkShape } from './entry.ts'
import { type ProfileKey, profileKey } from './keys.ts'
import { viewProfile } from './view.ts'
import { grantEntry, nextTime, ownerEntry } from './write.ts'

/** A draft the door asks the person to approve: exactly what will be signed, but the time. */
export type DraftRequest = { kind: 'draft'; id: string; door: string; profile: string; path: string; body: Body | null; hosts: string[] }

/** A connection the door asks for: a grant to the door's agent key for this profile. */
export type ConnectRequest = {
  kind: 'connect'
  id: string
  door: string
  profile: string
  agent: string
  client: string
  paths: string[]
  until: number
  hosts: string[]
}

export type ApprovalRequest = DraftRequest | ConnectRequest

export const MAX_PROFILES = 16

/** Which of the person's profiles a request is for. The page refuses a profile it cannot open. */
export function findProfile(seed: Uint8Array, did: string): ProfileKey | null {
  for (let n = 0; n < MAX_PROFILES; n++) {
    const key = profileKey(seed, n)
    if (key.did === did) return key
  }
  return null
}

/** The profile's own signed folder, read from the hosts the request names, checked. */
export async function readFolder(did: string, hints: string[], now: number): Promise<{ folder: FolderBody; view: ReturnType<typeof viewProfile> } | null> {
  const versions = []
  for (const host of hints) {
    try {
      versions.push(...(await readAll(host, { profile: did })).versions)
    } catch {
      // A host that does not answer is skipped.
    }
  }
  const view = viewProfile(did, versions, now)
  return view.folder ? { folder: view.folder, view } : null
}

/** The lines the page shows, as plain text, for the person to read before the tap. */
export function describe(request: ApprovalRequest): string[] {
  if (request.kind === 'connect') {
    const until = new Date(request.until).toISOString().slice(0, 10)
    return request.paths.length
      ? [
          `${request.client} asks to write for you, on its own, until ${until}.`,
          `Only: ${request.paths.join(', ')}. Nothing else, and never your own posts.`,
          'You can take it back at any time; what it wrote then disappears unless you keep it.',
        ]
      : [`${request.client} asks to prepare things for you to approve one at a time.`, 'It can publish nothing on its own.']
  }
  const lines = [request.body === null ? `Delete ${request.path}.` : `Publish ${request.path}:`]
  if (request.body !== null) for (const [key, value] of Object.entries(request.body)) lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return lines
}

export type ApprovalResult = { entry: Entry; published: string[]; refused: string[] }

/** Sign and publish an approved draft, then tell the door. */
export async function approveDraft(seed: Uint8Array, request: DraftRequest, now: number): Promise<ApprovalResult> {
  const key = findProfile(seed, request.profile)
  if (!key) throw new Error('this request is for a profile you do not hold')
  const found = await readFolder(request.profile, request.hosts, now)
  if (!found) throw new Error('the profile’s folder could not be read')
  checkShape({ v: 1, profile: request.profile, path: request.path, time: now, body: request.body }, false)
  const entry = ownerEntry(key, request.path, request.body, nextTime(now, found.view, request.path))
  return finish(request, entry, found.folder.hosts)
}

/** Sign the grant a connection asks for (or, with no paths, a private proof), and tell the door. */
export async function approveConnect(seed: Uint8Array, request: ConnectRequest, now: number): Promise<ApprovalResult> {
  const key = findProfile(seed, request.profile)
  if (!key) throw new Error('this request is for a profile you do not hold')
  const found = await readFolder(request.profile, request.hosts, now)
  if (!found) throw new Error('the profile’s folder could not be read')
  const grant: GrantBody = { to: request.agent, paths: request.paths, until: request.until, label: `${request.client}`.slice(0, 200), client: request.client.slice(0, 200) }
  const { entry } = grantEntry(key, request.id, grant, nextTime(now, found.view, `grant/${request.id}`))
  // A drafts-only connection publishes nothing: the proof goes to the door alone.
  return request.paths.length ? finish(request, entry, found.folder.hosts) : tellDoor(request, entry, [], [])
}

async function finish(request: ApprovalRequest, entry: Entry, hosts: string[]): Promise<ApprovalResult> {
  const outcomes = await publish(hosts, [entry])
  const published = outcomes.filter((o) => o.results[0]?.ok).map((o) => o.host)
  const refused = outcomes.filter((o) => !o.results[0]?.ok).map((o) => `${o.host}: ${o.results[0]?.error ?? o.error}`)
  if (!published.length) throw new Error(`no host took it: ${refused.join('; ')}`)
  return tellDoor(request, entry, published, refused)
}

async function tellDoor(request: ApprovalRequest, entry: Entry, published: string[], refused: string[]): Promise<ApprovalResult> {
  const res = await fetch(`${request.door}/${request.kind === 'draft' ? 'drafts' : 'connect'}/${request.id}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry }),
  })
  if (!res.ok) throw new Error(`the door answered ${res.status}: ${await res.text()}`)
  return { entry, published, refused }
}

export async function fetchRequest(url: string): Promise<ApprovalRequest> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not load the request (${res.status})`)
  return (await res.json()) as ApprovalRequest
}

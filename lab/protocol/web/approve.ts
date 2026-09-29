// The approval page. It is the one place the seed is opened: one tap and a face scan give the
// passkey's PRF output, the seed is made from it in memory, the profile's key signs, the page
// publishes, and the seed is dropped. Everything shown is plain text built with textContent.
//
//   #setup=<host>,<host>     first run: make a passkey, publish profile 0's folder and card
//   #connect=<door request>  an assistant asks for a standing rule
//   #draft=<door request>    an assistant asks to publish one thing

import { type ApprovalRequest, approveConnect, approveDraft, describe, fetchRequest } from '../src/approve.ts'
import { publish } from '../src/client.ts'
import { boxKey, profileKey, seedFromPrf } from '../src/keys.ts'
import { folderEntry, ownerEntry } from '../src/write.ts'

// keys/SPEC.md: the PRF input every Forest product uses.
const PRF_INPUT = new TextEncoder().encode('forest.foundation/prf/v1')

const $ = (id: string) => document.getElementById(id)!
const status = (text: string) => {
  $('status').textContent = text
}
function show(lines: string[]) {
  $('what').replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement('p')
      p.textContent = line
      return p
    }),
  )
}
function button(id: string, onClick: () => Promise<void>) {
  const b = $(id) as HTMLButtonElement
  b.hidden = false
  b.onclick = () => {
    for (const other of document.querySelectorAll('button')) other.disabled = true
    onClick()
      .catch((err: Error) => status(err.message))
      .finally(() => {
        for (const other of document.querySelectorAll('button')) other.disabled = false
      })
  }
}

async function createPasskey() {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Forest' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'forest', displayName: 'Forest' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} },
    },
  })) as PublicKeyCredential
  const prf = (credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf
  if (!prf?.enabled) throw new Error('This device’s passkeys cannot open Forest. Try another device or password manager.')
  status('Passkey ready.')
}

/** One tap and a face scan: the seed exists only inside `use`. */
async function withSeed<T>(use: (seed: Uint8Array) => Promise<T>): Promise<T> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  })) as PublicKeyCredential
  const first = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first
  if (!first) throw new Error('This passkey cannot open Forest.')
  const seed = seedFromPrf(new Uint8Array(first))
  try {
    return await use(seed)
  } finally {
    seed.fill(0)
  }
}

async function setup(hosts: string[]) {
  show(['Set up a profile on this device.', `It will live on: ${hosts.join(', ')}`])
  button('create', createPasskey)
  button('setup', () =>
    withSeed(async (seed) => {
      const key = profileKey(seed, 0)
      const box = await boxKey(seed, 0)
      const now = Date.now()
      const outcomes = await publish(hosts, [
        folderEntry(key, { hosts, box: box.recipient }, now),
        ownerEntry(key, 'profile', { market: 'tutoring', role: 'seller', name: 'Test profile', createdAt: new Date(now).toISOString() }, now),
      ])
      const ok = outcomes.filter((o) => o.results.every((r) => r.ok)).length
      document.body.dataset.profile = key.did
      status(`Profile ready on ${ok} of ${hosts.length} hosts.`)
    }),
  )
}

async function approve(request: ApprovalRequest) {
  show([...describe(request), `For your profile ending ${request.profile.slice(-6)}.`])
  button('approve', () =>
    withSeed(async (seed) => {
      const result = request.kind === 'draft' ? await approveDraft(seed, request, Date.now()) : await approveConnect(seed, request, Date.now())
      status(`Done. Published on ${result.published.length || 'no'} host${result.published.length === 1 ? '' : 's'}.`)
    }),
  )
  button('decline', async () => status('Declined. Nothing was signed.'))
}

async function main() {
  const params = new URLSearchParams(location.hash.slice(1))
  const setupHosts = params.get('setup')
  const target = params.get('draft') ?? params.get('connect')
  if (setupHosts) return setup(setupHosts.split(','))
  if (target) return approve(await fetchRequest(target))
  status('Nothing to approve.')
}

main().catch((err: Error) => status(err.message))

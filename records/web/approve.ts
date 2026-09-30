// The approval page: the one place a person's seed is opened. No framework.
//
//   1. Read the approval request from the link (after the #) and check it.
//   2. Show it as text: exactly what will be signed.
//   3. On Approve, one tap and a passkey: the passkey's PRF output makes the seed, in memory.
//   4. Find the request's profile among the person's own, read its signed folder, sign, and post
//      to every host the folder names.
//   5. Keep a copy on this device; wipe the seed.
//
// Code: this file and the protocol core in ../src (request, entry, canonical, keys, view, write,
// client, bytes). Libraries: @noble/curves, @noble/hashes, @scure/base, canonicalize. The build
// lists what the bundle holds in dist/approve.deps.txt, and the browser test checks that list.

import { encodeEntry } from '../src/entry.ts'
import { seedFromPrf } from '../src/keys.ts'
import { type ApprovalRequest, approve, describe, requestFromLink } from '../src/request.ts'

// keys/SPEC.md: the PRF input every Forest product uses.
const PRF_INPUT = new TextEncoder().encode('forest.foundation/prf/v1')

const note = document.getElementById('note')!
const status = document.getElementById('status')!
const approveButton = document.getElementById('approve') as HTMLButtonElement
const declineButton = document.getElementById('decline') as HTMLButtonElement

function say(text: string) {
  status.textContent = text
}

async function seedFromPasskey(): Promise<Uint8Array> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  })) as PublicKeyCredential | null
  const results = credential?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined
  const first = results?.prf?.results?.first
  if (!first) throw new Error('This passkey cannot open Forest.')
  const prf = new Uint8Array(first)
  const seed = seedFromPrf(prf)
  prf.fill(0)
  return seed
}

/** The person's own copy of what they signed, on this device. The hosts have it too. */
function keepCopy(line: string) {
  try {
    const copies = JSON.parse(localStorage.getItem('forest.entries') ?? '[]') as string[]
    copies.push(line)
    localStorage.setItem('forest.entries', JSON.stringify(copies))
  } catch {
    // Storage full or off: the hosts still hold it.
  }
}

async function onApprove(request: ApprovalRequest) {
  approveButton.disabled = declineButton.disabled = true
  say('Waiting for your passkey…')
  let seed: Uint8Array | undefined
  try {
    seed = await seedFromPasskey()
    const { entry, published } = await approve(seed, request, Date.now())
    keepCopy(encodeEntry(entry))
    say(`Done. Published on ${published.length} host${published.length === 1 ? '' : 's'}.`)
  } catch (err) {
    say((err as Error).message)
    approveButton.disabled = declineButton.disabled = false
  } finally {
    seed?.fill(0)
  }
}

function main() {
  let request: ApprovalRequest
  try {
    request = requestFromLink(location.hash)
  } catch (err) {
    say(`This link cannot be approved: ${(err as Error).message}`)
    return
  }
  for (const line of [...describe(request), `For your profile ending ${request.profile.slice(-6)}.`]) {
    const p = document.createElement('p')
    p.textContent = line
    note.append(p)
  }
  approveButton.hidden = declineButton.hidden = false
  approveButton.onclick = () => void onApprove(request)
  declineButton.onclick = () => {
    approveButton.disabled = declineButton.disabled = true
    say('Declined. Nothing was signed.')
  }
}

main()

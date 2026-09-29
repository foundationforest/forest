// The AI door over MCP (SDK v2, protocol 2026-07-28), with the approval page played in Node by
// the keys recipe's fixed test seed. The browser test does the same with a real passkey.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type ConnectRequest, type DraftRequest, approveConnect, approveDraft, describe as describeRequest, fetchRequest } from '../src/approve.ts'
import { publish, readAll } from '../src/client.ts'
import { Door } from '../src/door.ts'
import type { Host } from '../src/host.ts'
import { viewProfile } from '../src/view.ts'
import { delegateEntry, folderEntry, ownerEntry } from '../src/write.ts'
import { OTHER_SEED, SEED, alice, bob, offerBody, profileBody, reviewBody } from './fixtures.ts'
import { startHost } from './helpers.ts'

const requestUrl = (url: string) => {
  const fragment = new URL(url).hash.slice(1)
  return fragment.slice(fragment.indexOf('=') + 1)
}

/** The approval page, played in Node: open the request, approve with a seed. */
async function approveAt(url: string, seed: Uint8Array) {
  const request = await fetchRequest(requestUrl(url))
  return request.kind === 'draft' ? approveDraft(seed, request as DraftRequest, Date.now()) : approveConnect(seed, request as ConnectRequest, Date.now())
}

async function mcpClient(door: Door, token: string, onUrl: (url: string) => Promise<void>, autoFulfill = true) {
  // Pinned to MCP 2026-07-28: approvals come back to the client as input_required + requestState.
  const client = new Client(
    { name: 'test-assistant', version: '0.0.0' },
    { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill, maxRounds: 3 } },
  )
  client.setRequestHandler('elicitation/create', async (request) => {
    const params = request.params as { mode?: string; url?: string }
    if (params.mode !== 'url' || !params.url) return { action: 'decline' as const }
    await onUrl(params.url)
    return { action: 'accept' as const }
  })
  // Over HTTP, as a remote connector: the token rides as a bearer token on every request.
  await client.connect(new StreamableHTTPClientTransport(new URL(`${door.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '')

describe('the door', () => {
  let h1: Host
  let h2: Host
  let hosts: string[]
  let door: Door
  let token: string

  before(async () => {
    h1 = await startHost()
    h2 = await startHost()
    hosts = [h1.url, h2.url]
    await publish(hosts, [folderEntry(alice, { hosts }, Date.now()), ownerEntry(alice, 'profile', profileBody('Alice'), Date.now())])
    door = new Door({ approvalPage: 'http://localhost:9/approve.html', waitMs: 300 })
    await door.listen()
  })
  after(async () => {
    await door.close()
    await h1.close()
    await h2.close()
  })

  test('connect: one approval signs a narrow, short grant for a key the door derives; the client trades its verifier for the token', async () => {
    const started = door.startConnect({ profile: alice.did, hosts, client: 'claude.ai', paths: ['offer'], days: 7 })
    const request = (await fetchRequest(requestUrl(started.url))) as ConnectRequest
    assert.match(describeRequest(request).join(' '), /claude\.ai asks to write for you, on its own, until .* Only: offer/)
    await approveAt(started.url, SEED)
    assert.throws(() => door.exchange(started.id, 'not-the-verifier'), /wrong verifier/)
    token = door.exchange(started.id, started.verifier)
    assert.throws(() => door.exchange(started.id, started.verifier), /unknown/, 'once only')
    // The grant is public, on the profile's hosts, naming the door's agent key, not the person's.
    const grants = (await readAll(h1.url, { profile: alice.did, path: 'grant' })).versions
    assert.equal(grants.length, 1)
    assert.notEqual((grants[0]!.entry.body as { to: string }).to, alice.did)
  })

  test('standing rule: the assistant publishes an offer with the phone off', async () => {
    const client = await mcpClient(door, token, async () => assert.fail('no approval should be needed'))
    const result = await client.callTool({ name: 'forest_write', arguments: { path: 'offer/physics', body: offerBody('40') } })
    assert.match(textOf(result), /Published offer\/physics, signed by the assistant/)
    const onHost = viewProfile(alice.did, (await readAll(h2.url, { profile: alice.did })).versions, Date.now()).current.get('offer/physics')!
    assert.ok(onHost.entry.by && onHost.entry.by !== alice.did)
    await client.close()
  })

  test('per action: a review is outside the rule, so it goes to the phone by URL; one approval signs it with the person’s key', async () => {
    let shownUrl = ''
    const client = await mcpClient(door, token, async (url) => {
      shownUrl = url
      await approveAt(url, SEED)
    })
    const result = await client.callTool({ name: 'forest_write', arguments: { path: 'review/1', body: reviewBody(bob.did) } })
    assert.match(textOf(result), /Approved and published review\/1/)
    assert.match(shownUrl, /^http:\/\/localhost:9\/approve\.html#draft=http:\/\/127\.0\.0\.1:\d+\/drafts\/[0-9a-f]+$/)
    const review = viewProfile(alice.did, (await readAll(h1.url, { profile: alice.did })).versions, Date.now()).current.get('review/1')!
    assert.equal(review.entry.by, undefined, 'signed by the profile itself')
    await client.close()
  })

  test('someone else cannot approve it: a draft for Alice opened with another person’s passkey is refused', async () => {
    const client = await mcpClient(door, token, async (url) => {
      await assert.rejects(approveAt(url, OTHER_SEED), /profile you do not hold/)
    })
    const result = await client.callTool({ name: 'forest_write', arguments: { path: 'review/2', body: reviewBody(bob.did) } }).catch((e: Error) => e)
    assert.ok(result instanceof Error && /still required input|rounds/i.test(result.message), String(result))
    const onHost = viewProfile(alice.did, (await readAll(h1.url, { profile: alice.did })).versions, Date.now())
    assert.equal(onHost.current.has('review/2'), false, 'nothing was published')
    await client.close()
  })

  test('the door accepts only the draft that was shown, signed by the profile itself', async () => {
    const client = await mcpClient(door, token, async (url) => {
      const request = (await fetchRequest(requestUrl(url))) as DraftRequest
      const changed = ownerEntry(alice, request.path, { ...request.body, text: 'something else' }, Date.now())
      await assert.rejects(post(`${request.door}/drafts/${request.id}/done`, changed), /400/)
      const otherProfile = ownerEntry(bob, request.path, request.body, Date.now())
      await assert.rejects(post(`${request.door}/drafts/${request.id}/done`, otherProfile), /400/)
      await approveAt(url, SEED)
    })
    const result = await client.callTool({ name: 'forest_write', arguments: { path: 'review/3', body: reviewBody(bob.did) } })
    assert.match(textOf(result), /Approved and published/)
    await client.close()
  })

  test('a leaked master key alone signs nothing under the grant; with an intercepted token it can', async () => {
    const leaked = (door as unknown as { master: Uint8Array }).master
    const thief = new Door({ approvalPage: 'x', master: leaked })
    const grant = (await readAll(h1.url, { profile: alice.did, path: 'grant' })).versions[0]!
    const grantTo = (grant.entry.body as { to: string }).to
    // Without the token there is no nonce: every guess derives some other key.
    for (let i = 0; i < 100; i++) assert.notEqual(thief.agentKey(i.toString(16).padStart(32, '0')).did, grantTo)
    const guess = thief.agentKey('00'.repeat(16))
    const refused = await publish(hosts, [delegateEntry(guess, alice.did, grant.id, 'offer/x', offerBody('1'), Date.now())])
    assert.equal(refused[0]!.results[0]!.error, 'grant')
    // With the token (which the running door sees on every call) the thief is the assistant.
    const session = thief.openToken(token)!
    const agent = thief.agentKey(session.nonce)
    assert.equal(agent.did, grantTo)
    const within = await publish(hosts, [delegateEntry(agent, alice.did, grant.id, 'offer/y', offerBody('1'), Date.now())])
    assert.equal(within[0]!.results[0]!.ok, true, 'within the grant: yes')
    const outside = await publish(hosts, [delegateEntry(agent, alice.did, grant.id, 'review/y', reviewBody(bob.did), Date.now())])
    assert.equal(outside[0]!.results[0]!.error, 'grant', 'outside it: no')
  })

  test('a forged, replayed or foreign requestState is refused', async () => {
    // Manual mode: the client sees the input_required result itself, with its requestState.
    const manual = await mcpClient(door, token, async () => {}, false)
    const first = (await manual.callTool({ name: 'forest_write', arguments: { path: 'review/5', body: reviewBody(bob.did) } }, { allowInputRequired: true } as never)) as {
      resultType?: string
      requestState?: string
      inputRequests?: Record<string, { params: { mode: string; url: string } }>
    }
    assert.equal(first.resultType, 'input_required')
    const state = first.requestState!
    const url = first.inputRequests!.approve!.params.url
    assert.ok(state && url)

    const retry = (requestState: string, client = manual) =>
      client
        .callTool({ name: 'forest_write', arguments: { path: 'review/5', body: reviewBody(bob.did) }, requestState, inputResponses: { approve: { action: 'accept' } } } as never, {
          allowInputRequired: true,
        } as never)
        .then((r) => textOf(r) || JSON.stringify(r))
        .catch((e: Error) => `error: ${e.message}`)

    // Forged: one character changed.
    const forged = state.slice(0, -2) + (state.endsWith('A') ? 'B' : 'A') + state.slice(-1)
    assert.match(await retry(forged), /error/i)
    // Foreign: another connection of the same profile cannot use this one's approval.
    const other = door.startConnect({ profile: alice.did, hosts, client: 'other-client', paths: [], days: 1 })
    await approveAt(other.url, SEED)
    const second = await mcpClient(door, door.exchange(other.id, other.verifier), async () => {}, false)
    await approveAt(url, SEED)
    assert.match(await retry(state, second), /another connection/)
    // The right connection gets the answer once; a replay gets nothing more.
    assert.match(await retry(state), /Approved and published review\/5/)
    assert.match(await retry(state), /Already reported/)
    await second.close()
    await manual.close()
  })

  test('consent phishing: approving a connection someone else started connects their client (the page’s defence is to say who asks)', async () => {
    const attacker = door.startConnect({ profile: alice.did, hosts, client: 'evil.example', paths: ['offer'], days: 7 })
    const request = (await fetchRequest(requestUrl(attacker.url))) as ConnectRequest
    assert.match(describeRequest(request)[0]!, /^evil\.example asks/)
    await approveAt(attacker.url, SEED) // the person did not read it
    const stolen = door.exchange(attacker.id, attacker.verifier)
    assert.ok(door.openToken(stolen), 'the attacker now holds a narrow, revocable connection')
  })
})

async function post(url: string, entry: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry }) })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}


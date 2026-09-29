// Connections for assistants over MCP (SDK v2, protocol 2026-07-28, over HTTP, no login): the
// assistant reads public notes and drafts; the person approves on their own device. The approval
// page is played in Node with the keys recipe's fixed test seed; browser.test.ts does the same
// with a real passkey.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { b64u, utf8 } from '../src/bytes.ts'
import { publish, readAll } from '../src/client.ts'
import { Connections } from '../src/connections.ts'
import { checkEntry } from '../src/entry.ts'
import type { Host } from '../src/host.ts'
import { type ApprovalRequest, approve, checkRequest, describe as describeRequest, requestFromLink, requestLink } from '../src/request.ts'
import { viewProfile } from '../src/view.ts'
import { delegateEntry, folderEntry, ownerEntry } from '../src/write.ts'
import { DAY, OTHER_SEED, SEED, T0, alice, bob, offerBody, profileBody, reviewBody, stranger } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

const PAGE = 'https://forest.example/approve'

async function mcpClient(service: Connections, onUrl: (url: string) => Promise<void>, autoFulfill = true) {
  // Pinned to MCP 2026-07-28: an approval comes back to the client as input_required.
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
  await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`)))
  return client
}

const textOf = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]?.text ?? ''
const draft = (path: string, body: Record<string, unknown> | null) => ({ name: 'forest_draft', arguments: { profile: alice.did, path, body } })

describe('connections for assistants', () => {
  const clock = new Clock(T0)
  let h1: Host
  let h2: Host
  let hosts: string[]
  let service: Connections
  const onHosts = async (path: string) =>
    viewProfile(alice.did, [(await readAll(h1.url, { profile: alice.did })).versions, (await readAll(h2.url, { profile: alice.did })).versions], clock.t).current.get(path)

  before(async () => {
    h1 = await startHost({ now: clock.now })
    h2 = await startHost({ now: clock.now })
    hosts = [h1.url, h2.url]
    // The person's app, once: a folder naming both hosts, and a profile card.
    await publish(hosts, [folderEntry(alice, { hosts }, T0), ownerEntry(alice, 'profile', profileBody('Alice'), T0)])
    // The service knows one host; the profile's folder names the other.
    service = new Connections({ approvalPage: PAGE, hosts: [h1.url], now: clock.now, waitMs: 300 })
    await service.listen()
  })
  after(async () => {
    await service.close()
    await h1.close()
    await h2.close()
  })

  test('reading needs nothing: no key, no grant, no login', async () => {
    const client = await mcpClient(service, async () => assert.fail('no approval to read'))
    assert.match(textOf(await client.callTool({ name: 'forest_read', arguments: { profile: alice.did } })), /"name": "Alice"/)
    await client.close()
  })

  test('a draft: its link carries exactly the note, nothing is published until the person signs, and a copy of the service that never saw it reports it', async () => {
    const manual = await mcpClient(service, async () => {}, false)
    const first = (await manual.callTool(draft('offer/physics', offerBody('40')), { allowInputRequired: true } as never)) as {
      resultType?: string
      inputRequests?: Record<string, { params: { mode: string; url: string } }>
    }
    assert.equal(first.resultType, 'input_required')
    const url = first.inputRequests!.approve!.params.url
    assert.ok(url.startsWith(`${PAGE}#`))
    const request = requestFromLink(url)
    assert.deepEqual(request, { v: 1, profile: alice.did, path: 'offer/physics', body: offerBody('40'), hosts })
    assert.equal(await onHosts('offer/physics'), undefined)
    await manual.close()

    await approve(SEED, request, clock.t) // the page, on the person's phone

    const other = new Connections({ approvalPage: PAGE, hosts: [h2.url], now: clock.now, waitMs: 300 })
    await other.listen()
    try {
      const client = await mcpClient(other, async () => assert.fail('already published'))
      assert.match(textOf(await client.callTool(draft('offer/physics', offerBody('40')))), /^Published: offer\/physics/)
      await client.close()
    } finally {
      await other.close()
    }
    assert.equal((await onHosts('offer/physics'))!.entry.by, undefined, 'signed by the profile itself')
  })

  test('the person is away: the assistant hears the draft waits; days later one approval publishes it, and the assistant sees it', async () => {
    let shown = ''
    const client = await mcpClient(service, async (url) => {
      shown = url // shown in the conversation; nobody opens it now
    })
    const result = (await client.callTool(draft('review/1', reviewBody(bob.did)))) as { isError?: boolean }
    assert.match(textOf(result), /^Not approved yet, and nothing is published\. The draft waits in its link/)
    assert.equal(result.isError, false)
    assert.equal(await onHosts('review/1'), undefined)

    // The link is the draft: nothing to expire. The person returns and approves.
    clock.advance(3 * DAY)
    await approve(SEED, requestFromLink(shown), clock.t)
    assert.match(textOf(await client.callTool({ name: 'forest_read', arguments: { profile: alice.did } })), /"review\/1"/)
    assert.match(textOf(await client.callTool(draft('review/1', reviewBody(bob.did)))), /^Published: review\/1/)
    await client.close()
  })

  test('one tap while the assistant waits: approved on the phone, reported published', async () => {
    const client = await mcpClient(service, async (url) => {
      await approve(SEED, requestFromLink(url), clock.t)
    })
    assert.match(textOf(await client.callTool(draft('offer/chemistry', offerBody('45')))), /^Published: offer\/chemistry/)
    await client.close()
  })

  test('someone else’s passkey cannot approve it: nothing is published', async () => {
    const client = await mcpClient(service, async (url) => {
      await assert.rejects(approve(OTHER_SEED, requestFromLink(url), clock.t), /profile you do not hold/)
    })
    assert.match(textOf(await client.callTool(draft('review/2', reviewBody(bob.did)))), /^Not approved yet/)
    assert.equal(await onHosts('review/2'), undefined)
    await client.close()
  })

  test('what a link cannot carry: the folder, a sealed body, a changed or non-canonical request', async () => {
    const client = await mcpClient(service, async () => assert.fail('nothing to approve'))
    assert.match(textOf(await client.callTool(draft('folder', { hosts: ['https://evil.example'] }))), /cannot be drafted: the folder/)
    assert.match(textOf(await client.callTool(draft('note/1', { sealed: 'YWdl' }))), /cannot be drafted: a sealed body/)
    await client.close()

    const request: ApprovalRequest = { v: 1, profile: alice.did, path: 'offer/a', body: offerBody('1'), hosts }
    const spaced = JSON.stringify(request, null, 1)
    assert.throws(() => requestFromLink(`${PAGE}#${b64u.encode(utf8(spaced))}`), /canonical/)
    assert.throws(() => checkRequest({ ...request, from: 'someone' }), /exactly/)
    assert.throws(() => requestFromLink(requestLink(PAGE, request).slice(0, -3) + 'AAA'))
  })

  test('FINDING, consent phishing: approving a permission someone else asked for lets their key publish within it', async () => {
    const request: ApprovalRequest = {
      v: 1,
      profile: alice.did,
      path: 'grant/helper',
      body: { to: stranger.did, paths: ['offer'], until: clock.t + 7 * DAY, label: 'Helpful app' },
      hosts,
    }
    const lines = describeRequest(request)
    assert.match(lines[0]!, /^“Helpful app” asks to publish for you on its own, until \d{4}-\d{2}-\d{2}\.$/)
    assert.match(lines[1]!, /^Only: offer\./)
    const { entry } = await approve(SEED, request, clock.t) // the person did not read it
    const grantId = checkEntry(entry).id
    const [inside] = await publish(hosts, [delegateEntry(stranger, alice.did, grantId, 'offer/scam', offerBody('1'), clock.t)])
    assert.equal(inside!.results[0]!.ok, true, 'within the permission: yes')
    const [outside] = await publish(hosts, [delegateEntry(stranger, alice.did, grantId, 'review/scam', reviewBody(bob.did), clock.t)])
    assert.equal(outside!.results[0]!.error, 'grant', 'outside it: no')

    // Taking it back is one more approval, of null at the same path. What was posted stays.
    const takeBack: ApprovalRequest = { ...request, body: null }
    assert.deepEqual(describeRequest(takeBack), ['Take back the permission at grant/helper.', 'What it published before stays.'])
    clock.advance(1)
    await approve(SEED, takeBack, clock.t)
    const [after] = await publish(hosts, [delegateEntry(stranger, alice.did, grantId, 'offer/scam2', offerBody('1'), clock.t)])
    assert.equal(after!.results[0]!.message, 'grant-not-current')
    assert.equal((await onHosts('offer/scam'))!.entry.by, stranger.did)
  })
})

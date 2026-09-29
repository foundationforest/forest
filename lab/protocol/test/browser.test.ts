// The approval page in a real browser with a real WebAuthn passkey (PRF): headless Chromium with
// a virtual authenticator standing in for the phone. A note approved with one tap; an assistant's
// draft approved through MCP; a permission for the person's own signer; HTML in a draft; another
// person's passkey; a broken link. Real phones are not tested here.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core'
import { hex } from '../src/bytes.ts'
import { publish, readAll } from '../src/client.ts'
import { Connections } from '../src/connections.ts'
import { checkEntry } from '../src/entry.ts'
import type { Host } from '../src/host.ts'
import { profileKey, seedFromPrf } from '../src/keys.ts'
import { type ApprovalRequest, requestLink } from '../src/request.ts'
import { viewProfile } from '../src/view.ts'
import { delegateEntry, folderEntry, ownerEntry } from '../src/write.ts'
import { DAY, offerBody, profileBody, reviewBody, signer } from './fixtures.ts'
import { startHost } from './helpers.ts'

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const DIST = new URL('../web/dist/', import.meta.url).pathname

async function servePage(): Promise<{ server: Server; origin: string }> {
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css' }
  const server = createServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://page.invalid').pathname.slice(1) || 'approve.html'
    if (!/^approve\.(html|js|css)$/.test(name)) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': types[name.split('.').pop()!]! }).end(readFileSync(DIST + name))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The passkey belongs to the page's origin: http://localhost is a secure context, like https.
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}` }
}

/** A browser profile with its own virtual authenticator: one person's phone. */
async function phone(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })
  return { context, page }
}

/**
 * The person's first run, which is the app's job and not the page's: make a passkey on the page's
 * origin and get its PRF output. The test then makes the seed from it in Node, as the app would.
 */
async function firstRun(page: Page, origin: string): Promise<Uint8Array> {
  await page.goto(`${origin}/approve.html`)
  const prf = await page.evaluate(async () => {
    const input = new TextEncoder().encode('forest.foundation/prf/v1')
    await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Forest' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'forest', displayName: 'Forest' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} },
      },
    })
    const got = (await navigator.credentials.get({
      publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', extensions: { prf: { eval: { first: input } } } },
    })) as PublicKeyCredential
    const first = (got.getClientExtensionResults() as { prf: { results: { first: ArrayBuffer } } }).prf.results.first
    return [...new Uint8Array(first)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })
  return seedFromPrf(hex.decode(prf))
}

async function open(page: Page, url: string) {
  await page.goto('about:blank')
  await page.goto(url)
}
const statusText = (page: Page) => page.locator('#status').textContent()
const done = (page: Page) => page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done.'))

describe('the approval page with a real passkey', { skip: existsSync(CHROME) ? false : `no Chromium at ${CHROME}` }, () => {
  let browser: Browser
  let alicePhone: { context: BrowserContext; page: Page }
  let h1: Host
  let h2: Host
  let hosts: string[]
  let pageServer: Server
  let origin: string
  let profile: string
  const request = (path: string, body: ApprovalRequest['body']): ApprovalRequest => ({ v: 1, profile, path, body, hosts })
  const view = async () => viewProfile(profile, [(await readAll(h1.url, { profile })).versions, (await readAll(h2.url, { profile })).versions], Date.now())

  before(async () => {
    execFileSync(process.execPath, [new URL('../web/build.ts', import.meta.url).pathname])
    h1 = await startHost()
    h2 = await startHost()
    hosts = [h1.url, h2.url]
    ;({ server: pageServer, origin } = await servePage())
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    alicePhone = await phone(browser)
    const key = profileKey(await firstRun(alicePhone.page, origin), 0)
    profile = key.did
    await publish(hosts, [folderEntry(key, { hosts }, Date.now()), ownerEntry(key, 'profile', profileBody('Alice'), Date.now())])
  })
  after(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => pageServer?.close(() => resolve()))
    await h1?.close()
    await h2?.close()
  })

  test('the page’s code is this lab’s and four libraries’, and nothing else', () => {
    const libraries = readFileSync(`${DIST}approve.deps.txt`, 'utf8').trim().split('\n').map((line) => line.split(' ')[0])
    assert.deepEqual(libraries, ['@noble/curves', '@noble/hashes', '@scure/base', 'canonicalize'])
  })

  test('a note: the page shows exactly what it will sign, as text; one tap and the passkey post it to every host; the device keeps a copy', async () => {
    const { page } = alicePhone
    await open(page, requestLink(`${origin}/approve.html`, request('offer/maths', offerBody('30'))))
    await page.waitForSelector('#approve:not([hidden])')
    const shown = (await page.locator('#note').textContent())!
    assert.match(shown, /^Publish offer\/maths:/)
    assert.match(shown, /description: One hour of maths tutoring, online\./)
    await page.click('#approve')
    await done(page)
    assert.equal(await statusText(page), 'Done. Published on 2 hosts.')
    const offer = (await view()).current.get('offer/maths')!
    assert.equal(offer.entry.by, undefined, 'signed by the profile itself')
    const copies = JSON.parse((await page.evaluate(() => localStorage.getItem('forest.entries')))!) as string[]
    assert.equal(checkEntry(JSON.parse(copies.at(-1)!)).id, offer.id)
  })

  test('an assistant over MCP: the draft’s link opened on the phone, one tap, reported published', async () => {
    const { page } = alicePhone
    const service = new Connections({ approvalPage: `${origin}/approve.html`, hosts: [h1.url], waitMs: 3000 })
    await service.listen()
    const client = new Client(
      { name: 'assistant', version: '0.0.0' },
      { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { maxRounds: 3 } },
    )
    client.setRequestHandler('elicitation/create', async (req) => {
      await open(page, (req.params as { url: string }).url)
      await page.waitForSelector('#approve:not([hidden])')
      await page.click('#approve')
      await done(page)
      return { action: 'accept' as const }
    })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`)))
      const result = await client.callTool({ name: 'forest_draft', arguments: { profile, path: 'review/1', body: reviewBody(profile) } })
      assert.match(JSON.stringify(result), /Published: review\/1/)
      assert.equal((await view()).current.get('review/1')!.entry.by, undefined)
    } finally {
      await client.close()
      await service.close()
    }
  })

  test('a permission for a signer of the person’s own: one tap; then the signer publishes with the phone off', async () => {
    const { page } = alicePhone
    const until = Date.now() + 7 * DAY
    await open(page, requestLink(`${origin}/approve.html`, request('grant/mine', { to: signer.did, paths: ['offer'], until, label: 'My signer, offers only' })))
    await page.waitForSelector('#approve:not([hidden])')
    assert.match((await page.locator('#note').textContent())!, /^“My signer, offers only” asks to publish for you on its own, until \d{4}-\d{2}-\d{2}\.Only: offer\./)
    await page.click('#approve')
    await done(page)
    const grant = (await view()).current.get('grant/mine')!
    const [outcome] = await publish(hosts, [delegateEntry(signer, profile, grant.id, 'offer/weekend', offerBody('50'), Date.now())])
    assert.equal(outcome!.results[0]!.ok, true)
  })

  test('a draft that carries HTML is shown as text and runs nothing; the page refuses HTML from strings altogether', async () => {
    const { page } = alicePhone
    const payload = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>'
    await open(page, requestLink(`${origin}/approve.html`, request('review/2', { subject: profile, text: payload })))
    await page.waitForSelector('#approve:not([hidden])')
    assert.equal(await page.locator('#note img, #note script').count(), 0)
    assert.match((await page.locator('#note').textContent())!, /<img src=x onerror=/)
    assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined)
    const sink = await page.evaluate(() => {
      try {
        document.getElementById('note')!.innerHTML = '<b>x</b>'
        return 'allowed'
      } catch {
        return 'blocked'
      }
    })
    assert.equal(sink, 'blocked')
    await page.click('#decline')
    assert.equal(await statusText(page), 'Declined. Nothing was signed.')
    assert.equal((await view()).current.get('review/2'), undefined)
  })

  test('another person’s passkey cannot approve a note for this profile', async () => {
    const bobPhone = await phone(browser)
    try {
      await firstRun(bobPhone.page, origin)
      await open(bobPhone.page, requestLink(`${origin}/approve.html`, request('review/3', reviewBody(profile))))
      await bobPhone.page.waitForSelector('#approve:not([hidden])')
      await bobPhone.page.click('#approve')
      await bobPhone.page.waitForFunction(() => /profile you do not hold/.test(document.getElementById('status')?.textContent ?? ''))
      assert.equal((await view()).current.get('review/3'), undefined)
    } finally {
      await bobPhone.context.close()
    }
  })

  test('a broken link: the page says so and offers nothing to approve', async () => {
    const { page } = alicePhone
    await open(page, `${origin}/approve.html#bm90IGEgcmVxdWVzdA`)
    await page.waitForFunction(() => /cannot be approved/.test(document.getElementById('status')?.textContent ?? ''))
    assert.equal(await page.locator('#approve').isHidden(), true)
  })
})

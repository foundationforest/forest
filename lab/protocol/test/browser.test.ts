// The approval page in a real browser with a real WebAuthn passkey (PRF): headless Chromium with
// a virtual authenticator standing in for the phone. Keys from the passkey; a connection approved
// with one tap; an assistant's draft approved with one tap through MCP; a draft that tries to
// inject HTML; another person's passkey refused. Real phones are not tested here.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core'
import { readAll } from '../src/client.ts'
import { Door } from '../src/door.ts'
import type { Host } from '../src/host.ts'
import { viewProfile } from '../src/view.ts'
import { offerBody, reviewBody } from './fixtures.ts'
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

async function open(page: Page, url: string) {
  await page.goto('about:blank')
  await page.goto(url)
}
const statusText = (page: Page) => page.locator('#status').textContent()

describe('approval page with a real passkey', { skip: existsSync(CHROME) ? false : `no Chromium at ${CHROME}` }, () => {
  let browser: Browser
  let alicePhone: { context: BrowserContext; page: Page }
  let h1: Host
  let h2: Host
  let hosts: string[]
  let door: Door
  let pageServer: Server
  let origin: string
  let profile: string
  let token: string

  before(async () => {
    execFileSync(process.execPath, [new URL('../web/build.ts', import.meta.url).pathname])
    h1 = await startHost()
    h2 = await startHost()
    hosts = [h1.url, h2.url]
    ;({ server: pageServer, origin } = await servePage())
    door = new Door({ approvalPage: `${origin}/approve.html`, waitMs: 500 })
    await door.listen()
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    alicePhone = await phone(browser)
  })
  after(async () => {
    await browser?.close()
    await door?.close()
    await new Promise<void>((resolve) => pageServer?.close(() => resolve()))
    await h1?.close()
    await h2?.close()
  })

  test('a passkey with PRF makes the seed in the page; the profile it publishes is the same every time', async () => {
    const { page } = alicePhone
    await open(page, `${origin}/approve.html#setup=${hosts.join(',')}`)
    await page.click('#create')
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Passkey ready.')
    await page.click('#setup')
    await page.waitForFunction(() => document.body.dataset.profile)
    profile = (await page.evaluate(() => document.body.dataset.profile))!
    assert.match((await statusText(page))!, /Profile ready on 2 of 2 hosts/)
    // Again, after a reload: the same passkey gives the same profile.
    await open(page, `${origin}/approve.html#setup=${hosts.join(',')}`)
    await page.click('#setup')
    await page.waitForFunction(() => document.body.dataset.profile)
    assert.equal(await page.evaluate(() => document.body.dataset.profile), profile)
    const view = viewProfile(profile, (await readAll(h1.url, { profile })).versions, Date.now())
    assert.equal(view.folder?.hosts.length, 2)
    assert.match(view.folder!.box!, /^age1pq1/)
  })

  test('connect: the page says who asks and for what; one tap signs the grant', async () => {
    const { page } = alicePhone
    const started = door.startConnect({ profile, hosts, client: 'claude.ai', paths: ['offer'], days: 7 })
    await open(page, started.url)
    await page.waitForSelector('#approve:not([hidden])')
    const shown = (await page.locator('#what').textContent())!
    assert.match(shown, /claude\.ai asks to write for you, on its own, until/)
    assert.match(shown, /Only: offer/)
    await page.click('#approve')
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done.'))
    token = door.exchange(started.id, started.verifier)
  })

  test('an assistant over MCP: an offer under the rule at once; a review approved on the phone with one tap', async () => {
    const { page } = alicePhone
    const client = new Client(
      { name: 'assistant', version: '0.0.0' },
      { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { maxRounds: 3 } },
    )
    const opened: string[] = []
    client.setRequestHandler('elicitation/create', async (request) => {
      const { url } = request.params as { url: string }
      opened.push(url)
      await open(page, url)
      await page.waitForSelector('#approve:not([hidden])')
      await page.click('#approve')
      await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done.'))
      return { action: 'accept' as const }
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${door.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))

    const offer = await client.callTool({ name: 'forest_write', arguments: { path: 'offer/maths', body: offerBody('30') } })
    assert.match(JSON.stringify(offer), /signed by the assistant/)
    assert.equal(opened.length, 0, 'no approval needed within the rule')

    const review = await client.callTool({ name: 'forest_write', arguments: { path: 'review/1', body: reviewBody(profile) } })
    assert.match(JSON.stringify(review), /Approved and published review\/1/)
    assert.equal(opened.length, 1)
    const view = viewProfile(profile, (await readAll(h2.url, { profile })).versions, Date.now())
    assert.equal(view.current.get('review/1')!.entry.by, undefined, 'the person’s own signature')
    assert.ok(view.current.get('offer/maths')!.entry.by, 'the assistant’s signature')
    await client.close()
  })

  test('a draft that carries HTML is shown as text and runs nothing', async () => {
    const { page } = alicePhone
    const client = new Client({ name: 'assistant', version: '0.0.0' }, { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill: false } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${door.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    const payload = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>'
    const result = (await client.callTool({ name: 'forest_write', arguments: { path: 'review/2', body: { subject: profile, text: payload } } }, { allowInputRequired: true } as never)) as unknown as {
      inputRequests: Record<string, { params: { url: string } }>
    }
    await open(page, result.inputRequests.approve!.params.url)
    await page.waitForSelector('#approve:not([hidden])')
    assert.equal(await page.locator('#what img, #what script').count(), 0)
    assert.match((await page.locator('#what').textContent())!, /<img src=x onerror=/)
    assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined)
    // Defence in depth: the page's policy refuses HTML from strings altogether (Trusted Types).
    const sink = await page.evaluate(() => {
      try {
        document.getElementById('what')!.innerHTML = '<b>x</b>'
        return 'allowed'
      } catch {
        return 'blocked'
      }
    })
    assert.equal(sink, 'blocked')
    await page.click('#decline')
    await client.close()
  })

  test('another person’s passkey cannot approve a draft for this profile', async () => {
    const bobPhone = await phone(browser)
    try {
      await open(bobPhone.page, `${origin}/approve.html#setup=${hosts.join(',')}`)
      await bobPhone.page.click('#create')
      await bobPhone.page.waitForFunction(() => document.getElementById('status')?.textContent === 'Passkey ready.')
      const client = new Client({ name: 'assistant', version: '0.0.0' }, { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill: false } })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${door.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      const result = (await client.callTool({ name: 'forest_write', arguments: { path: 'review/3', body: reviewBody(profile) } }, { allowInputRequired: true } as never)) as unknown as {
        inputRequests: Record<string, { params: { url: string } }>
      }
      await open(bobPhone.page, result.inputRequests.approve!.params.url)
      await bobPhone.page.waitForSelector('#approve:not([hidden])')
      await bobPhone.page.click('#approve')
      await bobPhone.page.waitForFunction(() => /profile you do not hold/.test(document.getElementById('status')?.textContent ?? ''))
      await client.close()
    } finally {
      await bobPhone.context.close()
    }
  })
})

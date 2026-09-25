// The pages for people and machines, on part one's story (test/fixture.ts) in a fresh database,
// served over a local node:http server:
//   1. every page and its twin renders;
//   2. every JSON-LD block parses and validates against schema.org's vocabulary;
//   3. each twin matches its page;
//   4. the sitemap lists exactly the pages there are, and each resolves;
//   5. robots.txt lets everyone in; llms.txt says what Forest is and its links resolve;
//   6. every URL in the read skill resolves;
//   7. no crypto word anywhere a person reads;
//   8. the Pay link reads back to the offer's own terms, and the pay page checks it.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { startWeb } from '../src/main.ts'
import type { Web } from '../src/web/routes.ts'
import { serve } from '../src/web/server.ts'
import { trustAsRating } from '../src/web/jsonld.ts'
import { parsePayLink } from '../src/web/paylink.ts'
import * as w from '../src/web/words.ts'
import { CATEGORY, DEAL, MADE_UP_DEAL, MARKET, OFFERS, ana, ben, cleo, makeFixture } from './fixture.ts'
import { validateJsonLd } from './schemaorg/validate.ts'

// -----------------------------------------------------------------------------------------------
// Reading a page the way a person or a crawler does
// -----------------------------------------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** What a person reads: the text, and the attributes a browser shows (title, alt, placeholder, labels, the description). */
function readable(html: string): string {
  const noCode = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  const attrs = [...noCode.matchAll(/\s(?:title|alt|placeholder|aria-label|content)="([^"]*)"/g)].map((m) => m[1])
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ''
  return decode([title, ...attrs, noCode.replace(/<[^>]+>/g, ' ')].join(' ')).replace(/\s+/g, ' ')
}

const linkRel = (html: string, rel: string) => {
  const m = new RegExp(`<link rel="${rel}"(?: type="[^"]+")? href="([^"]+)">`).exec(html)
  return m ? decode(m[1]) : null
}
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))

const BANNED = /\b(wallets?|usdc|chains?|blockchains?|gas|crypto(currency)?|tokens?|solana|mints?)\b/i

test('pages for people and machines', { timeout: 120_000 }, async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not set')
  const fixture = await makeFixture(process.env.DATABASE_URL)
  const holder: { web?: Web } = {}
  const server = await serve({ handle: (req) => holder.web!.handle(req) }, 0, '127.0.0.1')
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    holder.web = (await startWeb(fixture.db, fixture.config({ PUBLIC_URL: base }), { listen: false })).web
    const get = async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url.startsWith('http') ? url : base + url, { redirect: 'manual', ...init })
      return { status: res.status, headers: res.headers, text: await res.text() }
    }
    const json = async (url: string) => JSON.parse((await get(url)).text)

    const anaTwin = await json(`/profiles/${ana.did}.json`)
    const portuguese = anaTwin.offers.find((o: any) => o.uri === OFFERS.portuguese.uri)
    const spanish = anaTwin.offers.find((o: any) => o.uri === OFFERS.spanish.uri)
    const altered = new URL(portuguese.payLink)
    altered.searchParams.set('price.amount', '1')

    /** Every page, with the URL its canonical link must name. */
    const PAGES: { path: string; canonical: string }[] = [
      { path: '/', canonical: `${base}/` },
      { path: `/categories/${CATEGORY}`, canonical: `${base}/categories/${CATEGORY}` },
      { path: `/markets/${MARKET}`, canonical: `${base}/markets/${MARKET}` },
      ...[ana, ben, cleo].map((p) => ({ path: `/profiles/${p.did}`, canonical: `${base}/profiles/${p.did}` })),
      { path: `/deals/${DEAL}`, canonical: `${base}/deals/${DEAL}` },
      { path: `/deals/${MADE_UP_DEAL}`, canonical: `${base}/deals/${MADE_UP_DEAL}` },
      { path: '/search?q=portuguese', canonical: `${base}/search?q=portuguese` },
      { path: '/search', canonical: `${base}/search?q=` },
      { path: new URL(portuguese.payLink).pathname + new URL(portuguese.payLink).search, canonical: portuguese.payLink },
      { path: new URL(spanish.payLink).pathname + new URL(spanish.payLink).search, canonical: spanish.payLink },
      { path: altered.pathname + altered.search, canonical: altered.toString() },
    ]
    const rendered = new Map<string, string>()
    for (const p of PAGES) rendered.set(p.path, (await get(p.path)).text)

    await t.test('1. every page and its twin renders', async () => {
      for (const p of PAGES) {
        const res = await get(p.path)
        assert.equal(res.status, 200, p.path)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', p.path)
        assert.equal(res.headers.get('set-cookie'), null, `${p.path}: no cookies`)
        assert.equal(res.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=300', p.path)
        assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/, p.path)
        assert.ok(res.text.startsWith('<!doctype html>'), p.path)
        assert.match(res.text, /<title>[^<]+<\/title>/, p.path)
        assert.equal(linkRel(res.text, 'canonical'), p.canonical, `${p.path}: canonical`)
        const twin = linkRel(res.text, 'alternate')
        assert.ok(twin, `${p.path}: links its twin`)
        assert.equal(res.headers.get('link'), `<${twin}>; rel="alternate"; type="application/json"`, `${p.path}: the twin in a header too`)
        assert.equal((await get(twin!)).status, 200, `${p.path}: its twin answers`)
        assert.equal(jsonLd(res.text).length, 1, `${p.path}: one JSON-LD block`)
        assert.equal([...res.text.matchAll(/<script\b/g)].length, 1, `${p.path}: no script but the data block`)
      }
      // Search engines are kept off search results, pay links and deals with no receipt.
      for (const p of PAGES) {
        const noindex = /<meta name="robots" content="noindex">/.test(rendered.get(p.path)!)
        assert.equal(noindex, p.path.startsWith('/search') || p.path.startsWith('/pay') || p.path.endsWith(MADE_UP_DEAL), `${p.path}: noindex`)
      }

      const alias = await get('/markets/online-tutor')
      assert.equal(alias.status, 301)
      assert.equal(alias.headers.get('location'), `${base}/markets/${MARKET}`)
      assert.equal((await get('/markets/online-tutor.json?offset=0')).headers.get('location'), `${base}/markets/${MARKET}.json?offset=0`)
      for (const path of ['/profiles/did:plc:nobody', '/markets/plumbers', '/categories/nothing', `/deals/${'00'.repeat(32)}`, '/nope', '/profiles/%E0%A4%A']) {
        const res = await get(path)
        assert.equal(res.status, 404, path)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', path)
      }
      const missing = await get('/profiles/did:plc:nobody.json')
      assert.equal(missing.status, 404)
      assert.equal(JSON.parse(missing.text).error, 'NotFound')
      assert.deepEqual(JSON.parse((await get('/search.json')).text).offers, [], 'no words, no results: the twin of the empty search page')
      assert.equal((await get('/', { method: 'HEAD' })).text, '')
      assert.equal((await get('/', { method: 'POST' })).status, 405)
    })

    await t.test("2. every JSON-LD block is valid schema.org", async () => {
      for (const p of PAGES) {
        for (const doc of jsonLd(rendered.get(p.path)!)) assert.deepEqual(validateJsonLd(doc), [], p.path)
      }
      // What a shopping AI reads from Ana's page.
      const g: any[] = jsonLd(rendered.get(`/profiles/${ana.did}`)!)[0]['@graph']
      const person = g.find((n) => n['@type'] === 'Person')
      assert.equal(person.name, ana.name)
      assert.equal(person.identifier, ana.did)
      assert.deepEqual(person.makesOffer.map((o: any) => [o.price, o.priceCurrency, o.priceSpecification.unitText]), [['25', 'USD', 'hour'], ['12.50', 'USD', 'hour']])
      const rating = g.find((n) => n['@type'] === 'AggregateRating')
      assert.equal(rating.ratingValue, trustAsRating(anaTwin.scores.trust.value), 'from the trust score')
      assert.equal(rating.reviewCount, 2)
      assert.equal(rating.itemReviewed['@id'], person['@id'])
      const reviews = g.filter((n) => n['@type'] === 'Review')
      assert.deepEqual(reviews.map((r) => [r.author.name, r.reviewRating.ratingValue]).sort(), [['Ben Okafor', 5], ['Cleo', 1]])
      // Cleo has no reviews: no rating at all rather than an empty one.
      const cleoGraph: any[] = jsonLd(rendered.get(`/profiles/${cleo.did}`)!)[0]['@graph']
      assert.equal(cleoGraph.find((n) => n['@type'] === 'AggregateRating'), undefined)
      const pay: any = jsonLd(rendered.get(`/deals/${DEAL}`)!)[0]['@graph'].find((n: any) => n['@type'] === 'PayAction')
      assert.deepEqual([pay.agent.name, pay.recipient.name, pay.price, pay.priceCurrency], [ben.name, ana.name, '25', 'USD'])
      // The validator itself refuses what schema.org does: a rating on a Person, a made-up type.
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Person', aggregateRating: { '@type': 'AggregateRating', ratingValue: 5 } }).length > 0)
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Tutor', name: 'x' }).length > 0)
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Offer', price: true }).length > 0)
    })

    await t.test('3. each twin matches its page', async () => {
      const cur = (a: string, mint: string) => w.money(a, mint, fixture.config().currencies).text
      for (const p of PAGES) {
        const html = rendered.get(p.path)!
        const twin = await json(linkRel(html, 'alternate')!)
        assert.equal(twin.url, p.canonical, `${p.path}: the twin names the page`)
        assert.equal(twin.json, linkRel(html, 'alternate'), `${p.path}: and itself`)
        const text = readable(html)
        const facts: string[] = []
        const offer = (o: any) => facts.push(o.description, w.price(o.price, fixture.config().currencies))
        switch (twin.kind) {
          case 'home':
            for (const c of twin.categories) facts.push(w.title(c.category), ...c.markets.map((m: any) => w.title(m.name)), ...c.markets.map((m: any) => w.plural(m.offers, 'offer')))
            break
          case 'category':
            facts.push(w.title(twin.category), ...twin.markets.map((m: any) => w.title(m.name)))
            break
          case 'market':
            facts.push(w.title(twin.market.name), twin.market.description, w.plural(twin.counts.offers, 'offer'))
            for (const o of twin.offers) offer(o), facts.push(o.name, w.score(o.trust))
            break
          case 'profile':
            facts.push(twin.profile.name, w.score(twin.scores.trust.value))
            if (twin.profile.about) facts.push(twin.profile.about)
            if (twin.profile.contact) facts.push(twin.profile.contact)
            for (const u of twin.scores.uniqueness) facts.push(w.percent(u.value))
            for (const b of twin.badges) facts.push(w.title(b.market), ...(b.counted ? [w.BADGE] : [w.badgeWhyNot(b.why)]))
            twin.offers.forEach(offer)
            for (const r of [...twin.reviews.received, ...twin.reviews.given]) facts.push(r.text, w.stars(r.rating), w.evidence(r.evidence.kind, r.evidence.note))
            break
          case 'deal':
            for (const r of twin.reviews) facts.push(r.text, r.reviewerName, r.subjectName)
            if (twin.receipt) facts.push(w.moneyFromBase(twin.receipt.amount, twin.receipt.mint, fixture.config().currencies).text, ...twin.receipt.buyerProfiles.map((x: any) => x.name), ...twin.receipt.sellerProfiles.map((x: any) => x.name))
            break
          case 'search':
            twin.offers.forEach(offer)
            if (twin.q) facts.push(twin.q)
            break
          case 'pay':
            if (twin.offer) offer(twin.offer)
            break
          default:
            assert.fail(`${p.path}: a twin of kind ${twin.kind}`)
        }
        for (const f of facts) assert.ok(text.includes(f), `${p.path}: the page shows "${f}"`)
        if (twin.kind !== 'search' || twin.q) assert.ok(facts.length > 0, `${p.path}: something to compare`)
      }
      // The numbers themselves, for the profile whose scores part one's test checks.
      assert.ok(Math.abs(anaTwin.scores.trust.value - (1 + 1.618034 / 2.618034 - 0.0025)) < 1e-3, `Ana ${anaTwin.scores.trust.value}`)
      assert.equal(cur('25', portuguese.price.mint), '$25')
      assert.equal(cur('12.5', portuguese.price.mint), '$12.50')
    })

    await t.test('4. the sitemap lists every page, and each resolves', async () => {
      const res = await get('/sitemap.xml')
      assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8')
      assert.match(res.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/)
      const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]))
      const listed = PAGES.filter((p) => !/<meta name="robots" content="noindex">/.test(rendered.get(p.path)!)).map((p) => p.canonical)
      assert.deepEqual([...locs].sort(), [...listed].sort(), 'every page meant for search engines, and nothing else')
      for (const loc of locs) assert.equal((await get(loc)).status, 200, loc)
    })

    await t.test('5. robots.txt lets everyone in; llms.txt says what Forest is', async () => {
      const robots = await get('/robots.txt')
      assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.match(robots.text, /^User-agent: \*$/m)
      assert.match(robots.text, /^Allow: \/$/m)
      assert.doesNotMatch(robots.text, /Disallow/)
      assert.match(robots.text, new RegExp(`^Sitemap: ${base}/sitemap.xml$`, 'm'))

      const llms = (await get('/llms.txt')).text
      assert.match(llms, /^# Forest\n/)
      assert.equal([...llms.matchAll(/^> .+$/gm)].length, 3, 'what Forest is, in three lines')
      const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1])
      assert.ok(links.length >= 6)
      for (const link of links) {
        if (link.startsWith('https://github.com/foundationforest/forest')) continue
        assert.ok(link.startsWith(base), `${link} is on this index`)
        assert.equal((await get(link)).status, 200, link)
      }
    })

    await t.test("6. every URL in the read skill resolves", async () => {
      const skill = await get('/skill.md')
      assert.equal(skill.headers.get('content-type'), 'text/markdown; charset=utf-8')
      assert.doesNotMatch(skill.text, /https:\/\/forest\.foundation/, 'written for forest.foundation, served with this index’s address')
      const found = [...skill.text.matchAll(/https?:\/\/[^\s`)"'<>]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''))
      const local = found.filter((u) => u.startsWith(base))
      assert.ok(local.length >= 10, `${local.length} examples`)
      for (const u of local) {
        let res = await get(u)
        if (res.status === 301) res = await get(res.headers.get('location')!)
        assert.equal(res.status, 200, u)
      }
      assert.ok(local.includes(portuguese.payLink), 'the Pay link example is the offer’s own link')
      for (const u of found.filter((x) => !x.startsWith(base))) assert.ok(u.startsWith('https://github.com/foundationforest/forest'), u)
    })

    await t.test('7. no crypto word anywhere a person reads', async () => {
      const everyPage = [...rendered.values(), (await get('/nope')).text, (await get('/pay?v=1')).text, (await get(`/deals/${MADE_UP_DEAL}`)).text]
      for (const html of everyPage) {
        const text = readable(html)
        const hit = BANNED.exec(text)
        assert.equal(hit, null, `"${hit?.[0]}" in: …${hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : ''}…`)
      }
    })

    await t.test('8. the Pay link reads back to the offer’s own terms', async () => {
      const read = parsePayLink(new URL(spanish.payLink).searchParams)
      assert.ok(read.ok)
      assert.deepEqual(read.link, { v: 1, offer: OFFERS.spanish.uri, cid: OFFERS.spanish.cid, price: spanish.price, terms: { timer: { days: 7, to: 'seller' } } })
      assert.equal(new URL(portuguese.payLink).searchParams.has('seller'), false, 'no key in the link: the app looks it up')
      const check = async (u: string) => (await json(`${base}/pay.json${new URL(u, base).search}`)).check
      assert.equal(await check(portuguese.payLink), 'matches')
      assert.equal(await check(altered.toString()), 'differs')
      const moved = new URL(portuguese.payLink)
      moved.searchParams.set('cid', 'bafyreianolderversionofthisoffer')
      assert.equal(await check(moved.toString()), 'changed')
      const gone = new URL(portuguese.payLink)
      gone.searchParams.set('offer', `at://${ben.did}/foundation.forest.post/3kzq2vrffxb9z`)
      assert.equal(await check(gone.toString()), 'notFound')
      assert.equal(await check(`${base}/pay?v=1`), 'invalid')
      assert.match(readable(rendered.get(altered.pathname + altered.search)!), /Don’t pay from it/)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fixture.drop()
  }
})

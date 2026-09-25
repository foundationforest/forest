// The page models. One function per page reads the database and returns one object: that object
// is the page's JSON twin, and the HTML is rendered from it (pages.ts), so the two never say
// different things. Field names such as `wallet` and `mint` are the records' own; they are for
// machines, and the HTML shows none of them.

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Directory, MarketFile } from '../markets.ts'
import { badgeStatus } from '../scores/compute.ts'
import { STATEMENT_HEADER } from '../scores/sign.ts'
import { type Urls, SCORING_DOC, SOURCE, PAYLINK_DOC } from './html.ts'
import { type PayLink, payLink } from './paylink.ts'

export type Ctx = { db: Db; directory: Directory; config: Config; urls: Urls }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const micro = (v: string | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(BigInt(v)) / 1_000_000)

/** Every model says what page it is and where it and its twin live. */
type Self = { kind: string; url: string; json: string }
const self = (ctx: Ctx, kind: string, url: string): Self => ({ kind, url, json: ctx.urls.json(url) })

// -----------------------------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------------------------

export type Offer = ReturnType<typeof offerOut>

function offerOut(ctx: Ctx, row: any) {
  const r = row.record
  const live = row.direction === 'offer' && row.market !== null && (row.expires === null || new Date(row.expires) > new Date())
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    name: (row.name as string | null) ?? null,
    profileUrl: ctx.urls.profile(row.did),
    direction: row.direction as 'offer' | 'request',
    market: row.market as string | null,
    marketUrl: row.market ? ctx.urls.market(row.market) : null,
    marketWritten: row.market_written as string,
    role: row.role as string,
    description: row.description as string,
    price: r.price as PayLink['price'],
    terms: (r.terms ?? null) as PayLink['terms'],
    availability: (r.availability ?? null) as string | null,
    remote: (row.remote ?? null) as boolean | null,
    location: (row.location ?? null) as string | null,
    expires: iso(row.expires),
    createdAt: iso(row.created_at),
    /** The seller's best uniqueness on a badge in this post's market, and their trust. Side by side, never one number. */
    uniqueness: micro(row.uniqueness),
    trust: micro(row.trust),
    /** The Pay link (PAYLINK.md): only on a live offer whose profile names a key to be paid at. */
    payLink: live && row.declared ? payLink(ctx.urls.base, { uri: row.uri, cid: row.cid, record: r }) : null,
  }
}

const OFFER_SELECT = `select p.*, pr.name, pr.wallet as declared,
       (select max(s.value_micro) from scores s where s.did = p.did and s.kind = 'uniqueness'
          and split_part(s.scope, '/', 1) = p.market) as uniqueness,
       (select s.value_micro from scores s where s.did = p.did and s.kind = 'trust' and s.scope = '') as trust
     from posts p left join profiles pr on pr.did = p.did`

const LIVE = `p.direction = 'offer' and p.market is not null and (p.expires is null or p.expires > now())`

/** Live offers, badged sellers first, then by trust, then newest: two keys side by side. */
async function offers(ctx: Ctx, where: string, params: unknown[], limit: number, offset: number) {
  const { rows } = await ctx.db.query(
    `select * , count(*) over () as total from (${OFFER_SELECT} where ${LIVE} and ${where}) o
     order by (coalesce(o.uniqueness, 0) > 0) desc, coalesce(o.trust, 0) desc, o.created_at desc nulls last, o.uri
     limit ${limit} offset ${offset}`,
    params,
  )
  return { total: rows.length ? Number(rows[0].total) : 0, offers: rows.map((r) => offerOut(ctx, r)) }
}

export type Review = Awaited<ReturnType<typeof reviews>>[number]

/** Reviews with how each was weighed, and the names and pages of both sides. */
async function reviews(ctx: Ctx, where: string, params: unknown[]) {
  const { rows } = await ctx.db.query(
    `select v.*, w.counted, w.skipped, w.evidence_kind, w.evidence_note, w.evidence_weight, w.reviewer_weight, w.contribution,
            a.name as reviewer_name, b.name as subject_name, (e.escrow is not null) as has_receipt
     from reviews v left join review_weights w on w.uri = v.uri
       left join profiles a on a.did = v.reviewer left join profiles b on b.did = v.subject
       left join escrow_receipts e on e.escrow = v.deal_id
     where ${where} order by v.created_at desc nulls last, v.uri`,
    params,
  )
  return rows.map((row) => ({
    uri: row.uri as string,
    reviewer: row.reviewer as string,
    reviewerName: (row.reviewer_name ?? null) as string | null,
    reviewerUrl: ctx.urls.profile(row.reviewer),
    subject: row.subject as string,
    subjectName: (row.subject_name ?? null) as string | null,
    subjectUrl: ctx.urls.profile(row.subject),
    rating: row.rating as number | null,
    text: row.text as string | null,
    dealId: row.deal_id as string | null,
    dealUrl: row.deal_id ? ctx.urls.deal(row.deal_id) : null,
    hasReceipt: Boolean(row.has_receipt),
    createdAt: iso(row.created_at),
    counted: (row.counted ?? false) as boolean,
    skipped: (row.skipped ?? null) as string | null,
    evidence: { kind: (row.evidence_kind ?? 'none') as string, note: (row.evidence_note ?? null) as string | null, weight: (row.evidence_weight ?? 0) as number },
    reviewerWeight: (row.reviewer_weight ?? 0) as number,
    contribution: (row.contribution ?? 0) as number,
  }))
}

function scoreOut(row: any) {
  return {
    scope: row.scope as string,
    value: micro(row.value_micro),
    valueMicro: String(row.value_micro),
    details: row.details,
    computedAt: Number(row.computed_at),
    signed: { statement: row.statement, message: row.message, ed25519: row.sig_ed25519, eddsaPoseidon: row.sig_eddsa },
  }
}

function marketOut(ctx: Ctx, m: MarketFile, counts: Map<string, number>) {
  return { name: m.name, url: ctx.urls.market(m.name), description: m.description ?? null, offers: counts.get(m.name) ?? 0 }
}

async function liveOfferCounts(ctx: Ctx): Promise<Map<string, number>> {
  const { rows } = await ctx.db.query(`select p.market, count(*)::int as n from posts p where ${LIVE} group by p.market`)
  return new Map(rows.map((r) => [r.market, r.n]))
}

// -----------------------------------------------------------------------------------------------
// Pages
// -----------------------------------------------------------------------------------------------

export async function home(ctx: Ctx) {
  const counts = await liveOfferCounts(ctx)
  const keys = await ctx.db.query(`select value from index_meta where key = 'publicKeys'`)
  return {
    ...self(ctx, 'home', ctx.urls.home()),
    index: {
      name: 'Forest index',
      about: 'Profiles, badges, reviews and payment receipts, read from signed records and the programs’ own events, each profile scored twice.',
      scoring: { version: 'v1', rules: SCORING_DOC },
      payLink: PAYLINK_DOC,
      source: SOURCE,
      keys: (keys.rows[0]?.value ?? null) as { ed25519: string; eddsaPoseidon: [string, string] } | null,
      statement: {
        header: STATEMENT_HEADER,
        lines: ['kind <uniqueness|trust>', 'did <did>', 'scope <badge scope, or empty>', 'value <millionths>', 'at <unix seconds>'],
        ed25519: 'over the statement text, UTF-8',
        eddsaPoseidon: 'over message = Poseidon(domain, kind, did, scope, value + 2^63, at); see index/SCORING.md',
      },
      machines: {
        sitemap: ctx.urls.file('sitemap.xml'),
        llms: ctx.urls.file('llms.txt'),
        skill: ctx.urls.file('skill.md'),
        search: `${ctx.urls.base}/search.json?q={q}`,
      },
    },
    categories: [...ctx.directory.categories()].map(([category, names]) => ({
      category,
      url: ctx.urls.category(category),
      markets: names.map((n) => marketOut(ctx, ctx.directory.markets.get(n)!, counts)),
    })),
  }
}

export async function category(ctx: Ctx, name: string) {
  const names = ctx.directory.categories().get(name)
  if (!names) return null
  const counts = await liveOfferCounts(ctx)
  return {
    ...self(ctx, 'category', ctx.urls.category(name)),
    category: name,
    markets: names.map((n) => marketOut(ctx, ctx.directory.markets.get(n)!, counts)),
  }
}

export const PAGE_SIZE = 50

export async function market(ctx: Ctx, name: string, offset: number) {
  const file = ctx.directory.markets.get(name)
  if (!file) return null
  const [posts, badges, page] = await Promise.all([
    ctx.db.query(
      `select direction, count(*)::int as n from posts where market = $1 and (expires is null or expires > now()) group by direction`,
      [name],
    ),
    ctx.db.query(
      `select b.did, b.wallet, b.scope, b.list_owner, p.wallet as declared from badges b join profiles p on p.did = b.did where b.market = $1`,
      [name],
    ),
    offers(ctx, 'p.market = $1', [name], PAGE_SIZE, offset),
  ])
  const counted = new Set(
    badges.rows
      .filter((b) => badgeStatus({ did: b.did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner }, b.declared, ctx.directory).counted)
      .map((b) => b.did),
  )
  const by = new Map(posts.rows.map((r) => [r.direction, r.n]))
  return {
    ...self(ctx, 'market', ctx.urls.market(name, offset)),
    market: file,
    categoryUrl: ctx.urls.category(file.category),
    aliases: ctx.directory.aliasesFor(name),
    counts: { offers: by.get('offer') ?? 0, requests: by.get('request') ?? 0, badgedProfiles: counted.size },
    limit: PAGE_SIZE,
    offset,
    total: page.total,
    next: offset + PAGE_SIZE < page.total ? ctx.urls.market(name, offset + PAGE_SIZE) : null,
    offers: page.offers,
  }
}

export async function profile(ctx: Ctx, did: string) {
  const { rows } = await ctx.db.query('select * from profiles where did = $1', [did])
  if (!rows.length) return null
  const p = rows[0]
  const r = p.record
  const [badges, scores, posts, credentials, received, given] = await Promise.all([
    ctx.db.query(
      `select b.*, t.block_time as registered_at from badges b join chain_transactions t on t.signature = b.signature
       where b.did = $1 order by b.slot, b.ix`,
      [did],
    ),
    ctx.db.query('select * from scores where did = $1 order by kind, scope', [did]),
    ctx.db.query(`${OFFER_SELECT} where p.did = $1 order by p.created_at desc nulls last, p.uri`, [did]),
    ctx.db.query('select * from credentials where did = $1 order by created_at desc nulls last, uri', [did]),
    reviews(ctx, 'v.subject = $1', [did]),
    reviews(ctx, 'v.reviewer = $1', [did]),
  ])
  const trust = scores.rows.find((s) => s.kind === 'trust')
  const allPosts = posts.rows.map((row) => offerOut(ctx, row))
  const isLive = (o: Offer) => o.market !== null && (o.expires === null || new Date(o.expires) > new Date())
  return {
    ...self(ctx, 'profile', ctx.urls.profile(did)),
    did,
    profile: {
      name: p.name as string,
      about: (r.about ?? null) as string | null,
      contact: (r.contact ?? null) as string | null,
      wallet: (p.wallet ?? null) as string | null,
      photo: r.photo ? { cid: (r.photo.ref?.$link ?? null) as string | null, mimeType: (r.photo.mimeType ?? null) as string | null } : null,
      createdAt: iso(p.created_at),
      cid: p.cid as string,
    },
    badges: badges.rows.map((b) => {
      const status = badgeStatus({ did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner }, p.wallet, ctx.directory)
      const issuer = ctx.config.issuers[b.list_owner]
      return {
        scope: b.scope as string,
        market: b.market as string,
        marketUrl: ctx.directory.markets.has(b.market) ? ctx.urls.market(b.market) : null,
        role: b.role as string | null,
        listIndex: b.list_index as number,
        listOwner: b.list_owner as string,
        issuer: { name: (issuer?.name ?? null) as string | null, weight: (issuer?.weight ?? 0) as number },
        wallet: b.wallet as string,
        counted: status.counted,
        why: status.counted ? null : status.why,
        registeredAt: iso(b.registered_at),
        transaction: b.signature as string,
      }
    }),
    scores: {
      uniqueness: scores.rows.filter((s) => s.kind === 'uniqueness').map(scoreOut),
      trust: trust ? scoreOut(trust) : null,
    },
    offers: allPosts.filter((o) => o.direction === 'offer' && isLive(o)),
    requests: allPosts.filter((o) => o.direction === 'request' && isLive(o)),
    credentials: credentials.rows.map((c) => ({ uri: c.uri, issuer: c.issuer, createdAt: iso(c.created_at), credential: c.record.credential })),
    reviews: { received, given },
  }
}

export async function deal(ctx: Ctx, dealId: string) {
  const [receipt, named] = await Promise.all([
    ctx.db.query('select * from escrow_receipts where escrow = $1', [dealId]),
    reviews(ctx, 'v.deal_id = $1', [dealId]),
  ])
  if (!receipt.rowCount && !named.length) return null
  let out = null
  if (receipt.rowCount) {
    const e = receipt.rows[0]
    const profiles = await ctx.db.query('select did, name, wallet from profiles where wallet = any($1) order by did', [[e.buyer, e.seller]])
    const of = (w: string) => profiles.rows.filter((p) => p.wallet === w).map((p) => ({ did: p.did as string, name: p.name as string, url: ctx.urls.profile(p.did) }))
    out = {
      escrow: e.escrow as string,
      program: e.program_id as string,
      buyer: e.buyer as string,
      seller: e.seller as string,
      creator: e.creator as 'buyer' | 'seller',
      buyerProfiles: of(e.buyer),
      sellerProfiles: of(e.seller),
      mint: e.mint as string,
      amount: e.amount as string,
      arbiter: (e.arbiter ?? null) as string | null,
      timer: e.timer_days ? { days: e.timer_days as number, to: e.timer_to as 'buyer' | 'seller' } : null,
      createdAt: iso(e.created_at),
      fundedAt: iso(e.funded_at),
      endedAt: iso(e.ended_at),
      outcome: (e.outcome ?? null) as string | null,
      toSeller: (e.to_seller ?? null) as string | null,
      toBuyer: (e.to_buyer ?? null) as string | null,
      closed: e.closed as boolean,
      transaction: e.signature as string,
    }
  }
  return { ...self(ctx, 'deal', ctx.urls.deal(dealId)), dealId, receipt: out, reviews: named }
}

export async function search(ctx: Ctx, q: string) {
  const needle = q.toLowerCase()
  const counts = await liveOfferCounts(ctx)
  const markets = q
    ? [...ctx.directory.markets.values()]
        .map((m) => {
          const aliases = ctx.directory.aliasesFor(m.name)
          const matched = m.name.includes(needle)
            ? 'name'
            : aliases.some((a) => a.includes(needle))
              ? 'alias'
              : m.category.includes(needle)
                ? 'category'
                : m.roles.some((r) => r.includes(needle))
                  ? 'role'
                  : null
          return matched ? { ...marketOut(ctx, m, counts), category: m.category, matched } : null
        })
        .filter((m) => m !== null)
    : []
  const page = q ? await offers(ctx, `p.search @@ websearch_to_tsquery('simple', $1)`, [q], PAGE_SIZE, 0) : { total: 0, offers: [] }
  return { ...self(ctx, 'search', ctx.urls.search(q)), q, markets, offers: page.offers, total: page.total }
}

/** Every page meant for search engines, for the sitemap. Search, pay and deals with no receipt are left out (noindex). */
export async function pages(ctx: Ctx): Promise<string[]> {
  const [profiles, deals] = await Promise.all([
    ctx.db.query('select did from profiles order by did'),
    ctx.db.query('select escrow from escrow_receipts order by escrow'),
  ])
  return [
    ctx.urls.home(),
    ...[...ctx.directory.categories().keys()].map(ctx.urls.category),
    ...[...ctx.directory.markets.keys()].sort().map((m) => ctx.urls.market(m)),
    ...profiles.rows.map((r) => ctx.urls.profile(r.did)),
    ...deals.rows.map((r) => ctx.urls.deal(r.escrow)),
  ]
}

/** One offer, by its record address, for the pay page. */
export async function offerByUri(ctx: Ctx, uri: string): Promise<Offer | null> {
  const { rows } = await ctx.db.query(`${OFFER_SELECT} where p.uri = $1`, [uri])
  return rows.length ? offerOut(ctx, rows[0]) : null
}

export type HomeModel = Awaited<ReturnType<typeof home>>
export type CategoryModel = NonNullable<Awaited<ReturnType<typeof category>>>
export type MarketModel = NonNullable<Awaited<ReturnType<typeof market>>>
export type ProfileModel = NonNullable<Awaited<ReturnType<typeof profile>>>
export type DealModel = NonNullable<Awaited<ReturnType<typeof deal>>>
export type SearchModel = Awaited<ReturnType<typeof search>>

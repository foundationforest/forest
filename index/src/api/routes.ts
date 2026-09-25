// The JSON endpoints. Stable URLs, GET only, no session, no login, no cookies, cacheable, open to
// any origin. `handle` takes a web-standard Request and returns a Response, so part two can mount
// it under any server (node:http here, a Vercel function later) unchanged.
//
// Field names such as `wallet` and `mint` are the records' own; they are for machines. Pages for
// people (part two) say none of them.

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Directory } from '../markets.ts'
import { badgeStatus } from '../scores/compute.ts'
import { type IndexKeys, STATEMENT_HEADER, publicKeys } from '../scores/sign.ts'

export type Api = { handle: (req: Request) => Promise<Response> }

const CACHE = 'public, max-age=30, stale-while-revalidate=300'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? CACHE : 'public, max-age=10',
      'access-control-allow-origin': '*',
      ...headers,
    },
  })
}
const notFound = (message: string) => json(404, { error: 'NotFound', message })
const badRequest = (message: string) => json(400, { error: 'BadRequest', message })

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const micro = (v: string | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(BigInt(v)) / 1_000_000)

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name)
  const n = raw === null ? fallback : Number(raw)
  if (!Number.isInteger(n) || n < 0) return fallback
  return Math.min(n, max)
}

export function createApi(ctx: { db: Db; directory: Directory; config: Config; keys: IndexKeys }): Api {
  const { db, directory } = ctx

  // -------------------------------------------------------------------------------------------
  // Shared shapes
  // -------------------------------------------------------------------------------------------

  function scoreOut(row: any) {
    return {
      scope: row.scope,
      value: micro(row.value_micro),
      valueMicro: String(row.value_micro),
      details: row.details,
      computedAt: Number(row.computed_at),
      signed: { statement: row.statement, message: row.message, ed25519: row.sig_ed25519, eddsaPoseidon: row.sig_eddsa },
    }
  }

  function offerOut(row: any) {
    const r = row.record
    return {
      uri: row.uri,
      did: row.did,
      name: row.name ?? null,
      direction: row.direction,
      market: row.market,
      marketWritten: row.market_written,
      role: row.role,
      description: row.description,
      price: r.price,
      terms: r.terms ?? null,
      availability: r.availability ?? null,
      remote: row.remote,
      location: row.location ?? null,
      expires: iso(row.expires),
      createdAt: iso(row.created_at),
      uniqueness: micro(row.uniqueness),
      trust: micro(row.trust),
    }
  }

  function reviewOut(row: any) {
    return {
      uri: row.uri,
      reviewer: row.reviewer,
      subject: row.subject,
      rating: row.rating,
      text: row.text,
      dealId: row.deal_id,
      createdAt: iso(row.created_at),
      counted: row.counted ?? false,
      skipped: row.skipped ?? null,
      evidence: { kind: row.evidence_kind ?? 'none', note: row.evidence_note ?? null, weight: row.evidence_weight ?? 0 },
      reviewerWeight: row.reviewer_weight ?? 0,
      contribution: row.contribution ?? 0,
    }
  }

  const REVIEW_SELECT = `select v.*, w.counted, w.skipped, w.evidence_kind, w.evidence_note, w.evidence_weight,
                                w.reviewer_weight, w.contribution
                         from reviews v left join review_weights w on w.uri = v.uri`

  // Offers in a market, or matching a search: live offers only, each with its seller's two scores.
  // Badged sellers first, then by trust, then newest: two scores side by side, never one number.
  async function offers(where: string, params: unknown[], limit: number, offset: number) {
    const { rows } = await db.query(
      `select p.*, pr.name,
              (select max(s.value_micro) from scores s where s.did = p.did and s.kind = 'uniqueness'
                 and split_part(s.scope, ':', 1) = p.market) as uniqueness,
              (select s.value_micro from scores s where s.did = p.did and s.kind = 'trust' and s.scope = '') as trust,
              count(*) over () as total
       from posts p left join profiles pr on pr.did = p.did
       where p.direction = 'offer' and p.market is not null and (p.expires is null or p.expires > now()) and ${where}
       order by (coalesce((select max(s.value_micro) from scores s where s.did = p.did and s.kind = 'uniqueness'
                   and split_part(s.scope, ':', 1) = p.market), 0) > 0) desc,
                coalesce((select s.value_micro from scores s where s.did = p.did and s.kind = 'trust' and s.scope = ''), 0) desc,
                p.created_at desc nulls last, p.uri
       limit ${limit} offset ${offset}`,
      params,
    )
    return { total: rows.length ? Number(rows[0].total) : 0, offers: rows.map(offerOut) }
  }

  // -------------------------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------------------------

  async function root() {
    return json(200, {
      index: 'Forest index, part one: records, badges, receipts and scores as JSON',
      scoring: { version: 'v1', rules: 'index/SCORING.md in the forest repo' },
      keys: publicKeys(ctx.keys),
      statement: {
        header: STATEMENT_HEADER,
        lines: ['kind <uniqueness|trust>', 'did <did>', 'scope <badge scope, or empty>', 'value <millionths>', 'at <unix seconds>'],
        ed25519: 'over the statement text, UTF-8',
        eddsaPoseidon: 'over message = Poseidon(domain, kind, did, scope, value + 2^63, at); see index/SCORING.md',
      },
      endpoints: [
        '/categories',
        '/markets/{market}',
        '/markets/{market}/offers?limit=&offset=',
        '/profiles/{did}',
        '/profiles/{did}/reviews',
        '/deals/{dealId}',
        '/search?q=',
      ],
    })
  }

  async function categories() {
    const { rows } = await db.query(
      `select market, count(*)::int as n from posts
       where direction = 'offer' and market is not null and (expires is null or expires > now()) group by market`,
    )
    const counts = new Map(rows.map((r) => [r.market, r.n]))
    return json(200, {
      categories: [...directory.categories()].map(([category, markets]) => ({
        category,
        markets: markets.map((name) => ({ name, offers: counts.get(name) ?? 0 })),
      })),
    })
  }

  async function market(name: string) {
    const file = directory.markets.get(name)
    if (!file) {
      const to = directory.aliasOf.get(name)
      if (to) return json(301, { movedTo: `/markets/${to}` }, { location: `/markets/${encodeURIComponent(to)}` })
      return notFound(`no market named ${name} in this index's directory`)
    }
    const posts = await db.query(
      `select direction, count(*)::int as n from posts
       where market = $1 and (expires is null or expires > now()) group by direction`,
      [name],
    )
    const badges = await db.query(
      `select b.did, b.wallet, b.scope, b.list_owner, p.wallet as declared
       from badges b join profiles p on p.did = b.did where b.market = $1`,
      [name],
    )
    const counted = new Set(
      badges.rows
        .filter((b) => badgeStatus({ did: b.did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner }, b.declared, directory).counted)
        .map((b) => b.did),
    )
    const by = new Map(posts.rows.map((r) => [r.direction, r.n]))
    return json(200, {
      market: file,
      aliases: directory.aliasesFor(name),
      counts: { offers: by.get('offer') ?? 0, requests: by.get('request') ?? 0, badgedProfiles: counted.size },
    })
  }

  async function marketOffers(name: string, url: URL) {
    if (!directory.markets.has(name)) {
      const to = directory.aliasOf.get(name)
      if (to) return json(301, { movedTo: `/markets/${to}/offers` }, { location: `/markets/${encodeURIComponent(to)}/offers${url.search}` })
      return notFound(`no market named ${name} in this index's directory`)
    }
    const limit = intParam(url, 'limit', 50, 200)
    const offset = intParam(url, 'offset', 0, 100_000)
    const page = await offers('p.market = $1', [name], limit, offset)
    return json(200, { market: name, limit, offset, ...page })
  }

  async function profile(did: string) {
    const { rows } = await db.query('select * from profiles where did = $1', [did])
    if (!rows.length) return notFound(`no profile ${did} in this index`)
    const p = rows[0]
    const r = p.record
    const [badges, scores, posts, credentials, counts] = await Promise.all([
      db.query(
        `select b.*, t.block_time as registered_at from badges b join chain_transactions t on t.signature = b.signature
         where b.did = $1 order by b.slot, b.ix`,
        [did],
      ),
      db.query('select * from scores where did = $1 order by kind, scope', [did]),
      db.query(`select p.*, null as uniqueness, null as trust from posts p where did = $1 order by created_at desc nulls last, uri`, [did]),
      db.query('select * from credentials where did = $1 order by created_at desc nulls last, uri', [did]),
      db.query(
        `select (select count(*)::int from reviews where subject = $1) as received,
                (select count(*)::int from reviews where reviewer = $1) as given`,
        [did],
      ),
    ])
    const trust = scores.rows.find((s) => s.kind === 'trust')
    return json(200, {
      did,
      profile: {
        name: p.name,
        about: r.about ?? null,
        contact: r.contact ?? null,
        wallet: p.wallet,
        photo: r.photo ? { cid: r.photo.ref?.$link ?? null, mimeType: r.photo.mimeType ?? null } : null,
        createdAt: iso(p.created_at),
        cid: p.cid,
      },
      badges: badges.rows.map((b) => {
        const status = badgeStatus({ did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner }, p.wallet, directory)
        const issuer = ctx.config.issuers[b.list_owner]
        return {
          scope: b.scope,
          market: b.market,
          role: b.role,
          listIndex: b.list_index,
          listOwner: b.list_owner,
          issuer: { name: issuer?.name ?? null, weight: issuer?.weight ?? 0 },
          wallet: b.wallet,
          counted: status.counted,
          why: status.counted ? null : status.why,
          registeredAt: iso(b.registered_at),
          transaction: b.signature,
        }
      }),
      scores: {
        uniqueness: scores.rows.filter((s) => s.kind === 'uniqueness').map(scoreOut),
        trust: trust ? scoreOut(trust) : null,
      },
      posts: posts.rows.map(offerOut).map(({ uniqueness: _u, trust: _t, name: _n, ...post }) => post),
      credentials: credentials.rows.map((c) => ({ uri: c.uri, issuer: c.issuer, createdAt: iso(c.created_at), credential: c.record.credential })),
      reviews: counts.rows[0],
    })
  }

  async function profileReviews(did: string) {
    const exists = await db.query('select 1 from profiles where did = $1', [did])
    const [received, given] = await Promise.all([
      db.query(`${REVIEW_SELECT} where v.subject = $1 order by v.created_at desc nulls last, v.uri`, [did]),
      db.query(`${REVIEW_SELECT} where v.reviewer = $1 order by v.created_at desc nulls last, v.uri`, [did]),
    ])
    if (!exists.rowCount && !received.rowCount && !given.rowCount) return notFound(`no profile or review for ${did} in this index`)
    return json(200, { did, received: received.rows.map(reviewOut), given: given.rows.map(reviewOut) })
  }

  async function deal(dealId: string) {
    const [receipt, reviews] = await Promise.all([
      db.query('select * from escrow_receipts where escrow = $1', [dealId]),
      db.query(`${REVIEW_SELECT} where v.deal_id = $1 order by v.created_at, v.uri`, [dealId]),
    ])
    if (!receipt.rowCount && !reviews.rowCount) return notFound(`nothing in this index names deal ${dealId}`)
    let out = null
    if (receipt.rowCount) {
      const e = receipt.rows[0]
      const profiles = await db.query('select did, wallet from profiles where wallet = any($1)', [[e.buyer, e.seller]])
      const of = (w: string) => profiles.rows.filter((p) => p.wallet === w).map((p) => p.did).sort()
      out = {
        escrow: e.escrow,
        program: e.program_id,
        buyer: e.buyer,
        seller: e.seller,
        buyerProfiles: of(e.buyer),
        sellerProfiles: of(e.seller),
        mint: e.mint,
        amount: e.amount,
        createdAt: iso(e.created_at),
        fundedAt: iso(e.funded_at),
        acceptedAt: iso(e.accepted_at),
        endedAt: iso(e.ended_at),
        outcome: e.outcome,
        toSeller: e.to_seller,
        toBuyer: e.to_buyer,
        locked: e.locked,
        closed: e.closed,
        transaction: e.signature,
      }
    }
    return json(200, { dealId, receipt: out, reviews: reviews.rows.map(reviewOut) })
  }

  async function search(url: URL) {
    const q = (url.searchParams.get('q') ?? '').trim()
    if (!q) return badRequest('q is required')
    if (q.length > 200) return badRequest('q is at most 200 characters')
    const needle = q.toLowerCase()
    const markets = [...directory.markets.values()]
      .map((m) => {
        const aliases = directory.aliasesFor(m.name)
        const matched = m.name.includes(needle)
          ? 'name'
          : aliases.some((a) => a.includes(needle))
            ? 'alias'
            : m.category.includes(needle)
              ? 'category'
              : m.roles.some((r) => r.includes(needle))
                ? 'role'
                : null
        return matched ? { name: m.name, category: m.category, matched } : null
      })
      .filter((m) => m !== null)
    const limit = intParam(url, 'limit', 50, 200)
    const page = await offers(`p.search @@ websearch_to_tsquery('simple', $1)`, [q], limit, 0)
    return json(200, { q, markets, offers: page.offers, total: page.total })
  }

  // -------------------------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------------------------

  async function handle(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'MethodNotAllowed', message: 'GET only' }, { allow: 'GET, HEAD' })
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    try {
      const res = await route(parts, url)
      return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
    } catch (err) {
      console.error('request failed', url.pathname, err)
      return json(500, { error: 'InternalError', message: 'the index could not answer this' })
    }
  }

  function route(parts: string[], url: URL): Promise<Response> {
    const [a, b, c] = parts
    if (parts.length === 0) return root()
    if (a === 'categories' && parts.length === 1) return categories()
    if (a === 'markets' && parts.length === 2) return market(b)
    if (a === 'markets' && parts.length === 3 && c === 'offers') return marketOffers(b, url)
    if (a === 'profiles' && parts.length === 2) return profile(b)
    if (a === 'profiles' && parts.length === 3 && c === 'reviews') return profileReviews(b)
    if (a === 'deals' && parts.length === 2) return deal(b)
    if (a === 'search' && parts.length === 1) return search(url)
    return Promise.resolve(notFound(`no endpoint at ${url.pathname}`))
  }

  return { handle }
}

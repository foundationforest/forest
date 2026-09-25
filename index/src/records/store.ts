// One verified record operation into Postgres. By the time a record gets here its commit has been
// checked against the signing key its DID document names, and the record against that commit
// (firehose.ts). Here it is checked once more, against its lexicon, with shapes/' own validator,
// and a record that fails is not stored: nothing unchecked ever reaches a score.

import { lexToJson } from '@atproto/lex'

// @ts-expect-error shapes/ is plain JavaScript with no type declarations
import { validateRecord } from '../../../shapes/src/validate.js'

import type { Db } from '../db.ts'
import type { Directory } from '../markets.ts'

export const COLLECTIONS = {
  profile: 'foundation.forest.profile',
  post: 'foundation.forest.post',
  review: 'foundation.forest.review',
  credential: 'foundation.forest.credential',
} as const
export const FOREST_COLLECTIONS: string[] = Object.values(COLLECTIONS)

export type RecordOp =
  | { event: 'create' | 'update'; did: string; collection: string; rkey: string; cid: string; rev: string; record: unknown }
  | { event: 'delete'; did: string; collection: string; rkey: string; rev: string }

export type Outcome = { result: 'stored' | 'deleted' | 'ignored' } | { result: 'refused'; why: string }

const ts = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export async function applyRecordOp(db: Db, directory: Directory, op: RecordOp): Promise<Outcome> {
  const uri = `at://${op.did}/${op.collection}/${op.rkey}`
  if (!FOREST_COLLECTIONS.includes(op.collection)) return { result: 'ignored' }

  if (op.event === 'delete') {
    switch (op.collection) {
      case COLLECTIONS.profile:
        if (op.rkey === 'self') await db.query('delete from profiles where did = $1', [op.did])
        break
      case COLLECTIONS.post:
        await db.query('delete from posts where uri = $1', [uri])
        break
      case COLLECTIONS.review:
        await db.query('delete from reviews where uri = $1', [uri])
        break
      case COLLECTIONS.credential:
        await db.query('delete from credentials where uri = $1', [uri])
        break
    }
    return { result: 'deleted' }
  }

  const r = lexToJson(op.record as never) as Record<string, any>
  if (r?.$type !== op.collection) return { result: 'refused', why: `$type ${r?.$type} in ${op.collection}` }
  const checked = validateRecord(r) as { ok: boolean; errors: string[] }
  if (!checked.ok) return { result: 'refused', why: checked.errors.join('; ') }

  switch (op.collection) {
    case COLLECTIONS.profile: {
      if (op.rkey !== 'self') return { result: 'refused', why: 'a profile is keyed self' }
      await db.query(
        `insert into profiles (did, cid, rev, record, name, wallet, created_at, indexed_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (did) do update set cid = excluded.cid, rev = excluded.rev, record = excluded.record,
           name = excluded.name, wallet = excluded.wallet, created_at = excluded.created_at, indexed_at = now()`,
        [op.did, op.cid, op.rev, r, r.name, r.wallet ?? null, ts(r.createdAt)],
      )
      break
    }
    case COLLECTIONS.post: {
      await db.query(
        `insert into posts (uri, did, rkey, cid, record, direction, market_written, market, role, description,
                            price_amount, price_mint, price_per, remote, location, expires, created_at, indexed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
         on conflict (uri) do update set cid = excluded.cid, record = excluded.record, direction = excluded.direction,
           market_written = excluded.market_written, market = excluded.market, role = excluded.role,
           description = excluded.description, price_amount = excluded.price_amount, price_mint = excluded.price_mint,
           price_per = excluded.price_per, remote = excluded.remote, location = excluded.location,
           expires = excluded.expires, created_at = excluded.created_at, indexed_at = now()`,
        [
          uri,
          op.did,
          op.rkey,
          op.cid,
          r,
          r.direction,
          r.market,
          directory.postMarket(r.market),
          r.role,
          r.description,
          r.price.amount,
          r.price.mint,
          r.price.per,
          r.remote ?? null,
          r.location ?? null,
          ts(r.expires),
          ts(r.createdAt),
        ],
      )
      break
    }
    case COLLECTIONS.review: {
      await db.query(
        `insert into reviews (uri, reviewer, rkey, cid, record, subject, rating, text, deal_id, created_at, indexed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         on conflict (uri) do update set cid = excluded.cid, record = excluded.record, subject = excluded.subject,
           rating = excluded.rating, text = excluded.text, deal_id = excluded.deal_id,
           created_at = excluded.created_at, indexed_at = now()`,
        [uri, op.did, op.rkey, op.cid, r, r.subject, r.rating ?? null, r.text ?? null, r.dealId ?? null, ts(r.createdAt)],
      )
      break
    }
    case COLLECTIONS.credential: {
      await db.query(
        `insert into credentials (uri, did, rkey, cid, record, issuer, created_at, indexed_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (uri) do update set cid = excluded.cid, record = excluded.record, issuer = excluded.issuer,
           created_at = excluded.created_at, indexed_at = now()`,
        [uri, op.did, op.rkey, op.cid, r, r.issuer, ts(r.createdAt)],
      )
      break
    }
  }
  return { result: 'stored' }
}

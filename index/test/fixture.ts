// Part one's story, as data, for the page tests: Ana tutors; Ben is her student; Cleo is a
// stranger. The same people, badges, deal and reviews the end-to-end test makes on real pieces,
// written straight into a fresh database, so the pages can be tested with nothing but Postgres.
//
//   - Records go in through part one's own `applyRecordOp`, so each is checked against its lexicon
//     exactly as a record off the firehose is.
//   - Chain rows go in as the adapters store them (badges, the log archive, the receipt).
//   - Scores come from the real recompute, signed with a fixed seed.
//
// The ids are fixed, so the read skill (index/skill.md) can use them as its examples.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import pg from 'pg'

import { INDEX_ROOT, type Config, loadConfig } from '../src/config.ts'
import { type Db, createPool } from '../src/db.ts'
import { startReaders } from '../src/main.ts'
import { applyRecordOp } from '../src/records/store.ts'

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const FOUNDATION_ISSUER = 'H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS'
export const MARKET = 'online-tutors'
export const CATEGORY = 'freelance-work'

export const ana = { did: 'did:plc:exampleana22222222222222', wallet: '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9', name: 'Ana Ribeiro' }
export const ben = { did: 'did:plc:exampleben22222222222222', wallet: 'mBKqcnGotbsSb5vNrdyhzZ5EhqZdids9QYiTRckvi7v', name: 'Ben Okafor' }
/** Cleo's badge is registered with one key; her profile declares another, so it must not count. */
export const cleo = {
  did: 'did:plc:examplecleo2222222222222',
  wallet: '4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JT',
  badgeWallet: 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os',
  name: 'Cleo',
}
/** Ana invoiced Ben; Ben paid in one tap and released it to her. */
export const DEAL = 'CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU'
export const MADE_UP_DEAL = 'cd'.repeat(32)
export const OFFERS = {
  portuguese: { rkey: '3kzq2vrffxb2c', cid: 'bafyreiexampleanaportuguese2222', uri: `at://${ana.did}/foundation.forest.post/3kzq2vrffxb2c` },
  spanish: { rkey: '3kzq2vrffxb2d', cid: 'bafyreiexampleanaspanish2222222', uri: `at://${ana.did}/foundation.forest.post/3kzq2vrffxb2d` },
}
export const SIGNING_SEED = '09'.repeat(32)
export const MARKETS_DIR = join(INDEX_ROOT, '../shapes/examples/markets')

const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00.000Z`

export type Fixture = { db: Db; config: (env?: Record<string, string>) => Config; drop: () => Promise<void> }

/** A fresh database with the story in it and its scores computed. `drop` removes it. */
export async function makeFixture(adminUrl: string): Promise<Fixture> {
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const name = `forest_index_pages_${randomBytes(4).toString('hex')}`
  await admin.query(`create database ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const env = { DATABASE_URL: url.toString(), MARKETS_DIR, INDEX_SIGNING_SEED: SIGNING_SEED }
  const config = (more: Record<string, string> = {}) => loadConfig({ ...env, ...more })
  const db = createPool(url.toString())

  // Migrations and the public keys; no firehose and no chain, so no reader starts.
  const readers = await startReaders(db, config())
  const put = async (did: string, collection: string, rkey: string, cid: string, record: Record<string, unknown>) => {
    const out = await applyRecordOp(db, readers.directory, { event: 'create', did, collection, rkey, cid, rev: '3kzq2vrffxb2a', record })
    if (out.result !== 'stored') throw new Error(`fixture record ${did}/${collection}/${rkey} not stored: ${JSON.stringify(out)}`)
  }

  const profile = (p: { name: string; wallet: string }, about: string | null, d: number) => ({
    $type: 'foundation.forest.profile',
    name: p.name,
    wallet: p.wallet,
    ...(about ? { about } : {}),
    createdAt: day(d),
  })
  await put(ana.did, 'foundation.forest.profile', 'self', 'bafyreiexampleanaprofile2222222', {
    ...profile(ana, 'Portuguese and Spanish tutor. Ten years teaching adults online.', 1),
    contact: 'Message me here first; video calls after a first reply.',
  })
  await put(ben.did, 'foundation.forest.profile', 'self', 'bafyreiexamplebenprofile2222222', profile(ben, 'Learning Portuguese for a move to Lisbon.', 2))
  await put(cleo.did, 'foundation.forest.profile', 'self', 'bafyreiexamplecleoprofile222222', profile(cleo, null, 3))

  const offer = (market: string, description: string, amount: string, extra: Record<string, unknown>) => ({
    $type: 'foundation.forest.post',
    direction: 'offer',
    market,
    role: 'seller',
    description,
    price: { amount, mint: USDC, per: 'hour' },
    remote: true,
    createdAt: day(4),
    ...extra,
  })
  await put(ana.did, 'foundation.forest.post', OFFERS.portuguese.rkey, OFFERS.portuguese.cid,
    offer(MARKET, 'Portuguese conversation for adults, A1 to B2.', '25', { availability: 'Weekday evenings, Lisbon time.', subjects: ['portuguese'] }))
  // Written under an alias of the market's name, with a timer: grouped under the directory name.
  await put(ana.did, 'foundation.forest.post', OFFERS.spanish.rkey, OFFERS.spanish.cid,
    offer('online-tutor', 'Spanish grammar, one hour, homework optional.', '12.50', { terms: { timer: { days: 7, to: 'seller' } }, subjects: ['spanish'] }))

  // Three badges on list 0, vouched for by the foundation's issuer; Cleo's for a key her profile does not declare.
  const badge = async (i: number, did: string, wallet: string) => {
    const signature = `ExampleRegistration${i}`.padEnd(88, '1')
    await db.query(
      `insert into chain_transactions (signature, program_id, slot, block_time, logs) values ($1, 'registry', $2, $3, '[]')`,
      [signature, 100 + i, day(5)],
    )
    await db.query(
      `insert into badges (signature, ix, scope, market, role, did, wallet, code, list_index, list_owner, slot, block_time)
       values ($1, 0, $2, $2, null, $3, $4, $5, 0, $6, $7, $8)`,
      [signature, MARKET, did, wallet, String(i).repeat(64), FOUNDATION_ISSUER, 100 + i, day(5)],
    )
  }
  await badge(1, ana.did, ana.wallet)
  await badge(2, ben.did, ben.wallet)
  await badge(3, cleo.did, cleo.badgeWallet)

  // The receipt: $25 from Ben to Ana, which she asked for, released to her.
  await db.query(
    `insert into escrow_receipts (escrow, program_id, buyer, seller, creator, mint, amount, created_at, ended_at, outcome,
                                  to_seller, to_buyer, signature)
     values ($1, 'escrow', $2, $3, 'seller', $4, 25000000, $5, $6, 'releasedToSeller', 25000000, 0, $7)`,
    [DEAL, ben.wallet, ana.wallet, USDC, day(6), day(6), 'ExampleDealRelease'.padEnd(88, '1')],
  )

  const review = (subject: string, rating: number, dealId: string, text: string, d: number) => ({
    $type: 'foundation.forest.review',
    subject,
    rating,
    text,
    dealId,
    createdAt: day(d),
  })
  await put(ben.did, 'foundation.forest.review', '3kzq2vrffxb3a', 'bafyreiexamplebenreview22222222', review(ana.did, 5, DEAL, 'Patient and well prepared.', 7))
  await put(ana.did, 'foundation.forest.review', '3kzq2vrffxb3b', 'bafyreiexampleanareview22222222', review(ben.did, 5, DEAL, 'Paid on time, came prepared.', 7))
  await put(cleo.did, 'foundation.forest.review', '3kzq2vrffxb3c', 'bafyreiexamplecleoreview2222222', review(ana.did, 1, MADE_UP_DEAL, 'Never showed up.', 8))

  await readers.scorer.now()
  readers.scorer.stop()

  return {
    db,
    config,
    drop: async () => {
      // pg's pool resolves `end()` before its sockets have closed; dropping the database under a
      // closing connection makes it report an error nobody is listening for. Wait for them to go.
      await db.end()
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query('select count(*)::int as n from pg_stat_activity where datname = $1', [name])
        if (rows[0].n === 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    },
  }
}

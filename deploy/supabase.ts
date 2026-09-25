// The index's Postgres on Supabase, through Supabase's Management API (SUPABASE_ACCESS_TOKEN).
//
//   node supabase.ts create     the project `forest-devnet` in the Forest organization, free plan;
//                               waits until it is healthy
//   node supabase.ts lockdown   no Data API access to the index's tables, and the pages' read-only role
//   node supabase.ts url        writes the connection strings (session pooler) to the secrets folder
//
// Each step checks first and skips what is done. The database password and the read-only role's
// password are made here, kept in the secrets folder (lib/secrets.ts), and never printed.

import { password, readSecret, secret, need, writeSecret } from './lib/secrets.ts'
import { readRecord, updateRecord } from './lib/record.ts'

const API = 'https://api.supabase.com'
const NAME = 'forest-devnet'
const REGION = process.env.SUPABASE_REGION || 'us-west-1'
const token = need('SUPABASE_ACCESS_TOKEN')

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** SQL through the Management API. The statement may hold a password: it is sent, never printed. */
const sql = (ref: string, query: string) => api('POST', `/v1/projects/${ref}/database/query`, { query })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function create(): Promise<void> {
  const orgs = await api<{ id: string; name: string }[]>('GET', '/v1/organizations')
  const org = orgs.find((o) => o.name === 'Forest') ?? orgs[0]
  if (!org) throw new Error('no Supabase organization')
  const projects = await api<{ ref: string; name: string; status: string; region: string }[]>('GET', '/v1/projects')
  let project = projects.find((p) => p.name === NAME)
  if (!project) {
    const dbPass = secret('supabase-db-password', password)
    project = await api('POST', '/v1/projects', { name: NAME, organization_id: org.id, region: REGION, db_pass: dbPass })
    console.log(`created ${NAME} (${project!.ref}) in ${REGION}`)
  } else {
    console.log(`${NAME} exists (${project.ref}), ${project.status}`)
  }
  const ref = project!.ref
  updateRecord({ supabase: { organization: org.name, project: NAME, ref, region: project!.region ?? REGION, plan: 'free' } })
  for (let i = 0; i < 90; i++) {
    const p = await api<{ status: string }>('GET', `/v1/projects/${ref}`)
    if (p.status === 'ACTIVE_HEALTHY') return void console.log(`${NAME} is healthy`)
    if (i % 6 === 0) console.log(`waiting: ${p.status}`)
    await sleep(10_000)
  }
  throw new Error(`${NAME} did not become healthy in 15 minutes`)
}

async function lockdown(): Promise<void> {
  const { ref } = readRecord().supabase
  // Supabase grants its public API roles every right on new tables in `public` by default. The index
  // uses none of that API, and without these revokes anyone holding the project's public key could
  // read and write the index's tables through it.
  await sql(
    ref,
    `revoke all on all tables in schema public from anon, authenticated;
     revoke all on all sequences in schema public from anon, authenticated;
     revoke all on all functions in schema public from anon, authenticated;
     alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
     alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
     alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;`,
  )
  console.log('the Data API roles hold no rights on the public schema, now or for new tables')
  // And the Data API serves no schema at all.
  try {
    await api('PATCH', `/v1/projects/${ref}/postgrest`, { db_schema: '' })
    console.log('the Data API serves no schema')
  } catch (err) {
    console.log(`the Data API could not be turned off through the API (${(err as Error).message.slice(0, 200)}); the revokes stand`)
  }
  // The pages' role, as index/HOSTING.md writes it: it reads, and nothing else.
  const pagesPass = secret('supabase-pages-password', password)
  const exists = await sql(ref, `select 1 from pg_roles where rolname = 'index_pages'`)
  const verb = Array.isArray(exists) && exists.length ? 'alter' : 'create'
  await sql(
    ref,
    `${verb} role index_pages login password '${pagesPass}';
     grant connect on database postgres to index_pages;
     grant usage on schema public to index_pages;
     grant select on all tables in schema public to index_pages;
     alter default privileges for role postgres in schema public grant select on tables to index_pages;`,
  )
  console.log(`read-only role index_pages ${verb === 'create' ? 'created' : 'kept, password reset'}`)
}

async function url(): Promise<void> {
  const { ref } = readRecord().supabase
  const pools = await api<any[]>('GET', `/v1/projects/${ref}/config/database/pooler`)
  const primary = pools.find((p) => p.database_type === 'PRIMARY') ?? pools[0]
  if (!primary?.db_host) throw new Error('no pooler listed')
  // Supabase lists its transaction-mode port (6543). The same pooler serves session mode on 5432,
  // which suits the index: a long-lived pool of ordinary connections.
  const host: string = primary.db_host
  const port = 5432
  const db = primary.db_name ?? 'postgres'
  const build = (user: string, pass: string) => `postgresql://${user}.${ref}:${encodeURIComponent(pass)}@${host}:${port}/${db}?sslmode=verify-full`
  writeSecret('DATABASE_URL', build('postgres', readSecret('supabase-db-password')))
  writeSecret('DATABASE_URL_PAGES', build('index_pages', readSecret('supabase-pages-password')))
  updateRecord({ supabase: { pooler: { host, port, mode: 'session' } } })
  console.log(`connection strings written for ${host}:${port} (session pooler); not printed`)
}

const step = process.argv[2]
const steps: Record<string, () => Promise<void>> = { create, lockdown, url }
if (!steps[step]) throw new Error(`usage: node supabase.ts ${Object.keys(steps).join('|')}`)
await steps[step]()

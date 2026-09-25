// The services on Railway, through Railway's public GraphQL API (RAILWAY_API_TOKEN, an account token).
//
//   node railway.ts provision          the project `forest-devnet`: five services, their volumes and
//                                      public domains, and each one's build and run settings (SERVICES below)
//   node railway.ts variables          every service's variables; the secrets sealed
//   node railway.ts deploy [name...]   builds and deploys: the branch's pushed commit when Railway can read
//                                      the repo, otherwise an upload of this checkout (`railway up`)
//   node railway.ts status             each service's latest deployment
//   node railway.ts sealed             every variable's name and whether it is sealed; never a value
//   node railway.ts rotate NAME        a new value for a secret this script makes, sealed, and a redeploy
//
// Each step reads what exists first and changes only what is missing or different. Public facts
// (ids, domains) go to deploy/services.json. Secrets are made or read by lib/secrets.ts, sent to
// Railway sealed, and never printed: every message from the API is redacted before it is shown.

import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { hex32, keyFile, need, password, readSecret, secret } from './lib/secrets.ts'
import { readRecord, updateRecord } from './lib/record.ts'

const API = 'https://backboard.railway.com/graphql/v2'
const PROJECT = 'forest-devnet'
const REPO = 'foundationforest/forest'
const root = resolve(import.meta.dirname, '..')
const token = need('RAILWAY_API_TOKEN')

// docs/devnet.md
const DEVNET = {
  registry: '8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i',
  escrow: '3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR',
}
/** Every devnet RPC: Helius's when HELIUS_API_KEY is set (then sealed, since the URL holds the key), else the public one. */
const rpc = process.env.HELIUS_API_KEY
  ? { value: `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, sealed: true }
  : { value: 'https://api.devnet.solana.com', sealed: false }

type Name = 'host' | 'carrier' | 'index' | 'issuer' | 'feepayer'
/**
 * Each service builds from deploy/<name>/Dockerfile with the repo root as its context, runs one
 * replica, restarts always, and answers its health path (the issuer's routes are POST only, so it has
 * none). Railway's config files (railway.json) are deprecated, so these are set through the API.
 */
const SERVICES: Record<Name, { port: number; volume?: string; health?: string }> = {
  host: { port: 2583, volume: '/data', health: '/xrpc/_health' },
  carrier: { port: 2470, volume: '/data', health: '/xrpc/_health' },
  index: { port: 8080, health: '/' },
  issuer: { port: 8080, volume: '/data' },
  feepayer: { port: 8080, health: '/liveness' },
}
const NAMES = Object.keys(SERVICES) as Name[]

// ---- the API ----------------------------------------------------------------------------------

/** Every secret value this run has touched, so no message from the API can show one. */
const secrets = new Set<string>()
function redact(text: string): string {
  let out = text
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('<redacted>')
  return out
}

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const text = await res.text()
    if (res.status === 429 && attempt < 5) {
      await sleep(5000 * (attempt + 1))
      continue
    }
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`Railway answered ${res.status}: ${redact(text.slice(0, 300))}`)
    }
    if (body.errors?.length) throw new Error(redact(body.errors.map((e: any) => e.message).join('; ')))
    return body.data as T
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- provision ----------------------------------------------------------------------------------

async function projectAndEnvironment(): Promise<{ projectId: string; environmentId: string }> {
  const { me } = await gql(`query { me { workspaces { id name } } }`)
  const workspaceId = me.workspaces[0].id
  // A workspace's projects are listed under the workspace; `projects` alone lists none of them.
  const { workspace } = await gql(`query($id: String!) { workspace(workspaceId: $id) { projects { edges { node { id name } } } } }`, { id: workspaceId })
  let project = workspace.projects.edges.map((e: any) => e.node).find((p: any) => p.name === PROJECT)
  if (!project) {
    const { projectCreate } = await gql(
      `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`,
      { input: { name: PROJECT, workspaceId, description: 'Forest foundation services on Solana devnet (deploy/README.md)' } },
    )
    project = projectCreate
    console.log(`created project ${PROJECT} (${project.id})`)
  }
  const { project: full } = await gql(
    `query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }`,
    { id: project.id },
  )
  const env = full.environments.edges.map((e: any) => e.node).find((e: any) => e.name === 'production') ?? full.environments.edges[0].node
  updateRecord({ railway: { workspace: me.workspaces[0].name, project: PROJECT, projectId: project.id, environmentId: env.id, environment: env.name } })
  return { projectId: project.id, environmentId: env.id }
}

async function projectState(projectId: string) {
  const { project } = await gql(
    `query($id: String!) { project(id: $id) {
       services { edges { node { id name serviceInstances { edges { node { environmentId source { repo image } domains { serviceDomains { domain targetPort } } } } } } } }
       volumes { edges { node { id name volumeInstances { edges { node { serviceId mountPath environmentId } } } } } }
     } }`,
    { id: projectId },
  )
  const services = project.services.edges.map((e: any) => e.node)
  const mounts = project.volumes.edges.flatMap((e: any) => e.node.volumeInstances.edges.map((v: any) => v.node))
  return { services, mounts }
}

async function createService(projectId: string, environmentId: string, name: Name, from?: { repo: string; branch: string }) {
  const { serviceCreate } = await gql(
    `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    { input: { projectId, environmentId, name, ...(from ? { source: { repo: from.repo }, branch: from.branch } : {}) } },
  )
  return serviceCreate
}

async function provision(): Promise<void> {
  const { projectId, environmentId } = await projectAndEnvironment()
  const branch = currentBranch()
  for (const name of NAMES) {
    let { services, mounts } = await projectState(projectId)
    let service = services.find((s: any) => s.name === name)
    let source: 'github' | 'upload' = 'github'
    if (!service) {
      try {
        service = await createService(projectId, environmentId, name, { repo: REPO, branch })
        console.log(`${name}: created from ${REPO} at ${branch}`)
      } catch (err) {
        const why = (err as Error).message
        if (/limit/i.test(why)) {
          console.log(`${name}: BLOCKED by Railway: ${why}`)
          updateRecord({ railway: { services: { [name]: { blocked: why } } } })
          continue
        }
        console.log(`${name}: Railway would not take ${REPO} as the source (${why}); created empty, deployed by upload`)
        service = await createService(projectId, environmentId, name)
        source = 'upload'
      }
      ;({ services, mounts } = await projectState(projectId))
      service = services.find((s: any) => s.id === service.id)
    } else {
      const instance = service.serviceInstances.edges.map((e: any) => e.node).find((i: any) => i.environmentId === environmentId)
      source = instance?.source?.repo ? 'github' : 'upload'
    }
    const id = service.id

    const { volume, port, health } = SERVICES[name]
    await gql(
      `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
         serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
      {
        serviceId: id,
        environmentId,
        input: {
          dockerfilePath: `deploy/${name}/Dockerfile`,
          numReplicas: 1,
          restartPolicyType: 'ALWAYS',
          ...(health ? { healthcheckPath: health, healthcheckTimeout: 300 } : {}),
        },
      },
    )

    if (volume && !mounts.some((m: any) => m.serviceId === id && m.environmentId === environmentId)) {
      await sleep(31_000) // Railway allows one new volume per 30 seconds
      await gql(`mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`, {
        input: { projectId, environmentId, serviceId: id, mountPath: volume },
      })
      console.log(`${name}: volume at ${volume}`)
    }

    const instance = service.serviceInstances.edges.map((e: any) => e.node).find((i: any) => i.environmentId === environmentId)
    let domain: string | undefined = instance?.domains?.serviceDomains?.[0]?.domain
    if (!domain) {
      const { serviceDomainCreate } = await gql(
        `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
        { input: { serviceId: id, environmentId, targetPort: port } },
      )
      domain = serviceDomainCreate.domain as string
      console.log(`${name}: https://${domain}`)
    }
    updateRecord({ railway: { services: { [name]: { id, source, url: `https://${domain}`, port, volume: volume ?? null, blocked: null } } } })
  }
}

// ---- variables ----------------------------------------------------------------------------------

type Value = { value: string; sealed: boolean }
const plain = (value: string): Value => ({ value, sealed: false })
const sealed = (value: string): Value => {
  secrets.add(value)
  return { value, sealed: true }
}

function variablesFor(name: Name, urls: Record<Name, string>): Record<string, Value> {
  const host = (url: string) => new URL(url).host
  switch (name) {
    case 'host':
      // host/pds.env.example, for a public hostname: no dev mode, invites required, the public directory.
      return {
        PDS_HOSTNAME: plain(host(urls.host)),
        PDS_PORT: plain('2583'),
        PDS_DATA_DIRECTORY: plain('/data'),
        PDS_BLOBSTORE_DISK_LOCATION: plain('/data/blobs'),
        PDS_DID_PLC_URL: plain('https://plc.directory'),
        PDS_INVITE_REQUIRED: plain('1'),
        PDS_BSKY_APP_VIEW_URL: plain('https://appview.invalid'),
        PDS_BSKY_APP_VIEW_DID: plain('did:web:appview.invalid'),
        LOG_ENABLED: plain('1'),
        LOG_LEVEL: plain('info'),
        PDS_JWT_SECRET: sealed(secret('PDS_JWT_SECRET', hex32)),
        PDS_ADMIN_PASSWORD: sealed(secret('PDS_ADMIN_PASSWORD', hex32)),
        PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: sealed(secret('PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX', hex32)),
      }
    case 'carrier':
      // carrier/relay.env.example, on the volume.
      return {
        RELAY_DISABLE_REQUEST_CRAWL: plain('true'),
        RELAY_PLC_HOST: plain('https://plc.directory'),
        DATABASE_URL: plain('sqlite:///data/relay/relay.sqlite'),
        RELAY_PERSIST_DIR: plain('/data/relay/persist'),
        RELAY_REPLAY_WINDOW: plain('72h'),
        RELAY_API_BIND: plain(':2470'),
        RELAY_METRICS_LISTEN: plain(':2471'),
        RELAY_ADMIN_PASSWORD: sealed(secret('RELAY_ADMIN_PASSWORD', password)),
      }
    case 'index':
      // index/HOSTING.md; readers and pages in one process on the trial, so it holds the seed.
      return {
        DATABASE_URL: sealed(readSecret('DATABASE_URL')),
        INDEX_SIGNING_SEED: sealed(secret('INDEX_SIGNING_SEED', hex32)),
        FIREHOSE_URL: plain(`wss://${host(urls.carrier)}`),
        PLC_URL: plain('https://plc.directory'),
        SOLANA_RPC_URL: rpc.sealed ? sealed(rpc.value) : plain(rpc.value),
        REGISTRY_PROGRAM_ID: plain(DEVNET.registry),
        ESCROW_PROGRAM_ID: plain(DEVNET.escrow),
        CHAIN_COMMITMENT: plain('finalized'),
        CHAIN_POLL_MS: plain('10000'),
        PUBLIC_URL: plain(urls.index),
        PORT: plain('8080'),
      }
    case 'issuer': {
      // issuer/README.md. No Didit key: deploy/issuer/start.sh runs the stand-in.
      const vars: Record<string, Value> = {
        ISSUER_KEYPAIR: sealed(keyFile('issuer')),
        SOLANA_RPC_URL: rpc.sealed ? sealed(rpc.value) : plain(rpc.value),
        REGISTRY_PROGRAM_ID: plain(DEVNET.registry),
        LIST_INDEX: plain('0'),
        DATABASE_PATH: plain('/data/issuer.sqlite'),
        BATCH_MAX: plain('50'),
        BATCH_INTERVAL_SECONDS: plain('120'),
        SESSION_LIMIT_PER_HOUR: plain('5'),
        CLIENT_ADDRESS_HEADER: plain('x-real-ip'),
        PORT: plain('8080'),
      }
      if (process.env.DIDIT_API_KEY && process.env.DIDIT_WORKFLOW_ID) {
        vars.DIDIT_API_KEY = sealed(process.env.DIDIT_API_KEY)
        vars.DIDIT_WORKFLOW_ID = sealed(process.env.DIDIT_WORKFLOW_ID)
      }
      return vars
    }
    case 'feepayer':
      // feepayer/README.md: the key itself as the JSON array, since Railway has no secret files.
      return {
        FOREST_FEEPAYER_KEY: sealed(keyFile('payer')),
        RPC_URL: rpc.sealed ? sealed(rpc.value) : plain(rpc.value),
        PORT: plain('8080'),
      }
  }
}

/** The services provisioned so far; one Railway refused (`blocked`) has no URL and is skipped. */
function live(): Name[] {
  const s = readRecord().railway?.services ?? {}
  return NAMES.filter((n) => s[n]?.id && s[n]?.url)
}

function urlsFromRecord(): Record<Name, string> {
  const s = readRecord().railway?.services ?? {}
  const urls = {} as Record<Name, string>
  for (const name of live()) urls[name] = s[name].url
  return urls
}

/** Sets one service's variables through the environment config, sealing the secrets there. */
async function setVariables(name: Name, vars: Record<string, Value>): Promise<void> {
  const { railway } = readRecord()
  const serviceId = railway.services[name].id
  // Railway's documented way to build from a Dockerfile that is not at the root.
  vars = { RAILWAY_DOCKERFILE_PATH: plain(`deploy/${name}/Dockerfile`), ...vars }
  const variables: Record<string, { value: string; isSealed?: boolean }> = {}
  for (const [key, v] of Object.entries(vars)) variables[key] = v.sealed ? { value: v.value, isSealed: true } : { value: v.value }
  await gql(
    `mutation($environmentId: String!, $patch: EnvironmentConfig!) {
       environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true, commitMessage: "forest deploy/railway.ts variables") }`,
    { environmentId: railway.environmentId, patch: { services: { [serviceId]: { variables } } } },
  )
  const n = Object.values(vars).filter((v) => v.sealed).length
  console.log(`${name}: ${Object.keys(vars).length} variables set, ${n} sealed`)
}

async function variables(): Promise<void> {
  const urls = urlsFromRecord()
  for (const name of live()) await setVariables(name, variablesFor(name, urls))
  await sealedReport()
}

/** Names and seal flags only: Railway's Variable type has no value field. */
async function sealedReport(): Promise<void> {
  const { railway } = readRecord()
  const { environment } = await gql(
    `query($id: String!) { environment(id: $id) { variables(first: 500) { edges { node { name isSealed serviceId } } } } }`,
    { id: railway.environmentId },
  )
  const byId = Object.fromEntries(Object.entries(railway.services).map(([n, s]: any) => [s.id, n]))
  const rows = environment.variables.edges.map((e: any) => e.node)
  const out: Record<string, { sealed: string[]; plain: string[] }> = {}
  for (const r of rows) {
    const svc = byId[r.serviceId] ?? 'shared'
    out[svc] ??= { sealed: [], plain: [] }
    out[svc][r.isSealed ? 'sealed' : 'plain'].push(r.name)
  }
  for (const [svc, v] of Object.entries(out)) console.log(`${svc}: sealed ${v.sealed.sort().join(', ') || '(none)'}; plain ${v.plain.sort().join(', ')}`)
  updateRecord({ railway: { sealed: Object.fromEntries(Object.entries(out).map(([s, v]) => [s, v.sealed.sort()])) } })
}

// ---- deploy -------------------------------------------------------------------------------------

function currentBranch(): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function pushedCommit(): string {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const remote = execFileSync('git', ['ls-remote', 'origin', `refs/heads/${currentBranch()}`], { cwd: root, encoding: 'utf8' })
  if (!remote.startsWith(sha)) throw new Error(`HEAD ${sha.slice(0, 8)} is not what origin/${currentBranch()} holds; push first`)
  return sha
}

async function deploy(names: Name[]): Promise<void> {
  const { railway } = readRecord()
  for (const name of names.length ? names : live()) {
    const s = railway.services[name]
    if (s.source === 'github') {
      const sha = pushedCommit()
      const { serviceInstanceDeployV2 } = await gql(
        `mutation($serviceId: String!, $environmentId: String!, $commitSha: String!) {
           serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }`,
        { serviceId: s.id, environmentId: railway.environmentId, commitSha: sha },
      )
      console.log(`${name}: deploying ${sha.slice(0, 8)} from GitHub (deployment ${serviceInstanceDeployV2})`)
    } else {
      // An upload of this checkout, as git sees it (ignored files stay behind).
      const r = spawnSync(
        'railway',
        ['up', '--ci', '--detach', '--project', railway.projectId, '--environment', railway.environmentId, '--service', s.id],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, RAILWAY_API_TOKEN: token } },
      )
      const text = redact(`${r.stdout}\n${r.stderr}`).trim().split('\n').slice(-3).join(' | ')
      if (r.status !== 0) throw new Error(`${name}: railway up failed: ${text}`)
      console.log(`${name}: uploaded (${text})`)
    }
  }
}

async function status(): Promise<void> {
  const { railway } = readRecord()
  for (const name of NAMES) {
    const s = railway.services[name]
    if (!s?.id) {
      console.log(`${name.padEnd(9)} not provisioned${s?.blocked ? `: ${s.blocked}` : ''}`)
      continue
    }
    const { deployments } = await gql(
      `query($input: DeploymentListInput!) { deployments(first: 1, input: $input) { edges { node { id status createdAt } } } }`,
      { input: { serviceId: s.id, environmentId: railway.environmentId } },
    )
    const d = deployments.edges[0]?.node
    console.log(`${name.padEnd(9)} ${d ? `${d.status.padEnd(10)} ${d.createdAt} ${d.id}` : 'no deployment'}  ${s.url}`)
  }
}

// ---- rotate -------------------------------------------------------------------------------------

/** The secrets this script makes itself, by service. Keys and the database's password are rotated where they come from. */
const MADE: Record<string, { service: Name; make: () => string }> = {
  PDS_JWT_SECRET: { service: 'host', make: hex32 },
  PDS_ADMIN_PASSWORD: { service: 'host', make: hex32 },
  RELAY_ADMIN_PASSWORD: { service: 'carrier', make: password },
  INDEX_SIGNING_SEED: { service: 'index', make: hex32 },
}

async function rotate(key: string): Promise<void> {
  const made = MADE[key]
  if (!made) throw new Error(`rotate knows ${Object.keys(MADE).join(', ')}; others change where they come from (deploy/README.md)`)
  const { writeSecret } = await import('./lib/secrets.ts')
  writeSecret(key, made.make())
  await setVariables(made.service, { [key]: sealed(readSecret(key)) })
  await deploy([made.service])
}

// ---- main ---------------------------------------------------------------------------------------

const [step, ...args] = process.argv.slice(2)
switch (step) {
  case 'provision':
    await provision()
    break
  case 'variables':
    await variables()
    break
  case 'deploy':
    await deploy(args as Name[])
    break
  case 'status':
    await status()
    break
  case 'sealed':
    await sealedReport()
    break
  case 'rotate':
    await rotate(args[0])
    break
  default:
    throw new Error('usage: node railway.ts provision|variables|deploy [name...]|status|sealed|rotate NAME')
}

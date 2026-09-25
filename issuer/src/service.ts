// Configuration from the environment, and the service put together from it.

import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'

import { Connection, PublicKey } from '@solana/web3.js'

import { PROGRAM_ID } from '../../registry/client/src/program.ts'
import { Batcher } from './batch.ts'
import { DiditClient, type FaceCheck } from './didit.ts'
import { ChainList, loadKeypair, type IssuerList } from './list.ts'
import { handler } from './server.ts'
import { Store } from './store.ts'

export type Config = {
  diditApiKey: string
  diditWorkflowId: string
  diditBaseUrl: string
  issuerKeypairPath: string
  rpcUrl: string
  programId: PublicKey
  listIndex: number
  databasePath: string
  batchMax: number
  batchIntervalMs: number
  port: number
}

function whole(name: string, value: string, min: number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return n
}

/** Reads the variables `README.md` lists. Fails naming every required one that is missing. */
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'ISSUER_KEYPAIR_PATH', 'SOLANA_RPC_URL']
  const missing = required.filter((name) => !env[name])
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  return {
    diditApiKey: env.DIDIT_API_KEY!,
    diditWorkflowId: env.DIDIT_WORKFLOW_ID!,
    diditBaseUrl: env.DIDIT_BASE_URL || 'https://verification.didit.me',
    issuerKeypairPath: env.ISSUER_KEYPAIR_PATH!,
    rpcUrl: env.SOLANA_RPC_URL!,
    programId: env.REGISTRY_PROGRAM_ID ? new PublicKey(env.REGISTRY_PROGRAM_ID) : PROGRAM_ID,
    listIndex: whole('LIST_INDEX', env.LIST_INDEX || '0', 0),
    databasePath: env.DATABASE_PATH || './data/issuer.sqlite',
    batchMax: whole('BATCH_MAX', env.BATCH_MAX || '50', 1),
    batchIntervalMs: whole('BATCH_INTERVAL_SECONDS', env.BATCH_INTERVAL_SECONDS || '3600', 1) * 1000,
    port: whole('PORT', env.PORT || '8080', 0),
  }
}

export type Issuer = {
  url: string
  server: Server
  store: Store
  batcher: Batcher
  /** Stops taking requests, lets a running batch finish, and closes the file. */
  close(): Promise<void>
}

/**
 * Starts the service. Tests pass their own face check or list; otherwise it talks to Didit and to the
 * chain, and refuses to start unless the key is an insert key of the list.
 */
export async function startIssuer(
  config: Config,
  overrides: { faceCheck?: FaceCheck; list?: IssuerList; log?: (line: string) => void } = {},
): Promise<Issuer> {
  const list =
    overrides.list ??
    (await ChainList.open({
      connection: new Connection(config.rpcUrl, 'confirmed'),
      issuer: loadKeypair(config.issuerKeypairPath),
      listIndex: config.listIndex,
      programId: config.programId,
    }))
  const faceCheck =
    overrides.faceCheck ??
    new DiditClient({
      apiKey: config.diditApiKey,
      workflowId: config.diditWorkflowId,
      baseUrl: config.diditBaseUrl,
    })

  mkdirSync(dirname(config.databasePath), { recursive: true })
  const store = new Store(config.databasePath)
  const batcher = new Batcher(store, list, {
    max: config.batchMax,
    intervalMs: config.batchIntervalMs,
    log: overrides.log,
  })
  const server = createServer(
    handler({ store, faceCheck, list, batcher, workflowId: config.diditWorkflowId, log: overrides.log }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, resolve)
  })
  batcher.start()

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    store,
    batcher,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await batcher.close()
      store.close()
    },
  }
}

// Everything the index is told from outside: environment variables for where things are, and three
// JSON files for its opinions (issuer weights, market aliases, scoring weights). Read once at
// start; a change means a restart.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const INDEX_ROOT = resolve(here, '..')

export type IssuerConfig = Record<string, { name: string; weight: number }>
export type AliasConfig = Record<string, string[]>
export type ScoringConfig = {
  evidence: { both: number; oneSided: number; none: number }
  unbadgedReviewer: number
  countedMints: string[]
  maxRounds: number
  tolerance: number
}

export type Config = {
  databaseUrl: string
  /** The firehose to read records from: a host's own in tests, the carrier later. Unset: no record reader. */
  firehoseUrl: string | null
  /** Where DIDs are resolved. An http:// URL (a local directory) makes the resolver use plain fetch. */
  plcUrl: string
  /** A Solana RPC. Unset: no chain reader. */
  rpcUrl: string | null
  registryProgramId: string | null
  escrowProgramId: string | null
  chainPollMs: number
  /** How settled a transaction must be before it is read: 'finalized' (the default) or 'confirmed'. */
  chainCommitment: 'finalized' | 'confirmed'
  /** 32 bytes, hex. Both of the index's signing keys come from it. */
  signingSeed: Uint8Array
  /** A folder of market files: the `markets` repo's, or shapes/examples/markets in tests. */
  marketsDir: string
  port: number
  issuers: IssuerConfig
  aliases: AliasConfig
  scoring: ScoringConfig
}

function readJson<T>(path: string, key: string): T {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!(key in parsed)) throw new Error(`${path} has no "${key}"`)
  return parsed[key] as T
}

function readScoring(path: string): ScoringConfig {
  const { about: _about, ...rest } = JSON.parse(readFileSync(path, 'utf8'))
  return rest as ScoringConfig
}

export function hexSeed(hex: string | undefined): Uint8Array {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('INDEX_SIGNING_SEED must be 32 bytes as 64 hex characters')
  }
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!env.MARKETS_DIR) throw new Error('MARKETS_DIR is required: a folder of market files')
  return {
    databaseUrl: env.DATABASE_URL,
    firehoseUrl: env.FIREHOSE_URL || null,
    plcUrl: env.PLC_URL || 'https://plc.directory',
    rpcUrl: env.SOLANA_RPC_URL || null,
    registryProgramId: env.REGISTRY_PROGRAM_ID || null,
    escrowProgramId: env.ESCROW_PROGRAM_ID || null,
    chainPollMs: Number(env.CHAIN_POLL_MS || 5000),
    chainCommitment: env.CHAIN_COMMITMENT === 'confirmed' ? 'confirmed' : 'finalized',
    signingSeed: hexSeed(env.INDEX_SIGNING_SEED),
    marketsDir: resolve(env.MARKETS_DIR),
    port: Number(env.PORT || 8080),
    issuers: readJson(env.ISSUERS_FILE || join(INDEX_ROOT, 'config/issuers.json'), 'issuers'),
    aliases: readJson(env.ALIASES_FILE || join(INDEX_ROOT, 'config/aliases.json'), 'aliases'),
    scoring: readScoring(env.SCORING_FILE || join(INDEX_ROOT, 'config/scoring.json')),
  }
}

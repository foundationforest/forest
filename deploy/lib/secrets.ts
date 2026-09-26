// Secrets the deploy scripts make or read, kept outside the repo and never printed.
//
// Each lives in its own file under FOREST_SERVICES_SECRETS (default ~/.forest-devnet/services),
// directory 700, files 600, next to the keys devnet/keys.sh writes (FOREST_DEVNET_KEYS, default
// ~/.forest-devnet/keys). Once a secret is sealed on Railway it cannot be read back from there; these
// files are this machine's copy for the admin calls a deploy makes, and they go when the machine goes.
// Rotating is the way to get a fresh one (README.md).

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '../..')

function inRepo(path: string): boolean {
  const full = resolve(path)
  return full === repo || full.startsWith(repo + '/')
}

export const secretsDir = process.env.FOREST_SERVICES_SECRETS || join(homedir(), '.forest-devnet/services')
export const keysDir = process.env.FOREST_DEVNET_KEYS || join(homedir(), '.forest-devnet/keys')

for (const dir of [secretsDir, keysDir]) {
  if (inRepo(dir)) throw new Error(`refusing: ${dir} is inside the repo; keep secrets outside it`)
}

export function hasSecret(name: string): boolean {
  return existsSync(join(secretsDir, name))
}

export function readSecret(name: string): string {
  const path = join(secretsDir, name)
  if (!existsSync(path)) throw new Error(`no secret ${name} in ${secretsDir}`)
  return readFileSync(path, 'utf8')
}

export function writeSecret(name: string, value: string): void {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 })
  chmodSync(secretsDir, 0o700)
  const path = join(secretsDir, name)
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** The secret named, made once with `make` and kept; later runs read the same one. */
export function secret(name: string, make: () => string): string {
  if (!hasSecret(name)) writeSecret(name, make())
  return readSecret(name)
}

export const hex32 = () => randomBytes(32).toString('hex')
export const password = () => randomBytes(24).toString('base64url')

/** A keypair file from devnet/keys.sh, as the JSON array of 64 numbers solana-keygen writes. */
export function keyFile(label: string): string {
  const path = join(keysDir, `${label}.json`)
  if (!existsSync(path)) throw new Error(`no ${label}.json in ${keysDir}; run devnet/keys.sh`)
  return readFileSync(path, 'utf8').trim()
}

/** Reads an environment variable the caller needs, failing with its name only. */
export function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

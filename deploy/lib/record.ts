// deploy/services.json: the public record of what is deployed where. URLs, ids, addresses and
// signatures only; never a secret. Every script reads it and merges what it learns into it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const recordPath = join(import.meta.dirname, '../services.json')

export type Record = { [key: string]: any }

export function readRecord(): Record {
  return existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : {}
}

/** Deep-merges `patch` into the record and writes it back. */
export function updateRecord(patch: Record): Record {
  const merged = merge(readRecord(), patch)
  writeFileSync(recordPath, JSON.stringify(merged, null, 2) + '\n')
  return merged
}

function merge(a: any, b: any): any {
  if (typeof a !== 'object' || a === null || Array.isArray(a) || typeof b !== 'object' || b === null || Array.isArray(b)) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
  return out
}

/** Appends one transaction to the record's list, once. */
export function noteTransaction(what: string, signature: string): void {
  const record = readRecord()
  const list: { what: string; signature: string }[] = record.transactions ?? []
  if (!list.some((t) => t.signature === signature)) list.push({ what, signature })
  updateRecord({ transactions: list })
  console.log(`${what}: ${signature}`)
}

// The market directory, as this index reads it: the market files in one folder (the `markets`
// repo's, once it exists), each checked with shapes/' validator, plus the index's own aliases.
//
// Two different questions, answered by two functions:
//   postMarket(name)   which directory market a post belongs to, through the aliases
//   badgeScope(scope)  whether a registry scope counts as a badge: the directory name, byte for
//                      byte, never through an alias, since a second spelling is a second scope
//                      and would be a second badge for the same human in the same market.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error shapes/ is plain JavaScript with no type declarations
import { validateMarket } from '../../shapes/src/validate.js'

import type { AliasConfig } from './config.ts'

export type MarketFile = {
  name: string
  category: string
  roles: string[]
  fields: unknown
  evidenceTypes: string[]
  suggested: unknown
  credentialIssuers: string[]
}

export class Directory {
  readonly markets = new Map<string, MarketFile>()
  /** spelling → directory name, for posts and URLs only. */
  readonly aliasOf = new Map<string, string>()
  /** Files in the folder that failed the validator, with why. They count for nothing. */
  readonly refused: { file: string; errors: string[] }[] = []

  constructor(files: { file: string; market: unknown }[], aliases: AliasConfig) {
    for (const { file, market } of files) {
      const checked = validateMarket(market) as { ok: boolean; errors: string[] }
      if (!checked.ok) {
        this.refused.push({ file, errors: checked.errors })
        continue
      }
      const m = market as MarketFile
      this.markets.set(m.name, m)
    }
    for (const [name, spellings] of Object.entries(aliases)) {
      if (!this.markets.has(name)) continue
      for (const s of spellings) if (!this.markets.has(s)) this.aliasOf.set(s, name)
    }
  }

  static load(dir: string, aliases: AliasConfig): Directory {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ file: f, market: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
    return new Directory(files, aliases)
  }

  /** The directory market a post's `market` belongs to: itself, or through an alias. */
  postMarket(name: string): string | null {
    if (this.markets.has(name)) return name
    return this.aliasOf.get(name) ?? null
  }

  /** The aliases this index groups under a directory market. */
  aliasesFor(name: string): string[] {
    return [...this.aliasOf].filter(([, to]) => to === name).map(([from]) => from).sort()
  }

  /**
   * Whether a registry scope is a badge this index counts: its market part, before the first
   * colon, is a directory name byte for byte, and its role part, if any, is one of that market's
   * roles.
   */
  badgeScope(scope: string): { market: string; role: string | null } | null {
    const { market, role } = splitScope(scope)
    const file = this.markets.get(market)
    if (!file) return null
    if (role !== null && !file.roles.includes(role)) return null
    return { market, role }
  }

  categories(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of this.markets.values()) {
      out.set(m.category, [...(out.get(m.category) ?? []), m.name].sort())
    }
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
}

/** A registry scope is a market, or a market and a role after the first colon. */
export function splitScope(scope: string): { market: string; role: string | null } {
  const at = scope.indexOf(':')
  return at === -1 ? { market: scope, role: null } : { market: scope.slice(0, at), role: scope.slice(at + 1) }
}

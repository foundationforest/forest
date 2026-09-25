// The market directory, as this index reads it: the `markets` repo itself, fetched over HTTPS from
// MARKETS_URL, never copied. Its `directory.md` names each market with a link to its file,
// `<category>/<name>.json`, which is checked with shapes/' validator; its Aliases table groups other
// spellings under a market.
//
// Two different questions, answered by two functions:
//   postMarket(name)   which directory market a post belongs to, through the aliases
//   badgeScope(scope)  whether a registry scope counts as a badge: `market/role` only, the market a
//                      directory name byte for byte, never through an alias, since a second
//                      spelling is a second scope and would be a second badge for the same human
//                      in the same market, and the role one of that market's roles. A plain
//                      `market` counts for nothing.

// @ts-expect-error shapes/ is plain JavaScript with no type declarations
import { rolesOf, validateMarket } from '../../shapes/src/validate.js'

/** A directory market's name, and the other spellings the markets repo groups under it. */
export type Aliases = Record<string, string[]>

export type MarketFile = {
  name: string
  category: string
  description?: string
  /** Always filled: the file's own roles, or shapes/' default (seller and buyer) when it names none. */
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
  /** Market files the directory lists that are not valid at their own path, with why. They count for nothing. */
  readonly refused: { file: string; errors: string[] }[] = []

  constructor(files: { file: string; market: unknown }[], aliases: Aliases) {
    for (const { file, market } of files) {
      const checked = validateMarket(market) as { ok: boolean; errors: string[] }
      if (!checked.ok) {
        this.refused.push({ file, errors: checked.errors })
        continue
      }
      const m = market as MarketFile
      this.markets.set(m.name, { ...m, roles: [...(rolesOf(m) as string[])] })
    }
    for (const [name, spellings] of Object.entries(aliases)) {
      if (!this.markets.has(name)) continue
      for (const s of spellings) if (!this.markets.has(s)) this.aliasOf.set(s, name)
    }
  }

  /**
   * The directory, read from a copy of the markets repo served over HTTP(S): `base` is the folder
   * that holds `directory.md`, such as `https://raw.githubusercontent.com/foundationforest/markets/main`.
   * A file that can't be fetched stops the load, so a network failure never drops a market
   * quietly; a file that fetches but is not a valid market file at its own path is refused.
   */
  static async fetch(base: string, get: typeof fetch = fetch): Promise<Directory> {
    const read = async (path: string): Promise<string> => {
      const res = await get(`${base}/${path}`)
      if (!res.ok) throw new Error(`the market directory: ${base}/${path} answered ${res.status}`)
      return res.text()
    }
    const { links, aliases } = parseDirectory(await read('directory.md'))
    const files: { file: string; market: unknown }[] = []
    const refused: { file: string; errors: string[] }[] = []
    for (const { name, path } of links) {
      let market: unknown
      try {
        market = JSON.parse(await read(path))
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err
        refused.push({ file: path, errors: ['not JSON'] })
        continue
      }
      const m = market as { name?: unknown; category?: unknown }
      if (m.name !== name || path !== `${m.category}/${m.name}.json`) {
        refused.push({ file: path, errors: [`listed as ${name}, but the file names ${String(m.name)} in ${String(m.category)}`] })
        continue
      }
      files.push({ file: path, market })
    }
    const directory = new Directory(files, aliases)
    directory.refused.push(...refused)
    return directory
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
   * Whether a registry scope is a badge this index counts: `market/role`, its market part a
   * directory name byte for byte and its role one of that market's roles. A scope with no role
   * counts for nothing.
   */
  badgeScope(scope: string): { market: string; role: string } | null {
    const { market, role } = splitScope(scope)
    const file = this.markets.get(market)
    if (!file || role === null || !file.roles.includes(role)) return null
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

/**
 * A registry scope is a market, or a market and a role after the first slash: `online-tutors` or
 * `online-tutors/seller`. Only the slash: market names and roles are slugs, so a scope written
 * with any other separator is not a directory name and counts for nothing. Accepting two
 * separators would make two scopes, so two badges, for one human in one market.
 */
export function splitScope(scope: string): { market: string; role: string | null } {
  const at = scope.indexOf('/')
  return at === -1 ? { market: scope, role: null } : { market: scope.slice(0, at), role: scope.slice(at + 1) }
}

/**
 * What the index takes from the markets repo's `directory.md`: each market's line,
 * ``- [`name`](category/name.json): …``, and the rows of the table under "## Aliases",
 * ``| `market` | `alias`, `alias` |``, read the way that repo's own `check.sh` reads them.
 */
export function parseDirectory(md: string): { links: { name: string; path: string }[]; aliases: Aliases } {
  const links = [...md.matchAll(/^- \[`([^`]+)`\]\(([^)\s]+\.json)\)/gm)].map(([, name, path]) => ({ name, path }))
  const aliases: Aliases = {}
  const table = (md.split(/^## Aliases *$/m)[1] ?? '').split(/^## /m)[0]
  for (const row of table.split('\n')) {
    const cells = row.split('|').slice(1, -1)
    const listed = cells[0]?.match(/`([^`]+)`/)?.[1]
    if (!listed || cells.length < 2) continue // not a row, or the header and its rule
    aliases[listed] = [...cells[1].matchAll(/`([^`]+)`/g)].map(([, alias]) => alias)
  }
  return { links, aliases }
}

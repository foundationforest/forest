// An index's reading side: it reads hosts directly, checks every entry itself, merges what it
// finds with the same pure function everyone uses, and finds new hosts in the folders it reads.
// No directory and no relay in between. Ranking lives above this and is not here.

import { readPage } from './client.ts'
import type { FolderBody } from './entry.ts'
import { type ProfileView, type Version, viewAll } from './view.ts'

export class Index {
  readonly hosts = new Set<string>()
  private readonly versions = new Map<string, Version>()
  private readonly cursors = new Map<string, number>()
  private readonly now: () => number
  /** Lines hosts served that did not pass the checks, by host. */
  readonly refused = new Map<string, number>()

  constructor(options: { hosts?: string[]; now?: () => number } = {}) {
    for (const h of options.hosts ?? []) this.hosts.add(h)
    this.now = options.now ?? Date.now
  }

  add(v: Version) {
    this.versions.set(v.id, v)
  }

  /** Follow one host's whole feed from where this index left off. */
  async follow(host: string, options: { path?: string } = {}): Promise<number> {
    this.hosts.add(host)
    let added = 0
    for (;;) {
      const after = this.cursors.get(host) ?? 0
      const page = await readPage(host, { after, path: options.path })
      for (const v of page.versions) {
        if (!this.versions.has(v.id)) added++
        this.add(v)
      }
      if (page.refused.length) this.refused.set(host, (this.refused.get(host) ?? 0) + page.refused.length)
      if (page.cursor === after) return added
      this.cursors.set(host, page.cursor)
    }
  }

  /**
   * Read every known host, then every host named in any current folder, until no new host
   * turns up. Hosts that do not answer are skipped: the others still count.
   */
  async crawl(): Promise<{ hosts: number; unreachable: string[] }> {
    const seen = new Set<string>()
    const unreachable: string[] = []
    for (;;) {
      const next = [...this.hosts].filter((h) => !seen.has(h))
      if (!next.length) return { hosts: seen.size, unreachable }
      for (const host of next) {
        seen.add(host)
        try {
          await this.follow(host)
        } catch {
          unreachable.push(host)
        }
      }
      for (const view of this.views().values()) {
        const folder = view.folder as FolderBody | null | undefined
        for (const host of folder?.hosts ?? []) this.hosts.add(host)
      }
    }
  }

  views(): Map<string, ProfileView> {
    return viewAll(this.versions.values(), this.now())
  }

  view(profile: string): ProfileView | undefined {
    return this.views().get(profile)
  }

  size(): number {
    return this.versions.size
  }
}

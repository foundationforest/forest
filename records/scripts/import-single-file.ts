// The one-time move from a host's old single SQLite file to a file per folder. It reads the old
// file and writes each folder's file and the blobs, then rebuilds host.sqlite from them, so a
// running host keeps every folder when it moves. Numbers stay as they were: the cursors readers and
// inboxes already hold go on working.
//
//   node scripts/import-single-file.ts <old.sqlite> <data directory>
//
// With the host stopped. Bytes go to the disk driver; a host on an S3-compatible bucket calls
// importSingleFile with its driver.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { type BlobDriver, blobStore, folderForImport, rebuild } from '../src/storage.ts'

export async function importSingleFile(oldFile: string, options: { dir: string; blobs?: BlobDriver; now?: number }): Promise<{ folders: number; records: number; messages: number; blobs: number }> {
  const { dir, blobs = { kind: 'disk' }, now = Date.now() } = options
  if (existsSync(join(dir, 'host.sqlite')) || (existsSync(join(dir, 'folders')) && readdirSync(join(dir, 'folders')).length)) throw new Error(`${dir} already holds a host`)
  const old = new DatabaseSync(oldFile, { readOnly: true })
  const folders = new Map<string, DatabaseSync>()
  const folder = (address: string) => {
    let db = folders.get(address)
    if (!db) {
      folders.set(address, (db = folderForImport(dir, address)))
      db.exec('BEGIN')
    }
    return db
  }
  const counts = { folders: 0, records: 0, messages: 0, blobs: 0 }
  try {
    // The old file kept no time a record arrived; the import's clock stands in for it.
    for (const r of old.prepare('SELECT seq, id, profile, text, bytes, older_since FROM records ORDER BY seq').iterate() as Iterable<{ seq: number; id: string; profile: string; text: string; bytes: number; older_since: number | null }>) {
      folder(r.profile).prepare('INSERT INTO records (seq, id, text, bytes, arrived, older_since) VALUES (?, ?, ?, ?, ?, ?)').run(r.seq, r.id, r.text, r.bytes, now, r.older_since)
      counts.records++
    }
    for (const m of old.prepare('SELECT seq, id, recipient, text, bytes, arrived FROM messages ORDER BY seq').iterate() as Iterable<{ seq: number; id: string; recipient: string; text: string; bytes: number; arrived: number }>) {
      folder(m.recipient).prepare('INSERT INTO messages (seq, id, text, bytes, arrived) VALUES (?, ?, ?, ?, ?)').run(m.seq, m.id, m.text, m.bytes, m.arrived)
      counts.messages++
    }
    for (const p of old.prepare('SELECT sender, recipient FROM once_pairs').iterate() as Iterable<{ sender: string; recipient: string }>) {
      folder(p.recipient).prepare('INSERT INTO once (sender) VALUES (?)').run(p.sender)
    }
    for (const db of folders.values()) db.exec('COMMIT')
    counts.folders = folders.size
    const store = blobStore(dir, blobs)
    for (const b of old.prepare('SELECT sha256, type, data FROM blobs').iterate() as Iterable<{ sha256: string; type: string; data: Uint8Array }>) {
      await store.put(b.sha256, b.type, b.data)
      counts.blobs++
    }
  } finally {
    for (const db of folders.values()) db.close()
    old.close()
  }
  await rebuild(dir, blobs, now)
  return counts
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [oldFile, dir] = process.argv.slice(2)
  if (!oldFile || !dir) {
    console.error('usage: node scripts/import-single-file.ts <old.sqlite> <data directory>')
    process.exit(1)
  }
  console.log(await importSingleFile(oldFile, { dir }))
}

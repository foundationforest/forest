// Fetch the pinned Semaphore setup files and check them against their hashes.
//
//   npm run fetch
//
// The verification key (`semaphore-32.json`, 3.7 kB) is committed: the program has it baked in
// forever, so it belongs in the repo. The proving key and the witness generator are 7.7 MB and
// only ever used to *make* a proof, so they are pinned by URL and SHA-256 here instead. A file
// that does not match its hash is deleted rather than kept.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

let failed = false
for (const [name, entry] of Object.entries(manifest.files)) {
  const path = join(here, name)
  if (existsSync(path) && sha256(readFileSync(path)) === entry.sha256) {
    console.log(`${name}: already here and correct`)
    continue
  }
  const url = `${manifest.baseUrl}${name}`
  process.stdout.write(`${name}: fetching ${url} ... `)
  const response = await fetch(url)
  if (!response.ok) {
    console.log(`HTTP ${response.status}`)
    failed = true
    continue
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const got = sha256(bytes)
  if (got !== entry.sha256) {
    console.log(`\n  WRONG HASH\n  want ${entry.sha256}\n  got  ${got}`)
    failed = true
    continue
  }
  writeFileSync(path, bytes)
  console.log(`${bytes.length} bytes, hash matches`)
}

// The committed verification key is checked too: it is the one thing the sealed program depends on.
for (const [name, want] of Object.entries(manifest.committed)) {
  const path = join(here, name)
  const got = existsSync(path) ? sha256(readFileSync(path)) : 'missing'
  if (got !== want.sha256) {
    console.log(`${name}: WRONG, want ${want.sha256}, got ${got}`)
    failed = true
  } else {
    console.log(`${name}: committed, hash matches`)
  }
}

if (failed) {
  for (const name of Object.keys(manifest.files)) {
    const path = join(here, name)
    if (existsSync(path) && sha256(readFileSync(path)) !== manifest.files[name].sha256) unlinkSync(path)
  }
  process.exit(1)
}

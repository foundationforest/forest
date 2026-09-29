// Bundle the approval page: web/dist/{approve.html, approve.css, approve.js}, plus the bundle's
// SHA-256, which a real deployment publishes so anyone can check the page they were served.

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const here = new URL('.', import.meta.url).pathname
mkdirSync(`${here}dist`, { recursive: true })
await build({
  entryPoints: [`${here}approve.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: `${here}dist/approve.js`,
  logLevel: 'warning',
})
copyFileSync(`${here}approve.html`, `${here}dist/approve.html`)
copyFileSync(`${here}approve.css`, `${here}dist/approve.css`)
const digest = createHash('sha256').update(readFileSync(`${here}dist/approve.js`)).digest('hex')
writeFileSync(`${here}dist/approve.js.sha256`, `${digest}  approve.js\n`)
console.log(`web/dist/approve.js sha256 ${digest}`)

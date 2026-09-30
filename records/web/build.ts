// Bundle the approval page: web/dist/{approve.html, approve.css, approve.js}, plus
// - approve.js.sha256: the bundle's hash, which a real deployment publishes so anyone can check
//   the page they were served;
// - approve.deps.txt: every library whose code is in the bundle, with its version.

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const here = new URL('.', import.meta.url).pathname
mkdirSync(`${here}dist`, { recursive: true })
const { metafile } = await build({
  entryPoints: [`${here}approve.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  metafile: true,
  outfile: `${here}dist/approve.js`,
  logLevel: 'warning',
})
copyFileSync(`${here}approve.html`, `${here}dist/approve.html`)
copyFileSync(`${here}approve.css`, `${here}dist/approve.css`)

const bundled = Object.keys(metafile.outputs[Object.keys(metafile.outputs)[0]!]!.inputs)
const packages = new Set<string>()
for (const path of bundled) {
  const after = path.split('node_modules/')[1]
  if (!after) continue
  const parts = after.split('/')
  packages.add(parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!)
}
const deps = [...packages].sort().map((name) => {
  const { version } = JSON.parse(readFileSync(`${here}../node_modules/${name}/package.json`, 'utf8')) as { version: string }
  return `${name} ${version}`
})
writeFileSync(`${here}dist/approve.deps.txt`, deps.join('\n') + '\n')

const js = readFileSync(`${here}dist/approve.js`)
const digest = createHash('sha256').update(js).digest('hex')
writeFileSync(`${here}dist/approve.js.sha256`, `${digest}  approve.js\n`)
console.log(`web/dist/approve.js: ${js.length} bytes, sha256 ${digest}`)
console.log(`libraries: ${deps.join(', ')}`)

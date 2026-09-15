#!/usr/bin/env node
// usage:
//   forest-validate record <record.json> [--market <market.json>]
//   forest-validate market <market.json>
// Exit 0 when valid, 1 when not, 2 on bad usage or unreadable input.

import { readFileSync } from 'node:fs'
import { validateMarket, validateRecord } from '../src/validate.js'

const usage = [
  'usage:',
  '  forest-validate record <record.json> [--market <market.json>]',
  '  forest-validate market <market.json>',
].join('\n')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`cannot read ${path}: ${e.message}`)
    process.exit(2)
  }
}

const [command, file, ...rest] = process.argv.slice(2)
let result

if (command === 'record' && file) {
  const at = rest.indexOf('--market')
  const marketFile = at >= 0 ? rest[at + 1] : undefined
  if (at >= 0 && !marketFile) {
    console.error(usage)
    process.exit(2)
  }
  const market = marketFile ? readJson(marketFile) : undefined
  result = validateRecord(readJson(file), { market })
  if (result.ok) {
    const where = market ? ` in market "${market.name}"` : ''
    console.log(`ok: ${file} is a valid ${result.shape}${where}`)
  }
} else if (command === 'market' && file) {
  result = validateMarket(readJson(file))
  if (result.ok) console.log(`ok: ${file} is a valid market file`)
} else {
  console.error(usage)
  process.exit(2)
}

if (!result.ok) {
  console.error(`${file}:`)
  for (const error of result.errors) console.error(`  - ${error}`)
  process.exit(1)
}

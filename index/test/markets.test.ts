// Reading the market directory from the markets repo: its `directory.md`, the market files it
// links, and its Aliases table. No network: the repo is a map of paths to texts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Directory, parseDirectory } from '../src/markets.ts'
import { MARKETS_FOLDER, serveMarkets } from './markets-repo.ts'

const BASE = 'https://markets.test/main'
const tutors = readFileSync(join(MARKETS_FOLDER, 'freelance-work/online-tutors.json'), 'utf8')
const plumbing = JSON.stringify({ ...JSON.parse(tutors), name: 'plumbing', category: 'home-services', fields: {} })

// The markets repo's own layout: a line per market under its category, a Scopes section whose
// bullets link nothing, and the Aliases table.
const md = (lines: string) => `# Directory

## home-services

- [\`plumbing\`](home-services/plumbing.json): Pipes, taps, drains.

## freelance-work

${lines}

## Scopes

- The roles are the ones the market's file names.

## Aliases

Each row is one market, then its aliases.

| Market | Aliases |
| --- | --- |
| \`plumbing\` | \`plumber\`, \`plumbers\` |
| \`online-tutors\` | \`online-tutor\` |
`

function repo(files: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const path = url.slice(BASE.length + 1)
    return path in files ? new Response(files[path]) : new Response('404: Not Found', { status: 404 })
  }) as typeof fetch
}

test('the directory: each linked market file, and the Aliases table', async () => {
  const text = md('- [`online-tutors`](freelance-work/online-tutors.json): Lessons online.')
  assert.deepEqual(parseDirectory(text), {
    links: [
      { name: 'plumbing', path: 'home-services/plumbing.json' },
      { name: 'online-tutors', path: 'freelance-work/online-tutors.json' },
    ],
    aliases: { plumbing: ['plumber', 'plumbers'], 'online-tutors': ['online-tutor'] },
  })
  const d = await Directory.fetch(BASE, repo({ 'directory.md': text, 'home-services/plumbing.json': plumbing, 'freelance-work/online-tutors.json': tutors }))
  assert.deepEqual([...d.markets.keys()], ['plumbing', 'online-tutors'])
  assert.deepEqual(d.refused, [])
  assert.equal(d.postMarket('plumber'), 'plumbing', 'an alias groups posts')
  assert.equal(d.badgeScope('plumber/seller'), null, 'and never a badge')
  assert.deepEqual(d.badgeScope('plumbing/seller'), { market: 'plumbing', role: 'seller' })
  assert.equal(d.badgeScope('plumbing'), null, 'a plain market counts for nothing')
})

test('a file listed under another name, at another path, or not a market file is refused; the rest count', async () => {
  const d = await Directory.fetch(
    BASE,
    repo({
      'directory.md': md(['- [`online-tutoring`](freelance-work/online-tutors.json): Wrong name.', '- [`broken`](freelance-work/broken.json): Not JSON.', '- [`bare`](freelance-work/bare.json): Not a market file.'].join('\n')),
      'home-services/plumbing.json': plumbing,
      'freelance-work/online-tutors.json': tutors,
      'freelance-work/broken.json': '{',
      'freelance-work/bare.json': JSON.stringify({ name: 'bare', category: 'freelance-work' }),
    }),
  )
  assert.deepEqual([...d.markets.keys()], ['plumbing'])
  assert.deepEqual(d.refused.map((r) => r.file).sort(), ['freelance-work/bare.json', 'freelance-work/broken.json', 'freelance-work/online-tutors.json'])
  assert.equal(d.postMarket('online-tutor'), null, 'an alias of a market that did not load groups nothing')
})

test('a file the directory links that cannot be fetched stops the load', async () => {
  await assert.rejects(
    Directory.fetch(BASE, repo({ 'directory.md': md('- [`online-tutors`](freelance-work/online-tutors.json): Missing.'), 'home-services/plumbing.json': plumbing })),
    /freelance-work\/online-tutors\.json answered 404/,
  )
  await assert.rejects(Directory.fetch(BASE, repo({})), /directory\.md answered 404/)
})

test("the tests' own markets repo, over HTTP", async () => {
  const served = await serveMarkets()
  try {
    const d = await Directory.fetch(served.url)
    assert.deepEqual([...d.markets.keys()], ['online-tutors'])
    assert.deepEqual(d.aliasesFor('online-tutors'), ['online-tutor', 'online-tutoring', 'tutors-online'])
  } finally {
    await served.close()
  }
})

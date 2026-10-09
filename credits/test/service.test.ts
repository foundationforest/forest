// Credits, a service's side: its key from PKCS #8, its directory as the client reads it, a buy
// counted, priced and answered (the client finishes the credits and the service's check takes them),
// the answer the same twice, nothing logged; the payment check against a stand-in RPC; and the
// spent list's hold, land and free, of one id or several together, kept across a restart.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { genericBatched } from '@cloudflare/privacypass-ts'
import { base58 } from '@scure/base'
import { buy, checkCredit, finish, serviceOf } from '../src/index.ts'
import { type Rpc, SpentList, amountOf, answer, countOf, directoryOf, keyFrom, paid } from '../src/service.ts'

const ORIGIN = 'https://payer.example'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ADDRESS = base58.encode(new Uint8Array(32).fill(3))
const pkcs8 = (bits: number) => new Uint8Array(generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'der' }))

const key = await keyFrom(pkcs8(2048))
const directory = directoryOf({ requestUri: '/credits/buy', keys: [{ key: key.published }], credit: { unit: 'one registration', address: ADDRESS, mint: MINT, price: '0.5' } })
const service = serviceOf(ORIGIN, directory)

test('its key, from PKCS #8, and its directory, as the client reads it', async () => {
  assert.deepEqual(service.key, key.published)
  assert.deepEqual([service.requestUri, service.unit, service.address, service.mint, service.price], [`${ORIGIN}/credits/buy`, 'one registration', ADDRESS, MINT, '0.5'])
  assert.deepEqual((directory['token-keys'] as unknown[])[0], { 'token-type': 2, 'token-key': Buffer.from(key.published).toString('base64url') })
  const later = directoryOf({ requestUri: '/credits/buy', keys: [{ key: key.published, notBefore: 1_790_000_000 }], credit: { unit: 'u', address: ADDRESS, mint: 'SOL', price: '0.001' } })
  assert.equal((later['token-keys'] as { 'not-before': number }[])[0]!['not-before'], 1_790_000_000)
  await assert.rejects(keyFrom(pkcs8(1024)), /RSA-2048/)
  await assert.rejects(keyFrom(new Uint8Array(32)))
})

test('a buy: counted, priced, answered; the credits finish and the service takes them', async () => {
  const b = await buy(service, 3)
  assert.equal(countOf(b.buy), 3)
  assert.equal(amountOf(service.price, countOf(b.buy)), '1.5')
  assert.ok(b.payLink.includes('amount=1.5&'), 'what the pay link asks for')
  const answered = await answer(b.buy, key, ORIGIN)
  assert.deepEqual(await answer(b.buy, key, ORIGIN), answered, 'the same buy gets the same answer')
  const credits = await finish(b.pending, answered)
  assert.equal(credits.length, 3)
  for (const c of credits) assert.match(await checkCredit(c, { origin: ORIGIN, keys: [key.published] }), /^[0-9a-f]{64}$/)
  assert.throws(() => countOf(new Uint8Array([1, 2, 3])), /not a buy/)
})

test('a request under another key gets an empty slot, and nothing is logged', async () => {
  const other = await keyFrom(pkcs8(2048))
  const theirs = await buy(serviceOf(ORIGIN, directoryOf({ requestUri: '/credits/buy', keys: [{ key: other.published }], credit: { unit: 'u', address: ADDRESS, mint: MINT, price: '1' } })), 1)
  const logged: unknown[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void logged.push(args)
  let answered: Uint8Array
  try {
    answered = await answer(theirs.buy, key, ORIGIN)
  } finally {
    console.log = log
  }
  assert.deepEqual(logged, [], 'nothing of what it was sent is logged')
  assert.equal([...genericBatched.GenericBatchTokenResponse.deserialize(answered)][0]!.tokenResponse, null)
  await assert.rejects(finish(theirs.pending, answered), /holds no credit/)
  // Bytes that are not a buy get no answer at all.
  await assert.rejects(answer(new Uint8Array([0, 2, 9]), key, ORIGIN))
})

test('the payment: a finalized transaction that names the reference and pays enough', async () => {
  const reference = base58.encode(new Uint8Array(32).fill(7))
  const tokens = (paidUnits: string, mint = MINT, err: unknown = null) => ({
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 1, mint, owner: ADDRESS, uiTokenAmount: { amount: '1000', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: ADDRESS, uiTokenAmount: { amount: String(1000n + BigInt(paidUnits)), decimals: 6 } }],
    },
    transaction: { message: { accountKeys: [] } },
  })
  const rpc = (txs: Record<string, unknown>): Rpc & { asked: string[] } => {
    const asked: string[] = []
    const call = async (method: string, params: unknown[]) => {
      asked.push(`${method} ${String(params[0])}`)
      if (method === 'getSignaturesForAddress') return Object.keys(txs).map((signature) => ({ signature, err: null }))
      return txs[params[0] as string] ?? null
    }
    return Object.assign(call, { asked })
  }
  const owed = { reference, address: ADDRESS, mint: MINT, amount: '1.5' }
  const enough = rpc({ sigA: tokens('1500000') })
  assert.equal(await paid(enough, owed), 'sigA')
  assert.deepEqual(enough.asked, [`getSignaturesForAddress ${reference}`, 'getTransaction sigA'])
  assert.equal(await paid(rpc({ sigA: tokens('1499999') }), owed), null, 'short by one unit')
  assert.equal(await paid(rpc({ sigA: tokens('1500000', ADDRESS) }), owed), null, 'another mint')
  assert.equal(await paid(rpc({ sigA: tokens('1500000', MINT, { InstructionError: [0, 'x'] }) }), owed), null, 'a failed transaction')
  assert.equal(await paid(rpc({ sigA: tokens('9'), sigB: tokens('2000000') }), owed), 'sigB', 'the one that pays')
  assert.equal(await paid(rpc({ sigA: tokens('1500000') }), { ...owed, amount: '1.0000001' }), null, 'more decimals than the mint has')
  const sol = rpc({ sigS: { meta: { err: null, preBalances: [5, 0], postBalances: [3, 2_000_000] }, transaction: { message: { accountKeys: ['Payer', ADDRESS] } } } })
  assert.equal(await paid(sol, { ...owed, mint: 'SOL', amount: '0.002' }), 'sigS', 'SOL, in lamports')
  await assert.rejects(paid(enough, { ...owed, reference: 'not-one' }))
})

test('the spent list: hold, land and free, of one or several together, kept across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-credits-spent-'))
  try {
    const path = join(dir, 'spent.sqlite')
    let list = new SpentList(path)
    assert.equal(list.hold('a', 'sig-a', 1), 'held')
    assert.equal(list.hold('a'), 'busy', 'held by another request in flight')
    assert.equal(list.hold('b', 'sig-b', 2), 'held')
    list.land('a')
    assert.equal(list.hold('a'), 'spent')
    list.free('a')
    assert.equal(list.hold('a'), 'spent', 'a spent credit stays spent')
    list.free('b')
    assert.equal(list.hold('b', 'sig-b2', 3), 'held', 'a freed credit can be shown again')
    list.close()
    list = new SpentList(path)
    assert.deepEqual(list.holds(), [{ id: 'b', note: 'sig-b2', at: 3 }], 'what is held, after a restart')
    assert.equal(list.hold('a'), 'spent')

    // Several together: all held, or none.
    assert.equal(list.hold(['c', 'd', 'a'], null, 4), 'spent', 'one of them spent')
    assert.equal(list.hold(['c', 'd', 'b'], null, 4), 'busy', 'one of them held by another request')
    assert.deepEqual(list.holds().map((h) => h.id), ['b'], 'and neither took c or d')
    assert.throws(() => list.hold(['c', 'c']), /each once/)
    assert.throws(() => list.hold([]), /one id or more/)
    assert.equal(list.hold(['c', 'd', 'e'], 'n', 5), 'held')
    list.land(['c', 'd'])
    list.free(['e', 'c'])
    assert.deepEqual([list.hold('c'), list.hold('d'), list.hold('e')], ['spent', 'spent', 'held'], 'landed together, freed together; a spent one stays spent')
    list.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

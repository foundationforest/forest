// What the client computes, checked against the proofs the program accepted.
//
// These need no chain and no artifacts: they run against the committed fixtures, which the
// LiteSVM tests then run against the real program. If either side drifted, one of the two fails.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Identity } from '@semaphore-protocol/identity'
import { Keypair, PublicKey } from '@solana/web3.js'

import {
  BN254_R,
  MESSAGE_NS,
  PROGRAM_ID,
  SCOPE_NS,
  TREASURY,
  TREASURY_PLACEHOLDER_SEED,
  USDC_MINT,
  USDC_MINT_DEVNET,
  registrationFee,
  codeBytesFor,
  codeFor,
  commitmentOf,
  acceptTreasuryIx,
  decodeConfig,
  decodeRegisteredEvents,
  discriminator,
  proposeTreasuryIx,
  fromBytes32,
  isFieldElement,
  messageOf,
  registerIx,
  scopeOf,
  toBytes32,
  usedCodeAddress,
  compressG1,
  compressG2,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, '../../program/tests-litesvm/fixtures/proofs.json'), 'utf8'),
)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

test('the namespaces are the ones the program hashes with', () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  assert.ok(lib.includes(`b"${SCOPE_NS}"`), 'the scope namespace must match the program')
  assert.ok(lib.includes(`b"${MESSAGE_NS}"`), 'the message namespace must match the program')
})

test('the treasury and USDC constants are the ones the program bakes in', () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  assert.ok(lib.includes(`pubkey!("${TREASURY.toBase58()}")`), 'the treasury must match the program')
  assert.ok(lib.includes(`pubkey!("${USDC_MINT.toBase58()}")`), 'mainnet USDC must match the program')
  assert.ok(lib.includes(`pubkey!("${USDC_MINT_DEVNET.toBase58()}")`), 'devnet USDC must match the program')
  // The placeholder is derived from a public seed so tests can sign for it. That is also why it
  // must be replaced before the first deploy: anyone can.
  assert.equal(Keypair.fromSeed(TREASURY_PLACEHOLDER_SEED).publicKey.toBase58(), TREASURY.toBase58())
})

test('0.25 is 25 × 10^(decimals − 2) in whatever units a mint counts in', () => {
  assert.equal(registrationFee(6), 250_000n)
  assert.equal(registrationFee(8), 25_000_000n)
  assert.equal(registrationFee(2), 25n)
  assert.equal(registrationFee(19), 2_500_000_000_000_000_000n)
  for (const bad of [0, 1, 20, 255, 6.5]) assert.throws(() => registrationFee(bad), RangeError, `${bad}`)
})

test('the scope and the message are what the accepted proofs carry', () => {
  for (const p of fixtures.proofs) {
    assert.equal(hex(toBytes32(scopeOf(p.market))), p.scope, `${p.name}: scope`)
    assert.equal(hex(toBytes32(messageOf(p.did))), p.message, `${p.name}: message`)
  }
})

test('a market name of any length gives a scope, and every scope is a field element', () => {
  const names = ['a', 'online-tutors', 'x'.repeat(31), 'x'.repeat(64), 'a name with spaces and ünïcode']
  const seen = new Set<string>()
  for (const name of names) {
    const scope = scopeOf(name)
    assert.ok(isFieldElement(scope), `${name}: below the scalar order`)
    assert.ok(scope < BN254_R >> 1n, 'the shift by a byte leaves the top byte clear')
    seen.add(scope.toString())
  }
  assert.equal(seen.size, names.length, 'different names, different scopes')
})

test('a scope and a message from the same text never collide', () => {
  assert.notEqual(scopeOf('online-tutors'), messageOf('online-tutors'))
})

test('the code is the nullifier the proof carries', () => {
  const alice = new Identity(
    Buffer.from('54684ed3bd15671b1a07bd8ed840a049c60ce847afd7d8da73b4f71cc6884d85', 'hex'),
  )
  // The commitment pinned in keys/test/vectors.json: the whole chain from the keys recipe.
  assert.equal(
    commitmentOf(alice).toString(),
    '14568690134484466610252976219100933485694269593799802854234702390895629808185',
  )
  for (const p of fixtures.proofs.filter((q: { name: string }) => q.name.startsWith('alice-'))) {
    assert.equal(hex(codeBytesFor(alice, p.market)), p.code, `${p.name}: code`)
  }
  // The same human in two markets gets two codes, and nothing on the chain links them.
  assert.notEqual(codeFor(alice, 'online-tutors'), codeFor(alice, 'house-cleaning'))
})

test('the code account address is a hash of the code and nothing else', () => {
  for (const p of fixtures.proofs) {
    const fromHex = usedCodeAddress(Buffer.from(p.code, 'hex'))
    const fromBig = usedCodeAddress(fromBytes32(new Uint8Array(Buffer.from(p.code, 'hex'))))
    assert.equal(fromHex.toBase58(), fromBig.toBase58())
  }
})

test('the compressed points are the ones the program decompressed', () => {
  for (const p of fixtures.proofs) {
    const a = Buffer.from(p.uncompressed.a, 'hex')
    const c = Buffer.from(p.uncompressed.c, 'hex')
    const b = Buffer.from(p.uncompressed.b, 'hex')
    const big = (buf: Buffer, at: number) => fromBytes32(new Uint8Array(buf.subarray(at, at + 32)))
    assert.equal(hex(compressG1(big(a, 0), big(a, 32))), p.a, `${p.name}: A`)
    assert.equal(hex(compressG1(big(c, 0), big(c, 32))), p.c, `${p.name}: C`)
    // The uncompressed G2 is x1, x0, y1, y0: the imaginary part first.
    assert.equal(hex(compressG2(big(b, 32), big(b, 0), big(b, 96), big(b, 64))), p.b, `${p.name}: B`)
  }
})

test("Anchor's discriminators are what the program answers to", () => {
  // Pinned, because a discriminator is part of the sealed wire format: renaming an instruction
  // changes the bytes every client sends. The Rust tests recompute the same eight bytes from the
  // same names, so a rename fails on both sides at once.
  const pinned: Record<string, string> = {
    'global:init': 'dc3bcfec6cfa2f64',
    'global:propose_treasury': 'ebf0de226a4289ec',
    'global:accept_treasury': 'c491518bb10dc52b',
    'global:open_list': '4f185028f28430d6',
    'global:add_issuer': 'fc6103dd41a2b120',
    'global:remove_issuer': '004b58e1049fa777',
    'global:insert_identity': '8167c6e9eb409eff',
    'global:register': 'd37c430fd3c2b2f0',
    'global:add_token': 'edff1a3638304434',
    'global:sweep_rent': '11ea3af1fb9487b9',
    'account:UsedCode': 'bf1f2dadd1e22d84',
    'event:Registered': '0bde0a48a06ea5e3',
  }
  for (const [name, want] of Object.entries(pinned)) {
    const [namespace, what] = name.split(':')
    assert.equal(hex(discriminator(namespace, what)), want, name)
  }
})

test('a handover is two instructions, and the pending slot decodes back out of the config', () => {
  const treasury = PublicKey.unique()
  const next = PublicKey.unique()
  // Propose: discriminator, then borsh's Option<Pubkey>: 0x01 and the key, or 0x00 alone.
  const propose = proposeTreasuryIx({ treasury, newTreasury: next })
  assert.equal(propose.data.length, 8 + 1 + 32)
  assert.equal(propose.data[8], 1)
  assert.deepEqual(new Uint8Array(propose.data.subarray(9)), next.toBytes())
  assert.ok(propose.keys[1].isSigner && propose.keys[1].pubkey.equals(treasury), 'the current treasury signs')
  const clear = proposeTreasuryIx({ treasury, newTreasury: null })
  assert.equal(clear.data.length, 9)
  assert.equal(clear.data[8], 0)
  // Accept: the pending key signs, and nothing else travels.
  const accept = acceptTreasuryIx({ pending: next })
  assert.equal(accept.data.length, 8)
  assert.ok(accept.keys[1].isSigner && accept.keys[1].pubkey.equals(next), 'the pending key signs')

  // A config with one mint, one list, and a pending key at 566..598, laid out by hand.
  const b = new Uint8Array(8 + 598)
  b.set(treasury.toBytes(), 8)
  b.set(USDC_MINT.toBytes(), 8 + 32)
  b[8 + 544] = 6
  b[8 + 560] = 1
  b[8 + 561] = 1
  b[8 + 565] = 255
  b.set(next.toBytes(), 8 + 566)
  const config = decodeConfig(b)
  assert.equal(config.treasury.toBase58(), treasury.toBase58())
  assert.deepEqual(config.mints.map((m) => m.toBase58()), [USDC_MINT.toBase58()])
  assert.deepEqual(config.decimals, [6])
  assert.equal(config.listCount, 1)
  assert.equal(config.bump, 255)
  assert.equal(config.pendingTreasury?.toBase58(), next.toBase58())
  b.fill(0, 8 + 566)
  assert.equal(decodeConfig(b).pendingTreasury, null, 'the zero key means nothing is pending')
})

test('a registration instruction is the bytes the program reads', () => {
  const p = fixtures.proofs[0]
  const key = () => PublicKey.unique()
  const ix = registerIx({
    market: p.market,
    did: p.did,
    listIndex: p.listIndex,
    root: Buffer.from(p.root, 'hex'),
    code: Buffer.from(p.code, 'hex'),
    proof: {
      a: new Uint8Array(Buffer.from(p.a, 'hex')),
      b: new Uint8Array(Buffer.from(p.b, 'hex')),
      c: new Uint8Array(Buffer.from(p.c, 'hex')),
    },
    accounts: { payer: key(), profileWallet: key(), profileTokens: key(), treasuryTokens: key() },
  })
  // 8 discriminator + (4 + 13) market + (4 + 32) DID + 4 list index + 32 root + 32 code + 128 proof
  assert.equal(ix.data.length, 8 + 4 + p.market.length + 4 + p.did.length + 4 + 32 + 32 + 128)
  assert.equal(ix.keys.length, 10)
  assert.equal(ix.keys[3].pubkey.toBase58(), usedCodeAddress(Buffer.from(p.code, 'hex')).toBase58())
  assert.ok(ix.keys[4].isSigner && ix.keys[5].isSigner, 'the payer and the profile wallet both sign')
})

test('an entry decodes back out of a log line', () => {
  const disc = discriminator('event', 'Registered')
  const market = 'online-tutors'
  const did = 'did:plc:wece24yzukt4pj6hqvmb2fn4'
  const enc = new TextEncoder()
  const parts = [
    disc,
    new Uint8Array(new Uint32Array([market.length]).buffer),
    enc.encode(market),
    new Uint8Array(new Uint32Array([did.length]).buffer),
    enc.encode(did),
    new Uint8Array(Buffer.from(fixtures.proofs[0].code, 'hex')),
    new Uint8Array(new Uint32Array([7]).buffer),
  ]
  const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)))
  const id = PROGRAM_ID.toBase58()
  const line = `Program data: ${bytes.toString('base64')}`
  const [event] = decodeRegisteredEvents([`Program ${id} invoke [1]`, line, `Program ${id} success`])
  assert.equal(event.market, market)
  assert.equal(event.did, did)
  assert.equal(event.listIndex, 7)
  assert.equal(hex(event.code), fixtures.proofs[0].code)

  // Any program can write those same bytes. An index that took them would badge any DID it was
  // shown, with a real code copied from a real registration. Only the registry's own lines count.
  const forger = 'Forger1111111111111111111111111111111111111'
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  assert.deepEqual(decodeRegisteredEvents([line]), [])
  assert.deepEqual(decodeRegisteredEvents([`Program ${forger} invoke [1]`, line, `Program ${forger} success`]), [])
  assert.deepEqual(decodeRegisteredEvents([`Program ${id} invoke [1]`, `Program ${token} invoke [2]`, line, `Program ${token} success`, `Program ${id} success`]), [])
  assert.deepEqual(decodeRegisteredEvents([`Program ${id} invoke [1]`, `Program ${id} success`, `Program ${forger} invoke [1]`, line, `Program ${forger} failed: custom program error: 0x1`]), [])
  assert.equal(decodeRegisteredEvents([`Program ${forger} invoke [1]`, `Program ${id} invoke [2]`, line, `Program ${id} success`, `Program ${forger} success`]).length, 1)
})

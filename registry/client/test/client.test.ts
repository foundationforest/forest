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
import { PublicKey } from '@solana/web3.js'

import {
  BN254_R,
  MESSAGE_NS,
  SCOPE_NS,
  codeBytesFor,
  codeFor,
  commitmentOf,
  decodeRegisteredEvents,
  discriminator,
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
  const [event] = decodeRegisteredEvents([`Program data: ${bytes.toString('base64')}`])
  assert.equal(event.market, market)
  assert.equal(event.did, did)
  assert.equal(event.listIndex, 7)
  assert.equal(hex(event.code), fixtures.proofs[0].code)
})

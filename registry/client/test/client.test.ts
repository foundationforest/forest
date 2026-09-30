// What the client computes, checked against the proofs the program accepted and the wire vectors
// the program wrote.
//
// These need no chain and no artifacts: they run against the committed fixtures, which the
// LiteSVM tests then run against the real program. If either side drifted, one of the two fails.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'

import {
  BN254_R,
  CODE_SEED,
  LINE_DISCRIMINATOR,
  MAX_LABEL,
  MAX_ROOTS,
  MESSAGE_NS,
  PROGRAM_ID,
  SCOPE_NS,
  addProofIx,
  buildRegistration,
  codeBytesFor,
  codeFor,
  compressG1,
  compressG2,
  decodeLine,
  discriminator,
  fetchLine,
  fetchLines,
  fromBytes32,
  isFieldElement,
  lineAddress,
  lineSpace,
  messageOf,
  refundIx,
  registerIx,
  scopeOf,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '../../program/tests-litesvm/fixtures/proofs.json'), 'utf8'))
const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))
const proofNamed = (name: string) => fixtures.proofs.find((p: { name: string }) => p.name === name)
const onWire = (p: { root: string; a: string; b: string; c: string }) => ({
  root: bytes(p.root),
  proof: { a: bytes(p.a), b: bytes(p.b), c: bytes(p.c) },
})

test('the namespaces, the program id, the seed and the limits are the program\'s own', () => {
  assert.ok(lib.includes(`b"${SCOPE_NS}"`), 'the scope namespace must match the program')
  assert.ok(lib.includes(`b"${MESSAGE_NS}"`), 'the message namespace must match the program')
  assert.equal(SCOPE_NS, 'forest.foundation/label/v1/')
  assert.ok(lib.includes(`declare_id!("${PROGRAM_ID.toBase58()}")`), 'the program id')
  assert.ok(lib.includes(`pub const CODE_SEED: &[u8] = b"${new TextDecoder().decode(CODE_SEED)}";`), 'the seed')
  assert.ok(lib.includes(`pub const MAX_LABEL: usize = ${MAX_LABEL};`), 'the longest label')
  assert.ok(lib.includes(`pub const MAX_ROOTS: usize = ${MAX_ROOTS};`), 'the most roots')
  assert.equal(fixtures.scopeNamespace, SCOPE_NS)
  assert.equal(fixtures.messageNamespace, MESSAGE_NS)
})

test('the scope and the message are what the accepted proofs carry', () => {
  for (const p of fixtures.proofs) {
    assert.equal(hex(toBytes32(scopeOf(p.label))), p.scope, `${p.name}: scope`)
    assert.equal(hex(toBytes32(messageOf(new PublicKey(p.profile)))), p.message, `${p.name}: message`)
  }
})

test('the message names the profile key and nothing else', () => {
  const alice = proofNamed('alice-tutoring-A')
  const key = new PublicKey(alice.profile)
  assert.equal(messageOf(key), messageOf(key.toBytes()), 'a key or its bytes')
  assert.notEqual(messageOf(key), messageOf(Keypair.generate().publicKey), 'another key, another message')
  assert.throws(() => messageOf(new Uint8Array(31)), /32 bytes/)
  assert.throws(() => messageOf(new Uint8Array(33)), /32 bytes/)
  // Alice's profile is the keys recipe's profile 0: its did:key name and its wallet are one key.
  assert.equal(key.toBase58(), keysVectors.profiles[0].wallet)
})

test('a label of any text gives a scope, every scope is a field element, and namespaces never collide', () => {
  for (const label of ['', 'a', 'tutoring/seller', 'x'.repeat(128), 'ünïcødé/ラベル']) {
    const s = scopeOf(label)
    assert.ok(isFieldElement(s) && s < BN254_R, label)
  }
  const key = new Uint8Array(32).fill(7)
  assert.notEqual(scopeOf(new TextDecoder().decode(key)), messageOf(key))
})

test('the code is the nullifier the proof carries', () => {
  const secret = Buffer.from(keysVectors.identity.secret, 'hex')
  for (const name of ['alice-tutoring-A', 'alice-tutoring-B', 'alice-cleaning-A', 'alice-longest-A']) {
    const p = proofNamed(name)
    assert.equal(hex(codeBytesFor(secret, p.label)), p.code, name)
  }
  assert.equal(proofNamed('alice-tutoring-A').code, proofNamed('alice-tutoring-B').code, 'one human, one label, two lists: one code')
  assert.notEqual(proofNamed('alice-tutoring-A').code, proofNamed('alice-cleaning-A').code, 'another label, another code')
  assert.equal(codeFor(secret, 'tutoring/seller'), fromBytes32(bytes(proofNamed('alice-tutoring-A').code)))
})

test('a line\'s address is a hash of its code and nothing else', () => {
  const code = bytes(proofNamed('alice-tutoring-A').code)
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('code'), Buffer.from(code)], PROGRAM_ID)
  assert.equal(lineAddress(code).toBase58(), expected.toBase58())
  assert.equal(lineAddress(fromBytes32(code)).toBase58(), expected.toBase58(), 'a code as bytes or as a number')
  assert.equal(lineAddress(code).toBase58(), fixtures.wire.lineAddress)
})

test('the compressed points are the ones the program decompressed', () => {
  for (const p of fixtures.proofs) {
    const u = p.uncompressed
    const n = (h: string, i: number) => fromBytes32(bytes(h.slice(i * 64, i * 64 + 64)))
    assert.equal(hex(compressG1(n(u.a, 0), n(u.a, 1))), p.a, `${p.name}: A`)
    // G2 arrives as x.c1, x.c0, y.c1, y.c0.
    assert.equal(hex(compressG2(n(u.b, 1), n(u.b, 0), n(u.b, 3), n(u.b, 2))), p.b, `${p.name}: B`)
    assert.equal(hex(compressG1(n(u.c, 0), n(u.c, 1))), p.c, `${p.name}: C`)
  }
})

test('the wire format written twice still matches', () => {
  // The client's bytes, from its own builders, against the vectors the Rust harness checks against
  // its own hand-written bytes and against the line the program actually writes.
  const w = fixtures.wire
  const a = proofNamed('alice-tutoring-A')
  const b = proofNamed('alice-tutoring-B')
  const payer = new PublicKey(w.payer)
  const code = bytes(a.code)
  assert.equal(PROGRAM_ID.toBase58(), w.programId)

  const register = registerIx({ profile: new PublicKey(a.profile), label: a.label, code, proof: onWire(a), payer })
  const add = addProofIx({ code, proof: onWire(b), payer })
  const refund = refundIx({ code, payer })
  assert.equal(hex(register.data), w.register, 'register')
  assert.equal(hex(add.data), w.addProof, 'add_proof')
  assert.equal(hex(refund.data), w.refund, 'refund')
  assert.deepEqual([...register.data.subarray(0, 8)], [...discriminator('global', 'register')])
  assert.equal(register.data.length, 8 + 32 + 4 + a.label.length + 32 + 160)
  assert.equal(add.data.length, 8 + 32 + 160)

  // Accounts: the line, the payer (the one signer), the system program; refund signs nothing.
  const line = lineAddress(code)
  for (const ix of [register, add]) {
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [line.toBase58(), false, true],
        [payer.toBase58(), true, true],
        [SystemProgram.programId.toBase58(), false, false],
      ],
    )
  }
  assert.deepEqual(refund.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [line.toBase58(), false, true],
    [payer.toBase58(), false, true],
  ])

  // The line the program wrote, decoded.
  const decoded = decodeLine(bytes(w.line))
  assert.equal(decoded.profile.toBase58(), a.profile)
  assert.equal(hex(decoded.code), a.code)
  assert.equal(decoded.payer.toBase58(), w.payer)
  assert.equal(decoded.time, BigInt(w.time))
  assert.equal(decoded.bump, PublicKey.findProgramAddressSync([Buffer.from('code'), Buffer.from(code)], PROGRAM_ID)[1])
  assert.equal(decoded.label, a.label)
  assert.deepEqual(decoded.roots.map(hex), [a.root, b.root])
  assert.equal(bytes(w.line).length, lineSpace(a.label.length, 2))
  assert.deepEqual([...bytes(w.line).subarray(0, 8)], [...LINE_DISCRIMINATOR])
})

test('decodeLine refuses anything that is not exactly a line', () => {
  const good = bytes(fixtures.wire.line)
  assert.throws(() => decodeLine(good.subarray(0, good.length - 1)), /not a line/, 'one byte short')
  assert.throws(() => decodeLine(new Uint8Array([...good, 0])), /not a line/, 'one byte extra')
  const wrong = good.slice()
  wrong[0] ^= 1
  assert.throws(() => decodeLine(wrong), /not a line/, 'another discriminator')
  const longLabel = good.slice()
  new DataView(longLabel.buffer).setUint32(113, MAX_LABEL + 1, true)
  assert.throws(() => decodeLine(longLabel), /not a line/, 'a label over 128 bytes')
})

test('the builders refuse what the program would refuse, before any proof is made', async () => {
  const a = proofNamed('alice-tutoring-A')
  const payer = Keypair.generate().publicKey
  assert.throws(
    () => registerIx({ profile: new PublicKey(a.profile), label: 'x'.repeat(MAX_LABEL + 1), code: bytes(a.code), proof: onWire(a), payer }),
    /at most 128 bytes/,
  )
  assert.throws(() => registerIx({ profile: new Uint8Array(31), label: '', code: bytes(a.code), proof: onWire(a), payer }), /32 bytes/)
  const base = { secret: new Uint8Array(32), label: 'tutoring/seller', profile: payer, artifacts: { wasm: '', zkey: '' }, payer, recentBlockhash: PublicKey.default.toBase58() }
  await assert.rejects(buildRegistration({ ...base, lists: [] }), /at least one list/)
  await assert.rejects(buildRegistration({ ...base, lists: Array.from({ length: MAX_ROOTS + 1 }, () => [1n]) }), /at most 16 roots/)
  await assert.rejects(buildRegistration({ ...base, label: 'x'.repeat(129), lists: [[1n]] }), /at most 128 bytes/)
  await assert.rejects(buildRegistration({ ...base, lists: [[1n, 2n]] }), /not in the list/)
})

test('lines read back through any connection, each checked to sit at its own code\'s address', async () => {
  const w = fixtures.wire
  const data = Buffer.from(w.line, 'hex')
  const address = new PublicKey(w.lineAddress)
  const seen: unknown[] = []
  const connection = {
    async getProgramAccounts(programId: PublicKey, config: unknown) {
      seen.push([programId.toBase58(), config])
      return [{ pubkey: address, account: { data, owner: PROGRAM_ID, lamports: 1, executable: false } }]
    },
    async getAccountInfo(at: PublicKey) {
      return at.equals(address) ? { data, owner: PROGRAM_ID, lamports: 1, executable: false } : null
    },
  }
  const profile = new PublicKey(proofNamed('alice-tutoring-A').profile)
  const lines = await fetchLines(connection as never, { profile })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].line.label, 'tutoring/seller')
  const [[programId, config]] = seen as [[string, { filters: { memcmp: { offset: number; bytes: string } }[] }]]
  assert.equal(programId, PROGRAM_ID.toBase58())
  assert.deepEqual(config.filters.map((f) => f.memcmp.offset), [0, 8], 'the discriminator, then the profile at offset 8')
  assert.equal(config.filters[1].memcmp.bytes, profile.toBase58())
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const decoded = [...config.filters[0].memcmp.bytes].reduce((n, ch) => n * 58n + BigInt(ALPHABET.indexOf(ch)), 0n)
  assert.equal(decoded, fromBytes32(new Uint8Array([...new Uint8Array(24), ...LINE_DISCRIMINATOR])), 'the discriminator in base58')

  assert.equal((await fetchLine(connection as never, bytes(proofNamed('alice-tutoring-A').code)))?.label, 'tutoring/seller')
  assert.equal(await fetchLine(connection as never, bytes(proofNamed('bob-tutoring-A').code)), null, 'no line')

  const moved = { ...connection, getProgramAccounts: async () => [{ pubkey: Keypair.generate().publicKey, account: { data, owner: PROGRAM_ID, lamports: 1, executable: false } }] }
  await assert.rejects(fetchLines(moved as never), /not at its code's address/)
  const foreign = { getAccountInfo: async () => ({ data, owner: Keypair.generate().publicKey, lamports: 1, executable: false }) }
  await assert.rejects(fetchLine(foreign as never, bytes(proofNamed('alice-tutoring-A').code)), /not the registry's/)
})

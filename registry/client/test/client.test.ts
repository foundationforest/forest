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
  MESSAGE_NS,
  PROGRAM_ID,
  SCOPE_NS,
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
  verifyMembership,
  type Membership,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '../../program/tests-litesvm/fixtures/proofs.json'), 'utf8'))
const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
const person = JSON.parse(readFileSync(join(here, 'person.json'), 'utf8'))
const verificationKey = JSON.parse(readFileSync(join(here, '../../artifacts/semaphore-32.json'), 'utf8'))
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
  assert.ok(!lib.includes('add_proof') && !lib.includes('realloc'), 'a line is written once: no instruction grows it')
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
  // Alice is the test person: test/person.json's profile.
  assert.equal(key.toBase58(), person.profile)
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
  const secret = Buffer.from(person.secret, 'hex')
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
  const payer = new PublicKey(w.payer)
  const code = bytes(a.code)
  assert.equal(PROGRAM_ID.toBase58(), w.programId)

  const register = registerIx({ profile: new PublicKey(a.profile), label: a.label, code, proof: onWire(a), payer })
  const refund = refundIx({ code, payer })
  assert.equal(hex(register.data), w.register, 'register')
  assert.equal(hex(refund.data), w.refund, 'refund')
  assert.deepEqual([...register.data.subarray(0, 8)], [...discriminator('global', 'register')])
  assert.equal(register.data.length, 8 + 32 + 4 + a.label.length + 32 + 160)

  // Accounts: the line, the payer (the one signer), the system program; refund signs nothing.
  const line = lineAddress(code)
  assert.deepEqual(
    register.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [line.toBase58(), false, true],
      [payer.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  )
  assert.deepEqual(refund.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [line.toBase58(), false, true],
    [payer.toBase58(), false, true],
  ])

  // The line the program wrote, decoded: every fixed field at its fixed offset, the label last.
  const decoded = decodeLine(bytes(w.line))
  assert.equal(decoded.profile.toBase58(), a.profile)
  assert.equal(hex(decoded.code), a.code)
  assert.equal(decoded.payer.toBase58(), w.payer)
  assert.equal(decoded.time, BigInt(w.time))
  assert.equal(decoded.bump, PublicKey.findProgramAddressSync([Buffer.from('code'), Buffer.from(code)], PROGRAM_ID)[1])
  assert.equal(hex(decoded.root), a.root)
  assert.equal(hex(bytes(w.line).subarray(113, 145)), a.root, 'the root at offset 113')
  assert.equal(decoded.label, a.label)
  assert.equal(bytes(w.line).length, lineSpace(a.label.length))
  assert.equal(lineSpace(a.label.length), 164, 'a 15-byte label: 164 bytes, forever')
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
  new DataView(longLabel.buffer).setUint32(145, MAX_LABEL + 1, true)
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
  await assert.rejects(buildRegistration({ ...base, label: 'x'.repeat(129), commitments: [1n] }), /at most 128 bytes/)
  await assert.rejects(buildRegistration({ ...base, commitments: [1n, 2n] }), /not in the list/)
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

test('a membership record verifies against its line and the roots its issuer published', async () => {
  // The record scripts/fixtures.ts made with makeMembership: Alice on issuer B's list, for the line
  // the wire vectors describe (her tutoring/seller line, registered against list A).
  const record: Membership = fixtures.membership.body
  const line = decodeLine(bytes(fixtures.wire.line))
  const profile = new PublicKey(proofNamed('alice-tutoring-A').profile)
  const rootB = bytes(proofNamed('alice-tutoring-B').root)
  const issuer = { key: record.issuer, roots: [bytes(proofNamed('alice-tutoring-A').root), rootB] }
  const check = (r: Membership, over: Partial<Parameters<typeof verifyMembership>[1]> = {}) =>
    verifyMembership(r, { profile, line, issuer, verificationKey, ...over })

  assert.equal(record.membership.code, hex(line.code), 'the line\'s code')
  assert.equal(record.membership.root, hex(rootB), 'issuer B\'s root, not the line\'s')
  assert.notEqual(record.membership.root, hex(line.root))
  assert.equal(await check(record), true)
  assert.equal(await check(record, { profile: profile.toBytes(), issuer: { key: issuer.key, roots: [fromBytes32(rootB)] } }), true, 'a key or its bytes, a root or its number')

  // Each of these changes one thing, and each is refused.
  const edited = (f: (m: Membership) => void): Membership => {
    const copy = structuredClone(record)
    f(copy)
    return copy
  }
  const bob = proofNamed('bob-tutoring-A')
  const otherLine = { ...line, code: bytes(bob.code) }
  const cases: [string, Promise<boolean>][] = [
    ['another issuer named', check(edited((m) => (m.issuer = 'did:key:z6MkpSx7aRn6kR1oSMgun7YdDD3ZXPepph8UcWYp1Jp4vhJL')))],
    ['a root the issuer never published', check(record, { issuer: { key: issuer.key, roots: [bytes(proofNamed('alice-tutoring-A').root)] } })],
    ['another profile', check(record, { profile: new PublicKey(bob.profile) })],
    ['the line of another profile', check(record, { line: { ...line, profile: new PublicKey(bob.profile) } })],
    ['another label', check(edited((m) => (m.membership.label = 'cleaning/seller')))],
    ['a line with another label', check(record, { line: { ...line, label: 'cleaning/seller' } })],
    ['a line with another code', check(record, { line: otherLine })],
    ['another code', check(edited((m) => (m.membership.code = bob.code)), { line: otherLine })],
    ['another root, published', check(edited((m) => (m.membership.root = proofNamed('alice-tutoring-A').root)))],
    ['a coordinate changed', check(edited((m) => (m.membership.proof[7] = m.membership.proof[7].replace(/.$/, (c) => (c === '0' ? '1' : '0')))))],
    ['two coordinates swapped', check(edited((m) => ([m.membership.proof[2], m.membership.proof[3]] = [m.membership.proof[3], m.membership.proof[2]])))],
    ['a coordinate plus the modulus', check(edited((m) => (m.membership.proof[0] = hex(toBytes32(BigInt(`0x${m.membership.proof[0]}`) + 21888242871839275222246405745257275088696311157297823662689037894645226208583n)))))],
    ['seven coordinates', check(edited((m) => m.membership.proof.pop()))],
    ['upper-case hex', check(edited((m) => (m.membership.code = m.membership.code.toUpperCase())))],
    ['no membership at all', check({ issuer: record.issuer, createdAt: record.createdAt } as never)],
  ]
  for (const [what, result] of cases) assert.equal(await result, false, what)
})

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

import { listIdentity, listSecret } from '../../../keys/src/index.ts'
import {
  BN254_R,
  MAX_LABEL,
  MESSAGE_NS,
  PROGRAM_ID,
  ROW_DISCRIMINATOR,
  ROW_OFFSET,
  ROW_SEED,
  SCOPE_NS,
  base58,
  buildRegistration,
  compressG1,
  compressG2,
  decodeRow,
  discriminator,
  fetchRow,
  fetchRows,
  fromBytes32,
  isFieldElement,
  keeperSigned,
  listRoot,
  marketStampBytesOf,
  marketStampOf,
  messageOf,
  refundIx,
  registerIx,
  rootBytes,
  rowAddress,
  rowSpace,
  scopeOf,
  stampOf,
  toBytes32,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '../../program/tests-litesvm/fixtures/proofs.json'), 'utf8'))
const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(keysVectors.seed, 'hex')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))
const proofNamed = (name: string) => fixtures.proofs.find((p: { name: string }) => p.name === name)
const argsOf = (p: Record<string, string>, payer: PublicKey) => ({
  profile: new PublicKey(p.profile),
  label: p.label,
  marketStamp: bytes(p.marketStamp),
  keeper: new PublicKey(p.keeper),
  root: bytes(p.root),
  keeperSignature: bytes(p.keeperSignature),
  proof: { a: bytes(p.a), b: bytes(p.b), c: bytes(p.c) },
  payer,
})

test("the namespaces, the program id, the seed and the limits are the program's own", () => {
  assert.ok(lib.includes(`b"${SCOPE_NS}"`), 'the scope namespace must match the program')
  assert.ok(lib.includes(`b"${MESSAGE_NS}"`), 'the message namespace must match the program')
  assert.equal(SCOPE_NS, 'forest.foundation/label/v1/')
  assert.ok(lib.includes(`declare_id!("${PROGRAM_ID.toBase58()}")`), 'the program id')
  assert.ok(lib.includes(`pub const ROW_SEED: &[u8] = b"${new TextDecoder().decode(ROW_SEED)}";`), 'the seed')
  assert.ok(lib.includes(`pub const MAX_LABEL: usize = ${MAX_LABEL};`), 'the longest label')
  assert.ok(!lib.includes('realloc') && !lib.includes('close ='), 'a row is written once: nothing grows or closes it')
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
  const key = new PublicKey(proofNamed('alice-tutoring-A').profile)
  assert.equal(messageOf(key), messageOf(key.toBytes()), 'a key or its bytes')
  assert.notEqual(messageOf(key), messageOf(Keypair.generate().publicKey), 'another key, another message')
  assert.throws(() => messageOf(new Uint8Array(31)), /32 bytes/)
  assert.throws(() => messageOf(new Uint8Array(33)), /32 bytes/)
})

test('a label of any text gives a scope, every scope is a field element, and namespaces never collide', () => {
  for (const label of ['', 'a', 'tutoring/seller', 'x'.repeat(128), 'ünïcødé/ラベル']) {
    const s = scopeOf(label)
    assert.ok(isFieldElement(s) && s < BN254_R, label)
  }
  const key = new Uint8Array(32).fill(7)
  assert.notEqual(scopeOf(new TextDecoder().decode(key)), messageOf(key))
})

test("Alice's stamps come from keys/: her seed and each keeper's address", async () => {
  for (const list of ['A', 'B'] as const) {
    const keeper = fixtures.keepers[list]
    const { stamp } = await listIdentity(seed, keeper)
    assert.equal(stampOf(await listSecret(seed, keeper)), stamp)
    assert.ok(fixtures.lists[list].includes(stamp.toString()), `her stamp is on list ${list}`)
    assert.equal(hex(toBytes32(listRoot(fixtures.lists[list].map(BigInt)))), fixtures.proofs.find((p: { list: string }) => p.list === list).root)
  }
  const a = await listIdentity(seed, fixtures.keepers.A)
  const b = await listIdentity(seed, fixtures.keepers.B)
  assert.notEqual(a.stamp, b.stamp, 'two lists, two stamps nobody can match')
})

test('the market stamp is the nullifier the proof carries: one per keeper per label per person', async () => {
  const onA = await listSecret(seed, fixtures.keepers.A)
  const onB = await listSecret(seed, fixtures.keepers.B)
  for (const [name, secret] of [
    ['alice-tutoring-A', onA],
    ['alice-tutoring-A-second-profile', onA],
    ['alice-tutoring-B', onB],
    ['alice-cleaning-A', onA],
    ['alice-longest-A', onA],
  ] as const) {
    const p = proofNamed(name)
    assert.equal(hex(marketStampBytesOf(secret, p.label)), p.marketStamp, name)
  }
  const stampOfCase = (name: string) => proofNamed(name).marketStamp
  assert.equal(stampOfCase('alice-tutoring-A'), stampOfCase('alice-tutoring-A-second-profile'), 'one list, one label, two profiles: one market stamp')
  assert.notEqual(stampOfCase('alice-tutoring-A'), stampOfCase('alice-tutoring-B'), 'another keeper, another market stamp')
  assert.notEqual(stampOfCase('alice-tutoring-A'), stampOfCase('alice-cleaning-A'), 'another label, another market stamp')
  assert.equal(marketStampOf(onA, 'tutoring/seller'), fromBytes32(bytes(stampOfCase('alice-tutoring-A'))))
})

test("a row's address is a hash of its market stamp and nothing else", () => {
  const stamp = bytes(proofNamed('alice-tutoring-A').marketStamp)
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('row'), Buffer.from(stamp)], PROGRAM_ID)
  assert.equal(rowAddress(stamp).toBase58(), expected.toBase58())
  assert.equal(rowAddress(fromBytes32(stamp)).toBase58(), expected.toBase58(), 'as bytes or as a number')
  assert.equal(rowAddress(stamp).toBase58(), fixtures.wire.rowAddress)
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
  // its own hand-written bytes and against the row the program actually writes.
  const w = fixtures.wire
  const a = proofNamed('alice-tutoring-A')
  const payer = new PublicKey(w.payer)
  assert.equal(PROGRAM_ID.toBase58(), w.programId)

  const register = registerIx(argsOf(a, payer))
  const row = rowAddress(bytes(a.marketStamp))
  const refund = refundIx({ row, payer })
  assert.equal(hex(register.data), w.register, 'register')
  assert.equal(hex(refund.data), w.refund, 'refund')
  assert.deepEqual([...register.data.subarray(0, 8)], [...discriminator('global', 'register')])
  assert.equal(register.data.length, 8 + 32 + 32 + 32 + 64 + 128 + 4 + a.label.length)

  // Accounts: the row, the profile (a signer), the payer (a signer), the system program; refund
  // signs nothing.
  assert.deepEqual(
    register.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [row.toBase58(), false, true],
      [a.profile, true, false],
      [payer.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  )
  assert.deepEqual(refund.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [row.toBase58(), false, true],
    [payer.toBase58(), false, true],
  ])

  // The row the program wrote, decoded: every fixed field at its fixed offset, the label last.
  const decoded = decodeRow(bytes(w.row))
  assert.equal(decoded.profile.toBase58(), a.profile)
  assert.equal(decoded.keeper.toBase58(), fixtures.keepers.A)
  assert.equal(hex(decoded.root), a.root)
  assert.equal(hex(decoded.keeperSignature), a.keeperSignature)
  assert.equal(decoded.payer.toBase58(), w.payer)
  assert.equal(decoded.bump, PublicKey.findProgramAddressSync([Buffer.from('row'), Buffer.from(bytes(a.marketStamp))], PROGRAM_ID)[1])
  assert.equal(decoded.label, a.label)
  assert.equal(bytes(w.row).length, rowSpace(a.label.length))
  assert.equal(rowSpace(a.label.length), 220, 'a 15-byte label: 220 bytes, forever')
  assert.deepEqual([...bytes(w.row).subarray(0, 8)], [...ROW_DISCRIMINATOR])
})

test('decodeRow refuses anything that is not exactly a row', () => {
  const good = bytes(fixtures.wire.row)
  assert.throws(() => decodeRow(good.subarray(0, good.length - 1)), /not a row/, 'one byte short')
  assert.throws(() => decodeRow(new Uint8Array([...good, 0])), /not a row/, 'one byte extra')
  const wrong = good.slice()
  wrong[0] ^= 1
  assert.throws(() => decodeRow(wrong), /not a row/, 'another discriminator')
  const longLabel = good.slice()
  new DataView(longLabel.buffer).setUint32(ROW_OFFSET.label, MAX_LABEL + 1, true)
  assert.throws(() => decodeRow(longLabel), /not a row/, 'a label over 128 bytes')
})

test("a keeper's signature is checked strictly, over the root's 32 big-endian bytes", () => {
  for (const p of fixtures.proofs) {
    assert.equal(keeperSigned({ keeper: new PublicKey(p.keeper), root: bytes(p.root), keeperSignature: bytes(p.keeperSignature) }), true, p.name)
  }
  const a = proofNamed('alice-tutoring-A')
  const b = proofNamed('alice-tutoring-B')
  const good = { keeper: new PublicKey(a.keeper), root: fromBytes32(bytes(a.root)), keeperSignature: bytes(a.keeperSignature) }
  assert.equal(keeperSigned(good), true, 'a root as a number')
  assert.equal(keeperSigned(decodeRow(bytes(fixtures.wire.row))), true, 'a row as it is read back')
  assert.deepEqual([...rootBytes(good.root)], [...bytes(a.root)])
  const flipped = good.keeperSignature.slice()
  flipped[10] ^= 1
  // The same signature with S + L, the group order: the same point, a second spelling.
  const L = 2n ** 252n + 27742317777372353535851937790883648493n
  const s = good.keeperSignature.slice(32).reverse().reduce((n, x) => (n << 8n) | BigInt(x), 0n) + L
  const malleable = good.keeperSignature.slice()
  for (let i = 0; i < 32; i++) malleable[32 + i] = Number((s >> BigInt(8 * i)) & 0xffn)
  const cases: [string, Parameters<typeof keeperSigned>[0]][] = [
    ['another keeper', { ...good, keeper: new PublicKey(b.keeper) }],
    ['another root', { ...good, root: bytes(b.root) }],
    ['a changed signature', { ...good, keeperSignature: flipped }],
    ['a signature plus the group order', { ...good, keeperSignature: malleable }],
    ['63 bytes', { ...good, keeperSignature: good.keeperSignature.subarray(1) }],
    ['all zeros', { ...good, keeperSignature: new Uint8Array(64) }],
    ['the zero keeper', { ...good, keeper: new Uint8Array(32) }],
  ]
  for (const [what, input] of cases) assert.equal(keeperSigned(input), false, what)
})

test('the builders refuse what the program or a reader would refuse, before any proof is made', async () => {
  const a = proofNamed('alice-tutoring-A')
  const payer = Keypair.generate().publicKey
  assert.throws(() => registerIx({ ...argsOf(a, payer), label: 'x'.repeat(MAX_LABEL + 1) }), /at most 128 bytes/)
  assert.throws(() => registerIx({ ...argsOf(a, payer), keeperSignature: new Uint8Array(63) }), /64 bytes/)
  assert.throws(() => registerIx({ ...argsOf(a, payer), keeper: new Uint8Array(31) }), /32 bytes/)
  assert.throws(() => registerIx({ ...argsOf(a, payer), proof: { a: new Uint8Array(32), b: new Uint8Array(32), c: new Uint8Array(32) } }), /32, 64 and 32/)

  const stamps = fixtures.lists.A.map(BigInt)
  const base = {
    secret: await listSecret(seed, fixtures.keepers.A),
    label: 'tutoring/seller',
    profile: payer,
    keeper: new PublicKey(fixtures.keepers.A),
    stamps,
    keeperSignature: bytes(a.keeperSignature),
    artifacts: { wasm: '', zkey: '' },
    payer,
    recentBlockhash: PublicKey.default.toBase58(),
  }
  await assert.rejects(buildRegistration({ ...base, label: 'x'.repeat(129) }), /at most 128 bytes/)
  await assert.rejects(buildRegistration({ ...base, keeper: new PublicKey(fixtures.keepers.B) }), /keeper's signature is not on this list's root/)
  await assert.rejects(buildRegistration({ ...base, stamps: [...stamps, 1n] }), /keeper's signature is not on this list's root/, 'another snapshot')
  await assert.rejects(buildRegistration({ ...base, secret: await listSecret(seed, fixtures.keepers.B) }), /not on the list/)
})

test('rows read back through any connection, filtered at fixed offsets', async () => {
  const w = fixtures.wire
  const data = Buffer.from(w.row, 'hex')
  const address = new PublicKey(w.rowAddress)
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
  const a = proofNamed('alice-tutoring-A')
  const profile = new PublicKey(a.profile)
  const keeper = new PublicKey(fixtures.keepers.A)
  const rows = await fetchRows(connection as never, { profile, keeper, label: 'tutoring/seller' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].row.label, 'tutoring/seller')
  assert.equal(rows[0].address.toBase58(), address.toBase58())
  const [[programId, config]] = seen as [[string, { filters: { memcmp: { offset: number; bytes: string } }[] }]]
  assert.equal(programId, PROGRAM_ID.toBase58())
  assert.deepEqual(config.filters.map((f) => f.memcmp.offset), [0, 8, 40, 201], 'the discriminator, the profile, the keeper, the label')
  assert.equal(config.filters[0].memcmp.bytes, base58(ROW_DISCRIMINATOR))
  assert.equal(config.filters[1].memcmp.bytes, profile.toBase58())
  assert.equal(config.filters[2].memcmp.bytes, keeper.toBase58())
  assert.equal(config.filters[3].memcmp.bytes, base58(new Uint8Array([15, 0, 0, 0, ...new TextEncoder().encode('tutoring/seller')])), 'the length, then the label')
  assert.deepEqual(await fetchRows(connection as never, { label: 'tutoring/sellers' }), [], 'checked exactly too')

  assert.equal((await fetchRow(connection as never, bytes(a.marketStamp)))?.label, 'tutoring/seller')
  assert.equal(await fetchRow(connection as never, bytes(proofNamed('bob-tutoring-A').marketStamp)), null, 'no row')
  const foreign = { getAccountInfo: async () => ({ data, owner: Keypair.generate().publicKey, lamports: 1, executable: false }) }
  await assert.rejects(fetchRow(foreign as never, bytes(a.marketStamp)), /not the registry's/)
})

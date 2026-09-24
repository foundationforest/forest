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
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'

import {
  BN254_R,
  MESSAGE_NS,
  PROGRAM_ID,
  SCOPE_NS,
  TREASURY,
  FOUNDATION_ISSUER,
  FOUNDATION_ISSUER_PLACEHOLDER_SEED,
  openListIx,
  addIssuerIx,
  acceptListOwnerIx,
  decodeIdentityInsertedEvents,
  fetchListLeaves,
  leavesFromEvents,
  listRoot,
  proposeListOwnerIx,
  sweepRentIx,
  TREASURY_PLACEHOLDER_SEED,
  USDC_FEE,
  USDC_MINT,
  USDC_MINT_DEVNET,
  addTokenIx,
  closeListIx,
  codeBytesFor,
  codeFor,
  commitmentOf,
  acceptTreasuryIx,
  decodeConfig,
  decodeIdentityList,
  decodeRegisteredEvents,
  discriminator,
  feeFor,
  listAddress,
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
const configAddressFor = () => PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0].toBase58()

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

test("the foundation's issuer key is the one the program writes as list 0's owner", () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  assert.ok(lib.includes(`pub const FOUNDATION_ISSUER: Pubkey = pubkey!("${FOUNDATION_ISSUER.toBase58()}")`), 'the issuer key must match the program')
  // A placeholder for the same reason as the treasury's, and to be replaced for the same reason.
  assert.equal(Keypair.fromSeed(FOUNDATION_ISSUER_PLACEHOLDER_SEED).publicKey.toBase58(), FOUNDATION_ISSUER.toBase58())
})

test('USDC pays its constant 0.25; every other mint pays the fee the treasury set for it', () => {
  const lib = readFileSync(join(here, '../../program/src/lib.rs'), 'utf8')
  assert.ok(lib.includes(`pub const USDC_FEE: u64 = ${USDC_FEE.toString().replace(/(\d)(?=(\d{3})+$)/g, '$1_')};`), 'the constant must match the program')
  assert.equal(USDC_FEE, 250_000n)
  // add_token carries the fee, a u64, after the discriminator; zero is refused before anything is built.
  const treasury = PublicKey.unique()
  const mint = PublicKey.unique()
  const ix = addTokenIx({ treasury, mint, fee: 31_250_000n })
  assert.equal(ix.data.length, 8 + 8)
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), 31_250_000n)
  assert.throws(() => addTokenIx({ treasury, mint, fee: 0n }), /FeeZero/)
  assert.throws(() => addTokenIx({ treasury, mint, fee: 1n << 64n }), RangeError)
})

test('the scope and the message are what the accepted proofs carry', () => {
  for (const p of fixtures.proofs) {
    assert.equal(hex(toBytes32(scopeOf(p.market))), p.scope, `${p.name}: scope`)
    assert.equal(hex(toBytes32(messageOf(new PublicKey(p.wallet), p.did))), p.message, `${p.name}: message`)
  }
})

test('the message names the profile\'s wallet as well as its DID', () => {
  const did = 'did:plc:wece24yzukt4pj6hqvmb2fn4'
  const a = PublicKey.unique()
  const b = PublicKey.unique()
  // Another wallet, the same DID: another message, so a proof made for one cannot land under the other.
  assert.notEqual(messageOf(a, did), messageOf(b, did))
  assert.notEqual(messageOf(a, did), messageOf(a, did + 'x'))
  assert.equal(messageOf(a, did), messageOf(a.toBytes(), did))
  assert.throws(() => messageOf(new Uint8Array(31), did), RangeError)
  // Alice's wallet in the fixtures is her profile 0 wallet from the keys recipe.
  const vectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
  const alice = fixtures.proofs.find((p: { name: string }) => p.name === 'alice-tutors')
  assert.equal(alice.wallet, vectors.profiles[0].wallet)
  assert.equal(Keypair.fromSeed(Buffer.from(alice.walletSeed, 'hex')).publicKey.toBase58(), alice.wallet)
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
  assert.notEqual(scopeOf('online-tutors'), messageOf(new Uint8Array(32), 'online-tutors'))
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
    'global:close_list': 'f340ec553656699b',
    'global:sweep_rent': '11ea3af1fb9487b9',
    'global:propose_list_owner': 'a0b5eebc58a1f83a',
    'global:accept_list_owner': 'c437d957a27be027',
    'event:ListOwnerProposed': '369de90e0e170e93',
    'event:ListOwnerChanged': '56a2f77af7741c4e',
    'event:IdentityInserted': '1b77bce435185818',
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

  // A config with two mints and their fees, one list, and a pending key at 678..710, laid out by hand.
  const other = PublicKey.unique()
  const b = new Uint8Array(8 + 710)
  const v = new DataView(b.buffer)
  b.set(treasury.toBytes(), 8)
  b.set(USDC_MINT.toBytes(), 8 + 32)
  b.set(other.toBytes(), 8 + 64)
  v.setBigUint64(8 + 544, 250_000n, true)
  v.setBigUint64(8 + 552, 31_250_000n, true)
  b[8 + 672] = 2
  b[8 + 673] = 1
  b[8 + 677] = 255
  b.set(next.toBytes(), 8 + 678)
  const config = decodeConfig(b)
  assert.equal(config.treasury.toBase58(), treasury.toBase58())
  assert.deepEqual(config.mints.map((m) => m.toBase58()), [USDC_MINT.toBase58(), other.toBase58()])
  assert.deepEqual(config.fees, [250_000n, 31_250_000n])
  assert.equal(feeFor(config, other), 31_250_000n)
  assert.equal(feeFor(config, PublicKey.unique()), null)
  assert.equal(config.listCount, 1)
  assert.equal(config.bump, 255)
  assert.equal(config.pendingTreasury?.toBase58(), next.toBase58())
  b.fill(0, 8 + 678)
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
    accounts: { payer: key(), profileWallet: new PublicKey(p.wallet), feeAuthority: key(), feeTokens: key(), treasuryTokens: key() },
  })
  // 8 discriminator + (4 + 13) market + (4 + 32) DID + 4 list index + 32 root + 32 code + 128 proof
  assert.equal(ix.data.length, 8 + 4 + p.market.length + 4 + p.did.length + 4 + 32 + 32 + 128)
  assert.equal(ix.keys.length, 11)
  assert.equal(ix.keys[3].pubkey.toBase58(), usedCodeAddress(Buffer.from(p.code, 'hex')).toBase58())
  assert.ok(ix.keys[4].isSigner && ix.keys[5].isSigner && ix.keys[6].isSigner, 'the payer, the profile wallet and the fee authority sign')
  assert.equal(ix.keys[5].pubkey.toBase58(), p.wallet, 'the profile wallet sits in slot 5')
  assert.ok(ix.keys[7].isWritable && !ix.keys[7].isSigner, 'the fee comes from slot 7')
})

test('anyone opens a list; its owner, not the treasury, manages and closes it; the owner decodes back out', () => {
  const [payer, owner, issuer] = [PublicKey.unique(), PublicKey.unique(), PublicKey.unique()]
  const open = openListIx({ payer, owner, newIndex: 3 })
  assert.equal(hex(open.data), hex(discriminator('global', 'open_list')))
  assert.deepEqual(
    open.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [configAddressFor(), false, true],
      [listAddress(3).toBase58(), false, true],
      [payer.toBase58(), true, true],
      [owner.toBase58(), true, false],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  )
  const add = addIssuerIx({ owner, listIndex: 3, issuer })
  assert.equal(hex(add.data), hex(discriminator('global', 'add_issuer')) + '03000000' + hex(issuer.toBytes()))
  const close = closeListIx({ owner, listIndex: 3 })
  assert.equal(hex(close.data), hex(discriminator('global', 'close_list')) + '03000000')
  for (const ix of [add, close]) {
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [listAddress(3).toBase58(), false, true],
        [owner.toBase58(), true, false],
      ],
      'the list and its owner, and no config: the treasury has no say',
    )
  }
  const list = new Uint8Array(8 + 5520)
  list[8 + 14] = 1
  list.set(owner.toBytes(), 8 + 5456)
  assert.equal(decodeIdentityList(list).closed, true)
  assert.equal(decodeIdentityList(list).owner.toBase58(), owner.toBase58())
  assert.equal(decodeIdentityList(list).pendingOwner, null, 'the zero key means no handover is pending')
  list[8 + 14] = 0
  assert.equal(decodeIdentityList(list).closed, false)
  assert.throws(() => decodeIdentityList(new Uint8Array(8 + 5488)), /not a list account/, 'a list laid out before session 15 is refused')
})

test("a list's handover is two instructions, and the pending owner decodes back out of the list", () => {
  const [owner, next] = [PublicKey.unique(), PublicKey.unique()]
  // Propose: discriminator, the list index, then borsh's Option<Pubkey>.
  const propose = proposeListOwnerIx({ owner, listIndex: 3, newOwner: next })
  assert.equal(hex(propose.data), hex(discriminator('global', 'propose_list_owner')) + '03000000' + '01' + hex(next.toBytes()))
  const clear = proposeListOwnerIx({ owner, listIndex: 3, newOwner: null })
  assert.equal(hex(clear.data), hex(discriminator('global', 'propose_list_owner')) + '03000000' + '00')
  const accept = acceptListOwnerIx({ pending: next, listIndex: 3 })
  assert.equal(hex(accept.data), hex(discriminator('global', 'accept_list_owner')) + '03000000')
  for (const [ix, signer] of [[propose, owner], [clear, owner], [accept, next]] as const) {
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [listAddress(3).toBase58(), false, true],
        [signer.toBase58(), true, false],
      ],
      'the list and the one key that signs: its owner to propose, the proposed key to accept',
    )
  }
  const list = new Uint8Array(8 + 5520)
  list.set(owner.toBytes(), 8 + 5456)
  list.set(next.toBytes(), 8 + 5488)
  assert.equal(decodeIdentityList(list).pendingOwner?.toBase58(), next.toBase58())
})

test("a sweep names where the rent goes: a list's owner, or the treasury", () => {
  const owner = PublicKey.unique()
  const ix = sweepRentIx({ target: { kind: 'list', index: 2 }, recipient: owner })
  assert.equal(hex(ix.data), hex(discriminator('global', 'sweep_rent')) + '02' + '02000000')
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [configAddressFor(), false, false],
      [listAddress(2).toBase58(), false, true],
      [owner.toBase58(), false, true],
    ],
    'nobody signs; the recipient only receives',
  )
})

/** One `IdentityInserted` entry's bytes, as the program writes them. */
function inserted(listIndex: number, leafIndex: bigint, commitment: bigint, root: bigint): string {
  const b = new Uint8Array(84)
  b.set(discriminator('event', 'IdentityInserted'))
  const v = new DataView(b.buffer)
  v.setUint32(8, listIndex, true)
  v.setBigUint64(12, leafIndex, true)
  b.set(toBytes32(commitment), 20)
  b.set(toBytes32(root), 52)
  return `Program data: ${Buffer.from(b).toString('base64')}`
}

test("a list's members read back out of the log, in order, checked against its root", () => {
  const id = PROGRAM_ID.toBase58()
  const members = [11n, 22n, 33n, 44n, 55n]
  const roots = members.map((_, i) => listRoot(members.slice(0, i + 1)))
  const logs = (from: number, to: number, list = 0) => [
    `Program ${id} invoke [1]`,
    ...members.slice(from, to).map((m, i) => inserted(list, BigInt(from + i), m, roots[from + i])),
    `Program ${id} success`,
  ]
  const events = decodeIdentityInsertedEvents([...logs(3, 5), ...logs(0, 3), ...logs(0, 2, 1)])
  assert.equal(events.length, 7)
  assert.equal(events[0].leafIndex, 3n)
  assert.deepEqual(leavesFromEvents(events, 0), members, 'in the order the list took them, whatever order the log was read in')
  assert.deepEqual(leavesFromEvents(events, 1), [11n, 22n], "another list's members kept apart")
  assert.deepEqual(leavesFromEvents([...events, ...events], 0), members, 'the same entry read twice counts once')
  assert.throws(() => leavesFromEvents(events.filter((e) => e.leafIndex !== 2n), 0), /no member at position 2/)
  const clash = { ...events[0], commitment: toBytes32(99n) }
  assert.throws(() => leavesFromEvents([...events, clash], 0), /two members at position 3/)
  // Only the registry's own lines: the same bytes from another program add no one.
  const forger = 'Forger1111111111111111111111111111111111111'
  assert.deepEqual(decodeIdentityInsertedEvents([`Program ${forger} invoke [1]`, inserted(0, 0n, 1n, 1n), `Program ${forger} success`]), [])
})

test('a phone reads a list through any connection, and refuses members that do not give its root', async () => {
  const id = PROGRAM_ID.toBase58()
  const members = [101n, 202n, 303n]
  const root = listRoot(members)
  // Three inserts, one per transaction, plus a registration that only read the list, plus a
  // failed transaction; listed newest first, the way RPC lists them.
  const txs: Record<string, string[]> = {
    s1: [`Program ${id} invoke [1]`, inserted(0, 0n, 101n, listRoot([101n])), `Program ${id} success`],
    s2: [`Program ${id} invoke [1]`, inserted(0, 1n, 202n, listRoot([101n, 202n])), `Program ${id} success`],
    s3: [`Program ${id} invoke [1]`, `Program log: Instruction: Register`, `Program ${id} success`],
    s4: [`Program ${id} invoke [1]`, inserted(0, 2n, 303n, root), `Program ${id} success`],
  }
  const account = (count: number, r: bigint) => {
    const data = new Uint8Array(8 + 5520)
    new DataView(data.buffer).setBigUint64(8, BigInt(count), true)
    data.set(toBytes32(r), 8 + 16)
    return { data: Buffer.from(data), owner: PROGRAM_ID, lamports: 1, executable: false }
  }
  const connection = (count: number, r: bigint) => ({
    getAccountInfo: async () => account(count, r),
    getSignaturesForAddress: async () =>
      ['s4', 'bad', 's3', 's2', 's1'].map((signature) => ({ signature, err: signature === 'bad' ? { e: 1 } : null })),
    getTransaction: async (signature: string) => ({ meta: { logMessages: txs[signature] } }),
  })
  const read = await fetchListLeaves(connection(3, root) as never, 0)
  assert.deepEqual(read.leaves, members)
  assert.equal(read.root, root)
  assert.equal(read.transactionsRead, 4, 'every transaction that touched the list and landed, and nothing else')
  // A member added after the account was read is left out, so the root is still one the list held.
  const early = await fetchListLeaves(connection(2, listRoot([101n, 202n])) as never, 0)
  assert.deepEqual(early.leaves, [101n, 202n])
  await assert.rejects(fetchListLeaves(connection(3, 7n) as never, 0), /do not give its root/)
  await assert.rejects(fetchListLeaves(connection(4, root) as never, 0), /holds 4 members but the log gave 3/)
})

test('an entry decodes back out of a log line', () => {
  const disc = discriminator('event', 'Registered')
  const market = 'online-tutors'
  const did = 'did:plc:wece24yzukt4pj6hqvmb2fn4'
  const enc = new TextEncoder()
  const wallet = new PublicKey(fixtures.proofs[0].wallet)
  const parts = [
    disc,
    new Uint8Array(new Uint32Array([market.length]).buffer),
    enc.encode(market),
    new Uint8Array(new Uint32Array([did.length]).buffer),
    enc.encode(did),
    wallet.toBytes(),
    new Uint8Array(Buffer.from(fixtures.proofs[0].code, 'hex')),
    new Uint8Array(new Uint32Array([7]).buffer),
    FOUNDATION_ISSUER.toBytes(),
  ]
  const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)))
  const id = PROGRAM_ID.toBase58()
  const line = `Program data: ${bytes.toString('base64')}`
  const [event] = decodeRegisteredEvents([`Program ${id} invoke [1]`, line, `Program ${id} success`])
  assert.equal(event.market, market)
  assert.equal(event.did, did)
  assert.equal(event.wallet.toBase58(), wallet.toBase58())
  assert.equal(event.listIndex, 7)
  assert.equal(event.listOwner.toBase58(), FOUNDATION_ISSUER.toBase58(), 'the entry names who vouched')
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

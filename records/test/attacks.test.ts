// Trying hard to break each promise. Every test names the promise and says what was tried; a test
// that shows an attack succeeding says so in its name (FINDING), and README.md lists it as a limit.
// Other attack tests live next to the code they attack: host.test.ts, view.test.ts, private.test.ts.

import assert from 'node:assert/strict'
import { createPublicKey, verify as nodeVerify } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages'
import { b64u, base58, concat, hex, utf8 } from '../src/bytes.ts'
import { publish, readAll, readProfile } from '../src/client.ts'
import type { Host } from '../src/host.ts'
import { readingKey } from '../src/private.ts'
import { checkRecord, encodeRecord, signingInput, unsignedOf, verifySignature } from '../src/record.ts'
import { viewProfile } from '../src/view.ts'
import { hostsRecord, ownerRecord, permissionsRecord, writerRecord } from '../src/write.ts'
import { DAY, MINUTE, SEED, T0, alice, aliceBuyer, allow, bob, offerBody, profileBody, writer } from './fixtures.ts'
import { startHost } from './helpers.ts'

const L = 2n ** 252n + 27742317777372353535851937790883648493n
const le = (n: bigint, len = 32) => Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * i)) & 255n))
const fromLe = (b: Uint8Array) => b.reduceRight((acc, byte) => (acc << 8n) + BigInt(byte), 0n)
const SMALL_ORDER_8 = hex.decode('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa')

function nodeAccepts(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' })
    return nodeVerify(null, message, key, sig)
  } catch {
    return false
  }
}

/** RFC 8032 signing with a chosen public key in the hash: how an attacker makes edge-case signatures. */
function signWithKey(secret: Uint8Array, publicKeyBytes: Uint8Array, message: Uint8Array): Uint8Array {
  const { scalar, prefix } = ed25519.utils.getExtendedPublicKey(secret)
  const r = fromLe(sha512(concat(prefix, message))) % L
  const R = ed25519.Point.BASE.multiply(r).toBytes()
  const k = fromLe(sha512(concat(R, publicKeyBytes, message))) % L
  return concat(R, le((r + k * scalar) % L))
}

describe('nobody forges; a signature means one thing everywhere', () => {
  const record = ownerRecord(alice, 'offer/a', offerBody('30'), T0)
  const message = signingInput(unsignedOf(record))
  const sig = b64u.decode(record.sig)

  test('a valid signature: ours and OpenSSL (node:crypto) agree', () => {
    assert.equal(verifySignature(sig, message, alice.publicKey), true)
    assert.equal(nodeAccepts(sig, message, alice.publicKey), true)
  })

  test('a second spelling of the same signature (S + L) is refused, and could not make a new id anyway', () => {
    const S = fromLe(sig.subarray(32))
    const malleated = concat(sig.subarray(0, 32), le(S + L))
    assert.equal(verifySignature(malleated, message, alice.publicKey), false)
    assert.equal(nodeAccepts(malleated, message, alice.publicKey), false)
    assert.throws(() => checkRecord({ ...record, sig: b64u.encode(malleated) }), /signature/)
  })

  test('a small-order key: (R = identity, S = 0) "verifies" any message for it; Forest refuses the key outright', (t) => {
    const identity = new Uint8Array(32)
    identity[0] = 1
    const universal = concat(identity, new Uint8Array(32))
    for (const weak of [identity, SMALL_ORDER_8]) {
      assert.equal(verifySignature(universal, message, weak), false)
      t.diagnostic(`node:crypto (OpenSSL) accepts the universal signature for small-order key ${hex.encode(weak).slice(0, 8)}…: ${nodeAccepts(universal, message, weak)}`)
    }
    // A permissions record naming a small-order writer key cannot even be written.
    assert.throws(() => permissionsRecord(alice, [{ key: base58.encode(identity), paths: ['offer'], until: T0 + MINUTE }], T0), /usable/)
  })

  test('a mixed-order key (the owner’s key plus a small-order point): verifiers could disagree; Forest refuses it', (t) => {
    const A = ed25519.Point.fromBytes(alice.publicKey)
    const mixed = A.add(ed25519.Point.fromBytes(SMALL_ORDER_8)).toBytes()
    let disagreements = 0
    for (let i = 0; i < 16; i++) {
      const m = utf8(`message ${i}`)
      const s = signWithKey(alice.secretKey, mixed, m)
      assert.equal(verifySignature(s, m, mixed), false)
      // A cofactored verifier accepts every one; a cofactorless one about 1 in 8.
      const R = ed25519.Point.fromBytes(s.subarray(0, 32))
      const k = fromLe(sha512(concat(s.subarray(0, 32), mixed, m))) % L
      const lhs = ed25519.Point.BASE.multiply(fromLe(s.subarray(32))).multiply(8n)
      const rhs = R.add(ed25519.Point.fromBytes(mixed).multiply(k)).multiply(8n)
      if (lhs.equals(rhs) !== nodeAccepts(s, m, mixed)) disagreements++
    }
    t.diagnostic(`cofactored vs OpenSSL disagreed on ${disagreements} of 16 signatures for a mixed-order key`)
    assert.ok(disagreements > 0, 'the split view is real when keys are not checked')
  })

  test('no record signature is a Solana transaction’s, and no transaction signature is a record’s', (t) => {
    const decoder = getCompiledTransactionMessageDecoder()
    assert.throws(() => decoder.decode(message), /version 127/)
    // Without the 0xff byte, a long canonical record is not refused by the version check:
    const outcome = (() => {
      try {
        decoder.decode(message.subarray(1))
        return 'decoded'
      } catch (err) {
        return `threw: ${(err as Error).message.slice(0, 40)}`
      }
    })()
    t.diagnostic(`the same bytes without 0xff, fed to Solana's decoder: ${outcome}`)
    // A Solana-style message signed by the profile's wallet key is not a record signature.
    const payment = concat(Uint8Array.of(1, 0, 1, 2), alice.publicKey, new Uint8Array(32), new Uint8Array(32), Uint8Array.of(1, 1, 1, 0, 0))
    assert.throws(() => checkRecord({ ...record, sig: b64u.encode(ed25519.sign(payment, alice.secretKey)) }), /signature/)
  })

  test('replaying a record into another profile, path or time fails; the same record twice is one record', () => {
    for (const change of [{ profile: bob.address }, { path: 'offer/b' }, { time: T0 + 1 }]) {
      assert.throws(() => checkRecord({ ...record, ...change }), /signature/)
    }
    assert.equal(checkRecord(record).id, checkRecord(JSON.parse(encodeRecord(record))).id)
  })
})

describe('a stolen writer key', () => {
  const until = T0 + 7 * DAY
  const permissions = permissionsRecord(alice, [allow(writer, ['offer'], until)], T0)
  const mine = ownerRecord(alice, 'offer/maths', offerBody('30'), T0)
  const view = (...records: Parameters<typeof checkRecord>[0][]) => viewProfile(alice.address, records.map((r) => checkRecord(r)), T0 + DAY)

  test('cannot rewrite or delete what the owner wrote, cannot touch hosts or permissions, cannot write outside its paths', () => {
    const overwrite = writerRecord(writer, alice.address, 'offer/maths', offerBody('1'), T0 + DAY)
    const card = writerRecord(writer, alice.address, 'profile', profileBody('Not Alice'), T0 + DAY)
    const v = view(permissions, mine, overwrite, card)
    assert.equal(v.current.get('offer/maths')!.id, checkRecord(mine).id)
    assert.equal(v.current.has('profile'), false)
    assert.throws(() => writerRecord(writer, alice.address, 'hosts', { urls: ['https://evil.example'] }, T0 + DAY), /only the owner/)
  })

  test('once removed, nothing it signs counts, however it is dated, on any host or none', () => {
    const removed = permissionsRecord(alice, [], T0 + MINUTE)
    const backdated = writerRecord(writer, alice.address, 'offer/spam', offerBody('1'), T0 + 1)
    const v = view(permissions, removed, backdated)
    assert.equal(v.current.has('offer/spam'), false)
  })

  test('FINDING: past until but still listed, a backdated record counts for readers of a host that skips the check', () => {
    // An honest host refuses it by its own clock (host.test.ts). A reader has no clock of its own
    // in the rule, so whoever holds a host that takes it can show it. Removing the key ends it.
    const backdated = writerRecord(writer, alice.address, 'offer/old', offerBody('1'), until - 1)
    assert.equal(viewProfile(alice.address, [permissions, backdated].map((r) => checkRecord(r)), until + 365 * DAY).current.has('offer/old'), true)
  })
})

describe('over real hosts', () => {
  let h1: Host
  let h2: Host
  before(async () => {
    h1 = await startHost({ now: () => T0 + 10 * MINUTE })
    h2 = await startHost({ now: () => T0 + 10 * MINUTE })
    const urls = [h1.url, h2.url]
    await publish(urls, [hostsRecord(alice, urls, T0), ownerRecord(alice, 'profile', profileBody('A'), T0), ownerRecord(alice, 'offer/a', offerBody('1'), T0)])
  })
  after(async () => {
    await h1.close()
    await h2.close()
  })

  test('a deleted offer cannot be brought back by a host that still has the old version', async () => {
    await publish([h1.url], [ownerRecord(alice, 'offer/a', null, T0 + 1)]) // only host 1 hears the delete
    const v = await readProfile([h2.url, h1.url], alice.address, T0 + 10 * MINUTE)
    assert.equal(v.current.get('offer/a')!.record.body, null)
  })

  test('a host holds no key: its whole database holds no secret of the person', async () => {
    const reading = await readingKey(alice.secretKey)
    const disk = [...h1.dump(), ...h2.dump()].join('\n')
    for (const secret of [alice.secretKey, SEED]) {
      for (const form of [hex.encode(secret), b64u.encode(secret), Buffer.from(secret).toString('base64'), base58.encode(secret)]) assert.ok(!disk.includes(form))
    }
    assert.ok(!disk.includes(reading.identity))
  })

  test('a hosts record signed by someone else, naming other hosts, is refused by hosts and readers', async () => {
    const fake = { ...hostsRecord(bob, ['https://evil.example'], T0 + 5), profile: alice.address }
    assert.throws(() => checkRecord(fake), /signature/)
    assert.equal((await h1.accept([encodeRecord(fake)]))[0]!.error, 'signature')
  })

  test('two readers reading different hosts compute the same view', async () => {
    await publish([h2.url], [ownerRecord(alice, 'offer/a', null, T0 + 1)]) // now both hosts hold everything
    const summary = (v: { current: Map<string, { id: string }> }) => [...v.current].map(([p, c]) => `${p}=${c.id}`).sort().join()
    const one = viewProfile(alice.address, (await readAll(h1.url, { profile: alice.address })).records, T0 + 10 * MINUTE)
    const two = viewProfile(alice.address, (await readAll(h2.url, { profile: alice.address })).records, T0 + 10 * MINUTE)
    assert.equal(summary(one), summary(two))
  })
})

describe('linking two profiles of one person', () => {
  test('addresses, reading keys and writer keys: nothing public repeats across the two profiles', async () => {
    const [read0, read1] = await Promise.all([readingKey(alice.secretKey), readingKey(aliceBuyer.secretKey)])
    const writerFor = (n: number) => ({ key: base58.encode(ed25519.getPublicKey(sha512(utf8(`writer ${n}`)).subarray(0, 32))), paths: ['offer'], until: T0 + 1 })
    const one = [
      hostsRecord(alice, ['https://big-host.example'], T0),
      ownerRecord(alice, 'profile', { ...profileBody('Alice teaches'), read: read0.recipient }, T0),
      permissionsRecord(alice, [writerFor(1)], T0),
    ]
    const two = [
      hostsRecord(aliceBuyer, ['https://big-host.example'], T0),
      ownerRecord(aliceBuyer, 'profile', { ...profileBody('A. buys'), role: 'buyer', read: read1.recipient }, T0),
      permissionsRecord(aliceBuyer, [writerFor(2)], T0),
    ]
    const tokens = (records: object[]) => {
      const out = new Set<string>()
      const walk = (v: unknown) => {
        if (typeof v === 'string' && v.length >= 16) out.add(v)
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
      }
      for (const r of records) walk(r)
      return out
    }
    const shared = [...tokens(one)].filter((t) => tokens(two).has(t))
    // What repeats is only what the person chose to repeat: here the host, and shared template text.
    assert.deepEqual(shared.sort(), ['2026-10-02T12:00:00Z', 'Maths and physics, secondary level.', 'https://big-host.example'].sort())
  })

  test('FINDING: written in the same moment, two profiles sit side by side in a host’s listing', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      await publish([host.url], [ownerRecord(alice, 'profile', profileBody('A'), T0)])
      await publish([host.url], [ownerRecord(bob, 'profile', profileBody('B'), T0)])
      // One app writes both of a person's profiles at once:
      await publish([host.url], [ownerRecord(alice, 'offer/x', offerBody('1'), T0 + 1), ownerRecord(aliceBuyer, 'offer/y', offerBody('1'), T0 + 1)])
      const listing = (await readAll(host.url)).records.map((c) => c.record.profile)
      assert.deepEqual(listing.slice(-2), [alice.address, aliceBuyer.address], 'adjacent, same millisecond: an observer can guess they are one person')
    } finally {
      await host.close()
    }
  })

  test('FINDING: one writer key listed by two profiles links them in public', () => {
    const intoSeller = writerRecord(writer, alice.address, 'offer/x', offerBody('1'), T0)
    const intoBuyer = writerRecord(writer, aliceBuyer.address, 'offer/y', offerBody('1'), T0)
    assert.equal(intoSeller.by, intoBuyer.by, 'anyone reading both sees the same by: give each profile its own writer key')
  })
})

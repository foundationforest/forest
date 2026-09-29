// Trying hard to break each need. Every test names the need and says what was tried; a test that
// shows an attack succeeding says so in its name: those are findings, written into the report.
// Other attack tests live next to the code they attack: grants.test.ts, connections.test.ts,
// browser.test.ts, sealed.test.ts, policy.test.ts, host.test.ts, discovery.test.ts.

import assert from 'node:assert/strict'
import { createPublicKey, verify as nodeVerify } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages'
import { publish, readAll } from '../src/client.ts'
import { b64u, concat, hex, utf8 } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type Entry, checkEntry, encodeEntry, signingInput, unsignedOf, verifySignature } from '../src/entry.ts'
import { checkPayload, hostsPayload } from '../src/discovery.ts'
import type { Host } from '../src/host.ts'
import { Index } from '../src/indexer.ts'
import { didFromPublicKey, keyFromSecret } from '../src/keys.ts'
import { approve, requestFromLink, requestLink } from '../src/request.ts'
import { boxKey } from '../src/sealed.ts'
import { liveContent, viewProfile } from '../src/view.ts'
import { delegateEntry, folderEntry, grantEntry, ownerEntry } from '../src/write.ts'
import { MINUTE, SEED, T0, alice, aliceBuyer, bob, offerBody, profileBody, reviewBody, signer } from './fixtures.ts'
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

describe('need 2: nobody forges; signatures mean one thing everywhere', () => {
  const entry = ownerEntry(alice, 'offer/a', offerBody('30'), T0)
  const message = signingInput(unsignedOf(entry))
  const sig = b64u.decode(entry.sig)

  test('a valid signature: ours and OpenSSL (node:crypto) agree', () => {
    assert.equal(verifySignature(sig, message, alice.publicKey), true)
    assert.equal(nodeAccepts(sig, message, alice.publicKey), true)
  })

  test('a second spelling of the same signature (S + L) is refused, and could not mint a new id anyway', () => {
    const S = fromLe(sig.subarray(32))
    const malleated = concat(sig.subarray(0, 32), le(S + L))
    assert.equal(verifySignature(malleated, message, alice.publicKey), false)
    assert.equal(nodeAccepts(malleated, message, alice.publicKey), false)
    // The id is the hash of what was signed, not of the signature.
    const forged = { ...entry, sig: b64u.encode(malleated) } as Entry
    assert.throws(() => checkEntry(forged), /signature/)
  })

  test('a small-order key: (R = identity, S = 0) "verifies" any message for it; Forest refuses the key outright', (t) => {
    const identity = new Uint8Array(32)
    identity[0] = 1
    const universal = concat(identity, new Uint8Array(32))
    for (const weak of [identity, SMALL_ORDER_8]) {
      assert.equal(verifySignature(universal, message, weak), false)
      t.diagnostic(`node:crypto (OpenSSL) accepts the universal signature for small-order key ${hex.encode(weak).slice(0, 8)}…: ${nodeAccepts(universal, message, weak)}`)
    }
    // A grant naming a small-order key cannot even be written: `to` must be a usable key.
    assert.throws(() => grantEntry(alice, 'weak', { to: didFromPublicKey(identity), paths: ['offer'], until: T0 + MINUTE }, T0), /usable/)
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
      const cofactored = lhs.equals(rhs)
      if (cofactored !== nodeAccepts(s, m, mixed)) disagreements++
    }
    t.diagnostic(`cofactored vs OpenSSL disagreed on ${disagreements} of 16 signatures for a mixed-order key`)
    assert.ok(disagreements > 0, 'the split view is real when keys are not checked')
  })

  test('no entry signature is a Solana transaction, and no transaction signature is an entry', (t) => {
    const decoder = getCompiledTransactionMessageDecoder()
    assert.throws(() => decoder.decode(message), /version 127/)
    // Without the 0xff byte, a long canonical entry is not refused by the version check:
    const withoutPrefix = message.subarray(1)
    const outcome = (() => {
      try {
        decoder.decode(withoutPrefix)
        return 'decoded'
      } catch (err) {
        return `threw: ${(err as Error).message.slice(0, 40)}`
      }
    })()
    t.diagnostic(`the same bytes without 0xff, fed to Solana's decoder: ${outcome}`)
    assert.ok(outcome.length > 0) // recorded either way; the prefix is what makes it certain
    // A Solana-style message signed by the profile's wallet key is not an entry signature.
    const payment = concat(Uint8Array.of(1, 0, 1, 2), alice.publicKey, new Uint8Array(32), new Uint8Array(32), Uint8Array.of(1, 1, 1, 0, 0))
    const paymentSig = ed25519.sign(payment, alice.secretKey)
    assert.throws(() => checkEntry({ ...entry, sig: b64u.encode(paymentSig) }), /signature/)
  })

  test('no Pkarr packet signature is an entry signature, and the reverse', () => {
    const payload = hostsPayload(alice, ['https://h1.example'], T0)
    assert.throws(() => checkEntry({ ...entry, sig: b64u.encode(payload.subarray(0, 64)) }), /signature/)
    const spliced = concat(sig, payload.subarray(64))
    assert.equal(checkPayload(alice.publicKey, spliced), null)
  })

  test('replaying an entry into another profile, path or time fails; the same entry twice is one entry', () => {
    for (const change of [{ profile: bob.did }, { path: 'offer/b' }, { time: T0 + 1 }]) {
      assert.throws(() => checkEntry({ ...entry, ...change }), /signature/)
    }
    assert.equal(checkEntry(entry).id, checkEntry(JSON.parse(encodeEntry(entry))).id)
  })

  test('a delegate cannot use one profile’s grant in another profile', () => {
    const { entry: grant, grantId } = grantEntry(alice, 'g', { to: signer.did, paths: ['offer'], until: T0 + 7 * 86_400_000 }, T0)
    const intoBob = delegateEntry(signer, bob.did, grantId, 'offer/x', offerBody('1'), T0 + 1)
    const v = viewProfile(bob.did, [[checkEntry(grant), checkEntry(intoBob)]], T0 + MINUTE)
    assert.equal(v.ignored.get(checkEntry(intoBob).id), 'grant-not-current')
  })
})

describe('needs 4, 5, 6, 10 over real hosts', () => {
  let h1: Host
  let h2: Host
  before(async () => {
    h1 = await startHost({ now: () => T0 + 10 * MINUTE })
    h2 = await startHost({ now: () => T0 + 10 * MINUTE })
    const hosts = [h1.url, h2.url]
    await publish(hosts, [folderEntry(alice, { hosts }, T0), ownerEntry(alice, 'profile', profileBody('A'), T0), ownerEntry(alice, 'offer/a', offerBody('1'), T0)])
  })
  after(async () => {
    await h1.close()
    await h2.close()
  })

  test('need 4: a deleted offer cannot be brought back by a host that still has the old version', async () => {
    await publish([h1.url], [ownerEntry(alice, 'offer/a', null, T0 + 1)]) // only host 1 hears the delete
    const index = new Index({ hosts: [h2.url, h1.url], now: () => T0 + 10 * MINUTE })
    await index.crawl()
    assert.equal(index.view(alice.did)!.current.get('offer/a')!.entry.body, null)
  })

  test('need 5: a host holds no key: its whole database contains no secret of the person', async () => {
    const box = await boxKey(SEED, 0)
    const disk = [...h1.dump(), ...h2.dump()].join('\n')
    for (const secret of [alice.secretKey, SEED]) {
      for (const form of [hex.encode(secret), b64u.encode(secret), Buffer.from(secret).toString('base64')]) assert.ok(!disk.includes(form))
    }
    assert.ok(!disk.includes(box.identity))
  })

  test('need 6: a folder signed by someone else, naming other hosts, is refused by readers', async () => {
    const fake = { ...folderEntry(bob, { hosts: ['https://evil.example'] }, T0 + 5), profile: alice.did } as Entry
    assert.throws(() => checkEntry(fake), /signature/)
    const results = await h1.accept([encodeEntry(fake)])
    assert.equal(results[0]!.error, 'signature')
  })

  test('need 10: two indexes reading different hosts compute the same view', async () => {
    await publish([h2.url], [ownerEntry(alice, 'offer/a', null, T0 + 1)]) // now both hosts hold everything
    const one = new Index({ hosts: [h1.url], now: () => T0 + 10 * MINUTE })
    const two = new Index({ hosts: [h2.url], now: () => T0 + 10 * MINUTE })
    await one.follow(h1.url)
    await two.follow(h2.url)
    const summary = (i: Index) => [...i.view(alice.did)!.current].map(([p, v]) => `${p}=${v.id}`).sort().join()
    assert.equal(summary(one), summary(two))
  })
})

describe('need 7: linking two profiles of one person', () => {
  test('keys, box keys, grant keys and ids: nothing public repeats across the two profiles', async () => {
    const [box0, box1] = await Promise.all([boxKey(SEED, 0), boxKey(SEED, 1)])
    const agentFor = (n: number) => keyFromSecret(sha512(utf8(`signer ${n}`)).subarray(0, 32)) // one signer key per profile
    const one = [
      folderEntry(alice, { hosts: ['https://big-host.example'], box: box0.recipient }, T0),
      ownerEntry(alice, 'profile', profileBody('Alice teaches'), T0),
      grantEntry(alice, 'c1', { to: agentFor(1).did, paths: ['offer'], until: T0 + 1 }, T0).entry,
    ]
    const two = [
      folderEntry(aliceBuyer, { hosts: ['https://big-host.example'], box: box1.recipient }, T0),
      ownerEntry(aliceBuyer, 'profile', { ...profileBody('A. buys'), role: 'buyer' }, T0),
      grantEntry(aliceBuyer, 'c2', { to: agentFor(2).did, paths: ['offer'], until: T0 + 1 }, T0).entry,
    ]
    const tokens = (entries: Entry[]) => {
      const out = new Set<string>()
      const walk = (v: unknown) => {
        if (typeof v === 'string' && v.length >= 16) out.add(v)
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
      }
      for (const e of entries) walk(e)
      return out
    }
    const shared = [...tokens(one)].filter((t) => tokens(two).has(t))
    // What repeats is only what the person chose to repeat: here the host, and shared template text.
    assert.deepEqual(shared.sort(), ['2026-09-29T12:00:00Z', 'Maths and physics, secondary level.', 'https://big-host.example'].sort())
  })

  test('FINDING: written in the same moment, two profiles sit side by side in a host’s feed', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      await publish([host.url], [folderEntry(alice, { hosts: [host.url] }, T0)])
      await publish([host.url], [folderEntry(bob, { hosts: [host.url] }, T0)])
      await publish([host.url], [folderEntry(aliceBuyer, { hosts: [host.url] }, T0)])
      // One app writes both of a person's profiles at once:
      await publish([host.url], [ownerEntry(alice, 'offer/x', offerBody('1'), T0 + 1), ownerEntry(aliceBuyer, 'offer/y', offerBody('1'), T0 + 1)])
      const feed = (await readAll(host.url)).versions.map((v) => v.entry.profile)
      const last = feed.slice(-2)
      assert.deepEqual(last, [alice.did, aliceBuyer.did], 'adjacent in arrival order, same millisecond: an observer can guess they are one person')
    } finally {
      await host.close()
    }
  })

  test('FINDING: an assistant that wrote a post recognizes it later on public hosts, in either mode', async () => {
    const host = await startHost({ now: () => T0 })
    try {
      await publish([host.url], [folderEntry(alice, { hosts: [host.url] }, T0)])
      // Draft and approve: the assistant holds nothing and the person signs, but the words are the assistant's.
      const drafted = offerBody('35')
      const link = requestLink('https://forest.example/approve', { v: 1, profile: alice.did, path: 'offer/drafted', body: drafted, hosts: [host.url] })
      await approve(SEED, requestFromLink(link), T0 + 1)
      // Under a grant: the post carries the signer's own key.
      const { entry: grant, grantId } = grantEntry(alice, 'mine', { to: signer.did, paths: ['offer'], until: T0 + 86_400_000 }, T0 + 2)
      await publish([host.url], [grant, delegateEntry(signer, alice.did, grantId, 'offer/signed', offerBody('36'), T0 + 3)])

      // Later, reading a public host with only its own words and its own key in hand:
      const found = (await readAll(host.url)).versions.filter((v) => canonical(v.entry.body) === canonical(drafted) || v.entry.by === signer.did)
      assert.deepEqual(found.map((v) => [v.entry.profile, v.entry.path]), [[alice.did, 'offer/drafted'], [alice.did, 'offer/signed']])
      assert.ok(liveContent(viewProfile(alice.did, [(await readAll(host.url)).versions], T0 + MINUTE)).has('offer/drafted'))
    } finally {
      await host.close()
    }
  })
})

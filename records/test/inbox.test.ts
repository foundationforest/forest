// The inbox: a profile's card declares one, anyone may deliver a sealed message to it on the
// profile's hosts, and only the profile's main key pulls it. Each check a host runs on a delivery
// is tried here, in the standard's order, and so is each way to pull what is not yours.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readingKey } from '../../keys/src/index.ts'
import { canonical } from '../src/canonical.ts'
import { deliver, publish, pull, readAll, readProfile } from '../src/client.ts'
import type { Host, HostOptions } from '../src/host.ts'
import type { Key } from '../src/keys.ts'
import { type SignedMessage, encodeMessage, inboxOf, pullRequest, readMessage, signMessage } from '../src/message.ts'
import { makePrivate, message, openMessage } from '../src/private.ts'
import { type Body, MAX_RECORD_BYTES, RecordError } from '../src/record.ts'
import { hostsRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { DAY, MINUTE, T0, accessKey, alice, aliceBuyer, allow, bob, profileBody, stranger } from './fixtures.ts'
import { Clock, startHost } from './helpers.ts'

const [aliceRead, aliceBuyerRead] = await Promise.all([readingKey(alice.privateKey), readingKey(aliceBuyer.privateKey)])
/** An issuer: whoever keeps a list. Here, any usable key. */
const ISSUER = stranger.address

const card = (inbox?: Body | string, name = 'Alice') => ({ ...profileBody(name), read: aliceRead.recipient, ...(inbox !== undefined && { inbox }) })
const ANYONE = { senders: 'anyone' }

/** A host, at T0 unless given a clock, holding Alice's card with this inbox. */
async function hostWith(inbox: Body | string | undefined, options: HostOptions = {}): Promise<Host> {
  const h = await startHost({ now: () => T0, ...options })
  await publish([h.url], [ownerRecord(alice, 'profile', card(inbox), T0)])
  return h
}
const note = (from: Key = bob, text = 'Is Tuesday at six free?', time = T0) => message(from, alice.address, { text, createdAt: '2026-10-02T12:00:00Z' }, time, aliceRead.recipient)
const errors = async (h: Host, messages: SignedMessage[]) => (await deliver([h.url], messages))[0]!.results.map((r) => r.error ?? 'ok')
const pulled = async (h: Host, after = 0, time = T0, owner: Key = alice) => pull(h.url, pullRequest(owner, after, time))
const refusal = async (promise: Promise<unknown>) => promise.then(() => 'ok', (err: unknown) => (err instanceof RecordError ? err.code : String(err)))

describe('messages', () => {
  test('a message is sealed to the card’s read and signed by from; only that reading key opens it', async () => {
    const m = await note()
    assert.deepEqual(Object.keys(m.body), ['private'])
    assert.equal(m.from, bob.address)
    const opened = await openMessage(m, aliceRead.identity)
    assert.deepEqual([opened.from, opened.to, opened.time, opened.body.text], [bob.address, alice.address, T0, 'Is Tuesday at six free?'])
    assert.equal(opened.id, readMessage(encodeMessage(m)).id)
    assert.match(opened.id, /^[0-9a-f]{64}$/, 'lowercase hex, as a record’s id')
    await assert.rejects(openMessage(m, aliceBuyerRead.identity), 'the same person’s other profile cannot open it')
  })

  test('a body is { private } and nothing else; a message is at most 65,536 bytes; the key must be from’s', async () => {
    const sealed = await makePrivate({ text: 'hi' }, [aliceRead.recipient])
    assert.throws(() => signMessage(bob, alice.address, { text: 'hi' } as never, T0), /body/)
    assert.throws(() => signMessage(bob, alice.address, { ...sealed, extra: 'x' } as never, T0), /body/)
    assert.throws(() => signMessage(bob, 'not an address', sealed, T0), /to is not/)
    assert.throws(() => signMessage({ ...bob, address: alice.address }, alice.address, sealed, T0), /private key/)
    assert.throws(() => signMessage(bob, alice.address, { private: 'A'.repeat(MAX_RECORD_BYTES) }, T0), /at most 65536/)
    const m = signMessage(bob, alice.address, sealed, T0)
    for (const [text, code] of [
      [JSON.stringify(m, null, 1), 'canonical'],
      [canonical({ ...m, path: 'x' }), 'shape'],
      [canonical({ ...m, v: 2 }), 'version'],
      [canonical({ ...m, time: -1 }), 'time'],
    ] as const) assert.throws(() => readMessage(text), (err: RecordError) => err.code === code, code)
  })

  test('the card’s inbox: none, open to anyone, an issuer’s rule; anything this code does not know is unsupported', () => {
    assert.equal(inboxOf(null), null)
    assert.equal(inboxOf(card()), null)
    assert.equal(inboxOf({ private: 'abc' }), null, 'a private card declares nothing a host can read')
    assert.deepEqual(inboxOf(card(ANYONE)), { senders: 'anyone' })
    assert.deepEqual(inboxOf(card({ senders: { issuer: ISSUER }, once: true, maxBytes: 4000 })), { senders: { issuer: ISSUER }, once: true, maxBytes: 4000 })
    for (const inbox of ['anyone', {}, { senders: 'everyone' }, { senders: { deposit: '5' } }, { senders: { issuer: 'x' } }, { senders: { issuer: ISSUER, label: 'x' } }, { ...ANYONE, once: false }, { ...ANYONE, maxBytes: -1 }, { ...ANYONE, deposit: '5' }]) {
      assert.equal(inboxOf(card(inbox as Body)), 'unsupported', JSON.stringify(inbox))
    }
  })
})

describe('deliver and pull', () => {
  test('a sender reads the card, seals to its read, delivers to each host; the main key pulls from each and opens; no host reads it, and no record lists it', async () => {
    const h1 = await startHost({ now: () => T0 })
    const h2 = await startHost({ now: () => T0 })
    try {
      await publish([h1.url, h2.url], [hostsRecord(alice, [h1.url, h2.url], T0), ownerRecord(alice, 'profile', card(ANYONE), T0)])
      // Bob's app knows one host; the hosts record gives the rest, and the card the reading key.
      const view = await readProfile([h1.url], alice.address, T0)
      const read = view.current.get('profile')!.record.body!.read as string
      const m = await message(bob, alice.address, { text: 'Is Tuesday at six free?' }, T0, read)
      const outcomes = await deliver(view.hosts, [m])
      assert.deepEqual(outcomes.map((o) => o.results.map((r) => r.error ?? 'ok')), [['ok'], ['ok']])

      for (const h of [h1, h2]) {
        const page = await pulled(h)
        assert.deepEqual(page.refused, [])
        assert.equal(page.messages.length, 1)
        assert.equal((await openMessage(page.messages[0]!.message, aliceRead.identity)).body.text, 'Is Tuesday at six free?')
        assert.ok(!h.dump().join('\n').includes('Tuesday'))
        const records = await readAll(h.url)
        assert.deepEqual([records.records.length, records.refused.length], [2, 0], 'a message is not a record')
      }
    } finally {
      await h1.close()
      await h2.close()
    }
  })

  test('a host checks a delivery in order: shape, future, duplicate, no inbox, signature', async () => {
    const h = await hostWith(ANYONE)
    try {
      const m = await note()
      const forged = { ...(await note(stranger)), from: bob.address } // stranger signed, claims to be Bob
      const results = await h.deliver([
        'not json',
        canonical({ ...m, path: 'x' }),
        encodeMessage({ ...m, body: { private: m.body.private, text: 'x' } } as never),
        encodeMessage(await note(bob, 'later', T0 + 10 * MINUTE + 1)),
        encodeMessage(m),
        encodeMessage(m),
        encodeMessage({ ...m, to: bob.address }),
        encodeMessage(forged),
        encodeMessage({ ...m, time: T0 - 1 }),
      ])
      assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['canonical', 'shape', 'body', 'future', 'ok', 'duplicate', 'no_inbox', 'signature', 'signature'])
      assert.deepEqual(await errors(h, [m]), ['duplicate'], 'in a later request too')
      // Cheap checks first: a forged message to a profile with no inbox is refused before its signature is checked.
      assert.deepEqual(await errors(h, [{ ...forged, to: aliceBuyer.address }]), ['no_inbox'])
    } finally {
      await h.close()
    }
  })

  test('no inbox field, no inbox: a card without one, no card, a deleted card, and a card on another host', async () => {
    const h = await hostWith(undefined)
    const other = await startHost({ now: () => T0 })
    try {
      assert.deepEqual(await errors(h, [await note()]), ['no_inbox'])
      await publish([other.url], [ownerRecord(alice, 'profile', card(ANYONE), T0 + 1)])
      assert.deepEqual(await errors(h, [await note()]), ['no_inbox'], 'only the card on this host counts')
      await publish([h.url], [ownerRecord(alice, 'profile', card(ANYONE), T0 + 1)])
      assert.deepEqual(await errors(h, [await note()]), ['ok'])
      await publish([h.url], [ownerRecord(alice, 'profile', null, T0 + 2)])
      assert.deepEqual(await errors(h, [await note()]), ['no_inbox'], 'a deleted card')
      assert.deepEqual(await errors(h, [await message(bob, bob.address, { text: 'x' }, T0, aliceRead.recipient)]), ['no_inbox'], 'a profile this host has never seen')
    } finally {
      await h.close()
      await other.close()
    }
  })

  test('the issuer rule: from needs a row from that issuer, under any label; a host without a lookup answers rule_unsupported; a lookup that fails is lookup, never sender', async () => {
    const asked: string[][] = []
    const rows = async (from: string, issuer: string) => {
      asked.push([from, issuer])
      return from === bob.address && issuer === ISSUER
    }
    const rule = { senders: { issuer: ISSUER } }
    const h = await hostWith(rule, { rowLookup: rows })
    const none = await hostWith(rule)
    let down = true
    const flaky = await hostWith(rule, {
      rowLookup: async (from, issuer) => {
        if (down) throw new Error('RPC unreachable')
        return rows(from, issuer)
      },
    })
    try {
      assert.deepEqual(await errors(h, [await note(bob), await note(aliceBuyer)]), ['ok', 'sender'])
      assert.deepEqual(asked, [[bob.address, ISSUER], [aliceBuyer.address, ISSUER]])
      assert.deepEqual(await errors(none, [await note(bob)]), ['rule_unsupported'])
      const m = await note(bob)
      const [outcome] = await deliver([flaky.url], [m])
      assert.equal(outcome!.results[0]!.error, 'lookup')
      assert.match(outcome!.results[0]!.message!, /RPC unreachable/)
      down = false
      assert.deepEqual(await errors(flaky, [m]), ['ok'], 'the same message, again: nothing was kept the first time')
      // A host without a lookup still takes an inbox open to anyone.
      await publish([none.url], [ownerRecord(alice, 'profile', card(ANYONE), T0 + 1)])
      assert.deepEqual(await errors(none, [await note(aliceBuyer)]), ['ok'])
    } finally {
      await h.close()
      await none.close()
      await flaky.close()
    }
  })

  test('an inbox the host cannot read is refused as rule_unsupported, never taken as open to anyone', async () => {
    for (const inbox of [{ senders: { deposit: '5' } }, { ...ANYONE, deposit: '5' }, { ...ANYONE, once: 'yes' }, 'anyone']) {
      const h = await hostWith(inbox as Body, { rowLookup: async () => true })
      try {
        assert.deepEqual(await errors(h, [await note()]), ['rule_unsupported'], JSON.stringify(inbox))
      } finally {
        await h.close()
      }
    }
  })

  test('once: a second message from the same sender is refused, ever; a refused first does not use it up; the pair is kept only while the inbox says once', async () => {
    const clock = new Clock(T0)
    const h = await startHost({ now: clock.now })
    try {
      await publish([h.url], [ownerRecord(alice, 'profile', card({ ...ANYONE, once: true, maxBytes: 4000 }), T0)])
      assert.deepEqual(await errors(h, [await note(bob, 'x'.repeat(3000))]), ['too_big'])
      assert.deepEqual(await errors(h, [await note(bob), await note(bob, 'And Wednesday?')]), ['ok', 'once'])
      assert.deepEqual(await errors(h, [await note(aliceBuyer)]), ['ok'], 'another sender')
      h.prune(T0 + 31 * DAY)
      assert.equal((await pulled(h)).messages.length, 0, 'the messages went after keep days')
      assert.deepEqual(await errors(h, [await note(bob, 'Still there?')]), ['once'], 'the pair did not')

      // While the inbox is open, no pair is kept: turning once on later gives each sender one more.
      await publish([h.url], [ownerRecord(alice, 'profile', card(ANYONE), T0 + 1)])
      assert.deepEqual(await errors(h, [await note(stranger)]), ['ok'])
      await publish([h.url], [ownerRecord(alice, 'profile', card({ ...ANYONE, once: true }), T0 + 2)])
      assert.deepEqual(await errors(h, [await note(stranger, 'Hello again'), await note(stranger, 'And again')]), ['ok', 'once'])
    } finally {
      await h.close()
    }
  })

  test('maxBytes counts the message’s canonical text, in bytes: too_big', async () => {
    const m = await note()
    const bytes = Buffer.byteLength(encodeMessage(m))
    for (const [maxBytes, result] of [[bytes, 'ok'], [bytes - 1, 'too_big']] as const) {
      const h = await hostWith({ ...ANYONE, maxBytes })
      try {
        assert.deepEqual(await errors(h, [m]), [result], String(maxBytes))
      } finally {
        await h.close()
      }
    }
  })

  test('a host’s own policy comes last, and sees what it holds for that recipient', async () => {
    const seen: number[] = []
    const h = await hostWith(ANYONE, {
      messagePolicy: (_m, stored) => {
        seen.push(stored.messages)
        return stored.messages < 2 ? null : 'two messages a profile here'
      },
    })
    try {
      const forged = { ...(await note(stranger)), from: bob.address }
      assert.deepEqual(await errors(h, [await note(bob), forged, await note(aliceBuyer), await note(stranger)]), ['ok', 'signature', 'ok', 'policy'])
      assert.deepEqual(seen, [0, 1, 2], 'never asked about a forged one')
    } finally {
      await h.close()
    }
  })

  test('a host chooses its batch: 100 here unless told otherwise; a client sends a bigger request in halves', async () => {
    const h = await hostWith(ANYONE, { maxBatch: 2 })
    const reference = await hostWith(ANYONE)
    try {
      const five = await Promise.all([1, 2, 3, 4, 5].map((i) => note(bob, `note ${i}`)))
      assert.deepEqual(await h.deliver(five.map(encodeMessage)), [{ i: 0, ok: false, error: 'batch', message: 'at most 2 messages a request' }])
      const [outcome] = await deliver([h.url], five)
      assert.deepEqual(outcome!.results.map((r) => [r.i, r.error ?? 'ok']), five.map((_, i) => [i, 'ok']))
      assert.equal((await reference.deliver(Array(101).fill('x')))[0]!.error, 'batch')
    } finally {
      await h.close()
      await reference.close()
    }
  })
})

describe('pulling', () => {
  test('only the profile’s main key pulls: another profile’s key, an access key, or a changed request is refused as signature', async () => {
    const h = await hostWith(ANYONE)
    try {
      await deliver([h.url], [await note()])
      await publish([h.url], [permissionsRecord(alice, [allow(accessKey, ['offer'])], T0)])
      const mine = pullRequest(alice, 0, T0)
      assert.equal((await pull(h.url, mine)).messages.length, 1)
      assert.equal(await refusal(pull(h.url, { ...pullRequest(bob, 0, T0), profile: alice.address })), 'signature')
      assert.equal(await refusal(pull(h.url, { ...pullRequest(accessKey, 0, T0), profile: alice.address })), 'signature', 'an access key Alice listed')
      assert.equal(await refusal(pull(h.url, { ...pullRequest(aliceBuyer, 0, T0), profile: alice.address })), 'signature', 'the same person’s other profile')
      assert.equal(await refusal(pull(h.url, { ...mine, after: 1 })), 'signature')
      // Bob's own pull is fine, and finds nothing: messages go to their recipient only.
      assert.equal((await pull(h.url, pullRequest(bob, 0, T0))).messages.length, 0)
    } finally {
      await h.close()
    }
  })

  test('a pull is signed within ten minutes of the host’s clock, either way: stale', async () => {
    const h = await hostWith(ANYONE)
    try {
      for (const [time, result] of [[T0 - 10 * MINUTE, 'ok'], [T0 + 10 * MINUTE, 'ok'], [T0 - 10 * MINUTE - 1, 'stale'], [T0 + 10 * MINUTE + 1, 'stale']] as const) {
        assert.equal(await refusal(pulled(h, 0, time)), result, String(time - T0))
      }
    } finally {
      await h.close()
    }
  })

  test('a pull answers that profile’s messages after the cursor, in arrival order, paged as the host chooses', async () => {
    const h = await hostWith(ANYONE, { maxPageRecords: 2 })
    try {
      await publish([h.url], [ownerRecord(aliceBuyer, 'profile', { ...card(ANYONE, 'A.'), read: aliceBuyerRead.recipient }, T0)])
      const toBuyer = await message(bob, aliceBuyer.address, { text: 'for the buyer' }, T0, aliceBuyerRead.recipient)
      const texts = ['one', 'two', 'three', 'four', 'five']
      for (const [i, text] of texts.entries()) await deliver([h.url], i === 2 ? [toBuyer, await note(bob, text)] : [await note(i % 2 ? stranger : bob, text)])
      const got: string[] = []
      let cursor = 0
      for (let pages = 0; ; pages++) {
        const page = await pulled(h, cursor)
        assert.ok(page.messages.length <= 2)
        for (const c of page.messages) got.push((await openMessage(c.message, aliceRead.identity)).body.text as string)
        if (page.cursor === cursor) {
          assert.equal(pages, 3)
          break
        }
        cursor = page.cursor
      }
      assert.deepEqual(got, texts)
      assert.deepEqual((await pulled(h, cursor)).messages, [], 'nothing new since the cursor')
      assert.equal((await pulled(h, 0, T0, aliceBuyer)).messages.length, 1)
    } finally {
      await h.close()
    }
  })

  test('a pull is a POST, so no URL carries it; GET is 405, and a pull that is not canonical is refused', async () => {
    const h = await hostWith(ANYONE)
    try {
      assert.equal((await fetch(`${h.url}/v1/inbox/pull`)).status, 405)
      assert.equal((await fetch(`${h.url}/v1/inbox`)).status, 405)
      const res = await fetch(`${h.url}/v1/inbox/pull`, { method: 'POST', body: JSON.stringify(pullRequest(alice, 0, T0), null, 1) })
      assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [400, 'canonical'])
    } finally {
      await h.close()
    }
  })

  test('a host that slips in a forged message, or one to someone else: the reader refuses each', async () => {
    const h = await hostWith(ANYONE)
    try {
      const m = await note()
      await deliver([h.url], [m])
      const toBob = await message(alice, bob.address, { text: 'x' }, T0, aliceRead.recipient)
      const serve = h.pull.bind(h)
      h.pull = (text, now) => {
        const out = serve(text, now)
        return { lines: [...out.lines, encodeMessage({ ...m, time: T0 + 1 }), encodeMessage(toBob)], cursor: out.cursor }
      }
      const page = await pulled(h)
      assert.equal(page.messages.length, 1)
      assert.deepEqual(page.refused.map((r) => r.reason), ['signature', 'to'])
    } finally {
      await h.close()
    }
  })
})

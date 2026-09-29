// Finding a profile's hosts from its key alone, with no directory: a Pkarr packet signed by the
// profile key, through the official Pkarr client, against a stand-in relay (no UDP here, so the
// Mainline DHT itself is not exercised).

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Relay, checkPayload, hostsFromPayload, hostsPayload, publishPayload, resolveHosts, z32decode, z32encode } from '../src/discovery.ts'
import { T0, alice, bob } from './fixtures.ts'

describe('Pkarr discovery', () => {
  const relay = new Relay()
  let url: string
  before(async () => {
    url = await relay.listen()
  })
  after(() => relay.close())

  test('z-base-32 round-trips and matches the Pkarr client', () => {
    assert.deepEqual(z32decode(z32encode(alice.publicKey)), alice.publicKey)
  })

  test('the profile key signs its host list; any reader with only the key finds the hosts', async () => {
    const hosts = ['https://h1.example', 'https://h2.example']
    const payload = hostsPayload(alice, hosts, T0)
    assert.deepEqual(hostsFromPayload(alice.publicKey, payload), hosts)
    assert.deepEqual(await publishPayload([url], alice.did, payload), [204])
    assert.deepEqual(await resolveHosts([url], alice.did), hosts)
  })

  test('an older packet cannot replace a newer one; a packet signed by another key is refused', async () => {
    assert.deepEqual(await publishPayload([url], alice.did, hostsPayload(alice, ['https://old.example'], T0 - 1000)), [409])
    assert.deepEqual(await publishPayload([url], alice.did, hostsPayload(bob, ['https://evil.example'], T0 + 1000)), [400])
    assert.equal(checkPayload(alice.publicKey, hostsPayload(bob, ['https://evil.example'], T0)), null)
  })

  test('eight long host names still fit the 1000-byte packet', () => {
    const hosts = Array.from({ length: 8 }, (_, i) => `https://host-number-${i}.a-rather-long-hosting-provider.example`)
    const payload = hostsPayload(alice, hosts, T0)
    assert.ok(payload.length - 72 < 1000, `packet is ${payload.length - 72} bytes`)
    assert.deepEqual(hostsFromPayload(alice.publicKey, payload), hosts)
  })

  test('a relay that tampers with the packet: the official client refuses it', async () => {
    relay.tamper = (payload) => {
      const copy = payload.slice()
      copy[copy.length - 1]! ^= 1
      return copy
    }
    try {
      const got = await resolveHosts([url], alice.did).catch((err: Error) => err)
      assert.ok(got === null || got instanceof Error, `tampered packet was accepted: ${JSON.stringify(got)}`)
    } finally {
      relay.tamper = undefined
    }
  })
})

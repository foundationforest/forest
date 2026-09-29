// Live, over the internet: a profile's signed host list, put on a public Pkarr relay that nobody
// runs for Forest, read back byte for byte, resolved through the official client, and found by
// other public relays, which fetch from the Mainline DHT. From PR #35, on this lab's discovery
// code. Not part of `npm test`: run `npm run test:net` (PKARR_RELAY and PKARR_OTHER_RELAYS pick
// other relays).

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { hostsFromPayload, hostsPayload, publishPayload, resolveHosts, z32encode } from '../../src/discovery.ts'
import { keyFromSecret } from '../../src/keys.ts'

const RELAY = process.env.PKARR_RELAY ?? 'https://relay.pkarr.org'
const OTHERS = (process.env.PKARR_OTHER_RELAYS ?? 'https://pkarr.pubky.org,https://pkarr.pubky.app').split(',')

test('a signed host list is stored by a public relay nobody runs for Forest, and resolves back', async (t) => {
  const key = keyFromSecret(randomBytes(32)) // a fresh profile key: nothing of anyone's goes out
  const hosts = ['https://host-one.example', 'https://host-two.example']
  const now = Date.now()
  const payload = hostsPayload(key, hosts, now)

  const [put] = await publishPayload([RELAY], key.did, payload)
  assert.ok(put! >= 200 && put! < 300, `the relay took it (${put})`)
  const res = await fetch(`${RELAY}/${z32encode(key.publicKey)}`)
  assert.equal(res.status, 200)
  const back = new Uint8Array(await res.arrayBuffer())
  assert.deepEqual(Buffer.from(back), Buffer.from(payload), 'byte for byte what was put')
  assert.deepEqual(hostsFromPayload(key.publicKey, back), hosts, 'and its signature checks')
  assert.deepEqual(await resolveHosts([RELAY], key.did), hosts, 'through the official client too')

  // Other public relays, never sent the packet, find it: from the DHT, unless they share storage
  // with the first, which this test cannot rule out.
  const found: string[] = []
  for (const other of OTHERS) {
    for (let attempt = 0; attempt < 5 && !found.includes(other); attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 3000))
      const got = await fetch(`${other}/${z32encode(key.publicKey)}`).catch(() => null)
      if (got?.status === 200 && JSON.stringify(hostsFromPayload(key.publicKey, new Uint8Array(await got.arrayBuffer()))) === JSON.stringify(hosts)) found.push(other)
    }
  }
  assert.ok(found.length > 0, `no other relay found it: ${OTHERS.join(', ')}`)

  const [older] = await publishPayload([RELAY], key.did, hostsPayload(key, ['https://stale.example'], now - 1000))
  assert.ok(older! >= 400, `an older packet is refused (${older})`)
  t.diagnostic(`${RELAY}: put ${put}, get 200, older put ${older}; found by ${found.join(', ')}; key ${z32encode(key.publicKey)}`)
})

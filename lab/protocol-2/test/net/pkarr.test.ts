// Network: the pointer goes through a public Pkarr relay onto the Mainline DHT and comes back.
// Needs the network; run with `npm run test:net`. A fresh random key is used each run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delegateKeys } from '../../src/keys.ts'
import { PkarrRelay, resolvePointer, signPointer, verifyPointer } from '../../src/pointer.ts'

const RELAY = process.env.PKARR_RELAY ?? 'https://relay.pkarr.org'

test('a signed pointer is stored by a public relay nobody runs for Forest, and resolves back', async () => {
  const { signer } = delegateKeys()
  const relay = new PkarrRelay(RELAY)
  const { payload, pointer } = signPointer(signer, ['https://host-one.example', 'https://host-two.example'])
  await relay.put(signer.did, payload)
  const back = await relay.get(signer.did)
  assert.ok(back, 'the relay returned a payload')
  assert.deepEqual(Buffer.from(back!), Buffer.from(payload), 'byte for byte what was put')
  assert.deepEqual(verifyPointer(signer.did, back!), pointer)
  const found = await resolvePointer(signer.did, [relay])
  assert.deepEqual(found!.pointer.hosts, ['https://host-one.example', 'https://host-two.example'])
  // A lower sequence is refused by the relay, as the DHT's rule says.
  const older = signPointer(signer, ['https://stale.example'], pointer.seq - 1)
  await assert.rejects(relay.put(signer.did, older.payload))
})

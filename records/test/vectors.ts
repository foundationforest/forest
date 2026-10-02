// The spec's test vectors, from the fixed test seed (test/keys.json). Ed25519 is deterministic, so
// these never change unless the protocol does. `node test/vectors.ts` prints them;
// vectors.test.ts checks them against test/vectors.json.

import { createHash } from 'node:crypto'
import { hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type Entry, entryId, signingInput, unsignedOf } from '../src/entry.ts'
import { boxKey } from '../src/sealed.ts'
import { delegateEntry, folderEntry, grantEntry, ownerEntry } from '../src/write.ts'
import { SEED, alice, signer } from './fixtures.ts'

const TIME = 1_790_000_000_000 // 2026-09-21T13:33:20Z

const describe = (entry: Entry) => ({
  wire: canonical(entry),
  signingInputHex: hex.encode(signingInput(unsignedOf(entry))),
  id: entryId(unsignedOf(entry)),
})

export async function vectors() {
  const box = await boxKey(SEED, 0)
  const folder = folderEntry(alice, { hosts: ['https://host-a.example', 'https://host-b.example'], box: box.recipient, keep: 30 }, TIME)
  const offer = ownerEntry(
    alice,
    'offer/maths',
    { direction: 'offer', description: 'One hour of maths tutoring, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, createdAt: '2026-09-21T13:33:20Z' },
    TIME,
  )
  const { entry: grant, grantId } = grantEntry(alice, 'signer1', { to: signer.did, paths: ['offer'], until: TIME + 7 * 86_400_000, label: 'My signer, offers only' }, TIME)
  const delegated = delegateEntry(signer, alice.did, grantId, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: '2026-09-21T13:34:20Z' }, TIME + 60_000)
  const deleted = ownerEntry(alice, 'offer/maths', null, TIME + 120_000)
  return {
    about: 'Forest data protocol vectors. Seed: test/keys.json prf -> seed; profile 0; the delegate key is 32 bytes of 0x2a.',
    profile: { index: 0, did: alice.did, address: alice.address, publicKeyHex: hex.encode(alice.publicKey) },
    boxRecipientSha256: createHash('sha256').update(box.recipient).digest('hex'),
    delegate: { did: signer.did },
    folder: describe(folder),
    offer: describe(offer),
    grant: describe(grant),
    delegated: describe(delegated),
    deleted: describe(deleted),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await vectors(), null, 2))

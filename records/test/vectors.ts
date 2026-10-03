// The spec's test vectors. The keys are keys/'s: its test seed (bytes 00 01 … 1f), its
// tutoring/seller profile and that profile's reading key, pinned in keys/test/vectors.json and not
// repeated here. Ed25519 is deterministic, so these never change unless the protocol does.
// `node test/vectors.ts` prints them; vectors.test.ts checks them against test/vectors.json, each
// with a second implementation.

import { hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type SignedRecord, recordId, signingInput, unsignedOf } from '../src/record.ts'
import { accessRecord, hostsRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { KEYS, accessKey, alice } from './fixtures.ts'

const TIME = 1_790_000_000_000 // 2026-09-21T13:33:20Z

const describe = (record: SignedRecord) => ({
  wire: canonical(record),
  signingInputHex: hex.encode(signingInput(unsignedOf(record))),
  id: recordId(unsignedOf(record)),
})

export async function vectors() {
  const reading = KEYS.profiles[0].reading
  const offer = { direction: 'offer', description: 'One hour of maths tutoring, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, createdAt: '2026-09-21T13:33:20Z' }
  return {
    about: "Forest records vectors. The profile is keys/'s tutoring/seller profile, from its test seed, and the profile record's read field is that profile's reading key: both are pinned in keys/test/vectors.json. The access key is the ed25519 key whose private key is 32 bytes of 0x2a.",
    profile: alice.address,
    accessKey: accessKey.address,
    hosts: describe(hostsRecord(alice, ['https://host-a.example', 'https://host-b.example'], TIME)),
    profileCard: describe(ownerRecord(alice, 'profile', { market: 'tutoring', role: 'seller', name: 'Ana', read: reading.recipient, createdAt: '2026-09-21T13:33:20Z' }, TIME)),
    offer: describe(ownerRecord(alice, 'offer/maths', offer, TIME)),
    permissions: describe(permissionsRecord(alice, [{ key: accessKey.address, paths: ['offer'], until: TIME + 7 * 86_400_000 }], TIME)),
    written: describe(accessRecord(accessKey, alice.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: '2026-09-21T13:34:20Z' }, TIME + 60_000)),
    deleted: describe(ownerRecord(alice, 'offer/maths', null, TIME + 120_000)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await vectors(), null, 2))

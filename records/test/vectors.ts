// The spec's test vectors, from a fixed seed. Ed25519 and HKDF are deterministic, so these never
// change unless the protocol does. `node test/vectors.ts` prints them; vectors.test.ts checks them
// against test/vectors.json, each with a second implementation.

import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { readingKey } from '../src/private.ts'
import { type SignedRecord, recordId, signingInput, unsignedOf } from '../src/record.ts'
import { hostsRecord, ownerRecord, permissionsRecord, writerRecord } from '../src/write.ts'
import { SEED, alice, writer } from './fixtures.ts'

const TIME = 1_790_000_000_000 // 2026-09-21T13:33:20Z

const describe = (record: SignedRecord) => ({
  wire: canonical(record),
  signingInputHex: hex.encode(signingInput(unsignedOf(record))),
  id: recordId(unsignedOf(record)),
})

export async function vectors() {
  const reading = await readingKey(alice.secretKey)
  const offer = { direction: 'offer', description: 'One hour of maths tutoring, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, createdAt: '2026-09-21T13:33:20Z' }
  return {
    about: 'Forest records vectors. The seed is bytes 00 01 … 1f; the profile is its tutoring/seller profile; the writer key is the ed25519 key whose secret is 32 bytes of 0x2a.',
    seed: { hex: hex.encode(SEED), words: entropyToMnemonic(SEED, wordlist) },
    profile: { label: alice.label, secretKeyHex: hex.encode(alice.secretKey), publicKeyHex: hex.encode(alice.publicKey), address: alice.address },
    reading: { identity: reading.identity, recipient: reading.recipient },
    writer: { address: writer.address },
    hosts: describe(hostsRecord(alice, ['https://host-a.example', 'https://host-b.example'], TIME)),
    profileCard: describe(ownerRecord(alice, 'profile', { market: 'tutoring', role: 'seller', name: 'Ana', read: reading.recipient, createdAt: '2026-09-21T13:33:20Z' }, TIME)),
    offer: describe(ownerRecord(alice, 'offer/maths', offer, TIME)),
    permissions: describe(permissionsRecord(alice, [{ key: writer.address, paths: ['offer'], until: TIME + 7 * 86_400_000 }], TIME)),
    written: describe(writerRecord(writer, alice.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: '2026-09-21T13:34:20Z' }, TIME + 60_000)),
    deleted: describe(ownerRecord(alice, 'offer/maths', null, TIME + 120_000)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await vectors(), null, 2))

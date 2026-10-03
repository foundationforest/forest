// The spec's test vectors. The keys are keys/'s: its test seed (bytes 00 01 … 1f), its
// tutoring/seller and tutoring/buyer profiles and the seller's reading key, pinned in
// keys/test/vectors.json and not repeated here. Ed25519 is deterministic, and the one sealed body is
// pinned as made, so these never change unless the protocol does.
// `node test/vectors.ts` prints them; vectors.test.ts checks them against test/vectors.json, each
// with a second implementation.

import { hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type SignedMessage, messageId, messageSigningInput, pullRequest, pullSigningInput, signMessage, unsignedMessageOf } from '../src/message.ts'
import { type SignedRecord, recordId, signingInput, unsignedOf } from '../src/record.ts'
import { accessRecord, hostsRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { KEYS, accessKey, alice, aliceBuyer } from './fixtures.ts'

const TIME = 1_790_000_000_000 // 2026-09-21T13:33:20Z

/**
 * The message vector's body: { text: 'Is Tuesday at six free?' } sealed to tutoring/seller's reading
 * key, made once with makePrivate. age's sealing is random, so it is pinned as made.
 */
const SEALED = [
  'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0-IG1sa2VtNzY4eDI1NTE5IHFjMGhpQWYycEVrbGhiVURpWHg4d0tGMUh6Q2Jo',
  'dnZhS3RYS2J0RXlqN0l3VTQzZTJiS1J1RVFIbFJXUElIK2xOWnlINC9FUnpNTm9ReWIxTHlEa0RKNzg1YXREL1J5aW5y',
  'R09Vajg5cGxUL3AvS2l6N3IzU2IxZ1E1aVFpVVN1OUh6NVEyWlVpbmRramlGNzVCZno1NU5pZEtKYm9GVjFsaTNhUmZn',
  'TFh2MTYyZTdxdldVK2U0UzRsWnBKTmZCbUpvOHNqV2JLeDUrTjNYTGxvMll3SThGaWxWVkVzOG8zRzZKQ21aOTdtN0xy',
  'WG9BbjI2cjhqV1Fyck80U0tuSE5JMFhLTmdpY2dkcTBuMlBYSk4wVDA5ZUtaUDEzaXhQVEZTdHBKWUQxS2E5OGRwNFRY',
  'KzBjUTh1aDV0NS9MRDYyRTJVK20xWnBJYjJjbmd5OHNLVVloNkNYMFRybytrUGNUUkhhTExERVVTd3BxMW83N2luL2Fq',
  'Q2FleXJaYXgvQWczM3FoZVlKa2hCVXR4SnFONnpSM0dmejNZMGRzMlZXUDArVEpmc2hlQjFFR3BEVTloK3BmQkhYSEFY',
  'YkhhbW9KTlg4OEtsNnIva0pwYmVudEN2R1c0Y0dZUVN1cExsK2pNU1VObjBVMFZQR1JwNkRSMld3ZEg2SnhtdExRM0Fv',
  'blMwSm5zT1QraFVsT1JJREJpdTdnUmR4UktQUkY2M2JOTUo2bkVjUGJLQjBjSVZORmlTQ2JJQ0pNWGUwSFBRV3hDZmtV',
  'cWdxS0owcjR6MWlqOENjbkZ1Vi9NSnUwTmVkWm1tSlBlaWRSajFjNGVUT0JvQmxlMXRnTVNqbVBIRjRFWS9zcWhXSm5t',
  'aTdRRzVwTnZmTmRxQkJyMkxQajJUUFUwWmthb3JISTlBSTFpcXBRS09ZR0NUWGpMMWdFNVhTTWNsY3RIdEQrY2ltTE16',
  'Ymhlcm12TWNaNDZPa0FZdXhaY0lqNmVsUVZlOGFsZFNsQ3pOcm9tMms1TW10a1BtR2txWWlwSDZhOEl1Q2hyakdxa0Vi',
  'bm95d2xwTVlYUStySDVDbHg2d09VQmNoR1hnU3BlalU4aE8wdy9hekM5V3BOeGRWQTNjemxzdjhzZXhPanN6QmhsenUz',
  'NHR3YjVuY05xWi9rZXZFcmlWaWNKUmlvL1g5blp0NlNJLzcxR09NOUZxR3cwWlBwdjI3SENtMk5BOTVBZjNBL1hoK01W',
  'a1E3WXp0VmNaRSs5UGsyOFVwM0xXdjh1YVBsY2NGSk52WVhvQVhvMU1wbDVUUlFXemg2d0hMaTJWY1FUWEtPSEpnUktj',
  'S0R2alpNOXVhcjg5UnBiVUE5WUpmNmlpRzZ3QXh1ajg0VVhUN2RtNlJiTU5acjBpWjFtRjZmZlpwRXJOalFWejd6Y3l6',
  'REp0Ukh3VkxQYk5GUVhGZi9rcm9CWmxwUERyZ3JYcHlmaWlhNGdKc0x5RHRDMFAzTUFINEtLeXU4UXJOQU1jaVBKdGdp',
  'ZnFZdlJ3czd2dGJrajNkeE84MDQ2R3paZVZtckZtQXhJemRURkpINnVtNGZmWHNFZzF0VHVMWXpBZm95K3JyS0JCM0xp',
  'SStSVDdwOERRd2FWQmswdE1hY2lYcTVaUG01WHY1dFBYT2Y2TTJvckkwbEhYNlFUU3pqWTZqYUt0QzJlcGdxYVBSYUlM',
  'ams3eXcvN2Z1Y3B4VTJVa29pQzhRQU9YWXNTd0Y0Mmd1SWdydGFhdU9LZjQ4clJNVGU0Z29TM1VITExIaVpzZUFGVUpD',
  'SkV2VjloZWxZTklzY0pvQXpmUVpmV1lBZ3FsVVJYaS9WWXJ1S2ptQlhyVU1iZUVuTTVJRUY4NEpyRzRiazNjOFVOdUZy',
  'QWk0RGg5SXRlZDVHTmNSN2M5NzJLeEwvR0xpb0hXVll0eS8xTnZxUVNpZFFDcFkveWNSR1BMc2lFYUxHaFhVY094Sk4y',
  'Qm1HSDNrNFFJc21WTUJBdwowblhnUXBiNFlzQkdGWkRNY2tyRk53UWdtM1lQQzdiSzNQVlZycTY1WDhVCi0tLSBrbUFV',
  'ZzdpL3FoUVRqdkNYNDU5RHVTTGs5Z3EraVFZRkJNaDZKYjVWVGYwCjdh51Myi8XWqVQVJjdnMT7-WF8RLy499VZ21449',
  'FPrTfPVvbgweNd-_g4Gd4X5ON7Rn4GL4ieIWKf5-eubguN49MQ',
].join('')

const describe = (record: SignedRecord) => ({
  wire: canonical(record),
  signingInputHex: hex.encode(signingInput(unsignedOf(record))),
  id: recordId(unsignedOf(record)),
})

const describeMessage = (message: SignedMessage) => ({
  wire: canonical(message),
  signingInputHex: hex.encode(messageSigningInput(unsignedMessageOf(message))),
  id: messageId(unsignedMessageOf(message)),
})

export async function vectors() {
  const reading = KEYS.mainKeys[0].reading
  const pull = pullRequest(alice, 0, TIME + 240_000)
  const { sig: _sig, ...unsignedPull } = pull
  const offer = { direction: 'offer', description: 'One hour of maths tutoring, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, createdAt: '2026-09-21T13:33:20Z' }
  return {
    about: "Forest records vectors. The profile is keys/'s tutoring/seller profile, from its test seed, and the profile record's read field is that profile's reading key: both are pinned in keys/test/vectors.json. The access key is the ed25519 key whose private key is 32 bytes of 0x2a. The message is from keys/'s tutoring/buyer profile, from the same seed, to tutoring/seller; its body is sealed to tutoring/seller's reading key, made once and pinned as made, since age's sealing is random. The pull is tutoring/seller's, for everything.",
    profile: alice.address,
    accessKey: accessKey.address,
    hosts: describe(hostsRecord(alice, ['https://host-a.example', 'https://host-b.example'], TIME)),
    profileCard: describe(ownerRecord(alice, 'profile', { market: 'tutoring', role: 'seller', name: 'Ana', read: reading.recipient, createdAt: '2026-09-21T13:33:20Z' }, TIME)),
    offer: describe(ownerRecord(alice, 'offer/maths', offer, TIME)),
    permissions: describe(permissionsRecord(alice, [{ key: accessKey.address, paths: ['offer'], until: TIME + 7 * 86_400_000 }], TIME)),
    written: describe(accessRecord(accessKey, alice.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: '2026-09-21T13:34:20Z' }, TIME + 60_000)),
    deleted: describe(ownerRecord(alice, 'offer/maths', null, TIME + 120_000)),
    message: describeMessage(signMessage(aliceBuyer, alice.address, { private: SEALED }, TIME + 180_000)),
    pull: { wire: canonical(pull), signingInputHex: hex.encode(pullSigningInput(unsignedPull)) },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await vectors(), null, 2))

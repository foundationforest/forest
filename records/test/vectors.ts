// The spec's test vectors. The keys are keys/'s: its test seed (bytes 00 01 … 1f), its
// tutoring/seller and tutoring/buyer profiles and their inbox keys, pinned in keys/test/vectors.json
// and not repeated here. Ed25519 is deterministic, and the two sealed bodies and the sealed notes
// are pinned as made, so these never change unless the protocol does.
// `node test/vectors.ts` prints them; vectors.test.ts checks them against test/vectors.json, each
// with a second implementation.

import { hex } from '../src/bytes.ts'
import { canonical } from '../src/canonical.ts'
import { type SignedMessage, type SignedPull, messageId, messageSigningInput, pullRequest, pullSigningInput, signMessage, unsignedMessageOf } from '../src/message.ts'
import { type SignedRecord, recordId, signingInput, unsignedOf } from '../src/record.ts'
import { accessRecord, hostsRecord, ownerRecord, permissionsRecord } from '../src/write.ts'
import { KEYS, accessKey, alice, aliceBuyer, messageKey } from './fixtures.ts'

const TIME = 1_790_000_000_000 // 2026-09-21T13:33:20Z

/**
 * The message vector's body: { text: 'Is Tuesday at six free?' } sealed to tutoring/seller's inbox
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

/** The delegated vector's body: { text: 'Tuesday at six, yes.' } sealed to tutoring/buyer's inbox key, pinned as made. */
const SEALED_TO_BUYER = [
  'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0-IG1sa2VtNzY4eDI1NTE5IHJvN1FtZ2gybHBxMXpSc0p0blVCdVQ0b0pwMENnSG',
  't2SENLd1V2SHY4RXNCM0QwL2lNQXl6SWN1S3dFaXBQbGphaWxiQS9wYmQwNks1anpTaHBzSmVoRXlKOHAxeGlqcmozT0Zk',
  'ZW9uTm1ZRThQcVpqWVhGU1JaclpPNm5oRlNGcW55SXl3SzJvdXltNEMvaVBYZEpsTmNyTStLcHJWQjlDY2tlZ2hKYUcrdU',
  '5aaTBOVnoySVBVZFdtNDRQNG1XaXdLdFBYN3JwVUtka1RaNXJNUTRxVHN0UE55NmJMNk5WUDdMZjd5bTJ2NHVGNjlIR0Rw',
  'VWdrK3p5bVh5WlpDS1BiYnZlUDNyOVRFQlRidmZ0UjYyTWhLZXZibHY1ZmFhak5qanZ5dXdTckQ1elNaSDRXdDluZ0hlb2',
  'pKQVNpT1JWcnptR1J4Ums4RnRWdFBUaUxnYy84UEFISUNBNXBqb0UxeDA3SDYxVkluajh3UHBzNTdCalF2RFRKTWE1cGpD',
  'ZEQ3M2JWdHF3Uk5nMldLYWYzRG1WanozbkFxcUVubk5iSm5HZkFHQ1Arb3plOUlZU0xja1d5d00wNmFLVC9xOXVRTTJnSz',
  'ErT1A2a25tMkpqR1FVQy92bEwzODFpYUpPRjFTZnBnUWtYVThlUGdSdlB2Z003Uk5ROTNveEpJWTRockl0TzlCU0xtekxR',
  'NEJrbktVVG1oN1dkM3hiSjFxaThWazVDSnlSREJDQ2ZSUWlSc1B0RTl5ZUJHTjkxU3laSlJmVkJGTktCL2FSR25ub1VyWU',
  'ZOdmVkTkNFdk1sVmdncDJmT244RU9tUWgyVXdGdWhtZDg4akhwazNMVFlBNDREWmlmL0U4SU16eTRJT05lVjI1MzRVWVp0',
  'T0FnWnpxdys2RFRoVmFjUUFDOWdOc1pjVnlaVWpkeXppMlpyV0NtblI4U1A3QUo2dUVDVFg3ZGhqS20yQksvNk5ZTHk5dV',
  'd2bDRLZGl4UFVOT0FNdjUzRmpPUHoxYkhhWEdGUE5COElac0h1cUJ0MnMxd2JkK0k5WXkxakZWTHIyN0NibzBLSFhIUCtV',
  'TlVoSllXVDZXRVVPUVhpYXBMdWtCQkVCV0JaWnN6UHBtWmI1WXFBM3VCbFRram5xaEE0SkhrQXhvNXZsNm8veEsvVmhNRV',
  'NIeFc4OFFKRVlhM29mb0pwMTRGWWR1elRlaGtEdktvckhiaTdEcnBPRGNiVGV6ZTh1RHZnYW85WlhQOStuaUZMZ1dKR29Q',
  'NnRKVEF1U0s0L2pqVmFBQXpXK1d4MnU3WEl6bEZRNkRoNk5MaU1ma3hnMWtMM1FnVzR2NUxIbFgvaFVXS1dQRG40K0c5Ym',
  '5mOENzZjFKbGtSTnY3VWp1cmRUWC9KbUtoVVB0REFGRXJEaUZWQjJVOUphakk1Y3oxZ2hEYnEwRVcwTnRBLzhsL3VHaXBX',
  'cDhTZFcwMXJURFRPWiswK3NSb1BHMkpwdlRrT0VhRGRtMWF6M2JUNHgxZ09aTXdEVnpPN1JzSDZYQ3FCdmU1V09pRHVycG',
  '8yeDlha0hnRkFSZ252d3ZaUnZLYXV3c3BiZEFoOVpLZURlaHNseENKTHk1NmhQaW9EMTNSUEJoQm54V2ZYbG41cU5scVVp',
  'dTU1UzBQaXAycENEM21NcXVYRWgrTWh3ZjRIYUJLZUlkQUpIdVB1SlZxU2VLaDF3WXh0OEk4Q0tjVGJwaWZlNEhXaHduZV',
  'p5b09BNmNTeFJwUGtJaFJQUDU3NDN2THUyTWVZNitXSVgxb2xOSVdhbkVIZnk2MFJZTzgxczNaakpXYTM1dGNPU0xzMkpG',
  'V1hmUFFRaUNxckUrSE9ONi9BSjhJdzEycVcwejljR3RFWWEzSUtPWXJteHBnckh0enNzOFA5SStDd21LYktZTy93d0kyNF',
  'dUMHllT2NmZlVqK1pMTE9DWW5HdFBJTVZvQ0paN3dvVnl0THR4Wjk4Z2VHWjRuSy9Vc05hQQpzYWJGekU1Q0JMUWExKy96',
  'anVBbVZXRXkvSU9NV0piUjkwZWYySFF4VG1ZCi0tLSBWQWcxbWtJRFJlVkYrWm9ZNzdlQk1FbHFTZFpyaWZVYjdDZTJ1YT',
  'lrZWlVCnK9JqGWN4Ek5Sg4rxookqabPpk0nEFoSWdCfHpY8s1_mvq0xiNgBa5gbdVw6RPNtrY3FRMMqNIMyG_xZ0vdAw',
].join('')

/**
 * The past vector's notes: Alice's notes on her access key and her message key, in the grant shape
 * with each key's public half, sealed to tutoring/seller's inbox key alone, pinned as made.
 */
const SEALED_NOTES = [
  'YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0-IG1sa2VtNzY4eDI1NTE5ICtZNWQ1aVN0S0RwWnFMOStRZTNaak9zb2JibkJlMm',
  's0aXBrQ0tiVmpSTmxqdDg4UW5GRmNNU1dRc3l3WGxFT1JjeUtkWjh5R2N5TmJ6d0x5K1JTR2NNd2hFdVEvaGU1YXQ1d1V5',
  'M3VUS0VwemR4YWxWRjdxVVFka0JtaVpZWWVMUTk2SWdMdWxRaE0yVDJrdkhmSFVVL2lBSFBTMmZZMEZJTnRqZ21QSWsvUk',
  'F6RVEwSW13dVV3QjRvNE9xb1dkeERkbE5raEtUejN5QmdNcElXYUE1c1FMMUFUNGkzK0RES3RPTzZNNllCQlU3MHphYUxN',
  'VVU3MElIZlp4UjY2R25CYlJpL2tEbExKbUcrdlc3ejF0Q3N6dkxKZGwrTUZXb3psZm83ZGt6RndnL1dTSFZEMGlkV0xsWG',
  'hDaW9qOHRzZmJJenJndm9ySEh5dXJSUGIrN042QzJjbGpNL1E3VnA4ZW5Rdlp2ZHkybUM3N25HM0VJb2ptUitZN0hxcENG',
  'UWw3YW5WckJCczh6bGtzNGh3ejdFNHQ0d0xacGJUaGpueXk0K21NdVNyZmhENXZZNnE5ejRxZ0lKSkI4WkVjckRBTWdPbm',
  'liVWxneS9IK2ZJb2RodlZSTisvZ2VXVEltTDBZYXJpd2NhVE1oZVVMVlN2dlVkZENiNENUU0JNTFNlUTVYNTJoWlVpNmx5',
  'R2ptVklsa1FKMmxWNU1iNWN4ZFBFNDBHdkt3eC9xNlFidndDbm1OcSt4SGZlK0VubUZDeHp4NXg4aE9ncmVlK3RxTDhndl',
  'p1RWxpdkZPMCtFMjhaQ3paMWNDLzFyYkpVendhbjJ0WUVucXE4NllsOGZQS1ZrMTM5ZDMrKzZpUytBZkZOQmN6SWRDalJB',
  'Z2JzSUczeWtZWWJBdit2MStSUDhzd1dTTnpmb0VzamVMSUQ1cGUxRll4QmFSSDJEK2dPSnRmMTZqUGZPUjRYY0pNcVBjNE',
  'I0eENrVkkvQXhBM2lmOWJ1MlFDSmE3dFp1eUloWE1CRUlHa0hEMjlyVE1FK0pLVnJya2hhYVc2RURxekgxMUozT1BNVnhX',
  'ZHY4a2hRMGxxOEhCOUsydzE0NVpCQ0NSWHhGT1N6UTlUYUFQMEphaCtscmdNSXRDcWFKL0UrL3IwaXVnUnVqbDVJcVQrVF',
  'E3QzBtL21SU1MwOUNUblZwS2dGbXlGWmpJR3U3SmFpRmZPWjBFTUpqeEhZb3ZmRGtscFdSQmpMNyt5cDVLZ1FHZGtoc3pl',
  'MGl6RkdhTUJIK0RxcE4zK2FnYnNGR2JyMWk1R3c1SzhTMDAvTjlSR3ZWZFY0Y0FPM2xNclN2cy9vLzJwQ3dvVEdNa2RMdW',
  '1JUWlKaUNVVFp6RWFieHRTQXpVM1FNd04zWVJJWkFJNTRPOWFHWis1K1hxMFhKRXBqZjlabGdCZzRKbmZZRTJCeE0rTkFW',
  'U0ZSSElKTVVIdFZ6U0YzdWVGRVhxaVdQL1FlbmZ6NVVXNytrbTdkaWVBem1HaUxPMVpHOXpCTkdyV1pzSy9PLzNVN0prZn',
  'VUOVJUNkZYaDlkWnFiQlBBZE1zYi9YZWNQNVZsMnB3TURabTV4bEpvMzRiQWl6OU9PN01oYVRFREk4RTN0NG91YmxYYkJJ',
  'NzZ0OHpHUzREK0phN0c1YTRkWEVUcHpiNjNUTnpCQkcwZlNTbGR0TU5yVkgyd0JjcTNCcmdOVTZLZzAwb3pwcjNXUlJGb0',
  '1nNFBZd2xCTFgwbFBXaSt5dmtxcnpSSkg0Sk5LNzJ4L1dkcVNEWGVDU0dmVWdQaHhLQWs4TVBlVE9NSW5tQ3E2YjBDckNm',
  'Q1JFcXNWcTJqNTFOQTY2NFNhUzNtM0pyYTdDVFpXcmIwU3hNSHMrMmM0WnJNZnBSWUhVWUVpUWVrcEVINmR5UjZsU3FqTV',
  'dTeUQzczV1eTV3N1B0MkNrRmUxWnIrSXpCS2RUUUxGeTI2VnNKb2ZkSHZuc0xGN1gyOFpBQQpGcno3YzJOYm1JUFJaZHpa',
  'LzIzaGF5RGhCY2IxaHVldEp2cUFXVFh3dDAwCi0tLSBmZ1NBSXdicGJLaGtXbDdISTQ4Q1c5clk4SVJhUENVL3pseTRoSm',
  'hxcXhBCpsgOoc_pc4ymtG2dkgY7fSiE7KiwVANASRl6kmpN7533_d2pkPo1plnXW3Uncm8PxTSq9ueQCCJ_iqLFf4-kKCd',
  'g23iOLGQQmFnMDM5vB6xQScY2gmaxr8QRnlcZddLScpXqZ8A4kbHSjrbK3xCWogwAXNsSVQN7z32zLCyqgU7t60kn2p_Qp',
  'qcCNjR4xpP_cdWZOhcVm_giJsFFHN01E7vEpX-NWgF2wQWSVlyLrrXD1C6jJSYUwse9qDPKfjox5wcWnzp0dtdtpe2GOCG',
  'u4NmbxUERiJGv5xodwE8-z1ERbhMb1OGSSOQyR7lrDDKYw0VDeoeYiYCrF48X6Vzd5kEZw1tSrEWRSNgtMBpldDKsL1G7Q',
  'bvkfjKe4U6SWEkc4EcdtnIwuag9J9nmXadbFFgMirGLtn4gSNopX46H6JqV-WpdeOuBOEy-v9mKVLpScDkIjVKX2yAUzL8',
  'pFhrnSgDlHWpRn014dVaaNRo_h10wdgK_uvOYskhIASmoF68SSqDvIoqe-DiR7-HnPQ3zf9PLx62Lx0PiecTEEKeJKnP1O',
  'wMYkhPN1AHDCEMMRjmguH9BAj-ktV72Oe3EcAeIWG7nhkDiNgtrrMtFX8_o9luYhOqq19i7_pTcSaNemXPjKN8-OTHYf65',
  'yPoyLa9k8SoAymDc19bN7rv1HP5grRRskSQ4xbKAIKmjWgFHvmTSzLXMwJSbfWI7058HtB0J79fIzfJMDWFmOsg',
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

const describePull = (pull: SignedPull) => {
  const { sig: _sig, ...unsigned } = pull
  return { wire: canonical(pull), signingInputHex: hex.encode(pullSigningInput(unsigned)) }
}

export async function vectors() {
  const inbox = KEYS.mainKeys[0].inbox
  const hostA = 'https://host-a.example'
  const offer = { direction: 'offer', description: 'One hour of maths tutoring, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, createdAt: '2026-09-21T13:33:20Z' }
  return {
    about: "Forest records vectors. The profile is keys/'s tutoring/seller profile, from its test seed, and the profile record's inboxKey field is that profile's inbox key: both are pinned in keys/test/vectors.json. The access key is the ed25519 key whose private key is 32 bytes of 0x2a, listed with scope write; the message key is the one whose private key is 32 bytes of 0x2b, listed with scope message. The message is from keys/'s tutoring/buyer profile, from the same seed, to tutoring/seller; its body is sealed to tutoring/seller's inbox key. The delegated message is from tutoring/seller, signed by its message key and naming host-a, to tutoring/buyer; its body is sealed to tutoring/buyer's inbox key. Both bodies were made once and are pinned as made, since age's sealing is random. The pull is tutoring/seller's, for everything; keyPull is the same pull signed by its message key. past is a later permissions record in which the access key is past and the message key still listed, with notes on both keys sealed to tutoring/seller's inbox key alone, pinned as made.",
    profile: alice.address,
    accessKey: accessKey.address,
    messageKey: messageKey.address,
    hosts: describe(hostsRecord(alice, [hostA, 'https://host-b.example'], TIME)),
    profileCard: describe(ownerRecord(alice, 'profile', { market: 'tutoring', role: 'seller', name: 'Ana', inboxKey: inbox.recipient, createdAt: '2026-09-21T13:33:20Z' }, TIME)),
    offer: describe(ownerRecord(alice, 'offer/maths', offer, TIME)),
    permissions: describe(permissionsRecord(alice, [{ key: accessKey.address, scope: 'write', paths: ['offer'] }, { key: messageKey.address, scope: 'message' }], TIME)),
    written: describe(accessRecord(accessKey, alice.address, 'offer/physics', { direction: 'offer', description: 'Physics, one hour.', createdAt: '2026-09-21T13:34:20Z' }, TIME + 60_000)),
    deleted: describe(ownerRecord(alice, 'offer/maths', null, TIME + 120_000)),
    message: describeMessage(signMessage(aliceBuyer, alice.address, { private: SEALED }, TIME + 180_000)),
    delegated: describeMessage(signMessage({ key: messageKey, from: alice.address, host: hostA }, aliceBuyer.address, { private: SEALED_TO_BUYER }, TIME + 300_000)),
    pull: describePull(pullRequest(alice, 0, TIME + 240_000)),
    keyPull: describePull(pullRequest({ key: messageKey, profile: alice.address }, 0, TIME + 360_000)),
    past: describe(permissionsRecord(alice, [{ key: accessKey.address, was: 'write', paths: ['offer'] }, { key: messageKey.address, scope: 'message' }], TIME + 420_000, SEALED_NOTES)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await vectors(), null, 2))

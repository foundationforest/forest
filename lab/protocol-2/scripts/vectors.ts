// Generates test/vectors.json. Run once; the test then pins its output. Deterministic: fixed seed,
// fixed times, no private records (their nonces are random by design).
import { writeFileSync } from 'node:fs'
import { profileKeys, delegateKeys, signerFromPrivateKey } from '../src/keys.ts'
import { signEntry, type Unsigned } from '../src/entry.ts'
import { signPointer } from '../src/pointer.ts'
import { signPermit } from '../src/permit.ts'
import { b64, blobCid, toJson } from '../src/codec.ts'
import { hex } from '@scure/base'

const seed = hex.decode('3d9afcf6df255ce134686fc4f26d6cca0a57f82480f7b34d37e682546aaa72b0') // keys/test/vectors.json's seed
const p0 = await profileKeys(seed, 0)
const p1 = await profileKeys(seed, 1)
const agent = signerFromPrivateKey(hex.decode('0101010101010101010101010101010101010101010101010101010101010101'))
const at = 1_800_000_000
const entries: { name: string; unsigned: Unsigned }[] = []
const e0 = signEntry(p0.signer, { v: 1, did: p0.did, seq: 0, prev: null, at, op: 'keys', rec: { reader: p0.reader.did } })
const e1 = signEntry(p0.signer, { v: 1, did: p0.did, seq: 1, prev: e0.cid, at: at + 1, op: 'put', col: 'foundation.forest.profile', key: 'self', rec: { $type: 'foundation.forest.profile', name: 'Ana', market: 'online-tutors', role: 'seller', wallet: p0.wallet.address, createdAt: '2026-09-29T00:00:00Z' } })
const e2 = signEntry(p0.signer, { v: 1, did: p0.did, seq: 2, prev: e1.cid, at: at + 2, op: 'grant', rec: { to: agent.did, cols: ['foundation.forest.post'], ops: ['put'], exp: at + 86400, max: 10 } })
const e3 = signEntry(agent, { v: 1, did: p0.did, seq: 3, prev: e2.cid, at: at + 3, op: 'put', by: agent.did, via: e2.cid, col: 'foundation.forest.post', key: '3l5xkq2m', rec: { $type: 'foundation.forest.post', direction: 'offer', description: 'Portuguese lessons', createdAt: '2026-09-29T00:00:03Z' } })
const e4 = signEntry(p0.signer, { v: 1, did: p0.did, seq: 4, prev: e3.cid, at: at + 4, op: 'revoke', rec: { grant: e2.cid } })
const e5 = signEntry(p0.signer, { v: 1, did: p0.did, seq: 5, prev: e4.cid, at: at + 5, op: 'del', col: 'foundation.forest.post', key: '3l5xkq2m' })
const pointer = signPointer(p0.signer, ['https://host.example'], 1_800_000_000_000_000)
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const permit = signPermit(p0.signer, p0.did, blobCid(photo).toString(), at + 600)
const out = {
  about: 'Fixed test vectors for protocol-2. The seed is the one keys/test/vectors.json pins. Bytes are base64url unless named hex. Generated once by this implementation; changing any value here is a protocol change.',
  seed: hex.encode(seed),
  profiles: [p0, p1].map((p) => ({ index: p.index, did: p.did, reader: p.reader.did, wallet: p.wallet.address })),
  agent: { privateKeyHex: '0101010101010101010101010101010101010101010101010101010101010101', did: agent.did },
  entries: [e0, e1, e2, e3, e4, e5].map((e) => ({ cid: e.cid.toString(), bytes: b64.encode(e.bytes), entry: toJson(e.entry) })),
  pointer: { hosts: ['https://host.example'], seq: 1_800_000_000_000_000, payload: b64.encode(pointer.payload) },
  permit: { photo: b64.encode(photo), cid: blobCid(photo).toString(), exp: at + 600, bytes: b64.encode(permit) },
}
writeFileSync(new URL('../test/vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('vectors written', out.profiles[0]!.did, out.entries.length)

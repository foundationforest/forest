// Pinned vectors: the same seed and the same inputs give the same DIDs, entries, CIDs, pointer and
// permit, byte for byte. This is what makes SPEC.md exact: another implementation must produce these.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hex } from '@scure/base'
import { profileKeys, signerFromPrivateKey } from '../src/keys.ts'
import { applyEntry, decodeEntry, emptyState, signEntry, verifyLog, type Entry, type Unsigned } from '../src/entry.ts'
import { signPointer, verifyPointer } from '../src/pointer.ts'
import { signPermit } from '../src/permit.ts'
import { b64, blobCid, toJson } from '../src/codec.ts'

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const seed = hex.decode(vectors.seed)

test('vectors: keys from the pinned seed', async () => {
  for (const expected of vectors.profiles) {
    const p = await profileKeys(seed, expected.index)
    assert.equal(p.did, expected.did)
    assert.equal(p.reader.did, expected.reader)
    assert.equal(p.wallet.address, expected.wallet)
  }
  assert.equal(signerFromPrivateKey(hex.decode(vectors.agent.privateKeyHex)).did, vectors.agent.did)
})

test('vectors: the six entries re-sign to the same bytes and CIDs, and verify as one log', async () => {
  const p0 = await profileKeys(seed, 0)
  const agent = signerFromPrivateKey(hex.decode(vectors.agent.privateKeyHex))
  const bytes: Uint8Array[] = []
  for (const v of vectors.entries) {
    const stored = b64.decode(v.bytes)
    const { entry, cid } = decodeEntry(stored)
    assert.equal(cid.toString(), v.cid)
    assert.deepEqual(toJson(entry), v.entry)
    const { sig: _sig, ...unsigned } = entry
    const signer = entry.by === agent.did ? agent : p0.signer
    const again = signEntry(signer, unsigned as Unsigned)
    assert.equal(b64.encode(again.bytes), v.bytes, 'ed25519 is deterministic: the same bytes again')
    assert.equal(again.cid.toString(), v.cid)
    bytes.push(stored)
  }
  const state = verifyLog(p0.did, bytes)
  assert.equal(state.head!.seq, 5)
  assert.equal(state.records.size, 1, 'the post was deleted; the profile remains')
  assert.equal(state.grants.get(vectors.entries[2].cid)!.revokedAt, 4)
  assert.equal(state.grants.get(vectors.entries[2].cid)!.used, 1)
  // Any entry out of order fails.
  let s = emptyState(p0.did)
  const e = bytes.map((b) => decodeEntry(b))
  s = applyEntry(s, e[0]!.entry as Entry, e[0]!.cid)
  assert.throws(() => applyEntry(s, e[2]!.entry as Entry, e[2]!.cid))
})

test('vectors: the pointer and the permit', async () => {
  const p0 = await profileKeys(seed, 0)
  const pointer = signPointer(p0.signer, vectors.pointer.hosts, vectors.pointer.seq)
  assert.equal(b64.encode(pointer.payload), vectors.pointer.payload)
  assert.deepEqual(verifyPointer(p0.did, b64.decode(vectors.pointer.payload)), { did: p0.did, hosts: vectors.pointer.hosts, seq: vectors.pointer.seq })
  const photo = b64.decode(vectors.permit.photo)
  assert.equal(blobCid(photo).toString(), vectors.permit.cid)
  assert.equal(b64.encode(signPermit(p0.signer, p0.did, vectors.permit.cid, vectors.permit.exp)), vectors.permit.bytes)
})

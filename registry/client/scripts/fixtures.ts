// Generate the real proofs and the wire vectors the LiteSVM tests run against, with the pinned
// ceremony artifacts.
//
//   npm run fixtures            (after `npm run fetch` in ../artifacts)
//
// Writes ../program/tests-litesvm/fixtures/proofs.json. The file is committed so `cargo test`
// needs nothing but Rust; this script is what proves the file was not written by hand.
//
// The `wire` section is the client's own bytes for one line's register, add_proof and refund, and
// the bytes that line should hold. The Rust harness encodes the same instructions by hand and must
// get the same bytes, the program must write exactly that line, and the client's tests decode it:
// the wire format written twice, checked against each other.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256 } from '@noble/hashes/sha2.js'
import { Identity } from '@semaphore-protocol/identity'
import { Keypair, PublicKey } from '@solana/web3.js'

import { profileKey } from '../../../keys/src/index.ts'
import { commitmentOf } from '../src/code.ts'
import { MESSAGE_NS, SCOPE_NS, toBytes32 } from '../src/field.ts'
import { LINE_DISCRIMINATOR, addProofIx, lineAddress, lineSpace, refundIx, registerIx } from '../src/program.ts'
import { listRoot, proveMembership } from '../src/proof.ts'

const here = dirname(fileURLToPath(import.meta.url))
const artifactDir = join(here, '../../artifacts')
const outPath = join(here, '../../program/tests-litesvm/fixtures/proofs.json')
const artifacts = {
  wasm: join(artifactDir, 'semaphore-32.wasm'),
  zkey: join(artifactDir, 'semaphore-32.zkey'),
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const fixtureKey = (name: string) => Keypair.fromSeed(sha256(new TextEncoder().encode(`forest registry fixture: ${name}`)))

// Alice is the keys recipe's pinned test seed: her identity secret and her profile 0 key, both
// derived through `keys/` itself, so the fixtures run from the seed to a verified proof. The others
// are plain bytes.
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(keysVectors.seed, 'hex')
const aliceProfile = await profileKey(seed, 0)
if (aliceProfile.address !== keysVectors.profiles[0].wallet) throw new Error("Alice's profile key is not the keys recipe's profile 0")
const secrets = {
  alice: Buffer.from(keysVectors.identity.secret, 'hex'),
  bob: Buffer.from('forest registry fixture: bob'),
  carol: Buffer.from('forest registry fixture: carol'),
}
if (commitmentOf(secrets.alice).toString() !== keysVectors.identity.commitment) throw new Error("Alice's commitment is not the keys recipe's")
const profiles = {
  alice: new PublicKey(aliceProfile.publicKey),
  bob: fixtureKey('profile bob').publicKey,
  carol: fixtureKey('profile carol').publicKey,
}

const labels = { tutoring: 'tutoring/seller', cleaning: 'cleaning/seller' }
// The longest label a line can carry: 128 bytes.
const longest = ['c'.repeat(42), 'm'.repeat(42), 'r'.repeat(42)].join('/')
if (Buffer.byteLength(longest) !== 128) throw new Error('the longest label is not 128 bytes')

// Two issuers' published lists. A holds Alice and Bob with strangers between them, so nobody is at
// index 0 or the end; B holds Carol and Alice. A also grows by one stranger at a time, fifteen
// times: the same issuer publishing newer roots, which gives Alice sixteen distinct roots in
// `tutoring/seller` from A and one from B, one more than a line holds.
const filler = (n: number) => commitmentOf(new Identity(Buffer.from(`forest registry fixture: filler ${n}`)))
const listA = [filler(1), commitmentOf(secrets.alice), filler(2), filler(3), commitmentOf(secrets.bob)]
const listB = [filler(4), commitmentOf(secrets.carol), filler(5), commitmentOf(secrets.alice)]
const growth = Array.from({ length: 15 }, (_, i) => filler(100 + i))
const listOf = (list: 'A' | 'B', grown: number) => (list === 'A' ? [...listA, ...growth.slice(0, grown)] : listB)

type Who = keyof typeof secrets
const cases: { name: string; who: Who; label: string; list: 'A' | 'B'; grown: number }[] = [
  { name: 'alice-tutoring-A', who: 'alice', label: labels.tutoring, list: 'A', grown: 0 },
  { name: 'alice-tutoring-B', who: 'alice', label: labels.tutoring, list: 'B', grown: 0 },
  { name: 'alice-cleaning-A', who: 'alice', label: labels.cleaning, list: 'A', grown: 0 },
  { name: 'bob-tutoring-A', who: 'bob', label: labels.tutoring, list: 'A', grown: 0 },
  { name: 'carol-tutoring-B', who: 'carol', label: labels.tutoring, list: 'B', grown: 0 },
  { name: 'alice-longest-A', who: 'alice', label: longest, list: 'A', grown: 0 },
  ...growth.map((_, i) => ({ name: `alice-tutoring-A${i + 1}`, who: 'alice' as Who, label: labels.tutoring, list: 'A' as const, grown: i + 1 })),
]

type FixtureProof = {
  name: string
  list: 'A' | 'B'
  grown: number
  label: string
  profile: string
  root: string
  code: string
  scope: string
  message: string
  a: string
  b: string
  c: string
  uncompressed: { a: string; b: string; c: string }
}
const proofs: FixtureProof[] = []
for (const c of cases) {
  const t0 = performance.now()
  const commitments = listOf(c.list, c.grown)
  const p = await proveMembership({ secret: secrets[c.who], label: c.label, profile: profiles[c.who], commitments, artifacts })
  if (p.root !== listRoot(commitments)) throw new Error(`${c.name}: the proof's root is not the list's`)
  console.log(`${c.name}: ${Math.round(performance.now() - t0)} ms, code ${p.code}`)
  proofs.push({
    name: c.name,
    list: c.list,
    grown: c.grown,
    label: c.label,
    profile: profiles[c.who].toBase58(),
    root: hex(toBytes32(p.root)),
    code: hex(toBytes32(p.code)),
    scope: hex(toBytes32(p.scope)),
    message: hex(toBytes32(p.message)),
    a: hex(p.proof.a),
    b: hex(p.proof.b),
    c: hex(p.proof.c),
    // snarkjs's own points, so the Rust side can check that decompressing what the client wrote
    // gives back exactly these.
    uncompressed: {
      a: hex(Buffer.concat([toBytes32(BigInt(p.raw.pi_a[0])), toBytes32(BigInt(p.raw.pi_a[1]))])),
      b: hex(
        Buffer.concat([
          toBytes32(BigInt(p.raw.pi_b[0][1])),
          toBytes32(BigInt(p.raw.pi_b[0][0])),
          toBytes32(BigInt(p.raw.pi_b[1][1])),
          toBytes32(BigInt(p.raw.pi_b[1][0])),
        ]),
      ),
      c: hex(Buffer.concat([toBytes32(BigInt(p.raw.pi_c[0])), toBytes32(BigInt(p.raw.pi_c[1]))])),
    },
  })
}

// The wire vectors: Alice's `tutoring/seller` line, registered against A and extended with B, paid
// by a fixed key at a fixed time, as the client writes it.
const byName = (name: string) => proofs.find((p) => p.name === name)!
const onWire = (p: FixtureProof) => ({
  root: Buffer.from(p.root, 'hex'),
  proof: { a: Buffer.from(p.a, 'hex'), b: Buffer.from(p.b, 'hex'), c: Buffer.from(p.c, 'hex') },
})
const first = byName('alice-tutoring-A')
const second = byName('alice-tutoring-B')
const code = Buffer.from(first.code, 'hex')
const payer = fixtureKey('payer')
const time = 1_790_000_000n
const register = registerIx({ profile: profiles.alice, label: first.label, code, proof: onWire(first), payer: payer.publicKey })
const addProof = addProofIx({ code, proof: onWire(second), payer: payer.publicKey })
const refund = refundIx({ code, payer: payer.publicKey })
const label = Buffer.from(first.label, 'utf8')
const timeBytes = Buffer.alloc(8)
timeBytes.writeBigInt64LE(time)
const bump = PublicKey.findProgramAddressSync([Buffer.from('code'), code], register.programId)[1]
const lineBytes = Buffer.concat([
  LINE_DISCRIMINATOR,
  profiles.alice.toBytes(),
  code,
  payer.publicKey.toBytes(),
  timeBytes,
  Buffer.from([bump]),
  Buffer.from(Uint32Array.of(label.length).buffer),
  label,
  Buffer.from(Uint32Array.of(2).buffer),
  Buffer.from(first.root, 'hex'),
  Buffer.from(second.root, 'hex'),
])
if (lineBytes.length !== lineSpace(label.length, 2)) throw new Error('the expected line is not its own size')

const out = {
  note: 'Generated by registry/client/scripts/fixtures.ts. Real proofs, real ceremony artifacts.',
  artifacts: {
    ceremony: 'Semaphore 4.0.0, the public July 2024 ceremony',
    depth: 32,
    zkeySha256: sha256File(artifacts.zkey),
    wasmSha256: sha256File(artifacts.wasm),
  },
  scopeNamespace: SCOPE_NS,
  messageNamespace: MESSAGE_NS,
  messageLayout: 'keccak256(messageNamespace || profile key (32 bytes)) >> 8',
  lists: {
    A: listA.map(String),
    B: listB.map(String),
    growth: growth.map(String),
  },
  proofs,
  wire: {
    what: "Alice's tutoring/seller line: register against list A, then add_proof with list B, paid by payerSeed's key at time",
    programId: register.programId.toBase58(),
    payer: payer.publicKey.toBase58(),
    payerSeed: hex(sha256(new TextEncoder().encode('forest registry fixture: payer'))),
    time: Number(time),
    lineAddress: lineAddress(code).toBase58(),
    register: hex(register.data),
    addProof: hex(addProof.data),
    refund: hex(refund.data),
    line: hex(lineBytes),
  },
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${outPath}`)
process.exit(0)

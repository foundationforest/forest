// Generate the real proofs and the wire vectors the LiteSVM tests run against, with the pinned
// ceremony artifacts.
//
//   npm run fixtures            (after `npm run fetch` in ../artifacts)
//
// Writes ../program/tests-litesvm/fixtures/proofs.json. The file is committed so `cargo test`
// needs nothing but Rust; this script is what proves the file was not written by hand.
//
// The `wire` section is the client's own bytes for one row's register and refund, and the bytes
// that row should hold. The Rust harness encodes the same instructions by hand and must get the
// same bytes, the program must write exactly that row, and the client's tests decode it: the wire
// format written twice, checked against each other.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Keypair, PublicKey } from '@solana/web3.js'

import { listSecret, mainKey } from '../../../keys/src/index.ts'
import { MESSAGE_NS, SCOPE_NS, toBytes32 } from '../src/field.ts'
import { rootBytes } from '../src/issuer.ts'
import { ROW_DISCRIMINATOR, refundIx, registerIx, rowAddress, rowSpace } from '../src/program.ts'
import { listRoot, proveStamp } from '../src/proof.ts'
import { stampOf } from '../src/stamp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const artifactDir = join(here, '../../artifacts')
const outPath = join(here, '../../program/tests-litesvm/fixtures/proofs.json')
const artifacts = {
  wasm: join(artifactDir, 'semaphore-32.wasm'),
  zkey: join(artifactDir, 'semaphore-32.zkey'),
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
/** A fixed key for a fixture: its 32-byte private seed is sha256 of a name. Test keys only. */
const seedOf = (name: string) => sha256(new TextEncoder().encode(`forest registry fixture: ${name}`))
const fixtureKey = (name: string) => Keypair.fromSeed(seedOf(name))

// Two issuers, each with its own list. Their names still say `keeper`: a name is its key's seed,
// and a new name would make new keys and so every proof here new.
const issuers = { A: fixtureKey('keeper A'), B: fixtureKey('keeper B') }
type List = keyof typeof issuers

// Alice is the test person: keys/'s pinned test seed (keys/test/vectors.json). Her secret for each
// list comes from it and the issuer's address, and her two profiles are its tutoring/seller and
// tutoring/buyer profiles, all through `keys/` itself. Bob and Carol are plain bytes, on one list
// each, with fixed main keys: the registry does not care how a main key was made.
const keysVectors = JSON.parse(readFileSync(join(here, '../../../keys/test/vectors.json'), 'utf8'))
const seed = Buffer.from(keysVectors.seed, 'hex')
const secrets = {
  'alice on A': (await listSecret(seed, issuers.A.publicKey.toBase58())).secret,
  'alice on B': (await listSecret(seed, issuers.B.publicKey.toBase58())).secret,
  'bob on A': Buffer.from('forest registry fixture: bob on A'),
  'carol on B': Buffer.from('forest registry fixture: carol on B'),
}
type Who = keyof typeof secrets

const profileSeeds = {
  alice: (await mainKey(seed, 'tutoring/seller')).privateKey,
  'alice 2': (await mainKey(seed, 'tutoring/buyer')).privateKey,
  bob: seedOf('profile bob'),
  carol: seedOf('profile carol'),
}
type Profile = keyof typeof profileSeeds
for (const [i, name] of (['alice', 'alice 2'] as const).entries()) {
  if (Keypair.fromSeed(profileSeeds[name]).publicKey.toBase58() !== keysVectors.mainKeys[i].address) throw new Error(`${name} is not keys/'s profile`)
}

const labels = { tutoring: 'tutoring/seller', cleaning: 'cleaning/seller' }
// The longest label a row can carry: 128 bytes.
const longest = ['c'.repeat(42), 'm'.repeat(42), 'r'.repeat(42)].join('/')
if (Buffer.byteLength(longest) !== 128) throw new Error('the longest label is not 128 bytes')

// Each issuer's published list. A holds Alice and Bob with strangers between them, so nobody is
// at index 0 or the end; B holds Carol and Alice.
const filler = (n: number) => stampOf(Buffer.from(`forest registry fixture: filler ${n}`))
const lists: Record<List, bigint[]> = {
  A: [filler(1), stampOf(secrets['alice on A']), filler(2), filler(3), stampOf(secrets['bob on A'])],
  B: [filler(4), stampOf(secrets['carol on B']), filler(5), stampOf(secrets['alice on B'])],
}
const signatures = Object.fromEntries(
  (Object.keys(issuers) as List[]).map((l) => [l, ed25519.sign(rootBytes(listRoot(lists[l])), seedOf(`keeper ${l}`))]),
) as Record<List, Uint8Array>

const cases: { name: string; who: Who; profile: Profile; label: string; list: List }[] = [
  { name: 'alice-tutoring-A', who: 'alice on A', profile: 'alice', label: labels.tutoring, list: 'A' },
  // The same person, list and label for a second profile: the same market stamp, so one row only.
  { name: 'alice-tutoring-A-second-profile', who: 'alice on A', profile: 'alice 2', label: labels.tutoring, list: 'A' },
  // The second profile under the same label through another issuer: another market stamp.
  { name: 'alice-tutoring-B', who: 'alice on B', profile: 'alice 2', label: labels.tutoring, list: 'B' },
  { name: 'alice-cleaning-A', who: 'alice on A', profile: 'alice', label: labels.cleaning, list: 'A' },
  { name: 'bob-tutoring-A', who: 'bob on A', profile: 'bob', label: labels.tutoring, list: 'A' },
  { name: 'carol-tutoring-B', who: 'carol on B', profile: 'carol', label: labels.tutoring, list: 'B' },
  { name: 'alice-longest-A', who: 'alice on A', profile: 'alice', label: longest, list: 'A' },
]

type FixtureProof = {
  name: string
  list: List
  issuer: string
  label: string
  profile: string
  profileSeed: string
  root: string
  issuerSignature: string
  marketStamp: string
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
  const stamps = lists[c.list]
  const profile = Keypair.fromSeed(profileSeeds[c.profile])
  const p = await proveStamp({ secret: secrets[c.who], label: c.label, profile: profile.publicKey, stamps, artifacts })
  if (p.root !== listRoot(stamps)) throw new Error(`${c.name}: the proof's root is not the list's`)
  console.log(`${c.name}: ${Math.round(performance.now() - t0)} ms, market stamp ${p.marketStamp}`)
  proofs.push({
    name: c.name,
    list: c.list,
    issuer: issuers[c.list].publicKey.toBase58(),
    label: c.label,
    profile: profile.publicKey.toBase58(),
    profileSeed: hex(profileSeeds[c.profile]),
    root: hex(toBytes32(p.root)),
    issuerSignature: hex(signatures[c.list]),
    marketStamp: hex(toBytes32(p.marketStamp)),
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
const byName = (name: string) => proofs.find((p) => p.name === name)!
if (byName('alice-tutoring-A').marketStamp !== byName('alice-tutoring-A-second-profile').marketStamp) throw new Error('one list, one label: one market stamp')
if (byName('alice-tutoring-A').marketStamp === byName('alice-tutoring-B').marketStamp) throw new Error('two lists: two market stamps')

// The wire vectors: Alice's `tutoring/seller` row against list A, paid by a fixed key, as the
// client writes it.
const first = byName('alice-tutoring-A')
const marketStamp = Buffer.from(first.marketStamp, 'hex')
const payer = fixtureKey('payer')
const profile = new PublicKey(first.profile)
const register = registerIx({
  profile,
  label: first.label,
  marketStamp,
  issuer: issuers.A.publicKey,
  root: Buffer.from(first.root, 'hex'),
  issuerSignature: Buffer.from(first.issuerSignature, 'hex'),
  proof: { a: Buffer.from(first.a, 'hex'), b: Buffer.from(first.b, 'hex'), c: Buffer.from(first.c, 'hex') },
  payer: payer.publicKey,
})
const row = rowAddress(marketStamp)
const refund = refundIx({ row, payer: payer.publicKey })
const label = Buffer.from(first.label, 'utf8')
const bump = PublicKey.findProgramAddressSync([Buffer.from('row'), marketStamp], register.programId)[1]
const rowBytes = Buffer.concat([
  ROW_DISCRIMINATOR,
  profile.toBytes(),
  issuers.A.publicKey.toBytes(),
  Buffer.from(first.root, 'hex'),
  Buffer.from(first.issuerSignature, 'hex'),
  payer.publicKey.toBytes(),
  Buffer.from([bump]),
  Buffer.from(Uint32Array.of(label.length).buffer),
  label,
])
if (rowBytes.length !== rowSpace(label.length)) throw new Error('the expected row is not its own size')

const out = {
  note: 'Generated by registry/client/scripts/fixtures.ts. Real proofs, real ceremony artifacts. Every key here is a test key. Alice is keys/\'s test person: her list secrets and her two profiles (tutoring/seller, tutoring/buyer) come from keys/test/vectors.json\'s seed through keys/. Every other key\'s private seed is sha256 of "forest registry fixture: <name>".',
  artifacts: {
    ceremony: 'Semaphore 4.13.0, the public 2025 setup for the fixed circuit',
    depth: 32,
    zkeySha256: sha256File(artifacts.zkey),
    wasmSha256: sha256File(artifacts.wasm),
  },
  scopeNamespace: SCOPE_NS,
  messageNamespace: MESSAGE_NS,
  messageLayout: 'keccak256(messageNamespace || main key (32 bytes)) >> 8',
  issuers: Object.fromEntries((Object.keys(issuers) as List[]).map((l) => [l, issuers[l].publicKey.toBase58()])),
  lists: { A: lists.A.map(String), B: lists.B.map(String) },
  proofs,
  wire: {
    what: "Alice's tutoring/seller row: register against list A, paid by payerSeed's key",
    programId: register.programId.toBase58(),
    payer: payer.publicKey.toBase58(),
    payerSeed: hex(seedOf('payer')),
    rowAddress: row.toBase58(),
    register: hex(register.data),
    refund: hex(refund.data),
    row: hex(rowBytes),
  },
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${outPath}`)
process.exit(0)

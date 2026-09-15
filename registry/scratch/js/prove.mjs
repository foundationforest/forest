// Q1, Q2, Q7: generate real Semaphore proofs with the published artifacts at a given depth,
// time them, verify with snarkjs, and write everything the Rust side needs.
import { readFileSync, writeFileSync } from "node:fs"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof, verifyProof } from "@semaphore-protocol/proof"
import { unpackGroth16Proof } from "@zk-kit/utils/proof-packing"
import { groth16 } from "snarkjs"
import { keccak256 } from "ethers/crypto"
import { toBeHex } from "ethers/utils"

const depth = Number(process.argv[2] ?? 20)
const dir = "../artifacts"
const snarkArtifacts = { wasm: `${dir}/semaphore-${depth}.wasm`, zkey: `${dir}/semaphore-${depth}.zkey` }
const vkey = JSON.parse(readFileSync(`${dir}/semaphore-${depth}.json`, "utf8"))

const secret = Buffer.from("54684ed3bd15671b1a07bd8ed840a049c60ce847afd7d8da73b4f71cc6884d85", "hex")
const identity = new Identity(secret)
// A group of 1,000 other members plus ours. Proof time depends on the circuit's MAX_DEPTH, not on the size.
const members = []
for (let i = 1; i <= 1000; i++) members.push(new Identity(Buffer.from(`member ${i}`)).commitment)
members.push(identity.commitment)
const group = new Group(members)
console.log(`depth ${depth}: group size ${group.size}, tree depth ${group.depth}, root ${group.root}`)

// Scope and message as the registry would set them: 32 bytes each.
// scope = market name, UTF-8, right-padded with zeros (what Semaphore's toBigInt does to a string under 32 bytes).
// message = the profile's DID, UTF-8, exactly 32 bytes for did:plc.
const bytes32 = (s) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b }
const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
const cases = [
  { name: "market", scope: bytes32("online-tutors"), message: bytes32(did) },
  { name: "badge-1", scope: bytes32("badge-1"), message: bytes32(did) },
]
const hashField = (b) => (BigInt(keccak256(toBeHex(BigInt("0x" + Buffer.from(b).toString("hex")), 32))) >> 8n).toString()

const results = []
for (const c of cases) {
  const times = []
  let proof
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now()
    proof = await generateProof(identity, group, c.message, c.scope, depth, snarkArtifacts)
    times.push(Math.round(performance.now() - t0))
  }
  const t1 = performance.now()
  const ok = await verifyProof(proof)
  const verifyMs = Math.round(performance.now() - t1)
  const rss = Math.round(process.memoryUsage().rss / 1048576)
  console.log(`${c.name}: prove ${times.join("/")} ms (3 runs), verify ${verifyMs} ms, ok=${ok}, rss ${rss} MB`)
  console.log(`  nullifier ${proof.nullifier}`)
  console.log(`  public signals: root, nullifier, hash(message)=${hashField(c.message)}, hash(scope)=${hashField(c.scope)}`)
  const unpacked = unpackGroth16Proof(proof.points)
  const publicSignals = [proof.merkleTreeRoot, proof.nullifier, hashField(c.message), hashField(c.scope)]
  const ok2 = await groth16.verify(vkey, publicSignals, unpacked)
  console.log(`  snarkjs.groth16.verify with the published verification key: ${ok2}`)
  results.push({ name: c.name, depth, proof: unpacked, publicSignals, proveMs: times, verifyMs, rssMB: rss })
}
// Same identity, same scope, different message -> same nullifier (the code is the nullifier).
const p2 = await generateProof(identity, group, bytes32("did:plc:other000000000000000000"), cases[0].scope, depth, snarkArtifacts)
console.log("same scope, other DID -> same nullifier:", p2.nullifier === results[0].publicSignals[1])
const other = new Identity(Buffer.from("member 7"))
const p3 = await generateProof(other, group, cases[0].message, cases[0].scope, depth, snarkArtifacts)
console.log("other human, same scope -> other nullifier:", p3.nullifier !== results[0].publicSignals[1])

writeFileSync(`proofs-${depth}.json`, JSON.stringify({ depth, vkey, cases: results }, null, 1))
console.log(`wrote proofs-${depth}.json`)
process.exit(0)

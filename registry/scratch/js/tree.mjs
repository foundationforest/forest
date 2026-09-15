// Q3: Semaphore's tree rules (LeanIMT over poseidon2), roots for small trees, and
// vectors for the Rust side (Solana's Poseidon) to reproduce.
import { writeFileSync } from "node:fs"
import { LeanIMT } from "@zk-kit/lean-imt"
import { Group } from "@semaphore-protocol/group"
import { poseidon2 } from "poseidon-lite/poseidon2"

const hash = (a, b) => poseidon2([a, b])
const out = { poseidon2: [], trees: [], proofs: [] }

for (const inputs of [[1n, 2n], [0n, 0n], [2n ** 253n, 7n], [123456789n, 987654321n]]) {
  const o = poseidon2(inputs)
  out.poseidon2.push({ inputs: inputs.map(String), out: o.toString() })
  console.log(`poseidon2(${inputs.join(",")}) = ${o} = 0x${o.toString(16).padStart(64, "0")}`)
}

// Leaves are small integers so the vectors are readable; a real leaf is a commitment (any field element).
const leaves = [11n, 22n, 33n, 44n, 55n, 66n, 77n, 88n]
for (const n of [1, 2, 3, 4, 5, 8]) {
  const t = new LeanIMT(hash)
  for (const l of leaves.slice(0, n)) t.insert(l)
  const g = new Group(leaves.slice(0, n))
  console.log(`size ${n}: depth ${t.depth}, root ${t.root}, Group agrees: ${g.root === t.root}`)
  out.trees.push({ leaves: leaves.slice(0, n).map(String), depth: t.depth, root: t.root.toString() })
  if (n === 3 || n === 5) {
    for (const i of [0, n - 1]) {
      const p = t.generateProof(i)
      console.log(`  proof for leaf ${i}: siblings ${p.siblings.length} (${p.siblings.map(String).join(", ")}), index ${p.index}`)
      out.proofs.push({ size: n, leaf: i, siblings: p.siblings.map(String), index: p.index, root: p.root.toString() })
    }
  }
}
// Hand check of the copy-up rule for size 3: root = h(h(a,b), c), and size 1: root = leaf.
console.log("size 3 root == h(h(11,22),33):", hash(hash(11n, 22n), 33n).toString() === out.trees.find(t => t.leaves.length === 3).root)
console.log("size 5 root == h(h(h(11,22),h(33,44)),55):", hash(hash(hash(11n, 22n), hash(33n, 44n)), 55n).toString() === out.trees.find(t => t.leaves.length === 5).root)
console.log("size 1 root == leaf:", out.trees[0].root === "11")
writeFileSync("vectors.json", JSON.stringify(out, null, 2))
console.log("wrote vectors.json")

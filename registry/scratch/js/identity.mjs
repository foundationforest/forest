// Q4: build a Semaphore identity from 32 bytes we derive ourselves, and
// recompute the commitment by hand to state exactly what it is a hash of.
import { webcrypto as crypto } from "node:crypto"
import { Identity } from "@semaphore-protocol/identity"
import { blake512 } from "@noble/hashes/blake1"
import { Base8, mulPointEscalar, subOrder } from "@zk-kit/baby-jubjub"
import { poseidon2 } from "poseidon-lite/poseidon2"

const hex = (b) => Buffer.from(b).toString("hex")

// The seed from keys/test/vectors.json, and one more HKDF output the way keys/SPEC.md derives every key.
const seed = Buffer.from("3d9afcf6df255ce134686fc4f26d6cca0a57f82480f7b34d37e682546aaa72b0", "hex")
async function hkdf(ikm, info) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) }, key, 256)
  return new Uint8Array(bits)
}
const identitySecret = await hkdf(seed, "forest.foundation/identity/v1")
console.log("identity secret (32 HKDF bytes):", hex(identitySecret))

// 1. The library's own answer.
const id = new Identity(identitySecret)
console.log("secretScalar:", id.secretScalar.toString())
console.log("publicKey.x :", id.publicKey[0].toString())
console.log("publicKey.y :", id.publicKey[1].toString())
console.log("commitment  :", id.commitment.toString())

// 2. By hand: blake512 -> first 32 bytes -> prune -> little-endian integer -> >> 3 -> mod l.
const h = blake512(identitySecret).slice(0, 32)
h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40
let s = 0n
for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(h[i])
s = (s >> 3n) % subOrder
const pk = mulPointEscalar(Base8, s)
const commitment = poseidon2([pk[0], pk[1]])
console.log("by hand secretScalar equal:", s === id.secretScalar)
console.log("by hand publicKey equal   :", pk[0] === id.publicKey[0] && pk[1] === id.publicKey[1])
console.log("by hand commitment equal  :", commitment === id.commitment)
console.log("subOrder l:", subOrder.toString())

// 3. Determinism and independence: same bytes, same identity; a different info string, a different identity.
const again = new Identity(Buffer.from(identitySecret))
const other = new Identity(await hkdf(seed, "forest.foundation/profile/0/wallet/v1"))
console.log("same bytes -> same commitment:", again.commitment === id.commitment)
console.log("other info -> other commitment:", other.commitment !== id.commitment)
console.log("export() round trip:", Identity.import(id.export()).commitment === id.commitment)

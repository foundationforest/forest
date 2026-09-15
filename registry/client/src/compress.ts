// Compressed BN254 points, in the form Solana's `alt_bn128` decompression syscalls read.
//
// A proof is 256 bytes uncompressed and 128 compressed, and bytes are the tight limit on a
// registration, so the transaction carries the compressed form and the program decompresses.
//
// The encoding is arkworks' compressed serialization written big-endian, which is what
// `alt_bn128_g1_decompress` and `alt_bn128_g2_decompress` take:
//
//   G1: 32 bytes, x big-endian, with 0x80 set in the first byte when y is the larger of the two
//       square roots (arkworks calls that `YIsNegative`), and 0x40 for the point at infinity.
//   G2: 64 bytes, x.c1 big-endian then x.c0 big-endian, the same flag in the first byte. The
//       imaginary part comes first, the same order as the uncompressed form the syscalls use.
//
// Every byte of this is checked in `registry/program/tests-litesvm`: the program decompresses
// what this file writes, and the proof verifies. If a flag were wrong, it would not.

import { BN254_P, toBytes32 } from './field.ts'

const Y_IS_NEGATIVE = 0x80

function negate(y: bigint): bigint {
  return y === 0n ? 0n : BN254_P - y
}

/** Is `y` the larger of the pair `(y, -y)`? That is the bit the compressed form carries. */
function yIsNegative(y: bigint): boolean {
  return y > negate(y)
}

/** Fq2 compares on the imaginary part first, then the real part, the way arkworks orders it. */
function fq2IsNegative(y0: bigint, y1: bigint): boolean {
  const n0 = negate(y0)
  const n1 = negate(y1)
  if (y1 !== n1) return y1 > n1
  return y0 > n0
}

export function compressG1(x: bigint, y: bigint): Uint8Array {
  const out = toBytes32(x)
  if (yIsNegative(y)) out[0] |= Y_IS_NEGATIVE
  return out
}

export function compressG2(x0: bigint, x1: bigint, y0: bigint, y1: bigint): Uint8Array {
  const out = new Uint8Array(64)
  out.set(toBytes32(x1), 0)
  out.set(toBytes32(x0), 32)
  if (fq2IsNegative(y0, y1)) out[0] |= Y_IS_NEGATIVE
  return out
}

/** snarkjs writes points as decimal strings in projective form; the trailing 1 is dropped. */
export type SnarkjsProof = {
  pi_a: [string, string, string]
  pi_b: [[string, string], [string, string], [string, string]]
  pi_c: [string, string, string]
}

export type CompressedProof = {
  a: Uint8Array // 32
  b: Uint8Array // 64
  c: Uint8Array // 32
}

export function compressProof(proof: SnarkjsProof): CompressedProof {
  const n = (s: string) => BigInt(s)
  if (n(proof.pi_a[2]) !== 1n || n(proof.pi_c[2]) !== 1n) {
    throw new Error('a proof point is at infinity, which is never a valid proof')
  }
  return {
    a: compressG1(n(proof.pi_a[0]), n(proof.pi_a[1])),
    b: compressG2(n(proof.pi_b[0][0]), n(proof.pi_b[0][1]), n(proof.pi_b[1][0]), n(proof.pi_b[1][1])),
    c: compressG1(n(proof.pi_c[0]), n(proof.pi_c[1])),
  }
}

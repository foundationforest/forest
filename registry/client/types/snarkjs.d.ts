// snarkjs ships no types. Only the one call the client makes is declared.
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: unknown; publicSignals: string[] }>
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>
  }
}

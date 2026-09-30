// Reading lines: through whatever connection the caller passes (its own RPC, an app's, an
// index's). Nothing here opens a network of its own.

import type { Commitment, Connection, PublicKey } from '@solana/web3.js'

import { LINE_DISCRIMINATOR, PROGRAM_ID, decodeLine, lineAddress, type Line } from './program.ts'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58, for the discriminator filter: RPC filters take their bytes in base58. */
function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let s = ''
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = '1' + s
  }
  return s
}

type ReadOnlyConnection = Pick<Connection, 'getAccountInfo' | 'getProgramAccounts'>

/** The line at `code`, or null if there is none. */
export async function fetchLine(
  connection: Pick<Connection, 'getAccountInfo'>,
  code: bigint | Uint8Array,
  options: { programId?: PublicKey; commitment?: Commitment } = {},
): Promise<Line | null> {
  const programId = options.programId ?? PROGRAM_ID
  const info = await connection.getAccountInfo(lineAddress(code, programId), options.commitment ?? 'confirmed')
  if (!info) return null
  if (!info.owner.equals(programId)) throw new Error('the account at that code is not the registry\'s')
  return decodeLine(new Uint8Array(info.data))
}

/**
 * Every line, or every line of one profile (a filter on the profile key at offset 8). Each is
 * checked to sit at the address its own code derives, so an answer that moved a line elsewhere is
 * refused.
 */
export async function fetchLines(
  connection: ReadOnlyConnection,
  options: { profile?: PublicKey; programId?: PublicKey; commitment?: Commitment } = {},
): Promise<{ address: PublicKey; line: Line }[]> {
  const programId = options.programId ?? PROGRAM_ID
  const filters: { memcmp: { offset: number; bytes: string } }[] = [
    { memcmp: { offset: 0, bytes: base58(LINE_DISCRIMINATOR) } },
  ]
  if (options.profile) filters.push({ memcmp: { offset: 8, bytes: options.profile.toBase58() } })
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: options.commitment ?? 'confirmed',
    filters,
  })
  return accounts.map(({ pubkey, account }) => {
    const line = decodeLine(new Uint8Array(account.data))
    if (!lineAddress(line.code, programId).equals(pubkey)) throw new Error(`${pubkey.toBase58()} is not at its code's address`)
    return { address: pubkey, line }
  })
}

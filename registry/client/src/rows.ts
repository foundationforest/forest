// Reading rows: through whatever connection the caller passes (its own RPC, an app's, an
// index's). Nothing here opens a network of its own.

import type { Commitment, Connection, PublicKey } from '@solana/web3.js'

import { PROGRAM_ID, ROW_DISCRIMINATOR, ROW_OFFSET, decodeRow, keyBytes, rowAddress, type Row } from './program.ts'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58, for RPC filters, which take their bytes in base58. */
export function base58(bytes: Uint8Array): string {
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

/** The row at `marketStamp`, or null if there is none. */
export async function fetchRow(
  connection: Pick<Connection, 'getAccountInfo'>,
  marketStamp: bigint | Uint8Array,
  options: { programId?: PublicKey; commitment?: Commitment } = {},
): Promise<Row | null> {
  const programId = options.programId ?? PROGRAM_ID
  const info = await connection.getAccountInfo(rowAddress(marketStamp, programId), options.commitment ?? 'confirmed')
  if (!info) return null
  if (!info.owner.equals(programId)) throw new Error("the account at that market stamp is not the registry's")
  return decodeRow(new Uint8Array(info.data))
}

/**
 * Every row, or every row of one profile, one issuer or one label: each a filter on the row's
 * bytes at a fixed offset, so the RPC does the filtering.
 */
export async function fetchRows(
  connection: Pick<Connection, 'getProgramAccounts'>,
  options: { profile?: PublicKey; issuer?: PublicKey; label?: string; programId?: PublicKey; commitment?: Commitment } = {},
): Promise<{ address: PublicKey; row: Row }[]> {
  const programId = options.programId ?? PROGRAM_ID
  const filters: { memcmp: { offset: number; bytes: string } }[] = [{ memcmp: { offset: 0, bytes: base58(ROW_DISCRIMINATOR) } }]
  if (options.profile) filters.push({ memcmp: { offset: ROW_OFFSET.profile, bytes: base58(keyBytes(options.profile)) } })
  if (options.issuer) filters.push({ memcmp: { offset: ROW_OFFSET.issuer, bytes: base58(keyBytes(options.issuer)) } })
  if (options.label !== undefined) {
    // The label's length and its bytes, so `tutoring/seller` never matches `tutoring/sellers`. An
    // RPC compares at most 128 bytes, so a longer label is cut there and checked exactly below.
    const label = new TextEncoder().encode(options.label)
    const prefix = new Uint8Array(4 + label.length)
    new DataView(prefix.buffer).setUint32(0, label.length, true)
    prefix.set(label, 4)
    filters.push({ memcmp: { offset: ROW_OFFSET.label, bytes: base58(prefix.subarray(0, 128)) } })
  }
  const accounts = await connection.getProgramAccounts(programId, { commitment: options.commitment ?? 'confirmed', filters })
  return accounts
    .map(({ pubkey, account }) => ({ address: pubkey, row: decodeRow(new Uint8Array(account.data)) }))
    .filter(({ row }) => options.label === undefined || row.label === options.label)
}

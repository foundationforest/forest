// The deposit address and its pay link.
//
// The deposit address is the escrow's associated token account for the mint. A Solana Pay
// transfer request names the owner, not the token account, and the wallet derives the same
// address, so the link's recipient is the escrow's own address. Nothing in the link is trusted
// by the program: whatever arrives, from wherever, counts.

import type { PublicKey } from '@solana/web3.js'

import { vaultAddress } from './program.ts'

/** Where money is sent. Any wallet's plain transfer of the mint to this account funds the escrow. */
export function depositAddress(escrow: PublicKey, mint: PublicKey): PublicKey {
  return vaultAddress(escrow, mint)
}

/** Base units to the decimal string a pay link carries: 1500000 at six decimals is "1.5". */
export function formatAmount(baseUnits: bigint, decimals: number): string {
  if (baseUnits < 0n) throw new RangeError('an amount is not negative')
  const s = baseUnits.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac.length ? `${whole}.${frac}` : whole
}

/**
 * A Solana Pay transfer request for the escrow's amount: `solana:<escrow>?amount=…&spl-token=…`.
 * The escrow's address is also the `reference`, so the funding transfer can be found by looking
 * up that address. `label` and `message` are what a wallet shows; crypto is not in them.
 */
export function solanaPayUrl(args: {
  escrow: PublicKey
  mint: PublicKey
  amount: bigint
  decimals: number
  label?: string
  message?: string
  memo?: string
}): string {
  const params = new URLSearchParams()
  params.set('amount', formatAmount(args.amount, args.decimals))
  params.set('spl-token', args.mint.toBase58())
  params.set('reference', args.escrow.toBase58())
  if (args.label) params.set('label', args.label)
  if (args.message) params.set('message', args.message)
  if (args.memo) params.set('memo', args.memo)
  return `solana:${args.escrow.toBase58()}?${params.toString()}`
}

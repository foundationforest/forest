// The deposit address and its pay link.
//
// The deposit address is the escrow's associated token account for the mint. A Solana Pay
// transfer request names the owner, not the token account, and the wallet derives the same
// address, so the link's recipient is the escrow's own address. Nothing in the link is trusted
// by the program: whatever arrives, from wherever, counts.
//
// The invoice pattern: the seller opens the escrow, naming the buyer, so it is accepted from the
// start, and sends the buyer its pay link. The buyer's app reads the escrow, checks its terms
// (`checkTerms`) and pays by a plain transfer, then approves when the work is done, or at once.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

import { escrowAddress, invoiceIx, vaultAddress, type Terms } from './program.ts'

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

/**
 * The seller's side of an invoice: the `create` the seller signs (as creator; `payer` pays the
 * rent), the escrow's address, its deposit address, and the pay link to send the buyer. The terms
 * are checked before anything is built, as for any `create`.
 */
export function invoice(args: {
  seller: PublicKey
  buyer: PublicKey
  payer: PublicKey
  mint: PublicKey
  decimals: number
  terms: Terms
  label?: string
  message?: string
  now?: bigint
  programId?: PublicKey
}): { escrow: PublicKey; deposit: PublicKey; instruction: TransactionInstruction; url: string } {
  const instruction = invoiceIx(args)
  const escrow = escrowAddress(args.buyer, args.terms.id, args.programId)
  return {
    escrow,
    deposit: vaultAddress(escrow, args.mint),
    instruction,
    url: solanaPayUrl({
      escrow,
      mint: args.mint,
      amount: args.terms.amount,
      decimals: args.decimals,
      label: args.label,
      message: args.message,
    }),
  }
}

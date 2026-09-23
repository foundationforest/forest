// The deposit address and its pay link.
//
// The deposit address is the escrow's associated token account for the mint. A Solana Pay
// transfer request names the owner, not the token account, and the wallet derives the same
// address, so the link's recipient is the escrow's own address. Nothing in the link is trusted
// by the program: whatever arrives, from wherever, counts.
//
// A pay link is one-time. It is built only for an escrow still waiting for its money: open or
// accepted, its funding not yet observed. Money that arrives anyway after the end is not lost:
// anyone can send it back to the buyer (`recover_late`), but the link should not invite it.
//
// The invoice pattern: the seller opens the escrow, naming the buyer, so it is accepted from the
// start, and sends the buyer its pay link. The buyer's app reads the escrow, checks its terms
// (`checkTerms`) and pays by a plain transfer, then approves when the work is done, or at once.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

import { PROGRAM_ID, escrowAddress, invoiceIx, vaultAddress, type EscrowAccount, type Terms } from './program.ts'

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

/** Whether an escrow, as read from the chain, still waits for its money: open or accepted, and its funding not yet observed. */
export function awaitingPayment(account: Pick<EscrowAccount, 'status' | 'fundedAt'>): boolean {
  return (account.status === 'open' || account.status === 'accepted') && account.fundedAt === null
}

/**
 * A Solana Pay transfer request for the escrow's amount: `solana:<escrow>?amount=…&spl-token=…`.
 * The escrow's address is also the `reference`, so the funding transfer can be found by looking
 * up that address. `label` and `message` are what a wallet shows; crypto is not in them.
 *
 * One-time: built only from the escrow account as read from the chain, and refused unless the
 * escrow still waits for its money (`awaitingPayment`). A link to an escrow that is funded, locked
 * or ended would only invite a second payment.
 */
export function solanaPayUrl(args: {
  account: EscrowAccount
  decimals: number
  label?: string
  message?: string
  memo?: string
  programId?: PublicKey
}): string {
  const a = args.account
  if (!awaitingPayment(a)) {
    throw new Error(`this escrow is ${a.status === 'ended' ? 'ended' : 'already funded'}: a pay link is one-time`)
  }
  return payUrl({ ...args, escrow: escrowAddress(a.buyer, a.id, args.programId ?? PROGRAM_ID), mint: a.mint, amount: a.amount })
}

/** The link itself, for an escrow known to be waiting for its money. */
function payUrl(args: {
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
 * are checked before anything is built, as for any `create`. The escrow is new, so it is waiting
 * for its money by construction; a link built later comes from `solanaPayUrl` and the chain.
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
    url: payUrl({
      escrow,
      mint: args.mint,
      amount: args.terms.amount,
      decimals: args.decimals,
      label: args.label,
      message: args.message,
    }),
  }
}

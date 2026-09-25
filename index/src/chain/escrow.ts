// THE ESCROW ADAPTER. The one file in the index that knows the escrow program's events.
//
// The escrow program is being rewritten. When its events change, change this file and nothing
// else: everything past it reads `EscrowFact`, the index's own shape for what happened to one
// escrow, and stores it in `escrow_receipts`.
//
// It reads only events the escrow program itself wrote: `decodeEvents` in escrow/client follows
// the runtime's own invoke and success lines, so a `Program data:` line another program wrote
// with the same bytes is never read (adversarial review 1, rule 1).

import { PublicKey } from '@solana/web3.js'

import { PROGRAM_ID, decodeEvents } from '../../../escrow/client/src/program.ts'

/** The escrow program the index reads by default: the client's own id. */
export const ESCROW_PROGRAM_ID: string = PROGRAM_ID.toBase58()

/** Unix seconds. Amounts are base units as decimal text: no rounding through a JavaScript number. */
export type EscrowFact =
  | { kind: 'created'; escrow: string; buyer: string; seller: string; mint: string; amount: string; createdAt: number }
  | { kind: 'accepted'; escrow: string; acceptedAt: number }
  | { kind: 'funded'; escrow: string; fundedAt: number }
  | { kind: 'objected'; escrow: string; at: number }
  | {
      kind: 'ended'
      escrow: string
      outcome: string
      toSeller: string
      toBuyer: string
      /** null when the seller never accepted. */
      acceptedAt: number | null
      endedAt: number
    }
  /** Never funded, and gone: nothing was dealt, so there is no receipt. */
  | { kind: 'closed'; escrow: string }

/** What happened to which escrow, in one successful transaction's log lines, in order. */
export function decodeEscrowFacts(logs: string[], programId: string = ESCROW_PROGRAM_ID): EscrowFact[] {
  // The client's `PublicKey` comes from its own copy of web3.js; the decoder only reads its base58.
  const events = decodeEvents(logs, new PublicKey(programId) as never)
  const out: EscrowFact[] = []
  for (const e of events) {
    const escrow = e.escrow.toBase58()
    switch (e.kind) {
      case 'created':
        out.push({
          kind: 'created',
          escrow,
          buyer: e.buyer.toBase58(),
          seller: e.seller.toBase58(),
          mint: e.mint.toBase58(),
          amount: e.amount.toString(),
          createdAt: Number(e.createdAt),
        })
        break
      case 'accepted':
        out.push({ kind: 'accepted', escrow, acceptedAt: Number(e.acceptedAt) })
        break
      case 'funded':
        out.push({ kind: 'funded', escrow, fundedAt: Number(e.fundedAt) })
        break
      case 'objected':
        out.push({ kind: 'objected', escrow, at: Number(e.at) })
        break
      case 'ended':
        out.push({
          kind: 'ended',
          escrow,
          outcome: e.outcome,
          toSeller: e.toSeller.toString(),
          toBuyer: e.toBuyer.toString(),
          acceptedAt: e.acceptedAt === null ? null : Number(e.acceptedAt),
          endedAt: Number(e.endedAt),
        })
        break
      case 'closed':
        out.push({ kind: 'closed', escrow })
        break
      // The per-ending events (approved, agreed, ...) repeat what `ended` carries; late money and
      // rent sweeps change no receipt.
    }
  }
  return out
}

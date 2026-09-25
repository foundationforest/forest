// The chain reader. For each program: every transaction that named it since the last one read,
// oldest first, from an RPC (a local validator in tests). A transaction that failed is skipped. One
// that succeeded is archived whole (its log lines), then read through its program's adapter, then
// the cursor moves past it, all in one database transaction, so a crash never half-reads one.
//
// RPC nodes are not an archive (adversarial review 1, rule 7): the logs are kept here.

import { Connection, PublicKey, type Commitment } from '@solana/web3.js'
import type pg from 'pg'

import { type Db, getCursor } from '../db.ts'
import { type EscrowFact, decodeEscrowFacts } from './escrow.ts'
import { decodeBadges } from './registry.ts'

export type Program = { id: string; kind: 'registry' | 'escrow' }

export class ChainReader {
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<number> | null = null
  private readonly db: Db
  private readonly programs: Program[]
  private readonly onChange: () => void
  private readonly commitment: Commitment
  readonly connection: Connection
  readonly onError: (err: unknown) => void

  constructor(
    db: Db,
    rpcUrl: string,
    programs: Program[],
    onChange: () => void,
    commitment: Commitment = 'finalized',
    onError: (err: unknown) => void = (err) => console.error('chain read failed', err),
  ) {
    this.db = db
    this.programs = programs
    this.onChange = onChange
    this.commitment = commitment
    this.onError = onError
    this.connection = new Connection(rpcUrl, commitment)
  }

  /** Read everything new once. Returns how many transactions were read. */
  pollOnce(): Promise<number> {
    if (!this.polling) {
      this.polling = (async () => {
        let n = 0
        try {
          for (const p of this.programs) n += await this.readProgram(p)
        } finally {
          this.polling = null
        }
        if (n > 0) this.onChange()
        return n
      })()
    }
    return this.polling
  }

  start(intervalMs: number): void {
    const tick = async () => {
      try {
        await this.pollOnce()
      } catch (err) {
        this.onError(err)
      }
      this.timer = setTimeout(tick, intervalMs)
    }
    void tick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async readProgram(p: Program): Promise<number> {
    const source = `chain:${p.id}`
    const until = (await getCursor(this.db, source)) ?? undefined
    const address = new PublicKey(p.id)
    // Newest first, a page at a time, back to the cursor; then read oldest first.
    const found: { signature: string; failed: boolean }[] = []
    let before: string | undefined
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(address, { until, before, limit: 1000 }, this.commitment as 'confirmed' | 'finalized')
      found.push(...page.map((s) => ({ signature: s.signature, failed: s.err !== null })))
      if (page.length < 1000) break
      before = page[page.length - 1].signature
    }
    found.reverse()

    for (const { signature, failed } of found) {
      const tx = failed
        ? null
        : await this.connection.getTransaction(signature, {
            commitment: this.commitment as 'confirmed' | 'finalized',
            maxSupportedTransactionVersion: 0,
          })
      if (!failed && !tx) throw new Error(`transaction ${signature} not served yet`)
      const client = await this.db.connect()
      try {
        await client.query('begin')
        if (tx && !tx.meta?.err) {
          const logs = tx.meta?.logMessages ?? []
          await client.query(
            `insert into chain_transactions (signature, program_id, slot, block_time, logs)
             values ($1, $2, $3, to_timestamp($4), $5) on conflict (signature) do nothing`,
            [signature, p.id, tx.slot, tx.blockTime ?? null, JSON.stringify(logs)],
          )
          if (p.kind === 'registry') await storeBadges(client, signature, tx.slot, tx.blockTime ?? null, logs, p.id)
          else await storeEscrowFacts(client, signature, decodeEscrowFacts(logs, p.id), p.id)
        }
        await client.query(
          'insert into cursors (source, value) values ($1, $2) on conflict (source) do update set value = excluded.value',
          [source, signature],
        )
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
    }
    return found.length
  }
}

async function storeBadges(
  client: pg.PoolClient,
  signature: string,
  slot: number,
  blockTime: number | null,
  logs: string[],
  programId: string,
): Promise<void> {
  for (const [ix, b] of decodeBadges(logs, programId).entries()) {
    await client.query(
      `insert into badges (signature, ix, scope, market, role, did, wallet, code, list_index, list_owner, slot, block_time)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))
       on conflict do nothing`,
      [signature, ix, b.scope, b.market, b.role, b.did, b.wallet, b.code, b.listIndex, b.listOwner, slot, blockTime],
    )
  }
}

/** A receipt, rebuilt from the facts in the order the chain wrote them. */
async function storeEscrowFacts(client: pg.PoolClient, signature: string, facts: EscrowFact[], programId: string): Promise<void> {
  for (const f of facts) {
    switch (f.kind) {
      case 'created':
        // A new deal at this address (only possible after a never-funded one closed): start afresh.
        await client.query(
          `insert into escrow_receipts (escrow, program_id, buyer, seller, mint, amount, created_at, signature)
           values ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8)
           on conflict (escrow) do update set program_id = excluded.program_id, buyer = excluded.buyer,
             seller = excluded.seller, mint = excluded.mint, amount = excluded.amount, created_at = excluded.created_at,
             funded_at = null, accepted_at = null, ended_at = null, outcome = null, to_seller = null, to_buyer = null,
             locked = false, closed = false, signature = excluded.signature, updated_at = now()`,
          [f.escrow, programId, f.buyer, f.seller, f.mint, f.amount, f.createdAt, signature],
        )
        break
      case 'accepted':
        await client.query('update escrow_receipts set accepted_at = to_timestamp($2), signature = $3, updated_at = now() where escrow = $1', [
          f.escrow,
          f.acceptedAt,
          signature,
        ])
        break
      case 'funded':
        await client.query(
          'update escrow_receipts set funded_at = coalesce(funded_at, to_timestamp($2)), signature = $3, updated_at = now() where escrow = $1',
          [f.escrow, f.fundedAt, signature],
        )
        break
      case 'objected':
        await client.query('update escrow_receipts set locked = true, signature = $2, updated_at = now() where escrow = $1', [f.escrow, signature])
        break
      case 'ended':
        await client.query(
          `update escrow_receipts set outcome = $2, to_seller = $3, to_buyer = $4,
             accepted_at = coalesce(to_timestamp($5), accepted_at), ended_at = to_timestamp($6), locked = false,
             signature = $7, updated_at = now()
           where escrow = $1`,
          [f.escrow, f.outcome, f.toSeller, f.toBuyer, f.acceptedAt, f.endedAt, signature],
        )
        break
      case 'closed':
        await client.query('update escrow_receipts set closed = true, signature = $2, updated_at = now() where escrow = $1', [f.escrow, signature])
        break
    }
  }
}

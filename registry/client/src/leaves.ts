// A list's members, read back out of the chain the way a phone reads them (session 15).
//
// The program keeps a list's frontier and its last 128 roots, never its leaves, and a device needs
// every leaf to build its Merkle path. They are all in the log: `insert_identity` writes one
// `IdentityInserted` entry per member, with its position and the root after it. So a device lists
// the transactions that touched the list's account, reads those entries (only the ones the registry
// itself wrote), puts them in order, rebuilds the tree and checks its root against the list account.
// Nothing is trusted: a missing, extra or reordered leaf gives another root and is refused.
//
// It opens no network of its own. `fetchListLeaves` reads through whatever connection the caller
// passes: its own RPC, a fee payer's, an index's.

import { Group } from '@semaphore-protocol/group'
import type { Connection, Finality, PublicKey } from '@solana/web3.js'

import { fromBytes32 } from './field.ts'
import {
  PROGRAM_ID,
  decodeIdentityInsertedEvents,
  decodeIdentityList,
  listAddress,
  type IdentityInsertedEvent,
} from './program.ts'

/** The root the program and the circuit compute for these leaves, in order (Semaphore's LeanIMT). Zero when empty. */
export function listRoot(leaves: bigint[]): bigint {
  return leaves.length === 0 ? 0n : new Group(leaves).root
}

/**
 * One list's leaves in the order it took them, from its `IdentityInserted` entries: in any order,
 * from any number of transactions, other lists' entries ignored, the same entry seen twice kept
 * once. Refuses a gap and two different members at one position.
 */
export function leavesFromEvents(events: IdentityInsertedEvent[], listIndex: number): bigint[] {
  const at = new Map<bigint, bigint>()
  for (const e of events) {
    if (e.listIndex !== listIndex) continue
    const member = fromBytes32(e.commitment)
    const seen = at.get(e.leafIndex)
    if (seen !== undefined && seen !== member) throw new Error(`two members at position ${e.leafIndex} of list ${listIndex}`)
    at.set(e.leafIndex, member)
  }
  const leaves: bigint[] = []
  for (let i = 0n; i < BigInt(at.size); i++) {
    const member = at.get(i)
    if (member === undefined) throw new Error(`no member at position ${i} of list ${listIndex}: the log read is incomplete`)
    leaves.push(member)
  }
  return leaves
}

type ReadOnlyConnection = Pick<Connection, 'getAccountInfo' | 'getSignaturesForAddress' | 'getTransaction'>

/**
 * Every member of one list, read from the chain: the list account first (how many members, and its
 * root), then every transaction that touched it, newest first, a thousand at a time. Returns the
 * first `leafCount` members, whose root must be the account's; members added after the account was
 * read are left out, so a list that grows while this runs still gives a root the account held.
 */
export async function fetchListLeaves(
  connection: ReadOnlyConnection,
  listIndex: number,
  options: { programId?: PublicKey; commitment?: Finality } = {},
): Promise<{ leaves: bigint[]; root: bigint; transactionsRead: number }> {
  const programId = options.programId ?? PROGRAM_ID
  const commitment = options.commitment ?? 'confirmed'
  const address = listAddress(listIndex, programId)

  const info = await connection.getAccountInfo(address, commitment)
  if (!info) throw new Error(`list ${listIndex} does not exist`)
  const list = decodeIdentityList(new Uint8Array(info.data))
  const count = Number(list.leafCount)
  const root = fromBytes32(list.root)

  const events: IdentityInsertedEvent[] = []
  let transactionsRead = 0
  let before: string | undefined
  for (;;) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: 1000 }, commitment)
    for (const { signature, err } of page) {
      if (err) continue
      const tx = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 })
      if (!tx?.meta?.logMessages) throw new Error(`transaction ${signature} came back without its log`)
      transactionsRead++
      events.push(...decodeIdentityInsertedEvents(tx.meta.logMessages, programId))
    }
    if (page.length < 1000) break
    before = page[page.length - 1].signature
  }

  const all = leavesFromEvents(events, listIndex)
  if (all.length < count) {
    throw new Error(`list ${listIndex} holds ${count} members but the log gave ${all.length}: try again`)
  }
  const leaves = all.slice(0, count)
  if (listRoot(leaves) !== root) throw new Error(`the members read for list ${listIndex} do not give its root`)
  return { leaves, root, transactionsRead }
}

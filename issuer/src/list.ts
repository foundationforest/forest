// The issuer's side of the chain: its list's members, and inserting one more.
//
// Everything here goes through `registry/client`: the list's address, the insert instruction, and
// `fetchListLeaves`, which rebuilds the list from the registry's own log entries and checks the
// result against the root on the chain. The members are kept in memory only: they are public, and
// they answer "is this commitment on the list yet".

import { readFileSync } from 'node:fs'

import { Connection, Keypair, Transaction, type PublicKey } from '@solana/web3.js'

import { fetchListLeaves } from '../../registry/client/src/leaves.ts'
import { decodeIdentityList, insertIdentityIx, listAddress } from '../../registry/client/src/program.ts'

export interface IssuerList {
  /** Read every member again from the chain. */
  refresh(): Promise<void>
  /** Whether the last read, plus every insert confirmed since, holds this commitment. */
  has(commitment: bigint): boolean
  /** Insert one commitment. Resolves once the chain has it; throws once it is sure it never will. */
  insert(commitment: bigint): Promise<void>
}

/** An insert that failed on the chain, or whose transaction can no longer land. */
export class InsertFailed extends Error {}

/** The issuer's key, from a Solana keypair file: 64 numbers, as `solana-keygen` writes it. */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ChainList implements IssuerList {
  readonly #connection: Connection
  readonly #issuer: Keypair
  readonly #listIndex: number
  readonly #programId: PublicKey
  #members = new Set<bigint>()

  private constructor(connection: Connection, issuer: Keypair, listIndex: number, programId: PublicKey) {
    this.#connection = connection
    this.#issuer = issuer
    this.#listIndex = listIndex
    this.#programId = programId
  }

  /**
   * Opens the list and reads its members. Refuses to start unless the key is one of the list's insert
   * keys and the list is open, so a wrong key fails now rather than at the first batch.
   */
  static async open(options: {
    connection: Connection
    issuer: Keypair
    listIndex: number
    programId: PublicKey
  }): Promise<ChainList> {
    const { connection, issuer, listIndex, programId } = options
    const info = await connection.getAccountInfo(listAddress(listIndex, programId), 'confirmed')
    if (!info) throw new Error(`list ${listIndex} does not exist under program ${programId.toBase58()}`)
    const list = decodeIdentityList(new Uint8Array(info.data))
    if (!list.issuers.some((key) => key.equals(issuer.publicKey))) {
      throw new Error(`${issuer.publicKey.toBase58()} is not an insert key of list ${listIndex}`)
    }
    if (list.closed) throw new Error(`list ${listIndex} is closed`)
    const chain = new ChainList(connection, issuer, listIndex, programId)
    await chain.refresh()
    return chain
  }

  async refresh(): Promise<void> {
    const { leaves } = await fetchListLeaves(this.#connection, this.#listIndex, { programId: this.#programId })
    this.#members = new Set(leaves)
  }

  has(commitment: bigint): boolean {
    return this.#members.has(commitment)
  }

  /**
   * One commitment, one transaction, paid by the issuer's key. It waits until the transaction is
   * confirmed or its blockhash has expired, never less: giving up while it can still land would
   * let the next batch send the same commitment again.
   */
  async insert(commitment: bigint): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: this.#issuer.publicKey, blockhash, lastValidBlockHeight }).add(
      insertIdentityIx({
        issuer: this.#issuer.publicKey,
        listIndex: this.#listIndex,
        commitment,
        programId: this.#programId,
      }),
    )
    tx.sign(this.#issuer)
    const signature = await this.#connection.sendRawTransaction(tx.serialize())

    for (let expired = false; ; ) {
      const { value } = await this.#connection.getSignatureStatuses([signature])
      const status = value[0]
      if (status?.err) throw new InsertFailed('the insert failed on the chain')
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        this.#members.add(commitment)
        return
      }
      // One more look after the blockhash expires, in case it landed in its last block.
      if (expired) throw new InsertFailed('the insert expired without landing')
      expired = (await this.#connection.getBlockHeight('confirmed')) > lastValidBlockHeight
      await sleep(400)
    }
  }
}

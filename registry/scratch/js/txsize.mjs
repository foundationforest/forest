// Q5: how many bytes a registration transaction takes, against Solana's 1,232-byte legacy/v0
// limit and the 4,096-byte v1 limit. Builds real messages with @solana/web3.js and serializes them.
import {
  Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram, AddressLookupTableAccount,
} from "@solana/web3.js"

const kp = () => Keypair.generate()
const feePayer = kp()          // Kora
const profileWallet = kp()     // signs only when the 0.25 transfer happens
const program = kp().publicKey
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const registryState = kp().publicKey, tree = kp().publicKey, treasuryAta = kp().publicKey, walletAta = kp().publicKey
const codeA = kp().publicKey, codeB = kp().publicKey, prevCode = kp().publicKey, entry = kp().publicKey
const blockhash = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k"

function data(nProofs, proofBytes, market = "online-tutors") {
  const m = Buffer.from(market, "utf8")
  return Buffer.concat([
    Buffer.from([1]),                       // instruction tag
    Buffer.from([m.length]), m,             // market name
    Buffer.alloc(32),                       // DID (32 bytes, did:plc)
    Buffer.alloc(32),                       // root the proofs were made against
    Buffer.from([3]),                       // k, the badge number (u8; u32 would be 3 more bytes)
    ...Array.from({ length: nProofs }, () => Buffer.concat([Buffer.alloc(proofBytes), Buffer.alloc(32)])), // proof + nullifier
  ])
}
function build({ nProofs, proofBytes, paid, alt, withCU = true }) {
  const keys = [
    { pubkey: registryState, isSigner: false, isWritable: true },
    { pubkey: tree, isSigner: false, isWritable: false },
    { pubkey: codeA, isSigner: false, isWritable: true },
    { pubkey: codeB, isSigner: false, isWritable: true },
    { pubkey: prevCode, isSigner: false, isWritable: false },
    { pubkey: entry, isSigner: false, isWritable: true },
    { pubkey: feePayer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]
  if (nProofs === 3) keys.push({ pubkey: kp().publicKey, isSigner: false, isWritable: true }) // a third code account
  if (paid) keys.push(
    { pubkey: profileWallet.publicKey, isSigner: true, isWritable: false },
    { pubkey: walletAta, isSigner: false, isWritable: true },
    { pubkey: treasuryAta, isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  )
  const ixs = []
  if (withCU) ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
  ixs.push(new TransactionInstruction({ programId: program, keys, data: data(nProofs, proofBytes) }))
  const tables = []
  if (alt) {
    // Static addresses a lookup table would hold: program ids, state, tree, treasury.
    const addresses = [registryState, tree, treasuryAta, tokenProgram, SystemProgram.programId, ComputeBudgetProgram.programId, program]
    tables.push(new AddressLookupTableAccount({ key: kp().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } }))
  }
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables)
  const nSigs = paid ? 2 : 1
  // web3.js refuses to serialize a message over 1,232 bytes, so count the wire format by hand and
  // check the count against the real serialization whenever it fits.
  const c16 = (n) => (n < 128 ? 1 : 2)
  let n = c16(nSigs) + 64 * nSigs + 1 /* version */ + 3 /* header */ + c16(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length + 32 /* blockhash */
  n += c16(msg.compiledInstructions.length)
  for (const ix of msg.compiledInstructions) n += 1 + c16(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + c16(ix.data.length) + ix.data.length
  n += c16(msg.addressTableLookups.length)
  for (const l of msg.addressTableLookups) n += 32 + c16(l.writableIndexes.length) + l.writableIndexes.length + c16(l.readonlyIndexes.length) + l.readonlyIndexes.length
  try {
    const tx = new VersionedTransaction(msg)
    tx.sign(paid ? [feePayer, profileWallet] : [feePayer])
    const real = tx.serialize().length
    if (real !== n) throw new Error(`hand count ${n} != serialized ${real}`)
  } catch (e) { if (!/overruns/.test(String(e))) throw e }
  return n
}
const rows = []
for (const nProofs of [2, 3]) for (const proofBytes of [256, 128]) for (const paid of [false, true]) for (const alt of [false, true]) {
  const bytes = build({ nProofs, proofBytes, paid, alt })
  rows.push({ proofs: nProofs, proofBytes, paid, alt, bytes, fits1232: bytes <= 1232, fits4096: bytes <= 4096 })
}
console.table(rows)
console.log("Fixed parts: signature 64 B each, proof 256 B uncompressed or 128 B compressed, nullifier 32 B, root 32 B, DID 32 B, account 32 B (1 B via a lookup table).")

// Devnet funding for the services and the end-to-end run, from the keys devnet/keys.sh writes:
//
//   1. 1 SOL from the deploy key to the payer, which is the fee payer's key (Kora signs with it);
//   2. the payer's test-dollar account, where Kora is paid;
//   3. seed 2's profile wallet's test-dollar account, and 2.00 test dollars in it (the test-dollar
//      authority mints them): the registration's 0.25 and Kora's charge.
//
// The deploy key pays every fee and rent here, so the payer's balance moves only through Kora.
// Each step checks the chain or the record first; run again, it sends nothing new.

import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'

import { DEVNET, connection, devnetKey, redactRpc, rpcName, send } from './lib/chain.ts'
import { person } from './lib/person.ts'
import { noteTransaction, readRecord, updateRecord } from './lib/record.ts'

const TOP_UP = 1 * LAMPORTS_PER_SOL
const DOLLARS = 2_000_000n // 2.00, six decimals

try {
  const deploy = devnetKey('deploy')
  const payer = devnetKey('payer')
  const authority = devnetKey('test-dollar-authority')
  if (!payer.publicKey.equals(DEVNET.payer)) throw new Error('the payer key is not the one docs/devnet.md records')
  const { wallet } = await person()
  const ata = (owner: typeof wallet) => getAssociatedTokenAddressSync(DEVNET.testDollar, owner)
  console.log(`RPC: ${rpcName}`)

  const record = readRecord()
  if (!record.funding?.payerTopUp) {
    const sig = await send([SystemProgram.transfer({ fromPubkey: deploy.publicKey, toPubkey: payer.publicKey, lamports: TOP_UP })], [deploy])
    noteTransaction('1 SOL from the deploy key to the payer (the fee payer\'s key)', sig)
    updateRecord({ funding: { payerTopUp: sig } })
  }

  const payerTokens = ata(payer.publicKey)
  const walletTokens = ata(wallet)
  const need = []
  if (!(await connection.getAccountInfo(payerTokens))) need.push(createAssociatedTokenAccountIdempotentInstruction(deploy.publicKey, payerTokens, payer.publicKey, DEVNET.testDollar))
  if (!(await connection.getAccountInfo(walletTokens))) need.push(createAssociatedTokenAccountIdempotentInstruction(deploy.publicKey, walletTokens, wallet, DEVNET.testDollar))
  if (need.length) {
    const sig = await send(need, [deploy])
    noteTransaction('test-dollar accounts: the payer\'s (where Kora is paid) and seed 2 profile 0\'s wallet\'s', sig)
  }

  const balance = (await getAccount(connection, walletTokens)).amount
  if (balance < DOLLARS / 2n && !readRecord().funding?.dollars) {
    const sig = await send([createMintToInstruction(DEVNET.testDollar, walletTokens, authority.publicKey, DOLLARS)], [deploy, authority])
    noteTransaction('2.00 test dollars minted to seed 2 profile 0\'s wallet', sig)
    updateRecord({ funding: { dollars: sig } })
  }

  const [payerSol, deploySol, dollars] = await Promise.all([
    connection.getBalance(payer.publicKey),
    connection.getBalance(deploy.publicKey),
    getAccount(connection, walletTokens).then((a) => a.amount),
  ])
  updateRecord({
    funding: {
      payer: payer.publicKey.toBase58(),
      payerTokens: payerTokens.toBase58(),
      person: { wallet: wallet.toBase58(), tokens: walletTokens.toBase58() },
    },
  })
  console.log(`payer (Kora's key) ${payerSol / LAMPORTS_PER_SOL} SOL; deploy key ${deploySol / LAMPORTS_PER_SOL} SOL; seed 2's wallet ${Number(dollars) / 1e6} test dollars`)
} catch (err) {
  console.error(redactRpc(String((err as Error).stack ?? err)))
  process.exit(1)
}

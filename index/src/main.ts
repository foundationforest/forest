// The index, whole: migrations, the market directory, both readers, the recompute and the
// endpoints, in one process. `startIndex` is what `npm start` runs and what the end-to-end test
// starts with its own settings.

import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'

import { createApi } from './api/routes.ts'
import { serve } from './api/server.ts'
import { ChainReader, type Program } from './chain/poll.ts'
import { ESCROW_PROGRAM_ID } from './chain/escrow.ts'
import { REGISTRY_PROGRAM_ID } from './chain/registry.ts'
import { type Config, loadConfig } from './config.ts'
import { type Db, createPool, migrate } from './db.ts'
import { Directory } from './markets.ts'
import { type RecordReader, startRecordReader } from './records/firehose.ts'
import type { Outcome } from './records/store.ts'
import { Scorer, recompute } from './scores/run.ts'
import { indexKeys } from './scores/sign.ts'

export type RunningIndex = {
  db: Db
  directory: Directory
  scorer: Scorer
  chain: ChainReader | null
  records: RecordReader | null
  server: Server | null
  api: ReturnType<typeof createApi>
  stop: () => Promise<void>
}

export async function startIndex(
  config: Config,
  opts: {
    listen?: boolean
    onError?: (err: unknown) => void
    onRecord?: (uri: string, outcome: Outcome) => void
  } = {},
): Promise<RunningIndex> {
  const onError = opts.onError ?? ((err: unknown) => console.error(err))
  const db = createPool(config.databaseUrl)
  await migrate(db)
  const directory = Directory.load(config.marketsDir, config.aliases)
  for (const r of directory.refused) onError(new Error(`market file ${r.file} refused: ${r.errors.join('; ')}`))
  const keys = indexKeys(config.signingSeed)

  const scorer = new Scorer(() => recompute(db, { directory, config, keys }))
  scorer.onError = onError
  await scorer.now()

  const records = config.firehoseUrl
    ? await startRecordReader({
        db,
        directory,
        firehoseUrl: config.firehoseUrl,
        plcUrl: config.plcUrl,
        onChange: () => scorer.schedule(),
        onError,
        onRecord: opts.onRecord,
      })
    : null

  let chain: ChainReader | null = null
  if (config.rpcUrl) {
    const programs: Program[] = [
      { id: config.registryProgramId ?? REGISTRY_PROGRAM_ID, kind: 'registry' },
      { id: config.escrowProgramId ?? ESCROW_PROGRAM_ID, kind: 'escrow' },
    ]
    chain = new ChainReader(db, config.rpcUrl, programs, () => scorer.schedule(), config.chainCommitment, onError)
    chain.start(config.chainPollMs)
  }

  const api = createApi({ db, directory, config, keys })
  const server = opts.listen === false ? null : await serve(api, config.port)

  return {
    db,
    directory,
    scorer,
    chain,
    records,
    server,
    api,
    stop: async () => {
      chain?.stop()
      await records?.stop()
      scorer.stop()
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
      await db.end()
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig()
  const index = await startIndex(config)
  console.log(`index listening on :${config.port}`)
  const shutdown = async () => {
    await index.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

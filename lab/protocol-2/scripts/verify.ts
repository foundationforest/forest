// Verifies a profile's log from any host or index that serves it, with nothing but the bytes and
// the rules in src/entry.ts. Prints the state. Usage: node scripts/verify.ts <host url> <did>

import { HostClient } from '../src/client.ts'
import { verifyLog } from '../src/entry.ts'
import { toJson } from '../src/codec.ts'

const [url, did] = process.argv.slice(2)
if (!url || !did) {
  console.error('usage: node scripts/verify.ts <host url> <did>')
  process.exit(2)
}
const { entries } = await new HostClient(url).log(did)
const state = verifyLog(did, entries)
console.log(JSON.stringify({
  did,
  entries: entries.length,
  head: state.head ? { seq: state.head.seq, cid: state.head.cid.toString() } : null,
  reader: state.reader,
  grants: [...state.grants.values()].map((g) => ({ cid: g.cid, used: g.used, revokedAt: g.revokedAt ?? null, ...g.grant })),
  records: [...state.records.entries()].map(([k, r]) => ({ col: k.split('\u0000')[0], key: k.split('\u0000')[1], seq: r.seq, cid: r.cid, rec: toJson(r.rec) })),
  privates: state.privates.size,
}, null, 2))

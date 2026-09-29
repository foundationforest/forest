// A blob permit: "this key may store this blob for this profile until then", signed by the profile
// key or by a delegate under a grant that allows `put`. A blob is bytes a record points at by
// content id (a photo, a video); the entry that points at it is what makes it part of the log.

import { CID, concat, encode, utf8 } from './codec.ts'
import { isProfileDid } from './did.ts'
import type { Signer } from './keys.ts'

export const PERMIT_CONTEXT = utf8('forest/permit/1')

export type Permit = {
  did: string
  cid: string
  exp: number
  by?: string
  via?: string
  sig: Uint8Array
}

export function signingMessage(unsigned: Omit<Permit, 'sig'>): Uint8Array {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(unsigned)) if (v !== undefined) clean[k] = v
  return concat(PERMIT_CONTEXT, encode(clean))
}

export function signPermit(signer: Signer, did: string, cid: string, exp: number, via?: CID): Uint8Array {
  const unsigned: Omit<Permit, 'sig'> = signer.did === did ? { did, cid, exp } : { did, cid, exp, by: signer.did, via: via?.toString() }
  if (signer.did !== did && !via) throw new Error('a delegate\'s permit names its grant')
  const sig = signer.sign(signingMessage(unsigned))
  return encode({ ...unsigned, sig })
}

export function checkPermit(p: unknown): asserts p is Permit {
  const ok =
    !!p && typeof p === 'object' &&
    isProfileDid((p as Permit).did) &&
    typeof (p as Permit).cid === 'string' &&
    Number.isInteger((p as Permit).exp) &&
    (p as Permit).sig instanceof Uint8Array && (p as Permit).sig.length === 64 &&
    (((p as Permit).by === undefined && (p as Permit).via === undefined) || (isProfileDid((p as Permit).by) && typeof (p as Permit).via === 'string'))
  if (!ok) throw new Error('malformed permit')
}

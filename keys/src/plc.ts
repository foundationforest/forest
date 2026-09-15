// The did:plc genesis operation, built and signed on the device.
//
// The rules are the did:plc method's, as implemented by the directory's own
// library (@did-plc/lib): DAG-CBOR the unsigned operation, sign it with a
// rotation key (secp256k1, low-S, 64-byte compact signature, base64url without
// padding), and the DID is "did:plc:" plus the first 24 characters of the
// lowercase base32 of the SHA-256 of the DAG-CBOR of the signed operation.
// The tests check this builder against that library byte for byte.

import * as dagCbor from '@ipld/dag-cbor'
import { base32nopad, base64urlnopad } from '@scure/base'
import { sha256 } from './hkdf.ts'
import type { ProfileKeys } from './profile.ts'

/** The AT Protocol did:plc directory. */
export const PLC_DIRECTORY = 'https://plc.directory'

export type GenesisParams = {
  /** The profile's handle, with or without `at://`. */
  handle: string
  /** The host that stores the profile's folder, an https URL. */
  pds: string
}

export type UnsignedGenesis = {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: { atproto: string }
  alsoKnownAs: string[]
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer'; endpoint: string } }
  prev: null
}

export type Genesis = UnsignedGenesis & { sig: string }

/** The unsigned genesis operation: rotation key = control key, verification key = signing key. */
export function genesisOperation(keys: ProfileKeys, { handle, pds }: GenesisParams): UnsignedGenesis {
  return {
    type: 'plc_operation',
    rotationKeys: [keys.control.did()],
    verificationMethods: { atproto: keys.signing.did() },
    alsoKnownAs: [atUri(handle)],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: httpsUrl(pds) } },
    prev: null,
  }
}

/** The signed genesis operation and the DID it creates. Talks to nothing. */
export async function didGenesis(keys: ProfileKeys, params: GenesisParams): Promise<{ did: string; op: Genesis }> {
  const unsigned = genesisOperation(keys, params)
  const signature = await keys.control.sign(dagCbor.encode(unsigned))
  const op: Genesis = { ...unsigned, sig: base64urlnopad.encode(signature) }
  const hash = await sha256(dagCbor.encode(op))
  const did = `did:plc:${base32nopad.encode(hash).toLowerCase().slice(0, 24)}`
  return { did, op }
}

/**
 * Sends a genesis operation to the directory. Separate from building it, and
 * the only function in this library that talks to anything. Creating a DID is
 * permanent and public.
 */
export async function submitGenesis(genesis: { did: string; op: Genesis }, directory = PLC_DIRECTORY): Promise<void> {
  const response = await fetch(`${directory.replace(/\/+$/, '')}/${genesis.did}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(genesis.op),
  })
  if (!response.ok) {
    throw new Error(`directory refused ${genesis.did}: ${response.status} ${await response.text()}`)
  }
}

// The same normalisation as the directory's library, so the same inputs give
// the same DID whichever builds the operation.
function atUri(handle: string): string {
  if (handle.startsWith('at://')) return handle
  return `at://${handle.replace('http://', '').replace('https://', '')}`
}

function httpsUrl(pds: string): string {
  if (pds.startsWith('http://') || pds.startsWith('https://')) return pds
  return `https://${pds}`
}

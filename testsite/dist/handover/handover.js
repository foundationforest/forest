// Forest handover experiment. Plain JS, no framework, no build, no dependencies.
//
// The seller's device runs this page. "Start handover" creates a passkey on the
// buyer's phone through the browser's QR flow (WebAuthn hybrid), over a
// challenge bound to a fresh deal id and session key. "Confirm again" signs in
// with that passkey and checks its signature here, with Web Crypto. Everything
// is recorded in a report the tester downloads. Nothing leaves the tab.

const STORAGE_KEY = 'forest-handover-test'
const TIMEOUT_MS = 120000
const REPORT_VERSION = 1

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- bytes

const u8 = (buffer) => new Uint8Array(buffer)
const utf8 = (text) => new TextEncoder().encode(text)
const text = (bytes) => new TextDecoder().decode(bytes)
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const sha256 = async (bytes) => u8(await crypto.subtle.digest('SHA-256', bytes))

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const base64url = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  decode: (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
}

function uuid(bytes) {
  const h = hex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ---------------------------------------------------------------- CBOR

// Just enough CBOR for an attestation object and a COSE key: integers, byte
// and text strings, arrays, maps and the simple values. Returns the value and
// where it ended, because a COSE key in authenticator data can be followed by
// extensions.
function decodeCbor(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  function length(info) {
    if (info < 24) return info
    if (info === 24) return view.getUint8(at++)
    if (info === 25) return (at += 2), view.getUint16(at - 2)
    if (info === 26) return (at += 4), view.getUint32(at - 4)
    if (info === 27) return (at += 8), Number(view.getBigUint64(at - 8))
    throw new Error('CBOR: indefinite length')
  }
  function item() {
    const first = view.getUint8(at++)
    const major = first >> 5
    const info = first & 31
    if (major === 0) return length(info)
    if (major === 1) return -1 - length(info)
    if (major === 2 || major === 3) {
      const n = length(info)
      const slice = bytes.slice(at, (at += n))
      return major === 2 ? slice : text(slice)
    }
    if (major === 4) return Array.from({ length: length(info) }, item)
    if (major === 5) {
      const map = new Map()
      for (let n = length(info); n > 0; n--) map.set(item(), item())
      return map
    }
    if (first === 0xf4) return false
    if (first === 0xf5) return true
    if (first === 0xf6) return null
    throw new Error(`CBOR: unexpected byte 0x${first.toString(16)}`)
  }
  const value = item()
  return { value, end: at }
}

// ---------------------------------------------------------------- WebAuthn data

// Authenticator data: rpIdHash (32), flags (1), signCount (4), then, when the
// AT flag is set, the AAGUID (16), the credential id and its COSE public key.
function parseAuthData(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const f = data[32]
  const out = {
    rpIdHash: data.slice(0, 32),
    flags: { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10), at: !!(f & 0x40), ed: !!(f & 0x80) },
    signCount: view.getUint32(33),
  }
  if (out.flags.at) {
    out.aaguid = data.slice(37, 53)
    const idLength = view.getUint16(53)
    out.credentialId = data.slice(55, 55 + idLength)
    out.coseKey = decodeCbor(data.subarray(55 + idLength)).value
  }
  return out
}

// The two algorithms the page asks for, as the keys page does: COSE -7 is
// ES256 (P-256), -257 is RS256.
const ALGORITHMS = {
  [-7]: { key: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  [-257]: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
}

// The attested COSE key, as SPKI bytes, through Web Crypto.
async function coseToSpki(cose) {
  const alg = cose.get(3)
  let jwk
  if (alg === -7 && cose.get(1) === 2 && cose.get(-1) === 1) {
    jwk = { kty: 'EC', crv: 'P-256', x: base64url.encode(cose.get(-2)), y: base64url.encode(cose.get(-3)) }
  } else if (alg === -257 && cose.get(1) === 3) {
    jwk = { kty: 'RSA', n: base64url.encode(cose.get(-1)), e: base64url.encode(cose.get(-2)) }
  } else {
    throw new Error(`the passkey's key is of a kind this page does not read (COSE kty ${cose.get(1)}, alg ${alg})`)
  }
  const key = await crypto.subtle.importKey('jwk', jwk, ALGORITHMS[alg].key, true, ['verify'])
  return { alg, spki: u8(await crypto.subtle.exportKey('spki', key)) }
}

// Re-encode SPKI bytes through Web Crypto so two encodings of one key compare equal.
async function normalizeSpki(spki, alg) {
  const key = await crypto.subtle.importKey('spki', spki, ALGORITHMS[alg].key, true, ['verify'])
  return u8(await crypto.subtle.exportKey('spki', key))
}

// A WebAuthn ES256 signature is DER, a SEQUENCE of two INTEGERs. Web Crypto
// wants r and s as 32 bytes each.
function derToRaw(der) {
  if (der[0] !== 0x30) throw new Error('the signature is not DER')
  let at = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2
  const out = new Uint8Array(64)
  for (const offset of [0, 32]) {
    if (der[at] !== 0x02) throw new Error('the signature is not DER')
    let length = der[at + 1]
    let start = at + 2
    at = start + length
    while (length > 32 && der[start] === 0) start++, length--
    if (length > 32) throw new Error('the signature is not DER')
    out.set(der.subarray(start, start + length), offset + 32 - length)
  }
  return out
}

// What an assertion signs: authenticator data, then the SHA-256 of clientDataJSON.
async function verifySignature(spki, alg, authenticatorData, clientDataJSON, signature) {
  const algorithm = ALGORITHMS[alg]
  const key = await crypto.subtle.importKey('spki', spki, algorithm.key, false, ['verify'])
  const signed = concat(authenticatorData, await sha256(clientDataJSON))
  return crypto.subtle.verify(algorithm.verify, key, alg === -7 ? derToRaw(signature) : signature, signed)
}

async function clientDataChecks(clientData, type, challenge, auth) {
  return {
    type: clientData.type === type,
    challenge: clientData.challenge === base64url.encode(challenge),
    origin: clientData.origin === location.origin,
    rpIdHash: equal(auth.rpIdHash, await sha256(utf8(location.hostname))),
    userPresent: auth.flags.up,
  }
}

// ---------------------------------------------------------------- report

function freshReport() {
  return {
    experiment: 'forest handover',
    reportVersion: REPORT_VERSION,
    page: { origin: location.origin, relyingParty: location.hostname, realRelyingParty: 'forest.foundation' },
    sellerDevice: { userAgent: navigator.userAgent },
    note: '',
    runs: [],
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved?.experiment === 'forest handover' && saved.reportVersion === REPORT_VERSION) {
      return { ...saved, page: freshReport().page, sellerDevice: freshReport().sellerDevice }
    }
  } catch {}
  return freshReport()
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(report))
  } catch {}
}

let report = load()

// Runs one ceremony and records it whatever happens, so the failure cases
// (the cheat, Bluetooth off) still leave a report.
async function ceremony(fn) {
  const record = { startedAt: new Date().toISOString(), endedAt: null, ms: null, ok: null }
  const started = performance.now()
  try {
    Object.assign(record, await fn())
    record.ok = true
  } catch (e) {
    record.ok = false
    record.error = { name: e?.name ?? 'Error', message: String(e?.message ?? e) }
  }
  record.endedAt = new Date().toISOString()
  record.ms = Math.round(performance.now() - started)
  return record
}

// ---------------------------------------------------------------- start handover

// The next deal is made before the tap, so the tap goes straight into the
// browser's passkey call. Safari may refuse a passkey call that follows other
// async work, because the tap no longer counts as the user's.
let nextDeal = null
let busy = false

function buttons() {
  $('start').disabled = busy || !nextDeal
  $('confirm').disabled = busy || !latestHandover()
}

async function prepareDeal() {
  nextDeal = null
  buttons()
  const id = crypto.getRandomValues(new Uint8Array(16))
  // The session key's private half cannot be exported and is not used in this
  // experiment; its public half is bound into the challenge.
  const session = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const sessionPublicKey = u8(await crypto.subtle.exportKey('raw', session.publicKey))
  const challenge = await sha256(concat(id, sessionPublicKey))
  nextDeal = { id, sessionPublicKey, challenge }
  buttons()
}

async function startHandover() {
  const deal = nextDeal
  if (!deal || busy) return
  nextDeal = null
  busy = true
  const attachment = $('attachment').value
  const run = {
    deal: {
      id: base64url.encode(deal.id),
      sessionPublicKey: base64url.encode(deal.sessionPublicKey),
      challenge: base64url.encode(deal.challenge),
      attachmentRequested: attachment,
      startedAt: new Date().toISOString(),
    },
    create: null,
    confirmations: [],
  }
  report.runs.push(run)
  save()
  render()
  status(
    attachment === 'cross-platform'
      ? 'Waiting for the browser. Scan its QR code with the buyer\'s phone and confirm there.'
      : 'Waiting for the browser. Confirm on this device.',
  )
  const pending = ceremony(async () => {
    const credential = await navigator.credentials.create({
      publicKey: {
        // No rp.id: the relying party is this page's origin, whatever it is.
        // In Forest the relying party is forest.foundation.
        rp: { name: 'Forest handover test' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: `Forest handover ${run.deal.id.slice(0, 6)}`,
          displayName: `Forest handover ${run.deal.id.slice(0, 6)}`,
        },
        challenge: deal.challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: attachment,
          residentKey: 'preferred',
          requireResidentKey: false,
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: TIMEOUT_MS,
      },
    })
    return readCreation(credential, deal.challenge)
  })
  guard(prepareDeal)()
  run.create = await pending
  busy = false
  save()
  render()
  status(run.create.ok ? 'Handover recorded. Press Confirm again to sign in with the same passkey.' : failure(run.create))
}

async function readCreation(credential, challenge) {
  const response = credential.response
  const clientDataJSON = u8(response.clientDataJSON)
  const attestationObject = u8(response.attestationObject)
  const clientData = JSON.parse(text(clientDataJSON))
  const attestation = decodeCbor(attestationObject).value
  const format = attestation.get('fmt')
  const auth = parseAuthData(attestation.get('authData'))
  const rawId = u8(credential.rawId)
  const { alg, spki } = await coseToSpki(auth.coseKey)
  const fromBrowser = response.getPublicKey?.()
  return {
    credentialId: base64url.encode(rawId),
    publicKey: base64url.encode(spki),
    publicKeyAlgorithm: alg,
    transports: response.getTransports?.() ?? null,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    userVerified: auth.flags.uv,
    flags: auth.flags,
    signCount: auth.signCount,
    aaguid: uuid(auth.aaguid),
    attestationFormat: format,
    signatureAtCreation:
      format === 'none'
        ? 'none: attestation "none" carries no signature, so the signature is checked at Confirm again'
        : `format "${format}", not checked by this page`,
    checks: {
      ...(await clientDataChecks(clientData, 'webauthn.create', challenge, auth)),
      credentialId: equal(auth.credentialId, rawId),
      publicKeyMatchesBrowser: fromBrowser ? equal(await normalizeSpki(u8(fromBrowser), alg), spki) : null,
    },
    raw: {
      clientDataJSON: base64url.encode(clientDataJSON),
      attestationObject: base64url.encode(attestationObject),
    },
  }
}

// ---------------------------------------------------------------- confirm again

// Confirm again applies to the latest run, and only once its handover completed.
function latestHandover() {
  const run = report.runs.at(-1)
  return run?.create?.ok ? run : null
}

async function confirmAgain() {
  const run = latestHandover()
  if (!run || busy) return
  busy = true
  buttons()
  const challenge = base64url.decode(run.deal.challenge)
  const transports = run.create.transports
  status('Waiting for the browser. Scan its QR code with the same phone and confirm there.')
  const record = await ceremony(async () => {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [
          { type: 'public-key', id: base64url.decode(run.create.credentialId), ...(transports ? { transports } : {}) },
        ],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
      },
    })
    return readAssertion(assertion, run, challenge)
  })
  run.confirmations.push(record)
  busy = false
  save()
  render()
  status(!record.ok ? failure(record) : record.signatureValid ? 'Signed in again. The signature checks out.' : 'Signed in again, but the signature does NOT check out.')
}

async function readAssertion(assertion, run, challenge) {
  const response = assertion.response
  const clientDataJSON = u8(response.clientDataJSON)
  const authenticatorData = u8(response.authenticatorData)
  const signature = u8(response.signature)
  const clientData = JSON.parse(text(clientDataJSON))
  const auth = parseAuthData(authenticatorData)
  const signatureValid = await verifySignature(
    base64url.decode(run.create.publicKey),
    run.create.publicKeyAlgorithm,
    authenticatorData,
    clientDataJSON,
    signature,
  )
  return {
    credentialId: base64url.encode(u8(assertion.rawId)),
    authenticatorAttachment: assertion.authenticatorAttachment ?? null,
    userVerified: auth.flags.uv,
    signatureValid,
    flags: auth.flags,
    signCount: auth.signCount,
    checks: {
      ...(await clientDataChecks(clientData, 'webauthn.get', challenge, auth)),
      sameCredential: base64url.encode(u8(assertion.rawId)) === run.create.credentialId,
      signature: signatureValid,
    },
    raw: {
      clientDataJSON: base64url.encode(clientDataJSON),
      authenticatorData: base64url.encode(authenticatorData),
      signature: base64url.encode(signature),
    },
  }
}

// ---------------------------------------------------------------- screen

function status(message) {
  $('status').textContent = message
}

function failure(record) {
  return `Failed after ${(record.ms / 1000).toFixed(1)} s: ${record.error.name}: ${record.error.message}`
}

const yesNo = (value) => (value === true ? 'yes' : value === false ? 'no' : 'not reported')

function checksLine(checks) {
  const failed = Object.entries(checks).filter(([, ok]) => ok === false).map(([name]) => name)
  const unknown = Object.entries(checks).filter(([, ok]) => ok === null).map(([name]) => name)
  return (failed.length ? `FAILED: ${failed.join(', ')}` : 'all passed') + (unknown.length ? ` (not available: ${unknown.join(', ')})` : '')
}

function ceremonyLine(record) {
  if (!record) return 'waiting for the browser'
  return record.ok ? `completed in ${(record.ms / 1000).toFixed(1)} s` : failure(record)
}

function render() {
  const run = report.runs.at(-1)
  buttons()
  $('note').value = report.note
  $('report').textContent = JSON.stringify(report, null, 2)
  const results = $('results')
  results.textContent = ''
  if (!run) {
    results.innerHTML = '<p class="muted">No handover yet.</p>'
    return
  }
  const c = run.create?.ok ? run.create : null
  const rows = [
    ['Deal id', run.deal.id],
    ['Started', run.deal.startedAt],
    ['Asked for', run.deal.attachmentRequested === 'cross-platform' ? 'another device (cross-platform)' : 'this device (platform)'],
    ['Handover', ceremonyLine(run.create)],
  ]
  if (c) {
    rows.push(
      ['Credential id', c.credentialId],
      ['Transports', c.transports ? JSON.stringify(c.transports) : 'not reported'],
      ['Attachment', c.authenticatorAttachment ?? 'not reported'],
      ['User verified', yesNo(c.userVerified)],
      ['Backup eligible, backed up', `${yesNo(c.flags.be)}, ${yesNo(c.flags.bs)}`],
      ['AAGUID', c.aaguid],
      ['Signature at creation', c.signatureAtCreation],
      ['Checks at creation', checksLine(c.checks)],
    )
  }
  run.confirmations.forEach((record, i) => {
    const label = `Confirm again ${i + 1}`
    rows.push([label, ceremonyLine(record)])
    if (record.ok) {
      rows.push(
        [`${label}: attachment`, record.authenticatorAttachment ?? 'not reported'],
        [`${label}: user verified`, yesNo(record.userVerified)],
        [`${label}: signature`, record.signatureValid ? 'valid' : 'NOT valid'],
        [`${label}: checks`, checksLine(record.checks)],
      )
    }
  })
  const table = document.createElement('table')
  for (const [name, value] of rows) {
    const tr = document.createElement('tr')
    const th = document.createElement('th')
    th.textContent = name
    const td = document.createElement('td')
    td.className = 'mono'
    td.textContent = value
    tr.append(th, td)
    table.append(tr)
  }
  results.append(table)
}

function download() {
  const run = report.runs.at(-1)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  const name = `handover-${run ? run.deal.id.slice(0, 6) : 'empty'}-${stamp}.json`
  const blob = new Blob([JSON.stringify({ ...report, downloadedAt: new Date().toISOString() }, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

function clear() {
  if (report.runs.length && !confirm('Clear the report? Download it first if you need it.')) return
  report = freshReport()
  save()
  render()
  status('Report cleared.')
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args)
    } catch (e) {
      status(`Error: ${e?.message ?? e}`)
    }
  }
}

$('start').addEventListener('click', guard(startHandover))
$('confirm').addEventListener('click', guard(confirmAgain))
$('download').addEventListener('click', download)
$('clear').addEventListener('click', clear)
$('note').addEventListener('input', () => {
  report.note = $('note').value
  save()
  $('report').textContent = JSON.stringify(report, null, 2)
})

render()
if (!window.isSecureContext) status('Not a secure context: open this page over HTTPS.')
else if (!window.PublicKeyCredential) status('This browser has no passkey support.')
else {
  status(report.runs.length ? 'A report is in progress. Download it, or clear it to start a new case.' : 'Ready.')
  guard(prepareDeal)()
}

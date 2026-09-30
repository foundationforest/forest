// Forest keys test page. Plain JS, no framework. Imports the library bundle
// built by `npm run build:page`. Holds the seed in memory only.

import { PRF_INPUT, seedFromPrf, profileKey, boxKey, exportWords } from './dist/forest-keys.js'

const PROFILES = [0, 1]
const STORAGE_KEY = 'forest-keys-test-page'

const state = { seed: null }
const $ = (id) => document.getElementById(id)

// localStorage holds only the credential id (so unlock can name it) and the
// last seed fingerprint (so a reload can say "same as last time").
function saved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}
function save(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved(), ...patch }))
  } catch {}
}

function log(message) {
  const time = new Date().toLocaleTimeString()
  $('log').textContent = `${time}  ${message}\n` + $('log').textContent
}

const base64url = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  decode: (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function createPasskey() {
  const credential = await navigator.credentials.create({
    publicKey: {
      // No rp.id: the relying party is this page's origin, whatever it is.
      // In Forest the relying party is forest.foundation.
      rp: { name: 'Forest keys test page' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'forest-keys-test',
        displayName: 'Forest keys test',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  })
  const extensions = credential.getClientExtensionResults()
  if (!extensions.prf?.enabled) {
    throw new Error('this passkey did not enable the PRF extension; try another authenticator or browser')
  }
  save({ credentialId: base64url.encode(new Uint8Array(credential.rawId)) })
  log('passkey created with PRF enabled. Now press Unlock.')
}

async function unlock() {
  const { credentialId } = saved()
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      allowCredentials: credentialId ? [{ type: 'public-key', id: base64url.decode(credentialId) }] : [],
      extensions: { prf: { eval: { first: PRF_INPUT } } },
    },
  })
  const first = assertion.getClientExtensionResults().prf?.results?.first
  if (!first) throw new Error('the authenticator returned no PRF output')
  if (!credentialId) save({ credentialId: base64url.encode(new Uint8Array(assertion.rawId)) })
  state.seed = await seedFromPrf(new Uint8Array(first))
  hideWords()
  await render()
  log('unlocked: seed derived from the PRF output')
}

async function render() {
  if (!state.seed) return
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', state.seed))
  const fingerprint = hex(digest).slice(0, 8)
  const previous = saved().fingerprint
  $('fingerprint').textContent = fingerprint
  $('same').textContent = previous ? (previous === fingerprint ? '(same as last time)' : '(DIFFERENT from last time)') : '(first time on this browser)'
  save({ fingerprint })

  const container = $('profiles')
  container.textContent = ''
  for (const n of PROFILES) {
    container.append(profileTable(n, await profileKey(state.seed, n), await boxKey(state.seed, n)))
  }
}

function profileTable(n, key, box) {
  const table = document.createElement('table')
  const rows = [
    ['Profile', String(n)],
    ['Name', key.did],
    ['Wallet', key.address],
    ['Box', `${box.recipient.slice(0, 24)}…${box.recipient.slice(-8)} (${box.recipient.length} characters)`],
  ]
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
  return table
}

function showWords() {
  if (!state.seed) throw new Error('unlock first')
  $('words').textContent = exportWords(state.seed)
  $('words').hidden = false
  $('show-words').hidden = true
  $('hide-words').hidden = false
}

function hideWords() {
  $('words').textContent = ''
  $('words').hidden = true
  $('show-words').hidden = false
  $('hide-words').hidden = true
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args)
    } catch (e) {
      log(`error: ${e?.message ?? e}`)
    }
  }
}

$('create').addEventListener('click', guard(createPasskey))
$('unlock').addEventListener('click', guard(unlock))
$('forget').addEventListener('click', () => {
  save({ credentialId: undefined, fingerprint: undefined })
  log('forgot the saved credential id and fingerprint')
})
$('show-words').addEventListener('click', guard(showWords))
$('hide-words').addEventListener('click', hideWords)

if (!window.PublicKeyCredential) log('this browser has no WebAuthn; the passkey buttons will fail')
if (!window.isSecureContext) log('not a secure context: serve this page over HTTPS or from localhost')
log(saved().credentialId ? 'a credential id is saved: press Unlock' : 'no passkey yet: press Create')

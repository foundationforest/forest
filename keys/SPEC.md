# The keys recipe, version v1

How a passkey's secret becomes a person's seed, and how the seed becomes separate keys and a name for each profile, plus one identity for the person that the registry uses and one central wallet for the person's money. Everything runs on the device, in memory. Nothing here talks to a server, and nothing here is stored, except the seed file a person chooses to keep for an extra passkey. Any product that follows these steps opens the same seed from the same passkey and gets the same keys, so a person is never locked into one app.

Plain words first, then the exact steps. The library in `src/` implements the steps; `test/vectors.json` pins the answers.

## In plain words

1. A passkey can do more than sign in: with the PRF extension it also returns a secret, 32 bytes that only that passkey can produce, the same every time it is asked with the same input. That secret never leaves the authenticator's owner's device.
2. The secret is stretched into a seed with a standard key derivation function. The seed is the one thing a person must never lose. It is 32 bytes.
3. Each profile the person opens (profile 0, profile 1, ...) gets three keys from the seed, each derived with its own label: a control key, a signing key, and a wallet key. Knowing one key tells you nothing about the others, and nothing about the seed.
4. One more secret comes out of the seed and belongs to the person, not to any profile: the one the registry uses to show that a verified human is asking, without saying which one. It is the same for every profile, so the registry can hold one entry per human while the profiles stay apart.
5. One more wallet belongs to the person, not to any profile: the central wallet, where money enters from a ramp and leaves to one. It has its own label and no profile index, so it is unrelated to every profile's keys.
6. A profile's name is a did:plc. The control key signs the profile's first directory record (the genesis operation), and the name is a hash of that record. The signing key is the one the record names for signing the profile's folder.
7. A second passkey can open the same seed through a seed file: the seed encrypted under the second passkey's secret, stored under a label the second passkey can recompute. Whoever stores the file learns nothing.
8. The seed can also be written as 24 English words: the optional backup, and the way to carry the seed anywhere. They are a backup, not a login: the one way in is a passkey.

## 1. The passkey and its secret

- The passkey's relying party is `forest.foundation`. Products that use the recipe are listed in `https://forest.foundation/.well-known/webauthn` (WebAuthn related origins), so one passkey serves every product.
- The passkey must have the PRF extension enabled at creation: `extensions: { prf: {} }` or with an `eval`. A passkey without PRF cannot be used with this recipe; the app must say so and offer to create another.
- The secret is obtained with `navigator.credentials.get`, with `extensions: { prf: { eval: { first: PRF_INPUT } } }` and user verification required. The result is `getClientExtensionResults().prf.results.first`, 32 bytes. Call it `PRF`.
- `PRF_INPUT` (WebAuthn calls it a salt) is fixed: the UTF-8 bytes of the text `forest.foundation/prf/v1`. Every product uses exactly this input; a different input would give a different secret and a different seed.
- The result at `create` time is not used: authenticators do not all return one, and some browsers return none.

## 2. The seed

```
seed = HKDF-SHA256(ikm = PRF, salt = empty, info = "forest.foundation/seed/v1", length = 32)
```

HKDF is RFC 5869 as exposed by Web Crypto. An empty salt is defined there as a string of 32 zero bytes. The seed is deterministic: the same passkey gives the same seed on any device, on any day, in any app.

## 3. Keys per profile

Profile indexes are whole numbers starting at 0, written in decimal inside the info strings. For profile `n`:

| Key | Derivation | Curve | Used for |
|---|---|---|---|
| control | `HKDF-SHA256(seed, salt = empty, info = "forest.foundation/profile/<n>/control/v1", 32)` as a private scalar | secp256k1 | did:plc rotation key: it can change the profile's directory record |
| signing | `HKDF-SHA256(seed, salt = empty, info = "forest.foundation/profile/<n>/signing/v1", 32)` as a private scalar | secp256k1 | did:plc verification key: it signs the profile's folder |
| wallet | `HKDF-SHA256(seed, salt = empty, info = "forest.foundation/profile/<n>/wallet/v1", 32)` as an ed25519 seed | ed25519 | Solana wallet: it pays, and pays into escrow. The address is the public key in base58 |

Why these curves:

- did:plc accepts two key types, P-256 and secp256k1, as `did:key` strings. secp256k1 is the AT Protocol network's default (the reference host uses it for both rotation and signing keys) and the most exercised path in the AT Protocol libraries, so both did:plc keys use it. A `did:key` on secp256k1 starts with `did:key:zQ3s`.
- Solana signs only with ed25519, so the wallet key is ed25519. Its 32-byte private seed is what Solana tooling accepts as a keypair seed.

Why one HKDF call per key: each call has its own info string, so every key is an independent output of the same one-way function. A control key cannot be computed from a signing key, a wallet from either, profile 1 from profile 0, or the seed from any key.

The secp256k1 private scalar must be in `[1, n-1]`. An HKDF output outside it has a chance below one in 2^127. The library then throws; there is no retry rule.

The control and signing keys are held as `@atproto/crypto` keypairs, not exportable. The wallet is returned as bytes because Solana tooling needs them.

## 4. The identity secret, one per person

The registry holds one entry per verified human, not one per profile. The entry is a commitment; a proof against the list of commitments shows that a verified human is registering without showing which one. That needs one secret per person.

```
identity secret = HKDF-SHA256(seed, salt = empty, info = "forest.foundation/identity/v1", length = 32)
```

No profile index in the info string, on purpose: one seed, one identity, whatever profiles the person opens. A per-profile identity would put the same human on the list once per folder, which is the thing the registry exists to prevent.

From those 32 bytes the Semaphore library builds the identity and its commitment, unchanged. What the commitment is a hash of is Semaphore's definition, baked into the sealed circuit, and is restated here only so it can be checked:

1. `h` = the first 32 bytes of BLAKE-512 of the 32 bytes.
2. Prune: `h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40`.
3. `secret scalar` = (the little-endian integer of `h`, shifted right 3) mod `l`, the Baby Jubjub subgroup order.
4. `public key` = `secret scalar * B8` on Baby Jubjub.
5. `commitment` = `Poseidon(2)` of the public key's two coordinates.

The commitment is the only part that ever leaves the device, and it goes to the issuer once, after the face check. The identity itself is rebuilt from the seed whenever a proof is needed; nothing is stored.

## 5. The central wallet, one per person

A person has one central wallet besides one wallet per profile. It is where money enters from a ramp and leaves to one; it never pays a seller and never receives from a buyer, so every deal touches only profile wallets and every receipt binds to a profile.

```
central wallet = HKDF-SHA256(seed, salt = empty, info = "forest.foundation/central/v1", length = 32) as an ed25519 seed
```

No profile index, like the identity secret: one per seed, whatever profiles the person opens. Otherwise it is a Solana wallet exactly like a profile's (section 3): the 32 bytes are the ed25519 private seed Solana tooling accepts, and the address is the public key in base58. Its own info string makes it one more independent HKDF output, so it cannot be computed from any profile's keys or from the identity secret, and none of them from it.

Nothing links the central wallet to a profile until money moves between them. That move is where profiles can be linked on chain, which is for the app moving the money to handle, not for this recipe.

## 6. The name

A profile's name is a did:plc. Creating it takes one signed record, the genesis operation, and the name is a hash of that record. The recipe builds the record exactly as the directory's own library does, so the same inputs give the same name either way.

Parameters, both left to the caller: `handle` (the profile's handle: at creation, the random name the app gives the folder under its own domain, for example `k7m2q.app.example`) and `pds` (the host that stores the profile's folder, an https URL).

Steps:

1. The unsigned operation:
   ```
   {
     "type": "plc_operation",
     "rotationKeys": [ <control key as did:key> ],
     "verificationMethods": { "atproto": <signing key as did:key> },
     "alsoKnownAs": [ "at://" + handle ],
     "services": { "atproto_pds": { "type": "AtprotoPersonalDataServer", "endpoint": pds } },
     "prev": null
   }
   ```
   A handle already starting with `at://` is kept; a `pds` with no scheme gets `https://`.
2. Sign: encode the unsigned operation as DAG-CBOR (which sorts map keys, so field order never matters), hash it with SHA-256, sign the hash with the control key on secp256k1 with a low-S signature, and take the 64-byte compact form. `sig` is that signature in base64url without padding. The signed operation is the unsigned one plus `sig`.
3. The name: `did:plc:` followed by the first 24 characters of the lowercase, unpadded base32 (RFC 4648) of the SHA-256 of the DAG-CBOR of the signed operation.

Building and signing talk to nothing. Sending the operation to the directory is a separate step: `POST <directory>/<did>` with the signed operation as JSON, directory `https://plc.directory`. Creating a name is permanent and public; a product does it when the person asks for the profile, not before.

## 7. The seed file, for extra passkeys

The first passkey needs no file: its seed comes straight from its secret (step 2). Any further passkey opens the same seed through a seed file. Let `PRF2` be the extra passkey's secret, obtained exactly as in step 1.

```
key   = HKDF-SHA256(ikm = PRF2, salt = empty, info = "forest.foundation/seed-file/key/v1",   32)
label = base64url, no padding, of HKDF-SHA256(ikm = PRF2, salt = empty, info = "forest.foundation/seed-file/label/v1", 32)
nonce = 12 random bytes, fresh for every file written
body  = AES-256-GCM(key, nonce, plaintext = seed, additional data = the UTF-8 bytes of label)
file  = { "label": label, "ciphertext": base64url, no padding, of (nonce || body) }
```

`body` is 48 bytes (32 of seed, 16 of tag), so the ciphertext decodes to 60 bytes. Under the same passkey the label is always the same and the ciphertext is always different.

The unlock rule, for any passkey:

1. Ask the passkey for its secret, `PRF`.
2. Compute `label` from `PRF`.
3. If a file exists under that label, unwrap the seed from it with the key from `PRF`.
4. Otherwise the seed is `HKDF(PRF)` from step 2.

So a new device finds its own seed file from nothing but its passkey, and the first passkey is just the case where no file exists. A store that serves files by label learns a random-looking label, random-looking bytes, and that the same label was written more than once. Nothing in a file names a person, a profile, or a passkey. Anyone can store these files; a product's store is one option, and a person can keep one anywhere.

Unwrapping fails, loudly, when the label does not match the passkey, when the ciphertext has the wrong length, and when the tag does not verify, which covers the wrong passkey and any damage.

## 8. The 24 words, a backup

The words are a backup, not a login. There is one way in: a passkey makes the seed (step 2) or opens it (step 7). The words are optional, and they are how the seed travels anywhere: typed into a device, they restore the seed there, and the app then writes a seed file under that device's passkey (step 7), so from then on the passkey opens it and nobody types the words again.

The seed is written as a BIP39 mnemonic in the English word list: 32 bytes of entropy plus an 8-bit checksum, 24 words. Import trims and lowercases the text, splits on any whitespace, checks the count and the checksum, and returns the 32 bytes. BIP39's own PBKDF2 "seed" step is not used and not needed: the words encode the seed itself.

The words open everything. They are for paper, never for a screen that syncs, a photo, or a message.

## 9. Fixed strings and encodings

| Name | Value |
|---|---|
| PRF input | UTF-8 of `forest.foundation/prf/v1` |
| Seed info | `forest.foundation/seed/v1` |
| Profile key info | `forest.foundation/profile/<n>/control/v1`, `.../signing/v1`, `.../wallet/v1` |
| Seed file info | `forest.foundation/seed-file/key/v1`, `forest.foundation/seed-file/label/v1` |
| Identity info | `forest.foundation/identity/v1`, with no profile index |
| Central wallet info | `forest.foundation/central/v1`, with no profile index |
| HKDF | SHA-256, empty salt, output 32 bytes everywhere |
| Cipher | AES-256-GCM, 12-byte nonce, 16-byte tag, label as additional data |
| Encodings | did:key per the AT Protocol (`z` base58btc multikey); wallet address base58btc; label and ciphertext base64url without padding; DID suffix base32 lowercase without padding |

A change to any value here is a new version with a new suffix. The old version keeps working for the seeds it made.

## 10. What this does not do

- No recovery without a passkey or the words. Lose every passkey and the paper, and the seed is gone. Nobody can reset it, because nobody else has it.
- No way back into the registry once the seed is gone. The identity secret comes from the seed, so losing the seed loses the identity: the badges stay on the chain, nobody else can use them, and the person cannot be put on the list again without another face check.
- No server. The recipe never sends anything anywhere; sending a genesis operation to the directory is a separate call the app makes on purpose.
- No email, no phone, no account. There is nothing to sign up for.
- No storage inside the library. The app decides where a seed file goes; the library only makes and opens them.
- No wiping of memory. JavaScript cannot guarantee that bytes are erased; a product closes the tab, not the recipe.
- No promise about a moved passkey. The design assumes a passkey copied between providers does not keep its PRF secret; such a passkey needs its own seed file.

## 11. Test vectors

`test/vectors.json` pins, for one PRF output: the seed, profiles 0 and 1 (control and signing `did:key`, wallet address, did:plc and signature for handle `handle.example` and host `https://host.example`), the identity secret with its secret scalar, public key and commitment, the central wallet's address, the 24 words, and one seed file made under a second PRF output. `npm test` checks them, checks HKDF against a second implementation, checks the genesis operation against the directory's own library, and recomputes the commitment step by step without the Semaphore wrapper.

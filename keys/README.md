# keys

Up: [the repo](../README.md).

## What it is

The standard for a person's keys in Forest, and a small library that follows it. The standard is
the 24 words and the recipe; the rules for apps are defaults an app adopts, or says it doesn't. A
person owns one seed: 24 random words. Their main keys, inbox keys and issuer secrets are mixed
from it, on their own device. Any app that follows this page gets the same keys from the same
seed, so a person is never locked into one app. Where the app keeps the seed is its choice: by
default the device's secure slot, with the words in the person's password manager (the vault) as
the backup.

This README is the standard. The library in `src/` follows it, and `test/vectors.json` pins its
answers.

## How it works

### The 24 words

- The seed is 32 random bytes, written as 24 English words: BIP39, the 32 bytes plus an 8-bit
  checksum.
- Where the seed lives is the app's choice. By default it lives in the app's slot of the OS
  keychain (Apple's Keychain or Android's Keystore), unlocked by the person's biometrics, face or
  fingerprint, and used only to derive something new. The words in the vault are the backup.
- The words are the 32 bytes and nothing more. BIP39's own seed step (PBKDF2, with a passphrase)
  is not used.
- Case and spacing in the words do not matter. A wrong word, or a word out of place, fails the
  checksum.

### The recipe

Every mix is HKDF-SHA256 (RFC 5869): an empty salt, the info string's UTF-8 bytes, 32 bytes out.

| From | Mixed with (info) | Gives | Used for |
|---|---|---|---|
| seed | `forest/v1/profile/<label>` | the main key (ed25519) | the profile's name and Solana address, and its signature on records and transactions |
| the main key's 32 private bytes | `forest/v1/read` | the profile's inbox key (age's post-quantum hybrid) | opening messages and private records encrypted to the profile |
| seed | `forest/v1/issuer/<issuer name>` | the person's secret for that issuer | the person's note number for that issuer, and their stamps |

The info strings are hashed into every key, so they stay as written, `profile` and `read`
included: a new string is a new key for everyone. From the issuer secret on, Poseidon takes over
(below).

**The main key.**
- One profile per label. A label is free text, used exactly as given, as UTF-8:
  `Tutoring/Seller` and `tutoring/seller` are two profiles. The recommended form is `market/role`,
  such as `tutoring/seller`.
- The 32 bytes are an ed25519 private key (RFC 8032), in the seed form Solana tooling accepts for
  a keypair: the main key is a Solana address by nature.
- The address is the public key in base58 (the Bitcoin alphabet). It is the profile's name and its
  Solana address: one key, so a name and an address can never disagree.
- A chain other than Solana gets an address derived from the main key and published in the
  profile. Only Solana is used now, and no code derives another.

**The inbox key.**
- Mixed from the main key, not from the seed: whoever holds a main key can read what is encrypted
  to its profile.
- The 32 bytes are used unchanged as age's post-quantum hybrid identity, `mlkem768x25519`
  (ML-KEM-768 with X25519): `AGE-SECRET-KEY-PQ-1`, then bech32 of the bytes, in upper case. age
  expands them into the two private keys.
- Others encrypt to its recipient, `age1pq1…`, which age computes from the identity. It is long:
  about 1,960 characters. Anyone else opens what is encrypted to it only if both ML-KEM-768 and
  X25519 are broken.
- The profile publishes the recipient, the key's public half; the address does not give it.

**The issuer secret, the note number and the stamps.**
- An issuer is anyone who signs notes for people, such as one that checks faces
  ([registry](../registry/README.md#the-note-and-the-person-proof)). Its name is the text it
  publishes as its own, such as a domain, used exactly as given, as UTF-8. The secret is mixed
  from the name, not from the issuer's key, so a new key changes no one's stamps.
- The 32 bytes become a number the way Semaphore v4 made its secret scalar (zk-kit's
  `deriveSecretScalar`, `@zk-kit/eddsa-poseidon` 1.0.4), restated here only so it can be checked:
  1. `h` = the first 32 bytes of BLAKE-512 of the 32 bytes.
  2. Prune: `h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40`.
  3. The scalar = (`h` read little-endian, shifted right 3) mod `l`, the Baby Jubjub subgroup
     order.
- **The note number** = Poseidon(1) of the scalar (circomlib's Poseidon). It goes to that issuer
  once, and the issuer signs it in the person's note. The secret is mixed again from the seed
  whenever a proof is needed; nothing is stored.
- **A stamp** = Poseidon(scope, scalar), one for each label, with the label as its scope. The
  registry says how a label becomes a scope ([registry](../registry/README.md)).

### Rules for apps that hold keys

1. The seed and the main keys stay in the device's secure slot.
2. Every signature asks for the person's face or fingerprint and shows what is being signed; the
   person may relax this per action, and the default is never relaxed.
3. Nothing leaves the device but access keys and signatures.
4. Each connection gets its own access key for each folder.
5. Proofs are made in the app, never delegated.
6. The app works with any host, and its host with any app.
7. A server that acts for you holds access keys with write, message or read scope, never a pay key.
8. The app that holds the seed is open source.
9. Keep a copy of every record signed; a host may drop one, and the copy puts it back.
10. Keep each grant, an access key handed to the person, as a private record in their own folder.

**Access keys.** A person hands out access keys, never a main key. An access key has one of four
scopes. Write: a key listed in the folder's permissions record ([records](../records/README.md)).
Message: a key that sends and pulls the profile's messages. Read: a read key, which the owner makes
at random and hands over; nothing here mixes it, and how it reaches the reader is the app's. Pay:
the chain's own token allowance to a key, with no Forest format. Where a holder keeps the access
keys it is handed is its own business; the foundation's key holder is one place
([services](https://github.com/foundationforest/services)). The profile's own inbox key is mixed
(above), not made.

### Use it

Everything is exported from `src/index.ts`. Everything that mixes is async.

| Function | Gives |
|---|---|
| `newSeed()` | A new seed: 32 random bytes |
| `exportWords(seed)`, `importWords(text)` | The 24 words, and the seed back from them |
| `mainKey(seed, label)` | The main key: `label`, `privateKey`, `publicKey`, `address` |
| `readingKey(main.privateKey)` | The inbox key: age's `identity`, and the `recipient` others encrypt to |
| `issuerSecret(seed, name)` | The issuer's `secret`, its `scalar`, and the `noteNumber` |
| `hkdf(ikm, info)`, `INFO` | The mixer and its info strings |

```
cd keys
npm ci
npm test        # the pinned vectors, and each value recomputed without the library
npm run check   # type-check
npm run build   # dist/ for other packages
```

Node 22.18 or later runs the TypeScript directly.

### Test vectors

`test/vectors.json` pins, for the seed `00 01 … 1f`: its 24 words; the main keys for
`tutoring/seller` and `tutoring/buyer`, each with its inbox key; and the issuer secrets, scalars
and note numbers for two issuers, `issuer-a.example` and `issuer-b.example`. `npm test` checks
each value and recomputes it without the library: HKDF from a second implementation, ed25519 from
`@noble/curves`, the hybrid recipient from `@noble/post-quantum`, age's bech32 by hand, an
encryption and an opening through age, and the scalar step by step without zk-kit.

## Promises

- **The same seed gives the same keys,** in any app, on any device, every time.
- **Nothing ties two profiles together.** Each label is its own mix: one profile's main key,
  address or inbox key says nothing about another's.
- **Nothing ties two issuers together.** Each issuer is its own mix, so the same person's note
  numbers for two issuers are unrelated, and two issuers comparing what they hold cannot match
  them.
- **No key gives the seed back.** Every mix is one way. A main key gives its inbox key, and
  nothing else.
- **Nothing leaves the device.** The library talks to no network and stores nothing.

## Limits

- **It trusts the device's secure slot and the vault** to keep the seed and the words, and show
  them to no one else.
- **It trusts its pieces, used unchanged:** Web Crypto (HKDF-SHA256, and its random source for new
  seeds), `@noble/curves` (ed25519), `@scure/base` (base58, bech32), `@scure/bip39`,
  `age-encryption` (whose hybrid runs on `@noble/post-quantum`), `@zk-kit/eddsa-poseidon` 1.0.4,
  the version the registry's client uses, and `poseidon-lite` 0.3.0.
- **An issuer's name is its own to keep unique.** Two issuers under one name get the same note
  number from each person, so they can match their people.
- **No recovery.** Lose the device and the words, and every profile and every stamp is gone.
  Nobody can reset them, because nobody else has them.
- **No rotation.** A profile's name is its key, so a leaked main key loses that profile for good
  (see the FAQ).
- **One profile per label per seed.** The same seed and label always give the same key.
- **Only the inbox key and read keys are post-quantum.** ed25519 and Semaphore's curves fall to a
  large quantum computer; the inbox key and read keys, age's ML-KEM-768 hybrid, do not (see the
  FAQ).
- **No wiping of memory.** JavaScript cannot promise that bytes are erased; an app closes the
  page, the library cannot.
- **Tests run in Node.**

## Who decides what

- **The standard:** the 24 words, the recipe and its info strings.
- **An app, with the person:** which of the rules above it adopts; where the seed and keys live and
  how the face or fingerprint opens them; backups; how a read key reaches its reader.
- **A service:** nothing. No service holds a main key.

## FAQ

**Why 24 words?**
24 words are 256 random bits: nobody guesses them. A secret one provider keeps for you stays with
that provider; words go anywhere, so the seed works with any app on any device. The cost: whoever
gets the words gets every key.

**What if I give the words to the wrong app?**
Then that app has everything the seed opens, and nothing takes it back:
- every profile: labels are public, so it can mix any main key, sign as that profile and move its
  money;
- every inbox key, so it can open the person's private records and messages;
- every issuer secret, so it can use their stamps. In a market where the person has no registry
  row yet, it can take that row for a profile of its own, and this seed can never have one there.

There is no rotation, so the only way out is a new seed and new profiles, moving the money first if
there is still time. Another app that asks for 24 words takes them as an ordinary recovery phrase
and shows unrelated accounts: they are not the person's profiles, but that app now holds the seed.
Give the words only to an app that follows the rules above.

**Why is one key a profile's name, its signature and its Solana address?**
So a registry row names the profile itself, with nothing to cross-check. The name is the key's
base58 address, not an identifier in some other format: one spelling names the profile in records,
on the registry and on Solana, and it needs no directory that could refuse, withhold or misorder
it.

**Can anyone tell that two profiles are mine?**
Not from the keys. Each main key is mixed from the seed and its own label, and each issuer secret
from the seed and its issuer's name, so nothing public ties two of a person's profiles together,
or their note numbers for two issuers: off chain they are private by default. How an app writes
them can still link them ([records](../records/README.md), Limits). On chain, moving money between
your own profiles links them until a privacy pool is used.

**Why a separate inbox key and not the main key?**
Signing and encrypting need different kinds of key: the main key is ed25519, which signs, and
nothing is ever encrypted to a main key. The inbox key is mixed from the main key, so there is
nothing extra to keep.

**Why that kind of key?**
Private records sit in public for years, so what they are encrypted to is post-quantum: a copy
taken today stays closed once quantum computers come. Signing does not need that yet: a signature
can only be forged once such a computer exists.

**Why is the inbox key mixed from the main key, not from the seed?**
So that whoever holds a profile can read what is encrypted to it, and nothing more: the inbox key
gives no other profile, and no main key gives the seed.

**Why two mixers, HKDF and Poseidon?**
They work in different places. HKDF-SHA256 mixes every key from the seed, on the device: it is a
standard, built into every browser's Web Crypto, and well studied. Poseidon is a hash made to be
cheap inside a zero-knowledge proof, where SHA-256 costs far more. The registry's circuit uses it
to turn the issuer secret into the note number and a stamp, so a proof can show that an issuer
signed a note for the note number, and give the stamp, without showing which note. So HKDF mixes
up to the issuer secret, outside the proof, and Poseidon takes it from there. Neither is ours;
both are used unchanged.

**What about quantum computers?**
Only the inbox key and read keys are post-quantum, so that a private record copied today stays
private once quantum computers come. A large enough quantum computer could:
- work out from a profile's address what signs for it, then sign as the profile and move its
  money;
- forge Semaphore proofs, whose curves it breaks too.

It could not open private records, even ones copied today to open later:
- the inbox key is age's hybrid, so its recipient gives nothing away unless ML-KEM-768 breaks
  too;
- breaking an address gives ed25519's signing number, not the main key's 32 private bytes the
  inbox key is mixed from: ed25519 hashes those bytes with SHA-512 first, and SHA-512 holds.

Nor could it undo the mixes: HKDF-SHA256, and so the seed, holds. Quantum-safe main keys would
be a new version with new info strings, and since a name is a key, every profile would get a new
name.

**What if a main key leaks?**
Whoever has it is that profile: it can sign records as the profile, move its money, and mix its
inbox key to open its private records. It cannot reach the seed, another profile, or an issuer
secret. There is no rotation, because the name is the key, and nothing in Forest marks the profile
as leaked: the person stops using it. Its registry row stays with it, because rows never change.
The same seed and label always give the leaked key, and the stamp depends on the seed, the
issuer's name and the label, never on the profile. So with this seed, that label with that issuer
is gone for good.

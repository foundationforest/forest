# keys

Up: [the repo](../README.md).

## What it is

The standard for a person's keys in Forest, and a small library that follows it. The standard is
the 24 words, the recipe and the rules for apps. A person owns one seed: 24 random words. Their main
keys, reading keys and list secrets are mixed from it, on their own device. Any app that follows
this page gets the same keys from the same seed, so a person is never locked into one app. The app
keeps the seed in the device's secure slot; the words in the person's password manager (the vault)
are the backup.

This README is the standard. The library in `src/` follows it, and `test/vectors.json` pins its
answers.

## How it works

### The 24 words

- The seed is 32 random bytes, written as 24 English words: BIP39, the 32 bytes plus an 8-bit
  checksum.
- The seed lives in the app's slot of the OS keychain (Apple's Keychain or Android's Keystore),
  unlocked by the person's biometrics, face or fingerprint, and used only to derive something new.
  The words in the vault are the backup.
- The words are the 32 bytes and nothing more. BIP39's own seed step (PBKDF2, with a passphrase)
  is not used.
- Case and spacing in the words do not matter. A wrong word, or a word out of place, fails the
  checksum.

### The recipe

Every mix is HKDF-SHA256 (RFC 5869): an empty salt, the info string's UTF-8 bytes, 32 bytes out.

| From | Mixed with (info) | Gives | Used for |
|---|---|---|---|
| seed | `forest/v1/profile/<label>` | the main key (ed25519) | the profile's name and Solana address, and its signature on records and transactions |
| the main key's 32 private bytes | `forest/v1/read` | the profile's reading key (age's post-quantum hybrid) | opening private records encrypted to the profile |
| seed | `forest/v1/list/<issuer address>` | the person's secret for that issuer's list (Semaphore v4) | the person's stamp on that list, and their market stamps |

The info strings are hashed into every key, so they stay as written, `profile` included: a new
string is a new key for everyone. From the list secret on, Semaphore's own hashes take over
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

**The reading key.**
- Mixed from the main key, not from the seed: whoever holds a main key can read what is encrypted
  to its profile.
- The 32 bytes are used unchanged as age's post-quantum hybrid identity, `mlkem768x25519`
  (ML-KEM-768 with X25519): `AGE-SECRET-KEY-PQ-1`, then bech32 of the bytes, in upper case. age
  expands them into the two private keys.
- Others encrypt to its recipient, `age1pq1…`, which age computes from the identity. It is long:
  about 1,960 characters. Anyone else opens what is encrypted to it only if both ML-KEM-768 and
  X25519 are broken.
- The address does not give the recipient: whoever encrypts needs it from the profile.

**The list secret and the stamps.**
- An issuer is anyone who keeps a list of stamps, such as the human list. The issuer's address is
  its 32-byte ed25519 public key in base58, in its one spelling.
- The 32 bytes go unchanged into Semaphore v4's identity (`@semaphore-protocol/identity` 4.12.1).
  Semaphore then computes the following, restated here only so it can be checked:
  1. `h` = the first 32 bytes of BLAKE-512 of the 32 bytes.
  2. Prune: `h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40`.
  3. The secret scalar = (`h` read little-endian, shifted right 3) mod `l`, the Baby Jubjub
     subgroup order.
  4. The public key = the secret scalar times `B8`, on Baby Jubjub.
  5. **The stamp** = Poseidon(2) of the public key's two coordinates.
- The stamp goes to that issuer once. The secret is mixed again from the seed whenever a proof is
  needed; nothing is stored.
- **A market stamp** is Semaphore's nullifier, Poseidon(scope, secret scalar), with the label as
  its scope. The registry says how a label becomes a scope ([registry](../registry/README.md)).

### Rules for apps that hold keys

1. The seed and the main keys stay in the device's secure slot.
2. Every signature asks for the person's face or fingerprint and shows what is being signed; the
   person may relax this per action, and the default is never relaxed.
3. Nothing leaves the device but access keys and signatures.
4. Each connection gets its own access key for each folder.
5. Proofs are made in the app, never delegated.
6. The app works with any host, and its host with any app.
7. A server that writes for you holds write-scoped access keys only, never a pay-scoped one.
8. The app that holds the seed is open source.
9. Keep a copy of every record signed; a host may drop one, and the copy puts it back.

**Access keys.** A person hands out access keys, never a main key. An access key has one of three
scopes. Write: a key listed in the folder's permissions record ([records](../records/README.md)).
Read: a reading key the owner makes at random and hands over; nothing here mixes it, and how it
reaches the reader is the app's. Pay: the chain's own token allowance to a key, with no Forest
format. The profile's own reading key is still mixed (above).

### Use it

Everything is exported from `src/index.ts`. Everything that mixes is async.

| Function | Gives |
|---|---|
| `newSeed()` | A new seed: 32 random bytes |
| `exportWords(seed)`, `importWords(text)` | The 24 words, and the seed back from them |
| `mainKey(seed, label)` | The main key: `label`, `privateKey`, `publicKey`, `address` |
| `readingKey(main.privateKey)` | The reading key: age's `identity`, and the `recipient` others encrypt to |
| `listSecret(seed, issuer)` | The list's `secret`, Semaphore's `identity`, and the `stamp` |
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
`tutoring/seller` and `tutoring/buyer`, each with its reading key; and the list secrets and stamps
for two issuers. `npm test` checks each value and recomputes it without the library: HKDF from a
second implementation, ed25519 from `@noble/curves`, the hybrid recipient from
`@noble/post-quantum`, age's bech32 by hand, an encryption and an opening through age, and the
stamp step by step without Semaphore's wrapper.

## Promises

- **The same seed gives the same keys,** in any app, on any device, every time.
- **Nothing ties two profiles together.** Each label is its own mix: one profile's main key,
  address or reading key says nothing about another's.
- **Nothing ties two lists together.** Each issuer is its own mix, so the same person's stamps on
  two lists are unrelated, and two issuers comparing their lists cannot match them.
- **No key gives the seed back.** Every mix is one way. A main key gives its reading key, and
  nothing else.
- **Nothing leaves the device.** The library talks to no network and stores nothing.

## Limits

- **It trusts the device's secure slot and the vault** to keep the seed and the words, and show
  them to no one else.
- **It trusts its pieces, used unchanged:** Web Crypto (HKDF-SHA256, and its random source for new
  seeds), `@noble/curves` (ed25519), `@scure/base` (base58, bech32), `@scure/bip39`,
  `age-encryption` (whose hybrid runs on `@noble/post-quantum`), and
  `@semaphore-protocol/identity` 4.12.1, the version that matches the registry's setup files.
- **No recovery.** Lose the device and the words, and every profile and every stamp is gone.
  Nobody can reset them, because nobody else has them.
- **No rotation.** A profile's name is its key, so a leaked main key loses that profile for good
  (see the FAQ).
- **One profile per label per seed.** The same seed and label always give the same key.
- **Only the reading key is post-quantum.** ed25519 and Semaphore's curves fall to a large quantum
  computer; the reading key, age's ML-KEM-768 hybrid, does not (see the FAQ).
- **No wiping of memory.** JavaScript cannot promise that bytes are erased; an app closes the
  page, the library cannot.
- **Tests run in Node.**

## FAQ

**Why 24 words?**
24 words are 256 random bits: nobody guesses them. A secret one provider keeps for you stays with
that provider; words go anywhere, so the seed works with any app on any device. The cost: whoever
gets the words gets every key.

**What if I give the words to the wrong app?**
Then that app has everything the seed opens, and nothing takes it back:
- every profile: labels are public, so it can mix any main key, sign as that profile and move its
  money;
- every reading key, so it can open the person's private records;
- every list secret, so it can use their stamps. In a market where the person has no registry row
  yet, it can take that row for a profile of its own, and this seed can never have one there.

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
Not from the keys. Each main key is mixed from the seed and its own label, and each list secret
from the seed and its issuer's address, so nothing public ties two of a person's profiles together,
or their stamps on two lists: off chain they are private by default. How an app writes them can
still link them ([records](../records/README.md), Limits). On chain, moving money between your own
profiles links them until a privacy pool is used.

**Why is the reading key mixed from the main key, not from the seed?**
So that whoever holds a profile can read what is encrypted to it, and nothing more: the reading key
gives no other profile, and no main key gives the seed.

**Why two mixers, HKDF and Poseidon?**
They work in different places. HKDF-SHA256 mixes every key from the seed, on the device: it is a
standard, built into every browser's Web Crypto, and well studied. Poseidon is a hash made to be
cheap inside a zero-knowledge proof, where SHA-256 costs far more. Semaphore's circuit uses it to
turn the list secret into the stamp and the market stamp, so a proof can show that a stamp is on a
list, and give its market stamp, without showing which stamp. So HKDF mixes up to the list secret,
outside the proof, and Semaphore's hashes take it from there. Neither is ours; both are used
unchanged.

**What about quantum computers?**
Only the reading key is post-quantum, so that a private record copied today stays private once
quantum computers come. A large enough quantum computer could:
- work out from a profile's address what signs for it, then sign as the profile and move its
  money;
- forge Semaphore proofs, whose curves it breaks too.

It could not open private records, even ones copied today to open later:
- the reading key is age's hybrid, so its recipient gives nothing away unless ML-KEM-768 breaks
  too;
- breaking an address gives ed25519's signing number, not the main key's 32 private bytes the
  reading key is mixed from: ed25519 hashes those bytes with SHA-512 first, and SHA-512 holds.

Nor could it undo the mixes: HKDF-SHA256, and so the seed, holds. Quantum-safe main keys would
be a new version with new info strings, and since a name is a key, every profile would get a new
name.

**What if a main key leaks?**
Whoever has it is that profile: it can sign records as the profile, move its money, and mix its
reading key to open its private records. It cannot reach the seed, another profile, or a list
secret. There is no rotation, because the name is the key, and nothing in Forest marks the profile
as leaked: the person stops using it. Its registry row stays with it, because rows never change.
The same seed and label always give the leaked key, and the market stamp depends on the seed, the
issuer and the label, never on the profile. So with this seed, that label on that list is gone for
good.

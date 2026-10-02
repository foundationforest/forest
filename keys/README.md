# keys

Up: [the repo](../README.md).

## What it is

The standard for a person's keys in Forest, and a small library that follows it. The standard is
the 24 words, the recipe and the rules for apps. A person owns one seed: 24 random words. Every key
they use is mixed from it, on their own device. Any app that follows this page gets the same keys
from the same seed, so a person is never locked into one app. Where the words live is the person's
choice.

This README is the standard. The library in `src/` follows it, and `test/vectors.json` pins its
answers.

## How it works

### The 24 words

- The seed is 32 random bytes, written as 24 English words: BIP39, the 32 bytes plus an 8-bit
  checksum.
- An app that needs a key asks for the words, mixes the key, and forgets the words.
- The words are the 32 bytes and nothing more. BIP39's own seed step (PBKDF2, with a passphrase)
  is not used.
- Case and spacing in the words do not matter. A wrong word, or a word out of place, fails the
  checksum.

### The recipe

Every mix is HKDF-SHA256 (RFC 5869): an empty salt, the info string's UTF-8 bytes, 32 bytes out.

| From | Mixed with (info) | Gives | Used for |
|---|---|---|---|
| seed | `forest/v1/profile/<label>` | the profile key (ed25519) | the profile's name, its wallet, its signature on records and transactions |
| the profile key's 32 private bytes | `forest/v1/read` | the profile's reading key (age's post-quantum hybrid) | opening private records encrypted to the profile |
| seed | `forest/v1/list/<keeper address>` | the person's secret for that list (Semaphore v4) | the person's stamp on that list, and their market stamps |

From the list secret on, Semaphore's own hashes take over (below).

**The profile key.**
- One profile per label. A label is free text, used exactly as given, as UTF-8:
  `Tutoring/Seller` and `tutoring/seller` are two profiles. The recommended form is `market/role`,
  such as `tutoring/seller`.
- The 32 bytes are an ed25519 private key (RFC 8032), in the seed form Solana tooling accepts for
  a keypair.
- The address is the public key in base58 (the Bitcoin alphabet). It is the profile's name and its
  wallet: one key, so a name and a wallet can never disagree.

**The reading key.**
- Mixed from the profile key, not from the seed: whoever holds a profile key can read what is
  encrypted to that profile.
- The 32 bytes are used unchanged as age's post-quantum hybrid identity, `mlkem768x25519`
  (ML-KEM-768 with X25519): `AGE-SECRET-KEY-PQ-1`, then bech32 of the bytes, in upper case. age
  expands them into the two private keys.
- Others encrypt to its recipient, `age1pq1…`, which age computes from the identity. It is long:
  about 1,960 characters. Anyone else opens what is encrypted to it only if both ML-KEM-768 and
  X25519 are broken.
- The address does not give the recipient: whoever encrypts needs it from the profile.

**The list secret and the stamps.**
- A keeper is anyone who keeps a list of stamps; the issuer keeps the human list. The keeper's
  address is its 32-byte ed25519 public key in base58, in its one spelling.
- The 32 bytes go unchanged into Semaphore v4's identity (`@semaphore-protocol/identity` 4.12.1).
  Semaphore then computes the following, restated here only so it can be checked:
  1. `h` = the first 32 bytes of BLAKE-512 of the 32 bytes.
  2. Prune: `h[0] &= 0xf8; h[31] &= 0x7f; h[31] |= 0x40`.
  3. The secret scalar = (`h` read little-endian, shifted right 3) mod `l`, the Baby Jubjub
     subgroup order.
  4. The public key = the secret scalar times `B8`, on Baby Jubjub.
  5. **The stamp** = Poseidon(2) of the public key's two coordinates.
- The stamp goes to that keeper once. The secret is mixed again from the seed whenever a proof is
  needed; nothing is stored.
- **A market stamp** is Semaphore's nullifier, Poseidon(scope, secret scalar), with the label as
  its scope. The registry says how a label becomes a scope ([registry](../registry/README.md)).

### Rules for apps that hold keys

1. **Never store or send the seed.** Ask for the words when a key is needed, mix it, and forget
   them. The seed opens every profile and every list, so it lives only where the person keeps the
   words.
2. **Keys stay on the device.** A key never leaves the device that mixed it, and no server holds
   one. Whoever holds a key is that profile.
3. **Show what the profile key signs.** Before each signature, show the person what it says, in
   words they can read. A key signs whatever it is handed.
4. **Keep a copy of every record signed.** Hosts are open and may drop a record; the copy puts it
   back.
5. **Hand out writer keys, never the profile key.** A helper that writes for a profile gets its
   own writer key. A writer key can be removed; a profile key cannot.

### Use it

Everything is exported from `src/index.ts`. Everything that mixes is async.

| Function | Gives |
|---|---|
| `newSeed()` | A new seed: 32 random bytes |
| `exportWords(seed)`, `importWords(text)` | The 24 words, and the seed back from them |
| `profileKey(seed, label)` | The profile key: `label`, `privateKey`, `publicKey`, `address` |
| `readingKey(profile.privateKey)` | The reading key: age's `identity`, and the `recipient` others encrypt to |
| `listSecret(seed, keeper)` | The list's `secret`, Semaphore's `identity`, and the `stamp` |
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

`test/vectors.json` pins, for the seed `00 01 … 1f`: its 24 words; the profile keys for
`tutoring/seller` and `tutoring/buyer`, each with its reading key; and the list secrets and stamps
for two keepers. `npm test` checks each value and recomputes it without the library: HKDF from a
second implementation, ed25519 from `@noble/curves`, the hybrid recipient from
`@noble/post-quantum`, age's bech32 by hand, an encryption and an opening through age, and the
stamp step by step without Semaphore's wrapper.

## Promises

- **The same seed gives the same keys,** in any app, on any device, every time.
- **Nothing ties two profiles together.** Each label is its own mix: one profile's key, address
  or reading key says nothing about another's.
- **Nothing ties two lists together.** Each keeper is its own mix, so the same person's stamps on
  two lists are unrelated, and two keepers comparing their lists cannot match them.
- **No key gives the seed back.** Every mix is one way. A profile key gives its reading key, and
  nothing else.
- **Nothing leaves the device.** The library talks to no network and stores nothing.

## Limits

- **It trusts wherever the person keeps the words** to keep them and show them to no one else.
- **It trusts its pieces, used unchanged:** Web Crypto (HKDF-SHA256, and its random source for new
  seeds), `@noble/curves` (ed25519), `@scure/base` (base58, bech32), `@scure/bip39`,
  `age-encryption` (whose hybrid runs on `@noble/post-quantum`), and
  `@semaphore-protocol/identity` 4.12.1, the version that matches the registry's setup files.
- **No recovery.** Lose the words, and every profile and every stamp is gone. Nobody can reset
  them, because nobody else has them.
- **No rotation.** A profile's name is its key, so a leaked profile key loses that profile for
  good (see the FAQ).
- **One profile per label per seed.** The same seed and label always give the same key.
- **Only the reading key is post-quantum.** ed25519 and Semaphore's curves fall to a large quantum
  computer; the reading key, age's ML-KEM-768 hybrid, does not (see the FAQ).
- **No wiping of memory.** JavaScript cannot promise that bytes are erased; an app closes the
  page, the library cannot.
- **Tests run in Node.**

## FAQ

**Why 24 words?**
24 words are 256 random bits: nobody guesses them. A secret one provider keeps for you stays with
that provider; words go anywhere, so the seed works with any app on any device, and the person
keeps it wherever they choose. How they keep it, and how they back it up, is an app's to offer, not
this standard's. No app stores the seed, so no app can leak it. The cost: whoever gets the words
gets every key.

**What if I give the words to the wrong app?**
Then that app has everything the seed opens, and nothing takes it back:
- every profile: labels are public, so it can mix any profile key, sign as that profile and move
  its money;
- every reading key, so it can open the person's private records;
- every list secret, so it can use their stamps. In a market where the person has no registry row
  yet, it can take that row for a profile of its own, and this seed can never have one there.

There is no rotation, so the only way out is a new seed and new profiles, moving the money first if
there is still time. A general wallet app takes the 24 words as an ordinary recovery phrase and
shows unrelated accounts: they are not the person's profiles, but the app now holds the seed. Give
the words only to an app that follows the rules above.

**Why is one key a profile's name, its signature and its wallet?**
So a registry row names the profile itself, with nothing to cross-check. The name is the key's
base58 address, not an identifier in some other format: one spelling names the profile in records,
on the registry and as a wallet, and it needs no directory that could refuse, withhold or misorder
it.

**Can anyone tell that two profiles are mine?**
Not from the keys. Each profile key is mixed from the seed and its own label, and each list secret
from the seed and its keeper's address, so nothing public ties two of a person's profiles together,
or their stamps on two lists: off chain they are private by default. How an app writes them can
still link them ([records](../records/README.md), Limits). On chain, moving money between your own
profiles links them until a privacy pool is used.

**Why is the reading key mixed from the profile key, not from the seed?**
So that whoever holds a profile can read what is encrypted to it, and nothing more: the reading key
gives no other profile, and no profile key gives the seed.

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
- breaking an address gives ed25519's signing number, not the profile key's 32 private bytes the
  reading key is mixed from: ed25519 hashes those bytes with SHA-512 first, and SHA-512 holds.

Nor could it undo the mixes: HKDF-SHA256, and so the seed, holds. Quantum-safe profile keys would
be a new version with new info strings, and since a name is a key, every profile would get a new
name.

**What if a profile key leaks?**
Whoever has it is that profile: it can sign records as the profile, move its money, and mix its
reading key to open its private records. It cannot reach the seed, another profile, or a list
secret. There is no rotation, because the name is the key, and nothing in Forest marks the profile
as leaked: the person stops using it. Its registry row stays with it, because rows never change.
The same seed and label always give the leaked key, and the market stamp depends on the seed, the
keeper and the label, never on the profile. So with this seed, that label on that list is gone for
good.

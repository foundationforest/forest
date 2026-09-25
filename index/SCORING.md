# How this index scores

Two scores per profile. They are never added together or blended into one number. Everyone
starts at zero. A badge means real and accountable, not good.

- **Uniqueness**: how sure this index is that a badge belongs to one real human.
- **Trust**: what the people this profile dealt with said about it, weighed by who said it and by
  what backs it up.

These are this index's opinion, not the foundation's rule. The weights live in three files anyone
can change on their own copy: `config/issuers.json`, `config/scoring.json` and
`config/aliases.json`. Another index may weigh everything differently. The code is
`src/scores/compute.ts`, and it must say the same as this page.

## Badges: which ones count

A badge is one `Registered` entry the registry program itself wrote. It counts for a profile only
if all three are true:

1. **Its name is in the directory, byte for byte.** The name before the first colon must be a
   market file's name exactly: no other case, no alias. If a role follows the colon, it must be one
   of that market's roles. Aliases never apply to badges. If they did, one person could register
   under two spellings and hold two badges in one market.
2. **The profile declares its wallet.** The entry names the wallet that signed the registration.
   The profile's own record must name the same wallet. Change the record's wallet and the badge
   stops counting at once.
3. **The profile exists** in this index.

## Uniqueness

For each counted badge (one market, or one market and role), take the owners of the lists that
vouch for it: the list owner each entry names. Each owner has a weight from 0 to 1 in
`config/issuers.json`. The foundation's issuer starts at 1; every other key is 0 until someone
sets it.

    uniqueness = 1 − (1 − w1) × (1 − w2) × …

- One issuer at weight w gives w.
- Two independent issuers count for more than either alone, and never more than 1. Two issuers at
  0.5 give 0.75.
- An issuer at 0 adds nothing.

The weight follows the owner the entry named when the badge was registered, not whoever owns the
list today.

## Evidence: what backs a review

A review can point at a deal with its `dealId`. When that id is an escrow's address, the index
reads that escrow's permanent receipt, built only from events the escrow program itself wrote.
The receipt counts only if:

- the reviewer and the reviewed are the escrow's buyer and seller, in either order, going by the
  wallets their profiles declare; and
- its token is one this index counts (`countedMints` in `config/scoring.json`; for now, USDC on
  mainnet and on devnet).

If it counts, the index asks who said yes:

| What the receipt shows | Evidence | Weight |
|---|---|---|
| Paid, and the seller accepted it (or opened it as an invoice) | both | 1 |
| Paid in full in one tap, the seller never accepted, and the seller reviewed the same deal id | one-sided, confirmed | 1 |
| Paid in full in one tap, the seller never accepted, and the seller has not reviewed it | one-sided | 0.5 |
| Withdrawn, never accepted, never paid, or closed unfunded | none | 0.05 |
| No deal id, an id with no receipt, someone else's receipt, or a token not counted | none | 0.05 |

"Paid" means the index saw the escrow funded, or saw it end in a way that paid someone from a full
balance. An ending proves the funding, because a one-tap payment has no separate funding event.

## Trust

Each review received adds:

    reviewer's weight × evidence weight × signal

- **Signal:** 5 stars is +1, 4 is +0.5, 3 is 0, 2 is −0.5, 1 is −1. A review with no rating says
  neither good nor bad, so it adds 0; it still shows in the list.
- **Reviewer's weight:** `max(u, 0.05) × (1 + t / (|t| + 1))`.
  - u is the reviewer's best uniqueness on any counted badge. A reviewer with no counted badge gets
    the floor, 0.05, so its review weighs near zero.
  - t is the reviewer's own trust. It moves the weight between nothing and twice the base, and a
    distrusted reviewer weighs less than a new one.

Because each reviewer's weight depends on its own trust, the index repeats the sum:

1. Start everyone at 0.
2. Compute every profile's trust from the others' current trust.
3. Repeat until no profile moves by more than 0.000000001, or 100 rounds.

Rules that stop cheap inflation:

- A review of yourself is ignored.
- Per reviewer and subject, one review counts per deal id that has evidence under it. All reviews
  with no evidence count once in total: the latest. Inventing deal ids adds nothing.
- Trust can go below zero. A person cannot shed it by starting over in the same market: one
  human, one badge per market.

What these rules do not stop: two real people who agree to run many small real deals and praise
each other. The handoff bounds that by identity (one badge per human per market) and by reviewer
trust. A minimum amount, or less weight for repeat deals between the same two, are open questions
in `docs/changes/index.md`.

A worked example (the end-to-end test):

- Ana and Ben are each badged at 1. They made one deal both said yes to, and each gave the other
  5 stars. Each converges to 1.618 (the golden ratio: x = 1 + x / (x + 1)).
- Cleo's badge does not count, because her profile declares another wallet. She gives Ana 1 star
  with a made-up deal id, which takes off 0.05 × 0.05 × 1 = 0.0025.
- Cleo, with no reviews, stays at 0.

## Signatures

Every score is served with a statement and two signatures. Both public keys are at `/`.

The statement, as text:

    forest.foundation/index/v1/score
    kind uniqueness            (or trust)
    did did:plc:…
    scope online-tutors        (empty for trust)
    value 1000000              (millionths; may be negative for trust)
    at 1790300000              (unix seconds, when this value was first computed)

- **Ed25519** signs the statement's UTF-8 bytes.
- **EdDSA-Poseidon** on BabyJubJub (zk-kit's, the scheme Semaphore itself uses) signs one field
  element:

      Poseidon(domain, kind, did, scope, value + 2^63, at)

  - `domain`: `fieldHash("forest.foundation/index/v1/score")`
  - `kind`: 1 for uniqueness, 2 for trust
  - `did`: `fieldHash("forest.foundation/index/v1/did/", did)`
  - `scope`: the registry's own `scopeOf(scope)`, the exact number a registration proof carries,
    so a later proof can tie a uniqueness score to a badge; 0 for trust
  - `value`: offset by 2^63, so a negative trust is still a small positive number a circuit can
    range-check

  `fieldHash` is the registry client's: keccak-256 of the namespace and the bytes, shifted right one
  byte.

A score whose value has not changed keeps its statement and signatures, so a signature someone
already holds stays good. Both keys come from one 32-byte seed (`INDEX_SIGNING_SEED`) by
HKDF-SHA256, under the labels `forest.foundation/index/ed25519/v1` and
`forest.foundation/index/eddsa-poseidon/v1`.

## When scores change

Every time a record or a chain event arrives, the index waits a quarter of a second, then
recomputes everything. At this size that is simplest; an incremental recompute is later work.

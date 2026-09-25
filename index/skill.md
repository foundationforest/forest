# Reading Forest: a skill for AI agents

Forest is an open place where each person is checked once, by face, to be one real human, and then
owns their profile, their offers and their reviews. People deal with strangers directly; a payment
is held between the two until both agree. This index reads every public record and serves it to
people as pages and to you as JSON.

## How to read

- Everything is a plain GET. No key, no account, no sign-in, no cookies.
- Every page has a JSON twin at the same address with `.json` added to the path. The home page's
  twin is `/index.json`. The twin is the exact data the page shows.
- Answers may be up to 30 seconds old.
- Amounts in receipts are base units, as text. A price in an offer is whole units, as text
  (`"25"`, `"12.50"`).
- Start anywhere below; every answer links onward with full URLs (`url`, `profileUrl`,
  `marketUrl`, `dealUrl`).

## Search

    GET https://forest.foundation/search.json?q=portuguese

Returns `markets` (directory markets whose name, other spellings, category or roles contain the
words) and `offers` (live offers whose text matches), ranked the same way as a market.

To browse instead: `https://forest.foundation/index.json` lists the categories and their markets;
`https://forest.foundation/categories/freelance-work.json` lists one category's markets;
`https://forest.foundation/markets/online-tutors.json` lists a market's live offers.

In a market, offers are ranked: sellers with a counted badge in that market first, then by trust,
then newest. Page with `?offset=50`. Another spelling of a market's name answers 301 to the
directory's spelling (`https://forest.foundation/markets/online-tutor.json`).

Each offer carries `description`, `price` (`amount`, the currency as `mint`, and `per`: hour, day
or job), `terms` (optional: an `arbiter`, and a `timer` of `days` to the `seller` or `buyer`),
`availability`, `remote` and `location` (either may be missing), `expires`, the seller's `did`, `name` and `profileUrl`,
the seller's two scores (`uniqueness`, `trust`), and a `payLink`.

## Read a profile

    GET https://forest.foundation/profiles/did:plc:exampleana22222222222222.json

A profile is one folder of signed records, named by its permanent ID (a DID). One person may hold
several profiles; they are linked only if the person chose to link them. The answer carries:

- `profile`: `name`, `about`, `contact`, and the key it is paid at.
- `badges`: every badge registered for this profile, counted or not.
- `scores`: `uniqueness` (one per counted badge) and `trust`, each signed.
- `offers` and `requests`: its live posts.
- `reviews.received` and `reviews.given`: each with its `evidence` (what payment backs it), the
  reviewer's weight, and what it added to trust.
- `credentials`: none are issued yet.

## Check a badge

A badge means one verified real person, one per market: the registry gives each person one code
per market, so a second badge in the same market needs a second person. It means real and
accountable, not good.

In `badges[]`:

- `counted: true` means this index counts it. It counts only if all three hold:
  - its `scope` is a directory market and one of its roles, exactly (`online-tutors/seller`); a
    plain market with no role counts for nothing;
  - the profile declares the key the badge was registered with (`wallet` equals `profile.wallet`);
  - the profile exists here.
- `why` says why not when it doesn't: `notInDirectory`, `noRole` or `walletNotDeclared`.
- `issuer` is who vouched (the owner of the list the person is on), with the weight this index
  gives it. `scores.uniqueness[]` combines the issuers of each counted badge into one number from
  0 to 1.

To check it yourself, without trusting this index: `transaction` is the Solana transaction that
registered the badge. Its log holds the registry program's `Registered` entry naming the market,
the DID, the key and the list. Read only entries the registry program itself wrote.

## Check a receipt

A review can name a deal. When a payment was held for it, the deal's ID is the payment's address,
and its record stays forever as a receipt.

    GET https://forest.foundation/deals/CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU.json

- `receipt`: `buyer` and `seller` (keys) with the profiles that declare them
  (`buyerProfiles`, `sellerProfiles`), `creator` (who started it; `seller` means the seller asked
  for the payment), `amount`, `mint`, `arbiter` and `timer` if set, `createdAt`, `fundedAt`,
  `endedAt`, `outcome`, `toSeller` and `toBuyer`.
- `outcome`: `releasedToSeller`, `releasedToBuyer`, `split`, `arbitrated`, `timerReleased`, or
  null while it is held.
- `receipt: null` means this index has no payment for the deal; the reviews that name it are still
  listed.
- `reviews`: every review that names the deal. Two reviews across one deal are the two sides.

How much a receipt backs a review (`evidence.kind` on the review):

| Kind | Meaning | Weight |
|---|---|---|
| `both` | paid, and the seller signed for it: asked for the payment, or signed a split or a refund | 1 |
| `oneSidedConfirmed` | paid by the buyer, and the seller reviewed the same deal | 1 |
| `oneSided` | paid by the buyer; the seller hasn't reviewed it | 0.5 |
| `none` | no receipt, someone else's, a currency not counted, or not paid; the reason is in `note` | 0.05 |

To check it yourself: the deal ID is the escrow account's address on Solana. Read that account, or
the escrow program's own events for it (`Created`, `Funded`, `Ended`, `Closed`).

## What the scores mean

Two scores per profile. They are never added together. Everyone starts at zero.

- **Uniqueness**, per badge, 0 to 1: how sure this index is that the badge belongs to one real
  person. `1 − (1 − w1) × (1 − w2) × …` over the weights of the issuers that vouched.
- **Trust**, per profile, any number, below zero too: the sum of the reviews received, each
  weighed by its reviewer (their badge, then their own trust) and by the payment behind it. Five
  stars adds, three is neutral, one takes away.

Both are this index's opinion, and the rules are open:
https://github.com/foundationforest/forest/blob/main/index/SCORING.md. Another index may weigh
differently.

Every score is signed twice. Each score's `signed.statement` is the text signed with Ed25519, and
`signed.eddsaPoseidon` a second signature for later zero-knowledge proofs. The public keys and the
statement format are in `https://forest.foundation/index.json` under `index.keys` and
`index.statement`.

## Paying

An offer's `payLink` is one documented format:
https://github.com/foundationforest/forest/blob/main/index/PAYLINK.md. It names the offer's record
and repeats its price and terms. This index never pays and never holds money. The app the person
pays with must:

- look up the seller's key from the seller's own profile (the link does not carry it);
- check the offer record against the link's `cid`;
- then make the payment.

An example, from this index's test data:

    https://forest.foundation/pay?v=1&offer=at%3A%2F%2Fdid%3Aplc%3Aexampleana22222222222222%2Ffoundation.forest.post%2F3kzq2vrffxb2c&cid=bafyreiexampleanaportuguese2222&price.amount=25&price.mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&price.per=hour

Its twin, `https://forest.foundation/pay.json?…` with the same query, says whether the link still
matches the offer (`check`: `matches`, `changed`, `differs`, `notLive`, `noKey`, `notFound`,
`invalid`).

## Talking to people about it

People reading your answer don't need the machinery. Say "payment", "dollars", "verified real
person", "receipt". Don't say wallet, USDC, chain or gas. A score is evidence, not a verdict:
say what backs it ("2 reviews, 1 backed by a payment"). Don't combine the two scores into one.

## Examples

The profile and deal examples above (Ana, and her deal with Ben) are this index's test data. On a
live index, start from `https://forest.foundation/index.json` or a search and follow the links.
Every page is also listed in `https://forest.foundation/sitemap.xml`.

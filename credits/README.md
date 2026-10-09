# credits

Up: [the repo](../README.md).

## What it is

A credit is a prepaid unit for one service, bought once and spent without the service being able
to tell who bought it. A service that sells them says what one buys: for the foundation's registry
payer, one registration; for its host, a cent of storage. Anyone can buy credits for someone else,
without learning which spends are theirs: that is how an issuer gives its people free
registrations.

A credit is a Privacy Pass token (RFC 9576, RFC 9577, RFC 9578) of type 2, Blind RSA: the service
signs it blind, over a number only the buyer's app knows, so when the credit comes back to be
spent, the service sees a good signature and nothing that ties it to the buy.

This README is the standard. The library in `src/` follows it, on Cloudflare's `privacypass-ts`,
used unchanged. It talks to no network of its own.

## How it works

### A service's key and price

A service that sells credits has an RSA-2048 key, and publishes it in its Privacy Pass issuer
directory, `GET /.well-known/private-token-issuer-directory`, as RFC 9578 writes it, with one
more field:

```
{ "issuer-request-uri": <where a buy goes>,
  "token-keys": [{ "token-type": 2, "token-key": <base64url>, "not-before"?: <Unix seconds> }, …],
  "forest-credit": { "unit": <text>, "address": <Solana address>,
                     "mint": <mint address> | "SOL", "price": <decimal text> } }
```

- `unit` says what one credit buys, in the service's own words. The standard never fixes it.
- `price` is one credit's price, in whole units of `mint`, paid to `address`.
- The latest type 2 key whose `not-before` has passed signs new credits. The service counts a key's
  credits for as long as its policy says.

### A credit

- Every credit of one service answers one challenge: token type 2, the service's host as the
  issuer's name, no redemption context and no origin info. With no context, credits can be bought
  ahead and kept.
- A credit is the token: its type (2 bytes), a nonce (32), the challenge's SHA-256 (32), the key's
  id, SHA-256 of the key (32), and the signature (256). 354 bytes, written in base64url.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes. The service
  made it blind: it signed a number the app had blinded, and never saw the nonce.
- A credit's id, on the service's spent list, is its nonce in hex.

### Buying

1. The app makes a buy of `n` credits: `n` requests, each the blinded first 98 bytes of a credit
   to be, in one batch, as `draft-ietf-privacypass-batched-tokens` writes it. It keeps each nonce,
   and each blinding's inverse: what it needs to finish, kept in the vault
   ([records](../records/README.md#the-vault)).
2. The buy's reference is SHA-256 of its bytes, written as a Solana address. Its pay link is a
   Solana Pay transfer request:
   `solana:<address>?amount=<n × price>[&spl-token=<mint>]&reference=<reference>&label=<host>`.
3. Anyone pays the link, from any wallet that reads Solana Pay. The payment carries the reference,
   so it names this buy and no other.
4. Anyone holding the buy collects it: a POST of its bytes to the `issuer-request-uri`, as
   `application/private-token-generic-batch-request`. The service hashes them, finds a finalized
   payment to its address carrying that reference, of at least `n × price`, and answers with the
   `n` blind signatures. Signing is deterministic, so the same buy collected again gets the same
   answer: a lost answer costs nothing, and gives no credit more.
5. The app finishes: it unblinds each signature and checks it against the service's key. An answer
   for another buy, or with an empty slot, finishes nothing, and the app collects again.

### Spending

- A credit is shown on the request whose action it pays for: one in RFC 9577's header,
  `Authorization: PrivateToken token="<credit>"`, or several in the request's body, as a list of
  credits in base64url, up to as many as the service takes in one request.
- The service checks it: type 2, its own challenge, a key it still counts, and the signature
  [`credit`]. Then it holds the id: an id already spent [`spent`], or held by another request in
  flight [`held`], is refused.
- Several shown together are checked, held and spent together: one that does not hold, a credit
  twice, or one spent or held refuses them all, and none is taken.
- A credit counts as spent only once its action lands; then its id joins the spent list. If the
  action fails, or can no longer land, the id is freed and the credit can be shown again, so a
  failed registration can retry.
- What the action is, and when it lands, is each service's to say, with its unit. For the registry
  payer, the action is the register transaction: it lands when confirmed, and can no longer land
  once its blockhash expires.
- The spent list holds ids only.

### Buying for someone else

The person's app hands the buyer the pay link, or the buy itself; the buyer pays; the person's app
collects and finishes.

- The buyer sees the amount and the reference, never the credits.
- The service sees who paid and the blinded buy, never which spends they become.
- An issuer gives its people free registrations by paying one-credit links for the registry payer.

### Use it

| Function | Gives |
|---|---|
| `serviceOf(origin, directory, now?)` | The service, from its directory: the key that counts, where a buy goes, its unit, address, mint and price |
| `buy(service, count)` | The buy's bytes, its reference, its pay link, and `pending`: what to keep to finish |
| `finish(pending, answer)` | The credits, each `{ service, credit }` and checked against the key; refuses any other answer |
| `authorization(credit)`, `creditOf(header)` | The header that shows one credit, and the credit back from it |
| `creditList(credits)` | Several credits as a request's body lists them |
| `checkCredit(credit, { origin, keys })` | For a service: the credit's id, or a refusal |
| `checkCredits(list, { origin, keys }, max)` | For a service: the ids of several credits shown together, at most `max`, or a refusal of them all |
| `creditId(credit)`, `referenceOf(buy)`, `challengeOf(origin)`, `checkPending(value)` | A credit's id; a buy's reference; a service's challenge; a pending buy's shape |

```ts
import { authorization, buy, finish, serviceOf } from '@forest/credits'

const service = serviceOf(origin, directory)          // its directory, read at DIRECTORY_PATH
const b = await buy(service, 1)                       // keep b.pending in the vault
// Anyone pays b.payLink. Then anyone posts b.buy to service.requestUri:
const credits = await finish(b.pending, answer)       // the answer's bytes
// Spend one: fetch(url, { headers: { authorization: authorization(credits[0]) }, … })
```

### Selling credits

A service's side, in `src/service.ts` (Node only, like records' host: its spent list is SQLite):

| Function | Gives |
|---|---|
| `keyFrom(pkcs8)` | The service's credit key from its private key, RSA-2048 in PKCS #8: what it signs with, and the bytes its directory publishes |
| `directoryOf({ requestUri, keys, credit })` | The directory to serve at `DIRECTORY_PATH`, with its `forest-credit` entry |
| `countOf(buy)`, `amountOf(price, n)` | How many credits a buy asks for, and what they cost: what its pay link asks |
| `paid(rpc, { reference, address, mint, amount })` | The signature of a finalized payment that names the reference and pays at least the amount, or null; through the RPC the service passes, two calls |
| `answer(buy, key, origin)` | The blind signatures for a paid buy: one per request under the key, an empty slot for any other, the same every time |
| `SpentList` | The spent list: `hold` (held, spent or busy), `land`, `free`, each of one id or several together, all or none; and `holds`, what is held now, with the service's note on each |

A service collects a buy this way: `countOf` it and refuse more than its policy allows; `paid` for
`amountOf(price, n)` at the buy's `referenceOf`; then `answer` it. It spends a credit this way:
`checkCredit` (or, for several, `checkCredits`), then `hold` its id (or their ids, together) with a
note of what to look for, and `land` or `free` it once it knows whether the action landed; on a restart it settles each of `holds()`. Nothing in it
logs what it is sent.

### Run it

```
cd credits
npm ci
npm run check   # type-check
npm test        # against a stand-in service made of Cloudflare's own issuer and origin, and the service side against a stand-in RPC
```

Node 22.18 or later. Built from existing pieces, used unchanged: `@cloudflare/privacypass-ts` 0.9.0,
and its `@cloudflare/blindrsa-ts`, for the tokens, the blinding and the batch; `@scure/base` for
base58 and base64url.

## Promises

- **A service cannot tell which buy a credit came from.** It signed the credit blind and never saw
  its nonce (but see Limits).
- **A credit is spent once, and only once its action lands.**
- **A buy is paid once.** Collecting it again gives the same credits, never more.
- **Credits are never refunded, never move between people, and never stand in for money.** One
  credit is one unit of one service, and nothing anywhere else.

## Limits

- **A credit names nobody, so it is a bearer token.** That is what makes it unlinkable. The
  standard has no way to move a credit, but nothing stops a person from handing its bytes to
  someone else, and whoever holds them can spend it. Credits are as safe as the vault.
- **Timing and network address.** A service that sees a buy collected and a credit spent moments
  later, or both from one network address, can match them. Wait between them, or use a VPN.
- **One key for everyone.** The app takes the key from the service's directory. A service could give
  one person a key of their own and so know their credits, and blinding holds only when the key is
  a real RSA key. An app can compare the key with what others see; the standard cannot rule this
  out.
- **The count can show.** A buy of an unusual number of credits, spent in a burst, is easier to tell
  apart.
- **Not post-quantum.** A large quantum computer could break RSA-2048 and make credits; the service
  would change its key. It could still not link a spend to its buy: blinding hides that from any
  computer.
- **The batch is a draft.** `draft-ietf-privacypass-batched-tokens` is not an RFC yet; its encoding
  is the one `privacypass-ts` 0.9.0 writes.
- **Not audited.**

## Who decides what

- **The standard:** the credit (type 2, its challenge, its id), the directory's `forest-credit`
  entry, the buy and its reference, the pay link, the header, and the rules: spent once, only when
  the action lands; never refunded.
- **A service, by its own policy:** its unit, price, mint and address; which keys it counts and for
  how long; how many credits one buy may hold, and how many one request may show; what its action is and when it lands; how long it
  keeps a payment for collecting.
- **An app, with the person:** when to buy, how many, and whom to ask to pay.
- **A buyer:** whom it pays for.

## FAQ

**Why Privacy Pass, and why type 2?**
Privacy Pass is the IETF's standard for exactly this, with maintained libraries. Of its two token
types, type 2 (Blind RSA) fits credits for three reasons:
- anyone can check a type 2 token with the service's public key, so the app knows what it holds;
  only the service can check a type 1 token;
- its blinding state is plain bytes, so a buy someone else pays days later can be finished on
  another device, from the vault; `privacypass-ts`'s type 1 client keeps that state in memory only;
- it is the type deployed most widely, in Apple's Private Access Tokens and at Cloudflare.

The cost: a credit is 354 bytes rather than 146, and a service makes one RSA signature per credit.

**Why is a credit never refunded?**
A refund pays someone back, so the service would need to know whom: and a credit names nobody.
Refunding would mean linking the credit to its buyer, which is what credits exist to prevent.

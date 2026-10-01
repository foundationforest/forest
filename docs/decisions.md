# Decisions

Devnet only: nothing here is shipped, and nothing is on mainnet.

Up: [the repo](../README.md).

Why the code is the way it is: one line per decision, with its reason. Each still holds for the code
today. A new decision goes here, in the same form.

## Records and keys

- **One ed25519 key per profile is its name, its signature and its wallet:** a badge then names the
  profile itself, and there is nothing to cross-check.
- **did:key, not did:plc:** a name needs no directory that can refuse, withhold or misorder it.
- **Every profile's keys come from their own labels:** nothing public ties two profiles of one
  person together.
- **The profile key keeps the label it was first made with (`…/wallet/v1`):** seeds already made
  keep giving the same keys.
- **A record is signed over `0xff`, `forest.foundation/entry/v1\n`, then its canonical text:** `0xff`
  never begins a Solana transaction, so a record's signature can never be a payment's.
- **A record travels as exactly its RFC 8785 text, over a narrowed JSON:** two readers must never see
  two contents under one signature.
- **Strict Ed25519 (prime-order keys and points, then the cofactorless check):** common verifiers
  disagree on edge cases, and OpenSSL accepts a signature Forest refuses.
- **A record's id hashes what was signed, not the signature:** a second spelling of a signature is
  not a new record.
- **No relay and no directory; readers find boards through folder records, crawling and optional
  Pkarr:** nothing grows with the network but each reader's own work.
- **Boards hold no keys and have no accounts:** with nothing held, a board can stop serving but can
  never lock anyone out.
- **A board always takes a newer folder record:** otherwise leaving would be at a board's mercy.
- **Boards never log network addresses:** one phone writing for two profiles would link them by
  address.
- **No budgets in the protocol; each board's own policy decides, from signatures and the registry:**
  keys are free, and those two are enough to hold off a flood.
- **The owner outranks every delegate:** what a person writes always wins, and overwrites anything
  a stolen key or a reordering board slipped in.
- **Draft and approve by default; permissions off:** an assistant that reads a hostile review can
  only draft, and the person sees exactly what they sign.
- **Revoking a permission ends it from then on, feed by feed:** nothing depends on a reader's clock.
- **The approval page is the one place the seed opens: small, four libraries, strict CSP, published
  hash:** whoever serves it could otherwise take the keys.
- **A request travels after the `#` and gets no reply:** no server keeps the draft, and anyone can
  see the outcome on the boards.
- **Passkey signatures are never published:** one passkey serves every profile, so its key would link
  them.
- **Sealed records use age's post-quantum hybrid, without forward secrecy:** forward-secret group
  schemes need one agreed order and lock out readers who join late.
- **Pkarr is only a hint, and a phone never reaches the DHT or a Pkarr relay itself:** a lookup shows
  which address asks for which key.
- **Not AT Protocol, Nostr or Pubky as the base:** one server per profile and a central directory;
  keys that cannot be Solana keys and no revocable delegation; servers that can forge unsigned records.
- **The passkey's secret is read on `get`, never at creation:** not every authenticator returns it
  at creation.
- **A seed file's label comes from its passkey's own secret:** a new device finds its file from
  nothing but its passkey.
- **One way in, a passkey; the 24 words are a backup:** a second way in is one more path to secure,
  and nothing a person needs.
- **A lost seed cannot rejoin the same issuer's list:** a known face joining again would hold two
  secrets, so two badges per label.
- **One central wallet per person, apart from every profile; deals touch only profile wallets:**
  receipts bind to profiles, and money meets a ramp in one place.

## Record shapes

- **Decimals are text (`"8.5"`, `"38.72"`):** a record holds no fractional number.
- **An offer names its token by mint address:** a symbol can be faked.
- **A review needs only its subject; evidence weighs, it never rejects:** what is missing weighs
  less, and nothing is refused.
- **A deal id is the escrow's address, or 32 random bytes:** two reviews across one id are both
  sides' receipts, so no receipt shape is needed.
- **A profile names one market and role; offers and reviews name none:** a badge counts under its
  profile's own label.
- **Price, token and escrow options are the seller's, per offer; a market adds fields only:** a
  market is a name, not a rule.
- **A credential is kept as text:** its `@context` is not a key a record allows.

## Registry

- **Semaphore 4.0.0, from the public July 2024 ceremony, not 4.13.0:** the later setup's second
  phase has no published transcript, and a sealed program bakes one key in forever.
- **Depth 32:** it costs almost nothing on chain and about 0.3 seconds on a device.
- **Scope and message are `keccak256(namespace ‖ input) >> 8`:** a label of any length, and no value
  from one namespace collides with another's.
- **The client calls snarkjs directly, not Semaphore's `generateProof`:** that would cap a label at
  32 bytes.
- **The proof's message is the profile's key:** whoever sees a proof cannot land it under another
  profile.
- **Plain accounts, not compressed ones:** those would make a sealed program depend on an indexer, a
  prover and a forester.
- **Store each account's bump:** finding one costs 1,500 compute units a try.
- **Issuers are an open slot; the program checks no root:** who vouches for a human must be a slot
  anyone can fill, and readers weigh who did.
- **Registration is free, and nothing is built to pay for someone else:** any payer may pay, and the
  program cannot tell.
- **The program returns rent above the minimum, to whoever paid it:** only the owning program can
  move it, and Solana is cutting the rate.
- **One spelling per label, `market/role`:** two spellings are two codes, so two badges for one human.

## Escrow

- **No clock but an optional timer; money out only when both sides agree:** that is what a person
  expects of money held for them.
- **The address comes from the creator's key and an id, and the creator signs:** nobody can open an
  escrow at an address another key will use.
- **The deposit account is the escrow's associated token account:** every wallet's "send to this
  address" lands there.
- **Funded is the live balance, checked by every way out:** a receipt always means the amount was
  held, and paying in one tap needs no mark.
- **The arbiter may be anyone; every way out pays the whole balance; anyone sends a due timer:** the
  fewest rules.
- **Each party is paid only at its standard token account, checked by address alone:** no ending can
  send money elsewhere, and handing the account away blocks no way out.
- **A party's account must exist only when it is paid:** nobody should have to make an account to
  get their own money back.
- **Receipts never close; an escrow that never held the amount closes, with no wait:** a review
  points at a receipt forever, and a never-funded escrow is no receipt.
- **Only the parties may close a never-funded escrow:** the rent is not whoever fronted it's own.
- **v1 sends every rent refund to the creator:** a relayer that fronts the rent charges the person
  for it, so the refund must reach the person.
- **Wrapped SOL is refused:** a plain SOL transfer to its deposit account would not count.
- **A payment in `create`'s transaction makes the deposit address first:** a relayer that checks each
  transfer's destination can then sign it.
- **Events count only from the program's own invoke lines:** any program can write the same bytes.
- **A party cannot be the escrow or its deposit address:** neither can ever sign, give or be paid.
- **Error codes and account fields are appended, never renumbered:** old codes and offsets keep their
  meaning.
- **v1 takes classic tokens only:** a transfer fee, a permanent delegate or a hook would change what
  "hold X, release X" means, and v1 cannot be patched.

## Repo

- **Anchor 1.2, no IDL, the wire format written twice by hand:** a drift on either side fails a test,
  the check that matters for a format that can never change.
- **Overflow checks on in release builds:** an overflow aborts instead of wrapping.
- **SBPF v3 builds:** SIMD-0500 will stop deploys of the older formats.
- **Local program ids have no keypair:** LiteSVM loads a program at any address, and each deploy uses
  its own id.
- **Every devnet key comes from one phrase, by PBKDF2:** any session with the phrase gets the same
  keys, and any language reproduces them.

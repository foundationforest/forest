# Decisions

Devnet only: nothing here is shipped, and nothing is on mainnet.

Up: [the repo](../README.md).

Why the code is the way it is: one line per decision, with its reason. Each holds for the code
today. A new decision goes here, in the same form.

## Records and keys

- **One ed25519 key per profile is its name, its signature and its wallet:** a badge then names the
  profile itself, with nothing to cross-check.
- **did:key, not did:plc:** a name needs no directory that can refuse, withhold or misorder it.
- **Every profile's keys come from their own labels:** nothing public ties two profiles of one person.
- **The profile key keeps the label it was first made with (`…/wallet/v1`):** seeds already made keep
  giving the same keys.
- **One identity secret per person, with no profile index:** the registry holds one entry per human
  while the profiles stay apart.
- **A record is signed after the byte `0xff`:** no Solana transaction begins with it, so a record's
  signature can never be a payment's.
- **A record travels as exactly its RFC 8785 text:** two readers must never see two contents under one
  signature.
- **Strict Ed25519:** common verifiers disagree on edge cases, and OpenSSL accepts a signature Forest
  refuses.
- **No relay and no directory; readers find boards through folder records, crawling and optional
  Pkarr:** nothing grows with the network but each reader's own work.
- **Boards hold no keys and no accounts, and always take a newer folder record:** a board can stop
  serving, but never lock anyone in.
- **Boards never log network addresses:** one phone writing for two profiles would link them.
- **No budgets in the protocol; each board's policy decides, from signatures and the registry:** keys
  are free, and those two are enough to hold off a flood.
- **The owner outranks every delegate:** what a person writes always wins, and overwrites what a stolen
  key or a reordering board slipped in.
- **Draft and approve by default; permissions off:** an assistant that reads a hostile review can only
  draft, and the person sees exactly what they sign.
- **Revoking a permission ends it from then on, feed by feed:** nothing depends on a reader's clock.
- **The approval page is the one place the seed opens: small, four libraries, strict CSP, a published
  hash:** whoever serves it could otherwise take the keys.
- **Passkey signatures are never published:** one passkey serves every profile, so its key would link
  them.
- **Sealed records use age's post-quantum hybrid, without forward secrecy:** forward-secret group
  schemes need one agreed order and lock out readers who join late.
- **Pkarr is only a hint, and a phone never reaches the DHT or a relay itself:** a lookup shows which
  address asks for which key.
- **Not AT Protocol, Nostr or Pubky as the base:** one server per profile and a central directory;
  keys that cannot be Solana keys and no revocable delegation; servers that can forge records.
- **One way in, a passkey; the 24 words are a backup:** a second way in is one more path to secure,
  and nothing a person needs.
- **A lost seed cannot rejoin the same issuer's list:** a known face joining again would hold two
  secrets, so two badges per label.
- **One central wallet per person; deals touch only profile wallets:** receipts bind to profiles, and
  money meets a ramp in one place.
- **Pools and ramps are features an app offers; Forest builds neither:** a provider a person picks in
  an app is not the foundation acting.

## Records, markets and evidence

- **Decimals are text (`"8.5"`):** a record holds no fractional number.
- **An offer names its token by mint address:** a symbol can be faked.
- **A review needs only its subject; evidence weighs, it never rejects:** what is missing weighs less,
  and nothing is refused.
- **A deal id is the escrow's address, or 32 random bytes:** two reviews across one id are both sides'
  receipts, so no receipt shape is needed.
- **A profile names one market and role; offers and reviews name none:** a badge counts under its
  profile's own label.
- **Price, token and escrow options are the seller's, per offer; a market only adds fields:** a market
  is a name, not a rule.
- **The `markets` repo recommends spellings and gates nothing:** one trade should not split into ten
  names, and nothing in the foundation decides who may trade.
- **Programs never interpret evidence; indexes weigh it:** a sealed program cannot learn new kinds of
  evidence, and an index can.
- **No evidence that two people met:** two people who agree to lie can relay their devices from
  anywhere, and no phone signs closeness.

## Registry

- **Semaphore 4.0.0, from the public July 2024 ceremony, not 4.13.0:** the later setup's second phase
  has no published transcript, and a sealed program bakes one key in forever.
- **Depth 32:** it costs almost nothing on chain and about 0.3 seconds on a device.
- **Scope and message are `keccak256(namespace ‖ input) >> 8`, derived by the program:** a label of any
  length, and no value from one namespace collides with another's.
- **The proof's message is the profile's key:** whoever sees a proof cannot land it under another
  profile.
- **The proof is the consent, so only the payer signs:** only the secret's holder can make a proof,
  and it makes only its own profile's line.
- **One proof per `register`:** two would pass the 200,000 compute units an instruction gets by
  default.
- **No numbered per-human codes; one code per human per label:** a shared code would link a human's
  profiles.
- **Issuers are an open slot; their lists stay off chain, and the program checks no root:** anyone must
  be able to vouch, and verifying needs only a root.
- **More issuers are membership records, not changes to the line:** the roots are already public, so
  nothing on chain needs to know.
- **A line never grows, never changes and never closes:** closing it would reopen its code, and a fixed
  size makes a refund to the exact minimum safe.
- **`refund` pays only the payer the line records, and anyone may send it:** only the owning program
  can move rent the cuts free, and a caller-named destination would be a drain.
- **Registration is free, and nothing in it pays for anyone:** Forest builds for people who pay; paying
  for someone else is a layer outside.
- **Plain accounts, not compressed ones:** those would make a sealed program depend on an indexer, a
  prover and a forester.
- **One spelling per label, `market/role`:** two spellings are two codes, so two badges for one human.

## Escrow

- **No clock but an optional timer; money out only when both sides agree:** that is what a person
  expects of money held for them.
- **The address comes from the creator's key and an id, and the creator signs:** nobody can open an
  escrow at an address another key will use.
- **The deposit account is the escrow's associated token account:** every wallet's "send to this
  address" lands there.
- **Funded is the live balance, checked by every way out:** a receipt always means the amount was held,
  and paying in one tap needs no mark.
- **The arbiter may be anyone; every way out pays the whole balance; anyone sends a due timer:** the
  fewest rules.
- **Each party is paid only at its standard token account, checked by address alone:** no ending can
  send money elsewhere, and handing the account away blocks no way out.
- **Each way out names only the accounts it pays:** nobody should have to make an account for a party
  that gets nothing.
- **Receipts never close; an escrow that never held the amount is closed by a party, with no wait:** a
  review points at a receipt forever, and a never-funded escrow is no receipt.
- **No seller signature at `create`:** it would stop anyone paying an offline seller, and break paying
  in one tap. The receipt records who created it instead.
- **v1 sends every rent refund to the creator:** a relayer that fronts the rent charges the person for
  it, so the refund must reach the person.
- **Wrapped SOL is refused:** a plain SOL transfer to its deposit account would not count.
- **A payment in `create`'s transaction makes the deposit address first:** a relayer that checks each
  transfer's destination can then sign it.
- **Events count only from the program's own invoke lines:** any program can write the same bytes.
- **A party cannot be the escrow or its deposit address:** neither can ever sign, give or be paid.
- **Error codes and account fields are appended, never renumbered:** old codes and offsets keep their
  meaning in every version.
- **v1 takes classic tokens only:** a transfer fee, a permanent delegate or a hook would change what
  "hold X, release X" means, and v1 cannot be patched.
- **v2: one objection per escrow, until the timer is due:** a second would change nothing, and one
  deadline for both means they never race.
- **v2: an objection needs no timer and no money, and `close_unfunded` still runs after one:** a buyer
  can object before paying, and a part payment needs a way out.
- **v2: an ending nobody marked records its own time as the funding time:** every receipt says when
  the money was there.
- **v2: rent above the receipt's minimum goes to whoever fronted it, a relayer included:** whoever
  fronted the rent gets back what Solana's cuts free, and a relayer says so plainly.
- **v2: a transfer fee is refused at any rate, and so is a token that cannot be transferred; every other
  Token-2022 extension is accepted:** a fee takes part of every payment while every way out pays the
  whole balance, and its rate can rise; an untransferable token could never leave.

## Repo

- **Shared pieces are open, in the foundation; money flows and interfaces are products:** a piece that
  only works if everyone shares one is a public good.
- **Anchor 1.2, no IDL, the wire format written twice by hand:** a drift on either side fails a test,
  the check that matters for a format that can never change.
- **Overflow checks on in release builds:** an overflow aborts instead of wrapping.
- **SBPF v3 builds:** SIMD-0500 will stop deploys of the older formats.
- **Every devnet key comes from one phrase, by PBKDF2:** any session with the phrase gets the same keys,
  and any language reproduces them.

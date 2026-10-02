# Decisions

Devnet only: nothing here is shipped, and nothing is on mainnet.

Up: [the repo](../README.md).

Why Forest is shaped the way it is: one line per decision, with its reason. Each holds for the code
today. Smaller choices live in the code's comments and in git history. A new decision that shapes
Forest goes here, in the same form.

## Profiles and records

- **One ed25519 key per profile is its name, its signature and its wallet:** a badge then names the
  profile itself, with nothing to cross-check.
- **did:key, not did:plc:** a name needs no directory that can refuse, withhold or misorder it.
- **Each profile's keys come from their own labels, and the person's identity secret from one of its
  own:** nothing public ties two profiles together, while the registry still holds one entry per
  human.
- **A record is signed after the byte `0xff`:** no Solana transaction begins with it, so a record's
  signature can never be a payment's.
- **Boards hold no keys and no accounts, and always take a newer folder record:** a board can stop
  serving, but never lock anyone in.
- **No relay and no directory; readers find boards through folder records and crawling:** nothing
  grows with the network but each reader's own work.
- **Boards never log network addresses:** one phone writing for two profiles would link them.
- **Draft and approve by default; permissions off; the owner outranks every delegate:** an assistant
  that reads a hostile review can only draft, and what a person writes always wins.
- **The approval page is the one place the seed opens:** whoever serves a page that opens the seed
  could take the keys, so there is one, small and checkable.
- **One way in, a passkey; the 24 words are a backup:** a second way in is one more path to secure,
  and nothing a person needs.
- **One central wallet per person; deals touch only profile wallets:** receipts bind to profiles, and
  money meets a ramp in one place.
- **Not AT Protocol, Nostr or Pubky as the base:** one server per profile and a central directory;
  keys that cannot be Solana keys and no revocable delegation; servers that can forge records.

## Markets and evidence

- **A profile names one market and role; offers and reviews name none:** a badge counts under its
  profile's own label.
- **The `markets` repo recommends spellings and gates nothing; a market adds fields and restricts no
  deal:** one trade should not split into ten names, and nothing in the foundation decides who may
  trade or on what terms.
- **A review needs only its subject; evidence weighs, it never rejects:** what is missing weighs less,
  and nothing is refused.
- **A deal id is the escrow's address, or 32 random bytes:** two reviews across one id are both sides'
  receipts, so no receipt shape is needed.
- **Programs never interpret evidence; indexes weigh it:** a sealed program cannot learn new kinds of
  evidence, and an index can.

## Registry

- **Semaphore 4.0.0, from the public July 2024 ceremony:** the later setup's second phase has no
  published transcript, and a sealed program bakes one key in forever.
- **The proof is the consent; its message is the profile's key, and only the payer signs:** only the
  secret's holder can make a proof, and whoever sees one cannot land it under another profile.
- **One code per human per label, never numbered:** a code shared across registrations would link a
  human's profiles.
- **Issuers are an open slot: lists stay off chain, the program checks no root, and more issuers are
  membership records:** anyone must be able to vouch, and readers weigh who did.
- **A line never changes and never closes:** closing it would reopen its code.
- **Registration is free, and nothing in it pays for anyone:** Forest builds for people who pay;
  paying for someone else is a layer outside.

## Escrow

- **No clock but an optional timer; money out only when both sides agree:** that is what a person
  expects of money held for them.
- **Each party is paid only at its standard token account, checked by address alone:** no ending can
  send money elsewhere, and handing the account away blocks no way out.
- **Receipts never close:** a review points at a receipt forever.
- **No seller signature at `create`:** it would stop anyone paying an offline seller, and break paying
  in one tap. The receipt records who created it instead.
- **One escrow program; v1 left the repo:** new deals were already meant to use v2, and one program
  is one set of rules for an app to show and for anyone to check.
- **The escrow takes classic and Token-2022 tokens, but refuses a transfer fee or a token that cannot
  be transferred:** a fee takes part of every payment while every way out pays the whole balance,
  and an untransferable token could never leave.
- **Either party may object once, until the timer is due, and the timer is then off:** one deadline
  for both means they never race.

## Repo

- **Shared pieces are open, in the foundation; money flows and interfaces are products:** a piece that
  only works if everyone shares one is a public good.

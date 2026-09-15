# Where used codes live

Session 4, September 15, 2026. Report only. Nothing here is decided, built or shipped; the recommendation goes to Carlos. Numbers were produced this session the way session 3 produced its numbers: read from mainnet, measured from published artifacts, or computed from costs session 3 measured. `registry/FEASIBILITY.md` is the earlier report this one builds on.

## What is being decided

Every registration writes one code. A code is the proof's nullifier, the same value for the same person in the same market and unguessable for anyone else, and it is what makes "one badge per market per human" true: if the code is already recorded, the registration fails. So the program has to keep every code it has ever seen, forever, and it has to be able to answer "have I seen this one?" in the middle of a transaction.

That much is easy. The hard part is a promise Forest wants to keep later. The plan is that a person can one day prove "these are all my badges, and nothing is hidden", by walking every market in the directory and saying, for each one, either "here is my badge" or "I have none here". The second half of that sentence is the problem. Proving you *have* something is ordinary. Proving you *do not* only works if the thing you are proving absence from is shaped for it.

So the question is not "what is the cheapest way to store codes". It is "which way of storing codes leaves the later promise possible". How the codes are stored is sealed with the program, so this is the last chance to get it right.

Three shapes were compared, as asked:

1. One small account per used code.
2. An indexed Merkle tree of codes kept by the program, where each registration proves its code is not already in the tree, then inserts it.
3. Both: the account for the check, and a tree for the later proof.

## The short version

**Option 1 is the simplest and it quietly kills the later proof.** A set of Solana accounts is not something a proof can be made about. Solana used to commit its accounts in a Merkle tree; it does not any more. Since the lattice accounts hash went live on mainnet there are no paths and no proofs of any kind about accounts, in or out. A program also cannot list the accounts it owns, so it cannot build such a commitment itself. If the codes live only as accounts, the later proof has to take somebody's word for what the full set of codes is.

**Option 2 is the right structure and it does not fit in a transaction.** An indexed Merkle tree is exactly the shape that proves absence. The catch is that whoever inserts has to hand the program a Merkle path, and a Merkle path at a useful depth is about a kilobyte. A registration already uses about 1,040 bytes of the 1,232 allowed. The deepest tree whose proof still fits alongside a registration holds sixteen codes.

**Option 3 costs almost nothing on top of option 1 and is the only one that keeps the promise.** The account stays, so the "already used?" check stays the runtime's job, which is free and cannot be got wrong. The program also appends each code to an append-only tree, which needs no path in the transaction because the program keeps a small frontier itself. That tree does not prove absence by itself. What it does is make the sorted structure that *does* prove absence checkable by anyone, instead of something a publisher has to be trusted about.

**Recommended: option 3.** The reason and the price are at the end.

One shape nobody asked for is also worth a look before anything is sealed, because it removes option 2's only real problem: keep the tree itself inside accounts the program owns, instead of making every registration carry a path. It is in its own section below.

## 1. The question that decides everything: can a circuit prove a code is absent from a set of accounts?

No.

A zero-knowledge circuit proves statements about data handed to it, measured against a short commitment that the verifier already trusts. "This code is absent from the registry's accounts" needs a short commitment to the whole set of registry accounts, and it needs that commitment to support absence, which means the set has to be sorted or indexed. Solana offers neither, and it recently went further away from offering them, not closer.

Read from mainnet this session (epoch 1035, slot 447,311,221, `solana-core` 4.3.0-rc.0):

| Feature | Gate | State |
|---|---|---|
| `accounts_lt_hash`, SIMD-0215, lattice accounts hash | `LTHasHQX6661DaDD4S6A2TFi6QBuiwXKv66fB1obfHq` | activated, slot 347,328,000 |
| `remove_accounts_delta_hash` | `LTdLt9Ycbyoipz5fLysCi1NnDnASsZfmJLJXts5ZxZz` | activated, slot 348,624,000 |
| `snapshots_lt_hash`, SIMD-0220 | `LTsNAP8h1voEVVToMNBNqoiNQex4aqfUrbFhRH3mSQ2` | activated, slot 353,376,000 |

A lattice hash is a sum, not a tree. It is built to be updated cheaply when one account changes, and it has no paths at all, so nothing can be proven in it or out of it. The per-slot Merkle hash that did have paths has been removed. Even when it existed it covered only the accounts changed in one slot, and a program has no way to read it.

A program cannot enumerate its own accounts either. It sees the accounts a transaction hands it and nothing else. So the program cannot build the commitment during registration, and there is no commitment already there to borrow.

**What the completeness proof would have to trust instead, if codes live only in accounts.** Somebody reads the whole chain, collects every code the registry ever wrote, sorts them, builds an indexed tree, and publishes the root. The later proof verifies against that root. Everyone relying on the proof is now trusting that publisher to have left nothing out, and leaving a code out is exactly the thing that lets a person hide a badge. The ways to soften that all cost something real:

- A named set of publishers with a challenge window. Now the promise depends on a committee and on somebody watching.
- Have every verifier replay the chain themselves. Slow at a million codes, depends on an archival RPC being honest and complete, and it cannot happen inside a circuit anyway, so it only moves the trust to the RPC.
- Prove the sorted tree is the same set as something already committed on the chain. This is the honest fix, and it needs something committed on the chain to compare against. That is option 3.

State it plainly: with option 1 alone, "none hidden" is not a proof. It is a claim backed by whoever publishes the code list.

## 2. Option 1: one account per used code

**How it works.** The code becomes the seed of a program-derived address. Registration passes that address in; if the account already exists, the code is used and the transaction fails; otherwise the program creates it. The runtime does the whole check, and it cannot be fooled, because the address is a hash of the code and nothing else can sit at it. The account can also hold the badge entry itself (market name, DID, the code), so indexes have one place to look.

**Rent.** Mainnet rent read from the Rent sysvar this session: 5,080 lamports per byte, exemption threshold 1.0, so an account's minimum is `(128 + bytes) * 5,080`. Solana is part way through a five-step cut (SIMD-0437) toward 696. SOL at $100.24 (CoinGecko, this session).

| Layout | Bytes | Today | After the planned cuts |
|---|---|---|---|
| Code account holding the entry (market name up to 64, DID 32, code 32, discriminator, bump) | 144 | 1,381,760 lamports, 0.00138 SOL, $0.1385 | 189,312 lamports, $0.0190 |
| Code marker only, entry stored elsewhere | 40 | 853,440 lamports, $0.0855 | 116,928 lamports, $0.0117 |

At a million badges the entry layout is 1,382 SOL, about $138,500 today and about $19,000 at the final rate. Rent is locked, never spent, and never comes back, because a code account must never close or the code becomes reusable.

**Compute.** One account created through the system program, about 4,244 compute units (session 3 measured 8,488 for two). Nothing else.

**Transaction bytes.** Nothing extra. The code account's address is one of the account keys a registration already carries.

**Program simplicity.** This is the simplest thing that can work, and simplicity is worth a lot in a program that can never be patched. There is no tree to corrupt, no path to validate, no ordering to get wrong. A reviewer can check it in an afternoon.

**What could go wrong.**

- Nothing, for uniqueness. This is the strongest part of the design and it should survive into whatever is chosen.
- Rent grows without limit and is never recovered. That is what the sweep instruction in section 5 is for.
- The later proof is foreclosed, per section 1. This is the only real objection, and it is fatal on its own.

## 3. Option 2: an indexed Merkle tree kept by the program

**How it works.** An indexed Merkle tree stores its leaves linked in sorted order: each leaf carries a value plus a pointer to the next larger value. To prove a code is absent you open the one leaf whose value is below it and whose "next" is above it. That single leaf is the proof of absence, and it is short. To insert, you open that same low leaf, repoint it at the new code, and append the new leaf. The program keeps only a root.

This is the right structure for the promise. It is also the structure the later proof would want regardless of how v1 stores things.

**The problem is bytes, not compute.** Session 3's finding holds here too. The path the inserter has to supply is 32 bytes per level, plus the low leaf and its index. A registration already uses about 1,040 of the 1,232 bytes a standard transaction allows, so there are 192 bytes of headroom, plus 32 more from dropping the code account key.

| Code tree depth | Non-membership proof in the transaction | Registration total | Verdict |
|---|---|---|---|
| 32 | 1,096 B | 2,104 B | over by 872 |
| 20 | 712 B | 1,720 B | over by 488 |
| 8 | 328 B | 1,336 B | over by 104 |
| 4 | 200 B | 1,208 B | fits, and holds 16 codes |

Deeper than four levels and it does not fit. Four levels holds sixteen codes, which is not a registry.

Ways out, all with a cost: the 4,096-byte transaction format (activated on mainnet at epoch 1035, drops address lookup tables and compute-budget instructions, Kora's support unverified, and the handoff chose the standard format); or stage the path in a buffer account first, which costs a second transaction, more rent, and the atomicity that makes a registration safe; or keep the tree on the chain instead of in the transaction, which is section 4.

**Compute, if the bytes were not a problem.** Using session 3's measured 872 units per two-input Poseidon hash and 1,177 for a three-input leaf hash: about 86,100 units at depth 32 and about 54,700 at depth 20, for the low-leaf check, the low-leaf update and the append. A registration with one proof has room for that; compute is not what stops this option.

**Rent.** Better than option 1: one root account for the whole system, about 64 bytes, 975,360 lamports, $0.0978 once, instead of an account per badge. This is the option's real attraction and it is not enough to save it.

**Complexity risk in a sealed program.** High, and it is the kind of complexity that fails silently. The insert has to check the low leaf really is the predecessor (both comparisons, including the wrap-around case at the largest value), has to recompute two roots in the right order, and has to reject a malformed path rather than accepting a root nobody can reproduce. An indexed tree that accepts one bad insert is permanently wrong, and the program cannot be fixed.

**What exists to copy, rather than invent.**

| Implementation | Language | License | State |
|---|---|---|---|
| `light-indexed-merkle-tree` 7.0.0 (Light Protocol) | Rust | Apache-2.0 | Published September 10, 2026. Hashes through `light-hasher`, which depends on `solana-define-syscall`, so on Solana it uses the Poseidon syscall. Reviewed as part of Light's audited system. Its own dependencies are Light crates (`light-hasher`, `light-concurrent-merkle-tree`, `light-bounded-vec`, `light-merkle-tree-reference`). |
| `indexed-merkle-tree` 0.6.2 (deltadevsde) | Rust | MIT | Last published August 2024. Not Solana-specific. No audit found. |
| Aztec's standard indexed tree | TypeScript and C++ | Apache-2.0 | Inside the Aztec protocol, not packaged as a dependency. |

Honest answer on whether any is usable as a dependency: **not as a dependency, and only one is worth copying.** `light-indexed-merkle-tree` is the one to start from. It is the right shape, it is Apache-2.0, and it is exercised on Solana at scale. But taking it as a live dependency puts a crate that Light keeps changing (7.0.0 landed five days ago) inside a program that is sealed forever, so the code would be vendored at a pinned version and reviewed as our own. The audits cover Light's system, not our copy, so the paid review before mainnet would have to cover it again. Nothing here is a drop-in.

## 4. Option 3: an account per code, plus a tree the program appends to

**How it works.** Registration does exactly what option 1 does: the code's account must not exist, then it is created. In the same instruction the program also appends the code to an append-only tree, the same kind of tree, with the same rules, as the list of verified humans that session 3 already worked out. That tree needs no path from the client: the program keeps a frontier of one node per level and walks up from the new leaf.

**Bytes: none.** The code is already in the instruction as part of the proof's public signals. The frontier lives on the chain. A registration stays at about 1,040 bytes.

**Compute:** option 1's 4,244 units plus the append. Session 3 measured a 20-level Poseidon insert at 17,426 units, so about 21,700 units at a million badges. Under two percent of the limit.

**Rent:** option 1's per-badge cost, unchanged, plus one account once. A root, a size and a 32-level frontier is about 1,088 bytes: 6,177,280 lamports, $0.62 today, $0.085 at the final rate. Paid once, ever.

**Complexity risk: low.** It is the same append the program already performs for the human list, on a second tree. No path validation, no ordering, no comparisons. If the append were ever wrong it would be wrong for the human list too, and that is already the most tested part of the design.

**What it actually buys, stated carefully.** An append-only tree does not prove absence. Its leaves are in arrival order, not sorted, so there is no short proof that a value is missing. What it gives is a commitment, written by the sealed program itself, to the exact set and order of every code ever recorded. With that on the chain, the sorted indexed tree that does prove absence can be built by anyone, off the chain, and *checked* rather than trusted: a proof that the sorted tree holds the same values as the committed append-only tree turns the publisher from someone you trust into someone you verify. Without the commitment there is nothing to check against, which is section 1.

Be clear about what that leaves open: the permutation proof is real work nobody has built for Forest, it is proportional to the number of codes, and it has to be redone as codes arrive. It is a cost and a piece of engineering, not a trust assumption, and that is the difference that matters. It is also entirely outside the sealed program, so it can be designed, rebuilt and replaced at any time, forever. That is the whole point of putting the commitment in v1: the cheap, irreversible half goes in now, the expensive, changeable half stays out.

A running hash chain of codes, one hash per registration instead of up to twenty, would commit the same set for less. It was rejected because opening a chain to show that one code *is* present costs a walk of the whole chain, and the completeness proof needs presence as often as absence.

## 5. A fourth shape, not asked for, worth one look before sealing

Option 2's only fatal problem is that the Merkle path travels in the transaction. It does not have to. The program can hold the tree itself, in accounts it owns, and then a registration carries nothing extra: the program reads the path out of its own data and writes the updated nodes back.

This is not free and it is not costed here to the same depth, but the rough shape is worth having:

- Rent is paid per byte of tree, not per account, so the 128-byte per-account overhead disappears. A leaf is the code plus two link fields, about 72 bytes, plus about 32 bytes of internal node per code: about 104 bytes per code, against 272 for option 1's 144-byte account. That is 2.6 times cheaper. At a million codes, about 104 MB, 528 SOL, about $53,000 today and about $7,300 at the final rate, against about $138,500 and $19,000 for option 1.
- The ceiling is account size. One account holds 10 MB (`MAX_PERMITTED_DATA_LENGTH`), so a million codes needs about eleven accounts, and a transaction can carry 64. Growth is capped at 10,240 bytes per instruction (`MAX_PERMITTED_DATA_INCREASE`), so the accounts grow in steps of about a hundred codes, and a registration that happens to trigger a step pays a lumpy 0.052 SOL of new rent. Lumpy costs inside a sealed program are exactly the kind of thing that turns out wrong.
- It gets absence proofs at registration time, directly, with no permutation proof later.

It was not recommended because it is the most program logic of any option, in the one program that can never be fixed, and because the cheap version (option 3) reaches the same destination with logic the design already has. It is here because it is the only shape found that gets both the byte budget and the absence proof, and if the permutation proof in option 3 turns out to be harder than it looks, this is where to go.

## 6. The rent sweep: is it possible, and what it must check

**Yes, it is possible, and only the owning program can do it.** Verified in the runtime source this session (`solana-transaction-context` 4.4.0-alpha.4, `instruction_accounts.rs`): `set_lamports` returns `ExternalAccountLamportSpend` when a program tries to reduce the balance of an account it does not own. The other side of that rule is the one that matters here: a program *may* reduce the balance of an account it does own, with no signature, because it is the owner. An instruction whose lamports do not sum to the same total fails with `UnbalancedInstruction`, so the excess has to land somewhere in the same instruction.

This is why the handoff's requirement for a sweep instruction from day one is right, and why it is urgent. Rent deposits sit inside accounts the registry owns. Nothing outside the registry can move them. A sealed program with no sweep instruction locks the difference between today's rate and tomorrow's rate in place forever. On the 144-byte layout that difference is 1,381,760 minus 189,312, which is 1,192,448 lamports, about $0.1195 per badge, about $120,000 at a million badges.

**The rule, so it can never take more than the excess.**

```
sweep(code_account, treasury):
  require code_account.owner == this program            # the runtime enforces it; check anyway
  require code_account.key == derive(code_account seeds) # re-derive, so a lookalike cannot be passed in
  require code_account.is_writable
  require treasury.key == TREASURY                       # sealed, or the treasury dial; never caller-supplied

  rent    = Rent::get()                                  # read at runtime, every time
  minimum = rent.minimum_balance(code_account.data_len())
  excess  = code_account.lamports().saturating_sub(minimum)
  require excess > 0

  code_account.lamports -= excess                        # subtract; never assign a computed total
  treasury.lamports     += excess

  assert code_account.lamports() == minimum              # still exactly rent exempt
  # data untouched, no realloc, no close
```

`minimum_balance` is `(128 + bytes) * lamports_per_byte` at the exemption threshold of 1.0, confirmed in `solana-rent` 4.4.0 this session, and the same formula that reproduced every figure the RPC returned.

Six things it must never do:

1. **Never bake the minimum in as a constant.** The rate changing is the entire reason the instruction exists. Read the Rent sysvar at runtime.
2. **Never assign a balance; always subtract the excess.** Setting a computed figure is one arithmetic slip away from emptying an account.
3. **Never send anywhere but the sealed treasury.** A caller-supplied destination is not a sweep, it is a drain with extra steps.
4. **Never touch data, never grow the account, never close it.** Code accounts are written once and never change size, which is what makes sweeping to the exact minimum safe. An account that could grow later would need its future minimum, not its current one.
5. **Never accept an account without re-deriving its address.** The caller supplies the account list, so the only thing stopping a substitution is the program checking the seeds itself.
6. **Never require a signer.** There is no key behind a program-derived address, and there does not need to be: the only possible outcome is excess moving to the sealed treasury, so anyone may call it and the foundation never becomes a liveness dependency for its own money.

A sweep can batch: about 60 accounts per transaction within the 64-account limit, recovering roughly 71.5 million lamports for a 5,000 lamport fee, at today's difference.

One thing to be aware of rather than to fix: if rent ever rose again, accounts already swept to the old minimum would sit below the new one. The runtime only checks exemption on accounts a transaction modifies, and these are never modified again, so they simply sit there. Rent has only moved down so far. If it were ever to move up, a later sweep would fail its own `excess > 0` check and do nothing, which is the correct behaviour.

## 7. What the completeness proof costs per market

The later proof walks every market in the directory and, for each one, either opens the badge or proves the code absent. So its cost is per market in the directory, and the directory's size is the dial that sets it. This is the same walk the sponsor policy would use for "fewer than N badges across the directory", so one number sizes both.

**Measured anchor.** The Semaphore proving keys the handoff pins (the public July 2024 ceremony, version 4.0.0) were downloaded and their headers read this session:

| Artifact | Bytes | SHA-256 | Witness variables | Public inputs | Domain size |
|---|---|---|---|---|---|
| `4.0.0/semaphore-20.zkey` | 3,866,785 | `fe9b6da2954fbdd04a9d7fb93979a24889a5193c88aaac8c146b7694802c2998` | 6,454 | 4 | 8,192 |
| `4.0.0/semaphore-32.zkey` | 5,841,577 | `0654f6692b026a0e98972db610a7084136ee6303a1960944e866205942d051c7` | 9,418 | 4 | 16,384 |

The difference is 2,964 across twelve extra Merkle levels, so **247 wires per level**, which is a Poseidon two-input hash plus its selector. That is a measurement, and everything below is scaled from it, not measured.

**Per market, at depth 32:** the path walk is 32 times 247, about 7,904; the code itself is one Poseidon hash, about 240; the indexed-tree leaf hash is about 290; the two range comparisons that make absence an absence are about 508. Total **about 8,900 constraints, which is roughly one whole Semaphore proof per market.**

Scaled against session 3's measured Semaphore proving time (0.93 to 1.11 seconds at depth 32 in Node on that machine, and an estimated 3 to 7 seconds on a mid-range phone):

| Markets in the directory | Constraints | Semaphore proofs' worth | On a machine like session 3's | On a mid-range phone | Proving key |
|---|---|---|---|---|---|
| 10 | about 89,000 | 9.5 | about 10 s | about 50 s | about 55 MB |
| 20 | about 179,000 | 19 | about 19 s | about 95 s | about 111 MB |
| 50 | about 447,000 | 48 | about 48 s | about 4 minutes | about 277 MB |

Two warnings about those figures. The times scale linearly, which is the floor: Groth16's setup step is `n log n`, so real times run above this. And the proving key size is the harder wall. A 277 MB key is not something a browser downloads, so **the directory's size is what really bounds this proof, not the second count.** Somewhere between twenty and fifty markets, a single flat proof stops being something a person can run on a phone, and the design has to either cap the directory, group markets so a proof covers a subset, or move to a proof system that composes. That is a decision for whoever builds the v1 circuit, and it is much easier to make now that the number is written down.

The per-market cost is the same for option 1, 2 or 3. What the options change is not what the proof costs, it is whether the proof means anything.

## Recommendation

**Take option 3: keep one small account per code, and have the program also append each code to a running tree.** The account is what makes "one badge per market per human" true, and Solana checks it for free and cannot get it wrong, so that part should not change. The tree costs about two percent more computing per registration, sixty-two cents of deposit once, and not one extra byte in the transaction. What it buys is the one thing the other options cannot: a record, written by the sealed program itself, that anyone can check the full list of codes against. Without it, the future promise that a person can show all their badges with none hidden quietly becomes a promise to trust whoever publishes the list, and since the program can never be changed after it ships, that would be settled forever on the day it deploys. Option 2 is the textbook answer and it simply does not fit in a Solana transaction, by a factor of five. Option 1 is cheaper and simpler today and closes a door that cannot be reopened. Sixty-two cents is a small price for keeping it open.

## What this report did not do

It did not write any program, and it did not run anything on devnet. The compute figures are session 3's measurements applied to new arithmetic, not new measurements: no indexed-tree insert and no second append was run under LiteSVM this session. The permutation proof that option 3 relies on later was reasoned about, not built or costed; that is the largest piece of unknown work the recommendation leans on, and it should be looked at before v1 deploys, because option 3 is worth much less if it turns out to be impractical. The fourth shape in section 4 was sketched, not costed. The proving times in section 7 are scaled from one machine's measurement, not measured, and nothing was run on a phone.

## Sources

- Mainnet reads this session, `api.mainnet-beta.solana.com`: `getVersion` (4.3.0-rc.0), `getEpochInfo` (epoch 1035, slot 447,311,221), `getAccountInfo` on the three feature gates above, `getMinimumBalanceForRentExemption` at 0, 40, 144, 176 and 200 bytes, and the Rent sysvar values session 3 recorded (5,080 lamports per byte, threshold 1.0).
- Agave and Solana crates: `feature-set` (`accounts_lt_hash`, `snapshots_lt_hash`, `remove_accounts_delta_hash` gate keys and their SIMD numbers); `solana-transaction-context` 4.4.0-alpha.4 (`set_lamports`, `ExternalAccountLamportSpend`, `UnbalancedInstruction`); `solana-rent` 4.4.0 (`ACCOUNT_STORAGE_OVERHEAD` 128, `minimum_balance`, exemption threshold constants); `solana-system-interface` 3.3.0 (`MAX_PERMITTED_DATA_LENGTH`); `solana-account-info` 3.1.1 (`MAX_PERMITTED_DATA_INCREASE`).
- Indexed Merkle tree implementations: crates.io metadata and dependency lists for `light-indexed-merkle-tree` 7.0.0 and `light-hasher` 7.0.0 (`solana-define-syscall`), and `indexed-merkle-tree` 0.6.2; `@zk-kit/imt` 2.0.0-beta.8 and `@zk-kit/smt` 1.0.2 on npm.
- Semaphore artifacts: `https://snark-artifacts.pse.dev/semaphore/4.0.0/semaphore-{20,32}.zkey`, downloaded and their zkey headers parsed this session for the witness and domain sizes above.
- Price: CoinGecko simple price API, $100.24 per SOL at fetch time.
- Earlier work: `registry/FEASIBILITY.md` (session 3) for the compute cost of a Poseidon hash and a created account, the 1,232-byte transaction budget, the rent schedule, Semaphore proving times, and the Light Protocol assessment.

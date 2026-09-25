//! The Forest registry, v1.
//!
//! One verified human, one badge per market, without saying who. A registration carries one
//! Semaphore proof, one rule and 25 cents, and writes one account whose address is a hash of the
//! proof's nullifier. That account's existence is the whole of "one badge per market per human":
//! the runtime does the check, for free, and cannot be fooled. The profile's own wallet signs
//! every registration, and the proof names that wallet, so nobody can badge a profile whose
//! wallet did not consent.
//!
//! This program is sealed per version. The upgrade authority is removed at deploy, so nothing
//! here can be patched: read `registry/README.md` for what is sealed and what is a dial. There is
//! no pause, no admin override of a registration, and no way to take a code back.
//!
//! Nothing is shipped. Nothing here has run anywhere but a local validator and LiteSVM.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod proof;
pub mod state;
pub mod tree;
pub mod verifying_key;

use errors::RegistryError;
use state::*;
use tree::{FRONTIER_LEN, MAX_DEPTH};

declare_id!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");

/// The treasury the registry starts with: where the 0.25 and swept rent land, and the key that
/// signs every dial. `init` writes this constant and nothing else, whoever calls it, so a deploy
/// race has nothing to win. `propose_treasury` then `accept_treasury` move it later, in two
/// steps, so it can never move to a key nobody holds.
///
/// PLACEHOLDER. Replace with the charter's treasury address before the first deploy. This key is
/// derived from the public seed `REPLACE-BEFORE-DEPLOY-treasury-0` so the tests can sign for it,
/// which means anyone with this repo can sign for it. A program deployed with it has no treasury.
pub const TREASURY: Pubkey = pubkey!("F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s");

/// The foundation's issuer key: list 0's owner and its first insert key, written by `init`. A
/// constant for the treasury's reason: whoever sends `init` must not get to choose who vouches for
/// the first list. Every later list is opened by anyone, who owns it.
///
/// PLACEHOLDER. Replace with the foundation's issuer key before the first deploy. This key is
/// derived from the public seed `REPLACE-BEFORE-DEPLOY-issuer-000` so the tests can sign for it,
/// which means anyone with this repo can sign for it. Deployed with it, list 0 is anyone's.
pub const FOUNDATION_ISSUER: Pubkey = pubkey!("H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS");

/// USDC. `mints[0]` forever. A constant rather than an argument to `init`, for the same reason
/// the treasury is: whoever calls `init` first must not get to choose what "USDC" means.
/// Mainnet by default; `--features devnet` builds the program for devnet's USDC.
#[cfg(not(feature = "devnet"))]
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
#[cfg(feature = "devnet")]
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

/// USDC's fee: 0.25, in its six decimals. A program constant, written as `fees[0]` at `init`, that
/// nothing can change or remove. Every other accepted mint carries the fee the treasury set when it
/// accepted that mint, in that mint's own units, so that if the dollar ever fails the treasury can
/// accept another token at a sensible amount and registration continues.
pub const USDC_FEE: u64 = 250_000;
/// The decimals `USDC_FEE` assumes. `init` refuses a USDC mint that counts in anything else.
pub const USDC_DECIMALS: u8 = 6;

/// The longest market name and DID a registration can carry. Both are hashed, so neither is a
/// limit on what a scope can be; they only bound the instruction and the log. A scope of 256 bytes
/// holds a `category/market/role` of three 64-character slugs with room to spare, and a
/// registration carrying it and a 64-byte DID still fits one standard transaction.
pub const MAX_MARKET_NAME: usize = 256;
pub const MAX_DID: usize = 64;

/// The scope is a hash of a namespaced market name, so a name of any length works and a scope
/// from one namespace can never collide with one from another.
pub const SCOPE_NS: &[u8] = b"forest.foundation/market/v1/";
/// The message binds a proof to one profile: its wallet and its DID, so it cannot be replayed for
/// another profile, or landed by a wallet that is not that profile's.
pub const MESSAGE_NS: &[u8] = b"forest.foundation/profile/v1/";

pub const CONFIG_SEED: &[u8] = b"config";
pub const LIST_SEED: &[u8] = b"list";
pub const CODE_TREE_SEED: &[u8] = b"code-tree";
pub const CODE_SEED: &[u8] = b"code";

const FIRST_LIST_INDEX: [u8; 4] = 0u32.to_le_bytes();

/// `keccak256(namespace || parts...) >> 8`, the way Semaphore's proof package turns a value into a
/// field element. The shift by one byte is what keeps the result below BN254's scalar order.
pub fn field_hash(namespace: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut input: Vec<&[u8]> = Vec::with_capacity(parts.len() + 1);
    input.push(namespace);
    input.extend_from_slice(parts);
    let h = solana_keccak_hasher::hashv(&input).to_bytes();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&h[..31]);
    out
}

#[program]
pub mod forest_registry {
    use super::*;

    /// Create the registry: the config, the first identity list, and the tree of used codes.
    ///
    /// Anyone may call it, once, and it writes the same bytes whoever does: the treasury is
    /// `TREASURY`, the first mint is `USDC_MINT` at `USDC_FEE`, list 0's owner and first insert key
    /// is `FOUNDATION_ISSUER`, and nothing in the instruction chooses any of them. A second call
    /// fails because the config account already exists.
    pub fn init(ctx: Context<Init>) -> Result<()> {
        // 250,000 base units is 0.25 only at six decimals. The mint is read, not assumed.
        let decimals = ctx.accounts.usdc_mint.decimals;
        require!(decimals == USDC_DECIMALS, RegistryError::WrongDecimals);
        let config = &mut ctx.accounts.config;
        config.treasury = TREASURY;
        config.mints = [Pubkey::default(); MAX_MINTS];
        config.fees = [0u64; MAX_MINTS];
        config.mints[0] = USDC_MINT;
        config.fees[0] = USDC_FEE;
        config.mint_count = 1;
        config.list_count = 1;
        config.bump = ctx.bumps.config;
        config.pending_treasury = Pubkey::default();

        let mut list = ctx.accounts.list.load_init()?;
        list.index = 0;
        list.bump = ctx.bumps.list;
        list.owner = FOUNDATION_ISSUER;
        list.issuers[0] = FOUNDATION_ISSUER;
        list.issuer_count = 1;
        drop(list);

        let mut code_tree = ctx.accounts.code_tree.load_init()?;
        code_tree.bump = ctx.bumps.code_tree;

        emit!(RegistryOpened { treasury: TREASURY, usdc_mint: USDC_MINT, fee: USDC_FEE });
        emit!(ListOpened { list_index: 0, owner: FOUNDATION_ISSUER });
        Ok(())
    }

    /// Propose handing the treasury to another key. The current treasury signs. Step one of two.
    ///
    /// Nothing moves here: the key is only recorded as pending. The 0.25 still lands with the
    /// current treasury, swept rent still goes to it, and it still signs every dial, this one
    /// included, until the pending key signs `accept_treasury`. A later proposal overwrites the
    /// pending key; proposing `None` clears it. The zero key and the current key are refused.
    ///
    /// Two steps because a one-step handover has no undo: a typo in the new address would have
    /// frozen every dial and sent every fee to nobody, forever. Now a key that nobody holds can
    /// be proposed but never accepted, and the treasury stays where it was.
    pub fn propose_treasury(
        ctx: Context<ProposeTreasury>,
        new_treasury: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let proposed = match new_treasury {
            Some(key) => {
                require_keys_neq!(key, Pubkey::default(), RegistryError::TreasuryEmpty);
                require_keys_neq!(key, config.treasury, RegistryError::TreasuryUnchanged);
                key
            }
            None => Pubkey::default(),
        };
        config.pending_treasury = proposed;
        emit!(TreasuryProposed { treasury: config.treasury, proposed });
        Ok(())
    }

    /// Accept a proposed handover. The pending key signs. Step two of two.
    ///
    /// Only now does everything move at once: where the 0.25 lands, where swept rent goes, and
    /// who signs the dials. That is what lets the treasury move to a multisig later: the
    /// multisig's vault signs this, which is the proof it can sign at all. After it, the old key
    /// signs nothing, is paid nothing, and is swept nothing, and the pending slot is empty.
    pub fn accept_treasury(ctx: Context<AcceptTreasury>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let to = config.pending_treasury;
        require_keys_neq!(to, Pubkey::default(), RegistryError::NoPendingTreasury);
        require_keys_eq!(to, ctx.accounts.pending.key(), RegistryError::NotThePendingTreasury);
        let from = config.treasury;
        config.treasury = to;
        config.pending_treasury = Pubkey::default();
        emit!(TreasuryChanged { from, to });
        Ok(())
    }

    /// Open another identity list. Anyone may: the payer pays its rent, and the owner, who signs,
    /// is recorded as the list's owner and its first insert key. They may be one key.
    ///
    /// Issuers are open. Whoever opens a list vouches for the humans on it, and only its owner
    /// changes its insert keys, closes it or hands it over; the treasury has no say over any list. The program
    /// checks nothing about who an owner is: every registration's entry names the list and its
    /// owner, and an index weighs a badge by who vouched. An issuer with several open lists assigns
    /// its joiners across them itself: which list a person is in must never say when they joined.
    pub fn open_list(ctx: Context<OpenList>) -> Result<()> {
        let index = ctx.accounts.config.list_count;
        let owner = ctx.accounts.owner.key();
        let mut list = ctx.accounts.list.load_init()?;
        list.index = index;
        list.bump = ctx.bumps.list;
        list.owner = owner;
        list.issuers[0] = owner;
        list.issuer_count = 1;
        drop(list);

        ctx.accounts.config.list_count = index + 1;
        emit!(ListOpened { list_index: index, owner });
        Ok(())
    }

    /// Close a list to new members. The list's owner signs.
    ///
    /// Nothing else about the list changes: its members stay, its root and its last 128 roots
    /// stay, and every proof made against it keeps verifying forever. Nothing reopens a closed
    /// list, and no instruction deletes a list at all.
    pub fn close_list(ctx: Context<ListAdmin>, _list_index: u32) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        require_keys_eq!(list.owner, ctx.accounts.owner.key(), RegistryError::NotTheListOwner);
        require!(!list.is_closed(), RegistryError::ListClosed);
        list.closed = 1;
        emit!(ListClosed { list_index: list.index, leaf_count: list.leaf_count, root: list.root });
        Ok(())
    }

    /// Let a key insert into one list. The list's owner signs.
    pub fn add_issuer(ctx: Context<ListAdmin>, _list_index: u32, issuer: Pubkey) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        require_keys_eq!(list.owner, ctx.accounts.owner.key(), RegistryError::NotTheListOwner);
        require!(!list.is_issuer(&issuer), RegistryError::IssuerAlreadyAdded);
        let n = list.issuer_count as usize;
        require!(n < MAX_ISSUERS, RegistryError::TooManyIssuers);
        list.issuers[n] = issuer;
        list.issuer_count = (n + 1) as u8;
        emit!(IssuerChanged { list_index: list.index, issuer, added: true });
        Ok(())
    }

    /// Stop a key from inserting into one list. The list's owner signs, and may remove its own key
    /// and stay the owner.
    ///
    /// Removing an issuer never removes an identity. Nobody is ever taken out of a list.
    pub fn remove_issuer(ctx: Context<ListAdmin>, _list_index: u32, issuer: Pubkey) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        require_keys_eq!(list.owner, ctx.accounts.owner.key(), RegistryError::NotTheListOwner);
        let n = list.issuer_count as usize;
        let at = list.issuers[..n]
            .iter()
            .position(|k| *k == issuer)
            .ok_or(error!(RegistryError::IssuerNotFound))?;
        for i in at..n - 1 {
            list.issuers[i] = list.issuers[i + 1];
        }
        list.issuers[n - 1] = Pubkey::default();
        list.issuer_count = (n - 1) as u8;
        emit!(IssuerChanged { list_index: list.index, issuer, added: false });
        Ok(())
    }

    /// Propose handing a list to another key. The list's owner signs. Step one of two (session 15).
    ///
    /// Nothing moves here: the key is only recorded as pending. The current owner still manages the
    /// insert keys, still may close the list or change this proposal, and still receives its swept
    /// rent, until the pending key signs `accept_list_owner`. A later proposal overwrites the
    /// pending key; proposing `None` clears it. The zero key and the current owner are refused. A
    /// closed list can be handed over too: it still has an owner, whose key its rent pays.
    ///
    /// This is how an issuer moves a list to a multisig, or away from a key that leaked, without
    /// opening a new list its members would have to join again. With both keys at hand, both steps
    /// fit in one transaction, which leaves no moment between them for anyone else holding the old
    /// key.
    pub fn propose_list_owner(
        ctx: Context<ListAdmin>,
        _list_index: u32,
        new_owner: Option<Pubkey>,
    ) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        require_keys_eq!(list.owner, ctx.accounts.owner.key(), RegistryError::NotTheListOwner);
        let proposed = match new_owner {
            Some(key) => {
                require_keys_neq!(key, Pubkey::default(), RegistryError::ListOwnerEmpty);
                require_keys_neq!(key, list.owner, RegistryError::ListOwnerUnchanged);
                key
            }
            None => Pubkey::default(),
        };
        list.pending_owner = proposed;
        emit!(ListOwnerProposed { list_index: list.index, owner: list.owner, proposed });
        Ok(())
    }

    /// Accept a proposed handover of a list. The pending key signs. Step two of two.
    ///
    /// Only now does the list change owner: who adds and removes its insert keys, closes it, hands
    /// it on, and receives its swept rent. Ownership moves and nothing else does: the insert keys
    /// stay as they were, so a new owner that means to drop the old key removes it itself, in the
    /// same transaction if it likes. The pending slot is cleared.
    pub fn accept_list_owner(ctx: Context<AcceptListOwner>, _list_index: u32) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        let to = list.pending_owner;
        require_keys_neq!(to, Pubkey::default(), RegistryError::NoPendingListOwner);
        require_keys_eq!(to, ctx.accounts.pending.key(), RegistryError::NotThePendingListOwner);
        let from = list.owner;
        list.owner = to;
        list.pending_owner = Pubkey::default();
        emit!(ListOwnerChanged { list_index: list.index, from, to });
        Ok(())
    }

    /// Append one identity commitment to a list. An issuer key signs.
    ///
    /// The commitment is made on the person's device and the issuer never sees anything else, so
    /// nothing server-side ever holds a person next to a profile.
    pub fn insert_identity(
        ctx: Context<InsertIdentity>,
        _list_index: u32,
        commitment: [u8; 32],
    ) -> Result<()> {
        require!(proof::is_field_element(&commitment), RegistryError::NotAFieldElement);
        require!(commitment != [0u8; 32], RegistryError::NotAFieldElement);

        let mut list = ctx.accounts.list.load_mut()?;
        require!(list.is_issuer(&ctx.accounts.issuer.key()), RegistryError::NotAnIssuer);
        require!(!list.is_closed(), RegistryError::ListClosed);

        let count = list.leaf_count;
        let root = tree::append(&mut list.frontier, count, commitment)?;
        list.push_root(root);

        emit!(IdentityInserted {
            list_index: list.index,
            leaf_index: count,
            commitment,
            root,
        });
        Ok(())
    }

    /// One registration: one proof, one rule, 25 cents.
    ///
    /// The profile's wallet signs, whoever pays: that signature is the profile's consent, and the
    /// proof's message names the same wallet, so a proof cannot be landed under any other. The fee
    /// comes from a token account the fee authority owns, and the transaction's payer covers the
    /// network fee and the code account's rent. Everyone is charged; whoever signs to pay, pays,
    /// and the program neither knows nor needs to know whose behalf that is.
    ///
    /// The order of checks is sealed with everything else. Any failure reverts all of it: there
    /// is no state in which a code is written and the fee is not paid, or the other way round.
    pub fn register(ctx: Context<Register>, args: RegisterArgs) -> Result<()> {
        require!(
            !args.market.is_empty() && args.market.len() <= MAX_MARKET_NAME,
            RegistryError::MarketNameLength
        );
        require!(
            !args.did.is_empty() && args.did.len() <= MAX_DID,
            RegistryError::DidLength
        );

        // The program never takes a scope or a message from the client. It derives both, from the
        // market name, and from the signing wallet and the DID, and hands them to the verifier as
        // public inputs: a proof made for another market, another profile, or another wallet
        // cannot verify at all. Without the wallet in the message, anyone who saw a proof before
        // it landed (a relay, a fee payer) could land it under their own wallet and burn the code.
        let wallet = ctx.accounts.profile_wallet.key();
        let scope = field_hash(SCOPE_NS, &[args.market.as_bytes()]);
        let message = field_hash(MESSAGE_NS, &[wallet.as_ref(), args.did.as_bytes()]);

        // The root must be one this list actually held, and never the empty tree's zero.
        let list_owner = {
            let list = ctx.accounts.list.load()?;
            require!(list.index == args.list_index, RegistryError::WrongList);
            require!(args.root != [0u8; 32], RegistryError::RootNotRecent);
            require!(list.has_recent_root(&args.root), RegistryError::RootNotRecent);
            list.owner
        };

        // Semaphore's public signals, in its own order: root, nullifier, message, scope.
        proof::verify(
            &args.proof_a,
            &args.proof_b,
            &args.proof_c,
            &[args.root, args.code, message, scope],
        )?;

        // The code account is created by the `init` constraint below, which fails if it already
        // exists. That failure is the one-badge rule, and the runtime enforces it.
        ctx.accounts.used_code.bump = ctx.bumps.used_code;

        // The same code, appended to the arrival-order tree. No Merkle path travels in the
        // transaction: the program walks up from its own frontier.
        {
            let mut code_tree = ctx.accounts.code_tree.load_mut()?;
            let count = code_tree.count;
            let root = tree::append(&mut code_tree.frontier, count, args.code)?;
            code_tree.count = count + 1;
            code_tree.root = root;
        }

        // The fee of an accepted token, from the fee authority's account to the treasury's.
        let mint = ctx.accounts.fee_tokens.mint;
        // One rule, 25 cents, always. Paying yourself is not paying: the same account on both
        // sides would move nothing, and the only key that could arrange it is the treasury's.
        // Anchor's duplicate-mutable-account check catches this first; the rule is written here
        // as well because these bytes are frozen at deploy and it must be findable in the
        // program's own text, not only in what a macro happened to generate.
        require_keys_neq!(
            ctx.accounts.fee_tokens.key(),
            ctx.accounts.treasury_tokens.key(),
            RegistryError::FeeGoesNowhere
        );
        require!(ctx.accounts.treasury_tokens.mint == mint, RegistryError::MintMismatch);
        // The fee recorded for this mint: `USDC_FEE` for USDC, and for any other the amount the
        // treasury set when it accepted the mint, in that mint's own base units.
        let fee = ctx
            .accounts
            .config
            .fee_of(&mint)
            .ok_or(error!(RegistryError::MintNotAccepted))?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.fee_tokens.to_account_info(),
                    to: ctx.accounts.treasury_tokens.to_account_info(),
                    authority: ctx.accounts.fee_authority.to_account_info(),
                },
            ),
            fee,
        )?;

        emit!(Registered {
            market: args.market,
            did: args.did,
            wallet,
            code: args.code,
            list_index: args.list_index,
            list_owner,
        });
        Ok(())
    }

    /// Accept one more mint, at a fee in its own base units. The treasury signs.
    ///
    /// What a program can check is checked: the mint is a classic SPL Token mint (the account's
    /// owner is the token program, which `anchor_spl::token::Mint` enforces), it is initialized,
    /// and the fee is not zero. What the fee is worth is a judgement no program can make: it is
    /// the treasury's, meant to be 25 cents, and set once. If the dollar ever fails, this is how
    /// registration continues: another token, at a sensible amount.
    ///
    /// Nothing changes a fee once set, and nothing removes a mint, so `mints[0]`, USDC at 0.25,
    /// is there forever and registration can never be halted by taking a token away.
    pub fn add_token(ctx: Context<AddToken>, fee: u64) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        require!(fee > 0, RegistryError::FeeZero);
        let config = &mut ctx.accounts.config;
        require!(!config.accepts(&mint), RegistryError::MintAlreadyAccepted);
        let n = config.mint_count as usize;
        require!(n < MAX_MINTS, RegistryError::TooManyMints);
        config.mints[n] = mint;
        config.fees[n] = fee;
        config.mint_count = (n + 1) as u8;
        emit!(TokenAccepted { mint, fee, decimals: ctx.accounts.mint.decimals });
        Ok(())
    }

    /// Move the lamports an account holds above the current rent-exempt minimum: a list's to the
    /// list's owner, and the config's, the code tree's and a code account's to the treasury.
    ///
    /// Solana is part way through a five-step cut to the rent rate. Deposits already sitting in
    /// registry accounts stay where they are, and only an instruction in the owning program can
    /// move them, so a sealed program without this one locks the difference away forever. Anyone
    /// may call it: there is no key behind a program-derived address, the only possible
    /// destination is the one the program reads for itself, and nobody must be a liveness
    /// dependency for anyone else's money. A list's rent goes to its owner (session 15, Carlos's
    /// decision): whoever paid a list's rent should get it back, the issuer that opens a list is
    /// the one paying for it (directly, or through a fee payer it pays), and the owner is the key
    /// the list records. It follows a handover. Where the payer and the owner are two keys, as for
    /// list 0 (paid by whoever sent `init`), the owner gets it.
    pub fn sweep_rent(ctx: Context<SweepRent>, target: SweepTarget) -> Result<()> {
        let account = &ctx.accounts.target_account;

        // The caller supplies the account list, so the only thing stopping a substitution is the
        // program deriving the address itself from the seeds the target names.
        let expected = match &target {
            SweepTarget::Config => Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID).0,
            SweepTarget::CodeTree => Pubkey::find_program_address(&[CODE_TREE_SEED], &crate::ID).0,
            SweepTarget::List { index } => {
                Pubkey::find_program_address(&[LIST_SEED, &index.to_le_bytes()], &crate::ID).0
            }
            SweepTarget::Code { code } => {
                Pubkey::find_program_address(&[CODE_SEED, code], &crate::ID).0
            }
        };
        require_keys_eq!(expected, account.key(), RegistryError::WrongSweepTarget);
        require_keys_eq!(*account.owner, crate::ID, RegistryError::WrongSweepTarget);

        // Where the excess goes is read from the chain, never taken from the caller: a list's
        // owner, as the list itself records it now, or else the treasury, as the config records it.
        let recipient = match &target {
            SweepTarget::List { .. } => {
                // The same bytes `AccountLoader` reads: the discriminator, then the list itself.
                let data = account.try_borrow_data()?;
                require!(
                    data.len() == 8 + IdentityList::LEN && &data[..8] == IdentityList::DISCRIMINATOR,
                    RegistryError::WrongSweepTarget
                );
                bytemuck::from_bytes::<IdentityList>(&data[8..]).owner
            }
            _ => ctx.accounts.config.treasury,
        };
        require_keys_eq!(recipient, ctx.accounts.recipient.key(), RegistryError::WrongSweepRecipient);

        // The exact check, in full, so it can never take more than the excess:
        //
        //   rent    = Rent::get()                      read at runtime, every time; never a constant,
        //                                              because the rate changing is why this exists
        //   minimum = rent.minimum_balance(data_len)   (128 + bytes) * lamports_per_byte, for this
        //                                              account's own size, which never changes
        //   excess  = lamports - minimum               saturating, so an account already at or below
        //                                              the minimum yields zero and the call fails
        //   require excess > 0
        //   account.lamports -= excess                 subtract; never assign a computed total
        //   recipient.lamports += excess               the list's owner or the treasury, as read
        //                                              above; never a caller's choice
        //   assert account.lamports == minimum         still exactly rent exempt
        //
        // Data is untouched, the account is never grown, realloc'd or closed, and no signer is
        // required or accepted for the target.
        let rent = Rent::get()?;
        let data_len = account.data_len();
        let minimum = rent.minimum_balance(data_len);
        let lamports = account.lamports();
        let excess = lamports.saturating_sub(minimum);
        require!(excess > 0, RegistryError::NothingToSweep);

        **account.try_borrow_mut_lamports()? -= excess;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += excess;
        require_eq!(account.lamports(), minimum, RegistryError::NothingToSweep);

        emit!(RentSwept {
            account: account.key(),
            lamports: excess,
            left: minimum,
        });
        Ok(())
    }
}

/// What `register` carries. Sealed: clients build these bytes forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterArgs {
    /// The market name, as it appears in the `markets` directory. Hashed into the scope.
    pub market: String,
    /// The profile's DID. Hashed into the message, which binds the proof to this profile.
    pub did: String,
    /// Which identity list the proof was made against.
    pub list_index: u32,
    /// That list's root at the time the proof was made.
    pub root: [u8; 32],
    /// The proof's nullifier: `Poseidon(scope, secret)`. This is the badge's code.
    pub code: [u8; 32],
    /// The proof, points compressed.
    pub proof_a: [u8; 32],
    pub proof_b: [u8; 64],
    pub proof_c: [u8; 32],
}

/// Which registry account a sweep is aimed at. The program derives the address from this; the
/// account in the instruction is only checked against what it derives.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum SweepTarget {
    Config,
    CodeTree,
    List { index: u32 },
    Code { code: [u8; 32] },
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 8 + Config::LEN, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + IdentityList::LEN,
        seeds = [LIST_SEED, &FIRST_LIST_INDEX],
        bump
    )]
    pub list: AccountLoader<'info, IdentityList>,
    #[account(init, payer = payer, space = 8 + CodeTree::LEN, seeds = [CODE_TREE_SEED], bump)]
    pub code_tree: AccountLoader<'info, CodeTree>,
    /// Whoever pays the rent. Not the treasury, and nothing about them is written anywhere.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// USDC, at the one address the program names. `mints[0]` forever: nothing in this program
    /// removes a mint.
    #[account(address = USDC_MINT)]
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeTreasury<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    pub treasury: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptTreasury<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_treasury != Pubkey::default() @ RegistryError::NoPendingTreasury,
        constraint = config.pending_treasury == pending.key() @ RegistryError::NotThePendingTreasury,
    )]
    pub config: Account<'info, Config>,
    /// The key the current treasury proposed. It signs, which is the whole point: a key that
    /// cannot sign cannot become the treasury.
    pub pending: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenList<'info> {
    /// Read for the next index and written with the new count. No `has_one`: anyone opens a list.
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + IdentityList::LEN,
        seeds = [LIST_SEED, &config.list_count.to_le_bytes()],
        bump
    )]
    pub list: AccountLoader<'info, IdentityList>,
    /// Pays the list's rent. Anyone.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Recorded as the list's owner and its first insert key. It signs, so no list is ever owned by
    /// a key that did not agree to it, or that nobody holds.
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `add_issuer`, `remove_issuer` and `close_list`. The owner is checked against the list in the
/// handler, so the rule is findable in the program's own text.
#[derive(Accounts)]
#[instruction(list_index: u32)]
pub struct ListAdmin<'info> {
    #[account(mut, seeds = [LIST_SEED, &list_index.to_le_bytes()], bump)]
    pub list: AccountLoader<'info, IdentityList>,
    pub owner: Signer<'info>,
}

/// `accept_list_owner`. The pending key is checked against the list in the handler.
#[derive(Accounts)]
#[instruction(list_index: u32)]
pub struct AcceptListOwner<'info> {
    #[account(mut, seeds = [LIST_SEED, &list_index.to_le_bytes()], bump)]
    pub list: AccountLoader<'info, IdentityList>,
    /// The key the list's owner proposed. It signs, which is the whole point: a key that cannot
    /// sign cannot own a list.
    pub pending: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(list_index: u32)]
pub struct InsertIdentity<'info> {
    #[account(mut, seeds = [LIST_SEED, &list_index.to_le_bytes()], bump)]
    pub list: AccountLoader<'info, IdentityList>,
    pub issuer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: RegisterArgs)]
pub struct Register<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [LIST_SEED, &args.list_index.to_le_bytes()], bump)]
    pub list: AccountLoader<'info, IdentityList>,
    #[account(mut, seeds = [CODE_TREE_SEED], bump)]
    pub code_tree: AccountLoader<'info, CodeTree>,
    /// Fails if it already exists. That failure is "one badge per market per human".
    #[account(
        init,
        payer = payer,
        space = 8 + UsedCode::LEN,
        seeds = [CODE_SEED, args.code.as_ref()],
        bump
    )]
    pub used_code: Account<'info, UsedCode>,
    /// Pays the code account's rent and the network fee. Whoever signs as payer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The profile's wallet: the key derived for this profile, which its profile record declares.
    /// It signs whoever pays, and the proof's message names it.
    pub profile_wallet: Signer<'info>,
    /// Whoever pays the fee: the profile's wallet itself, or any other key.
    pub fee_authority: Signer<'info>,
    #[account(mut, token::authority = fee_authority)]
    pub fee_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::authority = config.treasury)]
    pub treasury_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToken<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    pub treasury: Signer<'info>,
    pub mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct SweepRent<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the program derives this address itself from the seeds the `target` names, and
    /// requires it to match and to be owned by this program. Only its lamports are touched.
    #[account(mut)]
    pub target_account: UncheckedAccount<'info>,
    /// CHECK: checked in the handler against the one key the target pays: a list's owner for a
    /// list, the treasury for anything else. It only ever receives lamports.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[event]
pub struct RegistryOpened {
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee: u64,
}

/// A handover proposed, or cleared (`proposed` is the zero key then).
#[event]
pub struct TreasuryProposed {
    pub treasury: Pubkey,
    pub proposed: Pubkey,
}

/// A handover accepted: only now has the treasury moved.
#[event]
pub struct TreasuryChanged {
    pub from: Pubkey,
    pub to: Pubkey,
}

/// A list opened, and who owns it: `init`'s list 0, or anyone's through `open_list`.
#[event]
pub struct ListOpened {
    pub list_index: u32,
    pub owner: Pubkey,
}

/// A list closed to new members: how many it holds and its final root, which stays valid forever.
#[event]
pub struct ListClosed {
    pub list_index: u32,
    pub leaf_count: u64,
    pub root: [u8; 32],
}

/// A list's handover proposed, or cleared (`proposed` is the zero key then). Session 15.
#[event]
pub struct ListOwnerProposed {
    pub list_index: u32,
    pub owner: Pubkey,
    pub proposed: Pubkey,
}

/// A list's handover accepted: only now has its owner changed. Session 15.
#[event]
pub struct ListOwnerChanged {
    pub list_index: u32,
    pub from: Pubkey,
    pub to: Pubkey,
}

#[event]
pub struct IssuerChanged {
    pub list_index: u32,
    pub issuer: Pubkey,
    pub added: bool,
}

#[event]
pub struct IdentityInserted {
    pub list_index: u32,
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub root: [u8; 32],
}

/// One entry per registration, in the transaction log and in no account. This is what an index
/// reads to build a badge page. `wallet` is the profile's wallet that signed and that the proof
/// names: a badge counts for a profile only when its profile record declares that wallet.
/// `list_index` and `list_owner` say which list the proof was made against and who vouches for it,
/// so an index can weigh a badge by its issuer (`list_owner` appended in session 14).
#[event]
pub struct Registered {
    pub market: String,
    pub did: String,
    pub wallet: Pubkey,
    pub code: [u8; 32],
    pub list_index: u32,
    pub list_owner: Pubkey,
}

/// A mint accepted at a fee in its own base units. `decimals` is read off the mint, for readers.
#[event]
pub struct TokenAccepted {
    pub mint: Pubkey,
    pub fee: u64,
    pub decimals: u8,
}

#[event]
pub struct RentSwept {
    pub account: Pubkey,
    pub lamports: u64,
    pub left: u64,
}

/// Compile-time proof that the sealed sizes are what this file says they are.
const _: () = {
    assert!(IdentityList::LEN == 5520);
    assert!(CodeTree::LEN == 1104);
    assert!(Config::LEN == 710);
    // 0.25 at USDC's six decimals.
    assert!(USDC_FEE == 25 * 10u64.pow(USDC_DECIMALS as u32 - 2));
    assert!(UsedCode::LEN == 1);
    assert!(FRONTIER_LEN == MAX_DEPTH + 1);
};

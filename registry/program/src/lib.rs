//! The Forest registry, v1.
//!
//! One verified human, one badge per market, without saying who. A registration carries one
//! Semaphore proof, one rule and 25 cents, and writes one account whose address is a hash of the
//! proof's nullifier. That account's existence is the whole of "one badge per market per human":
//! the runtime does the check, for free, and cannot be fooled.
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

/// 0.25, always, in the base units of an accepted mint. The mints all carry the same decimals,
/// which is why this is one constant and never a conversion.
pub const REGISTRATION_FEE: u64 = 250_000;
/// The decimals every accepted mint must have. Written into the config at `init`; no instruction
/// changes it. USDC and every dollar stablecoin worth accepting carry six.
pub const TOKEN_DECIMALS: u8 = 6;

/// The longest market name and DID a registration can carry. Both are hashed, so neither is a
/// limit on what a scope can be; they only bound the instruction and the log.
pub const MAX_MARKET_NAME: usize = 64;
pub const MAX_DID: usize = 64;

/// The scope is a hash of a namespaced market name, so a name of any length works and a scope
/// from one namespace can never collide with one from another.
pub const SCOPE_NS: &[u8] = b"forest.foundation/market/v1/";
/// The message binds a proof to one profile, so it cannot be replayed for another.
pub const MESSAGE_NS: &[u8] = b"forest.foundation/profile/v1/";

pub const CONFIG_SEED: &[u8] = b"config";
pub const LIST_SEED: &[u8] = b"list";
pub const CODE_TREE_SEED: &[u8] = b"code-tree";
pub const CODE_SEED: &[u8] = b"code";

const FIRST_LIST_INDEX: [u8; 4] = 0u32.to_le_bytes();

/// `keccak256(namespace || bytes) >> 8`, the way Semaphore's proof package turns a value into a
/// field element. The shift by one byte is what keeps the result below BN254's scalar order.
pub fn field_hash(namespace: &[u8], bytes: &[u8]) -> [u8; 32] {
    let h = solana_keccak_hasher::hashv(&[namespace, bytes]).to_bytes();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&h[..31]);
    out
}

#[program]
pub mod forest_registry {
    use super::*;

    /// Create the registry: the config, the first identity list, and the tree of used codes.
    /// The treasury key signs, and becomes the key that signs every later settings change.
    pub fn init(ctx: Context<Init>, treasury: Pubkey) -> Result<()> {
        // The first mint is held to the same rule as every later one, so there is no mint in the
        // config that `add_token` would have refused.
        require!(
            ctx.accounts.usdc_mint.decimals == TOKEN_DECIMALS,
            RegistryError::WrongDecimals
        );
        let usdc_mint = ctx.accounts.usdc_mint.key();
        let config = &mut ctx.accounts.config;
        config.treasury = treasury;
        config.treasury_key = ctx.accounts.treasury_key.key();
        config.mints = [Pubkey::default(); MAX_MINTS];
        config.mints[0] = usdc_mint;
        config.mint_count = 1;
        config.token_decimals = TOKEN_DECIMALS;
        config.list_count = 1;
        config.bump = ctx.bumps.config;

        let mut list = ctx.accounts.list.load_init()?;
        list.index = 0;
        list.bump = ctx.bumps.list;

        let mut code_tree = ctx.accounts.code_tree.load_init()?;
        code_tree.bump = ctx.bumps.code_tree;

        emit!(RegistryOpened {
            treasury,
            treasury_key: config.treasury_key,
            usdc_mint,
        });
        Ok(())
    }

    /// Open another identity list. The treasury key signs.
    ///
    /// Lists exist so the design can grow without a new program. New joiners are assigned across
    /// the open lists by the issuer, not by this program: which list a person is in must never
    /// say when they joined.
    pub fn open_list(ctx: Context<OpenList>) -> Result<()> {
        let index = ctx.accounts.config.list_count;
        let mut list = ctx.accounts.list.load_init()?;
        list.index = index;
        list.bump = ctx.bumps.list;
        drop(list);

        ctx.accounts.config.list_count = index + 1;
        emit!(ListOpened { list_index: index });
        Ok(())
    }

    /// Let a key insert into one list. The treasury key signs.
    pub fn add_issuer(ctx: Context<ListAdmin>, _list_index: u32, issuer: Pubkey) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
        require!(!list.is_issuer(&issuer), RegistryError::IssuerAlreadyAdded);
        let n = list.issuer_count as usize;
        require!(n < MAX_ISSUERS, RegistryError::TooManyIssuers);
        list.issuers[n] = issuer;
        list.issuer_count = (n + 1) as u8;
        emit!(IssuerChanged { list_index: list.index, issuer, added: true });
        Ok(())
    }

    /// Stop a key from inserting into one list. The treasury key signs.
    ///
    /// Removing an issuer never removes an identity. Nobody is ever taken out of a list.
    pub fn remove_issuer(ctx: Context<ListAdmin>, _list_index: u32, issuer: Pubkey) -> Result<()> {
        let mut list = ctx.accounts.list.load_mut()?;
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

        // The program never takes a scope or a message from the client. It derives both from the
        // market name and the DID in the instruction, and hands them to the verifier as public
        // inputs, so a proof made for another market or another profile cannot verify at all.
        let scope = field_hash(SCOPE_NS, args.market.as_bytes());
        let message = field_hash(MESSAGE_NS, args.did.as_bytes());

        // The root must be one this list actually held, and never the empty tree's zero.
        {
            let list = ctx.accounts.list.load()?;
            require!(list.index == args.list_index, RegistryError::WrongList);
            require!(args.root != [0u8; 32], RegistryError::RootNotRecent);
            require!(list.has_recent_root(&args.root), RegistryError::RootNotRecent);
        }

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

        // 0.25 of an accepted token, from the profile's wallet to the treasury's.
        let mint = ctx.accounts.profile_tokens.mint;
        // One rule, 25 cents, always. Paying yourself is not paying: the same account on both
        // sides would move nothing, and the only key that could arrange it is the treasury's.
        // Anchor's duplicate-mutable-account check catches this first; the rule is written here
        // as well because these bytes are frozen at deploy and it must be findable in the
        // program's own text, not only in what a macro happened to generate.
        require_keys_neq!(
            ctx.accounts.profile_tokens.key(),
            ctx.accounts.treasury_tokens.key(),
            RegistryError::FeeGoesNowhere
        );
        require!(ctx.accounts.treasury_tokens.mint == mint, RegistryError::MintMismatch);
        require!(ctx.accounts.config.accepts(&mint), RegistryError::MintNotAccepted);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.profile_tokens.to_account_info(),
                    to: ctx.accounts.treasury_tokens.to_account_info(),
                    authority: ctx.accounts.profile_wallet.to_account_info(),
                },
            ),
            REGISTRATION_FEE,
        )?;

        emit!(Registered {
            market: args.market,
            did: args.did,
            code: args.code,
            list_index: args.list_index,
        });
        Ok(())
    }

    /// Accept one more mint. The treasury key signs.
    ///
    /// What a program can check is checked: the mint is a classic SPL Token mint (the account's
    /// owner is the token program, which `anchor_spl::token::Mint` enforces), it is initialized,
    /// and it carries exactly the decimals the config fixes, so 0.25 never silently means
    /// something else. Whether a mint really is a dollar stablecoin is a judgement no program can
    /// make; it is the treasury key's, and this is the pattern that bounds it.
    ///
    /// Nothing removes a mint, so `mints[0]`, USDC, is there forever and registration can never
    /// be halted by taking a token away.
    pub fn add_token(ctx: Context<AddToken>) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let decimals = ctx.accounts.mint.decimals;
        let config = &mut ctx.accounts.config;
        require!(decimals == config.token_decimals, RegistryError::WrongDecimals);
        require!(!config.accepts(&mint), RegistryError::MintAlreadyAccepted);
        let n = config.mint_count as usize;
        require!(n < MAX_MINTS, RegistryError::TooManyMints);
        config.mints[n] = mint;
        config.mint_count = (n + 1) as u8;
        emit!(TokenAccepted { mint });
        Ok(())
    }

    /// Move the lamports an account holds above the current rent-exempt minimum to the treasury.
    ///
    /// Solana is part way through a five-step cut to the rent rate. Deposits already sitting in
    /// registry accounts stay where they are, and only an instruction in the owning program can
    /// move them, so a sealed program without this one locks the difference away forever. Anyone
    /// may call it: there is no key behind a program-derived address, the only possible
    /// destination is the sealed treasury, and the foundation must not be a liveness dependency
    /// for its own money.
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
        //   treasury.lamports += excess                the sealed treasury; never a caller's choice
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
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += excess;
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
    #[account(mut)]
    pub payer: Signer<'info>,
    pub treasury_key: Signer<'info>,
    /// USDC. `mints[0]` forever: nothing in this program removes a mint.
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenList<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_key)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + IdentityList::LEN,
        seeds = [LIST_SEED, &config.list_count.to_le_bytes()],
        bump
    )]
    pub list: AccountLoader<'info, IdentityList>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub treasury_key: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(list_index: u32)]
pub struct ListAdmin<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_key)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [LIST_SEED, &list_index.to_le_bytes()], bump)]
    pub list: AccountLoader<'info, IdentityList>,
    pub treasury_key: Signer<'info>,
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
    /// Pays the code account's rent and the network fee. A sponsor, or the person themselves.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The profile's wallet, which the 0.25 comes from.
    pub profile_wallet: Signer<'info>,
    #[account(mut, token::authority = profile_wallet)]
    pub profile_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::authority = config.treasury)]
    pub treasury_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToken<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_key)]
    pub config: Account<'info, Config>,
    pub treasury_key: Signer<'info>,
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
    /// CHECK: the sealed treasury and nothing else. It only ever receives lamports.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
}

#[event]
pub struct RegistryOpened {
    pub treasury: Pubkey,
    pub treasury_key: Pubkey,
    pub usdc_mint: Pubkey,
}

#[event]
pub struct ListOpened {
    pub list_index: u32,
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
/// reads to build a badge page.
#[event]
pub struct Registered {
    pub market: String,
    pub did: String,
    pub code: [u8; 32],
    pub list_index: u32,
}

#[event]
pub struct TokenAccepted {
    pub mint: Pubkey,
}

#[event]
pub struct RentSwept {
    pub account: Pubkey,
    pub lamports: u64,
    pub left: u64,
}

/// Compile-time proof that the sealed sizes are what this file says they are.
const _: () = {
    assert!(IdentityList::LEN == 5456);
    assert!(CodeTree::LEN == 1104);
    assert!(Config::LEN == 583);
    assert!(UsedCode::LEN == 1);
    assert!(FRONTIER_LEN == MAX_DEPTH + 1);
};

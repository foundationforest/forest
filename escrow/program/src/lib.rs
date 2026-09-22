//! The Forest escrow, v1.
//!
//! One shape. An amount of a classic SPL token held between two keys, buyer and seller, released
//! by rules the chain can read by itself: signatures and time. Never by events. Each escrow has
//! its own deposit account, funded by a plain transfer from anywhere; the escrow counts as
//! funded when that account holds at least the amount, and anything above the amount goes back to
//! the buyer at the end.
//!
//! This program is sealed per version. The upgrade authority is removed at deploy, so nothing
//! here can be patched: read `escrow/README.md` for what is sealed and what the app decides.
//! There is no admin, no config account, no pause and no fee.
//!
//! Nothing is shipped. Nothing here has run anywhere but a local validator and LiteSVM.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod state;

use errors::EscrowError;
use state::*;

declare_id!("FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT");

/// Written into every escrow. A v2 is a new program at a new address.
pub const VERSION: u8 = 1;
pub const ESCROW_SEED: &[u8] = b"escrow";

/// What `create` carries. Sealed: clients build these bytes forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateArgs {
    /// Any number the buyer has not used before. The app picks it at random.
    pub id: u64,
    pub seller: Pubkey,
    pub arbiter: Option<Pubkey>,
    /// In the mint's base units.
    pub amount: u64,
    /// Unix seconds. When set, the clock starts here rather than at funding.
    pub service_time: Option<i64>,
    pub silence_days: u16,
    /// At most four, offsets strictly rising, each refund between 0 and 10,000 basis points.
    pub steps: Vec<Step>,
}

#[program]
pub mod forest_escrow {
    use super::*;

    /// Open an escrow. The buyer signs; whoever pays the rent signs too and is recorded.
    ///
    /// The deposit account is the escrow's associated token account for the mint, so any wallet
    /// that can send this token "to an address" lands it here: the address to send to is the
    /// escrow's own. If that account already exists, because money arrived before this landed,
    /// it is adopted and, if it already holds the amount, the escrow is funded from this moment.
    pub fn create(ctx: Context<Create>, args: CreateArgs) -> Result<()> {
        let buyer = ctx.accounts.buyer.key();
        require_keys_neq!(args.seller, buyer, EscrowError::SameParty);
        require_keys_neq!(args.seller, Pubkey::default(), EscrowError::EmptyKey);
        let arbiter = match args.arbiter {
            Some(key) => {
                require_keys_neq!(key, Pubkey::default(), EscrowError::EmptyKey);
                require_keys_neq!(key, buyer, EscrowError::ArbiterIsAParty);
                require_keys_neq!(key, args.seller, EscrowError::ArbiterIsAParty);
                key
            }
            None => Pubkey::default(),
        };
        require!(args.amount > 0, EscrowError::AmountZero);
        require!(args.silence_days > 0, EscrowError::SilenceZero);
        let service_time = match args.service_time {
            Some(t) => {
                require!(t > 0, EscrowError::BadServiceTime);
                t
            }
            None => 0,
        };
        require!(args.steps.len() <= MAX_STEPS, EscrowError::TooManySteps);
        let mut steps = [Step::default(); MAX_STEPS];
        let mut previous: Option<i64> = None;
        for (i, step) in args.steps.iter().enumerate() {
            require!(step.refund_bps <= BPS, EscrowError::StepOverHundred);
            if let Some(p) = previous {
                require!(step.offset > p, EscrowError::StepsUnsorted);
            }
            previous = Some(step.offset);
            steps[i] = *step;
        }

        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        escrow.version = VERSION;
        escrow.id = args.id;
        escrow.buyer = buyer;
        escrow.seller = args.seller;
        escrow.arbiter = arbiter;
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.rent_payer = ctx.accounts.payer.key();
        escrow.amount = args.amount;
        escrow.service_time = service_time;
        escrow.silence_days = args.silence_days;
        escrow.step_count = args.steps.len() as u8;
        escrow.steps = steps;
        escrow.created_at = now;
        escrow.funded_at = 0;
        escrow.status = Status::Open;
        escrow.bump = ctx.bumps.escrow;

        emit!(Created {
            escrow: escrow.key(),
            version: VERSION,
            id: args.id,
            buyer,
            seller: args.seller,
            arbiter,
            mint: escrow.mint,
            vault: escrow.vault,
            rent_payer: escrow.rent_payer,
            amount: args.amount,
            service_time,
            silence_days: args.silence_days,
            steps: args.steps,
            created_at: now,
        });

        // Money that arrived before the escrow did counts from now.
        let balance = ctx.accounts.vault.amount;
        if balance >= escrow.amount {
            escrow.funded_at = now;
            escrow.status = Status::Funded;
            emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        }
        Ok(())
    }

    /// Record that the deposit account holds the amount. Anyone may send it.
    ///
    /// This is the observation that starts the clock when there is no service time. Every
    /// instruction that needs funding checks the balance itself, so skipping this blocks nothing
    /// except silence, which cannot be counted from a moment nobody recorded.
    pub fn mark_funded(ctx: Context<MarkFunded>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.funded_at == 0, EscrowError::AlreadyFunded);
        let balance = ctx.accounts.vault.amount;
        require!(balance >= escrow.amount, EscrowError::NotFunded);
        let now = Clock::get()?.unix_timestamp;
        escrow.funded_at = now;
        if escrow.status == Status::Open {
            escrow.status = Status::Funded;
        }
        emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        Ok(())
    }

    /// The buyer releases: `seller_bps` of the amount to the seller (10,000 is all of it), the
    /// rest and anything above the amount back to the buyer. Not while locked.
    pub fn approve(ctx: Context<SettleAs>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_keys_eq!(ctx.accounts.actor.key(), escrow.buyer, EscrowError::NotTheBuyer);
        require!(escrow.status != Status::Locked, EscrowError::Locked);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let to_seller = share(escrow.amount, seller_bps);
        emit!(Approved { escrow: escrow.key(), seller_bps, to_seller, to_buyer: balance - to_seller });
        settle(&ctx.accounts.ending(), Outcome::Approved, to_seller)
    }

    /// Silence: after `silence_days` from the clock start, anyone may release the amount to the
    /// seller. Not while locked; not before the clock has started.
    pub fn release_by_silence(ctx: Context<Settle>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status != Status::Locked, EscrowError::Locked);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let start = escrow.clock_start().ok_or_else(|| error!(EscrowError::ClockNotStarted))?;
        let ends = escrow.silence_ends(start)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now > ends, EscrowError::SilenceNotOver);
        let to_seller = escrow.amount;
        emit!(ReleasedBySilence {
            escrow: escrow.key(),
            clock_start: start,
            silence_ended: ends,
            to_seller,
            to_buyer: balance - to_seller,
        });
        settle(&ctx.accounts.ending(), Outcome::ReleasedBySilence, to_seller)
    }

    /// The buyer objects before silence releases. The escrow locks: only agreement, the arbiter,
    /// or the seller giving everything back can end it. An unresolved lock marks both, in the
    /// log: an `Objected` with no `Closed` after it.
    pub fn object(ctx: Context<Object>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status != Status::Locked, EscrowError::Locked);
        let balance = ctx.accounts.vault.amount;
        require!(balance >= escrow.amount, EscrowError::NotFunded);
        let now = Clock::get()?.unix_timestamp;
        if escrow.funded_at == 0 {
            // First observed funded here: the objection is the observation.
            escrow.funded_at = now;
            emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        }
        let start = escrow.clock_start().ok_or_else(|| error!(EscrowError::ClockNotStarted))?;
        let ends = escrow.silence_ends(start)?;
        require!(now <= ends, EscrowError::SilenceOver);
        escrow.status = Status::Locked;
        emit!(Objected { escrow: escrow.key(), at: now, silence_ends: ends });
        Ok(())
    }

    /// Both keys sign any split. Allowed in any state once funded, locked included.
    pub fn agree(ctx: Context<SettleBoth>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let to_seller = share(escrow.amount, seller_bps);
        emit!(Agreed { escrow: escrow.key(), seller_bps, to_seller, to_buyer: balance - to_seller });
        settle(&ctx.accounts.ending(), Outcome::Agreed, to_seller)
    }

    /// The arbiter named at creation decides any split. Funded or locked.
    pub fn arbitrate(ctx: Context<SettleAs>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.has_arbiter(), EscrowError::NoArbiter);
        require_keys_eq!(ctx.accounts.actor.key(), escrow.arbiter, EscrowError::NotTheArbiter);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let to_seller = share(escrow.amount, seller_bps);
        emit!(Arbitrated {
            escrow: escrow.key(),
            arbiter: escrow.arbiter,
            seller_bps,
            to_seller,
            to_buyer: balance - to_seller,
        });
        settle(&ctx.accounts.ending(), Outcome::Arbitrated, to_seller)
    }

    /// The buyer cancels alone, before a deadline: the step in force says how much comes back;
    /// the rest of the amount goes to the seller. Not after the last deadline; not while locked.
    /// The seller's share rounds down, as in every split, so the buyer gets at least the step's
    /// percent.
    pub fn cancel_buyer(ctx: Context<SettleAs>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_keys_eq!(ctx.accounts.actor.key(), escrow.buyer, EscrowError::NotTheBuyer);
        require!(escrow.status != Status::Locked, EscrowError::Locked);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let start = escrow.clock_start().ok_or_else(|| error!(EscrowError::ClockNotStarted))?;
        let now = Clock::get()?.unix_timestamp;
        let (index, step) = escrow
            .current_step(start, now)?
            .ok_or_else(|| error!(EscrowError::AfterLastDeadline))?;
        let to_seller = share(escrow.amount, BPS - step.refund_bps);
        emit!(CancelledByBuyer {
            escrow: escrow.key(),
            step: index,
            refund_bps: step.refund_bps,
            to_buyer: balance - to_seller,
            to_seller,
        });
        settle(&ctx.accounts.ending(), Outcome::CancelledByBuyer, to_seller)
    }

    /// The seller cancels, any time before release, locked included: the buyer gets everything
    /// back, and the log marks the seller.
    pub fn cancel_seller(ctx: Context<SettleAs>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_keys_eq!(ctx.accounts.actor.key(), escrow.seller, EscrowError::NotTheSeller);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        emit!(CancelledBySeller { escrow: escrow.key(), seller: escrow.seller, to_buyer: balance });
        settle(&ctx.accounts.ending(), Outcome::CancelledBySeller, 0)
    }

    /// Close an escrow that never held the amount. Whatever the deposit account holds goes back
    /// to the buyer, both accounts close, and the rent goes back to whoever paid it. The seller
    /// may do this at any time; the buyer after the last deadline, or at any time when there are
    /// no steps. A funded escrow cannot be closed this way.
    pub fn close(ctx: Context<SettleAs>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let actor = ctx.accounts.actor.key();
        require!(ctx.accounts.vault.amount < escrow.amount, EscrowError::StillFunded);
        if actor == escrow.buyer {
            if let Some(deadline) = escrow.last_deadline(escrow.unfunded_reference())? {
                let now = Clock::get()?.unix_timestamp;
                require!(now > deadline, EscrowError::BeforeLastDeadline);
            }
        } else {
            require_keys_eq!(actor, escrow.seller, EscrowError::NotAParty);
        }
        settle(&ctx.accounts.ending(), Outcome::NeverFunded, 0)
    }
}

/// The deposit account's balance, which must be at least the amount.
fn funded_balance(escrow: &Escrow, vault: &Account<TokenAccount>) -> Result<u64> {
    let balance = vault.amount;
    require!(balance >= escrow.amount, EscrowError::NotFunded);
    Ok(balance)
}

/// The accounts every ending touches.
struct Ending<'a, 'info> {
    escrow: &'a Account<'info, Escrow>,
    vault: &'a Account<'info, TokenAccount>,
    buyer_tokens: &'a Account<'info, TokenAccount>,
    seller_tokens: &'a Account<'info, TokenAccount>,
    rent_payer: &'a UncheckedAccount<'info>,
    token_program: &'a Program<'info, Token>,
}

/// The common ending. `to_seller` of the deposit account's balance goes to the seller; the rest,
/// which is the buyer's share plus anything above the amount, goes to the buyer. Then the deposit
/// account closes, with its rent to the rent payer, and Anchor closes the escrow account the same
/// way after the handler returns.
fn settle(e: &Ending, outcome: Outcome, to_seller: u64) -> Result<()> {
    let escrow = e.escrow;
    let balance = e.vault.amount;
    let to_buyer = balance
        .checked_sub(to_seller)
        .ok_or_else(|| error!(EscrowError::NotFunded))?;

    let id = escrow.id.to_le_bytes();
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.buyer.as_ref(), &id, &[escrow.bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    if to_seller > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                e.token_program.key(),
                Transfer {
                    from: e.vault.to_account_info(),
                    to: e.seller_tokens.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                signer,
            ),
            to_seller,
        )?;
    }
    if to_buyer > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                e.token_program.key(),
                Transfer {
                    from: e.vault.to_account_info(),
                    to: e.buyer_tokens.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                signer,
            ),
            to_buyer,
        )?;
    }

    let vault_rent = e.vault.to_account_info().lamports();
    token::close_account(CpiContext::new_with_signer(
        e.token_program.key(),
        CloseAccount {
            account: e.vault.to_account_info(),
            destination: e.rent_payer.to_account_info(),
            authority: escrow.to_account_info(),
        },
        signer,
    ))?;
    let escrow_rent = escrow.to_account_info().lamports();

    emit!(Closed {
        escrow: escrow.key(),
        outcome,
        amount: escrow.amount,
        balance,
        to_seller,
        to_buyer,
        rent_payer: escrow.rent_payer,
        rent_lamports: vault_rent + escrow_rent,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: CreateArgs)]
pub struct Create<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Escrow::LEN,
        seeds = [ESCROW_SEED, buyer.key().as_ref(), &args.id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// The deposit account: the escrow's associated token account for the mint. Adopted if it
    /// already exists, which only this program's own address can own.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub buyer: Signer<'info>,
    /// Pays the rent of both accounts and gets it back when the escrow ends. A sponsor, or the
    /// buyer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// A classic SPL Token mint. `anchor_spl::token::Mint` is owned by the classic token program
    /// and nothing else, which is how a Token-2022 mint is refused.
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkFunded<'info> {
    #[account(mut, has_one = vault)]
    pub escrow: Account<'info, Escrow>,
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Object<'info> {
    #[account(mut, has_one = vault, has_one = buyer)]
    pub escrow: Account<'info, Escrow>,
    pub vault: Account<'info, TokenAccount>,
    pub buyer: Signer<'info>,
}

/// An ending anyone may send: `release_by_silence`.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, close = rent_payer, has_one = vault, has_one = rent_payer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// Any token account for the mint that the buyer owns.
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.buyer)]
    pub buyer_tokens: Account<'info, TokenAccount>,
    /// Any token account for the mint that the seller owns.
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.seller)]
    pub seller_tokens: Account<'info, TokenAccount>,
    /// CHECK: the key recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// An ending one key signs: `approve`, `arbitrate`, `cancel_buyer`, `cancel_seller`, `close`.
/// Which key it must be is checked in the handler, so each rule is findable in the program's own
/// text.
#[derive(Accounts)]
pub struct SettleAs<'info> {
    #[account(mut, close = rent_payer, has_one = vault, has_one = rent_payer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.buyer)]
    pub buyer_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.seller)]
    pub seller_tokens: Account<'info, TokenAccount>,
    /// CHECK: the key recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub actor: Signer<'info>,
}

/// An ending both parties sign: `agree`.
#[derive(Accounts)]
pub struct SettleBoth<'info> {
    #[account(mut, close = rent_payer, has_one = vault, has_one = rent_payer, has_one = buyer, has_one = seller)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.buyer)]
    pub buyer_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.seller)]
    pub seller_tokens: Account<'info, TokenAccount>,
    /// CHECK: the key recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub buyer: Signer<'info>,
    pub seller: Signer<'info>,
}

impl<'info> Settle<'info> {
    fn ending(&self) -> Ending<'_, 'info> {
        Ending {
            escrow: &self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: &self.seller_tokens,
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> SettleAs<'info> {
    fn ending(&self) -> Ending<'_, 'info> {
        Ending {
            escrow: &self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: &self.seller_tokens,
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> SettleBoth<'info> {
    fn ending(&self) -> Ending<'_, 'info> {
        Ending {
            escrow: &self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: &self.seller_tokens,
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Events. Every state change, with amounts, so an index can read outcomes from the log alone.
// ---------------------------------------------------------------------------------------------

#[event]
pub struct Created {
    pub escrow: Pubkey,
    pub version: u8,
    pub id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    /// The zero key when none.
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub rent_payer: Pubkey,
    pub amount: u64,
    /// 0 when none.
    pub service_time: i64,
    pub silence_days: u16,
    pub steps: Vec<Step>,
    pub created_at: i64,
}

/// The deposit account observed holding the amount. When there is no service time, this moment
/// is the clock start.
#[event]
pub struct Funded {
    pub escrow: Pubkey,
    pub balance: u64,
    pub funded_at: i64,
}

#[event]
pub struct Approved {
    pub escrow: Pubkey,
    pub seller_bps: u16,
    pub to_seller: u64,
    pub to_buyer: u64,
}

#[event]
pub struct ReleasedBySilence {
    pub escrow: Pubkey,
    pub clock_start: i64,
    pub silence_ended: i64,
    pub to_seller: u64,
    pub to_buyer: u64,
}

/// The lock. With no `Closed` after it, the lock is unresolved and marks both parties.
#[event]
pub struct Objected {
    pub escrow: Pubkey,
    pub at: i64,
    pub silence_ends: i64,
}

#[event]
pub struct Agreed {
    pub escrow: Pubkey,
    pub seller_bps: u16,
    pub to_seller: u64,
    pub to_buyer: u64,
}

#[event]
pub struct Arbitrated {
    pub escrow: Pubkey,
    pub arbiter: Pubkey,
    pub seller_bps: u16,
    pub to_seller: u64,
    pub to_buyer: u64,
}

#[event]
pub struct CancelledByBuyer {
    pub escrow: Pubkey,
    /// Which step was in force, from 0.
    pub step: u8,
    pub refund_bps: u16,
    pub to_buyer: u64,
    pub to_seller: u64,
}

/// The seller-cancelled marker: this event is it.
#[event]
pub struct CancelledBySeller {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub to_buyer: u64,
}

/// Every ending. `balance` is what the deposit account held; `to_seller + to_buyer == balance`.
#[event]
pub struct Closed {
    pub escrow: Pubkey,
    pub outcome: Outcome,
    pub amount: u64,
    pub balance: u64,
    pub to_seller: u64,
    pub to_buyer: u64,
    pub rent_payer: Pubkey,
    pub rent_lamports: u64,
}

/// Compile-time proof that the sealed size is what `state.rs` says it is.
const _: () = {
    assert!(Escrow::LEN == 278);
    assert!(MAX_STEPS == 4);
};

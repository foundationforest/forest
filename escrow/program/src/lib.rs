//! The Forest escrow, v1.
//!
//! One shape. An amount of a classic SPL token held between two keys, buyer and seller, released
//! by rules the chain can read by itself: signatures and time. Never by events. Each escrow has
//! its own deposit account, funded by a plain transfer from anywhere; the escrow counts as
//! funded when that account holds at least the amount, and anything above the amount goes back to
//! the buyer at the end.
//!
//! The seller accepts before anything but paying in full can happen: until then the buyer may
//! approve everything to the seller, which needs nobody's consent, or take everything back. An
//! escrow the seller opens is accepted from the start. When an escrow that held the amount ends,
//! its deposit account closes and the escrow account stays, with the outcome and the amounts in
//! it: its address is a permanent receipt, and never holds a second deal.
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
/// Wrapped SOL. A classic SPL Token mint, and refused at `create`: SOL sent to its deposit account
/// by a plain transfer counts only after someone syncs it, and whatever arrives after the last sync
/// would leave with the deposit account's rent rather than go to the buyer.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// What `create` carries. Sealed: clients build these bytes forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateArgs {
    /// Any number the buyer has not used before. The app picks it at random.
    pub id: u64,
    /// Whose money it is. The escrow's address is derived from this key and the id, whoever opens it.
    pub buyer: Pubkey,
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

    /// Open an escrow. The buyer or the seller signs as its creator; whoever pays the rent signs
    /// too and is recorded.
    ///
    /// Opened by the buyer, it is a proposal the seller has yet to accept. Opened by the seller, it
    /// is an invoice, accepted from this moment.
    ///
    /// The deposit account is the escrow's associated token account for the mint, so any wallet
    /// that can send this token "to an address" lands it here: the address to send to is the
    /// escrow's own. If that account already exists, because money arrived before this landed,
    /// it is adopted and, if it already holds the amount and the escrow is accepted, the escrow
    /// is funded from this moment.
    pub fn create(ctx: Context<Create>, args: CreateArgs) -> Result<()> {
        let buyer = args.buyer;
        require_keys_neq!(args.seller, buyer, EscrowError::SameParty);
        require_keys_neq!(args.seller, Pubkey::default(), EscrowError::EmptyKey);
        require_keys_neq!(buyer, Pubkey::default(), EscrowError::EmptyKey);
        let creator = ctx.accounts.creator.key();
        require!(creator == buyer || creator == args.seller, EscrowError::NotAParty);
        let arbiter = match args.arbiter {
            Some(key) => {
                require_keys_neq!(key, Pubkey::default(), EscrowError::EmptyKey);
                require_keys_neq!(key, buyer, EscrowError::ArbiterIsAParty);
                require_keys_neq!(key, args.seller, EscrowError::ArbiterIsAParty);
                key
            }
            None => Pubkey::default(),
        };
        require_keys_neq!(ctx.accounts.mint.key(), NATIVE_MINT, EscrowError::NativeMint);
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
        let invoice = creator == args.seller;
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
        escrow.status = if invoice { Status::Accepted } else { Status::Open };
        escrow.bump = ctx.bumps.escrow;
        escrow.accepted_at = if invoice { now } else { 0 };
        escrow.ended_at = 0;
        escrow.outcome = Outcome::Approved; // meaningless until the status is Ended
        escrow.to_seller = 0;
        escrow.to_buyer = 0;

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
        if invoice {
            emit!(Accepted { escrow: escrow.key(), seller: escrow.seller, accepted_at: now });
        }

        // Money that arrived before the escrow did counts from now, once the seller has accepted.
        let balance = ctx.accounts.vault.amount;
        if invoice && balance >= escrow.amount {
            escrow.funded_at = now;
            escrow.status = Status::Funded;
            emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        }
        Ok(())
    }

    /// The seller accepts the escrow as it stands: the amount, the mint, the arbiter, the clock and
    /// the steps. Only now can anything but a full approval or the buyer's withdrawal happen.
    ///
    /// If the deposit account already holds the amount, this is also the observation of funding,
    /// and the clock starts now when there is no service time.
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(!escrow.accepted(), EscrowError::AlreadyAccepted);
        let now = Clock::get()?.unix_timestamp;
        escrow.accepted_at = now;
        escrow.status = Status::Accepted;
        emit!(Accepted { escrow: escrow.key(), seller: escrow.seller, accepted_at: now });
        let balance = ctx.accounts.vault.amount;
        if balance >= escrow.amount {
            escrow.funded_at = now;
            escrow.status = Status::Funded;
            emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        }
        Ok(())
    }

    /// Record that the deposit account holds the amount. Anyone may send it, once the seller has
    /// accepted.
    ///
    /// This is the observation that starts the clock when there is no service time. Every
    /// instruction that needs funding checks the balance itself, so skipping this blocks nothing
    /// except silence and a buyer's cancellation, which cannot be counted from a moment nobody
    /// recorded.
    pub fn mark_funded(ctx: Context<MarkFunded>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(escrow.accepted(), EscrowError::NotAccepted);
        require!(escrow.funded_at == 0, EscrowError::AlreadyFunded);
        let balance = ctx.accounts.vault.amount;
        require!(balance >= escrow.amount, EscrowError::NotFunded);
        let now = Clock::get()?.unix_timestamp;
        escrow.funded_at = now;
        if escrow.status == Status::Accepted {
            escrow.status = Status::Funded;
        }
        emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        Ok(())
    }

    /// The buyer releases: `seller_bps` of the amount to the seller (10,000 is all of it), the
    /// rest and anything above the amount back to the buyer. Not while locked. Before the seller
    /// has accepted, only all of it: paying in full never needs the seller's consent.
    pub fn approve(ctx: Context<SettleAs>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require_keys_eq!(ctx.accounts.actor.key(), escrow.buyer, EscrowError::NotTheBuyer);
        require!(escrow.status != Status::Locked, EscrowError::Locked);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        require!(escrow.accepted() || seller_bps == BPS, EscrowError::NotAccepted);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let to_seller = share(escrow.amount, seller_bps);
        emit!(Approved { escrow: escrow.key(), seller_bps, to_seller, to_buyer: balance - to_seller });
        settle(&mut ctx.accounts.ending(), Outcome::Approved, to_seller)
    }

    /// Silence: after `silence_days` from the clock start, anyone may release the amount to the
    /// seller. Not while locked; not before the seller has accepted and the clock has started.
    pub fn release_by_silence(ctx: Context<Settle>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(escrow.accepted(), EscrowError::NotAccepted);
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
        settle(&mut ctx.accounts.ending(), Outcome::ReleasedBySilence, to_seller)
    }

    /// The buyer objects before silence releases, once the seller has accepted. The escrow locks:
    /// only agreement, the arbiter, or the seller giving everything back can end it. An unresolved
    /// lock marks both, in the log and in the account: `Locked`, and never `Ended`.
    pub fn object(ctx: Context<Object>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(escrow.accepted(), EscrowError::NotAccepted);
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

    /// Both keys sign any split. Allowed once the seller has accepted and the escrow is funded,
    /// locked included.
    pub fn agree(ctx: Context<SettleBoth>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(escrow.accepted(), EscrowError::NotAccepted);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        let to_seller = share(escrow.amount, seller_bps);
        emit!(Agreed { escrow: escrow.key(), seller_bps, to_seller, to_buyer: balance - to_seller });
        settle(&mut ctx.accounts.ending(), Outcome::Agreed, to_seller)
    }

    /// The arbiter named at creation decides any split, once the seller has accepted it. Funded or
    /// locked.
    pub fn arbitrate(ctx: Context<SettleAs>, seller_bps: u16) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(escrow.has_arbiter(), EscrowError::NoArbiter);
        require_keys_eq!(ctx.accounts.actor.key(), escrow.arbiter, EscrowError::NotTheArbiter);
        require!(escrow.accepted(), EscrowError::NotAccepted);
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
        settle(&mut ctx.accounts.ending(), Outcome::Arbitrated, to_seller)
    }

    /// The buyer cancels alone, before a deadline, once the seller has accepted: the step in force
    /// says how much comes back; the rest of the amount goes to the seller. Not after the last
    /// deadline; not while locked. The seller's share rounds down, as in every split, so the buyer
    /// gets at least the step's percent. (Before the seller accepts, the buyer withdraws instead.)
    pub fn cancel_buyer(ctx: Context<SettleAs>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require_keys_eq!(ctx.accounts.actor.key(), escrow.buyer, EscrowError::NotTheBuyer);
        require!(escrow.accepted(), EscrowError::NotAccepted);
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
        settle(&mut ctx.accounts.ending(), Outcome::CancelledByBuyer, to_seller)
    }

    /// The seller cancels, any time after accepting and before release, locked included: the
    /// buyer gets everything back, and the log marks the seller.
    pub fn cancel_seller(ctx: Context<SettleAs>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require_keys_eq!(ctx.accounts.actor.key(), escrow.seller, EscrowError::NotTheSeller);
        require!(escrow.accepted(), EscrowError::NotAccepted);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        emit!(CancelledBySeller { escrow: escrow.key(), seller: escrow.seller, to_buyer: balance });
        settle(&mut ctx.accounts.ending(), Outcome::CancelledBySeller, 0)
    }

    /// The buyer takes everything back from a funded escrow the seller has not accepted. After
    /// acceptance the buyer's way out is a cancellation step instead. The escrow account stays, as
    /// a receipt that says nobody dealt.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        require!(!escrow.accepted(), EscrowError::AlreadyAccepted);
        let balance = funded_balance(escrow, &ctx.accounts.vault)?;
        emit!(Withdrawn { escrow: escrow.key(), to_buyer: balance });
        settle(&mut ctx.accounts.ending(), Outcome::Withdrawn, 0)
    }

    /// Close an escrow that never held the amount. Whatever the deposit account holds goes back
    /// to the buyer, both accounts close, and both rents go back to whoever paid them: nothing was
    /// dealt, so there is no receipt to keep. The buyer or the seller may do this at any time; the
    /// rent payer after the last deadline, measured from the service time if set, else from
    /// creation, or at any time when there are no steps. A funded escrow cannot be closed at all.
    pub fn close_unfunded(ctx: Context<CloseUnfunded>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.ended(), EscrowError::Ended);
        let balance = ctx.accounts.vault.amount;
        require!(balance < escrow.amount, EscrowError::StillFunded);
        let closer = ctx.accounts.closer.key();
        if closer != escrow.buyer && closer != escrow.seller {
            require_keys_eq!(closer, escrow.rent_payer, EscrowError::NotACloser);
            if let Some(deadline) = escrow.last_deadline(escrow.unfunded_reference())? {
                let now = Clock::get()?.unix_timestamp;
                require!(now > deadline, EscrowError::BeforeLastDeadline);
            }
        }
        let escrow_key = escrow.key();
        let rent_payer = escrow.rent_payer;
        let (_, to_buyer, vault_rent) = pay_out(&ctx.accounts.ending(), 0)?;
        // Anchor closes the escrow account to the rent payer after this returns (`close`).
        let escrow_rent = ctx.accounts.escrow.to_account_info().lamports();
        emit!(Closed {
            escrow: escrow_key,
            closed_by: closer,
            to_buyer,
            rent_payer,
            rent_lamports: vault_rent + escrow_rent,
        });
        Ok(())
    }
}

/// The deposit account's balance, which must be at least the amount.
fn funded_balance(escrow: &Escrow, vault: &Account<TokenAccount>) -> Result<u64> {
    let balance = vault.amount;
    require!(balance >= escrow.amount, EscrowError::NotFunded);
    Ok(balance)
}

/// The accounts a payout touches.
struct Ending<'a, 'info> {
    escrow: &'a mut Account<'info, Escrow>,
    vault: &'a Account<'info, TokenAccount>,
    buyer_tokens: &'a Account<'info, TokenAccount>,
    /// `None` for the two exits that pay the seller nothing and do not name the seller's account:
    /// `withdraw` and `close_unfunded`.
    seller_tokens: Option<&'a Account<'info, TokenAccount>>,
    rent_payer: &'a UncheckedAccount<'info>,
    token_program: &'a Program<'info, Token>,
}

/// `to_seller` of the deposit account's balance to the seller; the rest, which is the buyer's
/// share plus anything above the amount, to the buyer. Then the deposit account closes, with its
/// rent to the rent payer. Returns the balance, the buyer's part and the rent returned.
fn pay_out(e: &Ending, to_seller: u64) -> Result<(u64, u64, u64)> {
    let balance = e.vault.amount;
    let to_buyer = balance
        .checked_sub(to_seller)
        .ok_or_else(|| error!(EscrowError::NotFunded))?;

    let id = e.escrow.id.to_le_bytes();
    let bump = [e.escrow.bump];
    let seeds: &[&[u8]] = &[ESCROW_SEED, e.escrow.buyer.as_ref(), &id, &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    if to_seller > 0 {
        let seller_tokens = e.seller_tokens.ok_or_else(|| error!(EscrowError::NotAParty))?;
        token::transfer(
            CpiContext::new_with_signer(
                e.token_program.key(),
                Transfer {
                    from: e.vault.to_account_info(),
                    to: seller_tokens.to_account_info(),
                    authority: e.escrow.to_account_info(),
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
                    authority: e.escrow.to_account_info(),
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
            authority: e.escrow.to_account_info(),
        },
        signer,
    ))?;
    Ok((balance, to_buyer, vault_rent))
}

/// The common ending of an escrow that held the amount: pay out, close the deposit account, and
/// write the outcome into the escrow account, which stays. That account is the receipt: its
/// address can never be opened again, and its bytes say who dealt, for how much, and how it ended.
fn settle(e: &mut Ending, outcome: Outcome, to_seller: u64) -> Result<()> {
    let (balance, to_buyer, vault_rent) = pay_out(e, to_seller)?;
    let now = Clock::get()?.unix_timestamp;
    let escrow = &mut *e.escrow;
    escrow.status = Status::Ended;
    escrow.ended_at = now;
    escrow.outcome = outcome;
    escrow.to_seller = to_seller;
    escrow.to_buyer = to_buyer;
    emit!(Ended {
        escrow: escrow.key(),
        outcome,
        amount: escrow.amount,
        balance,
        to_seller,
        to_buyer,
        accepted_at: escrow.accepted_at,
        ended_at: now,
        rent_payer: escrow.rent_payer,
        rent_lamports: vault_rent,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: CreateArgs)]
pub struct Create<'info> {
    /// Fails if it already exists, including as an ended escrow's receipt: an address that ever
    /// held a deal never holds another.
    #[account(
        init,
        payer = payer,
        space = 8 + Escrow::LEN,
        seeds = [ESCROW_SEED, args.buyer.as_ref(), &args.id.to_le_bytes()],
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
    /// The buyer, proposing; or the seller, invoicing.
    pub creator: Signer<'info>,
    /// Pays the rent of both accounts. Gets the deposit account's back when the escrow ends, and
    /// both back if it never held the amount. A sponsor, or either party.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// A classic SPL Token mint. `anchor_spl::token::Mint` is owned by the classic token program
    /// and nothing else, which is how a Token-2022 mint is refused. Wrapped SOL is refused by name.
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(mut, has_one = vault, has_one = seller)]
    pub escrow: Account<'info, Escrow>,
    pub vault: Account<'info, TokenAccount>,
    pub seller: Signer<'info>,
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
    #[account(mut, has_one = vault, has_one = rent_payer)]
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

/// An ending one key signs: `approve`, `arbitrate`, `cancel_buyer`, `cancel_seller`. Which key it
/// must be is checked in the handler, so each rule is findable in the program's own text.
#[derive(Accounts)]
pub struct SettleAs<'info> {
    #[account(mut, has_one = vault, has_one = rent_payer)]
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
    #[account(mut, has_one = vault, has_one = rent_payer, has_one = buyer, has_one = seller)]
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

/// The buyer's withdrawal before acceptance. It pays the seller nothing, so it does not name the
/// seller's token account: a buyer never has to make one to get their own money back.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = vault, has_one = rent_payer, has_one = buyer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.buyer)]
    pub buyer_tokens: Account<'info, TokenAccount>,
    /// CHECK: the key recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub buyer: Signer<'info>,
}

/// Closing an escrow that never held the amount. The only instruction that closes an escrow
/// account, and only this kind. Like `withdraw`, it does not name the seller's token account.
#[derive(Accounts)]
pub struct CloseUnfunded<'info> {
    #[account(mut, close = rent_payer, has_one = vault, has_one = rent_payer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = escrow.mint, token::authority = escrow.buyer)]
    pub buyer_tokens: Account<'info, TokenAccount>,
    /// CHECK: the key recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// The buyer, the seller, or the rent payer; which, and when, is checked in the handler.
    pub closer: Signer<'info>,
}

impl<'info> Settle<'info> {
    fn ending(&mut self) -> Ending<'_, 'info> {
        Ending {
            escrow: &mut self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: Some(&self.seller_tokens),
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> SettleAs<'info> {
    fn ending(&mut self) -> Ending<'_, 'info> {
        Ending {
            escrow: &mut self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: Some(&self.seller_tokens),
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> SettleBoth<'info> {
    fn ending(&mut self) -> Ending<'_, 'info> {
        Ending {
            escrow: &mut self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: Some(&self.seller_tokens),
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> Withdraw<'info> {
    fn ending(&mut self) -> Ending<'_, 'info> {
        Ending {
            escrow: &mut self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: None,
            rent_payer: &self.rent_payer,
            token_program: &self.token_program,
        }
    }
}

impl<'info> CloseUnfunded<'info> {
    fn ending(&mut self) -> Ending<'_, 'info> {
        Ending {
            escrow: &mut self.escrow,
            vault: &self.vault,
            buyer_tokens: &self.buyer_tokens,
            seller_tokens: None,
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

/// The seller accepted: in `accept`, or in `create` when the seller opened it (an invoice).
#[event]
pub struct Accepted {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub accepted_at: i64,
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

/// The lock. With no `Ended` after it, the lock is unresolved and marks both parties.
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

/// The buyer took everything back before the seller accepted.
#[event]
pub struct Withdrawn {
    pub escrow: Pubkey,
    pub to_buyer: u64,
}

/// Every ending of an escrow that held the amount, after its own event. `balance` is what the
/// deposit account held; `to_seller + to_buyer == balance`. `accepted_at` is 0 when the seller
/// never accepted (a full approval or a withdrawal before acceptance). The deposit account's rent
/// went back to the rent payer; the escrow account stays, holding the same numbers, as the receipt.
#[event]
pub struct Ended {
    pub escrow: Pubkey,
    pub outcome: Outcome,
    pub amount: u64,
    pub balance: u64,
    pub to_seller: u64,
    pub to_buyer: u64,
    pub accepted_at: i64,
    pub ended_at: i64,
    pub rent_payer: Pubkey,
    pub rent_lamports: u64,
}

/// An escrow that never held the amount, closed. Whatever the deposit account held went back to
/// the buyer; both accounts are gone and both rents went back to the rent payer. Not a receipt of
/// anything: nothing was dealt.
#[event]
pub struct Closed {
    pub escrow: Pubkey,
    pub closed_by: Pubkey,
    pub to_buyer: u64,
    pub rent_payer: Pubkey,
    pub rent_lamports: u64,
}

/// Compile-time proof that the sealed size is what `state.rs` says it is.
const _: () = {
    assert!(Escrow::LEN == 311);
    assert!(MAX_STEPS == 4);
};

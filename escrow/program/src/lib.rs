// ============================================================
// Program:    Forest escrow, v1
// Framework:  Anchor 1.2
// Testing:    LiteSVM (and a local validator, and a Trident fuzzer)
// Risk level: Medium by the safe-solana-builder table; treated as Critical, because it is
//             sealed at deploy and holds other people's money
// Template:   Frank Castle's safe-solana-builder
// Security:   see escrow/security-checklist.md
// ============================================================

//! The Forest escrow, v1.
//!
//! Money in, and out only when the two sides agree. One shape. An amount of a classic SPL token
//! held between two keys, buyer and seller. Each escrow has its own deposit account, funded by a
//! plain transfer from anywhere; the escrow counts as funded when that account holds at least the
//! agreed amount. Once funded it has three ways out: the buyer releases everything to the
//! seller, the seller releases everything to the buyer, or both sign a split. Receiving in full
//! never needs the receiver's signature, so each side alone can give, and only together can they
//! divide. Every way out pays out the whole balance, whatever it is.
//!
//! Two options, each off unless the creator turns it on at creation: an arbiter key that may sign
//! any split, and a timer that, a number of days after the funding is marked, lets anyone send
//! everything to the side it names. There is no other clock.
//!
//! When an escrow ends, its deposit account closes and the escrow account stays, with the outcome
//! and the amounts in it: its address is a permanent receipt, and never holds a second deal. Money
//! paid to it after the end goes back to the buyer, and rent above the minimum goes back to the
//! creator; neither changes the receipt. An escrow that never held the amount is closed instead,
//! both accounts and both rents.
//!
//! The escrow's address comes from the creator's key and an id, and the creator signs: nobody can
//! open an escrow at an address another key will use. Each party is paid only at its standard
//! token account for the mint. Every rent refund goes to the creator, whoever fronted the rent.
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
/// would leave with the deposit account's rent rather than with the deal.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// What `create` carries. Sealed: clients build these bytes forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateArgs {
    /// Any number the creator has not used before. The app picks it at random.
    pub id: u64,
    /// Whose money it is.
    pub buyer: Pubkey,
    pub seller: Pubkey,
    /// In the mint's base units: what the deal is for, and what funds it.
    pub amount: u64,
    /// Off unless set. Any key but the zero key, a party included.
    pub arbiter: Option<Pubkey>,
    /// Off unless set. At least one day.
    pub timer: Option<Timer>,
}

#[program]
pub mod forest_escrow {
    use super::*;

    /// Open an escrow. The buyer or the seller signs as its creator (an escrow the seller opens is
    /// an invoice). The address comes from the creator's key and the id, so only that key can open
    /// an escrow there. Whoever pays the rent signs too, and is not recorded: every rent refund
    /// goes to the creator.
    ///
    /// The deposit account is the escrow's associated token account for the mint, so any wallet
    /// that can send this token "to an address" lands it here: the address to send to is the
    /// escrow's own. If that account already exists, because money arrived before this landed,
    /// it is adopted, and what it holds is part of the deal.
    pub fn create(ctx: Context<Create>, args: CreateArgs) -> Result<()> {
        // Every argument is checked before anything is written.
        let buyer = args.buyer;
        require_keys_neq!(args.seller, buyer, EscrowError::SameParty);
        require_keys_neq!(buyer, Pubkey::default(), EscrowError::EmptyKey);
        require_keys_neq!(args.seller, Pubkey::default(), EscrowError::EmptyKey);
        let creator_key = ctx.accounts.creator.key();
        let creator = if creator_key == buyer {
            Side::Buyer
        } else if creator_key == args.seller {
            Side::Seller
        } else {
            return err!(EscrowError::NotAParty);
        };
        let arbiter = match args.arbiter {
            Some(key) => {
                // The zero key means "none" in the account, so it cannot also be a named arbiter.
                // Any other key may arbitrate, the buyer's or the seller's included.
                require_keys_neq!(key, Pubkey::default(), EscrowError::EmptyKey);
                key
            }
            None => Pubkey::default(),
        };
        require_keys_neq!(ctx.accounts.mint.key(), NATIVE_MINT, EscrowError::NativeMint);
        require!(args.amount > 0, EscrowError::AmountZero);
        let (timer_days, timer_to) = match args.timer {
            Some(t) => {
                require!(t.days > 0, EscrowError::TimerZero);
                (t.days, t.to)
            }
            None => (0, Side::Buyer),
        };

        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        escrow.version = VERSION;
        escrow.id = args.id;
        escrow.buyer = buyer;
        escrow.seller = args.seller;
        escrow.arbiter = arbiter;
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.rent_recipient = creator_key;
        escrow.amount = args.amount;
        escrow.creator = creator;
        escrow.timer_days = timer_days;
        escrow.timer_to = timer_to;
        escrow.created_at = now;
        escrow.funded_at = 0;
        escrow.status = Status::Open;
        escrow.bump = ctx.bumps.escrow;
        escrow.ended_at = 0;
        escrow.outcome = Outcome::ReleasedToSeller; // meaningless until the status is Ended
        escrow.to_seller = 0;
        escrow.to_buyer = 0;

        emit!(Created {
            escrow: escrow.key(),
            version: VERSION,
            id: args.id,
            buyer,
            seller: args.seller,
            creator,
            arbiter,
            mint: escrow.mint,
            vault: escrow.vault,
            rent_recipient: escrow.rent_recipient,
            amount: args.amount,
            timer_days,
            timer_to,
            created_at: now,
        });
        Ok(())
    }

    /// Record that the deposit account holds the amount. Anyone may send it, once.
    ///
    /// It records the time and nothing else. The timer counts from it; no way out needs it, since
    /// each one checks the balance itself.
    pub fn mark_funded(ctx: Context<MarkFunded>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.live(), EscrowError::Ended);
        require!(escrow.status == Status::Open, EscrowError::AlreadyFunded);
        let balance = ctx.accounts.vault.amount;
        require!(balance >= escrow.amount, EscrowError::NotFunded);
        let now = Clock::get()?.unix_timestamp;
        escrow.funded_at = now;
        escrow.status = Status::Funded;
        emit!(Funded { escrow: escrow.key(), balance, funded_at: now });
        Ok(())
    }

    /// The buyer gives: everything the deposit account holds, to the seller.
    pub fn release_to_seller(ctx: Context<ReleaseToSeller>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        require_keys_eq!(a.buyer.key(), a.escrow.buyer, EscrowError::NotTheBuyer);
        let balance = funded_balance(&a.escrow, &a.vault)?;
        let rent = pay_out(&a.escrow, &a.vault, &[(a.seller_tokens.to_account_info(), balance)], &a.rent_recipient, &a.token_program)?;
        end(&mut ctx.accounts.escrow, Outcome::ReleasedToSeller, balance, balance, 0, rent)
    }

    /// The seller gives: everything the deposit account holds, back to the buyer.
    pub fn release_to_buyer(ctx: Context<ReleaseToBuyer>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        require_keys_eq!(a.seller.key(), a.escrow.seller, EscrowError::NotTheSeller);
        let balance = funded_balance(&a.escrow, &a.vault)?;
        let rent = pay_out(&a.escrow, &a.vault, &[(a.buyer_tokens.to_account_info(), balance)], &a.rent_recipient, &a.token_program)?;
        end(&mut ctx.accounts.escrow, Outcome::ReleasedToBuyer, balance, 0, balance, rent)
    }

    /// Both sign any split: `seller_bps` of the balance to the seller, rounded down, the rest to
    /// the buyer.
    pub fn split(ctx: Context<Split>, seller_bps: u16) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        require_keys_eq!(a.buyer.key(), a.escrow.buyer, EscrowError::NotTheBuyer);
        require_keys_eq!(a.seller.key(), a.escrow.seller, EscrowError::NotTheSeller);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(&a.escrow, &a.vault)?;
        let (to_seller, to_buyer) = divide(balance, seller_bps)?;
        let payouts = [(a.seller_tokens.to_account_info(), to_seller), (a.buyer_tokens.to_account_info(), to_buyer)];
        let rent = pay_out(&a.escrow, &a.vault, &payouts, &a.rent_recipient, &a.token_program)?;
        end(&mut ctx.accounts.escrow, Outcome::Split, balance, to_seller, to_buyer, rent)
    }

    /// The arbiter named at creation signs any split, the same way both parties can. Only if one
    /// was named.
    pub fn arbitrate(ctx: Context<Arbitrate>, seller_bps: u16) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        require!(a.escrow.has_arbiter(), EscrowError::NoArbiter);
        require_keys_eq!(a.arbiter.key(), a.escrow.arbiter, EscrowError::NotTheArbiter);
        require!(seller_bps <= BPS, EscrowError::BadSplit);
        let balance = funded_balance(&a.escrow, &a.vault)?;
        let (to_seller, to_buyer) = divide(balance, seller_bps)?;
        let payouts = [(a.seller_tokens.to_account_info(), to_seller), (a.buyer_tokens.to_account_info(), to_buyer)];
        let rent = pay_out(&a.escrow, &a.vault, &payouts, &a.rent_recipient, &a.token_program)?;
        end(&mut ctx.accounts.escrow, Outcome::Arbitrated, balance, to_seller, to_buyer, rent)
    }

    /// The timer set at creation is due: anyone may send everything to the side it names. Due
    /// from `timer_days` whole days after the funding was marked, to the second. Only if a timer
    /// was set, and only once the funding has been marked.
    pub fn timer_release(ctx: Context<TimerRelease>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        require!(a.escrow.has_timer(), EscrowError::NoTimer);
        require!(a.escrow.status == Status::Funded, EscrowError::FundingNotMarked);
        let due = a.escrow.timer_due()?.ok_or_else(|| error!(EscrowError::FundingNotMarked))?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= due, EscrowError::TimerNotDue);
        let balance = funded_balance(&a.escrow, &a.vault)?;
        // Anyone sends this, so the account it pays is checked against the side the timer names:
        // that side's standard token account for the mint, by address, as on every way out.
        let to = a.to.to_account_info();
        let (to_seller, to_buyer) = match a.escrow.timer_to {
            Side::Buyer => {
                require_keys_eq!(to.key(), a.escrow.refund_address(), EscrowError::NotTheRefundAddress);
                (0, balance)
            }
            Side::Seller => {
                require_keys_eq!(to.key(), a.escrow.payout_address(), EscrowError::NotTheSellersAccount);
                (balance, 0)
            }
        };
        let rent = pay_out(&a.escrow, &a.vault, &[(to, balance)], &a.rent_recipient, &a.token_program)?;
        end(&mut ctx.accounts.escrow, Outcome::TimerReleased, balance, to_seller, to_buyer, rent)
    }

    /// Close an escrow that never held the amount. Whatever the deposit account holds goes back
    /// to the buyer, both accounts close, and both rents go back to the creator: nothing was
    /// dealt, so there is no receipt to keep. The buyer or the seller may do this at any time;
    /// whoever fronted the rent has no say. A funded escrow cannot be closed at all.
    pub fn close_unfunded(ctx: Context<CloseUnfunded>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.escrow.live(), EscrowError::Ended);
        let closer = a.closer.key();
        require!(closer == a.escrow.buyer || closer == a.escrow.seller, EscrowError::NotACloser);
        let balance = a.vault.amount;
        require!(balance < a.escrow.amount, EscrowError::StillFunded);
        let vault_rent = pay_out(&a.escrow, &a.vault, &[(a.buyer_tokens.to_account_info(), balance)], &a.rent_recipient, &a.token_program)?;
        // Anchor closes the escrow account to the creator after this returns (`close`).
        let escrow_rent = a.escrow.to_account_info().lamports();
        emit!(Closed {
            escrow: a.escrow.key(),
            closed_by: closer,
            to_buyer: balance,
            rent_recipient: a.escrow.rent_recipient,
            // Two accounts' lamports cannot add up past the total supply of SOL, far below u64::MAX.
            rent_lamports: vault_rent.saturating_add(escrow_rent),
        });
        Ok(())
    }

    /// Money that arrives after the end goes back to the buyer. Anyone may send this, on an escrow
    /// that has ended: whatever sits at its deposit address, which a later payment made again,
    /// goes to the buyer's refund address, the buyer's associated token account for the mint,
    /// which the caller makes first, at the caller's cost, if it does not exist. The deposit
    /// account closes again and its rent goes to the buyer, whose wallet almost always made it:
    /// this rent was not fronted at creation, so it is not the creator's.
    /// The receipt does not change: it says what the deal was, and this was not part of it.
    pub fn recover_late(ctx: Context<RecoverLate>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == Status::Ended, EscrowError::NotEnded);
        let late = ctx.accounts.vault.amount;

        let creator = escrow.creator_key();
        let id = escrow.id.to_le_bytes();
        let bump = [escrow.bump];
        let seeds: &[&[u8]] = &[ESCROW_SEED, creator.as_ref(), &id, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        if late > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.refund.to_account_info(),
                        authority: escrow.to_account_info(),
                    },
                    signer,
                ),
                late,
            )?;
        }
        let rent = ctx.accounts.vault.to_account_info().lamports();
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: escrow.to_account_info(),
            },
            signer,
        ))?;
        emit!(RecoveredLate { escrow: escrow.key(), to_buyer: late, rent_lamports: rent });
        Ok(())
    }

    /// Move the lamports the escrow account holds above the current rent-exempt minimum to the
    /// rent recipient recorded at creation: the creator.
    ///
    /// Solana is part way through a cut to the rent rate, and receipts are never closed, so each
    /// one would keep the difference forever: only an instruction in this program can move it.
    /// Anyone may call it, on an escrow in any state: the only possible destination is the
    /// creator, and the account keeps exactly its minimum. SOL sent to the escrow's address leaves
    /// the same way.
    pub fn sweep_rent(ctx: Context<SweepRent>) -> Result<()> {
        let account = ctx.accounts.escrow.to_account_info();

        // The registry's check, in full, so it can never take more than the excess:
        //
        //   rent    = Rent::get()                      read at runtime, every time; never a constant,
        //                                              because the rate changing is why this exists
        //   minimum = rent.minimum_balance(data_len)   for this account's own size, which never changes
        //   excess  = lamports - minimum               saturating, so an account already at or below
        //                                              the minimum yields zero and the call fails
        //   require excess > 0
        //   account.lamports -= excess                 subtract; never assign a computed total
        //   rent_recipient.lamports += excess          the recorded creator; never a caller's choice
        //   assert account.lamports == minimum         still exactly rent exempt
        //
        // The account's bytes are not changed, it is never grown, realloc'd or closed, and no
        // signer is required.
        let rent = Rent::get()?;
        let minimum = rent.minimum_balance(account.data_len());
        let lamports = account.lamports();
        let excess = lamports.saturating_sub(minimum);
        require!(excess > 0, EscrowError::NothingToSweep);

        **account.try_borrow_mut_lamports()? -= excess;
        **ctx.accounts.rent_recipient.try_borrow_mut_lamports()? += excess;
        require_eq!(account.lamports(), minimum, EscrowError::NothingToSweep);

        emit!(RentSwept { escrow: account.key(), lamports: excess, left: minimum });
        Ok(())
    }
}

/// The deposit account's balance, which must be at least the amount. Funded is always this live
/// balance, never a flag: the ways out check it themselves, so a one-tap payment needs no
/// `mark_funded`. Money can only be added to the deposit account (only this program can move it
/// out, and only by ending the escrow), so once it holds the amount it holds it until the end.
fn funded_balance(escrow: &Escrow, vault: &Account<TokenAccount>) -> Result<u64> {
    let balance = vault.amount;
    require!(balance >= escrow.amount, EscrowError::NotFunded);
    Ok(balance)
}

/// A split of the whole balance: `seller_bps` of it to the seller, rounded down, and the rest to
/// the buyer. The two always add up to the balance.
fn divide(balance: u64, seller_bps: u16) -> Result<(u64, u64)> {
    let to_seller = share(balance, seller_bps);
    let to_buyer = balance.checked_sub(to_seller).ok_or_else(|| error!(EscrowError::BadSplit))?;
    Ok((to_seller, to_buyer))
}

/// Pays each `(account, amount)` from the deposit account, skipping zeros, then closes the
/// deposit account with its rent to the creator. Returns the rent returned.
///
/// The amounts are the whole balance, split by the caller. Nothing here re-checks their sum: the
/// token program refuses a transfer above what the deposit account holds, and refuses to close it
/// while anything is left, so an ending that does not pay out exactly the balance reverts whole.
fn pay_out<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    payouts: &[(AccountInfo<'info>, u64)],
    rent_recipient: &UncheckedAccount<'info>,
    token_program: &Program<'info, Token>,
) -> Result<u64> {
    let creator = escrow.creator_key();
    let id = escrow.id.to_le_bytes();
    let bump = [escrow.bump];
    let seeds: &[&[u8]] = &[ESCROW_SEED, creator.as_ref(), &id, &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    for (to, amount) in payouts {
        if *amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer { from: vault.to_account_info(), to: to.clone(), authority: escrow.to_account_info() },
                signer,
            ),
            *amount,
        )?;
    }
    let rent = vault.to_account_info().lamports();
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_recipient.to_account_info(),
            authority: escrow.to_account_info(),
        },
        signer,
    ))?;
    Ok(rent)
}

/// Every ending of an escrow that held the amount, after its payout: write the outcome into the
/// escrow account, which stays as the receipt, and emit it. One place, so every way out leaves the
/// same kind of receipt (the skill's "every path to a terminal state runs the same cleanup").
fn end(escrow: &mut Account<Escrow>, outcome: Outcome, balance: u64, to_seller: u64, to_buyer: u64, rent_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
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
        ended_at: now,
        rent_recipient: escrow.rent_recipient,
        rent_lamports,
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
        seeds = [ESCROW_SEED, creator.key().as_ref(), &args.id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// The deposit account: the escrow's associated token account for the mint. Adopted if it
    /// already exists. Only the associated token program can make an account at this address, and
    /// only as a token account for this mint held by the escrow, whose authority only this program
    /// can use; so an account found here can differ only in its balance, which is part of the deal.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// The buyer, proposing; or the seller, invoicing. The escrow's address comes from this key,
    /// and every rent refund goes to it.
    pub creator: Signer<'info>,
    /// Fronts the rent of both accounts: either party, or any key paying for them, such as a fee
    /// payer that charges the person for it. Gets nothing back; the refunds go to the creator.
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
pub struct MarkFunded<'info> {
    #[account(mut, has_one = vault)]
    pub escrow: Account<'info, Escrow>,
    pub vault: Account<'info, TokenAccount>,
}

/// The buyer gives. Names only the seller's account: the buyer is paid nothing.
#[derive(Accounts)]
pub struct ReleaseToSeller<'info> {
    #[account(mut, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the seller's standard token account for the mint, by address, and no other account;
    /// the same rule as the buyer's (see `ReleaseToBuyer`).
    #[account(mut, address = escrow.payout_address() @ EscrowError::NotTheSellersAccount)]
    pub seller_tokens: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// Checked against the escrow's buyer in the handler.
    pub buyer: Signer<'info>,
}

/// The seller gives. Names only the buyer's account: the seller is paid nothing.
#[derive(Accounts)]
pub struct ReleaseToBuyer<'info> {
    #[account(mut, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the buyer's standard token account for the mint, by address, and no other account.
    /// Checked by address alone, not by who holds it now, so a buyer who hands it to another key
    /// cannot block an ending. The token program checks the rest when it is paid: an initialized
    /// classic token account for the same mint, not frozen.
    #[account(mut, address = escrow.refund_address() @ EscrowError::NotTheRefundAddress)]
    pub buyer_tokens: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// Checked against the escrow's seller in the handler.
    pub seller: Signer<'info>,
}

/// Both parties sign a split.
#[derive(Accounts)]
pub struct Split<'info> {
    #[account(mut, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the buyer's standard token account for the mint, by address, and no other account;
    /// see `ReleaseToBuyer`. It needs to exist only if the buyer's share is above zero.
    #[account(mut, address = escrow.refund_address() @ EscrowError::NotTheRefundAddress)]
    pub buyer_tokens: UncheckedAccount<'info>,
    /// CHECK: the seller's standard token account for the mint, by address, and no other account;
    /// the same rule as the buyer's (see `ReleaseToBuyer`).
    #[account(mut, address = escrow.payout_address() @ EscrowError::NotTheSellersAccount)]
    pub seller_tokens: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// Checked against the escrow's buyer in the handler.
    pub buyer: Signer<'info>,
    /// Checked against the escrow's seller in the handler.
    pub seller: Signer<'info>,
}

/// The arbiter named at creation signs a split. The same accounts as `Split`, one signer.
#[derive(Accounts)]
pub struct Arbitrate<'info> {
    #[account(mut, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the buyer's standard token account for the mint, by address, and no other account;
    /// see `ReleaseToBuyer`. It needs to exist only if the buyer's share is above zero.
    #[account(mut, address = escrow.refund_address() @ EscrowError::NotTheRefundAddress)]
    pub buyer_tokens: UncheckedAccount<'info>,
    /// CHECK: the seller's standard token account for the mint, by address, and no other account;
    /// the same rule as the buyer's (see `ReleaseToBuyer`).
    #[account(mut, address = escrow.payout_address() @ EscrowError::NotTheSellersAccount)]
    pub seller_tokens: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// Checked against the escrow's arbiter in the handler.
    pub arbiter: Signer<'info>,
}

/// The timer pays one side, so it names one account. No signer: anyone may send it.
#[derive(Accounts)]
pub struct TimerRelease<'info> {
    #[account(mut, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: checked in the handler, by address, against the side the timer names: that side's
    /// standard token account for the mint. The token program checks the rest when it is paid.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Closing an escrow that never held the amount. The only instruction that closes an escrow
/// account, and only this kind. It pays the seller nothing and names no seller account.
#[derive(Accounts)]
pub struct CloseUnfunded<'info> {
    #[account(mut, close = rent_recipient, has_one = vault, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the buyer's standard token account for the mint, by address, and no other account;
    /// see `ReleaseToBuyer`. It needs to exist only if the deposit account holds anything, so an
    /// escrow nobody paid closes without anyone making the buyer an account.
    #[account(mut, address = escrow.refund_address() @ EscrowError::NotTheRefundAddress)]
    pub buyer_tokens: UncheckedAccount<'info>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// The buyer or the seller; checked in the handler.
    pub closer: Signer<'info>,
}

/// Late money back to the buyer: `recover_late`. The escrow is read only, because the receipt
/// does not change.
#[derive(Accounts)]
pub struct RecoverLate<'info> {
    #[account(has_one = vault, has_one = buyer, has_one = mint)]
    pub escrow: Account<'info, Escrow>,
    /// The deposit address, made again by a payment that came after the end. If nothing made it
    /// again, there is nothing to recover and this fails to load.
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the buyer recorded at creation, checked by `has_one`. It owns the refund account and
    /// receives the deposit account's rent.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,
    /// The buyer's refund address: its associated token account for the mint, and no other
    /// account. Made here, at the caller's cost, if it does not exist.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub refund: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// Anyone. Pays for the refund account if it has to be made.
    #[account(mut)]
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Rent above the minimum back to the creator: `sweep_rent`. No signer.
#[derive(Accounts)]
pub struct SweepRent<'info> {
    #[account(mut, has_one = rent_recipient)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: the creator's key, recorded at creation, checked by `has_one`. It only receives lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
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
    /// Who opened it. The seller, for an invoice.
    pub creator: Side,
    /// The zero key when none.
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub rent_recipient: Pubkey,
    pub amount: u64,
    /// 0 when there is no timer.
    pub timer_days: u16,
    /// Meaningless when `timer_days` is 0.
    pub timer_to: Side,
    pub created_at: i64,
}

/// `mark_funded` saw the deposit account holding the amount. The timer counts from `funded_at`.
#[event]
pub struct Funded {
    pub escrow: Pubkey,
    pub balance: u64,
    pub funded_at: i64,
}

/// Every ending of an escrow that held the amount. `balance` is what the deposit account held;
/// `to_seller + to_buyer == balance`. The deposit account's rent went back to the creator; the
/// escrow account stays, holding the same numbers, as the receipt.
#[event]
pub struct Ended {
    pub escrow: Pubkey,
    pub outcome: Outcome,
    pub amount: u64,
    pub balance: u64,
    pub to_seller: u64,
    pub to_buyer: u64,
    pub ended_at: i64,
    pub rent_recipient: Pubkey,
    pub rent_lamports: u64,
}

/// An escrow that never held the amount, closed. Whatever the deposit account held went back to
/// the buyer; both accounts are gone and both rents went back to the creator. Not a receipt of
/// anything: nothing was dealt.
#[event]
pub struct Closed {
    pub escrow: Pubkey,
    pub closed_by: Pubkey,
    pub to_buyer: u64,
    pub rent_recipient: Pubkey,
    pub rent_lamports: u64,
}

/// Money that arrived after the end went back to the buyer's refund address, and the deposit
/// account closed again with its rent to the buyer. The receipt did not change.
#[event]
pub struct RecoveredLate {
    pub escrow: Pubkey,
    pub to_buyer: u64,
    pub rent_lamports: u64,
}

/// Lamports above the escrow account's rent-exempt minimum went to the creator; `left` is the
/// minimum it still holds.
#[event]
pub struct RentSwept {
    pub escrow: Pubkey,
    pub lamports: u64,
    pub left: u64,
}

/// Compile-time proof that the sealed size is what `state.rs` says it is.
const _: () = {
    assert!(Escrow::LEN == 256);
    assert!(BPS == 10_000);
};

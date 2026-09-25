//! The one account, and the size it keeps forever.
//!
//! The layout is sealed with the program: clients and indexes read these bytes for as long as
//! the program lives. Nothing may grow, shrink or be reordered in v1.

use anchor_lang::prelude::*;

use crate::errors::EscrowError;

/// One hundred percent, in basis points.
pub const BPS: u16 = 10_000;
pub const SECONDS_PER_DAY: i64 = 86_400;

/// One of the two parties. Stored as one byte: buyer 0, seller 1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buyer,
    Seller,
}

/// The optional timer, as `create` takes it: this many whole days after the funding is marked,
/// anyone may send everything to `to`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timer {
    pub days: u16,
    pub to: Side,
}

/// Where an escrow is. `Ended` is stored too: an ended escrow's account is never closed, so its
/// address is a permanent receipt that holds the final state and can never be reused.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Created; the funding has not been marked. The deposit account may already hold the amount.
    Open,
    /// `mark_funded` saw the deposit account holding the amount, at `funded_at`.
    Funded,
    /// Paid out. `outcome`, `ended_at`, `to_seller` and `to_buyer` say how. Nothing more happens
    /// to it but late money going back to the buyer and rent above the minimum to the rent payer.
    Ended,
}

/// How an escrow ended: in the account once it has, and in the `Ended` event.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The buyer signed: everything to the seller.
    ReleasedToSeller,
    /// The seller signed: everything to the buyer.
    ReleasedToBuyer,
    /// Both signed a split.
    Split,
    /// The arbiter named at creation signed a split.
    Arbitrated,
    /// The timer set at creation was due, and someone sent everything to the side it names.
    TimerReleased,
}

/// One escrow. Address: `["escrow", buyer, id]`. Never closed once it has ended: its deposit
/// account closes and its rent goes back, and this account stays as the receipt. Only an escrow
/// that never held the amount is closed (`close_unfunded`).
#[account]
pub struct Escrow {
    /// `crate::VERSION`. A v2 is a new program; this says which program's rules a record followed.
    pub version: u8,
    /// Chosen at creation, so one buyer can hold many escrows. The app picks it at random.
    pub id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    /// The zero key when no arbiter was named.
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    /// The deposit account: this escrow's associated token account for `mint`. Derivable from
    /// the escrow address alone, and recorded so a reader need not derive it.
    pub vault: Pubkey,
    /// Who paid the creation rent. The deposit account's rent goes back here at the end; the
    /// escrow account's stays in the receipt, unless the escrow never held the amount.
    pub rent_payer: Pubkey,
    /// The agreed amount, in the mint's base units. The escrow is funded once the deposit account
    /// holds at least this much; every way out then pays out the whole balance, whatever it is.
    pub amount: u64,
    /// Who opened it: the buyer, or the seller (an invoice).
    pub creator: Side,
    /// The timer's days, or 0 for no timer.
    pub timer_days: u16,
    /// The side the timer pays. Meaningless when `timer_days` is 0, and then stored as `Buyer`.
    pub timer_to: Side,
    pub created_at: i64,
    /// When `mark_funded` saw the deposit account holding the amount, or 0. The timer counts from
    /// here and from nothing else.
    pub funded_at: i64,
    pub status: Status,
    pub bump: u8,
    /// When it ended, or 0 while it has not.
    pub ended_at: i64,
    /// How it ended. Meaningful only when `status` is `Ended`; stored as 0 before.
    pub outcome: Outcome,
    /// What the seller and the buyer were paid at the end. `to_seller + to_buyer` is what the
    /// deposit account held. Zero before the end.
    pub to_seller: u64,
    pub to_buyer: u64,
}

impl Escrow {
    /// version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137,
    /// vault 137..169, rent_payer 169..201, amount 201..209, creator 209, timer_days 210..212,
    /// timer_to 212, created_at 213..221, funded_at 221..229, status 229, bump 230,
    /// ended_at 231..239, outcome 239, to_seller 240..248, to_buyer 248..256.
    pub const LEN: usize = 1 + 8 + 32 * 6 + 8 + 1 + 2 + 1 + 8 + 8 + 1 + 1 + 8 + 1 + 8 + 8;

    pub fn has_arbiter(&self) -> bool {
        self.arbiter != Pubkey::default()
    }

    pub fn has_timer(&self) -> bool {
        self.timer_days != 0
    }

    /// Open or funded: the only states any way out, `mark_funded` or `close_unfunded` runs from.
    /// An allowlist, so a state added later is refused by default.
    pub fn live(&self) -> bool {
        matches!(self.status, Status::Open | Status::Funded)
    }

    /// The buyer's refund address: the buyer's associated token account for the mint, the one
    /// account any payout to the buyer lands in. Computed from two keys fixed at creation, so
    /// nothing more is stored, and nobody who sends an instruction can name another.
    pub fn refund_address(&self) -> Pubkey {
        anchor_spl::associated_token::get_associated_token_address(&self.buyer, &self.mint)
    }

    /// When the timer is due: `timer_days` whole days after the funding was marked. `None` with no
    /// timer or unless the status is `Funded`. The one time gate in the program. It reads the
    /// status, never a zero `funded_at`, to tell whether the funding was marked.
    pub fn timer_due(&self) -> Result<Option<i64>> {
        if !self.has_timer() || self.status != Status::Funded {
            return Ok(None);
        }
        let due = self
            .funded_at
            .checked_add(i64::from(self.timer_days) * SECONDS_PER_DAY)
            .ok_or_else(|| error!(EscrowError::TimeOverflow))?;
        Ok(Some(due))
    }
}

/// `amount × bps / 10,000`, rounded down, in 128 bits so nothing overflows. `bps` is at most
/// 10,000 (checked by every caller), so the result is at most `amount` and fits back in 64 bits.
pub fn share(amount: u64, bps: u16) -> u64 {
    ((u128::from(amount) * u128::from(bps)) / u128::from(BPS)) as u64
}

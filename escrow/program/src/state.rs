//! The one account, and the size it keeps forever.
//!
//! The layout is sealed with the program: clients and indexes read these bytes for as long as
//! the program lives. Nothing may grow, shrink or be reordered in v1.

use anchor_lang::prelude::*;

use crate::errors::EscrowError;

/// How many cancellation steps an escrow can hold.
pub const MAX_STEPS: usize = 4;
/// One hundred percent, in basis points.
pub const BPS: u16 = 10_000;
pub const SECONDS_PER_DAY: i64 = 86_400;
/// How long after the funding was observed an escrow with no steps, which the seller never
/// accepted, waits before anyone may send everything back to the buyer (`close_unaccepted`).
pub const UNACCEPTED_DAYS: i64 = 30;

/// One cancellation step: until `offset` seconds from the clock start, the buyer alone can cancel
/// and gets `refund_bps` of the amount back. Negative offsets are deadlines before the clock start
/// ("until a day before the session"); positive ones are after it ("within a day of funding").
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub offset: i64,
    pub refund_bps: u16,
}

/// Where an escrow is. Stored, and `Ended` included: an ended escrow's account is never closed,
/// so its address is a permanent receipt that holds the final state and can never be reused.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Created by the buyer; the seller has not accepted. The deposit account may already hold
    /// money, and its funding may already be observed (`funded_at`): only a full approval, the
    /// buyer's withdrawal, or `close_unaccepted` after its timeout can end it then.
    Open,
    /// The seller accepted (`accepted_at` is set); the funding has not been observed yet.
    Accepted,
    /// Accepted, and observed holding the amount (`funded_at` is set).
    Funded,
    /// The buyer objected before silence released. Only agreement, the arbiter, or the seller
    /// giving everything back can end it.
    Locked,
    /// Paid out. `outcome`, `ended_at`, `to_seller` and `to_buyer` say how. Nothing more happens.
    Ended,
}

/// How an escrow ended: in the account once it has, and in the `Ended` event.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Approved,
    ReleasedBySilence,
    Agreed,
    Arbitrated,
    CancelledByBuyer,
    CancelledBySeller,
    /// The buyer took everything back before the seller accepted.
    Withdrawn,
    /// The seller never accepted, and after its timeout anyone sent everything back to the buyer
    /// (`close_unaccepted`). Appended in session 12, so every other outcome keeps its byte.
    NeverAccepted,
}

/// One escrow. Address: `["escrow", buyer, id]`. Never closed once it has held the amount: when
/// it ends, the deposit account closes and its rent goes back, and this account stays as the receipt.
/// Only an escrow that never held the amount is closed (`close_unfunded`).
#[account]
pub struct Escrow {
    /// `crate::VERSION`. A v2 is a new program; this says which program's rules a record followed.
    pub version: u8,
    /// Chosen by the buyer's app at creation, so one buyer can hold many escrows. Random.
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
    /// escrow account's stays in the receipt, unless it never held the amount.
    pub rent_payer: Pubkey,
    pub amount: u64,
    /// Unix seconds, or 0 when none. When set, the clock starts here.
    pub service_time: i64,
    pub silence_days: u16,
    pub step_count: u8,
    /// The first `step_count` are the steps, offsets strictly rising. The rest are zero.
    pub steps: [Step; MAX_STEPS],
    pub created_at: i64,
    /// When the deposit account was first observed holding the amount, or 0. It may be observed
    /// before the seller accepts. The clock never starts before it.
    pub funded_at: i64,
    pub status: Status,
    pub bump: u8,
    /// When the seller accepted, or 0. An escrow the seller created (an invoice) is accepted at
    /// creation. Appended after `bump`, with the four below it, so every offset before it is the
    /// one session 8 pinned.
    pub accepted_at: i64,
    /// When it ended, or 0 while it has not.
    pub ended_at: i64,
    /// How it ended. Meaningful only when `status` is `Ended`; zero before.
    pub outcome: Outcome,
    /// What the seller and the buyer were paid at the end. `to_seller + to_buyer` is what the
    /// deposit account held. Zero before the end.
    pub to_seller: u64,
    pub to_buyer: u64,
}

impl Escrow {
    /// version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137,
    /// vault 137..169, rent_payer 169..201, amount 201..209, service_time 209..217,
    /// silence_days 217..219, step_count 219, steps 220..260 (four of offset 8, refund_bps 2),
    /// created_at 260..268, funded_at 268..276, status 276, bump 277, accepted_at 278..286,
    /// ended_at 286..294, outcome 294, to_seller 295..303, to_buyer 303..311.
    pub const LEN: usize = 1 + 8 + 32 * 6 + 8 + 8 + 2 + 1 + MAX_STEPS * 10 + 8 + 8 + 1 + 1 + 8 + 8 + 1 + 8 + 8;

    pub fn has_arbiter(&self) -> bool {
        self.arbiter != Pubkey::default()
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps[..self.step_count as usize]
    }

    pub fn accepted(&self) -> bool {
        self.accepted_at != 0
    }

    pub fn ended(&self) -> bool {
        self.status == Status::Ended
    }

    /// The buyer's refund address: the buyer's associated token account for the mint, the one
    /// account every ending pays the buyer at. Computed from two keys fixed at creation, so nothing
    /// more is stored, and nobody who sends an ending can name another.
    pub fn refund_address(&self) -> Pubkey {
        anchor_spl::associated_token::get_associated_token_address(&self.buyer, &self.mint)
    }

    /// The clock start: the latest of the service time (if set), the observed funding and the
    /// seller's acceptance. `None` until the seller has accepted and the funding has been
    /// observed. Silence and every cancellation deadline are measured from here.
    ///
    /// Funding always counts, and so does the acceptance: an old invoice paid late, or an escrow a
    /// seller accepts late, cannot find the silence already over. The buyer always has the whole
    /// silence period after the money landed and after the seller committed in which to object.
    pub fn clock_start(&self) -> Option<i64> {
        if !self.accepted() || self.funded_at == 0 {
            return None;
        }
        Some(self.service_time.max(self.funded_at).max(self.accepted_at))
    }

    /// When an escrow the seller never accepted may be sent back to the buyer by anyone
    /// (`close_unaccepted`): after its last cancellation deadline, measured from the clock start
    /// as it would stand without the acceptance (the later of the service time and the observed
    /// funding), or `UNACCEPTED_DAYS` after the observed funding when it has no steps. `None`
    /// until the funding has been observed.
    pub fn unaccepted_timeout(&self) -> Result<Option<i64>> {
        if self.funded_at == 0 {
            return Ok(None);
        }
        match self.last_deadline(self.service_time.max(self.funded_at))? {
            Some(deadline) => Ok(Some(deadline)),
            None => Ok(Some(
                self.funded_at
                    .checked_add(UNACCEPTED_DAYS * SECONDS_PER_DAY)
                    .ok_or_else(|| error!(EscrowError::TimeOverflow))?,
            )),
        }
    }

    /// The reference a never-funded escrow's deadlines are measured from: the service time if
    /// set, else creation. Only `close_unfunded` uses it, and only for the rent payer's wait.
    pub fn unfunded_reference(&self) -> i64 {
        if self.service_time != 0 {
            self.service_time
        } else {
            self.created_at
        }
    }

    pub fn silence_ends(&self, start: i64) -> Result<i64> {
        start
            .checked_add(i64::from(self.silence_days) * SECONDS_PER_DAY)
            .ok_or_else(|| error!(EscrowError::TimeOverflow))
    }

    /// The step in force at `now`: the first whose deadline is still ahead. `None` after the
    /// last deadline, or when there are no steps.
    pub fn current_step(&self, start: i64, now: i64) -> Result<Option<(u8, Step)>> {
        for (i, step) in self.steps().iter().enumerate() {
            let deadline = start
                .checked_add(step.offset)
                .ok_or_else(|| error!(EscrowError::TimeOverflow))?;
            if now < deadline {
                return Ok(Some((i as u8, *step)));
            }
        }
        Ok(None)
    }

    /// The last deadline, or `None` when there are no steps.
    pub fn last_deadline(&self, start: i64) -> Result<Option<i64>> {
        match self.steps().last() {
            Some(step) => Ok(Some(
                start
                    .checked_add(step.offset)
                    .ok_or_else(|| error!(EscrowError::TimeOverflow))?,
            )),
            None => Ok(None),
        }
    }
}

/// `amount × bps / 10,000`, rounded down.
pub fn share(amount: u64, bps: u16) -> u64 {
    ((u128::from(amount) * u128::from(bps)) / u128::from(BPS)) as u64
}

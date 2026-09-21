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

/// One cancellation step: until `offset` seconds from the clock start, the buyer alone can cancel
/// and gets `refund_bps` of the amount back. Negative offsets are deadlines before the clock start
/// ("until a day before the session"); positive ones are after it ("within a day of funding").
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub offset: i64,
    pub refund_bps: u16,
}

/// Where an escrow is. `Ended` is never stored: the account is closed when the escrow ends and
/// the outcome lives in the `Closed` event. It is here so the four states have their numbers.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Created; the deposit account has not been observed holding the amount.
    Open,
    /// Observed holding the amount (`funded_at` is set).
    Funded,
    /// The buyer objected before silence released. Only agreement, the arbiter, or the seller
    /// giving everything back can end it.
    Locked,
    Ended,
}

/// How an escrow ended, in the `Closed` event.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Approved,
    ReleasedBySilence,
    Agreed,
    Arbitrated,
    CancelledByBuyer,
    CancelledBySeller,
    /// Closed without ever holding the amount. Whatever the deposit account held went back to
    /// the buyer.
    NeverFunded,
}

/// One escrow. Address: `["escrow", buyer, id]`. Closed, and its rent returned, when it ends.
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
    /// Who paid the creation rent; both accounts' rent goes back here at the end.
    pub rent_payer: Pubkey,
    pub amount: u64,
    /// Unix seconds, or 0 when none. When set, the clock starts here.
    pub service_time: i64,
    pub silence_days: u16,
    pub step_count: u8,
    /// The first `step_count` are the steps, offsets strictly rising. The rest are zero.
    pub steps: [Step; MAX_STEPS],
    pub created_at: i64,
    /// When the deposit account was first observed holding the amount, or 0. When there is no
    /// service time, the clock starts here.
    pub funded_at: i64,
    pub status: Status,
    pub bump: u8,
}

impl Escrow {
    /// version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137,
    /// vault 137..169, rent_payer 169..201, amount 201..209, service_time 209..217,
    /// silence_days 217..219, step_count 219, steps 220..260 (four of offset 8, refund_bps 2),
    /// created_at 260..268, funded_at 268..276, status 276, bump 277.
    pub const LEN: usize = 1 + 8 + 32 * 6 + 8 + 8 + 2 + 1 + MAX_STEPS * 10 + 8 + 8 + 1 + 1;

    pub fn has_arbiter(&self) -> bool {
        self.arbiter != Pubkey::default()
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps[..self.step_count as usize]
    }

    /// The clock start: the service time if set, else the observed funding time, else none yet.
    /// Silence and every cancellation deadline are measured from here.
    pub fn clock_start(&self) -> Option<i64> {
        if self.service_time != 0 {
            Some(self.service_time)
        } else if self.funded_at != 0 {
            Some(self.funded_at)
        } else {
            None
        }
    }

    /// The reference a never-funded escrow's deadlines are measured from: the service time if
    /// set, else creation. Only `close` uses it, and only for the buyer's wait.
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

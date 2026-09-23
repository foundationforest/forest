use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("the buyer and the seller must be different keys")]
    SameParty,
    #[msg("the arbiter cannot be the buyer or the seller")]
    ArbiterIsAParty,
    #[msg("a party cannot be the zero key")]
    EmptyKey,
    #[msg("the amount must be above zero")]
    AmountZero,
    #[msg("silence days must be above zero")]
    SilenceZero,
    #[msg("a service time must be a positive unix time")]
    BadServiceTime,
    #[msg("an escrow holds at most four cancellation steps")]
    TooManySteps,
    #[msg("cancellation steps must have strictly rising deadlines")]
    StepsUnsorted,
    #[msg("a refund is between 0 and 10,000 basis points")]
    StepOverHundred,
    #[msg("a split is between 0 and 10,000 basis points")]
    BadSplit,
    #[msg("the deposit account holds less than the amount")]
    NotFunded,
    #[msg("the deposit account already holds the amount; this escrow ends by approval, silence, agreement, the arbiter, cancellation or the buyer's withdrawal")]
    StillFunded,
    #[msg("the funding was already observed")]
    AlreadyFunded,
    #[msg("the escrow is locked by an objection; only agreement or the arbiter can end it")]
    Locked,
    #[msg("the clock has not started: no service time, and the funding has not been observed (send mark_funded)")]
    ClockNotStarted,
    #[msg("the silence period has not ended")]
    SilenceNotOver,
    #[msg("the silence period has ended; it is too late to object")]
    SilenceOver,
    #[msg("the last cancellation deadline has passed; the buyer cannot cancel alone")]
    AfterLastDeadline,
    #[msg("the last cancellation deadline has not passed; the rent payer cannot close yet")]
    BeforeLastDeadline,
    #[msg("no arbiter was named at creation")]
    NoArbiter,
    #[msg("only the arbiter named at creation can arbitrate")]
    NotTheArbiter,
    #[msg("only the buyer can do this")]
    NotTheBuyer,
    #[msg("only the seller can do this")]
    NotTheSeller,
    #[msg("only the buyer or the seller can do this")]
    NotAParty,
    #[msg("a deadline does not fit in a unix time")]
    TimeOverflow,
    #[msg("the seller has not accepted: only a full approval or the buyer's withdrawal can end it")]
    NotAccepted,
    #[msg("the seller has already accepted")]
    AlreadyAccepted,
    #[msg("this escrow has ended; its account is the receipt and nothing more happens to it")]
    Ended,
    #[msg("wrapped SOL is not accepted: a plain SOL transfer to its deposit account would not count")]
    NativeMint,
    #[msg("only the buyer, the seller, or the rent payer after the last deadline can close an escrow that never held the amount")]
    NotACloser,
}

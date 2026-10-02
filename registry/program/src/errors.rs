use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("the label is longer than 128 bytes")]
    LabelTooLong,
    #[msg("a value that must be a BN254 field element is not one")]
    NotAFieldElement,
    #[msg("the proof's points are not a valid compressed BN254 proof")]
    ProofMalformed,
    #[msg("the proof does not verify for this root, market stamp, label and profile")]
    ProofRejected,
    #[msg("the row holds nothing above its rent-exempt minimum")]
    NothingToRefund,
    #[msg("a refund goes only to the payer the row records")]
    NotThePayer,
}

use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("the label is longer than 128 bytes")]
    LabelTooLong,
    #[msg("a value that must be a BN254 field element is not one")]
    NotAFieldElement,
    #[msg("the proof's points are not a valid compressed BN254 proof")]
    ProofMalformed,
    #[msg("the proof does not verify for this root, code, label and profile")]
    ProofRejected,
    #[msg("this root is already in the line")]
    RootAlreadyInLine,
    #[msg("the line already holds 16 roots")]
    LineFull,
    #[msg("the line holds nothing above its rent-exempt minimum")]
    NothingToRefund,
    #[msg("a refund goes only to the payer the line records")]
    NotThePayer,
}

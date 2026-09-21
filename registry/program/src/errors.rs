use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("the market name must be between 1 and 64 bytes")]
    MarketNameLength,
    #[msg("the DID must be between 1 and 64 bytes")]
    DidLength,
    #[msg("a value that must be a BN254 field element is not one")]
    NotAFieldElement,
    #[msg("the root is not one of this list's last 128")]
    RootNotRecent,
    #[msg("the proof's points are not a valid compressed BN254 proof")]
    ProofMalformed,
    #[msg("the proof does not verify against this list's root, this market and this DID")]
    ProofRejected,
    #[msg("the Poseidon syscall rejected its inputs")]
    HashFailed,
    #[msg("the tree is full at depth 32")]
    TreeFull,
    #[msg("this key may not insert into this list")]
    NotAnIssuer,
    #[msg("this list already holds the most issuers it can")]
    TooManyIssuers,
    #[msg("this key is already an issuer of this list")]
    IssuerAlreadyAdded,
    #[msg("this key is not an issuer of this list")]
    IssuerNotFound,
    #[msg("the registry already accepts the most mints it can")]
    TooManyMints,
    #[msg("the registry already accepts this mint")]
    MintAlreadyAccepted,
    #[msg("the registry does not accept this mint")]
    MintNotAccepted,
    #[msg("the two token accounts are for different mints")]
    MintMismatch,
    #[msg("the fee would move from an account to itself")]
    FeeGoesNowhere,
    #[msg("0.25 of this mint is not a whole number of base units that fits: it needs 2 to 19 decimals")]
    WrongDecimals,
    #[msg("the treasury cannot be the zero key")]
    TreasuryEmpty,
    #[msg("the new treasury is the current one")]
    TreasuryUnchanged,
    #[msg("the list index does not match the list account")]
    WrongList,
    #[msg("the account passed is not the registry account the target names")]
    WrongSweepTarget,
    #[msg("there is nothing above the rent-exempt minimum to sweep")]
    NothingToSweep,
}

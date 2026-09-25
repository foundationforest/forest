use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("the market name must be between 1 and 256 bytes")]
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
    #[msg("the USDC mint must count in six decimals, so that its fixed fee of 250,000 base units is 0.25")]
    WrongDecimals,
    #[msg("the treasury cannot be the zero key")]
    TreasuryEmpty,
    #[msg("the new treasury is the current one")]
    TreasuryUnchanged,
    #[msg("no treasury handover has been proposed")]
    NoPendingTreasury,
    #[msg("only the proposed treasury key can accept the handover")]
    NotThePendingTreasury,
    #[msg("the list index does not match the list account")]
    WrongList,
    #[msg("the account passed is not the registry account the target names")]
    WrongSweepTarget,
    #[msg("there is nothing above the rent-exempt minimum to sweep")]
    NothingToSweep,
    #[msg("a mint's fee must be above zero: registration is never free inside the program")]
    FeeZero,
    #[msg("this list is closed to new members")]
    ListClosed,
    #[msg("only the list's owner may change its insert keys, close it or hand it over")]
    NotTheListOwner,
    #[msg("a list's owner cannot be the zero key")]
    ListOwnerEmpty,
    #[msg("the proposed key already owns this list")]
    ListOwnerUnchanged,
    #[msg("no handover of this list has been proposed")]
    NoPendingListOwner,
    #[msg("only the proposed owner can accept this list")]
    NotThePendingListOwner,
    #[msg("a list's rent goes to its owner, and any other account's to the treasury")]
    WrongSweepRecipient,
}

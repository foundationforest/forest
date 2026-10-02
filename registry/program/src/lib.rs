// ============================================================
// Program: forest_registry
// Framework: Anchor 1.2
// Testing:   LiteSVM (tests-litesvm/), a local validator, devnet
// Risk Level: 🟢 Low by the skill's table, treated as sealed
// Author: Frank Castle Security Template (safe-solana-builder)
// Security: See ../security-checklist.md
// ============================================================

//! The Forest registry: one row per market stamp.
//!
//! A keeper keeps a list of stamps (the issuer keeps the human list) and signs each snapshot of
//! it: an ed25519 signature over the list's root. A person's stamp on a list comes from their
//! seed and the keeper's address. Their market stamp is the Semaphore nullifier with the label as
//! scope: the same for one person on one list under one label, and unguessable for anyone else.
//!
//! A row says: this profile holds a stamp on this keeper's list, under this label, proven against
//! this root, which the keeper signed. The row sits at the address derived from the market stamp,
//! so one person gets at most one row per keeper per label. The program verifies the proof and
//! requires the profile's signature. It stores the keeper's signature without checking it, and
//! checks no root and no keeper: readers decide which keepers they trust and check their
//! signatures.
//!
//! There is no fee, no token, no treasury, no admin and no list in the program. The only costs are
//! Solana's own, paid by whoever sends the transaction. A row is written once and never changes.
//!
//! This program is sealed per version on mainnet: the upgrade authority is removed at deploy, so
//! nothing here can be patched there. Read `registry/README.md`. Nothing is in production.

use anchor_lang::prelude::*;

pub mod errors;
pub mod proof;
pub mod state;
pub mod verifying_key;

use errors::RegistryError;
use state::*;

declare_id!("FoRRegistryRowsFreeNoFeeNoAdmin1111111111111");

/// The longest label a row can carry, in bytes. The recommended shape is `market/role`; the
/// program does not care what the text says.
pub const MAX_LABEL: usize = 128;

/// The scope is a hash of the namespaced label, so a label of any text works and a scope from one
/// namespace can never collide with one from another.
pub const SCOPE_NS: &[u8] = b"forest.foundation/label/v1/";
/// The message is a hash of the namespaced profile key: what binds a proof to one profile.
pub const MESSAGE_NS: &[u8] = b"forest.foundation/profile/v1/";

/// A row's address: `[ROW_SEED, market stamp]`.
pub const ROW_SEED: &[u8] = b"row";

/// `keccak256(namespace || parts...) >> 8`, the way Semaphore's proof package turns a value into a
/// field element. The shift by one byte is what keeps the result below BN254's scalar order.
pub fn field_hash(namespace: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut input: Vec<&[u8]> = Vec::with_capacity(parts.len() + 1);
    input.push(namespace);
    input.extend_from_slice(parts);
    let h = solana_keccak_hasher::hashv(&input).to_bytes();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&h[..31]);
    out
}

/// The proof's scope: what makes a proof count for one label and no other.
pub fn scope_of(label: &str) -> [u8; 32] {
    field_hash(SCOPE_NS, &[label.as_bytes()])
}

/// The proof's message: what makes a proof count for one profile and no other.
pub fn message_of(profile: &Pubkey) -> [u8; 32] {
    field_hash(MESSAGE_NS, &[profile.as_ref()])
}

#[program]
pub mod forest_registry {
    use super::*;

    /// Write one row: this profile holds a stamp on this keeper's list, under this label, proven
    /// against this root. The row is never written again.
    ///
    /// The profile signs, so nobody can put a row on a profile but its holder. The program derives
    /// the scope from the label and the message from the profile, and verifies the proof with
    /// public inputs [root, market stamp, message, scope]. So the proof counts for this label, this
    /// profile and this market stamp and no other: a proof seen in flight cannot land under another
    /// profile. The root, the keeper and the keeper's signature are stored as given. The row's
    /// address is derived from the market stamp, and `init` refuses a second row for it.
    ///
    /// Anyone may pay. Whoever signs as payer pays the row's deposit and is recorded, so a refund
    /// can find them.
    pub fn register(ctx: Context<Register>, args: RegisterArgs) -> Result<()> {
        require!(args.label.len() <= MAX_LABEL, RegistryError::LabelTooLong);

        let profile = ctx.accounts.profile.key();
        let scope = scope_of(&args.label);
        let message = message_of(&profile);
        let p = &args.proof;
        proof::verify(&p.a, &p.b, &p.c, &[args.root, args.market_stamp, message, scope])?;

        let row = &mut ctx.accounts.row;
        row.profile = profile;
        row.keeper = args.keeper;
        row.root = args.root;
        row.keeper_signature = args.keeper_signature;
        row.payer = ctx.accounts.payer.key();
        row.bump = ctx.bumps.row;
        row.label = args.label;
        Ok(())
    }

    /// Move whatever a row holds above its rent-exempt minimum to the payer the row records.
    ///
    /// Solana is cutting the rent rate in steps, and only the owning program can move the
    /// difference out of its accounts, so a sealed program without this would lock it away. Anyone
    /// may send it: the amount and the destination are read from the chain, never from the caller.
    /// The row's data is untouched and it stays exactly rent exempt. It never closes: its
    /// existence is the one-row-per-market-stamp rule.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let row = ctx.accounts.row.to_account_info();
        // The rate is read at runtime, every time: the rate changing is why this exists.
        let minimum = Rent::get()?.minimum_balance(row.data_len());
        let excess = row.lamports().saturating_sub(minimum);
        require!(excess > 0, RegistryError::NothingToRefund);

        row.sub_lamports(excess)?;
        ctx.accounts.payer.add_lamports(excess)?;
        require_eq!(row.lamports(), minimum, RegistryError::NothingToRefund);
        Ok(())
    }
}

/// One Semaphore proof, its points compressed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedProof {
    pub a: [u8; 32],
    pub b: [u8; 64],
    pub c: [u8; 32],
}

/// What `register` carries. Sealed: clients build these bytes forever. Every fixed field comes
/// first; the label, the one of variable length, is last.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterArgs {
    /// The proof's nullifier, `Poseidon(scope, secret)`: the row's address comes from it.
    pub market_stamp: [u8; 32],
    /// The keeper's ed25519 key. Stored as given.
    pub keeper: Pubkey,
    /// The root of the keeper's list the proof was made against. Taken as given.
    pub root: [u8; 32],
    /// The keeper's ed25519 signature over the root's 32 big-endian bytes. Stored, never checked.
    pub keeper_signature: [u8; 64],
    pub proof: CompressedProof,
    /// Free text. Hashed into the scope.
    pub label: String,
}

#[derive(Accounts)]
#[instruction(args: RegisterArgs)]
pub struct Register<'info> {
    /// Fails if it already exists. That failure is "one row per market stamp".
    #[account(
        init,
        payer = payer,
        space = Row::space(args.label.len()),
        seeds = [ROW_SEED, args.market_stamp.as_ref()],
        bump
    )]
    pub row: Account<'info, Row>,
    /// The profile the row names: its ed25519 key, which signs.
    pub profile: Signer<'info>,
    /// Pays the deposit and is recorded in the row. Anyone, the profile included.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Any row. `Account` checks it is this program's and a `Row`; only `register` makes those,
    /// and only at a market stamp's address, so no seeds are needed to know it is one.
    #[account(mut, has_one = payer @ RegistryError::NotThePayer)]
    pub row: Account<'info, Row>,
    /// CHECK: `has_one` requires it to be the payer the row records. It only ever receives lamports.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

/// Compile-time proof that the sealed sizes are what this file says they are.
const _: () = {
    assert!(Row::FIXED == 193);
    assert!(Row::space(0) == 205);
    assert!(Row::space(MAX_LABEL) == 333);
};

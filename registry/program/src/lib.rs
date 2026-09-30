// ============================================================
// Program: forest_registry
// Framework: Anchor 1.2
// Testing:   LiteSVM (tests-litesvm/), a local validator, devnet
// Risk Level: 🟢 Low by the skill's table, treated as sealed
// Author: Frank Castle Security Template (safe-solana-builder)
// Security: See ../security-checklist.md
// ============================================================

//! The Forest registry: a free public list of badges.
//!
//! A badge is one line: this profile is one verified human under this label, proven against one
//! issuer's list. Nothing else lives in the program. There is no fee, no token, no treasury, no
//! admin and no list: the only costs are Solana's own, paid by whoever sends the transaction.
//!
//! A line sits at the address derived from its code, the Semaphore proof's nullifier, so one
//! human (one identity secret) has at most one line per label. The proof is made against an
//! issuer's list; the list lives with the issuer, and its root is an input the program does not
//! check. Readers decide which roots they trust.
//!
//! A line is written once, by `register`, and never grows and never changes. More issuers live
//! off chain: the person proves membership in another issuer's list for the same label and
//! profile, and keeps that proof in the profile's folder, where readers check it against the
//! line's code and the issuer's published roots.
//!
//! The proof is the consent. Its message is the profile key, so only the holder of the identity
//! secret can make one, and a proof can only ever create that profile's own line under that
//! label. So nobody's signature is asked but the payer's, and anyone may send either instruction
//! here: the person, an app, a relayer.
//!
//! This program is sealed per version. The upgrade authority is removed at deploy, so nothing
//! here can be patched: read `registry/README.md`. Nothing is shipped.

use anchor_lang::prelude::*;

pub mod errors;
pub mod proof;
pub mod state;
pub mod verifying_key;

use errors::RegistryError;
use state::*;

declare_id!("FoRBadgeLineFreeNoFeeNoAdmin1111111111111111");

/// The longest label a line can carry, in bytes. Our convention is `market/role`; the program
/// does not care what the text says.
pub const MAX_LABEL: usize = 128;

/// The scope is a hash of the namespaced label, so a label of any text works and a scope from one
/// namespace can never collide with one from another.
pub const SCOPE_NS: &[u8] = b"forest.foundation/label/v1/";
/// The message is a hash of the namespaced profile key: what binds a proof to one profile.
pub const MESSAGE_NS: &[u8] = b"forest.foundation/profile/v1/";

/// A line's address: `[CODE_SEED, code]`.
pub const CODE_SEED: &[u8] = b"code";

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

    /// Write one line: this profile is one verified human under this label, proven against the
    /// list this proof was made against. The line is never written again.
    ///
    /// The program derives the scope from the label and the message from the profile, and verifies
    /// the proof with public inputs [root, code, message, scope]. So the proof counts for this
    /// label, this profile and this code and no other, and only the holder of the identity secret
    /// could have made it. The root is taken as given. The line's address is derived from the code,
    /// and `init` refuses a second line for the same code: one line per human per label.
    ///
    /// Anyone may send it. Whoever signs as payer pays the line's deposit and is recorded, so a
    /// refund can find them.
    pub fn register(ctx: Context<Register>, args: RegisterArgs) -> Result<()> {
        require!(args.label.len() <= MAX_LABEL, RegistryError::LabelTooLong);

        let scope = scope_of(&args.label);
        let message = message_of(&args.profile);
        let p = &args.proof;
        proof::verify(&p.a, &p.b, &p.c, &[p.root, args.code, message, scope])?;

        let line = &mut ctx.accounts.line;
        line.profile = args.profile;
        line.code = args.code;
        line.payer = ctx.accounts.payer.key();
        line.time = Clock::get()?.unix_timestamp;
        line.bump = ctx.bumps.line;
        line.root = p.root;
        line.label = args.label;
        Ok(())
    }

    /// Move whatever a line holds above its rent-exempt minimum to the payer the line records.
    ///
    /// Solana is cutting the rent rate in steps, and only the owning program can move the
    /// difference out of its accounts, so a sealed program without this would lock it away. Anyone
    /// may send it: the amount and the destination are read from the chain, never from the caller.
    /// The line's data is untouched and it stays exactly rent exempt. It never closes: its
    /// existence is the one-line-per-code rule.
    pub fn refund(ctx: Context<Refund>, _code: [u8; 32]) -> Result<()> {
        let line = ctx.accounts.line.to_account_info();
        // The rate is read at runtime, every time: the rate changing is why this exists.
        let minimum = Rent::get()?.minimum_balance(line.data_len());
        let excess = line.lamports().saturating_sub(minimum);
        require!(excess > 0, RegistryError::NothingToRefund);

        line.sub_lamports(excess)?;
        ctx.accounts.payer.add_lamports(excess)?;
        require_eq!(line.lamports(), minimum, RegistryError::NothingToRefund);
        Ok(())
    }
}

/// One Semaphore proof, its points compressed, and the root of the list it was made against.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MembershipProof {
    /// The issuer's list's root when the proof was made. Taken as given.
    pub root: [u8; 32],
    pub a: [u8; 32],
    pub b: [u8; 64],
    pub c: [u8; 32],
}

/// What `register` carries. Sealed: clients build these bytes forever.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterArgs {
    /// The profile's 32-byte ed25519 key: its did:key name and its wallet. Hashed into the message.
    pub profile: Pubkey,
    /// Free text. Hashed into the scope.
    pub label: String,
    /// The proof's nullifier, `Poseidon(scope, secret)`: the line's address comes from it.
    pub code: [u8; 32],
    pub proof: MembershipProof,
}

#[derive(Accounts)]
#[instruction(args: RegisterArgs)]
pub struct Register<'info> {
    /// Fails if it already exists. That failure is "one line per human per label".
    #[account(
        init,
        payer = payer,
        space = Line::space(args.label.len()),
        seeds = [CODE_SEED, args.code.as_ref()],
        bump
    )]
    pub line: Account<'info, Line>,
    /// Pays the deposit and the network fee, and is recorded in the line. Anyone.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(code: [u8; 32])]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [CODE_SEED, code.as_ref()],
        bump = line.bump,
        has_one = payer @ RegistryError::NotThePayer,
    )]
    pub line: Account<'info, Line>,
    /// CHECK: `has_one` requires it to be the payer the line records. It only ever receives lamports.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

/// Compile-time proof that the sealed sizes are what this file says they are.
const _: () = {
    assert!(Line::FIXED == 137);
    assert!(Line::space(0) == 149);
    assert!(Line::space(MAX_LABEL) == 277);
};

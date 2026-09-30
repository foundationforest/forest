//! The one account, and the layout it keeps forever.
//!
//! Sealed with the program: clients and indexes read these bytes for as long as the program
//! lives. Nothing may be added, removed or reordered in this version.

use anchor_lang::prelude::*;

/// One badge: this profile is one verified human under this label, proven against this root.
///
/// At `[CODE_SEED, code]`. Borsh, as Anchor writes it after the 8-byte discriminator:
///
/// | offset | bytes | field |
/// |---|---|---|
/// | 8 | 32 | profile |
/// | 40 | 32 | code |
/// | 72 | 32 | payer |
/// | 104 | 8 | time, i64 little-endian |
/// | 112 | 1 | bump |
/// | 113 | 32 | root |
/// | 145 | 4 + n | label: u32 length, then UTF-8 |
///
/// Every fixed field comes first, so each sits at a fixed offset; the label, the one of variable
/// length, is last. Sized exactly, `space(label)`, at `register`, and never written again: a line
/// never grows and never changes. It never closes either: its existence is the one-line-per-code
/// rule.
#[account]
pub struct Line {
    /// The profile's ed25519 key: its did:key name and its Solana wallet. First, so a reader can
    /// ask for every line of one profile with one filter at offset 8.
    pub profile: Pubkey,
    /// The proof's nullifier, the same for one human under one label and unguessable for anyone
    /// else. The address is derived from it; it is stored too, so anyone reading lines can name
    /// one to `refund`, and every code can be read from the accounts alone.
    pub code: [u8; 32],
    /// Who paid the deposit at `register`. `refund` pays here and nowhere else.
    pub payer: Pubkey,
    /// When the line was written: unix seconds, from the clock sysvar.
    pub time: i64,
    /// The canonical bump of the line's address.
    pub bump: u8,
    /// The root of the issuer's list the proof was made against. The program does not check it;
    /// readers decide which roots they trust. More issuers are proofs kept off chain, in the
    /// profile's folder (`registry/README.md`).
    pub root: [u8; 32],
    /// Free text, at most `MAX_LABEL` bytes. The proof's scope is its hash.
    pub label: String,
}

impl Line {
    /// profile, code, payer, time, bump and root.
    pub const FIXED: usize = 32 + 32 + 32 + 8 + 1 + 32;

    /// The account's size, discriminator included, for a label of `label_len` bytes.
    pub const fn space(label_len: usize) -> usize {
        8 + Self::FIXED + 4 + label_len
    }
}

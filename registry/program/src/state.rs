//! The one account, and the layout it keeps forever.
//!
//! Sealed with the program: clients and indexes read these bytes for as long as the program
//! lives. Nothing may be added, removed or reordered in this version.

use anchor_lang::prelude::*;

/// One row: this profile holds a stamp on this issuer's list, under this label, proven against
/// this root.
///
/// At `[ROW_SEED, market stamp]`. Borsh, as Anchor writes it after the 8-byte discriminator:
///
/// | offset | bytes | field |
/// |---|---|---|
/// | 8 | 32 | profile |
/// | 40 | 32 | issuer |
/// | 72 | 32 | root |
/// | 104 | 64 | issuer signature |
/// | 168 | 32 | payer |
/// | 200 | 1 | bump |
/// | 201 | 4 + n | label: u32 length, then UTF-8 |
///
/// Every fixed field comes first, so each sits at a fixed offset; the label, the one of variable
/// length, is last. Sized exactly, `space(label)`, at `register`, and never written again: a row
/// never changes. It never closes either: its existence is the one-row-per-market-stamp rule.
#[account]
pub struct Row {
    /// The main key, which signed `register`: registered, it is this profile. First, so a reader
    /// can ask for every row of one profile with one filter at offset 8.
    pub profile: Pubkey,
    /// The issuer's ed25519 key, as given. Second, so a reader can ask for every row of one
    /// issuer with one filter at offset 40.
    pub issuer: Pubkey,
    /// The root of the issuer's list the proof was made against. The program does not check it.
    pub root: [u8; 32],
    /// The issuer's ed25519 signature over the root's 32 big-endian bytes. Stored as given; a
    /// reader checks it against `issuer` and `root`.
    pub issuer_signature: [u8; 64],
    /// Who paid the deposit at `register`. `refund` pays here and nowhere else.
    pub payer: Pubkey,
    /// The canonical bump of the row's address: with the market stamp, the address is one hash.
    pub bump: u8,
    /// Free text, at most `MAX_LABEL` bytes. The proof's scope is its hash.
    pub label: String,
}

impl Row {
    /// profile, issuer, root, issuer signature, payer and bump.
    pub const FIXED: usize = 32 + 32 + 32 + 64 + 32 + 1;

    /// The account's size, discriminator included, for a label of `label_len` bytes.
    pub const fn space(label_len: usize) -> usize {
        8 + Self::FIXED + 4 + label_len
    }
}

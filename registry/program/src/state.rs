//! The one account, and the layout it keeps forever.
//!
//! Sealed with the program: clients and indexes read these bytes for as long as the program
//! lives. Nothing may be added, removed or reordered in this version.

use anchor_lang::prelude::*;

/// One row: this main key holds a note from the issuer with this key, under this label, and its
/// stamp for that label is this one.
///
/// At `[ROW_SEED, stamp]`. Borsh, as Anchor writes it after the 8-byte discriminator:
///
/// | offset | bytes | field |
/// |---|---|---|
/// | 8 | 32 | profile |
/// | 40 | 32 | stamp |
/// | 72 | 64 | issuer: x, then y |
/// | 136 | 32 | payer |
/// | 168 | 8 | made |
/// | 176 | 4 + n | label: u32 length, then UTF-8 |
///
/// Every fixed field comes first, so each sits at a fixed offset; the label, the one of variable
/// length, is last. Sized exactly, `space(label)`, at `register`, and never written again: a row
/// never changes. It never closes either: its existence is the one-row-per-stamp rule. The tier
/// the proof showed is not kept: a profile shows its tier with the same proof attached to it.
#[account]
pub struct Row {
    /// The main key, which signed `register`: registered, it is this profile. First, so a reader
    /// can ask for every row of one profile with one filter at offset 8.
    pub profile: Pubkey,
    /// The proof's output, `Poseidon(scope, secret)`: the row's address comes from it, and an index
    /// reads it here.
    pub stamp: [u8; 32],
    /// The issuer's key, a point on Baby Jubjub, x then y, each 32 bytes big-endian: the key the
    /// proof shows signed the person's note. A reader asks for every row of one issuer with one
    /// filter at offset 72.
    pub issuer: [[u8; 32]; 2],
    /// Who paid the deposit at `register`. `refund` pays here and nowhere else.
    pub payer: Pubkey,
    /// When the program wrote the row: the clock's Unix time, in seconds. Never taken from the
    /// caller. A reader that stops trusting a leaked key stops counting its rows from that date.
    pub made: i64,
    /// Free text, at most `MAX_LABEL` bytes. The proof's scope is its hash.
    pub label: String,
}

impl Row {
    /// profile, stamp, issuer, payer and made.
    pub const FIXED: usize = 32 + 32 + 64 + 32 + 8;

    /// The account's size, discriminator included, for a label of `label_len` bytes.
    pub const fn space(label_len: usize) -> usize {
        8 + Self::FIXED + 4 + label_len
    }
}

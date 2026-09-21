//! The accounts, and the sizes they keep forever.
//!
//! Every layout here is sealed with the program: clients and indexes read these bytes for as
//! long as the program lives, and a code account's size is what the rent sweep measures against.
//! Nothing may grow, shrink or be reordered in v1.

use anchor_lang::prelude::*;

use crate::tree::FRONTIER_LEN;

/// How many recent roots a list keeps, so a proof made moments before someone else joins
/// still lands. Nobody is ever removed, so an old root is never a stale membership claim.
pub const ROOT_HISTORY: usize = 128;
/// How many issuer keys one list can hold.
pub const MAX_ISSUERS: usize = 8;
/// How many token mints the registry can ever accept.
pub const MAX_MINTS: usize = 16;

/// The registry's one settings account. There is exactly one, at the `config` address.
#[account]
pub struct Config {
    /// The treasury: where the 0.25 lands, where swept rent goes, and the key that signs
    /// `open_list`, `add_issuer`, `remove_issuer`, `add_token` and `propose_treasury`. Written
    /// from `crate::TREASURY` at `init`, moved only by `accept_treasury` (signed by the key it
    /// moves to), and touched by nothing else. It can never override or undo a registration. A
    /// wallet, not a token account: the destination token account in `register` must be owned by
    /// this key.
    pub treasury: Pubkey,
    /// Accepted mints. `mints[0]` is USDC, written at `init` from `crate::USDC_MINT` and never
    /// removed: nothing in this program removes a mint at all, so registration can never be
    /// halted by taking one away.
    pub mints: [Pubkey; MAX_MINTS],
    /// Each accepted mint's decimals, read off the mint account when it was accepted, at the
    /// same index as the mint. The 25-cent rule is `crate::registration_fee(decimals[i])` of
    /// `mints[i]`: 0.25 × 10^decimals, in that mint's own units.
    pub decimals: [u8; MAX_MINTS],
    pub mint_count: u8,
    /// How many identity lists have been opened. The next one gets this index.
    pub list_count: u32,
    pub bump: u8,
    /// The key the treasury has proposed to hand over to, or zero when nothing is pending.
    /// Written by `propose_treasury`, consumed and cleared by `accept_treasury`. Until the pending
    /// key signs `accept_treasury`, nothing about the treasury has moved. Appended after `bump`
    /// so the offsets of every field before it are the ones session 5 and 6 pinned.
    pub pending_treasury: Pubkey,
}

impl Config {
    pub const LEN: usize = 32 + 32 * MAX_MINTS + MAX_MINTS + 1 + 4 + 1 + 32;

    pub fn accepts(&self, mint: &Pubkey) -> bool {
        self.decimals_of(mint).is_some()
    }

    /// The decimals recorded for an accepted mint, or `None` if the mint is not accepted.
    pub fn decimals_of(&self, mint: &Pubkey) -> Option<u8> {
        let n = self.mint_count as usize;
        self.mints[..n].iter().position(|m| m == mint).map(|i| self.decimals[i])
    }
}

/// One list of verified humans: a Semaphore LeanIMT of identity commitments, depth 32.
///
/// Zero-copy, because it is 5,456 bytes and a registration only reads a small part of it.
#[account(zero_copy)]
#[repr(C)]
pub struct IdentityList {
    /// Leaves appended so far. Also the position of the next root in the ring.
    pub leaf_count: u64,
    pub index: u32,
    pub issuer_count: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    /// The current root. Zero while the list is empty, and a zero root is never accepted.
    pub root: [u8; 32],
    /// One node per level: the left node at that level still waiting for a right sibling.
    pub frontier: [[u8; 32]; FRONTIER_LEN],
    /// The last `ROOT_HISTORY` roots, written at `leaf_count % ROOT_HISTORY` before the count
    /// is raised. Unused slots are zero, and zero is never a valid root.
    pub roots: [[u8; 32]; ROOT_HISTORY],
    /// Keys that may insert into this list.
    pub issuers: [Pubkey; MAX_ISSUERS],
}

impl IdentityList {
    pub const LEN: usize = 8 + 4 + 1 + 1 + 2 + 32 + 32 * FRONTIER_LEN + 32 * ROOT_HISTORY + 32 * MAX_ISSUERS;

    pub fn is_issuer(&self, key: &Pubkey) -> bool {
        self.issuers[..self.issuer_count as usize].contains(key)
    }

    /// Record a new root in the ring. Called with `leaf_count` still at its pre-append value.
    pub fn push_root(&mut self, root: [u8; 32]) {
        self.roots[(self.leaf_count % ROOT_HISTORY as u64) as usize] = root;
        self.root = root;
        self.leaf_count += 1;
    }

    pub fn has_recent_root(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

/// Every code the registry has ever written, in arrival order.
///
/// This is option 3 of `docs/decisions/used-code-storage.md`, and the whole of what the sealed
/// program does for the later completeness proof. It is append-only, so it does not prove a code
/// is absent. What it does is commit, from inside the sealed program, to the exact set and order
/// of every code ever recorded, so the sorted structure that does prove absence can be rebuilt by
/// anyone and checked against this, instead of trusted.
#[account(zero_copy)]
#[repr(C)]
pub struct CodeTree {
    pub count: u64,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub root: [u8; 32],
    pub frontier: [[u8; 32]; FRONTIER_LEN],
}

impl CodeTree {
    pub const LEN: usize = 8 + 1 + 7 + 32 + 32 * FRONTIER_LEN;
}

/// One account per used code. Its existence is the whole of "one badge per market per human":
/// the address is a hash of the code, so nothing else can sit there, and the runtime does the
/// check for free and cannot be fooled.
///
/// Nine bytes, and never closed. Closing it would make the code reusable.
#[account]
pub struct UsedCode {
    pub bump: u8,
}

impl UsedCode {
    pub const LEN: usize = 1;
}

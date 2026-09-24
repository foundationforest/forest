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
/// How many insert keys one list can hold, its owner's own included.
pub const MAX_ISSUERS: usize = 8;
/// How many token mints the registry can ever accept.
pub const MAX_MINTS: usize = 16;

/// The registry's one settings account. There is exactly one, at the `config` address.
#[account]
pub struct Config {
    /// The treasury: where the 0.25 lands, where swept rent goes, and the key that signs
    /// `add_token` and `propose_treasury`. It has no say over any list. Written
    /// from `crate::TREASURY` at `init`, moved only by `accept_treasury` (signed by the key it
    /// moves to), and touched by nothing else. It can never override or undo a registration. A
    /// wallet, not a token account: the destination token account in `register` must be owned by
    /// this key.
    pub treasury: Pubkey,
    /// Accepted mints. `mints[0]` is USDC, written at `init` from `crate::USDC_MINT` and never
    /// removed: nothing in this program removes a mint at all, so registration can never be
    /// halted by taking one away.
    pub mints: [Pubkey; MAX_MINTS],
    /// Each accepted mint's fee, in that mint's own base units, at the same index as the mint.
    /// `fees[0]` is `crate::USDC_FEE`, 0.25 USDC, written at `init`. Every other is the amount
    /// the treasury set at `add_token`, meant to be worth 25 cents. Nothing changes a fee once
    /// written, and nothing removes one.
    pub fees: [u64; MAX_MINTS],
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
    /// treasury 0..32, mints 32..544, fees 544..672, mint_count 672, list_count 673..677,
    /// bump 677, pending_treasury 678..710.
    pub const LEN: usize = 32 + 32 * MAX_MINTS + 8 * MAX_MINTS + 1 + 4 + 1 + 32;

    pub fn accepts(&self, mint: &Pubkey) -> bool {
        self.fee_of(mint).is_some()
    }

    /// The fee recorded for an accepted mint, in its own base units, or `None` if the mint is
    /// not accepted.
    pub fn fee_of(&self, mint: &Pubkey) -> Option<u64> {
        let n = self.mint_count as usize;
        self.mints[..n].iter().position(|m| m == mint).map(|i| self.fees[i])
    }
}

/// One list of verified humans: a Semaphore LeanIMT of identity commitments, depth 32.
///
/// Zero-copy, because it is 5,520 bytes and a registration only reads a small part of it.
#[account(zero_copy)]
#[repr(C)]
pub struct IdentityList {
    /// Leaves appended so far. Also the position of the next root in the ring.
    pub leaf_count: u64,
    pub index: u32,
    pub issuer_count: u8,
    pub bump: u8,
    /// 1 once the list's owner has closed it to new members (`close_list`); 0 while open. A
    /// closed list keeps its members, its root and its last 128 roots, so every proof against it
    /// still verifies; it only takes no more inserts. Nothing reopens it and nothing deletes it.
    /// It sits in what was padding, so the account's size and every other offset are unchanged.
    pub closed: u8,
    pub _pad: [u8; 1],
    /// The current root. Zero while the list is empty, and a zero root is never accepted.
    pub root: [u8; 32],
    /// One node per level: the left node at that level still waiting for a right sibling.
    pub frontier: [[u8; 32]; FRONTIER_LEN],
    /// The last `ROOT_HISTORY` roots, written at `leaf_count % ROOT_HISTORY` before the count
    /// is raised. Unused slots are zero, and zero is never a valid root.
    pub roots: [[u8; 32]; ROOT_HISTORY],
    /// Keys that may insert into this list. The owner's is the first, from the moment the list
    /// opens; the owner may add others and remove any, its own included. A handover leaves them as
    /// they are.
    pub issuers: [Pubkey; MAX_ISSUERS],
    /// Who vouches for the list's members: the only key that adds or removes its insert keys,
    /// closes it or hands it over, and the key its swept rent goes to. Written when the list opens
    /// (`init` writes the foundation's issuer key for list 0), and changed only by
    /// `accept_list_owner`, signed by the key it moves to. Appended (session 14), so every offset
    /// before it is where sessions 5 to 11 put it.
    pub owner: Pubkey,
    /// The key the owner has proposed to hand the list to, or zero when nothing is pending.
    /// Written by `propose_list_owner`, consumed and cleared by `accept_list_owner`. Until the
    /// pending key accepts, nothing about the list has moved. Appended (session 15), so every
    /// offset before it stays.
    pub pending_owner: Pubkey,
}

impl IdentityList {
    pub const LEN: usize =
        8 + 4 + 1 + 1 + 1 + 1 + 32 + 32 * FRONTIER_LEN + 32 * ROOT_HISTORY + 32 * MAX_ISSUERS + 32 + 32;

    pub fn is_closed(&self) -> bool {
        self.closed != 0
    }

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

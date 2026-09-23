//! The harness, and the escrow's wire format written out a second time.
//!
//! Nothing here imports the program crate. The instruction bytes, the account layout, the event
//! layouts and the discriminators are written by hand, the way an outside client has to write
//! them, so a test passing means the sealed format really is what `src/lib.rs` and
//! `escrow/client` both say it is. A drift on either side fails a test instead of passing quietly.

use std::path::PathBuf;

use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rent::Rent;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const PROGRAM_ID: Address = solana_address::address!("FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT");
pub const TOKEN_PROGRAM: Address = solana_address::address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Address = solana_address::address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = solana_address::address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Address = solana_address::address!("11111111111111111111111111111111");

pub const VERSION: u8 = 1;
pub const ESCROW_LEN: usize = 8 + 311;
pub const MAX_STEPS: usize = 4;
pub const BPS: u16 = 10_000;
pub const DAY: i64 = 86_400;
/// `close_unaccepted`'s wait after the observed funding when an escrow has no steps.
pub const UNACCEPTED_DAYS: i64 = 30;
pub const NATIVE_MINT: Address = solana_address::address!("So11111111111111111111111111111111111111112");

/// `amount × bps / 10,000`, rounded down. Written a second time here, by hand.
pub fn share(amount: u64, bps: u16) -> u64 {
    ((u128::from(amount) * u128::from(bps)) / u128::from(BPS)) as u64
}

// ---------------------------------------------------------------------------------------------
// The wire format.
// ---------------------------------------------------------------------------------------------

pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let digest = Sha256::digest(format!("{namespace}:{name}").as_bytes());
    digest[..8].try_into().unwrap()
}

pub fn escrow_address(buyer: &Address, id: u64) -> Address {
    Address::find_program_address(&[b"escrow", buyer.as_ref(), &id.to_le_bytes()], &PROGRAM_ID).0
}

/// An associated token account: the standard address of `owner`'s account for `mint`.
pub fn ata_address(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

/// The deposit account: the escrow's associated token account for the mint.
pub fn vault_address(escrow: &Address, mint: &Address) -> Address {
    ata_address(escrow, mint)
}

/// The buyer's refund address: the buyer's associated token account for the mint. The only
/// account `recover_late` and `close_unaccepted` pay the buyer at.
pub fn refund_address(buyer: &Address, mint: &Address) -> Address {
    ata_address(buyer, mint)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub offset: i64,
    pub refund_bps: u16,
}

pub const fn step(offset: i64, refund_bps: u16) -> Step {
    Step { offset, refund_bps }
}

#[derive(Clone, Debug)]
pub struct Terms {
    pub id: u64,
    pub seller: Address,
    pub arbiter: Option<Address>,
    pub amount: u64,
    pub service_time: Option<i64>,
    pub silence_days: u16,
    pub steps: Vec<Step>,
}

/// The buyer, whose key and the id make the escrow's address, the rent payer and the mint.
pub struct CreateAccounts {
    pub buyer: Address,
    pub payer: Address,
    pub mint: Address,
}

/// id u64, buyer, seller, arbiter as an `Option` (0, or 1 then the key), amount u64, service_time
/// as an `Option` (0, or 1 then i64), silence_days u16, steps as a `Vec` (u32 count, then each as
/// offset i64 and refund_bps u16).
pub fn create_args_bytes(t: &Terms, buyer: &Address) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&t.id.to_le_bytes());
    data.extend_from_slice(buyer.as_ref());
    data.extend_from_slice(t.seller.as_ref());
    match t.arbiter {
        Some(k) => {
            data.push(1);
            data.extend_from_slice(k.as_ref());
        }
        None => data.push(0),
    }
    data.extend_from_slice(&t.amount.to_le_bytes());
    match t.service_time {
        Some(s) => {
            data.push(1);
            data.extend_from_slice(&s.to_le_bytes());
        }
        None => data.push(0),
    }
    data.extend_from_slice(&t.silence_days.to_le_bytes());
    data.extend_from_slice(&(t.steps.len() as u32).to_le_bytes());
    for s in &t.steps {
        data.extend_from_slice(&s.offset.to_le_bytes());
        data.extend_from_slice(&s.refund_bps.to_le_bytes());
    }
    data
}

/// `create` opened by the buyer: a proposal the seller has yet to accept.
pub fn create_ix(t: &Terms, a: &CreateAccounts) -> Instruction {
    create_ix_by(t, a, a.buyer)
}

/// `create` opened by the seller: an invoice, accepted from creation.
pub fn invoice_ix(t: &Terms, a: &CreateAccounts) -> Instruction {
    create_ix_by(t, a, t.seller)
}

/// `create` with `creator` in the signer slot: escrow, vault, creator, payer, mint, token
/// program, associated token program, system program.
pub fn create_ix_by(t: &Terms, a: &CreateAccounts, creator: Address) -> Instruction {
    let escrow = escrow_address(&a.buyer, t.id);
    let mut data = discriminator("global", "create").to_vec();
    data.extend_from_slice(&create_args_bytes(t, &a.buyer));
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault_address(&escrow, &a.mint), false),
            AccountMeta::new_readonly(creator, true),
            AccountMeta::new(a.payer, true),
            AccountMeta::new_readonly(a.mint, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data,
    }
}

/// `accept`: escrow, vault, seller.
pub fn accept_ix(escrow: Address, vault: Address, seller: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(seller, true),
        ],
        data: discriminator("global", "accept").to_vec(),
    }
}

pub fn mark_funded_ix(escrow: Address, vault: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(escrow, false), AccountMeta::new_readonly(vault, false)],
        data: discriminator("global", "mark_funded").to_vec(),
    }
}

pub fn object_ix(escrow: Address, vault: Address, buyer: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(buyer, true),
        ],
        data: discriminator("global", "object").to_vec(),
    }
}

/// The accounts every ending touches, in order: escrow, vault, buyer_tokens, seller_tokens,
/// rent_payer, token program. Signers, if any, follow.
#[derive(Clone, Copy)]
pub struct SettleAccounts {
    pub escrow: Address,
    pub vault: Address,
    pub buyer_tokens: Address,
    pub seller_tokens: Address,
    pub rent_payer: Address,
}

fn settle_metas(s: &SettleAccounts) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(s.escrow, false),
        AccountMeta::new(s.vault, false),
        AccountMeta::new(s.buyer_tokens, false),
        AccountMeta::new(s.seller_tokens, false),
        AccountMeta::new(s.rent_payer, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false),
    ]
}

/// `release_by_silence`: no signer beyond the transaction's fee payer.
pub fn release_by_silence_ix(s: &SettleAccounts) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: settle_metas(s),
        data: discriminator("global", "release_by_silence").to_vec(),
    }
}

/// An ending one key signs. `seller_bps` is `approve` and `arbitrate`'s argument; the others
/// carry none.
pub fn settle_as_ix(name: &str, s: &SettleAccounts, actor: Address, seller_bps: Option<u16>) -> Instruction {
    let mut accounts = settle_metas(s);
    accounts.push(AccountMeta::new_readonly(actor, true));
    let mut data = discriminator("global", name).to_vec();
    if let Some(bps) = seller_bps {
        data.extend_from_slice(&bps.to_le_bytes());
    }
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

pub fn approve_ix(s: &SettleAccounts, buyer: Address, seller_bps: u16) -> Instruction {
    settle_as_ix("approve", s, buyer, Some(seller_bps))
}
pub fn arbitrate_ix(s: &SettleAccounts, arbiter: Address, seller_bps: u16) -> Instruction {
    settle_as_ix("arbitrate", s, arbiter, Some(seller_bps))
}
pub fn cancel_buyer_ix(s: &SettleAccounts, buyer: Address) -> Instruction {
    settle_as_ix("cancel_buyer", s, buyer, None)
}
pub fn cancel_seller_ix(s: &SettleAccounts, seller: Address) -> Instruction {
    settle_as_ix("cancel_seller", s, seller, None)
}

/// The two exits that pay the seller nothing name no seller account: escrow, vault, buyer_tokens,
/// rent_payer, token program, then the signer.
fn refund_ix(name: &str, s: &SettleAccounts, signer: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(s.escrow, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new(s.buyer_tokens, false),
            AccountMeta::new(s.rent_payer, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(signer, true),
        ],
        data: discriminator("global", name).to_vec(),
    }
}

/// `withdraw`: the buyer, before the seller accepts. `s.seller_tokens` is not sent.
pub fn withdraw_ix(s: &SettleAccounts, buyer: Address) -> Instruction {
    refund_ix("withdraw", s, buyer)
}

/// `close_unfunded`: the buyer, the seller, or the rent payer after the last deadline.
/// `s.seller_tokens` is not sent.
pub fn close_unfunded_ix(s: &SettleAccounts, closer: Address) -> Instruction {
    refund_ix("close_unfunded", s, closer)
}

/// `agree`: both keys sign.
pub fn agree_ix(s: &SettleAccounts, buyer: Address, seller: Address, seller_bps: u16) -> Instruction {
    let mut accounts = settle_metas(s);
    accounts.push(AccountMeta::new_readonly(buyer, true));
    accounts.push(AccountMeta::new_readonly(seller, true));
    let mut data = discriminator("global", "agree").to_vec();
    data.extend_from_slice(&seller_bps.to_le_bytes());
    Instruction { program_id: PROGRAM_ID, accounts, data }
}

/// `recover_late`: escrow, vault, buyer, refund, mint, caller (signs, pays for the refund account
/// if it has to be made), token program, associated token program, system program.
pub fn recover_late_ix(escrow: Address, vault: Address, buyer: Address, mint: Address, caller: Address) -> Instruction {
    recover_late_ix_to(escrow, vault, buyer, refund_address(&buyer, &mint), mint, caller)
}

/// `recover_late` naming any refund account: for tests that try another one.
pub fn recover_late_ix_to(escrow: Address, vault: Address, buyer: Address, refund: Address, mint: Address, caller: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(buyer, false),
            AccountMeta::new(refund, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(caller, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data: discriminator("global", "recover_late").to_vec(),
    }
}

/// `sweep_rent`: escrow, rent payer. No signer beyond the transaction's fee payer.
pub fn sweep_rent_ix(escrow: Address, rent_payer: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(escrow, false), AccountMeta::new(rent_payer, false)],
        data: discriminator("global", "sweep_rent").to_vec(),
    }
}

/// `close_unaccepted`: escrow, vault, buyer, refund, mint, rent payer, caller (signs, pays for the
/// refund account if it has to be made), token program, associated token program, system program.
pub fn close_unaccepted_ix(escrow: Address, vault: Address, buyer: Address, mint: Address, rent_payer: Address, caller: Address) -> Instruction {
    close_unaccepted_ix_to(escrow, vault, buyer, refund_address(&buyer, &mint), mint, rent_payer, caller)
}

/// `close_unaccepted` naming any refund account: for tests that try another one.
pub fn close_unaccepted_ix_to(
    escrow: Address,
    vault: Address,
    buyer: Address,
    refund: Address,
    mint: Address,
    rent_payer: Address,
    caller: Address,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(buyer, false),
            AccountMeta::new(refund, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(rent_payer, false),
            AccountMeta::new(caller, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data: discriminator("global", "close_unaccepted").to_vec(),
    }
}

/// A plain SPL Token transfer, the way any wallet funds the deposit account: instruction 3,
/// amount u64; source, destination, owner.
pub fn spl_transfer_ix(from: Address, to: Address, owner: Address, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(from, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

/// The associated token program's `CreateIdempotent` (instruction 1): what a wallet sends before
/// paying an address whose token account does not exist. Payer, account, owner, mint, system,
/// token. Returns the account's address too.
pub fn create_ata_idempotent_ix(payer: Address, owner: Address, mint: Address) -> (Instruction, Address) {
    let ata = ata_address(&owner, &mint);
    let ix = Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![1],
    };
    (ix, ata)
}

/// A plain SOL transfer: the system program's instruction 2.
pub fn sol_transfer_ix(from: Address, to: Address, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)],
        data,
    }
}

/// The Rent sysvar at a given rate. The rent-exempt minimum of an account of `n` bytes is then
/// `(128 + n) × lamports_per_byte`.
pub fn rent_at(lamports_per_byte: u64) -> Rent {
    let mut rent = Rent::default();
    rent.lamports_per_byte = lamports_per_byte;
    rent
}

/// Lamports per byte where SIMD-0437's cuts end.
pub const RENT_FINAL: u64 = 696;

// ---------------------------------------------------------------------------------------------
// The account layout, read back out of the raw bytes.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open = 0,
    Accepted = 1,
    Funded = 2,
    Locked = 3,
    Ended = 4,
}

#[derive(Debug)]
pub struct EscrowView {
    pub version: u8,
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    /// The zero key when none.
    pub arbiter: Address,
    pub mint: Address,
    pub vault: Address,
    pub rent_payer: Address,
    pub amount: u64,
    pub service_time: i64,
    pub silence_days: u16,
    pub steps: Vec<Step>,
    pub created_at: i64,
    pub funded_at: i64,
    pub status: Status,
    pub bump: u8,
    /// 0 until the seller accepts.
    pub accepted_at: i64,
    /// 0 until it ends.
    pub ended_at: i64,
    /// `None` until it ends.
    pub outcome: Option<Outcome>,
    pub to_seller: u64,
    pub to_buyer: u64,
}

/// version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137, vault 137..169,
/// rent_payer 169..201, amount 201..209, service_time 209..217, silence_days 217..219,
/// step_count 219, steps 220..260, created_at 260..268, funded_at 268..276, status 276, bump 277,
/// accepted_at 278..286, ended_at 286..294, outcome 294, to_seller 295..303, to_buyer 303..311.
pub fn read_escrow(data: &[u8]) -> EscrowView {
    assert_eq!(data.len(), ESCROW_LEN);
    assert_eq!(data[..8], discriminator("account", "Escrow"));
    let b = &data[8..];
    let key = |at: usize| Address::try_from(&b[at..at + 32]).unwrap();
    let u64_at = |at: usize| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    let i64_at = |at: usize| i64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    let step_count = b[219] as usize;
    let steps = (0..step_count)
        .map(|i| Step {
            offset: i64_at(220 + i * 10),
            refund_bps: u16::from_le_bytes(b[228 + i * 10..230 + i * 10].try_into().unwrap()),
        })
        .collect();
    let status = match b[276] {
        0 => Status::Open,
        1 => Status::Accepted,
        2 => Status::Funded,
        3 => Status::Locked,
        4 => Status::Ended,
        other => panic!("status byte {other}"),
    };
    EscrowView {
        version: b[0],
        id: u64_at(1),
        buyer: key(9),
        seller: key(41),
        arbiter: key(73),
        mint: key(105),
        vault: key(137),
        rent_payer: key(169),
        amount: u64_at(201),
        service_time: i64_at(209),
        silence_days: u16::from_le_bytes(b[217..219].try_into().unwrap()),
        steps,
        created_at: i64_at(260),
        funded_at: i64_at(268),
        status,
        bump: b[277],
        accepted_at: i64_at(278),
        ended_at: i64_at(286),
        outcome: if status == Status::Ended { Some(outcome_of(b[294])) } else { None },
        to_seller: u64_at(295),
        to_buyer: u64_at(303),
    }
}

pub fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

// ---------------------------------------------------------------------------------------------
// Events, decoded from the `Program data:` lines Anchor writes.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Approved = 0,
    ReleasedBySilence = 1,
    Agreed = 2,
    Arbitrated = 3,
    CancelledByBuyer = 4,
    CancelledBySeller = 5,
    Withdrawn = 6,
    NeverAccepted = 7,
}

pub fn outcome_of(byte: u8) -> Outcome {
    match byte {
        0 => Outcome::Approved,
        1 => Outcome::ReleasedBySilence,
        2 => Outcome::Agreed,
        3 => Outcome::Arbitrated,
        4 => Outcome::CancelledByBuyer,
        5 => Outcome::CancelledBySeller,
        6 => Outcome::Withdrawn,
        7 => Outcome::NeverAccepted,
        other => panic!("outcome byte {other}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Created {
        escrow: Address,
        version: u8,
        id: u64,
        buyer: Address,
        seller: Address,
        arbiter: Address,
        mint: Address,
        vault: Address,
        rent_payer: Address,
        amount: u64,
        service_time: i64,
        silence_days: u16,
        steps: Vec<Step>,
        created_at: i64,
    },
    Accepted { escrow: Address, seller: Address, accepted_at: i64 },
    Funded { escrow: Address, balance: u64, funded_at: i64 },
    Approved { escrow: Address, seller_bps: u16, to_seller: u64, to_buyer: u64 },
    ReleasedBySilence { escrow: Address, clock_start: i64, silence_ended: i64, to_seller: u64, to_buyer: u64 },
    Objected { escrow: Address, at: i64, silence_ends: i64 },
    Agreed { escrow: Address, seller_bps: u16, to_seller: u64, to_buyer: u64 },
    Arbitrated { escrow: Address, arbiter: Address, seller_bps: u16, to_seller: u64, to_buyer: u64 },
    CancelledByBuyer { escrow: Address, step: u8, refund_bps: u16, to_buyer: u64, to_seller: u64 },
    CancelledBySeller { escrow: Address, seller: Address, to_buyer: u64 },
    Withdrawn { escrow: Address, to_buyer: u64 },
    Ended {
        escrow: Address,
        outcome: Outcome,
        amount: u64,
        balance: u64,
        to_seller: u64,
        to_buyer: u64,
        accepted_at: i64,
        ended_at: i64,
        rent_payer: Address,
        rent_lamports: u64,
    },
    Closed { escrow: Address, closed_by: Address, to_buyer: u64, rent_payer: Address, rent_lamports: u64 },
    NeverAccepted { escrow: Address, timeout: i64, to_buyer: u64 },
    RecoveredLate { escrow: Address, to_buyer: u64, rent_lamports: u64 },
    RentSwept { escrow: Address, lamports: u64, left: u64 },
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::Created { .. } => "Created",
            Event::Accepted { .. } => "Accepted",
            Event::Funded { .. } => "Funded",
            Event::Approved { .. } => "Approved",
            Event::ReleasedBySilence { .. } => "ReleasedBySilence",
            Event::Objected { .. } => "Objected",
            Event::Agreed { .. } => "Agreed",
            Event::Arbitrated { .. } => "Arbitrated",
            Event::CancelledByBuyer { .. } => "CancelledByBuyer",
            Event::CancelledBySeller { .. } => "CancelledBySeller",
            Event::Withdrawn { .. } => "Withdrawn",
            Event::Ended { .. } => "Ended",
            Event::Closed { .. } => "Closed",
            Event::NeverAccepted { .. } => "NeverAccepted",
            Event::RecoveredLate { .. } => "RecoveredLate",
            Event::RentSwept { .. } => "RentSwept",
        }
    }
}

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn u8(&mut self) -> u8 {
        let v = self.b[self.at];
        self.at += 1;
        v
    }
    fn u16(&mut self) -> u16 {
        let v = u16::from_le_bytes(self.b[self.at..self.at + 2].try_into().unwrap());
        self.at += 2;
        v
    }
    fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes(self.b[self.at..self.at + 4].try_into().unwrap());
        self.at += 4;
        v
    }
    fn u64(&mut self) -> u64 {
        let v = u64::from_le_bytes(self.b[self.at..self.at + 8].try_into().unwrap());
        self.at += 8;
        v
    }
    fn i64(&mut self) -> i64 {
        self.u64() as i64
    }
    fn key(&mut self) -> Address {
        let v = Address::try_from(&self.b[self.at..self.at + 32]).unwrap();
        self.at += 32;
        v
    }
    fn steps(&mut self) -> Vec<Step> {
        let n = self.u32() as usize;
        (0..n).map(|_| Step { offset: self.i64(), refund_bps: self.u16() }).collect()
    }
    fn done(&self) {
        assert_eq!(self.at, self.b.len(), "an event has trailing bytes");
    }
}

const EVENT_NAMES: [&str; 16] = [
    "Created",
    "Accepted",
    "Funded",
    "Approved",
    "ReleasedBySilence",
    "Objected",
    "Agreed",
    "Arbitrated",
    "CancelledByBuyer",
    "CancelledBySeller",
    "Withdrawn",
    "Ended",
    "Closed",
    "NeverAccepted",
    "RecoveredLate",
    "RentSwept",
];

pub fn events(logs: &[String]) -> Vec<Event> {
    let mut out = Vec::new();
    for line in logs {
        let Some(payload) = line.strip_prefix("Program data: ") else { continue };
        let Ok(bytes) = base64_decode(payload) else { continue };
        if bytes.len() < 8 {
            continue;
        }
        let Some(name) = EVENT_NAMES.iter().find(|n| discriminator("event", n) == bytes[..8]) else {
            continue;
        };
        let mut c = Cursor { b: &bytes[8..], at: 0 };
        let escrow = c.key();
        let event = match *name {
            "Created" => Event::Created {
                escrow,
                version: c.u8(),
                id: c.u64(),
                buyer: c.key(),
                seller: c.key(),
                arbiter: c.key(),
                mint: c.key(),
                vault: c.key(),
                rent_payer: c.key(),
                amount: c.u64(),
                service_time: c.i64(),
                silence_days: c.u16(),
                steps: c.steps(),
                created_at: c.i64(),
            },
            "Accepted" => Event::Accepted { escrow, seller: c.key(), accepted_at: c.i64() },
            "Funded" => Event::Funded { escrow, balance: c.u64(), funded_at: c.i64() },
            "Approved" => Event::Approved { escrow, seller_bps: c.u16(), to_seller: c.u64(), to_buyer: c.u64() },
            "ReleasedBySilence" => Event::ReleasedBySilence {
                escrow,
                clock_start: c.i64(),
                silence_ended: c.i64(),
                to_seller: c.u64(),
                to_buyer: c.u64(),
            },
            "Objected" => Event::Objected { escrow, at: c.i64(), silence_ends: c.i64() },
            "Agreed" => Event::Agreed { escrow, seller_bps: c.u16(), to_seller: c.u64(), to_buyer: c.u64() },
            "Arbitrated" => Event::Arbitrated {
                escrow,
                arbiter: c.key(),
                seller_bps: c.u16(),
                to_seller: c.u64(),
                to_buyer: c.u64(),
            },
            "CancelledByBuyer" => Event::CancelledByBuyer {
                escrow,
                step: c.u8(),
                refund_bps: c.u16(),
                to_buyer: c.u64(),
                to_seller: c.u64(),
            },
            "CancelledBySeller" => Event::CancelledBySeller { escrow, seller: c.key(), to_buyer: c.u64() },
            "Withdrawn" => Event::Withdrawn { escrow, to_buyer: c.u64() },
            "Ended" => Event::Ended {
                escrow,
                outcome: outcome_of(c.u8()),
                amount: c.u64(),
                balance: c.u64(),
                to_seller: c.u64(),
                to_buyer: c.u64(),
                accepted_at: c.i64(),
                ended_at: c.i64(),
                rent_payer: c.key(),
                rent_lamports: c.u64(),
            },
            "Closed" => Event::Closed {
                escrow,
                closed_by: c.key(),
                to_buyer: c.u64(),
                rent_payer: c.key(),
                rent_lamports: c.u64(),
            },
            "NeverAccepted" => Event::NeverAccepted { escrow, timeout: c.i64(), to_buyer: c.u64() },
            "RecoveredLate" => Event::RecoveredLate { escrow, to_buyer: c.u64(), rent_lamports: c.u64() },
            "RentSwept" => Event::RentSwept { escrow, lamports: c.u64(), left: c.u64() },
            _ => unreachable!(),
        };
        c.done();
        out.push(event);
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for ch in s.bytes() {
        if ch == b'=' {
            break;
        }
        let Some(v) = TABLE.iter().position(|c| *c == ch) else { return Err(()) };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------------------------

pub fn spl_mint_account(decimals: u8, owner: Address) -> Account {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1; // is_initialized
    Account { lamports: 1_461_600, data: d, owner, executable: false, rent_epoch: 0 }
}

pub fn spl_token_account(mint: &Address, owner: &Address, amount: u64) -> Account {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state: Initialized
    Account { lamports: 2_039_280, data: d, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }
}

/// Ten dollars at six decimals: what the buyer starts with.
pub const BUYER_START: u64 = 10_000_000;
/// A Monday noon, in unix seconds, where every test's clock starts.
pub const T0: i64 = 1_800_000_000;

pub struct Harness {
    pub svm: LiteSVM,
    /// The transaction fee payer and, unless a test says otherwise, the rent payer.
    pub payer: Keypair,
    pub buyer: Keypair,
    pub seller: Keypair,
    pub arbiter: Keypair,
    /// A six-decimal classic SPL Token mint.
    pub mint: Address,
    pub buyer_tokens: Address,
    pub seller_tokens: Address,
}

impl Harness {
    pub fn new() -> Self {
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/forest_escrow.so");
        let bytes = std::fs::read(&so).unwrap_or_else(|e| {
            panic!("{}: {e}. Build it first: `cargo build-sbf` in escrow/program.", so.display())
        });
        let mut svm = LiteSVM::new();
        svm.add_program(PROGRAM_ID, &bytes).unwrap();

        let payer = Keypair::new();
        let buyer = Keypair::new();
        let seller = Keypair::new();
        let arbiter = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&buyer.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&seller.pubkey(), 10_000_000_000).unwrap();

        let mint = Address::new_unique();
        svm.set_account(mint, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
        let buyer_tokens = Address::new_unique();
        svm.set_account(buyer_tokens, spl_token_account(&mint, &buyer.pubkey(), BUYER_START)).unwrap();
        let seller_tokens = Address::new_unique();
        svm.set_account(seller_tokens, spl_token_account(&mint, &seller.pubkey(), 0)).unwrap();

        let mut h = Harness { svm, payer, buyer, seller, arbiter, mint, buyer_tokens, seller_tokens };
        h.set_time(T0);
        h
    }

    // -- time --

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, unix: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn advance(&mut self, seconds: i64) {
        let now = self.now();
        self.set_time(now + seconds);
    }

    // -- sending --

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<litesvm::types::TransactionMetadata, String> {
        self.svm.expire_blockhash();
        let mut keys: Vec<&Keypair> = vec![&self.payer];
        keys.extend_from_slice(signers);
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&keys, msg, self.svm.latest_blockhash());
        self.send_tx(tx)
    }

    pub fn send_tx(&mut self, tx: Transaction) -> Result<litesvm::types::TransactionMetadata, String> {
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta),
            Err(e) => Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
        }
    }

    // -- the standard deal --

    /// Terms with no arbiter and no service time: 1.00 of the mint, seven silence days, two
    /// steps (until one day after the clock start, all back; until three days, half back).
    pub fn terms(&self, id: u64) -> Terms {
        Terms {
            id,
            seller: self.seller.pubkey(),
            arbiter: None,
            amount: 1_000_000,
            service_time: None,
            silence_days: 7,
            steps: vec![step(DAY, 10_000), step(3 * DAY, 5_000)],
        }
    }

    pub fn create_accounts(&self) -> CreateAccounts {
        CreateAccounts { buyer: self.buyer.pubkey(), payer: self.payer.pubkey(), mint: self.mint }
    }

    /// `create`, signed by the buyer and the payer. Returns the escrow address.
    pub fn create(&mut self, t: &Terms) -> Result<(Address, litesvm::types::TransactionMetadata), String> {
        let a = self.create_accounts();
        let buyer = self.buyer.insecure_clone();
        let meta = self.send(&[create_ix(t, &a)], &[&buyer])?;
        Ok((escrow_address(&a.buyer, t.id), meta))
    }

    /// A plain transfer from the buyer's token account into the deposit account.
    pub fn fund(&mut self, escrow: &Address, amount: u64) {
        let vault = vault_address(escrow, &self.mint);
        let buyer = self.buyer.insecure_clone();
        self.send(&[spl_transfer_ix(self.buyer_tokens, vault, buyer.pubkey(), amount)], &[&buyer])
            .expect("fund");
    }

    /// `create`, opened by the seller as an invoice, signed by the seller and the payer.
    pub fn invoice(&mut self, t: &Terms) -> Result<(Address, litesvm::types::TransactionMetadata), String> {
        let a = self.create_accounts();
        let seller = self.seller.insecure_clone();
        let meta = self.send(&[invoice_ix(t, &a)], &[&seller])?;
        Ok((escrow_address(&a.buyer, t.id), meta))
    }

    /// The seller accepts.
    pub fn accept(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let vault = vault_address(escrow, &self.mint);
        let seller = self.seller.insecure_clone();
        self.send(&[accept_ix(*escrow, vault, seller.pubkey())], &[&seller])
    }

    pub fn mark_funded(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let vault = vault_address(escrow, &self.mint);
        self.send(&[mark_funded_ix(*escrow, vault)], &[])
    }

    /// Created by the buyer, accepted by the seller, funded with exactly the amount by a plain
    /// transfer, and marked funded, all at the current time (`T0` unless a test moved it).
    pub fn funded(&mut self, t: &Terms) -> Address {
        let (escrow, _) = self.create(t).expect("create");
        self.accept(&escrow).expect("accept");
        self.fund(&escrow, t.amount);
        self.mark_funded(&escrow).expect("mark_funded");
        escrow
    }

    /// The buyer's refund address for the harness's mint.
    pub fn refund(&self) -> Address {
        refund_address(&self.buyer.pubkey(), &self.mint)
    }

    /// `recover_late`, sent and paid for by `caller`.
    pub fn recover_late(&mut self, escrow: &Address, caller: &Keypair) -> Result<litesvm::types::TransactionMetadata, String> {
        let ix = recover_late_ix(*escrow, vault_address(escrow, &self.mint), self.buyer.pubkey(), self.mint, caller.pubkey());
        self.send(&[ix], &[caller])
    }

    /// `sweep_rent`, with nobody but the fee payer signing.
    pub fn sweep(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let rent_payer = self.payer.pubkey();
        self.send(&[sweep_rent_ix(*escrow, rent_payer)], &[])
    }

    /// `close_unaccepted`, sent and paid for by `caller`.
    pub fn close_unaccepted(&mut self, escrow: &Address, caller: &Keypair) -> Result<litesvm::types::TransactionMetadata, String> {
        let ix = close_unaccepted_ix(
            *escrow,
            vault_address(escrow, &self.mint),
            self.buyer.pubkey(),
            self.mint,
            self.payer.pubkey(),
            caller.pubkey(),
        );
        self.send(&[ix], &[caller])
    }

    pub fn settle_accounts(&self, escrow: &Address) -> SettleAccounts {
        SettleAccounts {
            escrow: *escrow,
            vault: vault_address(escrow, &self.mint),
            buyer_tokens: self.buyer_tokens,
            seller_tokens: self.seller_tokens,
            rent_payer: self.payer.pubkey(),
        }
    }

    // -- reading --

    pub fn account(&self, address: &Address) -> Account {
        self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"))
    }

    pub fn escrow(&self, address: &Address) -> EscrowView {
        read_escrow(&self.account(address).data)
    }

    pub fn balance(&self, token_account: &Address) -> u64 {
        token_amount(&self.account(token_account).data)
    }

    pub fn vault_balance(&self, escrow: &Address) -> u64 {
        self.balance(&vault_address(escrow, &self.mint))
    }

    pub fn lamports(&self, address: &Address) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, address: &Address) -> bool {
        self.svm.get_account(address).map(|a| a.lamports > 0).unwrap_or(false)
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

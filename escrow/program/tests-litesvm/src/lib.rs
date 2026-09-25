//! The harness, and the escrow's wire format written out a second time.
//!
//! Nothing here imports the program crate. The instruction bytes, the account layout, the event
//! layouts and the discriminators are written by hand, the way an outside client has to write
//! them, so a test passing means the sealed format really is what `src/lib.rs` and
//! `escrow/client` both say it is. A drift on either side fails a test instead of passing quietly.

use std::path::PathBuf;
use std::sync::Mutex;

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
pub const NATIVE_MINT: Address = solana_address::address!("So11111111111111111111111111111111111111112");

pub const VERSION: u8 = 1;
/// The escrow account: Anchor's eight-byte discriminator and 256 bytes of state.
pub const ESCROW_LEN: usize = 8 + 256;
pub const BPS: u16 = 10_000;
pub const DAY: i64 = 86_400;

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
/// account any payout to the buyer lands in.
pub fn refund_address(buyer: &Address, mint: &Address) -> Address {
    ata_address(buyer, mint)
}

/// A party, as one byte: buyer 0, seller 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buyer = 0,
    Seller = 1,
}

pub fn side_of(byte: u8) -> Side {
    match byte {
        0 => Side::Buyer,
        1 => Side::Seller,
        other => panic!("side byte {other}"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timer {
    pub days: u16,
    pub to: Side,
}

#[derive(Clone, Debug)]
pub struct Terms {
    pub id: u64,
    pub seller: Address,
    pub amount: u64,
    pub arbiter: Option<Address>,
    pub timer: Option<Timer>,
}

/// The buyer, whose key and the id make the escrow's address, the rent payer and the mint.
pub struct CreateAccounts {
    pub buyer: Address,
    pub payer: Address,
    pub mint: Address,
}

/// id u64, buyer, seller, amount u64, arbiter as an `Option` (0, or 1 then the key), timer as an
/// `Option` (0, or 1 then days u16 and the side as one byte).
pub fn create_args_bytes(t: &Terms, buyer: &Address) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&t.id.to_le_bytes());
    data.extend_from_slice(buyer.as_ref());
    data.extend_from_slice(t.seller.as_ref());
    data.extend_from_slice(&t.amount.to_le_bytes());
    match t.arbiter {
        Some(k) => {
            data.push(1);
            data.extend_from_slice(k.as_ref());
        }
        None => data.push(0),
    }
    match t.timer {
        Some(timer) => {
            data.push(1);
            data.extend_from_slice(&timer.days.to_le_bytes());
            data.push(timer.to as u8);
        }
        None => data.push(0),
    }
    data
}

/// `create` opened by the buyer.
pub fn create_ix(t: &Terms, a: &CreateAccounts) -> Instruction {
    create_ix_by(t, a, a.buyer)
}

/// `create` opened by the seller: an invoice.
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
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data,
    }
}

/// `mark_funded`: escrow, vault. No signer beyond the transaction's fee payer.
pub fn mark_funded_ix(escrow: Address, vault: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(escrow, false), AccountMeta::new_readonly(vault, false)],
        data: discriminator("global", "mark_funded").to_vec(),
    }
}

/// The accounts the ways out touch. Each instruction takes the ones it pays, in this order:
/// escrow, vault, buyer_tokens, seller_tokens, rent_payer, token program, then its signers.
/// `buyer_tokens` must be the buyer's refund address; tests put other accounts there to see them
/// refused.
#[derive(Clone, Copy, Debug)]
pub struct Accounts {
    pub escrow: Address,
    pub vault: Address,
    pub buyer_tokens: Address,
    pub seller_tokens: Address,
    pub rent_payer: Address,
}

fn ix(name: &str, metas: Vec<AccountMeta>, args: &[u8]) -> Instruction {
    let mut data = discriminator("global", name).to_vec();
    data.extend_from_slice(args);
    Instruction { program_id: PROGRAM_ID, accounts: metas, data }
}

/// `release_to_seller`: escrow, vault, seller_tokens, rent_payer, token program, buyer (signs).
pub fn release_to_seller_ix(s: &Accounts, buyer: Address) -> Instruction {
    ix(
        "release_to_seller",
        vec![
            AccountMeta::new(s.escrow, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new(s.seller_tokens, false),
            AccountMeta::new(s.rent_payer, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(buyer, true),
        ],
        &[],
    )
}

/// `release_to_buyer`: escrow, vault, buyer_tokens, rent_payer, token program, seller (signs).
pub fn release_to_buyer_ix(s: &Accounts, seller: Address) -> Instruction {
    ix(
        "release_to_buyer",
        vec![
            AccountMeta::new(s.escrow, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new(s.buyer_tokens, false),
            AccountMeta::new(s.rent_payer, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(seller, true),
        ],
        &[],
    )
}

fn both_metas(s: &Accounts) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(s.escrow, false),
        AccountMeta::new(s.vault, false),
        AccountMeta::new(s.buyer_tokens, false),
        AccountMeta::new(s.seller_tokens, false),
        AccountMeta::new(s.rent_payer, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false),
    ]
}

/// `split(seller_bps)`: escrow, vault, buyer_tokens, seller_tokens, rent_payer, token program,
/// buyer and seller (both sign).
pub fn split_ix(s: &Accounts, buyer: Address, seller: Address, seller_bps: u16) -> Instruction {
    let mut metas = both_metas(s);
    metas.push(AccountMeta::new_readonly(buyer, true));
    metas.push(AccountMeta::new_readonly(seller, true));
    ix("split", metas, &seller_bps.to_le_bytes())
}

/// `arbitrate(seller_bps)`: the same accounts as `split`, and the arbiter signs.
pub fn arbitrate_ix(s: &Accounts, arbiter: Address, seller_bps: u16) -> Instruction {
    let mut metas = both_metas(s);
    metas.push(AccountMeta::new_readonly(arbiter, true));
    ix("arbitrate", metas, &seller_bps.to_le_bytes())
}

/// `timer_release`: escrow, vault, to (the named side's account), rent_payer, token program. No
/// signer beyond the transaction's fee payer.
pub fn timer_release_ix(escrow: Address, vault: Address, to: Address, rent_payer: Address) -> Instruction {
    ix(
        "timer_release",
        vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(to, false),
            AccountMeta::new(rent_payer, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        &[],
    )
}

/// `close_unfunded`: escrow, vault, buyer_tokens, rent_payer, token program, closer (signs).
pub fn close_unfunded_ix(s: &Accounts, closer: Address) -> Instruction {
    ix(
        "close_unfunded",
        vec![
            AccountMeta::new(s.escrow, false),
            AccountMeta::new(s.vault, false),
            AccountMeta::new(s.buyer_tokens, false),
            AccountMeta::new(s.rent_payer, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(closer, true),
        ],
        &[],
    )
}

/// `recover_late`: escrow, vault, buyer, refund, mint, caller (signs, pays for the refund account
/// if it has to be made), token program, associated token program, system program.
pub fn recover_late_ix(escrow: Address, vault: Address, buyer: Address, mint: Address, caller: Address) -> Instruction {
    recover_late_ix_to(escrow, vault, buyer, refund_address(&buyer, &mint), mint, caller)
}

/// `recover_late` naming any refund account: for tests that try another one.
pub fn recover_late_ix_to(escrow: Address, vault: Address, buyer: Address, refund: Address, mint: Address, caller: Address) -> Instruction {
    ix(
        "recover_late",
        vec![
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
        &[],
    )
}

/// `sweep_rent`: escrow, rent payer. No signer beyond the transaction's fee payer.
pub fn sweep_rent_ix(escrow: Address, rent_payer: Address) -> Instruction {
    ix("sweep_rent", vec![AccountMeta::new(escrow, false), AccountMeta::new(rent_payer, false)], &[])
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
    Funded = 1,
    Ended = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    ReleasedToSeller = 0,
    ReleasedToBuyer = 1,
    Split = 2,
    Arbitrated = 3,
    TimerReleased = 4,
}

pub fn outcome_of(byte: u8) -> Outcome {
    match byte {
        0 => Outcome::ReleasedToSeller,
        1 => Outcome::ReleasedToBuyer,
        2 => Outcome::Split,
        3 => Outcome::Arbitrated,
        4 => Outcome::TimerReleased,
        other => panic!("outcome byte {other}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub creator: Side,
    /// `None` when `timer_days` is 0.
    pub timer: Option<Timer>,
    pub created_at: i64,
    /// 0 until the funding is marked.
    pub funded_at: i64,
    pub status: Status,
    pub bump: u8,
    /// 0 until it ends.
    pub ended_at: i64,
    /// `None` until it ends.
    pub outcome: Option<Outcome>,
    pub to_seller: u64,
    pub to_buyer: u64,
}

/// version 0, id 1..9, buyer 9..41, seller 41..73, arbiter 73..105, mint 105..137, vault 137..169,
/// rent_payer 169..201, amount 201..209, creator 209, timer_days 210..212, timer_to 212,
/// created_at 213..221, funded_at 221..229, status 229, bump 230, ended_at 231..239, outcome 239,
/// to_seller 240..248, to_buyer 248..256.
pub fn read_escrow(data: &[u8]) -> EscrowView {
    assert_eq!(data.len(), ESCROW_LEN);
    assert_eq!(data[..8], discriminator("account", "Escrow"));
    let b = &data[8..];
    let key = |at: usize| Address::try_from(&b[at..at + 32]).unwrap();
    let u64_at = |at: usize| u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    let i64_at = |at: usize| i64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    let timer_days = u16::from_le_bytes(b[210..212].try_into().unwrap());
    let timer_to = side_of(b[212]);
    let status = match b[229] {
        0 => Status::Open,
        1 => Status::Funded,
        2 => Status::Ended,
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
        creator: side_of(b[209]),
        timer: if timer_days == 0 {
            assert_eq!(timer_to, Side::Buyer, "no timer is stored as buyer");
            None
        } else {
            Some(Timer { days: timer_days, to: timer_to })
        },
        created_at: i64_at(213),
        funded_at: i64_at(221),
        status,
        bump: b[230],
        ended_at: i64_at(231),
        outcome: if status == Status::Ended { Some(outcome_of(b[239])) } else { None },
        to_seller: u64_at(240),
        to_buyer: u64_at(248),
    }
}

pub fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

// ---------------------------------------------------------------------------------------------
// Events, decoded from the `Program data:` lines Anchor writes.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Created {
        escrow: Address,
        version: u8,
        id: u64,
        buyer: Address,
        seller: Address,
        creator: Side,
        arbiter: Address,
        mint: Address,
        vault: Address,
        rent_payer: Address,
        amount: u64,
        timer_days: u16,
        timer_to: Side,
        created_at: i64,
    },
    Funded { escrow: Address, balance: u64, funded_at: i64 },
    Ended {
        escrow: Address,
        outcome: Outcome,
        amount: u64,
        balance: u64,
        to_seller: u64,
        to_buyer: u64,
        ended_at: i64,
        rent_payer: Address,
        rent_lamports: u64,
    },
    Closed { escrow: Address, closed_by: Address, to_buyer: u64, rent_payer: Address, rent_lamports: u64 },
    RecoveredLate { escrow: Address, to_buyer: u64, rent_lamports: u64 },
    RentSwept { escrow: Address, lamports: u64, left: u64 },
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::Created { .. } => "Created",
            Event::Funded { .. } => "Funded",
            Event::Ended { .. } => "Ended",
            Event::Closed { .. } => "Closed",
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
    fn done(&self) {
        assert_eq!(self.at, self.b.len(), "an event has trailing bytes");
    }
}

const EVENT_NAMES: [&str; 6] = ["Created", "Funded", "Ended", "Closed", "RecoveredLate", "RentSwept"];

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
                creator: side_of(c.u8()),
                arbiter: c.key(),
                mint: c.key(),
                vault: c.key(),
                rent_payer: c.key(),
                amount: c.u64(),
                timer_days: c.u16(),
                timer_to: side_of(c.u8()),
                created_at: c.i64(),
            },
            "Funded" => Event::Funded { escrow, balance: c.u64(), funded_at: c.i64() },
            "Ended" => Event::Ended {
                escrow,
                outcome: outcome_of(c.u8()),
                amount: c.u64(),
                balance: c.u64(),
                to_seller: c.u64(),
                to_buyer: c.u64(),
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

/// The `Ended` event in a list: outcome, balance, to the seller, to the buyer, rent returned.
pub fn ended(events: &[Event]) -> (Outcome, u64, u64, u64, u64) {
    let Some(Event::Ended { outcome, balance, to_seller, to_buyer, rent_lamports, .. }) =
        events.iter().find(|e| e.name() == "Ended")
    else {
        panic!("no Ended event in {events:?}")
    };
    (*outcome, *balance, *to_seller, *to_buyer, *rent_lamports)
}

pub fn names(events: &[Event]) -> Vec<&'static str> {
    events.iter().map(|e| e.name()).collect()
}

// ---------------------------------------------------------------------------------------------
// Compute units, gathered across a test run and printed by `zz_cu_summary`.
// ---------------------------------------------------------------------------------------------

pub static CU_RESULTS: Mutex<Vec<(String, u64, usize)>> = Mutex::new(Vec::new());

pub fn record_cu(label: &str, cu: u64, bytes: usize) {
    CU_RESULTS.lock().unwrap().push((label.to_string(), cu, bytes));
}

pub fn print_cu_summary() {
    let results = CU_RESULTS.lock().unwrap();
    if results.is_empty() {
        println!("no compute units recorded (run with --test-threads=1 so the summary runs last)");
        return;
    }
    println!("\n== compute units and bytes, a legacy transaction with a compute-budget instruction ==");
    for (label, cu, bytes) in results.iter() {
        println!(
            "   {label:<52} {cu:>7} compute units ({:.1}% of 1,400,000)   {bytes:>4} bytes ({:.0}% of 1,232)",
            *cu as f64 / 1_400_000.0 * 100.0,
            *bytes as f64 / 1232.0 * 100.0
        );
    }
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
/// 1.00 at six decimals: the standard deal's amount.
pub const AMOUNT: u64 = 1_000_000;
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
    /// The account the buyer pays from: one it owns, but not its standard account. Payouts never
    /// land here; they land at the refund address (`refund()`), which the harness makes empty.
    pub buyer_tokens: Address,
    /// A token account the seller owns, not its standard one: any seller-held account is paid.
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
        svm.airdrop(&arbiter.pubkey(), 1_000_000_000).unwrap();

        let mint = Address::new_unique();
        svm.set_account(mint, spl_mint_account(6, TOKEN_PROGRAM)).unwrap();
        let buyer_tokens = Address::new_unique();
        svm.set_account(buyer_tokens, spl_token_account(&mint, &buyer.pubkey(), BUYER_START)).unwrap();
        // The buyer's refund address, its standard account for the mint, empty and ready.
        svm.set_account(refund_address(&buyer.pubkey(), &mint), spl_token_account(&mint, &buyer.pubkey(), 0)).unwrap();
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
        let result = match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta),
            Err(e) => Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
        };
        self.svm.expire_blockhash();
        result
    }

    /// Sends `ixs` behind a compute-budget instruction, and returns the compute units the
    /// transaction used and its size on the wire. Panics if it fails.
    pub fn measure(&mut self, what: &str, ixs: &[Instruction], signers: &[&Keypair]) -> (u64, usize, Vec<Event>) {
        let mut all = vec![solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_limit(200_000)];
        all.extend_from_slice(ixs);
        self.svm.expire_blockhash();
        let msg = Message::new(&all, Some(&self.payer.pubkey()));
        let mut keys: Vec<&Keypair> = vec![&self.payer];
        keys.extend_from_slice(signers);
        let tx = Transaction::new(&keys, msg, self.svm.latest_blockhash());
        let bytes = bincode::serialize(&tx).unwrap().len();
        let meta = self.send_tx(tx).unwrap_or_else(|e| panic!("{what}: {e}"));
        let cu = meta.compute_units_consumed;
        assert!(bytes <= 1232, "{what}: {bytes} bytes does not fit one transaction");
        assert!(cu < 200_000, "{what}: {cu} compute units");
        record_cu(what, cu, bytes);
        (cu, bytes, events(&meta.logs))
    }

    // -- the standard deal --

    /// Terms with every option off: 1.00 of the mint, no arbiter, no timer.
    pub fn terms(&self, id: u64) -> Terms {
        Terms { id, seller: self.seller.pubkey(), amount: AMOUNT, arbiter: None, timer: None }
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

    /// `create`, opened by the seller as an invoice, signed by the seller and the payer.
    pub fn invoice(&mut self, t: &Terms) -> Result<(Address, litesvm::types::TransactionMetadata), String> {
        let a = self.create_accounts();
        let seller = self.seller.insecure_clone();
        let meta = self.send(&[invoice_ix(t, &a)], &[&seller])?;
        Ok((escrow_address(&a.buyer, t.id), meta))
    }

    /// A plain transfer from the buyer's token account into the deposit account.
    pub fn fund(&mut self, escrow: &Address, amount: u64) {
        let vault = vault_address(escrow, &self.mint);
        let buyer = self.buyer.insecure_clone();
        self.send(&[spl_transfer_ix(self.buyer_tokens, vault, buyer.pubkey(), amount)], &[&buyer])
            .expect("fund");
    }

    pub fn mark_funded(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let vault = vault_address(escrow, &self.mint);
        self.send(&[mark_funded_ix(*escrow, vault)], &[])
    }

    /// Created by the buyer and funded with exactly the amount by a plain transfer, at the current
    /// time. Not marked: no way out needs it.
    pub fn funded(&mut self, t: &Terms) -> Address {
        let (escrow, _) = self.create(t).expect("create");
        self.fund(&escrow, t.amount);
        escrow
    }

    /// The same, and marked funded.
    pub fn marked(&mut self, t: &Terms) -> Address {
        let escrow = self.funded(t);
        self.mark_funded(&escrow).expect("mark_funded");
        escrow
    }

    /// The buyer's refund address for the harness's mint.
    pub fn refund(&self) -> Address {
        refund_address(&self.buyer.pubkey(), &self.mint)
    }

    /// What the buyer holds across the account it pays from and its refund address.
    pub fn buyer_total(&self) -> u64 {
        self.balance(&self.buyer_tokens) + if self.exists(&self.refund()) { self.balance(&self.refund()) } else { 0 }
    }

    /// Take away the buyer's (empty) refund address, as a buyer who closed it would, so a test can
    /// see it made again, or see it is not needed.
    pub fn drop_refund(&mut self) {
        let refund = self.refund();
        assert_eq!(self.balance(&refund), 0, "only an empty account can be closed");
        self.svm.set_account(refund, Account::default()).unwrap();
        assert!(!self.exists(&refund));
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

    pub fn accounts(&self, escrow: &Address) -> Accounts {
        Accounts {
            escrow: *escrow,
            vault: vault_address(escrow, &self.mint),
            buyer_tokens: self.refund(),
            seller_tokens: self.seller_tokens,
            rent_payer: self.payer.pubkey(),
        }
    }

    // -- the ways out, signed by the right keys --

    pub fn release_to_seller(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let buyer = self.buyer.insecure_clone();
        let s = self.accounts(escrow);
        self.send(&[release_to_seller_ix(&s, buyer.pubkey())], &[&buyer])
    }

    pub fn release_to_buyer(&mut self, escrow: &Address) -> Result<litesvm::types::TransactionMetadata, String> {
        let seller = self.seller.insecure_clone();
        let s = self.accounts(escrow);
        self.send(&[release_to_buyer_ix(&s, seller.pubkey())], &[&seller])
    }

    pub fn split(&mut self, escrow: &Address, seller_bps: u16) -> Result<litesvm::types::TransactionMetadata, String> {
        let buyer = self.buyer.insecure_clone();
        let seller = self.seller.insecure_clone();
        let s = self.accounts(escrow);
        self.send(&[split_ix(&s, buyer.pubkey(), seller.pubkey(), seller_bps)], &[&buyer, &seller])
    }

    pub fn arbitrate(&mut self, escrow: &Address, seller_bps: u16) -> Result<litesvm::types::TransactionMetadata, String> {
        let arbiter = self.arbiter.insecure_clone();
        let s = self.accounts(escrow);
        self.send(&[arbitrate_ix(&s, arbiter.pubkey(), seller_bps)], &[&arbiter])
    }

    /// `timer_release`, naming the account of the side `to`: the refund address for the buyer, the
    /// harness's seller account for the seller.
    pub fn timer_release(&mut self, escrow: &Address, to: Side) -> Result<litesvm::types::TransactionMetadata, String> {
        let account = match to {
            Side::Buyer => self.refund(),
            Side::Seller => self.seller_tokens,
        };
        let ix = timer_release_ix(*escrow, vault_address(escrow, &self.mint), account, self.payer.pubkey());
        self.send(&[ix], &[])
    }

    pub fn close_unfunded(&mut self, escrow: &Address, closer: &Keypair) -> Result<litesvm::types::TransactionMetadata, String> {
        let s = self.accounts(escrow);
        self.send(&[close_unfunded_ix(&s, closer.pubkey())], &[closer])
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

    /// Closed for good: no lamports, no data, and owned by the system program (or gone entirely).
    pub fn assert_closed(&self, address: &Address, what: &str) {
        if let Some(a) = self.svm.get_account(address) {
            assert_eq!(a.lamports, 0, "{what}: lamports");
            assert!(a.data.is_empty(), "{what}: data");
            assert_eq!(a.owner, SYSTEM_PROGRAM, "{what}: owner");
        }
    }

    /// Anyone at all, with some SOL to pay for what it makes.
    pub fn someone(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        k
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

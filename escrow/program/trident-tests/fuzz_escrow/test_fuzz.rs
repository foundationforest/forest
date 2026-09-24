//! Adversarial review 1: the escrow under Trident.
//!
//! Random flows against the built program (`../target/deploy/forest_escrow.so`), with a model
//! of every escrow kept beside it. The model is the README's state machine written out a third
//! time: for every instruction the fuzzer sends, it says whether the program must accept it and,
//! if so, exactly what moves. After every step the invariants below are checked.
//!
//! Trident's runtime does not check signatures: an account marked as a signer is taken as signed.
//! So every key here can "sign", and every authority rule has to hold on key comparisons alone.
//!
//! Invariants, from `docs/decisions/adversarial-review-1.md`, with session 11's rules (the seller's
//! acceptance, permanent receipts, `withdraw`, `close_unfunded`, wrapped SOL refused) and session
//! 12's (`recover_late`, `sweep_rent`, `close_unaccepted`, the clock that waits for the funding,
//! `mark_funded` before acceptance) and session 14's (every ending pays the buyer only at its
//! refund address, checked by address, whoever holds that account):
//!   I1 every deposit account holds exactly what was sent to it;
//!   I2 no ending pays out more, or less, than the deposit account held;
//!   I3 rent goes back to the recorded rent payer, to the lamport, and to nobody else: the deposit
//!      account's at every ending, and the escrow account's too only when it never held the amount;
//!      a deposit account made again after the end goes back to the buyer with the late money;
//!   I4 an ended escrow accepts nothing but `recover_late` and `sweep_rent`, even after a later
//!      payment re-creates its deposit account, and its address never opens again;
//!   I5 a buyer's cancellation refund is never below the step's percent of the amount;
//!   I6 no token is created or destroyed: every balance, every buyer's refund address and every
//!      deposit account add up to a constant;
//!   I7 the program accepts exactly what the state machine allows, and refuses everything else;
//!   I8 a receipt, once written, never changes its bytes and never closes;
//!   I9 late money always reaches the buyer: `recover_late` runs whenever an ended escrow's deposit
//!      account exists, and pays exactly what it held to the buyer's refund address;
//!   I10 a sweep never breaches the minimum: every escrow account always holds at least its
//!      rent-exempt minimum, and a sweep leaves exactly that and pays the rest to the rent payer;
//!   I11 an unaccepted escrow past its timeout always returns everything to the buyer: at the end
//!      of every run, each funded escrow nobody accepted is observed, waited out and closed, and
//!      every unit goes to the buyer's refund address.
//!
//! Run: `cargo run --release --bin fuzz_escrow` from this directory (after `cargo build-sbf` in
//! `escrow/program`). `FOREST_FUZZ_ITERATIONS` and `FOREST_FUZZ_FLOWS` set the size;
//! `FUZZING_METRICS=1 FUZZING_JSON=metrics.json` writes Trident's per-instruction outcome counts.

use sha2::{Digest, Sha256};
use trident_fuzz::fuzzing::*;

const PROGRAM_ID: Pubkey = pubkey!("FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT");
const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");
const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const BPS: u16 = 10_000;
const DAY: i64 = 86_400;
const UNACCEPTED_DAYS: i64 = 30;
const T0: i64 = 1_800_000_000;
const START_TOKENS: u64 = 100_000_000_000_000_000;
/// People: two buyers, two sellers, an arbiter, a stranger and a sponsor. Anyone can be anything.
const PEOPLE: usize = 7;
const SPONSOR: usize = 6;

fn disc(namespace: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{namespace}:{name}").as_bytes())[..8].try_into().unwrap()
}

fn share(amount: u64, bps: u16) -> u64 {
    ((u128::from(amount) * u128::from(bps)) / u128::from(BPS)) as u64
}

fn escrow_address(buyer: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"escrow", buyer.as_ref(), &id.to_le_bytes()], &PROGRAM_ID).0
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> AccountSharedData {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    let mut a = AccountSharedData::new(2_039_280, 165, &TOKEN_PROGRAM);
    a.set_data_from_slice(&d);
    a
}

fn mint_account(decimals: u8) -> AccountSharedData {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1;
    let mut a = AccountSharedData::new(1_461_600, 82, &TOKEN_PROGRAM);
    a.set_data_from_slice(&d);
    a
}

#[derive(Clone, Debug)]
struct Deal {
    escrow: Pubkey,
    vault: Pubkey,
    buyer: Pubkey,
    seller: Pubkey,
    arbiter: Option<Pubkey>,
    rent_payer: Pubkey,
    amount: u64,
    service_time: i64,
    silence_days: u16,
    steps: Vec<(i64, u16)>,
    created_at: i64,
    funded_at: i64,
    /// 0 until the seller accepts; the creation time for an invoice.
    accepted_at: i64,
    locked: bool,
    deposited: u64,
    /// Paid out: the escrow account stays as the receipt.
    ended: bool,
    /// Closed without ever holding the amount: both accounts gone, the address free again.
    closed: bool,
    /// The receipt's bytes, as the ending left them. Its lamports may move (a tip in, a sweep out),
    /// never below the minimum.
    receipt: Option<Vec<u8>>,
}

impl Deal {
    fn live(&self) -> bool {
        !self.ended && !self.closed
    }
    fn accepted(&self) -> bool {
        self.accepted_at != 0
    }
    /// The latest of the service time, the funding observation and the acceptance; nothing until
    /// the last two have happened.
    fn clock_start(&self) -> Option<i64> {
        if self.accepted_at == 0 || self.funded_at == 0 {
            return None;
        }
        Some(self.service_time.max(self.funded_at).max(self.accepted_at))
    }
    /// When anyone may send an unaccepted escrow back: the last deadline from the later of the
    /// service time and the funding observation, or 30 days after the observation with no steps.
    /// `Ok(None)` until observed; `Err(())` is an overflow, which the program refuses.
    fn unaccepted_timeout(&self) -> Result<Option<i64>, ()> {
        if self.funded_at == 0 {
            return Ok(None);
        }
        match self.steps.last() {
            Some((o, _)) => self.service_time.max(self.funded_at).checked_add(*o).map(Some).ok_or(()),
            None => self.funded_at.checked_add(UNACCEPTED_DAYS * DAY).map(Some).ok_or(()),
        }
    }
    /// A never-funded escrow's last deadline, from the service time if set, else creation.
    fn unfunded_deadline(&self) -> Option<Option<i64>> {
        let reference = if self.service_time != 0 { self.service_time } else { self.created_at };
        match self.steps.last() {
            None => Some(None),
            Some((o, _)) => reference.checked_add(*o).map(Some),
        }
    }
    fn silence_ends(&self, start: i64) -> Option<i64> {
        start.checked_add(i64::from(self.silence_days) * DAY)
    }
    /// `Err(())` is an overflow, which the program refuses.
    fn current_step(&self, start: i64, now: i64) -> Result<Option<u16>, ()> {
        for (offset, bps) in &self.steps {
            let deadline = start.checked_add(*offset).ok_or(())?;
            if now < deadline {
                return Ok(Some(*bps));
            }
        }
        Ok(None)
    }
}

#[derive(Default, Clone, Copy)]
struct Counts {
    accepted: u64,
    refused: u64,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    people: Vec<Pubkey>,
    tokens: Vec<Pubkey>,
    /// Each person's refund address: their associated token account for the mint. Most people
    /// start with one; the rest get it from `make_refund`, or from `recover_late` or
    /// `close_unaccepted` when a buyer is paid there first. Every ending pays the buyer here and
    /// nowhere else.
    refunds: Vec<Pubkey>,
    /// An escrow account's rent-exempt minimum: what `create` put in the first one. Trident's rent
    /// rate never changes, and every escrow account has the same size.
    escrow_min: u64,
    mint: Pubkey,
    deals: Vec<Deal>,
    total_tokens: u128,
    counts: std::collections::BTreeMap<&'static str, Counts>,
    /// Trident's per-iteration account storage. Unused: the model above keeps every address.
    fuzz_accounts: FuzzAccounts,
}

#[derive(Default)]
struct FuzzAccounts {}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            people: vec![],
            tokens: vec![],
            refunds: vec![],
            escrow_min: 0,
            mint: Pubkey::default(),
            deals: vec![],
            total_tokens: 0,
            counts: Default::default(),
            fuzz_accounts: FuzzAccounts::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.trident.warp_to_timestamp(T0);
        self.people.clear();
        self.tokens.clear();
        self.refunds.clear();
        self.deals.clear();
        self.mint = self.trident.random_pubkey();
        let mint = self.mint;
        self.trident.set_account_custom(&mint, &mint_account(6));
        self.trident.set_account_custom(&NATIVE_MINT, &mint_account(9));
        for _ in 0..PEOPLE {
            let p = self.trident.random_pubkey();
            self.trident.airdrop(&p, 1_000 * LAMPORTS_PER_SOL);
            let t = self.trident.random_pubkey();
            self.trident.set_account_custom(&t, &token_account(&mint, &p, START_TOKENS));
            self.people.push(p);
            self.tokens.push(t);
            let refund = ata(&p, &mint);
            if self.pick(4) != 0 {
                self.trident.set_account_custom(&refund, &token_account(&mint, &p, 0));
            }
            self.refunds.push(refund);
        }
        self.total_tokens = u128::from(START_TOKENS) * PEOPLE as u128;
    }

    // -- flows --------------------------------------------------------------------------------

    #[flow]
    fn create(&mut self) {
        let buyer_i = self.pick(PEOPLE);
        let buyer = self.people[buyer_i];
        let native = self.pick(40) == 0;
        let mint = if native { NATIVE_MINT } else { self.mint };
        // Mostly well-formed terms, so the endings get exercised; each malformed choice ~3%.
        let seller = match self.pick(33) {
            0 => Pubkey::default(),
            1 => buyer,
            _ => self.other_than(buyer_i),
        };
        let arbiter = match self.pick(33) {
            0 => Some(Pubkey::default()),
            1 => Some(buyer),
            2 => Some(seller),
            k if k < 18 => None,
            _ => Some(self.person()),
        };
        let amount = self.amount();
        let now = self.now();
        let service_time = match self.pick(33) {
            0 => Some(0),
            1 => Some(-5),
            2 => Some(i64::MAX - self.trident.random_from_range(0..100)),
            k if k < 20 => None,
            k if k < 26 => Some(now - self.trident.random_from_range(1..10 * DAY)),
            _ => Some(now + self.trident.random_from_range(1..10 * DAY)),
        };
        let silence_days: u16 = match self.pick(33) {
            0 => 0,
            1 => u16::MAX,
            _ => self.trident.random_from_range(1..=7),
        };
        let n = if self.pick(20) == 0 { 5 } else { self.trident.random_from_range(0..=4usize) };
        let mut steps = Vec::new();
        let mut offset: i64 = self.trident.random_from_range(-2 * DAY..3 * DAY);
        for _ in 0..n {
            let bps: u16 = if self.pick(33) == 0 { BPS + 1 } else { self.trident.random_from_range(0..=BPS) };
            steps.push((offset, bps));
            offset = offset.saturating_add(match self.pick(40) {
                0 => 0,                                        // a repeat: must be refused
                1 => -self.trident.random_from_range(1..DAY),  // unsorted: must be refused
                2 => i64::MAX / 2,                             // far future, and overflow later
                _ => self.trident.random_from_range(1..5 * DAY),
            });
        }
        let id: u64 = self.trident.random_from_range(0..6);
        let payer_i = if self.coin() { buyer_i } else { SPONSOR };
        let payer = self.people[payer_i];

        // Who opens it: the buyer, proposing; the seller, invoicing; now and then someone else.
        let creator = match self.pick(20) {
            0 => self.person(),
            k if k < 8 => seller,
            _ => buyer,
        };

        let escrow = escrow_address(&buyer, id);
        let vault = ata(&escrow, &mint);
        // An address is taken while a deal there is live, and for good once one has ended.
        let taken = self.deals.iter().any(|d| d.escrow == escrow && !d.closed);
        let valid = seller != buyer
            && seller != Pubkey::default()
            && (creator == buyer || creator == seller)
            && arbiter.map_or(true, |a| a != Pubkey::default() && a != buyer && a != seller)
            && !native
            && amount > 0
            && silence_days > 0
            && service_time.map_or(true, |t| t > 0)
            && steps.len() <= 4
            && steps.iter().all(|(_, b)| *b <= BPS)
            && steps.windows(2).all(|w| w[1].0 > w[0].0)
            && !taken;

        let mut data = disc("global", "create").to_vec();
        data.extend_from_slice(&id.to_le_bytes());
        data.extend_from_slice(buyer.as_ref());
        data.extend_from_slice(seller.as_ref());
        match arbiter {
            Some(k) => {
                data.push(1);
                data.extend_from_slice(k.as_ref());
            }
            None => data.push(0),
        }
        data.extend_from_slice(&amount.to_le_bytes());
        match service_time {
            Some(t) => {
                data.push(1);
                data.extend_from_slice(&t.to_le_bytes());
            }
            None => data.push(0),
        }
        data.extend_from_slice(&silence_days.to_le_bytes());
        data.extend_from_slice(&(steps.len() as u32).to_le_bytes());
        for (o, b) in &steps {
            data.extend_from_slice(&o.to_le_bytes());
            data.extend_from_slice(&b.to_le_bytes());
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(escrow, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(creator, true),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data,
        };
        let vault_before = self.trident.get_account(&vault);
        let prefunded = token_amount_of(&vault_before);
        let payer_before = self.lamports(&payer);
        let ok = self.send(&[ix], "create");
        assert_eq!(ok, valid, "I7 create: model says {valid}, program said {ok}");
        if !ok {
            return;
        }
        // Rent: the payer paid for the escrow account, and for the deposit account if create made it.
        let paid = payer_before - self.lamports(&payer);
        let made_vault = if vault_before.lamports() == 0 { self.lamports(&vault) } else { 0 };
        assert_eq!(paid, self.lamports(&escrow) + made_vault, "I3 create: the payer paid both rents and nothing else");
        if self.escrow_min == 0 {
            self.escrow_min = self.lamports(&escrow);
        }
        assert_eq!(self.lamports(&escrow), self.escrow_min, "I10 create: an escrow account starts at its minimum");
        let invoice = creator == seller;
        let funded_at = if invoice && prefunded >= amount { now } else { 0 };
        self.deals.push(Deal {
            escrow,
            vault,
            buyer,
            seller,
            arbiter,
            rent_payer: payer,
            amount,
            service_time: service_time.unwrap_or(0),
            silence_days,
            steps,
            created_at: now,
            funded_at,
            accepted_at: if invoice { now } else { 0 },
            locked: false,
            deposited: prefunded,
            ended: false,
            closed: false,
            receipt: None,
        });
    }

    /// The seller accepts, usually; sometimes someone else tries.
    #[flow]
    fn accept(&mut self) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        let actor = self.actor_for(&d, "accept");
        let balance = self.vault_balance(&d);
        let vault_exists = self.trident.get_account(&d.vault).lamports() > 0;
        let valid = d.live() && vault_exists && !d.accepted() && actor == d.seller;
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(d.escrow, false),
                AccountMeta::new_readonly(d.vault, false),
                AccountMeta::new_readonly(actor, true),
            ],
            data: disc("global", "accept").to_vec(),
        };
        // Trident's runtime moves its clock on by the wall-clock seconds that pass after each
        // transaction, so the time the program saw is the one read before sending, not after.
        let now = self.now();
        let ok = self.send(&[ix], "accept");
        assert_eq!(ok, valid, "I4/I7 accept: model {valid}, program {ok}");
        if ok {
            self.deals[i].accepted_at = now;
            if d.funded_at == 0 && balance >= d.amount {
                self.deals[i].funded_at = now;
            }
        }
    }

    /// A plain transfer into a deposit account, from anyone. If the deposit account does not exist
    /// yet (a deal not created, or one that ended), a wallet would create it first: so does this.
    #[flow]
    fn deposit(&mut self) {
        let Some(d) = self.any_deal() else { return };
        let from = self.pick(PEOPLE);
        let have = self.vault_balance(&d);
        let amount = match self.pick(6) {
            0 | 1 | 2 => d.amount.saturating_sub(have).max(1), // exactly enough
            3 => d.amount.saturating_sub(have).saturating_sub(1).max(1), // one short
            4 => self.trident.random_from_range(1..1_000),
            _ => self.amount(),
        }
        .min(START_TOKENS / 1000);
        if amount == 0 {
            return;
        }
        let mut ixs = vec![];
        if self.trident.get_account(&d.vault).lamports() == 0 {
            ixs.push(Instruction {
                program_id: ATA_PROGRAM,
                accounts: vec![
                    AccountMeta::new(self.people[from], true),
                    AccountMeta::new(d.vault, false),
                    AccountMeta::new_readonly(d.escrow, false),
                    AccountMeta::new_readonly(self.mint, false),
                    AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                    AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                ],
                data: vec![1],
            });
        }
        let mut data = vec![3u8];
        data.extend_from_slice(&amount.to_le_bytes());
        ixs.push(Instruction {
            program_id: TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(self.tokens[from], false),
                AccountMeta::new(d.vault, false),
                AccountMeta::new_readonly(self.people[from], true),
            ],
            data,
        });
        let ok = self.send(&ixs, "deposit");
        assert!(ok, "a plain transfer to a deposit address must land");
        // The newest deal at this address owns what arrives, live or not. An ended one's deposit
        // account is stranded for good, since its address never reopens; a never-funded one that
        // was closed keeps it until the same buyer reopens the id, which adopts it.
        let latest = self.latest_at(&d.escrow);
        self.deals[latest].deposited += amount;
    }

    /// Anyone makes someone's refund address, the standard idempotent way: what the sender of an
    /// ending does first when the buyer has none.
    #[flow]
    fn make_refund(&mut self) {
        let owner_i = self.pick(PEOPLE);
        let payer_i = self.pick(PEOPLE);
        let ix = Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(self.people[payer_i], true),
                AccountMeta::new(self.refunds[owner_i], false),
                AccountMeta::new_readonly(self.people[owner_i], false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            ],
            data: vec![1],
        };
        let ok = self.send(&[ix], "make_refund");
        assert!(ok, "making a standard token account, or finding it there, must land");
    }

    /// What a buyer's app does: send exactly what is missing and record it, in one transaction.
    #[flow]
    fn fund_and_mark(&mut self) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        if !d.live() {
            return;
        }
        let have = self.vault_balance(&d);
        let missing = d.amount.saturating_sub(have);
        let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
        let mut ixs = vec![];
        if missing > 0 {
            let mut data = vec![3u8];
            data.extend_from_slice(&missing.to_le_bytes());
            ixs.push(Instruction {
                program_id: TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(self.tokens[buyer_i], false),
                    AccountMeta::new(d.vault, false),
                    AccountMeta::new_readonly(d.buyer, true),
                ],
                data,
            });
        }
        // The funding can be observed before the seller accepts, too.
        let marks = d.funded_at == 0;
        if marks {
            ixs.push(Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![AccountMeta::new(d.escrow, false), AccountMeta::new_readonly(d.vault, false)],
                data: disc("global", "mark_funded").to_vec(),
            });
        }
        if ixs.is_empty() {
            return;
        }
        let now = self.now();
        let ok = self.send(&ixs, "fund_and_mark");
        assert!(ok, "I7 fund_and_mark: exactly the missing amount, then mark_funded, must land");
        self.deals[i].deposited += missing;
        if marks {
            self.deals[i].funded_at = now;
        }
    }

    #[flow]
    fn mark_funded(&mut self) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        let balance = self.vault_balance(&d);
        let valid = d.live() && d.funded_at == 0 && balance >= d.amount;
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(d.escrow, false), AccountMeta::new_readonly(d.vault, false)],
            data: disc("global", "mark_funded").to_vec(),
        };
        let now = self.now();
        let ok = self.send(&[ix], "mark_funded");
        assert_eq!(ok, valid, "I4/I7 mark_funded: model {valid}, program {ok}");
        if ok {
            self.deals[i].funded_at = now;
        }
    }

    #[flow]
    fn object(&mut self) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        let actor = self.actor_for(&d, "object");
        let now = self.now();
        let balance = self.vault_balance(&d);
        let valid = (|| {
            if !d.live() || !d.accepted() || actor != d.buyer || d.locked || balance < d.amount {
                return false;
            }
            let mut dd = d.clone();
            if dd.funded_at == 0 {
                dd.funded_at = now;
            }
            let Some(start) = dd.clock_start() else { return false };
            match dd.silence_ends(start) {
                Some(ends) => now <= ends,
                None => false,
            }
        })();
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(d.escrow, false),
                AccountMeta::new_readonly(d.vault, false),
                AccountMeta::new_readonly(actor, true),
            ],
            data: disc("global", "object").to_vec(),
        };
        let ok = self.send(&[ix], "object");
        assert_eq!(ok, valid, "I4/I7 object: model {valid}, program {ok}");
        if ok {
            if self.deals[i].funded_at == 0 {
                self.deals[i].funded_at = now;
            }
            self.deals[i].locked = true;
        }
    }

    #[flow]
    fn approve(&mut self) {
        self.ending("approve");
    }
    #[flow]
    fn release_by_silence(&mut self) {
        self.ending("release_by_silence");
    }
    #[flow]
    fn agree(&mut self) {
        self.ending("agree");
    }
    #[flow]
    fn arbitrate(&mut self) {
        self.ending("arbitrate");
    }
    #[flow]
    fn cancel_buyer(&mut self) {
        self.ending("cancel_buyer");
    }
    #[flow]
    fn cancel_seller(&mut self) {
        self.ending("cancel_seller");
    }
    #[flow]
    fn withdraw(&mut self) {
        self.ending("withdraw");
    }
    #[flow]
    fn close_unfunded(&mut self) {
        self.ending("close_unfunded");
    }

    /// SOL sent to an escrow's address, live or ended. It never counts as funding; a sweep takes it
    /// out again, to the rent payer. Closed addresses are left alone: a tip there would pre-fund an
    /// address a later `create` may use, which is not what this model counts.
    #[flow]
    fn tip(&mut self) {
        let Some(d) = self.any_deal() else { return };
        let d = self.deals[self.latest_at(&d.escrow)].clone();
        if d.closed {
            return;
        }
        let from = self.person();
        let lamports: u64 = self.trident.random_from_range(1..10_000_000);
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend_from_slice(&lamports.to_le_bytes());
        let ix = Instruction {
            program_id: SYSTEM_PROGRAM,
            accounts: vec![AccountMeta::new(from, true), AccountMeta::new(d.escrow, false)],
            data,
        };
        let ok = self.send(&[ix], "tip");
        assert!(ok, "a plain SOL transfer to an escrow's address lands");
    }

    /// Rent above the minimum back to the rent payer; anyone sends it, on any escrow.
    #[flow]
    fn sweep_rent(&mut self) {
        let Some(d) = self.any_deal() else { return };
        let i = self.latest_at(&d.escrow);
        let d = self.deals[i].clone();
        let payer_i = self.people.iter().position(|p| *p == d.rent_payer).unwrap();
        let rp_i = if self.pick(10) == 0 { self.pick(PEOPLE) } else { payer_i };
        let lamports = self.lamports(&d.escrow);
        let excess = lamports.saturating_sub(self.escrow_min);
        let valid = !d.closed && lamports > 0 && rp_i == payer_i && excess > 0;
        let before: Vec<u64> = (0..PEOPLE).map(|k| self.lamports(&self.people[k].clone())).collect();
        let bytes = self.trident.get_account(&d.escrow).data().to_vec();
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(d.escrow, false), AccountMeta::new(self.people[rp_i], false)],
            data: disc("global", "sweep_rent").to_vec(),
        };
        let ok = self.send(&[ix], "sweep_rent");
        assert_eq!(ok, valid, "I7/I10 sweep_rent: model {valid}, program {ok} (deal {d:?}, lamports {lamports})");
        if !ok {
            return;
        }
        assert_eq!(self.lamports(&d.escrow), self.escrow_min, "I10 sweep_rent: exactly the minimum left");
        for k in 0..PEOPLE {
            let want = if k == payer_i { before[k] + excess } else { before[k] };
            assert_eq!(self.lamports(&self.people[k].clone()), want, "I3/I10 sweep_rent: the excess to the rent payer and nobody else (person {k})");
        }
        assert_eq!(self.trident.get_account(&d.escrow).data(), &bytes[..], "I8/I10 sweep_rent: the bytes do not change");
    }

    /// Late money back to the buyer. Anyone sends it, usually on an ended escrow, usually naming
    /// the buyer's refund address.
    #[flow]
    fn recover_late(&mut self) {
        let Some(i) = self.ended_deal().or_else(|| self.latest_deal()) else { return };
        let d = self.deals[i].clone();
        let caller_i = self.pick(PEOPLE);
        let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
        let buyer_key = if self.pick(20) == 0 { self.person() } else { d.buyer };
        let refund = match self.pick(20) {
            0 => self.tokens[buyer_i], // the buyer's, but not its standard account
            1 => self.refunds[caller_i],
            _ => self.refunds[buyer_i],
        };
        let vault_exists = self.lamports(&d.vault) > 0;
        let valid = d.ended && vault_exists && buyer_key == d.buyer && refund == self.refunds[buyer_i];

        let late = self.vault_balance(&d);
        let vault_lamports = self.lamports(&d.vault);
        let refund_existed = self.lamports(&self.refunds[buyer_i].clone()) > 0;
        let before_ref = self.token_balance(&self.refunds[buyer_i].clone());
        let before: Vec<u64> = (0..PEOPLE).map(|k| self.lamports(&self.people[k].clone())).collect();
        let escrow_before = self.trident.get_account(&d.escrow);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(d.escrow, false),
                AccountMeta::new(d.vault, false),
                AccountMeta::new(buyer_key, false),
                AccountMeta::new(refund, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.people[caller_i], true),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: disc("global", "recover_late").to_vec(),
        };
        let ok = self.send(&[ix], "recover_late");
        assert_eq!(ok, valid, "I4/I7/I9 recover_late: model {valid}, program {ok} (deal {d:?})");
        if !ok {
            return;
        }
        assert_eq!(late, d.deposited, "I1 recover_late: the deposit account held exactly what was sent after the end");
        let got = self.token_balance(&self.refunds[buyer_i].clone()) - before_ref;
        assert_eq!(got, late, "I9 recover_late: every late unit to the buyer's refund address");
        assert_eq!(self.lamports(&d.vault), 0, "recover_late: the deposit account closed again");
        let made = if refund_existed { 0 } else { self.lamports(&self.refunds[buyer_i].clone()) };
        for k in 0..PEOPLE {
            let mut want = before[k];
            if k == buyer_i {
                want += vault_lamports;
            }
            if k == caller_i {
                want -= made;
            }
            assert_eq!(
                self.lamports(&self.people[k].clone()),
                want,
                "I3 recover_late: the deposit account's rent to the buyer, the refund address paid for by the caller (person {k})"
            );
        }
        let escrow_after = self.trident.get_account(&d.escrow);
        assert_eq!(escrow_after.data(), escrow_before.data(), "I8 recover_late: the receipt does not change");
        assert_eq!(escrow_after.lamports(), escrow_before.lamports(), "I8 recover_late: nor its lamports");
        self.deals[i].deposited = 0;
    }

    /// Everything back from a funded escrow the seller never accepted, after its timeout. Anyone
    /// sends it, usually naming the buyer's refund address and the recorded rent payer.
    #[flow]
    fn close_unaccepted(&mut self) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        let now = self.now();
        let caller_i = self.pick(PEOPLE);
        let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
        let payer_i = self.people.iter().position(|p| *p == d.rent_payer).unwrap();
        let buyer_key = if self.pick(20) == 0 { self.person() } else { d.buyer };
        let refund = match self.pick(20) {
            0 => self.tokens[buyer_i],
            1 => self.refunds[caller_i],
            _ => self.refunds[buyer_i],
        };
        let rp_i = if self.pick(20) == 0 { self.pick(PEOPLE) } else { payer_i };
        let balance = self.vault_balance(&d);
        let accounts_right = buyer_key == d.buyer && refund == self.refunds[buyer_i] && rp_i == payer_i;
        let valid = d.live()
            && accounts_right
            && !d.accepted()
            && balance >= d.amount
            && matches!(d.unaccepted_timeout(), Ok(Some(t)) if now > t);
        self.send_close_unaccepted(i, caller_i, buyer_key, refund, rp_i, valid, now);
    }

    /// Time moves: by a random stretch, or to a second either side of a deal's own boundary.
    #[flow]
    fn time_passes(&mut self) {
        let target = match (self.pick(3), self.latest_deal()) {
            (0, Some(i)) => {
                let d = self.deals[i].clone();
                let start = d.clock_start().unwrap_or(d.created_at);
                let mut marks: Vec<i64> = d.silence_ends(start).into_iter().collect();
                marks.extend(d.steps.iter().filter_map(|(o, _)| start.checked_add(*o)));
                if let Some(Some(deadline)) = d.unfunded_deadline() {
                    marks.push(deadline);
                }
                if let Ok(Some(timeout)) = d.unaccepted_timeout() {
                    marks.push(timeout);
                }
                if marks.is_empty() {
                    return;
                }
                let m = marks[self.pick(marks.len())];
                m.saturating_add(self.trident.random_from_range(-1..=1))
            }
            _ => self.now().saturating_add(match self.pick(4) {
                0 => self.trident.random_from_range(1..120),
                1 => self.trident.random_from_range(1..DAY),
                _ => self.trident.random_from_range(1..8 * DAY),
            }),
        };
        // The cluster clock never runs backwards.
        if target > self.now() && target < T0 + 100_000 * DAY {
            self.trident.warp_to_timestamp(target);
        }
    }

    #[end]
    fn end(&mut self) {
        self.every_unaccepted_escrow_comes_back();
        self.check_everything();
        let mut all = std::collections::BTreeMap::new();
        std::mem::swap(&mut all, &mut self.counts);
        for (k, c) in all {
            self.trident.record_accumulator(&format!("{k} accepted"), c.accepted as f64);
            self.trident.record_accumulator(&format!("{k} refused"), c.refused as f64);
        }
    }

    // -- the endings ----------------------------------------------------------------------------

    fn ending(&mut self, name: &'static str) {
        let Some(i) = self.latest_deal() else { return };
        let d = self.deals[i].clone();
        let now = self.now();
        let balance = self.vault_balance(&d);
        let actor = self.actor_for(&d, name);
        let second = if self.pick(4) == 0 { self.person() } else { d.seller };
        let bps: u16 = match self.pick(5) {
            0 => BPS + self.trident.random_from_range(1..100),
            1 => 0,
            2 => BPS,
            _ => self.trident.random_from_range(0..=BPS),
        };
        let refund = name == "withdraw" || name == "close_unfunded";

        // Which token accounts and rent payer the sender names: usually the right ones. The two
        // exits that pay the seller nothing name no seller account at all.
        let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
        let seller_i = self.people.iter().position(|p| *p == d.seller).unwrap();
        let payer_i = self.people.iter().position(|p| *p == d.rent_payer).unwrap();
        // The buyer's slot: its refund address, or now and then another account the buyer owns, or
        // anyone's. Only the refund address is right (session 14), and it must exist.
        let buyer_account = match self.pick(20) {
            0 => self.tokens[buyer_i],
            1 => {
                let k = self.pick(PEOPLE);
                if self.coin() { self.refunds[k] } else { self.tokens[k] }
            }
            _ => self.refunds[buyer_i],
        };
        let st_i = if !refund && self.pick(20) == 0 { self.pick(PEOPLE) } else { seller_i };
        let rp_i = if self.pick(20) == 0 { self.pick(PEOPLE) } else { payer_i };
        let accounts_right = buyer_account == self.refunds[buyer_i] && st_i == seller_i && rp_i == payer_i;
        let refund_exists = self.lamports(&self.refunds[buyer_i].clone()) > 0;
        let vault_exists = self.trident.get_account(&d.vault).lamports() > 0;

        let funded = balance >= d.amount;
        let accepted = d.accepted();
        // (valid, to_seller)
        let expect: (bool, u64) = if !d.live() || !accounts_right || !refund_exists || !vault_exists {
            (false, 0)
        } else {
            match name {
                "approve" => (
                    actor == d.buyer && !d.locked && bps <= BPS && funded && (accepted || bps == BPS),
                    share(d.amount, bps),
                ),
                "agree" => (accepted && actor == d.buyer && second == d.seller && bps <= BPS && funded, share(d.amount, bps)),
                "arbitrate" => (
                    accepted && d.arbiter.is_some() && Some(actor) == d.arbiter && bps <= BPS && funded,
                    share(d.amount, bps),
                ),
                "release_by_silence" => {
                    let ok = accepted
                        && !d.locked
                        && funded
                        && d.clock_start().and_then(|s| d.silence_ends(s)).map_or(false, |ends| now > ends);
                    (ok, d.amount)
                }
                "cancel_buyer" => {
                    if !accepted || actor != d.buyer || d.locked || !funded {
                        (false, 0)
                    } else {
                        match d.clock_start().map(|s| d.current_step(s, now)) {
                            Some(Ok(Some(refund))) => (true, share(d.amount, BPS - refund)),
                            _ => (false, 0),
                        }
                    }
                }
                "cancel_seller" => (accepted && actor == d.seller && funded, 0),
                "withdraw" => (!accepted && actor == d.buyer && funded, 0),
                "close_unfunded" => {
                    let ok = !funded
                        && (actor == d.buyer
                            || actor == d.seller
                            || (actor == d.rent_payer
                                && match d.unfunded_deadline() {
                                    Some(None) => true,
                                    Some(Some(deadline)) => now > deadline,
                                    None => false,
                                }));
                    (ok, 0)
                }
                _ => unreachable!(),
            }
        };

        let mut metas = vec![
            AccountMeta::new(d.escrow, false),
            AccountMeta::new(d.vault, false),
            AccountMeta::new(buyer_account, false),
        ];
        if !refund {
            metas.push(AccountMeta::new(self.tokens[st_i], false));
        }
        metas.push(AccountMeta::new(self.people[rp_i], false));
        metas.push(AccountMeta::new_readonly(TOKEN_PROGRAM, false));
        let mut data = disc("global", name).to_vec();
        match name {
            "release_by_silence" => {}
            "agree" => {
                metas.push(AccountMeta::new_readonly(actor, true));
                metas.push(AccountMeta::new_readonly(second, true));
                data.extend_from_slice(&bps.to_le_bytes());
            }
            "approve" | "arbitrate" => {
                metas.push(AccountMeta::new_readonly(actor, true));
                data.extend_from_slice(&bps.to_le_bytes());
            }
            _ => metas.push(AccountMeta::new_readonly(actor, true)),
        }
        let before_b = self.token_balance(&self.refunds[buyer_i].clone());
        let before_s = self.token_balance(&self.tokens[seller_i].clone());
        let escrow_rent = self.lamports(&d.escrow);
        let vault_rent = self.lamports(&d.vault);
        let before_rp: Vec<u64> = (0..PEOPLE).map(|k| self.lamports(&self.people[k].clone())).collect();

        let ok = self.send(&[Instruction { program_id: PROGRAM_ID, accounts: metas, data }], name);
        let (valid, to_seller) = expect;
        assert_eq!(ok, valid, "I4/I7 {name}: model {valid}, program {ok} (deal {d:?}, balance {balance}, now {now})");
        if !ok {
            return;
        }
        let got_s = self.token_balance(&self.tokens[seller_i].clone()) - before_s;
        let got_b = self.token_balance(&self.refunds[buyer_i].clone()) - before_b;
        assert_eq!(got_s, to_seller, "{name}: the seller's share");
        assert_eq!(got_b + got_s, balance, "I2 {name}: every unit the deposit account held, and no more");
        assert_eq!(balance, d.deposited, "I1 {name}: the deposit account held exactly what was sent");
        if name == "cancel_buyer" {
            let bps = d.clock_start().and_then(|s| d.current_step(s, now).ok().flatten()).unwrap();
            assert!(
                u128::from(d.amount - to_seller) * u128::from(BPS) >= u128::from(d.amount) * u128::from(bps),
                "I5 cancel_buyer: refund {} of {} is below {bps} bps",
                d.amount - to_seller,
                d.amount
            );
        }
        // A never-funded escrow gives both rents back and leaves nothing; every other ending gives
        // back the deposit account's and keeps the escrow account as the receipt.
        let returned = if name == "close_unfunded" { escrow_rent + vault_rent } else { vault_rent };
        for k in 0..PEOPLE {
            let now_l = self.lamports(&self.people[k].clone());
            let want = if k == payer_i { before_rp[k] + returned } else { before_rp[k] };
            assert_eq!(now_l, want, "I3 {name}: rent to the rent payer and to nobody else (person {k})");
        }
        assert_eq!(self.lamports(&d.vault), 0, "{name}: deposit account closed");
        if name == "close_unfunded" {
            assert_eq!(self.lamports(&d.escrow), 0, "{name}: an escrow that never held the amount leaves nothing");
            self.deals[i].closed = true;
        } else {
            let account = self.trident.get_account(&d.escrow);
            assert_eq!(account.lamports(), escrow_rent, "I3/I8 {name}: the receipt keeps its own rent");
            let b = &account.data()[8..];
            let outcome = ["approve", "release_by_silence", "agree", "arbitrate", "cancel_buyer", "cancel_seller", "withdraw"]
                .iter()
                .position(|n| *n == name)
                .unwrap() as u8;
            assert_eq!(b[276], 4, "I8 {name}: the receipt says Ended");
            assert_eq!(b[294], outcome, "I8 {name}: the receipt's outcome");
            assert_eq!(u64::from_le_bytes(b[295..303].try_into().unwrap()), to_seller, "I8 {name}: to the seller");
            assert_eq!(u64::from_le_bytes(b[303..311].try_into().unwrap()), balance - to_seller, "I8 {name}: to the buyer");
            assert_eq!(i64::from_le_bytes(b[278..286].try_into().unwrap()), d.accepted_at, "I8 {name}: when the seller accepted, or never");
            assert_eq!(i64::from_le_bytes(b[268..276].try_into().unwrap()), d.funded_at, "I8 {name}: when the funding was observed");
            self.deals[i].ended = true;
            self.deals[i].receipt = Some(account.data().to_vec());
        }
        self.deals[i].deposited = 0;
    }

    /// I11. Every funded escrow nobody accepted comes back to its buyer: observed if nobody had,
    /// waited out, and closed by the sponsor, every unit to the buyer's refund address. Exempt only
    /// a timeout the program refuses as an overflow, or one past the end of the model's clock
    /// (the same bound `time_passes` keeps); `close_unaccepted`'s flow checks both refusals.
    fn every_unaccepted_escrow_comes_back(&mut self) {
        for i in 0..self.deals.len() {
            let d = self.deals[i].clone();
            if !d.live() || d.accepted() || self.vault_balance(&d) < d.amount {
                continue;
            }
            if d.funded_at == 0 {
                let now = self.now();
                let ix = Instruction {
                    program_id: PROGRAM_ID,
                    accounts: vec![AccountMeta::new(d.escrow, false), AccountMeta::new_readonly(d.vault, false)],
                    data: disc("global", "mark_funded").to_vec(),
                };
                let ok = self.send(&[ix], "mark_funded");
                assert!(ok, "I11: anyone can observe the funding of an escrow nobody accepted");
                self.deals[i].funded_at = now;
            }
            let d = self.deals[i].clone();
            let Ok(Some(timeout)) = d.unaccepted_timeout() else { continue };
            if timeout >= T0 + 100_000 * DAY {
                continue;
            }
            if self.now() <= timeout {
                self.trident.warp_to_timestamp(timeout + 1);
            }
            let now = self.now();
            let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
            let payer_i = self.people.iter().position(|p| *p == d.rent_payer).unwrap();
            let refund = self.refunds[buyer_i];
            self.send_close_unaccepted(i, SPONSOR, d.buyer, refund, payer_i, true, now);
            self.trident.record_accumulator("I11 unaccepted escrows sent back", 1.0);
        }
    }

    /// Sends `close_unaccepted` for deal `i` with the accounts given, checks the program agrees
    /// with `valid`, and, when it lands, that every unit went to the buyer's refund address, the
    /// deposit account's rent to the rent payer, and the receipt says `NeverAccepted`.
    #[allow(clippy::too_many_arguments)]
    fn send_close_unaccepted(&mut self, i: usize, caller_i: usize, buyer_key: Pubkey, refund: Pubkey, rp_i: usize, valid: bool, now: i64) {
        let d = self.deals[i].clone();
        let buyer_i = self.people.iter().position(|p| *p == d.buyer).unwrap();
        let payer_i = self.people.iter().position(|p| *p == d.rent_payer).unwrap();
        let balance = self.vault_balance(&d);
        let vault_lamports = self.lamports(&d.vault);
        let escrow_lamports = self.lamports(&d.escrow);
        let refund_existed = self.lamports(&self.refunds[buyer_i].clone()) > 0;
        let before_ref = self.token_balance(&self.refunds[buyer_i].clone());
        let before: Vec<u64> = (0..PEOPLE).map(|k| self.lamports(&self.people[k].clone())).collect();
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(d.escrow, false),
                AccountMeta::new(d.vault, false),
                AccountMeta::new_readonly(buyer_key, false),
                AccountMeta::new(refund, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.people[rp_i], false),
                AccountMeta::new(self.people[caller_i], true),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(ATA_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: disc("global", "close_unaccepted").to_vec(),
        };
        let ok = self.send(&[ix], "close_unaccepted");
        assert_eq!(ok, valid, "I4/I7/I11 close_unaccepted: model {valid}, program {ok} (deal {d:?}, balance {balance}, now {now})");
        if !ok {
            return;
        }
        assert_eq!(balance, d.deposited, "I1 close_unaccepted: the deposit account held exactly what was sent");
        let got = self.token_balance(&self.refunds[buyer_i].clone()) - before_ref;
        assert_eq!(got, balance, "I2/I11 close_unaccepted: every unit to the buyer's refund address");
        assert_eq!(self.lamports(&d.vault), 0, "close_unaccepted: deposit account closed");
        let made = if refund_existed { 0 } else { self.lamports(&self.refunds[buyer_i].clone()) };
        for k in 0..PEOPLE {
            let mut want = before[k];
            if k == payer_i {
                want += vault_lamports;
            }
            if k == caller_i {
                want -= made;
            }
            assert_eq!(
                self.lamports(&self.people[k].clone()),
                want,
                "I3 close_unaccepted: the deposit account's rent to the rent payer, the refund address paid for by the caller (person {k})"
            );
        }
        let account = self.trident.get_account(&d.escrow);
        assert_eq!(account.lamports(), escrow_lamports, "I3/I8 close_unaccepted: the receipt keeps its own rent");
        let b = &account.data()[8..];
        assert_eq!(b[276], 4, "I8 close_unaccepted: the receipt says Ended");
        assert_eq!(b[294], 7, "I8 close_unaccepted: the outcome is NeverAccepted");
        assert_eq!(u64::from_le_bytes(b[295..303].try_into().unwrap()), 0, "I8 close_unaccepted: nothing to the seller");
        assert_eq!(u64::from_le_bytes(b[303..311].try_into().unwrap()), balance, "I8 close_unaccepted: everything to the buyer");
        assert_eq!(i64::from_le_bytes(b[278..286].try_into().unwrap()), 0, "I8 close_unaccepted: never accepted");
        assert_eq!(i64::from_le_bytes(b[268..276].try_into().unwrap()), d.funded_at, "I8 close_unaccepted: when the funding was observed");
        self.deals[i].ended = true;
        self.deals[i].receipt = Some(account.data().to_vec());
        self.deals[i].deposited = 0;
    }

    // -- invariants -----------------------------------------------------------------------------

    fn check_everything(&mut self) {
        let mut in_vaults: u128 = 0;
        let mut seen = std::collections::HashSet::new();
        for d in self.deals.clone() {
            if !seen.insert(d.vault) {
                continue; // one deposit account per address; the newest deal holds its count
            }
            let latest = &self.deals[self.latest_at(&d.escrow)];
            let bal = token_amount_of(&self.trident.get_account(&d.vault));
            assert_eq!(bal, latest.deposited, "I1: deposit account {} holds what was sent", d.vault);
            in_vaults += u128::from(bal);
        }
        let held: u128 = (0..PEOPLE)
            .map(|k| u128::from(self.token_balance(&self.tokens[k].clone())) + u128::from(self.token_balance(&self.refunds[k].clone())))
            .sum();
        assert_eq!(held + in_vaults, self.total_tokens, "I6: no token created or destroyed");
        for d in self.deals.clone() {
            if d.closed {
                continue;
            }
            let now = self.trident.get_account(&d.escrow);
            assert!(now.lamports() >= self.escrow_min, "I10: escrow {} holds {} < its minimum {}", d.escrow, now.lamports(), self.escrow_min);
            if let Some(data) = &d.receipt {
                assert_eq!(now.data(), &data[..], "I8: receipt {} keeps its bytes", d.escrow);
            }
        }
        self.trident.record_accumulator("invariant checks", 1.0);
    }

    // -- helpers ----------------------------------------------------------------------------------

    fn send(&mut self, ixs: &[Instruction], name: &'static str) -> bool {
        let r = self.trident.process_transaction(ixs, Some(name));
        let ok = r.is_success();
        let c = self.counts.entry(name).or_default();
        if ok {
            c.accepted += 1;
        } else {
            c.refused += 1;
        }
        ok
    }

    fn person(&mut self) -> Pubkey {
        let k = self.pick(PEOPLE);
        self.people[k]
    }
    fn pick(&mut self, n: usize) -> usize {
        self.trident.random_from_range(0..n)
    }
    fn coin(&mut self) -> bool {
        self.trident.random_bool()
    }
    fn now(&self) -> i64 {
        self.trident.get_current_timestamp()
    }
    fn lamports(&mut self, k: &Pubkey) -> u64 {
        self.trident.get_account(k).lamports()
    }
    fn token_balance(&mut self, k: &Pubkey) -> u64 {
        token_amount_of(&self.trident.get_account(k))
    }
    fn vault_balance(&mut self, d: &Deal) -> u64 {
        token_amount_of(&self.trident.get_account(&d.vault))
    }
    fn amount(&mut self) -> u64 {
        match self.pick(18) {
            0 => 0,
            6..=17 => self.trident.random_from_range(1..10_000_000),
            1 => 1,
            2 => self.trident.random_from_range(2..10),
            3 => self.trident.random_from_range(1..1_000_000_000_000),
            4 => START_TOKENS / 1000,
            _ => self.trident.random_from_range(1..10_000_000),
        }
    }
    /// Who sends an instruction: usually the key the rules want, sometimes any party, sometimes anyone.
    fn actor_for(&mut self, d: &Deal, name: &str) -> Pubkey {
        let right = match name {
            "cancel_seller" | "accept" => d.seller,
            "arbitrate" => d.arbiter.unwrap_or(d.buyer),
            "close_unfunded" => match self.pick(3) {
                0 => d.buyer,
                1 => d.seller,
                _ => d.rent_payer,
            },
            _ => d.buyer,
        };
        match self.pick(10) {
            0 => d.buyer,
            1 => d.seller,
            2 | 3 => self.person(),
            _ => right,
        }
    }
    fn other_than(&mut self, i: usize) -> Pubkey {
        let k = (i + 1 + self.pick(PEOPLE - 1)) % PEOPLE;
        self.people[k]
    }
    fn any_deal(&mut self) -> Option<Deal> {
        if self.deals.is_empty() {
            return None;
        }
        let i = self.pick(self.deals.len());
        Some(self.deals[i].clone())
    }
    /// A deal to act on: usually a live one, sometimes the newest at any address, ended or not.
    fn latest_deal(&mut self) -> Option<usize> {
        if self.deals.is_empty() {
            return None;
        }
        let live: Vec<usize> = (0..self.deals.len()).filter(|&k| self.deals[k].live()).collect();
        if !live.is_empty() && self.pick(5) != 0 {
            let k = self.pick(live.len());
            return Some(live[k]);
        }
        let i = self.pick(self.deals.len());
        Some(self.latest_at(&self.deals[i].escrow.clone()))
    }
    /// An ended deal, three times in four when there is one: the deals `recover_late` is for.
    fn ended_deal(&mut self) -> Option<usize> {
        let ended: Vec<usize> = (0..self.deals.len()).filter(|&k| self.deals[k].ended).collect();
        if ended.is_empty() || self.pick(4) == 0 {
            return None;
        }
        let k = self.pick(ended.len());
        Some(ended[k])
    }
    fn latest_at(&self, escrow: &Pubkey) -> usize {
        self.deals.iter().rposition(|d| d.escrow == *escrow).unwrap()
    }
}

fn token_amount_of(a: &AccountSharedData) -> u64 {
    if a.lamports() == 0 || a.data().len() < 72 {
        return 0;
    }
    u64::from_le_bytes(a.data()[64..72].try_into().unwrap())
}

fn main() {
    let iterations = std::env::var("FOREST_FUZZ_ITERATIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(1_000);
    let flows = std::env::var("FOREST_FUZZ_FLOWS").ok().and_then(|v| v.parse().ok()).unwrap_or(80);
    FuzzTest::fuzz(iterations, flows);
}

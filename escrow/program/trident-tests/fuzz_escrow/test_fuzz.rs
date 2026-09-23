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
//! acceptance, permanent receipts, `withdraw`, `close_unfunded`, wrapped SOL refused):
//!   I1 every deposit account holds exactly what was sent to it;
//!   I2 no ending pays out more, or less, than the deposit account held;
//!   I3 rent goes back to the recorded rent payer, to the lamport, and to nobody else: the deposit
//!      account's at every ending, and the escrow account's too only when it never held the amount;
//!   I4 an ended escrow accepts no instruction, even after a later payment re-creates its deposit
//!      account, and its address never opens again;
//!   I5 a buyer's cancellation refund is never below the step's percent of the amount;
//!   I6 no token is created or destroyed: every balance plus every deposit account is constant;
//!   I7 the program accepts exactly what the state machine allows, and refuses everything else;
//!   I8 a receipt, once written, never changes and never closes: its bytes and its lamports stay.
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
    /// The receipt's bytes and lamports, as the ending left them.
    receipt: Option<(Vec<u8>, u64)>,
}

impl Deal {
    fn live(&self) -> bool {
        !self.ended && !self.closed
    }
    fn accepted(&self) -> bool {
        self.accepted_at != 0
    }
    /// The service time if set, else the funding observation, but never before the acceptance.
    fn clock_start(&self) -> Option<i64> {
        if self.accepted_at == 0 {
            return None;
        }
        let base = if self.service_time != 0 {
            self.service_time
        } else if self.funded_at != 0 {
            self.funded_at
        } else {
            return None;
        };
        Some(base.max(self.accepted_at))
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
            if balance >= d.amount {
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
        // Only an accepted escrow's funding can be observed.
        let marks = d.funded_at == 0 && d.accepted();
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
        let valid = d.live() && d.accepted() && d.funded_at == 0 && balance >= d.amount;
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
        let bt_i = if self.pick(20) == 0 { self.pick(PEOPLE) } else { buyer_i };
        let st_i = if !refund && self.pick(20) == 0 { self.pick(PEOPLE) } else { seller_i };
        let rp_i = if self.pick(20) == 0 { self.pick(PEOPLE) } else { payer_i };
        let accounts_right = bt_i == buyer_i && st_i == seller_i && rp_i == payer_i;
        let vault_exists = self.trident.get_account(&d.vault).lamports() > 0;

        let funded = balance >= d.amount;
        let accepted = d.accepted();
        // (valid, to_seller)
        let expect: (bool, u64) = if !d.live() || !accounts_right || !vault_exists {
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
            AccountMeta::new(self.tokens[bt_i], false),
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
        let before_b = self.token_balance(&self.tokens[buyer_i].clone());
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
        let got_b = self.token_balance(&self.tokens[buyer_i].clone()) - before_b;
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
            self.deals[i].receipt = Some((account.data().to_vec(), account.lamports()));
        }
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
        let held: u128 = (0..PEOPLE).map(|k| u128::from(self.token_balance(&self.tokens[k].clone()))).sum();
        assert_eq!(held + in_vaults, self.total_tokens, "I6: no token created or destroyed");
        for d in self.deals.clone() {
            if let Some((data, lamports)) = &d.receipt {
                let now = self.trident.get_account(&d.escrow);
                assert_eq!(now.lamports(), *lamports, "I8: receipt {} keeps its lamports", d.escrow);
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

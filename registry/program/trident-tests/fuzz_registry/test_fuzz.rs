//! Adversarial review 1: the registry under Trident. IT DOES NOT RUN, and is kept as the record
//! of why. Trident 0.12's runtime (`trident-svm` 0.2.0) builds its feature set with
//! `SVMFeatureSet::default()`, every feature off, and its builder has no way to change that, so
//! the `sol_poseidon` and `alt_bn128` syscalls are never registered. The first `insert_identity`
//! fails as "unsupported BPF instruction" after 2,814 compute units, where the program first
//! hashes. The same model and invariants run under LiteSVM in `../tests-litesvm/tests/invariants.rs`.
//! If a later Trident exposes the feature set, this file should run as it is.
//!
//! Random flows against the built program (`../target/deploy/forest_registry.so`) and the real
//! Semaphore proofs in `../tests-litesvm/fixtures/proofs.json`, with a model of the registry kept
//! beside it. For every instruction the fuzzer sends, the model says whether the program must
//! accept it; after every step the invariants below are checked.
//!
//! Trident's runtime does not check signatures: an account marked as a signer is taken as signed.
//! So every key here can "sign", and every authority rule has to hold on key comparisons alone.
//!
//! Invariants, from `docs/decisions/adversarial-review-1.md`:
//!   R1 a code is never recorded twice: one account per code, and the code tree's count and root
//!      are exactly those of the codes accepted, in order;
//!   R2 a treasury's balance, lamports and every token, never goes down; it goes up by exactly
//!      the fee on a registration and exactly the excess on a sweep;
//!   R3 the identity count only grows, and each list's root is the LeanIMT root of its leaves;
//!   R4 each list's ring holds exactly its last 128 roots;
//!   R5 the program accepts exactly what the rules allow, and refuses everything else: no
//!      corrupted proof, wrong list, wrong signer, wrong account or wrong fee ever lands.
//!
//! Run: `cargo run --release --bin fuzz_registry` from this directory (after `cargo build-sbf`
//! in `registry/program`). `FOREST_FUZZ_ITERATIONS` and `FOREST_FUZZ_FLOWS` set the size;
//! `TRIDENT_WITH_EXIT_CODE=1` exits 99 if any invariant failed.

use std::collections::{HashMap, HashSet};

use num_bigint::BigUint;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use solana_poseidon::{hashv, Endianness, Parameters};
use trident_fuzz::fuzzing::*;

const PROGRAM_ID: Pubkey = pubkey!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");
const TREASURY: Pubkey = pubkey!("F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");
const BN254_R: &str = "21888242871839275222246405745257275088548364400416422360885981858940010000001";
const RING: usize = 128;
/// People who pay and insert: an issuer and four others.
const PEOPLE: usize = 5;
const ISSUER: usize = 0;
/// Keys that can hold the treasury: the constant and two others. They never pay for anything.
const TREASURIES: usize = 3;
const START: u64 = 4_000_000_000_000_000_000;

#[derive(Deserialize)]
struct Fixtures {
    lists: Vec<FixtureList>,
    proofs: Vec<FixtureProof>,
}
#[derive(Deserialize)]
struct FixtureList {
    index: u32,
    leaves: Vec<String>,
}
#[derive(Deserialize, Clone)]
struct FixtureProof {
    #[serde(rename = "listIndex")]
    list_index: u32,
    market: String,
    did: String,
    root: String,
    code: String,
    a: String,
    b: String,
    c: String,
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn h32(s: &str) -> [u8; 32] {
    hex(s).try_into().unwrap()
}
fn dec32(s: &str) -> [u8; 32] {
    let b = BigUint::parse_bytes(s.as_bytes(), 10).unwrap().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}
fn plus_r(a: &[u8; 32]) -> [u8; 32] {
    let sum = BigUint::from_bytes_be(a) + BN254_R.parse::<BigUint>().unwrap();
    let b = sum.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}
fn disc(namespace: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{namespace}:{name}").as_bytes())[..8].try_into().unwrap()
}
fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b]).unwrap().to_bytes()
}
fn lean_imt_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = level.chunks(2).map(|p| if p.len() == 2 { poseidon2(&p[0], &p[1]) } else { p[0] }).collect();
    }
    level[0]
}
fn fee(decimals: u8) -> Option<u64> {
    if decimals < 2 {
        return None;
    }
    25u64.checked_mul(10u64.checked_pow(u32::from(decimals - 2))?)
}
fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).0
}
fn list_address(i: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"list", &i.to_le_bytes()], &PROGRAM_ID).0
}
fn code_tree_address() -> Pubkey {
    Pubkey::find_program_address(&[b"code-tree"], &PROGRAM_ID).0
}
fn code_address(code: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"code", code], &PROGRAM_ID).0
}
fn mint_account(decimals: u8, owner: &Pubkey) -> AccountSharedData {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1;
    let mut a = AccountSharedData::new(1_461_600, 82, owner);
    a.set_data_from_slice(&d);
    a
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
fn amount_of(a: &AccountSharedData) -> u64 {
    if a.lamports() == 0 || a.data().len() < 72 {
        return 0;
    }
    u64::from_le_bytes(a.data()[64..72].try_into().unwrap())
}
fn borsh_string(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

#[derive(Default)]
struct FuzzAccounts {}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: FuzzAccounts,
    proofs: Vec<FixtureProof>,
    fixture_lists: Vec<(u32, Vec<[u8; 32]>)>,
    people: Vec<Pubkey>,
    treasuries: Vec<Pubkey>,
    /// The model.
    treasury: Pubkey,
    pending: Pubkey,
    mints: Vec<(Pubkey, u8)>,
    /// (mint, owner) -> token account
    tokens: HashMap<(Pubkey, Pubkey), Pubkey>,
    leaves: Vec<Vec<[u8; 32]>>,
    rings: Vec<Vec<[u8; 32]>>,
    issuers: Vec<Vec<Pubkey>>,
    codes: Vec<[u8; 32]>,
    used: HashSet<[u8; 32]>,
    /// Lamports put into registry accounts above their rent: what a sweep may take.
    donated: HashMap<Pubkey, u64>,
    /// Every key that has held the treasury, and its balances at the last check.
    watch: HashMap<Pubkey, Vec<u64>>,
    extra_mints: Vec<Pubkey>,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests-litesvm/fixtures/proofs.json")).unwrap();
        let f: Fixtures = serde_json::from_str(&text).unwrap();
        Self {
            trident: Trident::default(),
            fuzz_accounts: FuzzAccounts::default(),
            proofs: f.proofs,
            fixture_lists: f.lists.iter().map(|l| (l.index, l.leaves.iter().map(|x| dec32(x)).collect())).collect(),
            people: vec![],
            treasuries: vec![],
            treasury: TREASURY,
            pending: Pubkey::default(),
            mints: vec![],
            tokens: HashMap::new(),
            leaves: vec![],
            rings: vec![],
            issuers: vec![],
            codes: vec![],
            used: HashSet::new(),
            donated: HashMap::new(),
            watch: HashMap::new(),
            extra_mints: vec![],
        }
    }

    #[init]
    fn start(&mut self) {
        self.people = (0..PEOPLE).map(|_| self.trident.random_pubkey()).collect();
        self.treasuries = vec![TREASURY, self.trident.random_pubkey(), self.trident.random_pubkey()];
        self.treasury = TREASURY;
        self.pending = Pubkey::default();
        self.mints = vec![(USDC, 6)];
        self.tokens.clear();
        self.leaves.clear();
        self.rings.clear();
        self.issuers.clear();
        self.codes.clear();
        self.used.clear();
        self.donated.clear();
        self.watch.clear();
        self.extra_mints.clear();
        for p in self.people.clone() {
            self.trident.airdrop(&p, 1_000 * LAMPORTS_PER_SOL);
        }
        self.trident.set_account_custom(&USDC, &mint_account(6, &TOKEN_PROGRAM));
        self.give_token_accounts(USDC);

        let payer = self.people[1];
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(config_address(), false),
                AccountMeta::new(list_address(0), false),
                AccountMeta::new(code_tree_address(), false),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(USDC, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: disc("global", "init").to_vec(),
        };
        assert!(self.send(&[ix], "init"), "init");
        self.leaves.push(vec![]);
        self.rings.push(vec![]);
        self.issuers.push(vec![]);
        let issuer = self.people[ISSUER];
        assert!(self.send(&[self.issuer_ix("add_issuer", TREASURY, 0, issuer)], "add_issuer"));
        self.issuers[0].push(issuer);
        assert!(self.send(&[self.open_list_ix(TREASURY, 1)], "open_list"));
        self.leaves.push(vec![]);
        self.rings.push(vec![]);
        self.issuers.push(vec![]);
        assert!(self.send(&[self.issuer_ix("add_issuer", TREASURY, 1, issuer)], "add_issuer"));
        self.issuers[1].push(issuer);
        for (index, leaves) in self.fixture_lists.clone() {
            for leaf in leaves {
                self.do_insert(index, issuer, leaf, true);
            }
        }
        for t in self.treasuries.clone() {
            self.watch.insert(t, vec![]);
        }
        self.check_treasuries();
    }

    // -- flows ------------------------------------------------------------------------------------

    #[flow]
    fn register(&mut self) {
        let p = self.a_proof();
        let mut market = p.market.clone();
        let mut did = p.did.clone();
        let mut list_index = p.list_index;
        let mut root = h32(&p.root);
        let mut code = h32(&p.code);
        let mut a: [u8; 32] = h32(&p.a);
        let mut b: [u8; 64] = hex(&p.b).try_into().unwrap();
        let mut c: [u8; 32] = h32(&p.c);
        let mut corrupted = true;
        match self.pick(20) {
            0 => a[self.pick(32)] ^= 1 << self.pick(8),
            1 => b[self.pick(64)] ^= 1 << self.pick(8),
            2 => c[self.pick(32)] ^= 1 << self.pick(8),
            3 => did = self.a_proof().did + if self.coin() { "x" } else { "" },
            4 => market = if self.coin() { market.to_uppercase() } else { format!("{market} ") },
            5 => list_index = 1 - list_index.min(1),
            6 => root = if self.coin() { plus_r(&root) } else { [self.pick(250) as u8 + 1; 32] },
            7 => code = if self.coin() { plus_r(&code) } else { h32(&self.a_proof().code) },
            _ => corrupted = false,
        }
        // A corruption that happens to change nothing is not one.
        if (did == p.did && market == p.market && list_index == p.list_index && root == h32(&p.root) && code == h32(&p.code))
            && (a == h32(&p.a) && b.to_vec() == hex(&p.b) && c == h32(&p.c))
        {
            corrupted = false;
        }

        let payer = self.a_person();
        let wallet = self.a_person();
        let (mint, decimals) = if self.pick(4) == 0 && !self.extra_mints.is_empty() {
            let m = self.an_extra_mint();
            (m, self.mints.iter().find(|(x, _)| *x == m).map(|(_, d)| *d).unwrap_or(0))
        } else {
            (USDC, 6)
        };
        let accepted = self.mints.iter().any(|(m, _)| *m == mint);
        let profile_tokens = self.tokens[&(mint, wallet)];
        let (fee_to, right_treasury) = match self.pick(20) {
            0 => (self.a_person(), false),
            1 => (self.a_treasury(), false),
            _ => (self.treasury, true),
        };
        let right_treasury = right_treasury || fee_to == self.treasury;
        let treasury_tokens = self.tokens[&(mint, fee_to)];
        let balance = self.token_balance(&profile_tokens);
        let f = fee(decimals).unwrap_or(u64::MAX);

        let list_ok = (list_index as usize) < self.leaves.len();
        let root_ok = list_ok && self.rings[list_index as usize].contains(&root);
        let valid = !corrupted && !self.used.contains(&code) && root_ok && accepted && right_treasury && balance >= f;

        let mut data = disc("global", "register").to_vec();
        data.extend_from_slice(&borsh_string(&market));
        data.extend_from_slice(&borsh_string(&did));
        data.extend_from_slice(&list_index.to_le_bytes());
        data.extend_from_slice(&root);
        data.extend_from_slice(&code);
        data.extend_from_slice(&a);
        data.extend_from_slice(&b);
        data.extend_from_slice(&c);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(config_address(), false),
                AccountMeta::new_readonly(list_address(list_index), false),
                AccountMeta::new(code_tree_address(), false),
                AccountMeta::new(code_address(&code), false),
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(wallet, true),
                AccountMeta::new(profile_tokens, false),
                AccountMeta::new(treasury_tokens, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data,
        };
        let t_before = self.token_balance(&treasury_tokens);
        let ok = self.send(&[ix], "register");
        assert_eq!(ok, valid, "R5 register: model {valid}, program {ok} (corrupted {corrupted}, used {}, root {root_ok}, accepted {accepted}, treasury {right_treasury}, balance {balance} fee {f})", self.used.contains(&code));
        if !ok {
            return;
        }
        assert_eq!(self.token_balance(&profile_tokens), balance - f, "the wallet paid exactly the fee");
        assert_eq!(self.token_balance(&treasury_tokens), t_before + f, "R2 the treasury got exactly the fee");
        self.used.insert(code);
        self.codes.push(code);
        let tree = self.trident.get_account(&code_tree_address());
        let d = &tree.data()[8..];
        assert_eq!(u64::from_le_bytes(d[0..8].try_into().unwrap()), self.codes.len() as u64, "R1 code tree count");
        assert_eq!(<[u8; 32]>::try_from(&d[16..48]).unwrap(), lean_imt_root(&self.codes), "R1 code tree root");
        self.check_treasuries();
    }

    #[flow]
    fn insert(&mut self) {
        let list = self.pick(self.leaves.len() + 1) as u32;
        let signer = if self.pick(10) < 7 { self.people[ISSUER] } else { self.any_key() };
        let commitment = match self.pick(30) {
            0 => [0u8; 32],
            1 => plus_r(&[0u8; 32]),
            2 => [0xffu8; 32],
            3 => self.fixture_lists[0].1[0],
            _ => {
                let mut x = [0u8; 32];
                for byte in x.iter_mut().skip(1) {
                    *byte = self.pick(256) as u8;
                }
                x
            }
        };
        let valid = (list as usize) < self.leaves.len()
            && self.issuers[list as usize].contains(&signer)
            && commitment != [0u8; 32]
            && BigUint::from_bytes_be(&commitment) < BN254_R.parse::<BigUint>().unwrap();
        self.do_insert(list, signer, commitment, valid);
    }

    #[flow]
    fn propose_treasury(&mut self) {
        let signer = match self.pick(4) {
            0 | 1 => self.treasury,
            2 => self.a_treasury(),
            _ => self.any_key(),
        };
        let proposed: Option<Pubkey> = match self.pick(10) {
            0 => None,
            1 => Some(Pubkey::default()),
            2 => Some(self.treasury),
            _ => Some(self.a_treasury()),
        };
        let valid = signer == self.treasury && proposed.map_or(true, |k| k != Pubkey::default() && k != self.treasury);
        let mut data = disc("global", "propose_treasury").to_vec();
        match proposed {
            Some(k) => {
                data.push(1);
                data.extend_from_slice(k.as_ref());
            }
            None => data.push(0),
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(config_address(), false), AccountMeta::new_readonly(signer, true)],
            data,
        };
        let ok = self.send(&[ix], "propose_treasury");
        assert_eq!(ok, valid, "R5 propose_treasury: model {valid}, program {ok}");
        if ok {
            self.pending = proposed.unwrap_or_default();
        }
        self.check_config();
    }

    #[flow]
    fn accept_treasury(&mut self) {
        let signer = if self.coin() && self.pending != Pubkey::default() { self.pending } else { self.any_key() };
        let valid = self.pending != Pubkey::default() && signer == self.pending;
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(config_address(), false), AccountMeta::new_readonly(signer, true)],
            data: disc("global", "accept_treasury").to_vec(),
        };
        let ok = self.send(&[ix], "accept_treasury");
        assert_eq!(ok, valid, "R5 accept_treasury: model {valid}, program {ok}");
        if ok {
            self.treasury = signer;
            self.pending = Pubkey::default();
        }
        self.check_config();
    }

    #[flow]
    fn add_token(&mut self) {
        let signer = if self.pick(10) < 7 { self.treasury } else { self.any_key() };
        let (mint, decimals, classic) = match self.pick(10) {
            0 => (USDC, 6, true),
            1 if !self.extra_mints.is_empty() => {
                let m = self.an_extra_mint();
                (m, self.mints.iter().find(|(x, _)| *x == m).map(|(_, d)| *d).unwrap_or(6), true)
            }
            2 => {
                let m = self.trident.random_pubkey();
                self.trident.set_account_custom(&m, &mint_account(6, &TOKEN_2022));
                (m, 6, false)
            }
            _ => {
                let m = self.trident.random_pubkey();
                let d = if self.pick(4) == 0 { self.pick(22) as u8 } else { [2u8, 6, 8, 9, 18, 19][self.pick(6)] };
                self.trident.set_account_custom(&m, &mint_account(d, &TOKEN_PROGRAM));
                (m, d, true)
            }
        };
        let valid = signer == self.treasury
            && classic
            && fee(decimals).is_some()
            && !self.mints.iter().any(|(m, _)| *m == mint)
            && self.mints.len() < 16;
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(config_address(), false),
                AccountMeta::new_readonly(signer, true),
                AccountMeta::new_readonly(mint, false),
            ],
            data: disc("global", "add_token").to_vec(),
        };
        let ok = self.send(&[ix], "add_token");
        assert_eq!(ok, valid, "R5 add_token: model {valid}, program {ok} (decimals {decimals}, classic {classic})");
        if ok {
            self.mints.push((mint, decimals));
            self.extra_mints.push(mint);
            self.give_token_accounts(mint);
        }
        self.check_config();
    }

    #[flow]
    fn issuers(&mut self) {
        let add = self.coin();
        let list = self.pick(self.leaves.len() + 1) as u32;
        let signer = if self.pick(10) < 7 { self.treasury } else { self.any_key() };
        let key = if self.coin() { self.a_person() } else { self.trident.random_pubkey() };
        let exists = (list as usize) < self.leaves.len();
        let valid = signer == self.treasury
            && exists
            && if add {
                !self.issuers[list as usize].contains(&key) && self.issuers[list as usize].len() < 8
            } else {
                self.issuers[list as usize].contains(&key)
            };
        let name = if add { "add_issuer" } else { "remove_issuer" };
        let ok = self.send(&[self.issuer_ix(name, signer, list, key)], name);
        assert_eq!(ok, valid, "R5 {name}: model {valid}, program {ok}");
        if ok {
            let l = &mut self.issuers[list as usize];
            if add {
                l.push(key);
            } else {
                l.retain(|k| *k != key);
            }
        }
    }

    #[flow]
    fn open_list(&mut self) {
        if self.leaves.len() >= 6 {
            return;
        }
        let signer = if self.pick(10) < 7 { self.treasury } else { self.any_key() };
        let valid = signer == self.treasury;
        let n = self.leaves.len() as u32;
        let ok = self.send(&[self.open_list_ix(signer, n)], "open_list");
        assert_eq!(ok, valid, "R5 open_list: model {valid}, program {ok}");
        if ok {
            self.leaves.push(vec![]);
            self.rings.push(vec![]);
            self.issuers.push(vec![]);
        }
    }

    /// Someone sends lamports to a registry account; then anyone sweeps an account.
    #[flow]
    fn sweep(&mut self) {
        let (tag, arg, address, exists): (u8, Vec<u8>, Pubkey, bool) = match self.pick(4) {
            0 => (0, vec![], config_address(), true),
            1 => (1, vec![], code_tree_address(), true),
            2 => {
                let i = self.pick(self.leaves.len() + 1) as u32;
                (2, i.to_le_bytes().to_vec(), list_address(i), (i as usize) < self.leaves.len())
            }
            _ => {
                let code = if !self.codes.is_empty() && self.coin() { self.a_code() } else { h32(&self.a_proof().code) };
                (3, code.to_vec(), code_address(&code), self.used.contains(&code))
            }
        };
        if self.coin() {
            let from = self.a_person();
            let amount = self.trident.random_from_range(1..10_000_000u64);
            let mut data = 2u32.to_le_bytes().to_vec();
            data.extend_from_slice(&amount.to_le_bytes());
            let ix = Instruction {
                program_id: SYSTEM_PROGRAM,
                accounts: vec![AccountMeta::new(from, true), AccountMeta::new(address, false)],
                data,
            };
            assert!(self.send(&[ix], "donate"), "a plain transfer to any address lands");
            *self.donated.entry(address).or_default() += amount;
        }
        let to = if self.pick(10) == 0 { self.any_key() } else { self.treasury };
        let excess = if exists { self.donated.get(&address).copied().unwrap_or(0) } else { 0 };
        let valid = to == self.treasury && exists && excess > 0;
        let mut data = disc("global", "sweep_rent").to_vec();
        data.push(tag);
        data.extend_from_slice(&arg);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(config_address(), false),
                AccountMeta::new(address, false),
                AccountMeta::new(to, false),
            ],
            data,
        };
        let target_before = self.lamports(&address);
        let treasury_before = self.lamports(&self.treasury.clone());
        let ok = self.send(&[ix], "sweep_rent");
        assert_eq!(ok, valid, "R5 sweep_rent: model {valid}, program {ok} (exists {exists}, excess {excess})");
        if ok {
            assert_eq!(self.lamports(&address), target_before - excess, "R2 the sweep took exactly the excess");
            assert_eq!(self.lamports(&self.treasury.clone()), treasury_before + excess, "R2 and gave exactly that to the treasury");
            self.donated.insert(address, 0);
        }
        self.check_treasuries();
    }

    #[end]
    fn end(&mut self) {
        self.check_treasuries();
        self.check_config();
        for (i, leaves) in self.leaves.clone().into_iter().enumerate() {
            let list = self.trident.get_account(&list_address(i as u32));
            let d = &list.data()[8..];
            assert_eq!(u64::from_le_bytes(d[0..8].try_into().unwrap()), leaves.len() as u64, "R3 leaf count");
        }
        for code in self.codes.clone() {
            assert!(self.lamports(&code_address(&code)) > 0, "R1 every code's account stays");
        }
        assert_eq!(self.codes.len(), self.used.len(), "R1 no code twice");
    }

    // -- the pieces -----------------------------------------------------------------------------

    fn do_insert(&mut self, list: u32, signer: Pubkey, commitment: [u8; 32], valid: bool) {
        let mut data = disc("global", "insert_identity").to_vec();
        data.extend_from_slice(&list.to_le_bytes());
        data.extend_from_slice(&commitment);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(list_address(list), false), AccountMeta::new_readonly(signer, true)],
            data,
        };
        let before = if (list as usize) < self.leaves.len() { self.leaves[list as usize].len() } else { 0 };
        let ok = self.send(&[ix], "insert_identity");
        assert_eq!(ok, valid, "R5 insert_identity: model {valid}, program {ok}");
        if !ok {
            return;
        }
        let l = list as usize;
        self.leaves[l].push(commitment);
        assert_eq!(self.leaves[l].len(), before + 1);
        let acct = self.trident.get_account(&list_address(list));
        let d = &acct.data()[8..];
        let count = u64::from_le_bytes(d[0..8].try_into().unwrap());
        let root: [u8; 32] = d[16..48].try_into().unwrap();
        assert_eq!(count, self.leaves[l].len() as u64, "R3 the identity count grew by one");
        assert_eq!(root, lean_imt_root(&self.leaves[l]), "R3 the root is the LeanIMT root of the leaves");
        self.rings[l].push(root);
        if self.rings[l].len() > RING {
            self.rings[l].remove(0);
        }
        // R4: the ring holds exactly the last 128 roots, each at leaf_count - 1 mod 128.
        let ring: Vec<[u8; 32]> = (0..RING).map(|i| d[1104 + i * 32..1136 + i * 32].try_into().unwrap()).collect();
        let n = self.leaves[l].len();
        for (k, r) in self.rings[l].iter().enumerate() {
            let leaf_count_after = n - self.rings[l].len() + k + 1;
            assert_eq!(&ring[(leaf_count_after - 1) % RING], r, "R4 ring slot");
        }
        let held = ring.iter().filter(|r| **r != [0u8; 32]).count();
        assert_eq!(held, self.rings[l].len(), "R4 nothing else in the ring");
    }

    fn issuer_ix(&self, name: &str, signer: Pubkey, list: u32, issuer: Pubkey) -> Instruction {
        let mut data = disc("global", name).to_vec();
        data.extend_from_slice(&list.to_le_bytes());
        data.extend_from_slice(issuer.as_ref());
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(config_address(), false),
                AccountMeta::new(list_address(list), false),
                AccountMeta::new_readonly(signer, true),
            ],
            data,
        }
    }

    fn open_list_ix(&self, signer: Pubkey, index: u32) -> Instruction {
        Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(config_address(), false),
                AccountMeta::new(list_address(index), false),
                AccountMeta::new(self.people[1], true),
                AccountMeta::new_readonly(signer, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: disc("global", "open_list").to_vec(),
        }
    }

    fn give_token_accounts(&mut self, mint: Pubkey) {
        for owner in self.people.clone().into_iter().chain(self.treasuries.clone()) {
            let t = self.trident.random_pubkey();
            let start = if self.treasuries.contains(&owner) { 0 } else { START };
            self.trident.set_account_custom(&t, &token_account(&mint, &owner, start));
            self.tokens.insert((mint, owner), t);
        }
    }

    fn check_config(&mut self) {
        let c = self.trident.get_account(&config_address());
        let d = &c.data()[8..];
        assert_eq!(Pubkey::try_from(&d[0..32]).unwrap(), self.treasury, "the treasury is who the model says");
        assert_eq!(Pubkey::try_from(&d[566..598]).unwrap(), self.pending, "the pending key is who the model says");
        assert_eq!(d[560] as usize, self.mints.len(), "the accepted mints");
    }

    /// R2: no key that has held the treasury ever loses a lamport or a token unit.
    fn check_treasuries(&mut self) {
        for t in self.treasuries.clone() {
            let mut now = vec![self.lamports(&t)];
            for (m, _) in self.mints.clone() {
                if let Some(acct) = self.tokens.get(&(m, t)).copied() {
                    now.push(self.token_balance(&acct));
                }
            }
            let before = self.watch.get(&t).cloned().unwrap_or_default();
            for (k, b) in before.iter().enumerate() {
                assert!(now[k] >= *b, "R2 a treasury balance went down: {t} slot {k}: {b} -> {}", now[k]);
            }
            self.watch.insert(t, now);
        }
    }

    fn a_proof(&mut self) -> FixtureProof {
        let k = self.pick(self.proofs.len());
        self.proofs[k].clone()
    }
    fn a_person(&mut self) -> Pubkey {
        let k = self.pick(PEOPLE);
        self.people[k]
    }
    fn a_treasury(&mut self) -> Pubkey {
        let k = self.pick(TREASURIES);
        self.treasuries[k]
    }
    fn an_extra_mint(&mut self) -> Pubkey {
        let k = self.pick(self.extra_mints.len());
        self.extra_mints[k]
    }
    fn a_code(&mut self) -> [u8; 32] {
        let k = self.pick(self.codes.len());
        self.codes[k]
    }
    fn send(&mut self, ixs: &[Instruction], name: &str) -> bool {
        let r = self.trident.process_transaction(ixs, Some(name));
        if std::env::var("FOREST_FUZZ_LOGS").is_ok() && !r.is_success() {
            eprintln!("{name} refused: {}", r.logs());
        }
        r.is_success()
    }
    fn pick(&mut self, n: usize) -> usize {
        self.trident.random_from_range(0..n)
    }
    fn coin(&mut self) -> bool {
        self.trident.random_bool()
    }
    fn any_key(&mut self) -> Pubkey {
        if self.coin() {
            self.a_person()
        } else {
            self.a_treasury()
        }
    }
    fn lamports(&mut self, k: &Pubkey) -> u64 {
        self.trident.get_account(k).lamports()
    }
    fn token_balance(&mut self, k: &Pubkey) -> u64 {
        amount_of(&self.trident.get_account(k))
    }
}

fn main() {
    let iterations = std::env::var("FOREST_FUZZ_ITERATIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
    let flows = std::env::var("FOREST_FUZZ_FLOWS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    FuzzTest::fuzz(iterations, flows);
}

//! Adversarial review 1: the registry's invariants, as a property test under LiteSVM.
//!
//! This is the registry half of the fuzzing in `docs/decisions/adversarial-review-1.md`. The
//! escrow runs under Trident (`escrow/program/trident-tests`); the registry cannot, because
//! Trident 0.12's runtime builds its feature set with every feature off and offers no way to turn
//! one on, so the `sol_poseidon` and `alt_bn128` syscalls this program needs are never registered
//! and its first hash fails as "unsupported BPF instruction" (`registry/program/trident-tests`
//! keeps the attempt). LiteSVM registers them, so the same model and the same invariants run here,
//! with real signatures and a seeded random generator instead of Trident's.
//!
//! Random flows: register (the five real proofs, sometimes corrupted, signed by the profile's own
//! wallet or by another, the fee paid by the profile or by anyone else), insert, propose and accept
//! a treasury, add a token at a fee of the treasury's choosing, open a list as anyone, add and remove
//! a list's insert keys and close it as its owner or as anyone else, propose and accept a list's
//! handover as its owner, the proposed key or anyone else, send lamports to a registry account,
//! sweep to the right key or any other, and move the rent rate between the three rates the sweep
//! exists for. The model says whether each must land; after each, the invariants:
//!   R1 a code is never recorded twice, and the code tree's count and root are those of the codes
//!      accepted, in order;
//!   R2 no key that has held the treasury ever loses a lamport or a token unit; it gains exactly
//!      the fee on a registration and exactly the excess on a sweep of the config, the code tree
//!      or a code account; a list's sweep pays exactly its excess to the list's owner of the moment
//!      and to no one else (session 15);
//!   R3 each list's identity count only grows, and its root is the LeanIMT root of its leaves;
//!   R4 each list's ring holds exactly its last 128 roots;
//!   R5 the program accepts exactly what the rules allow and refuses everything else;
//!   R6 every registration is signed by the wallet its proof names, and its entry names that
//!      wallet, its list and that list's owner; each mint's fee never changes once set; a closed
//!      list takes no member and stays closed;
//!   R7 a list's owner changes only when the key its owner proposed signs to accept, and only
//!      its owner changes the list's insert keys, closes it or proposes a handover; a handover moves
//!      the owner and nothing else (session 14: anyone may open a list; the treasury has no say
//!      over any; session 15: handovers).
//!
//! `cargo test --release --test invariants -- --nocapture`; `FOREST_FUZZ_ITERATIONS`,
//! `FOREST_FUZZ_FLOWS` and `FOREST_FUZZ_SEED` size and replay a run.

use std::collections::{BTreeMap, HashMap, HashSet};

use forest_registry_tests::*;
use num_bigint::BigUint;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const BN254_R: &str = "21888242871839275222246405745257275088548364400416422360885981858940010000001";
const TOKEN_2022: Address = solana_address::address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM: Address = solana_system_interface::program::ID;
const PEOPLE: usize = 5;
const TREASURIES: usize = 3;
const START: u64 = 4_000_000_000_000_000_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }
}

fn plus_r(a: &[u8; 32]) -> [u8; 32] {
    let b = (BigUint::from_bytes_be(a) + BN254_R.parse::<BigUint>().unwrap()).to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

fn is_field(x: &[u8; 32]) -> bool {
    BigUint::from_bytes_be(x) < BN254_R.parse::<BigUint>().unwrap()
}

struct World {
    h: Harness,
    rng: Rng,
    proofs: Vec<(u32, String, String, [u8; 32], [u8; 32], [u8; 32], [u8; 64], [u8; 32])>,
    /// Each proof's profile wallet, at the same index as `proofs`.
    profiles: Vec<Keypair>,
    people: Vec<Keypair>,
    treasuries: Vec<Keypair>,
    treasury: Address,
    pending: Address,
    /// Accepted mints and the fee each was set at.
    mints: Vec<(Address, u64)>,
    tokens: HashMap<(Address, Address), Address>,
    leaves: Vec<Vec<[u8; 32]>>,
    rings: Vec<Vec<[u8; 32]>>,
    issuers: Vec<Vec<Address>>,
    /// Each list's owner: its opener, until a handover is accepted.
    owners: Vec<Address>,
    /// Each list's pending handover, or the zero key.
    pending_owners: Vec<Address>,
    closed: Vec<bool>,
    codes: Vec<[u8; 32]>,
    used: HashSet<[u8; 32]>,
    watch: HashMap<Address, Vec<u64>>,
    extra_mints: Vec<Address>,
    rate: u64,
    last_error: String,
    counts: BTreeMap<String, (u64, u64)>,
    errors: BTreeMap<String, u64>,
}

impl World {
    fn new(seed: u64) -> Self {
        let f = Fixtures::load();
        let h = Harness::new(); // init: list 0 owned by the foundation's issuer key, its first insert key
        let issuer = h.issuer.insecure_clone();
        let mut people = vec![issuer];
        people.extend((1..PEOPLE).map(|_| Keypair::new()));
        let treasuries = vec![h.treasury_signer(), Keypair::new(), Keypair::new()];
        let proofs = f
            .proofs
            .iter()
            .map(|p| (p.list_index, p.market.clone(), p.did.clone(), p.root_bytes(), p.code_bytes(), p.a_bytes(), p.b_bytes(), p.c_bytes()))
            .collect();
        let profiles = f.proofs.iter().map(|p| p.wallet_keypair()).collect();
        let mut w = World {
            h,
            rng: Rng(seed | 1),
            proofs,
            profiles,
            people,
            treasuries,
            treasury: TREASURY,
            pending: Address::default(),
            mints: vec![(USDC_MINT, USDC_FEE)],
            tokens: HashMap::new(),
            leaves: vec![vec![]],
            rings: vec![vec![]],
            issuers: vec![],
            owners: vec![],
            pending_owners: vec![],
            closed: vec![false],
            codes: vec![],
            used: HashSet::new(),
            watch: HashMap::new(),
            extra_mints: vec![],
            rate: RENT_HIGH,
            last_error: String::new(),
            counts: BTreeMap::new(),
            errors: BTreeMap::new(),
        };
        w.h.svm.set_sysvar(&rent_at(RENT_HIGH));
        // Alice's two proofs share one profile wallet: one airdrop each key.
        let mut funded = HashSet::new();
        for p in w.people.iter().chain(w.profiles.iter()) {
            if funded.insert(p.pubkey()) {
                w.h.svm.airdrop(&p.pubkey(), 1_000_000_000_000).unwrap();
            }
        }
        // List 0 is the foundation issuer's from `init`, and that key is its first insert key.
        let issuer = w.people[0].pubkey();
        assert_eq!(issuer, FOUNDATION_ISSUER);
        w.issuers.push(vec![issuer]);
        w.owners.push(issuer);
        w.pending_owners.push(Address::default());
        w.give_token_accounts(USDC_MINT);
        // List 1, as the fixtures expect, opened by the same key, then both lists' real leaves.
        let payer = w.h.payer.pubkey();
        assert!(w.send(&[open_list_ix(payer, issuer, 1)], "open_list"));
        w.leaves.push(vec![]);
        w.rings.push(vec![]);
        w.closed.push(false);
        w.issuers.push(vec![issuer]);
        w.owners.push(issuer);
        w.pending_owners.push(Address::default());
        for fl in &f.lists {
            for leaf in &fl.leaves {
                w.do_insert(fl.index, issuer, dec_to_be32(leaf), true);
            }
        }
        for t in &w.treasuries {
            w.watch.insert(t.pubkey(), vec![]);
        }
        w.check_treasuries();
        w
    }

    // -- sending, with real signatures -----------------------------------------------------------

    fn key(&self, a: &Address) -> &Keypair {
        if *a == self.h.payer.pubkey() {
            return &self.h.payer;
        }
        self.people
            .iter()
            .chain(self.treasuries.iter())
            .chain(self.profiles.iter())
            .find(|k| k.pubkey() == *a)
            .unwrap_or_else(|| panic!("no key for {a}"))
    }

    fn send(&mut self, ixs: &[Instruction], name: &str) -> bool {
        self.send_logged(ixs, name).is_some()
    }

    /// As `send`, with the transaction's logs when it lands.
    fn send_logged(&mut self, ixs: &[Instruction], name: &str) -> Option<Vec<String>> {
        self.h.svm.expire_blockhash();
        let msg = Message::new(ixs, Some(&self.h.payer.pubkey()));
        let n = msg.header.num_required_signatures as usize;
        let signers: Vec<&Keypair> = msg.account_keys[..n].iter().map(|a| self.key(a)).collect();
        let tx = Transaction::new(&signers, msg.clone(), self.h.svm.latest_blockhash());
        let out = self.h.send_tx(tx);
        let c = self.counts.entry(name.to_string()).or_default();
        match &out {
            Ok(_) => c.0 += 1,
            Err(e) => {
                c.1 += 1;
                self.last_error = e.clone();
                let code = e
                    .split("Error Code: ")
                    .nth(1)
                    .map(|s| s.split('.').next().unwrap_or("").to_string())
                    .or_else(|| e.lines().next().map(|l| l.chars().take(60).collect()))
                    .unwrap_or_default();
                *self.errors.entry(format!("{name}: {code}")).or_default() += 1;
            }
        }
        out.ok().map(|meta| meta.logs)
    }

    fn a_person(&mut self) -> Address {
        let k = self.rng.below(PEOPLE);
        self.people[k].pubkey()
    }
    fn a_treasury(&mut self) -> Address {
        let k = self.rng.below(TREASURIES);
        self.treasuries[k].pubkey()
    }
    fn any_key(&mut self) -> Address {
        if self.rng.coin() {
            self.a_person()
        } else {
            self.a_treasury()
        }
    }

    fn give_token_accounts(&mut self, mint: Address) {
        let owners: Vec<(Address, bool)> = self
            .people
            .iter()
            .chain(self.profiles.iter())
            .map(|k| (k.pubkey(), false))
            .chain(self.treasuries.iter().map(|k| (k.pubkey(), true)))
            .collect::<std::collections::BTreeMap<_, _>>()
            .into_iter()
            .collect();
        for (owner, is_treasury) in owners {
            let t = Address::new_unique();
            self.h.svm.set_account(t, spl_token_account(&mint, &owner, if is_treasury { 0 } else { START })).unwrap();
            self.tokens.insert((mint, owner), t);
        }
    }

    fn lamports(&self, a: &Address) -> u64 {
        self.h.svm.get_account(a).map(|x| x.lamports).unwrap_or(0)
    }
    fn balance(&self, a: &Address) -> u64 {
        self.h.svm.get_account(a).map(|x| if x.data.len() >= 72 { token_amount(&x.data) } else { 0 }).unwrap_or(0)
    }

    // -- flows ------------------------------------------------------------------------------------

    fn register(&mut self) {
        let k = self.rng.below(self.proofs.len());
        let (p_list, p_market, p_did, p_root, p_code, p_a, p_b, p_c) = self.proofs[k].clone();
        let (mut market, mut did, mut list, mut root, mut code, mut a, mut b, mut c) =
            (p_market.clone(), p_did.clone(), p_list, p_root, p_code, p_a, p_b, p_c);
        match self.rng.below(20) {
            0 => a[self.rng.below(32)] ^= 1 << self.rng.below(8),
            1 => b[self.rng.below(64)] ^= 1 << self.rng.below(8),
            2 => c[self.rng.below(32)] ^= 1 << self.rng.below(8),
            3 => {
                let j = self.rng.below(self.proofs.len());
                did = self.proofs[j].2.clone() + if self.rng.coin() { "x" } else { "" };
            }
            4 => market = if self.rng.coin() { market.to_uppercase() } else { format!("{market} ") },
            5 => list = 1 - list.min(1),
            6 => root = if self.rng.coin() { plus_r(&root) } else { [self.rng.below(250) as u8 + 1; 32] },
            7 => {
                let j = self.rng.below(self.proofs.len());
                code = if self.rng.coin() { plus_r(&code) } else { self.proofs[j].4 };
            }
            _ => {}
        }
        let corrupted = (market.clone(), did.clone(), list, root, code, a, b, c) != (p_market, p_did, p_list, p_root, p_code, p_a, p_b, p_c);

        let payer = self.a_person();
        // The profile's wallet signs: usually the one the proof names, sometimes another profile's
        // or anyone's. The fee authority is the profile itself (the paid path) or anyone (a sponsor).
        let profile = match self.rng.below(12) {
            0 => self.profiles[self.rng.below(self.profiles.len())].pubkey(),
            1 => self.a_person(),
            _ => self.profiles[k].pubkey(),
        };
        let wallet_ok = profile == self.profiles[k].pubkey();
        let fee_authority = if self.rng.coin() { profile } else { self.a_person() };
        let mint = if self.rng.below(4) == 0 && !self.extra_mints.is_empty() {
            let j = self.rng.below(self.extra_mints.len());
            self.extra_mints[j]
        } else {
            USDC_MINT
        };
        let fee_set = self.mints.iter().find(|(m, _)| *m == mint).map(|(_, f)| *f);
        let fee = fee_set.unwrap_or(u64::MAX);
        let fee_tokens = self.tokens[&(mint, fee_authority)];
        let fee_to = match self.rng.below(20) {
            0 => self.a_person(),
            1 => self.a_treasury(),
            _ => self.treasury,
        };
        let treasury_tokens = self.tokens[&(mint, fee_to)];
        let balance = self.balance(&fee_tokens);
        let root_ok = (list as usize) < self.rings.len() && self.rings[list as usize].contains(&root);
        let valid = !corrupted
            && wallet_ok
            && !self.used.contains(&code)
            && root_ok
            && fee_set.is_some()
            && fee_to == self.treasury
            && balance >= fee;

        let accounts = RegisterAccounts { payer, profile_wallet: profile, fee_authority, fee_tokens, treasury_tokens };
        let args = RegisterArgs { market: &market, did: &did, list_index: list, root, code, proof_a: a, proof_b: b, proof_c: c };
        let ix = register_ix(&args, &accounts);
        let t_before = self.balance(&treasury_tokens);
        let ok = self.send_logged(&[ix], "register");
        assert_eq!(ok.is_some(), valid, "R5 register: model {valid}, program {} (corrupted {corrupted}, wallet {wallet_ok}, root {root_ok})", ok.is_some());
        let Some(logs) = ok else { return };
        let entries = registered_events(&logs);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].wallet, profile, "R6 the entry names the wallet that signed");
        assert_eq!(entries[0].list_index, list, "R6 the entry names the list");
        assert_eq!(entries[0].list_owner, self.owners[list as usize], "R6 and the list's owner");
        assert_eq!(profile, self.profiles[k].pubkey(), "R6 and it is the wallet the proof names");
        assert_eq!(self.balance(&fee_tokens), balance - fee, "the fee authority paid exactly the fee");
        assert_eq!(self.balance(&treasury_tokens), t_before + fee, "R2 the treasury got exactly the fee");
        self.used.insert(code);
        self.codes.push(code);
        let tree = self.h.code_tree();
        assert_eq!(tree.count, self.codes.len() as u64, "R1 code tree count");
        assert_eq!(tree.root, lean_imt_root(&self.codes), "R1 code tree root");
    }

    fn insert(&mut self) {
        let list = self.rng.below(self.leaves.len() + 1) as u32;
        // Usually one of the list's own insert keys that this world can sign for, else anyone.
        let known: Vec<Address> = self
            .issuers
            .get(list as usize)
            .map(|l| l.iter().copied().filter(|k| self.people.iter().chain(self.treasuries.iter()).any(|p| p.pubkey() == *k)).collect())
            .unwrap_or_default();
        let signer = if !known.is_empty() && self.rng.below(10) < 7 { known[self.rng.below(known.len())] } else { self.any_key() };
        let commitment = match self.rng.below(30) {
            0 => [0u8; 32],
            1 => plus_r(&[0u8; 32]),
            2 => [0xffu8; 32],
            3 => self.leaves[0][0],
            _ => {
                let mut x = [0u8; 32];
                for byte in x.iter_mut().skip(1) {
                    *byte = self.rng.below(256) as u8;
                }
                x
            }
        };
        let valid = (list as usize) < self.leaves.len()
            && self.issuers[list as usize].contains(&signer)
            && !self.closed[list as usize]
            && commitment != [0u8; 32]
            && is_field(&commitment);
        self.do_insert(list, signer, commitment, valid);
    }

    fn do_insert(&mut self, list: u32, signer: Address, commitment: [u8; 32], valid: bool) {
        let before = self.leaves.get(list as usize).map(|l| l.len()).unwrap_or(0);
        let ok = self.send(&[insert_identity_ix(signer, list, commitment)], "insert_identity");
        assert_eq!(ok, valid, "R5 insert_identity: model {valid}, program {ok}");
        if !ok {
            return;
        }
        let l = list as usize;
        self.leaves[l].push(commitment);
        let view = self.h.list(list);
        assert_eq!(view.leaf_count, before as u64 + 1, "R3 the identity count grew by one");
        assert_eq!(view.root, lean_imt_root(&self.leaves[l]), "R3 the root is the LeanIMT root of the leaves");
        self.rings[l].push(view.root);
        if self.rings[l].len() > ROOT_HISTORY {
            self.rings[l].remove(0);
        }
        let n = self.leaves[l].len();
        for (k, r) in self.rings[l].iter().enumerate() {
            let count_after = n - self.rings[l].len() + k + 1;
            assert_eq!(&view.roots[(count_after - 1) % ROOT_HISTORY], r, "R4 ring slot");
        }
        assert_eq!(view.roots.iter().filter(|r| **r != [0u8; 32]).count(), self.rings[l].len(), "R4 nothing else in the ring");
    }

    fn propose(&mut self) {
        let signer = match self.rng.below(4) {
            0 | 1 => self.treasury,
            2 => self.a_treasury(),
            _ => self.any_key(),
        };
        let proposed = match self.rng.below(10) {
            0 => None,
            1 => Some(Address::default()),
            2 => Some(self.treasury),
            _ => Some(self.a_treasury()),
        };
        let valid = signer == self.treasury && proposed.map_or(true, |k| k != Address::default() && k != self.treasury);
        let ok = self.send(&[propose_treasury_ix(signer, proposed)], "propose_treasury");
        assert_eq!(ok, valid, "R5 propose_treasury: model {valid}, program {ok}");
        if ok {
            self.pending = proposed.unwrap_or_default();
        }
        self.check_config();
    }

    fn accept(&mut self) {
        let signer = if self.rng.coin() && self.pending != Address::default() { self.pending } else { self.any_key() };
        let valid = self.pending != Address::default() && signer == self.pending;
        let ok = self.send(&[accept_treasury_ix(signer)], "accept_treasury");
        assert_eq!(ok, valid, "R5 accept_treasury: model {valid}, program {ok}");
        if ok {
            self.treasury = signer;
            self.pending = Address::default();
        }
        self.check_config();
    }

    fn add_token(&mut self) {
        let signer = if self.rng.below(10) < 7 { self.treasury } else { self.any_key() };
        let (mint, classic) = match self.rng.below(10) {
            0 => (USDC_MINT, true),
            1 if !self.extra_mints.is_empty() => {
                let j = self.rng.below(self.extra_mints.len());
                (self.extra_mints[j], true)
            }
            2 => {
                let m = Address::new_unique();
                let mut acct = spl_mint_account(6);
                acct.owner = TOKEN_2022;
                self.h.svm.set_account(m, acct).unwrap();
                (m, false)
            }
            _ => {
                let m = Address::new_unique();
                self.h.svm.set_account(m, spl_mint_account(self.rng.below(256) as u8)).unwrap();
                (m, true)
            }
        };
        // Any fee the treasury chooses, zero aside; decimals play no part.
        let fee = match self.rng.below(8) {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            _ => 1 + self.rng.next() % 1_000_000_000,
        };
        let valid = signer == self.treasury
            && classic
            && fee > 0
            && !self.mints.iter().any(|(m, _)| *m == mint)
            && self.mints.len() < 16;
        let ok = self.send(&[add_token_ix(signer, mint, fee)], "add_token");
        assert_eq!(ok, valid, "R5 add_token: model {valid}, program {ok} (fee {fee}, classic {classic})");
        if ok {
            self.mints.push((mint, fee));
            self.extra_mints.push(mint);
            self.give_token_accounts(mint);
        }
        self.check_config();
    }

    /// Usually the list's owner, sometimes anyone, the treasury included.
    fn list_signer(&mut self, list: u32) -> Address {
        match self.owners.get(list as usize) {
            Some(owner) if self.rng.below(10) < 7 => *owner,
            _ if self.rng.below(4) == 0 => self.treasury,
            _ => self.any_key(),
        }
    }

    fn close_list(&mut self) {
        let list = self.rng.below(self.leaves.len() + 1) as u32;
        let signer = self.list_signer(list);
        let exists = (list as usize) < self.leaves.len();
        let valid = exists && signer == self.owners[list as usize] && !self.closed[list as usize];
        let ok = self.send(&[close_list_ix(signer, list)], "close_list");
        assert_eq!(ok, valid, "R5 close_list: model {valid}, program {ok}");
        if ok {
            self.closed[list as usize] = true;
        }
    }

    fn issuers(&mut self) {
        let add = self.rng.coin();
        let list = self.rng.below(self.leaves.len() + 1) as u32;
        let signer = self.list_signer(list);
        let key = if self.rng.coin() { self.a_person() } else { Address::new_unique() };
        let exists = (list as usize) < self.leaves.len();
        let valid = exists
            && signer == self.owners[list as usize]
            && if add {
                !self.issuers[list as usize].contains(&key) && self.issuers[list as usize].len() < 8
            } else {
                self.issuers[list as usize].contains(&key)
            };
        let name = if add { "add_issuer" } else { "remove_issuer" };
        let ok = self.send(&[issuer_ix(name, signer, list, key)], name);
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

    fn open_list(&mut self) {
        if self.leaves.len() >= 6 {
            return;
        }
        // Anyone opens a list and owns it: a person, or a treasury key, which has no more say
        // over lists than anyone. The rent comes from the harness payer, or from the owner itself
        // when it is a person (a treasury key paying would break R2's watch, not a rule).
        let owner = self.any_key();
        let is_person = self.people.iter().any(|k| k.pubkey() == owner);
        let payer = if is_person && self.rng.coin() { owner } else { self.h.payer.pubkey() };
        let n = self.leaves.len() as u32;
        let ok = self.send(&[open_list_ix(payer, owner, n)], "open_list");
        assert!(ok, "R5 open_list: anyone may open a list, program refused: {}", self.last_error);
        self.leaves.push(vec![]);
        self.rings.push(vec![]);
        self.issuers.push(vec![owner]);
        self.owners.push(owner);
        self.pending_owners.push(Address::default());
        self.closed.push(false);
    }

    /// A list's handover: its owner (or anyone) proposes a key, nothing, the zero key or itself;
    /// or the proposed key (or anyone) accepts. Sometimes both in one transaction.
    fn list_handover(&mut self) {
        // Mostly a list with a handover pending, when there is one, so accepts get exercised.
        let pending_lists: Vec<u32> =
            (0..self.pending_owners.len()).filter(|i| self.pending_owners[*i] != Address::default()).map(|i| i as u32).collect();
        let list = if !pending_lists.is_empty() && self.rng.below(10) < 7 {
            pending_lists[self.rng.below(pending_lists.len())]
        } else {
            self.rng.below(self.leaves.len() + 1) as u32
        };
        let exists = (list as usize) < self.leaves.len();
        let owner = if exists { self.owners[list as usize] } else { Address::default() };
        let pending = if exists { self.pending_owners[list as usize] } else { Address::default() };
        match self.rng.below(3) {
            0 => {
                let signer = self.list_signer(list);
                let proposed = match self.rng.below(8) {
                    0 => None,
                    1 => Some(Address::default()),
                    2 => Some(owner),
                    3 => Some(Address::new_unique()), // a typo: nobody holds it, so nobody accepts
                    _ => Some(self.any_key()),
                };
                let valid = exists
                    && signer == owner
                    && match proposed {
                        None => true,
                        Some(k) => k != Address::default() && k != owner,
                    };
                let ok = self.send(&[propose_list_owner_ix(signer, list, proposed)], "propose_list_owner");
                assert_eq!(ok, valid, "R5 propose_list_owner: model {valid}, program {ok}\n{}", self.last_error);
                if ok {
                    self.pending_owners[list as usize] = proposed.unwrap_or_default();
                }
            }
            1 => {
                // Usually the pending key, when anyone holds it; otherwise the owner or anyone.
                let held = pending != Address::default() && self.people.iter().chain(self.treasuries.iter()).any(|k| k.pubkey() == pending);
                let signer = if held && self.rng.below(10) < 7 {
                    pending
                } else if self.rng.coin() && exists {
                    owner
                } else {
                    self.any_key()
                };
                let valid = exists && pending != Address::default() && signer == pending;
                let ok = self.send(&[accept_list_owner_ix(signer, list)], "accept_list_owner");
                assert_eq!(ok, valid, "R5 accept_list_owner: model {valid}, program {ok}\n{}", self.last_error);
                if ok {
                    self.owners[list as usize] = signer;
                    self.pending_owners[list as usize] = Address::default();
                }
            }
            _ => {
                // Both steps in one transaction, both keys signing.
                if !exists {
                    return;
                }
                let to = self.any_key();
                let valid = to != owner;
                let ok = self.send(
                    &[propose_list_owner_ix(owner, list, Some(to)), accept_list_owner_ix(to, list)],
                    "propose_and_accept",
                );
                assert_eq!(ok, valid, "R5 propose_and_accept: model {valid}, program {ok}\n{}", self.last_error);
                if ok {
                    self.owners[list as usize] = to;
                    self.pending_owners[list as usize] = Address::default();
                }
            }
        }
    }

    /// The rent rate moves between the three the sweep was written for, either way.
    fn rent_moves(&mut self) {
        self.rate = [RENT_HIGH, RENT_TODAY, RENT_FINAL][self.rng.below(3)];
        self.h.svm.set_sysvar(&rent_at(self.rate));
    }

    /// Someone may send lamports to a registry account; then anyone sweeps one.
    fn sweep(&mut self) {
        let (target, exists) = match self.rng.below(4) {
            0 => (SweepTarget::Config, true),
            1 => (SweepTarget::CodeTree, true),
            2 => {
                let i = self.rng.below(self.leaves.len() + 1) as u32;
                (SweepTarget::List(i), (i as usize) < self.leaves.len())
            }
            _ => {
                let code = if !self.codes.is_empty() && self.rng.coin() {
                    self.codes[self.rng.below(self.codes.len())]
                } else {
                    self.proofs[self.rng.below(self.proofs.len())].4
                };
                let exists = self.used.contains(&code);
                (SweepTarget::Code(code), exists)
            }
        };
        let address = target.address();
        if self.rng.coin() {
            let from = self.a_person();
            let amount = 1 + self.rng.next() % 10_000_000;
            let mut data = 2u32.to_le_bytes().to_vec();
            data.extend_from_slice(&amount.to_le_bytes());
            let ix = Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(from, true), AccountMeta::new(address, false)], data };
            self.send(&[ix], "donate"); // lands unless the runtime's rent rules refuse it; either way the chain is the truth
        }
        // A list's rent goes to its owner of the moment; everything else's to the treasury.
        let right = match &target {
            SweepTarget::List(i) if exists => self.owners[*i as usize],
            _ => self.treasury,
        };
        let to = if self.rng.below(10) == 0 { self.any_key() } else { right };
        let (lamports, len) = self.h.svm.get_account(&address).map(|x| (x.lamports, x.data.len())).unwrap_or((0, 0));
        let excess = if exists { lamports.saturating_sub(rent_minimum(self.rate, len)) } else { 0 };
        // The runtime, not the program: an account a transaction credits must end rent exempt, so
        // a key holding no SOL takes a sweep only if the excess alone covers its own rent.
        let to_len = self.h.svm.get_account(&to).map(|x| x.data.len()).unwrap_or(0);
        let to_after = self.lamports(&to) + excess;
        let valid = to == right && exists && excess > 0 && to_after >= rent_minimum(self.rate, to_len);
        let to_before = self.lamports(&to);
        let ok = self.send(&[sweep_rent_ix(&target, to)], "sweep_rent");
        assert_eq!(ok, valid, "R5 sweep_rent: model {valid}, program {ok} (exists {exists}, excess {excess}, rate {}, target {address}, len {len}, lamports {lamports})\n{}", self.rate, self.last_error);
        if ok {
            assert_eq!(self.lamports(&address), rent_minimum(self.rate, len), "R2 exactly the minimum stays");
            assert_eq!(self.lamports(&to), to_before + excess, "R2 exactly the excess to the one key the target pays");
        }
    }

    // -- invariants -----------------------------------------------------------------------------

    fn check_config(&self) {
        let c = self.h.config();
        assert_eq!(c.treasury, self.treasury, "the treasury is who the model says");
        assert_eq!(c.pending_treasury, self.pending, "the pending key is who the model says");
        assert_eq!(c.mints.len(), self.mints.len(), "the accepted mints");
        assert_eq!(c.fees, self.mints.iter().map(|(_, f)| *f).collect::<Vec<_>>(), "R6 each mint's fee, as set and never changed");
    }

    fn check_treasuries(&mut self) {
        for t in self.treasuries.iter().map(|k| k.pubkey()).collect::<Vec<_>>() {
            let mut now = vec![self.lamports(&t)];
            for (m, _) in &self.mints {
                if let Some(acct) = self.tokens.get(&(*m, t)) {
                    now.push(self.balance(acct));
                }
            }
            let before = self.watch.get(&t).cloned().unwrap_or_default();
            for (k, b) in before.iter().enumerate() {
                assert!(now[k] >= *b, "R2 a treasury balance went down: {t} slot {k}: {b} -> {}", now[k]);
            }
            self.watch.insert(t, now);
        }
    }

    fn check_everything(&mut self) {
        self.check_treasuries();
        self.check_config();
        for (i, leaves) in self.leaves.iter().enumerate() {
            let view = self.h.list(i as u32);
            assert_eq!(view.leaf_count, leaves.len() as u64, "R3 leaf count");
            assert_eq!(view.closed, self.closed[i], "R6 a closed list stays closed, an open one open");
            assert_eq!(view.owner, self.owners[i], "R7 a list's owner changes only by an accepted handover");
            assert_eq!(view.pending_owner, self.pending_owners[i], "R7 the pending handover is the one the owner proposed");
            assert_eq!(view.issuers, self.issuers[i], "R7 its insert keys are the ones its owner set");
        }
        for code in &self.codes {
            let a: Account = self.h.svm.get_account(&used_code_address(code)).expect("R1 every code's account stays");
            assert_eq!(a.owner, PROGRAM_ID);
        }
        assert_eq!(self.codes.len(), self.used.len(), "R1 no code twice");
        assert_eq!(self.h.code_tree().count, self.codes.len() as u64, "R1 code tree count");
    }

    fn step(&mut self) {
        match self.rng.below(10) {
            0 | 1 => self.register(),
            2 => self.insert(),
            3 => self.propose(),
            4 => self.accept(),
            5 => self.add_token(),
            6 => self.issuers(),
            7 => match self.rng.below(5) {
                0 | 1 => self.open_list(),
                2 => self.close_list(),
                _ => self.rent_moves(),
            },
            8 => self.list_handover(),
            _ => self.sweep(),
        }
        self.check_everything();
    }
}

#[test]
fn registry_invariants_hold_under_random_flows() {
    let iterations: u64 = std::env::var("FOREST_FUZZ_ITERATIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    let flows: u64 = std::env::var("FOREST_FUZZ_FLOWS").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    let seed: u64 = std::env::var("FOREST_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
    });
    println!("seed {seed}: {iterations} iterations of {flows} flows");
    let started = std::time::Instant::now();
    let mut counts: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut errors: BTreeMap<String, u64> = BTreeMap::new();
    for i in 0..iterations {
        let mut w = World::new(seed.wrapping_add(i.wrapping_mul(0x9E37_79B9_7F4A_7C15)));
        for _ in 0..flows {
            w.step();
        }
        for (k, (a, r)) in &w.counts {
            let c = counts.entry(k.clone()).or_default();
            c.0 += a;
            c.1 += r;
        }
        for (k, n) in &w.errors {
            *errors.entry(k.clone()).or_default() += n;
        }
    }
    println!("{:<20} {:>9} {:>9}", "instruction", "accepted", "refused");
    for (k, (a, r)) in &counts {
        println!("{k:<20} {a:>9} {r:>9}");
    }
    println!("refusals by reason:");
    for (k, n) in &errors {
        println!("  {n:>7}  {k}");
    }
    println!("{} flows in {:.1} s, every invariant held", iterations * flows, started.elapsed().as_secs_f64());
}

//! The registry's rules as a property test under LiteSVM, with real proofs and a seeded random
//! generator.
//!
//! Random flows by four keys, any of them sending anything: register (the real proofs, sometimes
//! bent: another profile, another label, another code, a root nobody has, one flipped bit),
//! add_proof (any proof, aimed at its own code or another's, sometimes flipped: strangers replay
//! every public proof), refund (to the recorded payer or anyone else), lamports sent to a line's
//! address before or after it exists, the rent rate moving between the three rates refund exists
//! for, and the clock moving. A model says whether each must land; after each, the invariants:
//!   I1 the program accepts exactly what the rules allow and refuses everything else;
//!   I2 at most one line per code; a line's profile, code, payer, time and label never change after
//!      register, and its roots only ever grow by appending a root it lacks, up to 16;
//!   I3 every code without a line has no account of the program's at its address;
//!   I4 a refund pays exactly the excess over the current minimum, to the recorded payer only, and
//!      leaves the line holding exactly the minimum; add_proof leaves it holding at least the new
//!      minimum and takes only from the payer that signed;
//!   I5 no key loses a lamport in a transaction it did not sign.
//!
//! `cargo test --release --test invariants -- --nocapture`; `FOREST_FUZZ_ITERATIONS` and
//! `FOREST_FUZZ_SEED` size and replay a run.

use std::collections::HashMap;

use forest_registry_tests::*;
use solana_account::Account;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

const FEE: u64 = 5_000;

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
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn flip(p: &mut Proof, rng: &mut Rng) {
    let bit = 1u8 << rng.below(8);
    match rng.below(3) {
        0 => p.a[rng.below(32)] ^= bit,
        1 => p.b[rng.below(64)] ^= bit,
        _ => p.c[rng.below(32)] ^= bit,
    }
}

/// Would a system transfer that leaves `after` in an account of `size` bytes be allowed, given
/// what it held before? The runtime refuses to leave an account below its rent minimum unless it
/// was already below it, the same size, and is not given more.
fn transition_allowed(rate: u64, size: usize, before: u64, after: u64) -> bool {
    after == 0 || after >= rent_minimum(rate, size) || (before > 0 && before < rent_minimum(rate, size) && after <= before)
}

#[test]
fn registry_invariants_hold_under_random_flows() {
    let iterations = env("FOREST_FUZZ_ITERATIONS", 150);
    let seed = env("FOREST_FUZZ_SEED", 0x5eed_f0e5_7000_0001);
    let mut rng = Rng(seed | 1);
    let f = Fixtures::load();
    let mut h = Harness::new();
    let keys: Vec<Keypair> = (0..4).map(|_| h.funded(1_000_000_000_000)).collect();
    let codes: Vec<[u8; 32]> = {
        let mut c: Vec<[u8; 32]> = f.proofs.iter().map(|p| p.code_bytes()).collect();
        c.sort();
        c.dedup();
        c
    };
    let mut lines: HashMap<[u8; 32], LineView> = HashMap::new();
    // LiteSVM's starting rate, read rather than assumed.
    let mut rate = h.svm.get_sysvar::<solana_rent::Rent>().lamports_per_byte;
    let mut time: i64 = 1_790_000_000;
    h.set_time(time);
    let mut landed: HashMap<&str, u64> = HashMap::new();
    let mut refused_count: HashMap<&str, u64> = HashMap::new();

    for step in 0..iterations {
        let sender = rng.below(keys.len());
        let balances: Vec<u64> = keys.iter().map(|k| h.lamports_of(&k.pubkey())).collect();
        let what: &str;
        let expected: bool;
        let result;

        match rng.below(10) {
            // register, sometimes bent
            0..=2 => {
                what = "register";
                let p = &f.proofs[rng.below(f.proofs.len())];
                let (mut profile, mut label, mut code, mut proof) = (p.profile_address(), p.label.clone(), p.code_bytes(), p.proof());
                let bent = rng.chance(40);
                if bent {
                    match rng.below(5) {
                        0 => profile = Keypair::new().pubkey(),
                        1 => label.push('x'),
                        2 => code = codes[(codes.iter().position(|c| *c == code).unwrap() + 1 + rng.below(codes.len() - 1)) % codes.len()],
                        3 => proof.root = [7u8; 32],
                        _ => flip(&mut proof, &mut rng),
                    }
                }
                expected = !bent && !lines.contains_key(&code);
                let k = &keys[sender];
                result = h.send_as(k, &[register_ix(k.pubkey(), &profile, &label, &code, &proof)]);
                if result.is_ok() {
                    lines.insert(code, LineView { profile, code, payer: k.pubkey(), time, bump: Address::find_program_address(&[b"code", &code], &PROGRAM_ID).1, label, roots: vec![proof.root] });
                }
            }
            // add_proof: its own code or another's, sometimes flipped, by anyone
            3..=5 => {
                what = "add_proof";
                let p = &f.proofs[rng.below(f.proofs.len())];
                let code = if rng.chance(75) { p.code_bytes() } else { codes[rng.below(codes.len())] };
                let mut proof = p.proof();
                let bent = rng.chance(15);
                if bent {
                    flip(&mut proof, &mut rng);
                }
                expected = !bent
                    && code == p.code_bytes()
                    && lines.get(&code).is_some_and(|l| !l.roots.contains(&proof.root) && l.roots.len() < MAX_ROOTS);
                let address = line_address(&code);
                let before = h.lamports_of(&address);
                let k = &keys[sender];
                result = h.send_as(k, &[add_proof_ix(k.pubkey(), &code, &proof)]);
                if result.is_ok() {
                    let line = lines.get_mut(&code).unwrap();
                    line.roots.push(proof.root);
                    let size = line_space(line.label.len(), line.roots.len());
                    let after = h.lamports_of(&address);
                    assert_eq!(after, before.max(rent_minimum(rate, size)), "I4: add_proof tops up to exactly the new minimum, or nothing");
                    assert_eq!(balances[sender] - h.lamports_of(&k.pubkey()), FEE + (after - before), "I4: only the signing payer paid");
                }
            }
            // refund, to the recorded payer or to anyone
            6..=7 => {
                what = "refund";
                let code = codes[rng.below(codes.len())];
                let to = match lines.get(&code) {
                    Some(l) if rng.chance(70) => l.payer,
                    _ => keys[rng.below(keys.len())].pubkey(),
                };
                let address = line_address(&code);
                let before = h.lamports_of(&address);
                let excess = lines
                    .get(&code)
                    .map(|l| before.saturating_sub(rent_minimum(rate, line_space(l.label.len(), l.roots.len()))))
                    .unwrap_or(0);
                expected = lines.get(&code).is_some_and(|l| l.payer == to) && excess > 0;
                let k = &keys[sender];
                let to_before = h.lamports_of(&to);
                result = h.send_as(k, &[refund_ix(to, &code)]);
                if result.is_ok() {
                    let paid = if to == k.pubkey() { FEE } else { 0 };
                    assert_eq!(h.lamports_of(&to) + paid - to_before, excess, "I4: exactly the excess, to the payer");
                    assert_eq!(h.lamports_of(&address), before - excess, "I4: the line keeps exactly the minimum");
                }
            }
            // lamports sent to a line's address, whether or not the line exists
            8 => {
                what = "gift";
                let code = codes[rng.below(codes.len())];
                let address = line_address(&code);
                let amount = 1_000_000 + rng.below(2_000_000) as u64;
                let before = h.lamports_of(&address);
                let size = h.svm.get_account(&address).map(|a| a.data.len()).unwrap_or(0);
                expected = transition_allowed(rate, size, before, before + amount);
                let k = &keys[sender];
                result = h.send_as(k, &[solana_system_interface::instruction::transfer(&k.pubkey(), &address, amount)]);
            }
            // the rent rate or the clock moves
            _ => {
                what = "rate or clock";
                if rng.chance(50) {
                    rate = [RENT_HIGH, RENT_TODAY, RENT_FINAL][rng.below(3)];
                    h.set_rent(rate);
                } else {
                    time += 1 + rng.below(100_000) as i64;
                    h.set_time(time);
                }
                expected = true;
                result = Ok(Default::default());
            }
        }

        // I1
        assert_eq!(result.is_ok(), expected, "step {step} (seed {seed:#x}): {what} {}\n{:?}", if expected { "was refused" } else { "landed" }, result.err());
        *(if result.is_ok() { landed.entry(what) } else { refused_count.entry(what) }).or_default() += 1;

        // I2, I3
        for code in &codes {
            let address = line_address(code);
            match lines.get(code) {
                Some(model) => {
                    let account = h.account(&address);
                    assert_eq!(account.owner, PROGRAM_ID);
                    let chain = read_line(&account.data);
                    assert_eq!(&chain, model, "I2: step {step}, the line is what the model says");
                    let mut roots = chain.roots.clone();
                    roots.sort();
                    roots.dedup();
                    assert!(roots.len() == chain.roots.len() && roots.len() <= MAX_ROOTS, "I2: distinct roots, at most 16");
                }
                None => {
                    let owner = h.svm.get_account(&address).map(|a: Account| a.owner);
                    assert_ne!(owner, Some(PROGRAM_ID), "I3: step {step}, no line where none was registered");
                }
            }
        }

        // I5
        for (i, k) in keys.iter().enumerate() {
            if i != sender {
                assert!(h.lamports_of(&k.pubkey()) >= balances[i], "I5: step {step}, a key that did not sign lost lamports");
            }
        }
    }

    let full = lines.values().filter(|l| l.roots.len() == MAX_ROOTS).count();
    println!(
        "{iterations} steps (seed {seed:#x}): landed {landed:?}, refused {refused_count:?}; {} lines, {} roots in all, {full} full",
        lines.len(),
        lines.values().map(|l| l.roots.len()).sum::<usize>()
    );
    assert!(landed.get("register").copied().unwrap_or(0) > 0, "the run registered something");
}

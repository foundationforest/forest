//! The registry's rules as a property test under LiteSVM, with real proofs and a seeded random
//! generator.
//!
//! Random flows by four payers, any of them sending anything: register (the real proofs, sometimes
//! bent: another main key signing, the main key not signing, another label, another stamp, another
//! issuer's key, another tier, one flipped bit), refund (of any row or any address, to the recorded
//! payer or anyone else), lamports sent to a row's address before or after it exists, the rent
//! rate moving between the three rates refund exists for, and the clock moving. A model says
//! whether each must land; after each, the invariants:
//!   I1 the program accepts exactly what the rules allow and refuses everything else;
//!   I2 at most one row per stamp, and a row never changes: its bytes and its size are exactly what
//!      register wrote, with the time the clock read then, whatever lands after;
//!   I3 every stamp without a row has no account of the program's at its address;
//!   I4 a refund pays exactly the excess over the current minimum, to the recorded payer only, and
//!      leaves the row holding exactly the minimum;
//!   I5 no payer loses a lamport in a transaction it did not sign.
//!
//! `cargo test --release --test invariants -- --nocapture`; `FOREST_FUZZ_ITERATIONS` and
//! `FOREST_FUZZ_SEED` size and replay a run.

use std::collections::HashMap;

use forest_registry_tests::*;
use solana_account::Account;
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
    let seed = env("FOREST_FUZZ_SEED", 0x5eed_f0e5_7000_0002);
    let mut rng = Rng(seed | 1);
    let f = Fixtures::load();
    let mut h = Harness::new();
    let payers: Vec<Keypair> = (0..4).map(|_| h.funded(1_000_000_000_000)).collect();
    let stamps: Vec<[u8; 32]> = {
        let mut s: Vec<[u8; 32]> = f.proofs.iter().map(|p| p.stamp()).collect();
        s.sort();
        s.dedup();
        s
    };
    // The model: each row as register wrote it, and its bytes then.
    let mut rows: HashMap<[u8; 32], (RowView, Vec<u8>)> = HashMap::new();
    // LiteSVM's starting rate, read rather than assumed.
    let mut rate = h.svm.get_sysvar::<solana_rent::Rent>().lamports_per_byte;
    let mut now: i64 = 1_791_331_200;
    h.set_time(now);
    let mut landed: HashMap<&str, u64> = HashMap::new();
    let mut refused_count: HashMap<&str, u64> = HashMap::new();

    for step in 0..iterations {
        let sender = rng.below(payers.len());
        let balances: Vec<u64> = payers.iter().map(|k| h.lamports_of(&k.pubkey())).collect();
        let what: &str;
        let expected: bool;
        let result;

        match rng.below(9) {
            // register, sometimes bent
            0..=3 => {
                what = "register";
                let p = &f.proofs[rng.below(f.proofs.len())];
                let mut profile = p.main_key();
                let mut args = p.args();
                let mut profile_signs = true;
                let bent = rng.chance(40);
                if bent {
                    match rng.below(7) {
                        0 => profile = Keypair::new(),
                        1 => profile_signs = false,
                        2 => args.label.push('x'),
                        3 => {
                            let at = stamps.iter().position(|s| *s == args.stamp).unwrap();
                            args.stamp = stamps[(at + 1 + rng.below(stamps.len() - 1)) % stamps.len()];
                        }
                        4 => args.issuer = f.issuer(if p.issuer == "A" { "B" } else { "A" }),
                        5 => args.tier[31] ^= 1 + rng.below(255) as u8,
                        _ => flip(&mut args.proof, &mut rng),
                    }
                }
                expected = !bent && !rows.contains_key(&args.stamp);
                let k = &payers[sender];
                let mut ix = register_ix(k.pubkey(), profile.pubkey(), &args);
                result = if profile_signs {
                    h.send_signed(&k.pubkey(), &[k, &profile], &[ix])
                } else {
                    ix.accounts[1].is_signer = false;
                    h.send_as(k, &[ix])
                };
                if result.is_ok() {
                    let view = RowView {
                        profile: profile.pubkey(),
                        stamp: args.stamp,
                        issuer: args.issuer,
                        payer: k.pubkey(),
                        made: now,
                        label: args.label.clone(),
                    };
                    let bytes = h.account(&row_address(&args.stamp)).data;
                    assert_eq!(bytes.len(), row_space(view.label.len()));
                    rows.insert(args.stamp, (view, bytes));
                }
            }
            // refund, of any stamp's address, to the recorded payer or to anyone
            4..=5 => {
                what = "refund";
                let stamp = stamps[rng.below(stamps.len())];
                let to = match rows.get(&stamp) {
                    Some((r, _)) if rng.chance(70) => r.payer,
                    _ => payers[rng.below(payers.len())].pubkey(),
                };
                let address = row_address(&stamp);
                let before = h.lamports_of(&address);
                let excess = rows
                    .get(&stamp)
                    .map(|(r, _)| before.saturating_sub(rent_minimum(rate, row_space(r.label.len()))))
                    .unwrap_or(0);
                expected = rows.get(&stamp).is_some_and(|(r, _)| r.payer == to) && excess > 0;
                let k = &payers[sender];
                let to_before = h.lamports_of(&to);
                result = h.send_as(k, &[refund_ix(to, address)]);
                if result.is_ok() {
                    let paid = if to == k.pubkey() { FEE } else { 0 };
                    assert_eq!(h.lamports_of(&to) + paid - to_before, excess, "I4: exactly the excess, to the payer");
                    assert_eq!(h.lamports_of(&address), before - excess, "I4: the row keeps exactly the minimum");
                }
            }
            // lamports sent to a row's address, whether or not the row exists
            6..=7 => {
                what = "gift";
                let address = row_address(&stamps[rng.below(stamps.len())]);
                let amount = 1_000_000 + rng.below(2_000_000) as u64;
                let before = h.lamports_of(&address);
                let size = h.svm.get_account(&address).map(|a| a.data.len()).unwrap_or(0);
                expected = transition_allowed(rate, size, before, before + amount);
                let k = &payers[sender];
                result = h.send_as(k, &[solana_system_interface::instruction::transfer(&k.pubkey(), &address, amount)]);
            }
            // the rent rate moves, or the clock does
            _ => {
                if rng.chance(50) {
                    what = "rate";
                    rate = [RENT_HIGH, RENT_TODAY, RENT_FINAL][rng.below(3)];
                    h.set_rent(rate);
                } else {
                    what = "time";
                    now += 1 + rng.below(86_400) as i64;
                    h.set_time(now);
                }
                expected = true;
                result = Ok(Default::default());
            }
        }

        // I1
        assert_eq!(result.is_ok(), expected, "step {step} (seed {seed:#x}): {what} {}\n{:?}", if expected { "was refused" } else { "landed" }, result.err());
        *(if result.is_ok() { landed.entry(what) } else { refused_count.entry(what) }).or_default() += 1;

        // I2, I3
        for stamp in &stamps {
            let address = row_address(stamp);
            match rows.get(stamp) {
                Some((model, bytes)) => {
                    let account = h.account(&address);
                    assert_eq!(account.owner, PROGRAM_ID);
                    assert_eq!(&account.data, bytes, "I2: step {step}, the row is byte for byte what register wrote");
                    assert_eq!(&read_row(&account.data), model, "I2: step {step}, the row is what the model says");
                }
                None => {
                    let owner = h.svm.get_account(&address).map(|a: Account| a.owner);
                    assert_ne!(owner, Some(PROGRAM_ID), "I3: step {step}, no row where none was registered");
                }
            }
        }

        // I5
        for (i, k) in payers.iter().enumerate() {
            if i != sender {
                assert!(h.lamports_of(&k.pubkey()) >= balances[i], "I5: step {step}, a payer that did not sign lost lamports");
            }
        }
    }

    println!("{iterations} steps (seed {seed:#x}): landed {landed:?}, refused {refused_count:?}; {} rows", rows.len());
    assert!(landed.get("register").copied().unwrap_or(0) > 0, "the run registered something");
}

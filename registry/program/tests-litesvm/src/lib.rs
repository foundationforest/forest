//! The harness, and the registry's wire format written out a second time.
//!
//! Nothing here imports the program crate. The instruction bytes, the row's layout and the
//! discriminators are written by hand, the way an outside client has to write them, and checked
//! against the client's own bytes in `fixtures/proofs.json` (`wire`). So a test passing means the
//! sealed format really is what `src/` and `registry/client` both say it is.

use std::path::PathBuf;

use litesvm::LiteSVM;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rent::Rent;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const PROGRAM_ID: Address = solana_address::address!("FoRRegistryRowsFreeNoFeeNoAdmin1111111111111");
pub const SYSTEM_PROGRAM: Address = solana_system_interface::program::ID;

pub const MAX_LABEL: usize = 128;

/// Anchor's error codes start at 6000, in the order `errors.rs` declares them.
pub mod err {
    pub const LABEL_TOO_LONG: u32 = 6000;
    pub const NOT_A_FIELD_ELEMENT: u32 = 6001;
    pub const PROOF_MALFORMED: u32 = 6002;
    pub const PROOF_REJECTED: u32 = 6003;
    pub const NOTHING_TO_REFUND: u32 = 6004;
    pub const NOT_THE_PAYER: u32 = 6005;
    /// Anchor's own: an account that should have signed did not.
    pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
    /// Anchor's own: an account of this program that is not a `Row`.
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
}

/// `Err` holds the runtime's error and the log, so a test can look for the exact code.
pub fn custom_error(result: &Result<litesvm::types::TransactionMetadata, String>) -> Option<u32> {
    let e = result.as_ref().err()?;
    let at = e.find("Custom(")? + "Custom(".len();
    e[at..].split(')').next()?.parse().ok()
}

// ---------------------------------------------------------------------------------------------
// Fixtures: real person proofs, made by registry/client/scripts/fixtures.ts with the committed
// devnet setup.
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Fixtures {
    /// Each issuer's key as a row holds it: x then y, 64 bytes in hex.
    pub issuers: Issuers,
    pub proofs: Vec<FixtureProof>,
    pub wire: Wire,
}

#[derive(Deserialize)]
pub struct Issuers {
    #[serde(rename = "A")]
    pub a: String,
    #[serde(rename = "B")]
    pub b: String,
}

#[derive(Deserialize)]
pub struct FixtureProof {
    pub name: String,
    /// "A" or "B".
    pub issuer: String,
    /// The issuer's key, x then y, in hex.
    #[serde(rename = "issuerKey")]
    pub issuer_key: String,
    pub label: String,
    /// The main key, base58, and its private seed: a test key, so the harness can sign as it.
    pub profile: String,
    #[serde(rename = "profileSeed")]
    pub profile_seed: String,
    pub stamp: String,
    pub tier: String,
    pub scope: String,
    pub message: String,
    pub a: String,
    pub b: String,
    pub c: String,
    pub uncompressed: Uncompressed,
}

#[derive(Deserialize)]
pub struct Uncompressed {
    pub a: String,
    pub b: String,
    pub c: String,
}

/// The client's bytes for one row (`scripts/fixtures.ts`, `wire`).
#[derive(Deserialize)]
pub struct Wire {
    #[serde(rename = "programId")]
    pub program_id: String,
    pub payer: String,
    #[serde(rename = "payerSeed")]
    pub payer_seed: String,
    /// What the clock reads when the row is written, Unix seconds.
    pub made: i64,
    #[serde(rename = "rowAddress")]
    pub row_address: String,
    pub register: String,
    pub refund: String,
    pub row: String,
}

impl Fixtures {
    pub fn load() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/proofs.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{}: {e}. Run `npm run fixtures` in registry/client.", path.display()));
        serde_json::from_str(&text).unwrap()
    }

    pub fn proof(&self, name: &str) -> &FixtureProof {
        self.proofs.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no fixture {name}"))
    }

    /// An issuer's key, "A" or "B".
    pub fn issuer(&self, which: &str) -> [[u8; 32]; 2] {
        issuer_key(if which == "A" { &self.issuers.a } else { &self.issuers.b })
    }
}

impl FixtureProof {
    pub fn profile_address(&self) -> Address {
        self.profile.parse().unwrap()
    }
    /// The main key, to sign with.
    pub fn main_key(&self) -> Keypair {
        let key = Keypair::new_from_array(from_hex32(&self.profile_seed));
        assert_eq!(key.pubkey(), self.profile_address(), "{}: the profile seed is the profile's", self.name);
        key
    }
    pub fn stamp(&self) -> [u8; 32] {
        from_hex32(&self.stamp)
    }
    pub fn row_address(&self) -> Address {
        row_address(&self.stamp())
    }
    pub fn proof(&self) -> Proof {
        Proof { a: from_hex32(&self.a), b: hex(&self.b).try_into().unwrap(), c: from_hex32(&self.c) }
    }
    /// Everything `register` carries, as this fixture's person would send it.
    pub fn args(&self) -> Args {
        Args {
            stamp: self.stamp(),
            issuer: issuer_key(&self.issuer_key),
            tier: from_hex32(&self.tier),
            proof: self.proof(),
            label: self.label.clone(),
        }
    }
}

pub fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

pub fn from_hex32(s: &str) -> [u8; 32] {
    hex(s).try_into().unwrap()
}

/// An issuer's key from its 64 bytes in hex: x, then y.
pub fn issuer_key(s: &str) -> [[u8; 32]; 2] {
    let b = hex(s);
    assert_eq!(b.len(), 64, "an issuer's key is 64 bytes");
    [b[..32].try_into().unwrap(), b[32..].try_into().unwrap()]
}

/// A number as 32 big-endian bytes.
pub fn be32(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

// ---------------------------------------------------------------------------------------------
// The wire format.
// ---------------------------------------------------------------------------------------------

pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let digest = Sha256::digest(format!("{namespace}:{name}").as_bytes());
    digest[..8].try_into().unwrap()
}

/// `keccak256(namespace || parts...) >> 8`, written again, so the tests can derive a scope and a
/// message without the program.
pub fn field_hash(namespace: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    use sha3::Keccak256;
    let mut h = Keccak256::new();
    h.update(namespace);
    for p in parts {
        h.update(p);
    }
    let d = h.finalize();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&d[..31]);
    out
}

pub fn scope_of(label: &str) -> [u8; 32] {
    field_hash(b"forest.foundation/label/v1/", &[label.as_bytes()])
}

pub fn message_of(profile: &Address) -> [u8; 32] {
    field_hash(b"forest.foundation/profile/v1/", &[profile.as_ref()])
}

pub fn row_address(stamp: &[u8; 32]) -> Address {
    Address::find_program_address(&[b"row", stamp], &PROGRAM_ID).0
}

/// Where each field of a row starts, discriminator included. The label is last.
pub mod at {
    pub const PROFILE: usize = 8;
    pub const STAMP: usize = 40;
    pub const ISSUER: usize = 72;
    pub const PAYER: usize = 136;
    pub const MADE: usize = 168;
    pub const LABEL: usize = 176;
}

/// A row's size, discriminator included. It never changes.
pub fn row_space(label_len: usize) -> usize {
    8 + 32 + 32 + 64 + 32 + 8 + 4 + label_len
}

/// One proof's compressed points. 128 bytes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Proof {
    pub a: [u8; 32],
    pub b: [u8; 64],
    pub c: [u8; 32],
}

/// What `register` carries, field by field.
#[derive(Clone, Debug)]
pub struct Args {
    pub stamp: [u8; 32],
    pub issuer: [[u8; 32]; 2],
    pub tier: [u8; 32],
    pub proof: Proof,
    pub label: String,
}

pub fn register_data(args: &Args) -> Vec<u8> {
    let mut data = discriminator("global", "register").to_vec();
    data.extend_from_slice(&args.stamp);
    data.extend_from_slice(&args.issuer[0]);
    data.extend_from_slice(&args.issuer[1]);
    data.extend_from_slice(&args.tier);
    data.extend_from_slice(&args.proof.a);
    data.extend_from_slice(&args.proof.b);
    data.extend_from_slice(&args.proof.c);
    data.extend_from_slice(&(args.label.len() as u32).to_le_bytes());
    data.extend_from_slice(args.label.as_bytes());
    data
}

/// Where the label's bytes start in `register`'s data: after the discriminator, every fixed field
/// and the label's four-byte length.
pub const REGISTER_LABEL_AT: usize = 8 + 32 + 64 + 32 + 128 + 4;

/// `register`: the row, the profile (a signer), the payer (a signer, writable), the system program.
pub fn register_ix(payer: Address, profile: Address, args: &Args) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(row_address(&args.stamp), false),
            AccountMeta::new_readonly(profile, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data: register_data(args),
    }
}

pub fn refund_data() -> Vec<u8> {
    discriminator("global", "refund").to_vec()
}

/// `refund`: the row, the payer it records. Nobody signs.
pub fn refund_ix(payer: Address, row: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![AccountMeta::new(row, false), AccountMeta::new(payer, false)],
        data: refund_data(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowView {
    pub profile: Address,
    pub stamp: [u8; 32],
    pub issuer: [[u8; 32]; 2],
    pub payer: Address,
    /// Unix seconds, from the clock when `register` ran.
    pub made: i64,
    pub label: String,
}

/// A row's bytes, read strictly: the discriminator, the fixed fields at their offsets, then the
/// label, and nothing after it.
pub fn read_row(data: &[u8]) -> RowView {
    assert_eq!(&data[..8], &discriminator("account", "Row"), "not a row");
    let label_len = u32::from_le_bytes(data[at::LABEL..at::LABEL + 4].try_into().unwrap()) as usize;
    assert_eq!(data.len(), row_space(label_len), "a row is exactly its size");
    RowView {
        profile: Address::try_from(&data[at::PROFILE..at::STAMP]).unwrap(),
        stamp: data[at::STAMP..at::ISSUER].try_into().unwrap(),
        issuer: [data[at::ISSUER..at::ISSUER + 32].try_into().unwrap(), data[at::ISSUER + 32..at::PAYER].try_into().unwrap()],
        payer: Address::try_from(&data[at::PAYER..at::MADE]).unwrap(),
        made: i64::from_le_bytes(data[at::MADE..at::LABEL].try_into().unwrap()),
        label: String::from_utf8(data[at::LABEL + 4..].to_vec()).unwrap(),
    }
}

// ---------------------------------------------------------------------------------------------
// Rent.
// ---------------------------------------------------------------------------------------------

/// The rate mainnet charged before September 2026.
pub const RENT_HIGH: u64 = 6_960;
/// The rate mainnet and devnet charge part way through SIMD-0437's five steps.
pub const RENT_TODAY: u64 = 5_080;
/// Where those steps end.
pub const RENT_FINAL: u64 = 696;

/// The minimum a rent-exempt account of this size must hold, at this rate.
pub fn rent_minimum(rate: u64, data_len: usize) -> u64 {
    (128 + data_len as u64) * rate
}

pub fn rent_at(lamports_per_byte: u64) -> Rent {
    let mut rent = Rent::default();
    rent.lamports_per_byte = lamports_per_byte;
    rent
}

// ---------------------------------------------------------------------------------------------
// The harness.
// ---------------------------------------------------------------------------------------------

pub struct Harness {
    pub svm: LiteSVM,
    /// Pays every transaction's fee, and a row's deposit unless a test names another payer.
    pub payer: Keypair,
}

impl Harness {
    /// The program loaded and a funded payer. Nothing else: the registry has no setup.
    pub fn new() -> Self {
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/forest_registry.so");
        let bytes = std::fs::read(&so).unwrap_or_else(|e| {
            panic!("{}: {e}. Build it first: `cargo build-sbf` in registry/program.", so.display())
        });
        let mut svm = LiteSVM::new();
        svm.add_program(PROGRAM_ID, &bytes).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        Harness { svm, payer }
    }

    /// A funded key, for a second payer, a stranger or a fee payer.
    pub fn funded(&mut self, lamports: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), lamports).unwrap();
        k
    }

    /// Send, the harness's payer paying the fee and signing, plus any other signers.
    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<litesvm::types::TransactionMetadata, String> {
        let payer = self.payer.insecure_clone();
        let mut keys: Vec<&Keypair> = vec![&payer];
        keys.extend_from_slice(extra);
        self.send_signed(&payer.pubkey(), &keys, ixs)
    }

    /// Send with `payer` as the fee payer and only signer.
    pub fn send_as(&mut self, payer: &Keypair, ixs: &[Instruction]) -> Result<litesvm::types::TransactionMetadata, String> {
        self.send_signed(&payer.pubkey(), &[payer], ixs)
    }

    /// Send with this fee payer and exactly these signers.
    pub fn send_signed(&mut self, fee_payer: &Address, signers: &[&Keypair], ixs: &[Instruction]) -> Result<litesvm::types::TransactionMetadata, String> {
        self.svm.expire_blockhash();
        let msg = Message::new(ixs, Some(fee_payer));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.send_tx(tx)
    }

    pub fn send_tx(&mut self, tx: Transaction) -> Result<litesvm::types::TransactionMetadata, String> {
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta),
            Err(e) => Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
        }
    }

    /// The fixture's row: its main key signs, the harness's payer pays.
    pub fn register(&mut self, p: &FixtureProof) -> Result<litesvm::types::TransactionMetadata, String> {
        let payer = self.payer.insecure_clone();
        self.register_paid_by(&payer, p)
    }

    /// The fixture's row: its main key signs, `payer` pays.
    pub fn register_paid_by(&mut self, payer: &Keypair, p: &FixtureProof) -> Result<litesvm::types::TransactionMetadata, String> {
        let profile = p.main_key();
        let ix = register_ix(payer.pubkey(), profile.pubkey(), &p.args());
        self.send_signed(&payer.pubkey(), &[payer, &profile], &[ix])
    }

    pub fn set_rent(&mut self, lamports_per_byte: u64) {
        self.svm.set_sysvar(&rent_at(lamports_per_byte));
    }

    /// Set the chain's clock to this Unix time, in seconds.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: solana_clock::Clock = self.svm.get_sysvar();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    pub fn account(&self, address: &Address) -> Account {
        self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"))
    }

    pub fn exists(&self, address: &Address) -> bool {
        self.svm.get_account(address).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn row(&self, stamp: &[u8; 32]) -> RowView {
        read_row(&self.account(&row_address(stamp)).data)
    }

    pub fn lamports_of(&self, address: &Address) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

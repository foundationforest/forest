//! The harness, and the registry's wire format written out a second time.
//!
//! Nothing here imports the program crate. The instruction bytes, the row's layout and the
//! discriminators are written by hand, the way an outside client has to write them, and checked
//! against the client's own bytes in `fixtures/proofs.json` (`wire`). So a test passing means the
//! sealed format really is what `src/` and `registry/client` both say it is.

use std::path::PathBuf;

use litesvm::LiteSVM;
use num_bigint::BigUint;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_poseidon::{hashv, Endianness, Parameters};
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
// Fixtures: real proofs, made by registry/client/scripts/fixtures.ts with the pinned artifacts.
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Fixtures {
    pub keepers: Keepers,
    pub lists: Lists,
    pub proofs: Vec<FixtureProof>,
    pub wire: Wire,
}

#[derive(Deserialize)]
pub struct Keepers {
    #[serde(rename = "A")]
    pub a: String,
    #[serde(rename = "B")]
    pub b: String,
}

#[derive(Deserialize)]
pub struct Lists {
    #[serde(rename = "A")]
    pub a: Vec<String>,
    #[serde(rename = "B")]
    pub b: Vec<String>,
}

#[derive(Deserialize)]
pub struct FixtureProof {
    pub name: String,
    pub list: String,
    /// The keeper's key, base58.
    pub keeper: String,
    pub label: String,
    /// The profile's key, base58, and its private seed: a test key, so the harness can sign as it.
    pub profile: String,
    #[serde(rename = "profileSeed")]
    pub profile_seed: String,
    pub root: String,
    #[serde(rename = "keeperSignature")]
    pub keeper_signature: String,
    #[serde(rename = "marketStamp")]
    pub market_stamp: String,
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

    /// The stamps a proof was made against: list A or list B.
    pub fn stamps_of(&self, p: &FixtureProof) -> Vec<[u8; 32]> {
        let list = if p.list == "A" { &self.lists.a } else { &self.lists.b };
        list.iter().map(|s| dec_to_be32(s)).collect()
    }
}

impl FixtureProof {
    pub fn profile_address(&self) -> Address {
        self.profile.parse().unwrap()
    }
    /// The profile's key, to sign with.
    pub fn profile_key(&self) -> Keypair {
        let key = Keypair::new_from_array(from_hex32(&self.profile_seed));
        assert_eq!(key.pubkey(), self.profile_address(), "{}: the profile seed is the profile's", self.name);
        key
    }
    pub fn market_stamp(&self) -> [u8; 32] {
        from_hex32(&self.market_stamp)
    }
    pub fn row_address(&self) -> Address {
        row_address(&self.market_stamp())
    }
    pub fn proof(&self) -> Proof {
        Proof { a: from_hex32(&self.a), b: hex(&self.b).try_into().unwrap(), c: from_hex32(&self.c) }
    }
    /// Everything `register` carries, as this fixture's person would send it.
    pub fn args(&self) -> Args {
        Args {
            market_stamp: self.market_stamp(),
            keeper: self.keeper.parse().unwrap(),
            root: from_hex32(&self.root),
            keeper_signature: hex(&self.keeper_signature).try_into().unwrap(),
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

pub fn dec_to_be32(s: &str) -> [u8; 32] {
    let b = BigUint::parse_bytes(s.as_bytes(), 10).unwrap().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

// ---------------------------------------------------------------------------------------------
// Semaphore's tree, rebuilt the slow way, so each fixture's root can be checked against its list.
// ---------------------------------------------------------------------------------------------

pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b]).unwrap().0
}

/// A full rebuild: pair left to right, copy a node with no right sibling up unhashed.
pub fn lean_imt_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| if pair.len() == 2 { poseidon2(&pair[0], &pair[1]) } else { pair[0] })
            .collect();
    }
    level[0]
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

pub fn row_address(market_stamp: &[u8; 32]) -> Address {
    Address::find_program_address(&[b"row", market_stamp], &PROGRAM_ID).0
}

/// A row's size, discriminator included. It never changes.
pub fn row_space(label_len: usize) -> usize {
    8 + 32 + 32 + 32 + 64 + 32 + 1 + 4 + label_len
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
    pub market_stamp: [u8; 32],
    pub keeper: Address,
    pub root: [u8; 32],
    pub keeper_signature: [u8; 64],
    pub proof: Proof,
    pub label: String,
}

pub fn register_data(args: &Args) -> Vec<u8> {
    let mut data = discriminator("global", "register").to_vec();
    data.extend_from_slice(&args.market_stamp);
    data.extend_from_slice(args.keeper.as_ref());
    data.extend_from_slice(&args.root);
    data.extend_from_slice(&args.keeper_signature);
    data.extend_from_slice(&args.proof.a);
    data.extend_from_slice(&args.proof.b);
    data.extend_from_slice(&args.proof.c);
    data.extend_from_slice(&(args.label.len() as u32).to_le_bytes());
    data.extend_from_slice(args.label.as_bytes());
    data
}

/// Where the label's bytes start in `register`'s data: after the discriminator, every fixed field
/// and the label's four-byte length.
pub const REGISTER_LABEL_AT: usize = 8 + 32 + 32 + 32 + 64 + 128 + 4;

/// `register`: the row, the profile (a signer), the payer (a signer, writable), the system program.
pub fn register_ix(payer: Address, profile: Address, args: &Args) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(row_address(&args.market_stamp), false),
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
    pub keeper: Address,
    pub root: [u8; 32],
    pub keeper_signature: [u8; 64],
    pub payer: Address,
    pub bump: u8,
    pub label: String,
}

/// A row's bytes, read strictly: the discriminator, the fixed fields at their offsets, then the
/// label, and nothing after it.
pub fn read_row(data: &[u8]) -> RowView {
    assert_eq!(&data[..8], &discriminator("account", "Row"), "not a row");
    let label_len = u32::from_le_bytes(data[201..205].try_into().unwrap()) as usize;
    assert_eq!(data.len(), row_space(label_len), "a row is exactly its size");
    RowView {
        profile: Address::try_from(&data[8..40]).unwrap(),
        keeper: Address::try_from(&data[40..72]).unwrap(),
        root: data[72..104].try_into().unwrap(),
        keeper_signature: data[104..168].try_into().unwrap(),
        payer: Address::try_from(&data[168..200]).unwrap(),
        bump: data[200],
        label: String::from_utf8(data[205..].to_vec()).unwrap(),
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

    /// A funded key, for a second payer, a stranger or a relayer.
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

    /// The fixture's row: its profile signs, the harness's payer pays.
    pub fn register(&mut self, p: &FixtureProof) -> Result<litesvm::types::TransactionMetadata, String> {
        let payer = self.payer.insecure_clone();
        self.register_paid_by(&payer, p)
    }

    /// The fixture's row: its profile signs, `payer` pays.
    pub fn register_paid_by(&mut self, payer: &Keypair, p: &FixtureProof) -> Result<litesvm::types::TransactionMetadata, String> {
        let profile = p.profile_key();
        let ix = register_ix(payer.pubkey(), profile.pubkey(), &p.args());
        self.send_signed(&payer.pubkey(), &[payer, &profile], &[ix])
    }

    pub fn set_rent(&mut self, lamports_per_byte: u64) {
        self.svm.set_sysvar(&rent_at(lamports_per_byte));
    }

    pub fn account(&self, address: &Address) -> Account {
        self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"))
    }

    pub fn exists(&self, address: &Address) -> bool {
        self.svm.get_account(address).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn row(&self, market_stamp: &[u8; 32]) -> RowView {
        read_row(&self.account(&row_address(market_stamp)).data)
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

//! The harness, and the registry's wire format written out a second time.
//!
//! Nothing here imports the program crate. The instruction bytes, the account layouts and the
//! discriminators are written by hand, the way an outside client has to write them, so a test
//! passing means the sealed format really is what `src/lib.rs` and `registry/client` both say it
//! is. A drift on either side fails a test instead of passing quietly.

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

pub const PROGRAM_ID: Address = solana_address::address!("FoRPzGfMyWjK8uLjMoZfae2yevnviyCsGsHM7AwBwK8B");
pub const TOKEN_PROGRAM: Address = solana_address::address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// The placeholder treasury the program starts with, and the public seed it is derived from so
/// these tests can sign for it. Replaced with the charter's address before the first deploy.
pub const TREASURY_SEED: [u8; 32] = *b"REPLACE-BEFORE-DEPLOY-treasury-0";
pub const TREASURY: Address = solana_address::address!("F35kGoXPCdZLdanwTGuShYXxAkmkpHP9LWgV7dNvKU5s");
/// Mainnet's USDC, the one address `init` accepts as the first mint. These tests run against the
/// default build; a `--features devnet` build names devnet's instead.
pub const USDC_MINT: Address = solana_address::address!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// USDC's fee, a program constant: 0.25 at six decimals. Written a second time here, by hand. Every
/// other mint's fee is whatever the treasury set at `add_token`.
pub const USDC_FEE: u64 = 250_000;

pub fn treasury_keypair() -> Keypair {
    let kp = Keypair::new_from_array(TREASURY_SEED);
    assert_eq!(kp.pubkey(), TREASURY, "the placeholder seed must derive the program's constant");
    kp
}

/// The placeholder foundation issuer key, and the public seed it is derived from so these tests can
/// sign for it: list 0's owner and its first insert key, written at `init`. Replaced with the
/// foundation's issuer key before the first deploy.
pub const FOUNDATION_ISSUER_SEED: [u8; 32] = *b"REPLACE-BEFORE-DEPLOY-issuer-000";
pub const FOUNDATION_ISSUER: Address = solana_address::address!("H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS");

pub fn foundation_issuer_keypair() -> Keypair {
    let kp = Keypair::new_from_array(FOUNDATION_ISSUER_SEED);
    assert_eq!(kp.pubkey(), FOUNDATION_ISSUER, "the placeholder seed must derive the program's constant");
    kp
}

pub const ROOT_HISTORY: usize = 128;
pub const CONFIG_LEN: usize = 8 + 710;
pub const LIST_LEN: usize = 8 + 5520;
pub const CODE_TREE_LEN: usize = 8 + 1104;
pub const USED_CODE_LEN: usize = 8 + 1;

// ---------------------------------------------------------------------------------------------
// Fixtures: real proofs, made by registry/client/scripts/fixtures.ts with the pinned artifacts.
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct Fixtures {
    pub lists: Vec<FixtureList>,
    #[serde(rename = "extraLeaves")]
    pub extra_leaves: Vec<String>,
    pub proofs: Vec<FixtureProof>,
}

#[derive(Deserialize)]
pub struct FixtureList {
    pub index: u32,
    pub leaves: Vec<String>,
}

#[derive(Deserialize)]
pub struct FixtureProof {
    pub name: String,
    #[serde(rename = "listIndex")]
    pub list_index: u32,
    pub market: String,
    pub did: String,
    /// The profile's wallet, base58: it signs, and the proof's message names it.
    pub wallet: String,
    /// Its 32-byte ed25519 seed, hex, so the tests can sign as it. Alice's is the keys recipe's.
    #[serde(rename = "walletSeed")]
    pub wallet_seed: String,
    pub root: String,
    pub code: String,
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

    pub fn list(&self, index: u32) -> &FixtureList {
        self.lists.iter().find(|l| l.index == index).unwrap()
    }
}

impl FixtureProof {
    /// The profile's wallet, as a key that can sign.
    pub fn wallet_keypair(&self) -> Keypair {
        let kp = Keypair::new_from_array(from_hex32(&self.wallet_seed));
        assert_eq!(kp.pubkey().to_string(), self.wallet, "{}: the wallet seed must derive the wallet", self.name);
        kp
    }
    pub fn root_bytes(&self) -> [u8; 32] {
        from_hex32(&self.root)
    }
    pub fn code_bytes(&self) -> [u8; 32] {
        from_hex32(&self.code)
    }
    pub fn a_bytes(&self) -> [u8; 32] {
        from_hex32(&self.a)
    }
    pub fn b_bytes(&self) -> [u8; 64] {
        let v = hex(&self.b);
        v.try_into().unwrap()
    }
    pub fn c_bytes(&self) -> [u8; 32] {
        from_hex32(&self.c)
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
// Semaphore's tree, rebuilt the slow way, so the program's frontier can be checked against it.
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

pub fn config_address() -> Address {
    Address::find_program_address(&[b"config"], &PROGRAM_ID).0
}
pub fn list_address(index: u32) -> Address {
    Address::find_program_address(&[b"list", &index.to_le_bytes()], &PROGRAM_ID).0
}
pub fn code_tree_address() -> Address {
    Address::find_program_address(&[b"code-tree"], &PROGRAM_ID).0
}
pub fn used_code_address(code: &[u8; 32]) -> Address {
    Address::find_program_address(&[b"code", code], &PROGRAM_ID).0
}

fn borsh_string(s: &str) -> Vec<u8> {
    let mut v = (s.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(s.as_bytes());
    v
}

pub struct RegisterArgs<'a> {
    pub market: &'a str,
    pub did: &'a str,
    pub list_index: u32,
    pub root: [u8; 32],
    pub code: [u8; 32],
    pub proof_a: [u8; 32],
    pub proof_b: [u8; 64],
    pub proof_c: [u8; 32],
}

/// The payer (network fee and the code account's rent), the profile's wallet (consent, named in
/// the proof), and the fee authority with the token account the fee comes from (the profile's
/// wallet itself, or any other key paying for it).
pub struct RegisterAccounts {
    pub payer: Address,
    pub profile_wallet: Address,
    pub fee_authority: Address,
    pub fee_tokens: Address,
    pub treasury_tokens: Address,
}

pub fn register_ix(args: &RegisterArgs, accounts: &RegisterAccounts) -> Instruction {
    let mut data = discriminator("global", "register").to_vec();
    data.extend_from_slice(&borsh_string(args.market));
    data.extend_from_slice(&borsh_string(args.did));
    data.extend_from_slice(&args.list_index.to_le_bytes());
    data.extend_from_slice(&args.root);
    data.extend_from_slice(&args.code);
    data.extend_from_slice(&args.proof_a);
    data.extend_from_slice(&args.proof_b);
    data.extend_from_slice(&args.proof_c);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(config_address(), false),
            AccountMeta::new_readonly(list_address(args.list_index), false),
            AccountMeta::new(code_tree_address(), false),
            AccountMeta::new(used_code_address(&args.code), false),
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(accounts.profile_wallet, true),
            AccountMeta::new_readonly(accounts.fee_authority, true),
            AccountMeta::new(accounts.fee_tokens, false),
            AccountMeta::new(accounts.treasury_tokens, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data,
    }
}

/// `init` takes no argument and no treasury signer: the mint account it names is the one at the
/// program's constant, and the treasury it writes is the program's constant.
pub fn init_ix(payer: Address, usdc: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new(list_address(0), false),
            AccountMeta::new(code_tree_address(), false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(usdc, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data: discriminator("global", "init").to_vec(),
    }
}

/// Step one of a handover: the current treasury signs. `None` clears a pending proposal. Borsh
/// writes an `Option<Pubkey>` as one tag byte, `0x00` for none or `0x01` followed by the key.
pub fn propose_treasury_ix(treasury: Address, new_treasury: Option<Address>) -> Instruction {
    let mut data = discriminator("global", "propose_treasury").to_vec();
    match new_treasury {
        Some(key) => {
            data.push(1);
            data.extend_from_slice(key.as_ref());
        }
        None => data.push(0),
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new_readonly(treasury, true),
        ],
        data,
    }
}

/// Step two: the pending key signs, and only then does the treasury move.
pub fn accept_treasury_ix(pending: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new_readonly(pending, true),
        ],
        data: discriminator("global", "accept_treasury").to_vec(),
    }
}

/// `open_list`: anyone. `payer` pays the list's rent; `owner` signs and is recorded as the list's
/// owner and its first insert key. They may be the same key.
pub fn open_list_ix(payer: Address, owner: Address, new_index: u32) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new(list_address(new_index), false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data: discriminator("global", "open_list").to_vec(),
    }
}

/// `add_issuer` or `remove_issuer`: the list's owner signs. No config: the treasury has no say.
pub fn issuer_ix(name: &str, owner: Address, list_index: u32, issuer: Address) -> Instruction {
    let mut data = discriminator("global", name).to_vec();
    data.extend_from_slice(&list_index.to_le_bytes());
    data.extend_from_slice(issuer.as_ref());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(list_address(list_index), false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

/// `close_list`: the same accounts as the issuer instructions, and the list index.
pub fn close_list_ix(owner: Address, list_index: u32) -> Instruction {
    let mut data = discriminator("global", "close_list").to_vec();
    data.extend_from_slice(&list_index.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(list_address(list_index), false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

/// Step one of a list's handover (session 15): the list's owner signs. `None` clears a pending
/// proposal. The same `Option` bytes as `propose_treasury`, after the list index.
pub fn propose_list_owner_ix(owner: Address, list_index: u32, new_owner: Option<Address>) -> Instruction {
    let mut data = discriminator("global", "propose_list_owner").to_vec();
    data.extend_from_slice(&list_index.to_le_bytes());
    match new_owner {
        Some(key) => {
            data.push(1);
            data.extend_from_slice(key.as_ref());
        }
        None => data.push(0),
    }
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(list_address(list_index), false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

/// Step two: the proposed key signs, and only then does the list change owner.
pub fn accept_list_owner_ix(pending: Address, list_index: u32) -> Instruction {
    let mut data = discriminator("global", "accept_list_owner").to_vec();
    data.extend_from_slice(&list_index.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(list_address(list_index), false),
            AccountMeta::new_readonly(pending, true),
        ],
        data,
    }
}

pub fn insert_identity_ix(issuer: Address, list_index: u32, commitment: [u8; 32]) -> Instruction {
    let mut data = discriminator("global", "insert_identity").to_vec();
    data.extend_from_slice(&list_index.to_le_bytes());
    data.extend_from_slice(&commitment);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(list_address(list_index), false),
            AccountMeta::new_readonly(issuer, true),
        ],
        data,
    }
}

/// `add_token`: the mint, at `fee` in its own base units.
pub fn add_token_ix(treasury: Address, mint: Address, fee: u64) -> Instruction {
    let mut data = discriminator("global", "add_token").to_vec();
    data.extend_from_slice(&fee.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(config_address(), false),
            AccountMeta::new_readonly(treasury, true),
            AccountMeta::new_readonly(mint, false),
        ],
        data,
    }
}

pub enum SweepTarget {
    Config,
    CodeTree,
    List(u32),
    Code([u8; 32]),
}

impl SweepTarget {
    pub fn bytes(&self) -> Vec<u8> {
        match self {
            SweepTarget::Config => vec![0],
            SweepTarget::CodeTree => vec![1],
            SweepTarget::List(i) => {
                let mut v = vec![2];
                v.extend_from_slice(&i.to_le_bytes());
                v
            }
            SweepTarget::Code(code) => {
                let mut v = vec![3];
                v.extend_from_slice(code);
                v
            }
        }
    }
    pub fn address(&self) -> Address {
        match self {
            SweepTarget::Config => config_address(),
            SweepTarget::CodeTree => code_tree_address(),
            SweepTarget::List(i) => list_address(*i),
            SweepTarget::Code(code) => used_code_address(code),
        }
    }
}

/// `sweep_rent`: no signer. `recipient` is where the excess goes: a list's owner for a list, the
/// treasury for anything else (session 15).
pub fn sweep_rent_ix(target: &SweepTarget, recipient: Address) -> Instruction {
    let mut data = discriminator("global", "sweep_rent").to_vec();
    data.extend_from_slice(&target.bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(config_address(), false),
            AccountMeta::new(target.address(), false),
            AccountMeta::new(recipient, false),
        ],
        data,
    }
}

// ---------------------------------------------------------------------------------------------
// Account layouts, read back out of the raw bytes.
// ---------------------------------------------------------------------------------------------

pub struct ConfigView {
    pub treasury: Address,
    pub mints: Vec<Address>,
    /// One per accepted mint, at the same index: its fee in its own base units.
    pub fees: Vec<u64>,
    pub list_count: u32,
    /// The proposed treasury, or the zero key when no handover is pending.
    pub pending_treasury: Address,
}

/// treasury 0..32, mints 32..544, fees 544..672, mint_count 672, list_count 673..677, bump 677,
/// pending_treasury 678..710.
pub fn read_config(data: &[u8]) -> ConfigView {
    let b = &data[8..];
    let mint_count = b[672] as usize;
    ConfigView {
        treasury: Address::try_from(&b[0..32]).unwrap(),
        mints: (0..mint_count).map(|i| Address::try_from(&b[32 + i * 32..64 + i * 32]).unwrap()).collect(),
        fees: (0..mint_count).map(|i| u64::from_le_bytes(b[544 + i * 8..552 + i * 8].try_into().unwrap())).collect(),
        list_count: u32::from_le_bytes(b[673..677].try_into().unwrap()),
        pending_treasury: Address::try_from(&b[678..710]).unwrap(),
    }
}

pub struct ListView {
    pub leaf_count: u64,
    pub index: u32,
    pub issuer_count: u8,
    /// Byte 14, once padding.
    pub closed: bool,
    pub root: [u8; 32],
    pub roots: Vec<[u8; 32]>,
    pub issuers: Vec<Address>,
    /// Bytes 5456..5488, appended: who owns the list and alone manages its insert keys. The zero
    /// key when the account is too short to hold one, as a list made before session 14 was.
    pub owner: Address,
    /// Bytes 5488..5520, appended in session 15: the key the owner has proposed to hand the list
    /// to, or the zero key when none is pending (or the account is too short to hold one).
    pub pending_owner: Address,
}

pub fn read_list(data: &[u8]) -> ListView {
    let b = &data[8..];
    let issuer_count = b[12];
    ListView {
        leaf_count: u64::from_le_bytes(b[0..8].try_into().unwrap()),
        index: u32::from_le_bytes(b[8..12].try_into().unwrap()),
        issuer_count,
        closed: b[14] != 0,
        root: b[16..48].try_into().unwrap(),
        roots: (0..ROOT_HISTORY).map(|i| b[1104 + i * 32..1136 + i * 32].try_into().unwrap()).collect(),
        issuers: (0..issuer_count as usize)
            .map(|i| Address::try_from(&b[5200 + i * 32..5232 + i * 32]).unwrap())
            .collect(),
        owner: b.get(5456..5488).map(|o| Address::try_from(o).unwrap()).unwrap_or_default(),
        pending_owner: b.get(5488..5520).map(|o| Address::try_from(o).unwrap()).unwrap_or_default(),
    }
}

pub struct CodeTreeView {
    pub count: u64,
    pub root: [u8; 32],
}

pub fn read_code_tree(data: &[u8]) -> CodeTreeView {
    let b = &data[8..];
    CodeTreeView {
        count: u64::from_le_bytes(b[0..8].try_into().unwrap()),
        root: b[16..48].try_into().unwrap(),
    }
}

pub fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

/// The `Registered` event, decoded from the `Program data:` line Anchor writes.
pub struct RegisteredEvent {
    pub market: String,
    pub did: String,
    pub wallet: Address,
    pub code: [u8; 32],
    pub list_index: u32,
    /// The owner of the list the proof was made against, appended in session 14. The zero key if
    /// the entry is too short to hold one.
    pub list_owner: Address,
}

pub fn registered_events(logs: &[String]) -> Vec<RegisteredEvent> {
    let want = discriminator("event", "Registered");
    let mut out = Vec::new();
    for line in logs {
        let Some(payload) = line.strip_prefix("Program data: ") else { continue };
        let Ok(bytes) = base64_decode(payload) else { continue };
        if bytes.len() < 8 || bytes[..8] != want {
            continue;
        }
        let mut at = 8usize;
        let read_string = |at: &mut usize| {
            let len = u32::from_le_bytes(bytes[*at..*at + 4].try_into().unwrap()) as usize;
            *at += 4;
            let s = String::from_utf8(bytes[*at..*at + len].to_vec()).unwrap();
            *at += len;
            s
        };
        let market = read_string(&mut at);
        let did = read_string(&mut at);
        let wallet = Address::try_from(&bytes[at..at + 32]).unwrap();
        at += 32;
        let code: [u8; 32] = bytes[at..at + 32].try_into().unwrap();
        at += 32;
        let list_index = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        at += 4;
        let list_owner = bytes.get(at..at + 32).map(|o| Address::try_from(o).unwrap()).unwrap_or_default();
        out.push(RegisteredEvent { market, did, wallet, code, list_index, list_owner });
    }
    out
}

/// Every `ListOpened` entry in a log, as (list index, owner). The owner is the zero key when the
/// entry is too short to hold one, as before session 14.
pub fn list_opened_events(logs: &[String]) -> Vec<(u32, Address)> {
    let want = discriminator("event", "ListOpened");
    let mut out = Vec::new();
    for line in logs {
        let Some(payload) = line.strip_prefix("Program data: ") else { continue };
        let Ok(bytes) = base64_decode(payload) else { continue };
        if bytes.len() < 12 || bytes[..8] != want {
            continue;
        }
        let index = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let owner = bytes.get(12..44).map(|o| Address::try_from(o).unwrap()).unwrap_or_default();
        out.push((index, owner));
    }
    out
}

/// Every `ListOwnerProposed` entry in a log, as (list index, owner, proposed key; zero when a
/// proposal was cleared). Session 15.
pub fn list_owner_proposed_events(logs: &[String]) -> Vec<(u32, Address, Address)> {
    three_field_events(logs, "ListOwnerProposed")
}

/// Every `ListOwnerChanged` entry in a log, as (list index, from, to). Session 15.
pub fn list_owner_changed_events(logs: &[String]) -> Vec<(u32, Address, Address)> {
    three_field_events(logs, "ListOwnerChanged")
}

fn three_field_events(logs: &[String], name: &str) -> Vec<(u32, Address, Address)> {
    let want = discriminator("event", name);
    let mut out = Vec::new();
    for line in logs {
        let Some(payload) = line.strip_prefix("Program data: ") else { continue };
        let Ok(bytes) = base64_decode(payload) else { continue };
        if bytes.len() != 8 + 4 + 32 + 32 || bytes[..8] != want {
            continue;
        }
        let index = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let a = Address::try_from(&bytes[12..44]).unwrap();
        let b = Address::try_from(&bytes[44..76]).unwrap();
        out.push((index, a, b));
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

pub struct Harness {
    pub svm: LiteSVM,
    pub payer: Keypair,
    /// The treasury: the placeholder the program starts with, held here so tests can sign for it.
    /// Where the fee and swept rent go, and the key that turns every dial.
    pub treasury_key: Keypair,
    pub treasury: Address,
    /// The foundation's issuer key: the placeholder the program writes at `init` as list 0's owner
    /// and first insert key, held here so tests can sign for it.
    pub issuer: Keypair,
    /// The mint at the program's `USDC_MINT` constant.
    pub usdc: Address,
    /// A token account for it, owned by the treasury.
    pub treasury_tokens: Address,
}

pub fn spl_mint_account(decimals: u8) -> Account {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1; // is_initialized
    Account { lamports: 1_461_600, data: d, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }
}

pub fn spl_token_account(mint: &Address, owner: &Address, amount: u64) -> Account {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state: Initialized
    Account { lamports: 2_039_280, data: d, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }
}

/// The rate mainnet charged before September 2026.
pub const RENT_HIGH: u64 = 6_960;
/// The rate session 3 read from the mainnet Rent sysvar, part way through SIMD-0437's five steps.
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

impl Harness {
    /// The program loaded, the keys made and a USDC-shaped mint set up. Nothing initialised yet.
    pub fn bare() -> Self {
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/forest_registry.so");
        let bytes = std::fs::read(&so).unwrap_or_else(|e| {
            panic!("{}: {e}. Build it first: `cargo build-sbf` in registry/program.", so.display())
        });
        let mut svm = LiteSVM::new();
        svm.add_program(PROGRAM_ID, &bytes).unwrap();

        let payer = Keypair::new();
        let treasury_key = treasury_keypair();
        let treasury = treasury_key.pubkey();
        let issuer = foundation_issuer_keypair();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&treasury, 1_000_000).unwrap();

        // A six-decimal mint planted at USDC's address, the only one `init` accepts.
        let usdc = USDC_MINT;
        svm.set_account(usdc, spl_mint_account(6)).unwrap();
        let treasury_tokens = Address::new_unique();
        svm.set_account(treasury_tokens, spl_token_account(&usdc, &treasury, 0)).unwrap();

        Harness { svm, payer, treasury_key, treasury, issuer, usdc, treasury_tokens }
    }

    /// A registry with one list, USDC accepted, and the treasury ready to be paid. `init` is sent
    /// by the payer alone: nothing about the treasury or the list's owner is in the instruction.
    /// List 0 opens owned by the foundation's issuer key, which is also its first insert key, so
    /// nothing else is needed before `insert`.
    pub fn new() -> Self {
        let mut h = Harness::bare();
        let payer_key = h.payer.pubkey();
        let usdc = h.usdc;
        h.send(&[init_ix(payer_key, usdc)], &[Harness::PAYER]).expect("init");
        h
    }

    pub const PAYER: u8 = 0;
    pub const TREASURY: u8 = 1;
    pub const ISSUER: u8 = 2;

    fn signer(&self, which: u8) -> &Keypair {
        match which {
            Harness::PAYER => &self.payer,
            Harness::TREASURY => &self.treasury_key,
            Harness::ISSUER => &self.issuer,
            _ => unreachable!(),
        }
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[u8],
    ) -> Result<litesvm::types::TransactionMetadata, String> {
        self.svm.expire_blockhash();
        let keys: Vec<&Keypair> = signers.iter().map(|s| self.signer(*s)).collect();
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&keys, msg, self.svm.latest_blockhash());
        self.send_tx(tx)
    }

    pub fn send_signed(
        &mut self,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<litesvm::types::TransactionMetadata, String> {
        self.svm.expire_blockhash();
        let mut keys: Vec<&Keypair> = vec![&self.payer];
        keys.extend_from_slice(extra);
        let msg = Message::new(ixs, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&keys, msg, self.svm.latest_blockhash());
        self.send_tx(tx)
    }

    pub fn send_tx(
        &mut self,
        tx: Transaction,
    ) -> Result<litesvm::types::TransactionMetadata, String> {
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta),
            Err(e) => Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
        }
    }

    pub fn insert(&mut self, list_index: u32, commitment: [u8; 32]) {
        let issuer = self.issuer.pubkey();
        self.send(&[insert_identity_ix(issuer, list_index, commitment)], &[Harness::PAYER, Harness::ISSUER])
            .expect("insert_identity");
    }

    /// `insert_identity` signed by any insert key, such as the owner of a list a stranger opened.
    pub fn insert_as(&mut self, issuer: &Keypair, list_index: u32, commitment: [u8; 32]) -> Result<litesvm::types::TransactionMetadata, String> {
        self.send_signed(&[insert_identity_ix(issuer.pubkey(), list_index, commitment)], &[issuer])
    }

    /// Anyone opens the next list: `owner` pays its rent and owns it. Returns the new index.
    pub fn open_list_as(&mut self, owner: &Keypair) -> Result<(u32, litesvm::types::TransactionMetadata), String> {
        let index = self.config().list_count;
        let meta = self.send_signed(&[open_list_ix(owner.pubkey(), owner.pubkey(), index)], &[owner])?;
        Ok((index, meta))
    }

    pub fn account(&self, address: &Address) -> Account {
        self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"))
    }

    pub fn config(&self) -> ConfigView {
        read_config(&self.account(&config_address()).data)
    }
    pub fn list(&self, index: u32) -> ListView {
        read_list(&self.account(&list_address(index)).data)
    }
    pub fn code_tree(&self) -> CodeTreeView {
        read_code_tree(&self.account(&code_tree_address()).data)
    }

    pub fn lamports_of(&self, address: &Address) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }

    /// The treasury's own key, so a test can make it sign outside `send`.
    pub fn treasury_signer(&self) -> Keypair {
        self.treasury_key.insecure_clone()
    }

    /// A token account for `mint`, owned by whoever `owner` is, holding nothing.
    pub fn token_account_for(&mut self, mint: Address, owner: Address) -> Address {
        let tokens = Address::new_unique();
        self.svm.set_account(tokens, spl_token_account(&mint, &owner, 0)).unwrap();
        tokens
    }

    /// A profile's own wallet, from its fixture, with a token account for `mint` holding `amount`:
    /// the paid path, where the profile pays its own fee.
    pub fn profile_with(&mut self, p: &FixtureProof, mint: Address, amount: u64) -> (Keypair, Address) {
        let wallet = p.wallet_keypair();
        let tokens = Address::new_unique();
        self.svm.set_account(tokens, spl_token_account(&mint, &wallet.pubkey(), amount)).unwrap();
        (wallet, tokens)
    }

    /// A wallet holding `amount` of `mint`, ready to pay.
    pub fn wallet_with(&mut self, mint: Address, amount: u64) -> (Keypair, Address) {
        let wallet = Keypair::new();
        let tokens = Address::new_unique();
        self.svm.set_account(tokens, spl_token_account(&mint, &wallet.pubkey(), amount)).unwrap();
        (wallet, tokens)
    }
}

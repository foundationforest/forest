//! Scratch program: measures what a registration would cost in compute units.
//! Instruction data: [n_proofs u8][hash_rounds u8][n_pdas u8][transfer u8][market_len u8][market bytes]
//! then per proof: proof_a (64, already negated) | proof_b (128) | proof_c (64) | 4 public inputs (4 x 32).
//! Accounts: [payer (signer, writable)] [system program] [pda_0 .. pda_(n-1)] [token: source, dest, authority (signer), token program].
use groth16_solana::groth16::Groth16Verifier;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    keccak,
    log::sol_log_compute_units,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use solana_poseidon::{hashv, Endianness, Parameters};

mod verifying_key;
use verifying_key::VERIFYINGKEY;

entrypoint!(process);

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let n_proofs = data[0] as usize;
    let hash_rounds = data[1] as usize;
    let n_pdas = data[2] as usize;
    let transfer = data[3] == 1;
    let market_len = data[4] as usize;
    let market = &data[5..5 + market_len];
    let mut rest = &data[5 + market_len..];
    msg!("start");
    sol_log_compute_units();

    let mut nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut first_scope = [0u8; 32];
    for i in 0..n_proofs {
        let proof_a: &[u8; 64] = rest[0..64].try_into().unwrap();
        let proof_b: &[u8; 128] = rest[64..192].try_into().unwrap();
        let proof_c: &[u8; 64] = rest[192..256].try_into().unwrap();
        let mut inputs = [[0u8; 32]; 4];
        for (j, chunk) in rest[256..384].chunks(32).enumerate() {
            inputs[j].copy_from_slice(chunk);
        }
        nullifiers.push(inputs[1]);
        if i == 0 {
            first_scope = inputs[3];
        }
        let mut verifier = Groth16Verifier::new(proof_a, proof_b, proof_c, &inputs, &VERIFYINGKEY)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        verifier.verify().map_err(|_| ProgramError::InvalidArgument)?;
        msg!("verified proof {}", i);
        sol_log_compute_units();
        rest = &rest[384..];
    }

    // scope = keccak256(market name padded to 32 bytes) >> 8, as Semaphore's proof package does it.
    let mut padded = [0u8; 32];
    padded[..market.len()].copy_from_slice(market);
    let h = keccak::hashv(&[&padded]).0;
    let mut scope = [0u8; 32];
    scope[1..].copy_from_slice(&h[..31]);
    // The program never trusts the client's scope: it recomputes keccak256(name) >> 8 from the
    // market name in the instruction and requires the first proof's scope public signal to equal it.
    if n_proofs > 0 && scope != first_scope {
        msg!("scope mismatch: the proof was not made for this market name");
        return Err(ProgramError::InvalidArgument);
    }
    msg!("keccak scope checked against the proof");
    sol_log_compute_units();

    // A tree insert: one Poseidon(2) per level, big-endian field elements, BN254 x^5 (Semaphore's Poseidon).
    let mut node = scope;
    let sibling = [7u8; 32];
    for _ in 0..hash_rounds {
        node = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&node, &sibling])
            .map_err(|_| ProgramError::InvalidArgument)?
            .to_bytes();
    }
    msg!("poseidon x{}", hash_rounds);
    sol_log_compute_units();

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let rent = Rent::get()?;
    for i in 0..n_pdas {
        let pda = next_account_info(iter)?;
        let seed_key = nullifiers.get(i).copied().unwrap_or([i as u8; 32]);
        let (expected, bump) = Pubkey::find_program_address(&[b"code", &seed_key], program_id);
        if expected != *pda.key {
            return Err(ProgramError::InvalidSeeds);
        }
        let space = 40u64; // discriminator 8 + the badge number and a pointer would fit here
        invoke_signed(
            &system_instruction::create_account(payer.key, pda.key, rent.minimum_balance(space as usize), space, program_id),
            &[payer.clone(), pda.clone(), system.clone()],
            &[&[b"code", &seed_key, &[bump]]],
        )?;
        pda.try_borrow_mut_data()?[..8].copy_from_slice(b"FORESTv1");
    }
    msg!("pdas x{}", n_pdas);
    sol_log_compute_units();

    if transfer {
        let source = next_account_info(iter)?;
        let dest = next_account_info(iter)?;
        let authority = next_account_info(iter)?;
        let token_program = next_account_info(iter)?;
        // SPL Token `Transfer` (tag 3) with amount 250_000 base units (0.25 with 6 decimals).
        let mut ix_data = vec![3u8];
        ix_data.extend_from_slice(&250_000u64.to_le_bytes());
        let ix = Instruction {
            program_id: *token_program.key,
            accounts: vec![
                AccountMeta::new(*source.key, false),
                AccountMeta::new(*dest.key, false),
                AccountMeta::new_readonly(*authority.key, true),
            ],
            data: ix_data,
        };
        invoke(&ix, &[source.clone(), dest.clone(), authority.clone(), token_program.clone()])?;
        msg!("transfer");
        sol_log_compute_units();
    }
    msg!("end");
    sol_log_compute_units();
    Ok(())
}

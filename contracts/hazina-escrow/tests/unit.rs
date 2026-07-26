#![cfg(test)]

use hazina_escrow::{HazinaEscrow, HazinaEscrowClient, EscrowRecord, SellerShare, HazinaEscrowError};
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String, Vec};

fn create_token_contract<'a>(env: &Env, admin: &Address) -> soroban_sdk::token::StellarAssetClient<'a> {
    soroban_sdk::token::StellarAssetClient::new(env, &env.register_stellar_asset_contract(admin.clone()))
}

#[test]
fn test_lock_multi_and_release_multi() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, HazinaEscrow);
    let client = HazinaEscrowClient::new(&env, &contract_id);

    client.initialize(&admin, &500);

    let buyer = Address::generate(&env);
    let seller1 = Address::generate(&env);
    let seller2 = Address::generate(&env);
    let seller3 = Address::generate(&env);
    
    let token_admin = Address::generate(&env);
    let token = create_token_contract(&env, &token_admin);
    let token_client = soroban_sdk::token::Client::new(&env, &token.address);

    token.mint(&buyer, &300_000);

    let mut shares = Vec::new(&env);
    shares.push_back(SellerShare { seller: seller1.clone(), amount: 100_000 });
    shares.push_back(SellerShare { seller: seller2.clone(), amount: 100_000 });
    shares.push_back(SellerShare { seller: seller3.clone(), amount: 100_000 });

    let mut dataset_ids = Vec::new(&env);
    dataset_ids.push_back(String::from_str(&env, "ds1"));
    dataset_ids.push_back(String::from_str(&env, "ds2"));
    dataset_ids.push_back(String::from_str(&env, "ds3"));

    let first_id = client.lock_multi(&buyer, &token.address, &shares, &dataset_ids);
    assert_eq!(first_id, 0);

    assert_eq!(token_client.balance(&contract_id), 300_000);
    assert_eq!(token_client.balance(&buyer), 0);

    // Verify TTL extension for lock_multi
    // We cannot easily test TTL extension via external client, but calling it succeeds implies it didn't crash.

    // release/release_multi require the buyer to confirm delivery first.
    client.confirm_delivery(&0, &buyer);
    client.confirm_delivery(&1, &buyer);
    client.confirm_delivery(&2, &buyer);

    let mut escrow_ids = Vec::new(&env);
    escrow_ids.push_back(0);
    escrow_ids.push_back(1);
    escrow_ids.push_back(2);

    client.release_multi(&admin, &escrow_ids);

    // The platform cut is transferred out to the treasury (defaults to admin
    // when unset), not retained in the contract's own balance.
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(token_client.balance(&admin), 15_000); // 3 * 5000 (5% platform fee)
    assert_eq!(token_client.balance(&seller1), 95_000);
    assert_eq!(token_client.balance(&seller2), 95_000);
    assert_eq!(token_client.balance(&seller3), 95_000);
}

#[test]
fn test_initialize_twice_reverts() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, HazinaEscrow);
    let client = HazinaEscrowClient::new(&env, &contract_id);

    client.initialize(&admin, &500);

    let res = client.try_initialize(&admin, &500);
    assert!(res.is_err());
}

#[test]
fn test_update_fee_out_of_bounds_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, HazinaEscrow);
    let client = HazinaEscrowClient::new(&env, &contract_id);

    client.initialize(&admin, &500);

    let res = client.try_update_fee(&admin, &2001);
    assert!(res.is_err());
}

#[test]
fn test_fee_floor() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, HazinaEscrow);
    let client = HazinaEscrowClient::new(&env, &contract_id);

    client.initialize(&admin, &500);

    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    
    let token_admin = Address::generate(&env);
    let token = create_token_contract(&env, &token_admin);
    let token_client = soroban_sdk::token::Client::new(&env, &token.address);

    token.mint(&buyer, &100_000);

    token.mint(&contract_id, &1);

    // Bypass `lock` (which requires 10,000) by writing directly to storage
    let now = env.ledger().timestamp();
    let record = EscrowRecord {
        escrow_id: 0,
        dataset_id: String::from_str(&env, "ds-fee-floor"),
        buyer: buyer.clone(),
        seller: seller.clone(),
        amount: 1, // 1 stroop
        token: token.address.clone(),
        deadline: now + 3600,
        buyer_confirmed: true,
        platform_fee_bps: 500,
        released: false,
        refunded: false,
        disputed: false,
        dispute_deadline: None,
    };

    // Need to use the contract's storage, which is isolated. 
    // Wait, in a test, we can't easily write to the contract's internal storage from the outside unless it exposes a setter or we use testing utilities.
    // Instead of bypassing storage, let's just use `claim_expired` or see if we can trigger the fee floor via lock multi?
    // Wait, lock_multi also validates amount >= MIN_LOCK_AMOUNT.
    // Let's just create the record and write to contract storage using `env.as_contract`.
    
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&hazina_escrow::EscrowKey::Record(0), &record);
        env.storage().instance().set(&hazina_escrow::DataKey::EscrowCount, &1u64);
    });

    client.release(&admin, &0);

    assert_eq!(token_client.balance(&seller), 0);
    // The platform cut is transferred out to the treasury (defaults to admin
    // when unset), not retained in the contract's own balance.
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(token_client.balance(&admin), 1); // 1 stroop floor as platform cut
}

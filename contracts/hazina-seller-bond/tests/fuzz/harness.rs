//! Shared scaffold for the property-based invariant suite.
//!
//! Three jobs: build a fresh bond world per proptest case, expose input
//! strategies derived from the contract's own constants, and hold the
//! expected-value model for the slash math in one place.

#![allow(dead_code)]

use hazina_seller_bond::{
    HazinaSellerBond, HazinaSellerBondClient, MAX_BASIS_POINTS, MAX_SLASH_BPS,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, FileFailurePersistence};
use soroban_sdk::testutils::{Address as _, EnvTestConfig, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env};

pub const START_TIMESTAMP: u64 = 1_000;
pub const START_SEQUENCE: u32 = 100;

/// Seller float, large enough that several staking/slash cycles don't
/// exhaust the balance.
pub const SELLER_FLOAT: i128 = 1_000_000_000_000; // 100 000 USDC

/// A test `Env` with auth mocked and snapshot-at-drop disabled.
pub fn bare_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    const TEST_ENTRY_TTL: u32 = 1_000_000;
    env.ledger().set_min_persistent_entry_ttl(TEST_ENTRY_TTL);
    env.ledger().set_max_entry_ttl(TEST_ENTRY_TTL);
    env.mock_all_auths();
    env
}

// ─── World ───────────────────────────────────────────────────────────────────

/// One initialised bond world: token, bond contract, and the accounts
/// money can legally reach.
pub struct BondWorld {
    pub env: Env,
    pub client: HazinaSellerBondClient<'static>,
    pub token: TokenClient<'static>,
    pub admin: Address,
    pub seller: Address,
    pub arbitrator: Address,
    pub bond_contract: Address,
}

/// Balances over every account the bond flow touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Balances {
    pub seller: i128,
    pub arbitrator: i128,
    pub beneficiary: i128,
    pub contract: i128,
}

impl Balances {
    pub fn total(&self) -> i128 {
        self.seller + self.arbitrator + self.beneficiary + self.contract
    }
}

impl BondWorld {
    pub fn new(cooldown_secs: u32) -> Self {
        let env = bare_env();
        env.ledger().set_timestamp(START_TIMESTAMP);
        env.ledger().set_sequence_number(START_SEQUENCE);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let arbitrator = Address::generate(&env);

        // Use a dummy escrow address that returns 0 open disputes.
        // For tests needing real escrow interaction, use `with_escrow`.
        let escrow_contract = Address::generate(&env);

        let token_address = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(&env, &token_address).mint(&seller, &SELLER_FLOAT);
        let token = TokenClient::new(&env, &token_address);

        let bond_contract = env.register(HazinaSellerBond, ());
        let client = HazinaSellerBondClient::new(&env, &bond_contract);
        client.init(
            &admin,
            &token_address,
            &arbitrator,
            &escrow_contract,
            &cooldown_secs,
        );

        BondWorld {
            env,
            client,
            token,
            admin,
            seller,
            arbitrator,
            bond_contract,
        }
    }

    pub fn token_address(&self) -> Address {
        self.token.address.clone()
    }

    pub fn balances(&self, beneficiary: &Address) -> Balances {
        Balances {
            seller: self.token.balance(&self.seller),
            arbitrator: self.token.balance(&self.arbitrator),
            beneficiary: self.token.balance(beneficiary),
            contract: self.token.balance(&self.bond_contract),
        }
    }

    pub fn advance_timestamp(&self, secs: u64) {
        self.env.ledger().set_timestamp(secs);
    }
}

// ─── Expected-value model ────────────────────────────────────────────────────

/// The contract's slash cut, including the floor of 1 stroop and the clamp
/// to `staked`.
pub fn expected_slash_cut(staked: i128, bps: u32) -> i128 {
    let raw = staked * (bps as i128) / (MAX_BASIS_POINTS as i128);
    core::cmp::min(staked, core::cmp::max(1, raw))
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/// Staking amounts, weighted toward interesting regions.
pub fn stake_amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        2 => Just(1i128),                          // dust
        2 => Just(1_000_000_000i128),              // exactly Bronze
        2 => Just(25_000_000_000i128),             // exactly Gold
        6 => 1i128..1_000_000_000i128,
        6 => 1_000_000_000i128..25_000_000_000i128,
        3 => 25_000_000_000i128..=100_000_000_000i128,
    ]
}

/// Slash basis points, every value the contract accepts.
pub fn slash_bps() -> impl Strategy<Value = u32> {
    prop_oneof![
        2 => Just(1u32),
        2 => Just(MAX_SLASH_BPS),
        1 => Just(0u32),   // invalid
        5 => 0..=MAX_SLASH_BPS,
        1 => (MAX_SLASH_BPS + 1)..=u32::MAX, // invalid
    ]
}

/// Valid slash basis points (non-zero, within cap).
pub fn valid_slash_bps() -> impl Strategy<Value = u32> {
    1..=MAX_SLASH_BPS
}

/// Cooldown durations.
pub fn cooldown_secs() -> impl Strategy<Value = u32> {
    prop_oneof![
        2 => Just(3_600u32),      // 1 hour
        2 => Just(86_400u32),     // 1 day
        6 => 3_600..86_400u32,
    ]
}

// ─── Proptest configuration ──────────────────────────────────────────────────

pub const DEFAULT_CASES: u32 = 48;

pub fn config(persistence_file: &'static str) -> Config {
    Config {
        cases: DEFAULT_CASES,
        max_shrink_iters: 2_048,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(persistence_file))),
        ..Config::default()
    }
}

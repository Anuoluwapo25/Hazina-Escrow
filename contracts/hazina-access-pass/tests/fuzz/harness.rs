//! Shared scaffold for the access-pass property suite.
//!
//! Three jobs: build a fresh contract world per proptest case (real escrow
//! contract included, so the cross-contract fee lookup is exercised for
//! real), expose input strategies bounded by the contract's own constants,
//! and provide the proptest config that persists failing seeds to one
//! predictable committed directory.

#![allow(dead_code)]

use hazina_access_pass::{HazinaAccessPass, HazinaAccessPassClient, MIN_SUB_AMOUNT};
use hazina_escrow::{HazinaEscrow, HazinaEscrowClient};
use proptest::prelude::*;
use proptest::test_runner::{Config, FileFailurePersistence};
use soroban_sdk::testutils::{Address as _, EnvTestConfig, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, String as SorobanString};

/// Non-zero start so "before expiry" and "after expiry" are never satisfied
/// by a degenerate zero clock.
pub const START_TIMESTAMP: u64 = 1_000;

/// Buyer float, comfortably above any price a generated case can produce.
pub const BUYER_FLOAT: i128 = 1_000_000_000_000;

/// The default fee the escrow contract is initialized with in every world;
/// the lifecycle model hardcodes this constant.
pub const DEFAULT_FEE_BPS: u32 = 500;

/// A test `Env` with auth mocked and **snapshot-at-drop disabled**. A property
/// test builds one `Env` per case; leaving capture on would dump thousands of
/// near-identical JSON files into `test_snapshots/` on every run.
///
/// MAX persistent TTL is raised so the contract's 518_400-ledger extensions
/// are legal; the floor stays at the SDK default because nothing here jumps
/// the ledger sequence (ops advance wall-clock time, not sequences).
pub fn bare_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_max_entry_ttl(1_000_000);
    env.mock_all_auths();
    env
}

// ─── World ───────────────────────────────────────────────────────────────────

/// One initialised world: token, escrow contract, access-pass contract, and
/// the accounts money can legally reach. Exactly one plan exists, defined by
/// the seller from the case's generated parameters.
pub struct World {
    pub env: Env,
    pub client: HazinaAccessPassClient<'static>,
    pub admin: Address,
    pub seller: Address,
    pub buyers: [Address; 3],
    pub usdc: Address,
    pub token: TokenClient<'static>,
    pub plan_id: u64,
    pub dataset_id: SorobanString,
    pub price: i128,
    pub period: u64,
    pub max_seats: u32,
}

impl World {
    pub fn new(price: i128, period: u64, max_seats: u32) -> World {
        let env = bare_env();
        env.ledger().set_timestamp(START_TIMESTAMP);

        let admin = Address::generate(&env);
        let seller = Address::generate(&env);
        let buyers = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let token = TokenClient::new(&env, &usdc);
        let sac = StellarAssetClient::new(&env, &usdc);
        for buyer in &buyers {
            sac.mint(buyer, &BUYER_FLOAT);
        }

        let escrow_id = env.register(HazinaEscrow, ());
        let escrow_client = HazinaEscrowClient::new(&env, &escrow_id);
        escrow_client.initialize(&admin, &DEFAULT_FEE_BPS);

        let pass_id = env.register(HazinaAccessPass, ());
        let client = HazinaAccessPassClient::new(&env, &pass_id);
        client.initialize(&admin, &escrow_id, &usdc);

        let dataset_id = SorobanString::from_str(&env, "ds-fuzz");
        let plan_id = client.define_plan(&seller, &dataset_id, &price, &period, &max_seats);

        World {
            env,
            client,
            admin,
            seller,
            buyers,
            usdc,
            token,
            plan_id,
            dataset_id,
            price,
            period,
            max_seats,
        }
    }
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/// Prices from the minimum upward; the range naturally produces values whose
/// 500-bps cuts force floor rounding.
pub fn prop_price() -> impl Strategy<Value = i128> {
    MIN_SUB_AMOUNT..=2_000_000i128
}

/// Periods between an hour and a week — short enough that generated time
/// deltas cross expiry boundaries often.
pub fn prop_period() -> impl Strategy<Value = u64> {
    3_600u64..=(7 * 24 * 3_600)
}

/// Small seat counts so MaxSeatsReached is reachable within a few ops.
pub fn prop_seats() -> impl Strategy<Value = u32> {
    1u32..=3
}

/// Which buyer the op targets.
pub fn prop_buyer() -> impl Strategy<Value = usize> {
    0usize..3
}

/// Time delta up to two weeks, biased across typical period lengths.
pub fn prop_time_delta() -> impl Strategy<Value = u64> {
    prop_oneof![
        2 => 0u64..3_600,
        3 => 0u64..(24 * 3_600),
        2 => 0u64..(14 * 24 * 3_600),
    ]
}

// ─── Proptest configuration ──────────────────────────────────────────────────

/// Per-property case budget. Each case builds a whole Soroban world, so this
/// is tuned as a fast local gate; CI raises it with `PROPTEST_CASES`, which
/// proptest applies on top of whatever is set here.
pub const DEFAULT_CASES: u32 = 48;

/// Persist failing seeds to `proptest-regressions/<file>` relative to the
/// crate root, mirroring hazina-escrow's harness.
pub fn config(persistence_file: &'static str) -> Config {
    Config {
        cases: DEFAULT_CASES,
        max_shrink_iters: 2_048,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(persistence_file))),
        ..Config::default()
    }
}

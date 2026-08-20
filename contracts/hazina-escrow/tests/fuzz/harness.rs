//! Shared scaffold for the property-based invariant suite (issue #531).
//!
//! Three jobs: build a fresh contract world per proptest case, expose input
//! strategies derived from the contract's own constants so generated inputs
//! can't drift from the real boundaries, and hold the expected-value model of
//! the fee math in one place instead of re-deriving it per property.

#![allow(dead_code)]

use hazina_escrow::{
    HazinaEscrow, HazinaEscrowClient, DEFAULT_MAX_ESCROW_AMOUNT, MAX_BASIS_POINTS,
    MAX_EXPIRY_SECONDS, MAX_FEE_BPS, MIN_LOCK_AMOUNT,
};
use proptest::prelude::*;
use proptest::test_runner::{Config, FileFailurePersistence};
use soroban_sdk::testutils::{Address as _, EnvTestConfig, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env, String as SorobanString};

/// Non-zero start values, so "before the deadline" and "inside the dispute
/// window" are never accidentally satisfied by a zero clock.
pub const START_TIMESTAMP: u64 = 1_000;
pub const START_SEQUENCE: u32 = 100;

/// Buyer float, well above `DEFAULT_MAX_ESCROW_AMOUNT` so a case that locks the
/// largest legal amount (or several in a row) fails on a contract rule rather
/// than on an empty wallet.
pub const BUYER_FLOAT: i128 = 64 * DEFAULT_MAX_ESCROW_AMOUNT;

/// A test `Env` with auth mocked and **snapshot-at-drop disabled**. Snapshots
/// are worth committing for the example tests; a property test builds one `Env`
/// per case, so leaving capture on would dump thousands of near-identical JSON
/// files into `test_snapshots/` on every run.
///
/// The TTL bounds are also raised from the SDK defaults. The default test
/// ledger gives contract-instance storage a live-until of only
/// `min_persistent_entry_ttl` (4_096) ledgers past the current sequence.
/// Timelock flows in the invariant suite advance the ledger by the full
/// `DEFAULT_TIMELOCK_DELAY_LEDGERS` (25_920) — and a single case can do so more
/// than once (e.g. treasury setup then an admin hand-over) — which would
/// otherwise archive the instance and make the next call panic with `Storage,
/// InternalError`. Raising both TTL bounds keeps instance data written during
/// `initialize` alive across the jump. In production the contract extends TTLs
/// itself; this is purely a test-harness accommodation.
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

/// One initialised contract world: token, escrow contract, and the accounts
/// money can legally reach.
pub struct World {
    pub env: Env,
    pub client: HazinaEscrowClient<'static>,
    pub token: TokenClient<'static>,
    pub admin: Address,
    pub treasury: Address,
    pub buyer: Address,
    pub seller: Address,
    pub contract: Address,
}

/// Balances over every account the escrow flow touches. Asserting on `total()`
/// is what makes a conservation property more than a restatement of the
/// transfer calls: a payout to some fifth address would still satisfy the
/// per-account checks but would break the sum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Balances {
    pub buyer: i128,
    pub seller: i128,
    pub treasury: i128,
    pub admin: i128,
    pub contract: i128,
}

impl Balances {
    pub fn total(&self) -> i128 {
        self.buyer + self.seller + self.treasury + self.admin + self.contract
    }
}

impl World {
    /// A world with an explicit treasury, distinct from the admin, so "the
    /// platform got paid" and "the admin got paid" are separable assertions.
    pub fn new(default_fee_bps: u32) -> Self {
        let world = Self::without_treasury(default_fee_bps);
        let treasury = Address::generate(&world.env);
        world.client.schedule_set_treasury(&world.admin, &treasury);
        world.advance_ledgers(world.get_timelock_delay());
        world.client.execute_set_treasury();
        World { treasury, ..world }
    }

    /// Leaves `Treasury` unset, so the platform cut falls back to the admin —
    /// `release_one`'s `unwrap_or(admin)` branch.
    pub fn without_treasury(default_fee_bps: u32) -> Self {
        let env = bare_env();
        env.ledger().set_timestamp(START_TIMESTAMP);
        env.ledger().set_sequence_number(START_SEQUENCE);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let token_address = env.register_stellar_asset_contract_v2(admin.clone()).address();
        StellarAssetClient::new(&env, &token_address).mint(&buyer, &BUYER_FLOAT);
        let token = TokenClient::new(&env, &token_address);

        let contract = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract);
        client.initialize(&admin, &default_fee_bps);

        World {
            env,
            client,
            token,
            treasury: admin.clone(),
            admin,
            buyer,
            seller,
            contract,
        }
    }

    pub fn token_address(&self) -> Address {
        self.token.address.clone()
    }

    pub fn balances(&self) -> Balances {
        Balances {
            buyer: self.token.balance(&self.buyer),
            seller: self.token.balance(&self.seller),
            // When the treasury is unset it *is* the admin; count it once.
            treasury: if self.treasury == self.admin {
                0
            } else {
                self.token.balance(&self.treasury)
            },
            admin: self.token.balance(&self.admin),
            contract: self.token.balance(&self.contract),
        }
    }

        /// The timelock delay, in ledgers, between proposing a sensitive action and
    /// executing it.
    pub fn get_timelock_delay(&self) -> u32 {
        self.client.get_timelock_delay()
    }

    /// Whatever address actually receives the platform cut in this world.
    pub fn fee_recipient_balance(&self) -> i128 {
        self.token.balance(&self.treasury)
    }

    pub fn new_seller(&self) -> Address {
        Address::generate(&self.env)
    }

    /// Move the clock past `deadline` so `claim_expired` is reachable.
    pub fn advance_past(&self, deadline: u64) {
        self.env.ledger().set_timestamp(deadline + 1);
    }

    /// Advance the ledger sequence, which resets the per-ledger rate counter.
    pub fn advance_ledgers(&self, n: u32) {
        let next = self.env.ledger().sequence() + n;
        self.env.ledger().set_sequence_number(next);
    }

    pub fn dataset(&self, id: &str) -> SorobanString {
        SorobanString::from_str(&self.env, id)
    }

    /// The happy-path lock: valid amount, valid expiry, distinct parties.
    pub fn lock(&self, amount: i128, dataset: &str, expiry_seconds: u64) -> u64 {
        self.client.lock(
            &self.buyer,
            &self.seller,
            &self.token_address(),
            &amount,
            &self.dataset(dataset),
            &expiry_seconds,
        )
    }
}

// ─── Expected-value model ────────────────────────────────────────────────────

/// The contract's platform cut, including the min-1-stroop floor.
///
/// The floor only fires for `amount * fee_bps < MAX_BASIS_POINTS`. `lock`
/// requires `amount >= MIN_LOCK_AMOUNT` (10 000 = MAX_BASIS_POINTS), so any
/// escrow created through the public API with `fee_bps >= 1` already rounds to
/// at least 1 stroop — the floor is reachable only by records written straight
/// to storage, which is what `fee_bounds::min_one_stroop_*` does.
pub fn expected_platform_cut(amount: i128, fee_bps: u32) -> i128 {
    let calculated = amount * fee_bps as i128 / MAX_BASIS_POINTS as i128;
    if calculated == 0 && amount > 0 && fee_bps > 0 {
        1
    } else {
        calculated
    }
}

pub fn expected_seller_cut(amount: i128, fee_bps: u32) -> i128 {
    amount - expected_platform_cut(amount, fee_bps)
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/// Amounts `lock` accepts, weighted toward the interesting regions: the
/// `MIN_LOCK_AMOUNT` floor, the small band where truncation bites hardest,
/// ordinary amounts, and the circuit-breaker ceiling.
pub fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        2 => Just(MIN_LOCK_AMOUNT),
        1 => Just(DEFAULT_MAX_ESCROW_AMOUNT),
        6 => MIN_LOCK_AMOUNT..1_000_000i128,
        6 => 1_000_000i128..1_000_000_000i128,
        3 => 1_000_000_000i128..=DEFAULT_MAX_ESCROW_AMOUNT,
    ]
}

/// Amounts small enough that several fit in one `lock_multi` batch.
pub fn small_amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        2 => Just(MIN_LOCK_AMOUNT),
        8 => MIN_LOCK_AMOUNT..100_000_000i128,
    ]
}

/// Sub-`MIN_LOCK_AMOUNT` amounts — unreachable through `lock`, used by the
/// properties that plant records directly to exercise the fee floor.
pub fn dust_amount() -> impl Strategy<Value = i128> {
    1i128..MIN_LOCK_AMOUNT
}

/// Every fee the contract accepts, both boundaries included.
pub fn fee_bps() -> impl Strategy<Value = u32> {
    prop_oneof![
        2 => Just(0u32),
        2 => Just(MAX_FEE_BPS),
        1 => Just(1u32),
        5 => 0..=MAX_FEE_BPS,
    ]
}

/// Fees above the cap, which every fee-setting entry point must reject.
pub fn invalid_fee_bps() -> impl Strategy<Value = u32> {
    (MAX_FEE_BPS + 1)..=u32::MAX
}

/// Expiries `lock` accepts, both boundaries included.
pub fn expiry_seconds() -> impl Strategy<Value = u64> {
    prop_oneof![
        2 => Just(1u64),
        2 => Just(MAX_EXPIRY_SECONDS),
        6 => 1..=MAX_EXPIRY_SECONDS,
    ]
}

// ─── Proptest configuration ──────────────────────────────────────────────────

/// Per-property case budget. Each case builds a whole Soroban world, so this is
/// tuned as a fast local gate; CI raises it with `PROPTEST_CASES`, which
/// proptest applies on top of whatever is set here.
pub const DEFAULT_CASES: u32 = 48;

/// Persist failing seeds to `proptest-regressions/<file>` relative to the crate
/// root. `Direct` rather than the default source-parallel resolution, so seeds
/// land in one predictable committed directory regardless of module nesting.
pub fn config(persistence_file: &'static str) -> Config {
    Config {
        cases: DEFAULT_CASES,
        max_shrink_iters: 2_048,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(persistence_file))),
        ..Config::default()
    }
}

/// Same, with an explicit budget for properties whose individual cases are
/// expensive (many escrows per case).
pub fn config_with_cases(persistence_file: &'static str, cases: u32) -> Config {
    Config {
        cases,
        ..config(persistence_file)
    }
}

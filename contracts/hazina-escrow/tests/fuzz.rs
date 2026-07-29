#![cfg(feature = "fuzz-tests")]

extern crate std;

use hazina_escrow::{HazinaEscrow, HazinaEscrowClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String,
};

// ─── Constants (mirror src/lib.rs) ──────────────────────────────────────────

const MIN_LOCK_AMOUNT: i128 = 10_000;
const MAX_BASIS_POINTS: u32 = 10_000;
const MAX_FEE_BPS: u32 = 2_000;
const DEFAULT_MAX_ESCROW_AMOUNT: i128 = 1_000_000_000_000;

// ─── Configurable proptest case count ───────────────────────────────────────
//
// PROPTEST_CASES can be set via the environment so CI can cap runtime.
// Defaults to 32, which is enough to exercise all branches without slowing
// down the test suite.

fn proptest_cases() -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(32)
}

fn proptest_config() -> ProptestConfig {
    ProptestConfig {
        cases: proptest_cases(),
        ..ProptestConfig::default()
    }
}

// ─── Proptest strategies ────────────────────────────────────────────────────

// Generates amounts spanning three regions:
//   1. Below `MIN_LOCK_AMOUNT` (should be rejected by the contract)
//   2. The valid range `[MIN_LOCK_AMOUNT, DEFAULT_MAX_ESCROW_AMOUNT]`
//   3. Above the circuit-breaker cap (should be rejected)
prop_compose! {
    fn amount_strategy()(
        amount in prop_oneof![
            0i128..MIN_LOCK_AMOUNT,
            MIN_LOCK_AMOUNT..=DEFAULT_MAX_ESCROW_AMOUNT,
            (DEFAULT_MAX_ESCROW_AMOUNT + 1)..=2_000_000_000_000i128,
        ]
    ) -> i128 {
        amount
    }
}

// Generates fee values in basis points:
//   - `0..=MAX_FEE_BPS`  — valid fees the admin can set
//   - `(MAX_FEE_BPS)..=MAX_BASIS_POINTS` — above the hard cap, should be
//     rejected by `update_fee` / `set_default_fee`
prop_compose! {
    fn fee_bps_strategy()(
        fee in prop_oneof![
            0u32..=MAX_FEE_BPS,
            (MAX_FEE_BPS + 1)..=MAX_BASIS_POINTS,
        ]
    ) -> u32 {
        fee
    }
}

// Generates a `u32` index that can be mapped to a soroban `Address` via
// `Address::generate(&env)` inside the test body.  Soroban `Address` values
// require an `Env` reference and therefore cannot be generated directly by
// proptest strategies.
prop_compose! {
    fn address_index_strategy()(idx in 0u32..1_000) -> u32 {
        idx
    }
}

// Generates a triple of address indices for buyer, seller, and treasury.
prop_compose! {
    fn address_set_strategy()(
        buyer_idx in address_index_strategy(),
        seller_idx in address_index_strategy(),
        treasury_idx in address_index_strategy(),
    ) -> (u32, u32, u32) {
        (buyer_idx, seller_idx, treasury_idx)
    }
}

// ─── Token / contract setup helpers ─────────────────────────────────────────
//
// Mirrors the token setup in tests/unit.rs (create_token_contract).

fn create_token_contract(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract_v2(admin.clone()).address()
}

/// Reusable setup that returns `(env, client, token, admin)`.
///
/// * `env`    — the Soroban test environment (mocks enabled)
/// * `client` — `HazinaEscrowClient` bound to a freshly deployed contract
/// * `token`  — address of a Stellar asset contract used as the payment token
/// * `admin`  — the escrow admin address (also the token issuer)
pub fn setup_contract() -> (Env, HazinaEscrowClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let token = create_token_contract(&env, &admin);

    let contract_id = env.register(HazinaEscrow, ());
    let client = HazinaEscrowClient::new(&env, &contract_id);
    client.initialize(&admin, &500);

    (env, client, token, admin)
}

/// Mints `amount` of `token` to `recipient` using the token's admin (issuer).
fn mint(env: &Env, token: &Address, recipient: &Address, amount: &i128) {
    StellarAssetClient::new(env, token).mint(recipient, amount);
}

// ─── Property tests ─────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(proptest_config())]

    /// The amount strategy always produces a value in one of the three
    /// expected regions (below min, valid, or above the circuit-breaker cap).
    #[test]
    fn prop_amount_strategy_covers_three_regions(amount in amount_strategy()) {
        let below_min = amount < MIN_LOCK_AMOUNT;
        let valid = amount >= MIN_LOCK_AMOUNT && amount <= DEFAULT_MAX_ESCROW_AMOUNT;
        let above_cap = amount > DEFAULT_MAX_ESCROW_AMOUNT;
        prop_assert!(below_min || valid || above_cap);
    }

    /// The fee strategy always produces a value in `[0, MAX_BASIS_POINTS]`.
    #[test]
    fn prop_fee_bps_strategy_within_bounds(fee in fee_bps_strategy()) {
        prop_assert!(fee <= MAX_BASIS_POINTS);
    }

    /// The address-set strategy produces three indices, each in range.
    #[test]
    fn prop_address_set_strategy_indices_in_range(
        (buyer, seller, treasury) in address_set_strategy()
    ) {
        prop_assert!(buyer < 1_000);
        prop_assert!(seller < 1_000);
        prop_assert!(treasury < 1_000);
    }

    /// `setup_contract` always yields a freshly initialised contract with
    /// zero escrows and the default circuit-breaker cap.
    #[test]
    fn prop_setup_contract_yields_clean_state(
        _seed in address_index_strategy()
    ) {
        let (_env, client, _token, _admin) = setup_contract();
        prop_assert_eq!(client.get_escrow_count(), 0);
        prop_assert_eq!(client.get_max_escrow_amount(), DEFAULT_MAX_ESCROW_AMOUNT);
    }

    /// `lock` accepts amounts in the valid range and rejects amounts below
    /// `MIN_LOCK_AMOUNT` or above the circuit-breaker cap.
    #[test]
    fn prop_lock_respects_amount_bounds(amount in amount_strategy()) {
        let (env, client, token, _admin) = setup_contract();
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        mint(&env, &token, &buyer, &2_000_000_000_000);

        let result = client.try_lock(
            &buyer,
            &seller,
            &token,
            &amount,
            &String::from_str(&env, "ds-fuzz"),
            &3600,
        );

        if amount >= MIN_LOCK_AMOUNT && amount <= DEFAULT_MAX_ESCROW_AMOUNT {
            prop_assert!(result.is_ok(), "amount {} should be accepted", amount);
        } else {
            prop_assert!(result.is_err(), "amount {} should be rejected", amount);
        }
    }

    /// `update_fee` accepts fees up to `MAX_FEE_BPS` and rejects anything
    /// above it.
    #[test]
    fn prop_update_fee_respects_max(fee in fee_bps_strategy()) {
        let (_env, client, _token, admin) = setup_contract();
        let result = client.try_update_fee(&admin, &fee);
        if fee <= MAX_FEE_BPS {
            prop_assert!(result.is_ok(), "fee {} bps should be accepted", fee);
        } else {
            prop_assert!(result.is_err(), "fee {} bps should be rejected", fee);
        }
    }
}

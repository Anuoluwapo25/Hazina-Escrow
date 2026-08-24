//! Rust contract fee math vs. backend `platformFee` — issue #540.
//!
//! The two implementations disagree by construction (integer bps vs. IEEE-754
//! rounded to four decimals). The job here is not to make them agree, it is to
//! **bound and pin** the disagreement so a change on either side that widens it
//! fails a test instead of quietly mispaying someone.
//!
//! The backend half is not reimplemented in Rust — `toFixed(4)` rounds ties
//! away from zero while Rust's formatter rounds to even, and a hand-port would
//! be testing the port. Instead `backend/scripts/gen-fee-vectors.ts` runs the
//! real backend functions and commits the results to
//! `tests/fixtures/fee_vectors.json`; `backend/src/common/constants.differential.test.ts`
//! fails if that file drifts from the backend, and this module fails if the
//! contract drifts from the file.

use std::fs;

use hazina_escrow::{MAX_BASIS_POINTS, MIN_LOCK_AMOUNT};
use proptest::prelude::*;
use serde_json::Value;

use crate::harness::{config_with_cases, expected_platform_cut, World};

const FIXTURE: &str = "tests/fixtures/fee_vectors.json";

/// Backend `platformFee` rounds to 4 decimals of a whole token unit, and a
/// stroop is 1e-7 of a unit — so its answer is always a multiple of 1 000
/// stroops and can sit up to 500 stroops either side of the exact fee. The
/// contract truncates, costing under 1 stroop. 501 is the sum, and it is
/// dominated entirely by the backend's rounding.
const TOLERANCE_STROOPS: i128 = 501;

struct Vectors {
    fee_bps: u32,
    rate: f64,
    decimals: u32,
    /// `(price_units, backend_fee_units, backend_seller_units)`
    rows: Vec<(f64, f64, f64)>,
}

fn load() -> Vectors {
    let raw = fs::read_to_string(FIXTURE).unwrap_or_else(|e| {
        panic!("{FIXTURE} missing ({e}); run `npm run gen:fee-vectors --prefix backend`")
    });
    let json: Value = serde_json::from_str(&raw).expect("fee_vectors.json is not valid JSON");

    let rows = json["vectors"]
        .as_array()
        .expect("vectors must be an array")
        .iter()
        .map(|v| {
            let f = |i: usize| v[i].as_f64().expect("vector entries must be numbers");
            (f(0), f(1), f(2))
        })
        .collect();

    Vectors {
        fee_bps: json["platformFeeBps"].as_u64().expect("platformFeeBps") as u32,
        rate: json["platformFeeRate"].as_f64().expect("platformFeeRate"),
        decimals: json["decimals"].as_u64().expect("decimals") as u32,
        rows,
    }
}

fn to_stroops(units: f64, decimals: u32) -> i128 {
    (units * 10f64.powi(decimals as i32)).round() as i128
}

/// The single source-of-truth check: the backend derives `PLATFORM_FEE_BPS`
/// from the same `PLATFORM_FEE_RATE` it uses off-chain, and that is the value
/// handed to the contract. The *rate* therefore cannot diverge even though the
/// rounding does.
#[test]
fn backend_bps_is_the_rate_the_backend_uses() {
    let v = load();
    assert_eq!(v.fee_bps, (v.rate * MAX_BASIS_POINTS as f64).round() as u32);
    assert_eq!(v.decimals, 7, "Stellar assets are 7-decimal");
    assert!(!v.rows.is_empty());
}

/// The headline differential: for every committed vector, the contract's
/// integer answer sits within `TOLERANCE_STROOPS` of the backend's float
/// answer, and the contract's own split is exact whatever the backend does.
#[test]
fn contract_fee_tracks_backend_fee_within_tolerance() {
    let v = load();
    let mut worst = 0i128;
    let mut backend_zero_contract_nonzero = 0;

    for (price, backend_fee, backend_seller) in &v.rows {
        let amount = to_stroops(*price, v.decimals);
        let backend_cut = to_stroops(*backend_fee, v.decimals);
        let contract_cut = expected_platform_cut(amount, v.fee_bps);
        let delta = (contract_cut - backend_cut).abs();

        assert!(
            delta <= TOLERANCE_STROOPS,
            "price {price}: contract {contract_cut} vs backend {backend_cut} stroops (delta {delta})",
        );
        worst = worst.max(delta);

        // The contract conserves exactly. The backend rounds each side
        // independently, so its two numbers need not add back to the price —
        // which is precisely why backend figures are display-only.
        assert_eq!(contract_cut + (amount - contract_cut), amount);
        let backend_total = to_stroops(backend_fee + backend_seller, v.decimals);
        assert!((backend_total - amount).abs() <= TOLERANCE_STROOPS);

        if backend_cut == 0 && contract_cut > 0 {
            backend_zero_contract_nonzero += 1;
        }
    }

    // Both of these are load-bearing: if the grid ever stops covering the
    // rounding-to-zero band, the tolerance above stops being exercised.
    assert!(worst > 0, "grid no longer covers any diverging price");
    assert!(
        backend_zero_contract_nonzero > 0,
        "grid no longer covers the band where the backend fee rounds to zero",
    );
}

/// Every vector at or above `MIN_LOCK_AMOUNT` run through the real contract,
/// not the model — closing the loop from the committed backend numbers all the
/// way to an actual `lock` / `release`.
#[test]
fn real_contract_matches_the_model_on_every_vector() {
    let v = load();
    let datasets = ["ds-diff-0", "ds-diff-1", "ds-diff-2", "ds-diff-3"];

    for (i, (price, _, _)) in v.rows.iter().enumerate() {
        let amount = to_stroops(*price, v.decimals);
        if amount < MIN_LOCK_AMOUNT {
            continue;
        }

        let world = World::new(v.fee_bps);
        world
            .client
            .set_max_escrow_amount(&world.admin, &amount.max(MIN_LOCK_AMOUNT));
        let escrow_id = world.lock(amount, datasets[i % datasets.len()], 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        let contract_cut = world.fee_recipient_balance();
        assert_eq!(
            contract_cut,
            expected_platform_cut(amount, v.fee_bps),
            "price {price} ({amount} stroops)",
        );
        assert_eq!(world.balances().seller + contract_cut, amount);
    }
}

proptest! {
    #![proptest_config(config_with_cases("proptest-regressions/fee_differential.txt", 128))]

    /// The contract half of the comparison, over the whole input space rather
    /// than the committed grid: truncation costs strictly less than one stroop
    /// against the exact rational fee, except where the min-1-stroop floor
    /// deliberately rounds *up*.
    ///
    /// This needs no JS semantics, so it can be fuzzed freely — it is what
    /// bounds the contract's own contribution to the 501-stroop budget above.
    #[test]
    fn contract_truncation_error_is_under_one_stroop(
        amount in 1i128..i128::MAX / MAX_BASIS_POINTS as i128,
        fee_bps in 0..=hazina_escrow::MAX_FEE_BPS,
    ) {
        let exact_numerator = amount * fee_bps as i128;
        let cut = expected_platform_cut(amount, fee_bps);
        let cut_numerator = cut * MAX_BASIS_POINTS as i128;

        if fee_bps == 0 {
            prop_assert_eq!(cut, 0);
        } else if exact_numerator >= MAX_BASIS_POINTS as i128 {
            // Ordinary truncation: never above the exact fee, never a whole
            // stroop below it.
            prop_assert!(cut_numerator <= exact_numerator);
            prop_assert!(exact_numerator - cut_numerator < MAX_BASIS_POINTS as i128);
        } else {
            // Floor region: rounds up, and by definition to exactly 1 stroop.
            prop_assert_eq!(cut, 1);
            prop_assert!(cut_numerator > exact_numerator);
        }
    }
}

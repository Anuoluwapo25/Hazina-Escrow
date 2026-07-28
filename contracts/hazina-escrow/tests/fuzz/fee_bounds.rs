//! Fee bounds — I8, I9, I10, I11 (issue #535).
//!
//! Two regions matter, and only one is reachable through `lock`:
//!
//!   * `amount >= MIN_LOCK_AMOUNT` (10 000 = MAX_BASIS_POINTS). Here
//!     `amount * fee_bps / 10_000 >= 1` for any `fee_bps >= 1`, so the
//!     min-1-stroop floor never fires and the cut is pure truncation.
//!   * `amount < MIN_LOCK_AMOUNT`. Truncation can hit zero and the floor takes
//!     over. `lock` rejects these amounts, so the only way in is a record
//!     written straight to storage — what `plant_escrow` below does, mirroring
//!     `tests/unit.rs::test_fee_floor` across the whole input space.

use hazina_escrow::{
    DataKey, EscrowKey, EscrowRecord, MAX_BASIS_POINTS, MAX_FEE_BPS, MIN_LOCK_AMOUNT,
};
use proptest::prelude::*;
use soroban_sdk::token::StellarAssetClient;

use crate::harness::{
    amount, config, dust_amount, expected_platform_cut, expected_seller_cut, fee_bps,
    invalid_fee_bps, World,
};

/// Seller floor implied by the fee cap, in percent.
const MIN_SELLER_PERCENT: i128 = 100 - (MAX_FEE_BPS as i128 / 100);

/// Write an escrow record straight into contract storage, bypassing `lock`'s
/// `MIN_LOCK_AMOUNT` check, and fund the contract to cover it.
fn plant_escrow(world: &World, amount: i128, fee_bps: u32, confirmed: bool) -> u64 {
    StellarAssetClient::new(&world.env, &world.token_address()).mint(&world.contract, &amount);

    let record = EscrowRecord {
        escrow_id: 0,
        dataset_id: world.dataset("ds-planted"),
        buyer: world.buyer.clone(),
        seller: world.seller.clone(),
        amount,
        token: world.token_address(),
        deadline: world.env.ledger().timestamp() + 3_600,
        buyer_confirmed: confirmed,
        platform_fee_bps: fee_bps,
        released: false,
        refunded: false,
        disputed: false,
        dispute_deadline: None,
    };

    world.env.as_contract(&world.contract, || {
        world.env.storage().persistent().set(&EscrowKey::Record(0), &record);
        world.env.storage().instance().set(&DataKey::EscrowCount, &1u64);
    });
    0
}

proptest! {
    #![proptest_config(config("proptest-regressions/fee_bounds.txt"))]

    /// I8 — the seller of any escrow created through `lock` receives at least
    /// 80 % of the amount, and the platform never exceeds the 2 000 bps cap.
    #[test]
    fn seller_receives_at_least_eighty_percent(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-fee-bound", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        let seller_cut = world.balances().seller;
        let platform_cut = world.fee_recipient_balance();

        prop_assert_eq!(seller_cut + platform_cut, amount);
        prop_assert!(
            seller_cut * 100 >= amount * MIN_SELLER_PERCENT,
            "seller got {} of {} ({} bps fee)", seller_cut, amount, fee_bps
        );
        prop_assert!(platform_cut >= 0);
        prop_assert!(platform_cut <= amount * MAX_FEE_BPS as i128 / MAX_BASIS_POINTS as i128);
    }

    /// I8 — `claim_expired` withholds a cut bounded by the same rule. Separate
    /// code path, so it gets its own property rather than riding on `release`.
    #[test]
    fn claim_expired_pays_seller_at_least_eighty_percent(
        amount in amount(),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-fee-bound-claim", 3_600);
        world.advance_past(world.client.get_escrow(&escrow_id).deadline);
        world.client.claim_expired(&escrow_id, &world.seller);

        let seller_cut = world.balances().seller;
        let withheld = world.balances().contract;

        prop_assert_eq!(seller_cut + withheld, amount);
        prop_assert!(seller_cut * 100 >= amount * MIN_SELLER_PERCENT);
        prop_assert!(withheld <= amount * MAX_FEE_BPS as i128 / MAX_BASIS_POINTS as i128);
    }

    /// I9 — the cut is zero exactly when the rate is zero. Stated as an iff so
    /// both directions are checked: a zero fee must not pick up the 1-stroop
    /// floor, and a non-zero fee must not truncate away to nothing.
    #[test]
    fn platform_cut_is_zero_iff_fee_bps_is_zero(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-fee-zero-iff", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        prop_assert_eq!(world.fee_recipient_balance() == 0, fee_bps == 0);
        if fee_bps == 0 {
            prop_assert_eq!(world.balances().seller, amount);
        }
    }

    /// I9 — the min-1-stroop floor on the only inputs that can reach it.
    /// Conservation must still hold, which at `amount == 1` means the seller
    /// receives nothing: the floor is allowed to consume the whole payment.
    #[test]
    fn min_one_stroop_floor_holds_on_dust_amounts(
        amount in dust_amount(),
        fee_bps in 1..=MAX_FEE_BPS,
    ) {
        let world = World::new(0);
        let escrow_id = plant_escrow(&world, amount, fee_bps, true);

        let before = world.balances();
        world.client.release(&world.admin, &escrow_id);
        let after = world.balances();

        let platform_cut = world.fee_recipient_balance();
        let seller_cut = after.seller;

        prop_assert!(platform_cut >= 1, "floor did not fire for {} @ {} bps", amount, fee_bps);
        prop_assert_eq!(platform_cut, expected_platform_cut(amount, fee_bps));
        prop_assert_eq!(seller_cut, expected_seller_cut(amount, fee_bps));
        prop_assert_eq!(seller_cut + platform_cut, amount);
        prop_assert!(seller_cut >= 0, "floor overdrew the seller: {}", seller_cut);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.total(), before.total());
    }

    /// I9 — the floor does not fire at a zero rate, however small the amount.
    #[test]
    fn zero_fee_takes_nothing_even_on_dust(amount in dust_amount()) {
        let world = World::new(0);
        let escrow_id = plant_escrow(&world, amount, 0, true);
        world.client.release(&world.admin, &escrow_id);

        prop_assert_eq!(world.balances().seller, amount);
        prop_assert_eq!(world.fee_recipient_balance(), 0);
        prop_assert_eq!(world.balances().contract, 0);
    }

    /// I11 — every fee-setting entry point rejects a rate above the cap, a
    /// rejected write leaves the previous rate in place, and the cap itself is
    /// inclusive.
    #[test]
    fn fees_above_the_cap_are_rejected_everywhere(
        good_fee in fee_bps(),
        bad_fee in invalid_fee_bps(),
    ) {
        let world = World::new(good_fee);
        let dataset = world.dataset("ds-fee-cap");

        prop_assert!(world.client.try_set_default_fee(&world.admin, &bad_fee).is_err());
        prop_assert!(world.client.try_set_fee(&world.admin, &bad_fee).is_err());
        prop_assert!(world.client.try_update_fee(&world.admin, &bad_fee).is_err());
        prop_assert!(world.client.try_set_dataset_fee(&world.admin, &dataset, &bad_fee).is_err());

        prop_assert_eq!(world.client.get_default_fee(), good_fee);
        prop_assert!(!world.client.get_dataset_fee_config(&dataset).has_custom_fee);

        world.client.set_default_fee(&world.admin, &MAX_FEE_BPS);
        prop_assert_eq!(world.client.get_default_fee(), MAX_FEE_BPS);
    }

    /// I11 — a contract can never be initialised above the cap, so no escrow
    /// can snapshot such a rate. `initialize` writes its `Initialized` flag
    /// before validating the fee, so this also checks the failed call rolled
    /// back cleanly enough for a valid init to still succeed.
    #[test]
    fn initialize_rejects_fees_above_the_cap(bad_fee in invalid_fee_bps()) {
        use hazina_escrow::{HazinaEscrow, HazinaEscrowClient};
        use soroban_sdk::testutils::Address as _;
        use soroban_sdk::Address;

        let env = crate::harness::bare_env();
        let admin = Address::generate(&env);
        let client = HazinaEscrowClient::new(&env, &env.register(HazinaEscrow, ()));

        prop_assert!(client.try_initialize(&admin, &bad_fee).is_err());
        client.initialize(&admin, &MAX_FEE_BPS);
        prop_assert_eq!(client.get_default_fee(), MAX_FEE_BPS);
    }

    /// I10 — an escrow settles at the rate in force when it was locked, however
    /// many times the fee is changed afterwards.
    #[test]
    fn locked_fee_is_immune_to_later_repricing(
        amount in amount(),
        locked_fee in fee_bps(),
        repricings in prop::collection::vec(0..=MAX_FEE_BPS, 1..5),
    ) {
        let world = World::new(locked_fee);
        let escrow_id = world.lock(amount, "ds-fee-immunity", 3_600);

        for fee in &repricings {
            world.client.set_default_fee(&world.admin, fee);
            prop_assert_eq!(world.client.get_escrow(&escrow_id).platform_fee_bps, locked_fee);
        }

        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);
        prop_assert_eq!(world.fee_recipient_balance(), expected_platform_cut(amount, locked_fee));
    }

    /// I8 — the bound is a property of the arithmetic, not of any one escrow.
    /// Checks the model directly across the full legal input space, including
    /// amounts far larger than a test world could mint.
    #[test]
    fn fee_model_is_bounded_over_the_whole_input_space(
        amount in MIN_LOCK_AMOUNT..i128::MAX / MAX_FEE_BPS as i128,
        fee_bps in 0..=MAX_FEE_BPS,
    ) {
        let platform_cut = expected_platform_cut(amount, fee_bps);
        let seller_cut = expected_seller_cut(amount, fee_bps);

        prop_assert_eq!(platform_cut + seller_cut, amount);
        prop_assert!(platform_cut >= 0);
        prop_assert!(platform_cut <= amount);
        prop_assert!(seller_cut * 100 >= amount * MIN_SELLER_PERCENT);
        prop_assert_eq!(platform_cut == 0, fee_bps == 0);
    }
}

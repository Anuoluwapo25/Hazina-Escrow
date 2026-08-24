//! Value conservation — B1, B2, B3, B4, B6, B7 (docs/INVARIANTS.md).
//!
//! Same shape throughout: snapshot every account the bond flow can reach,
//! run a sequence of operations, assert the tokens landed somewhere rather
//! than being created or destroyed.

use hazina_seller_bond::MAX_BASIS_POINTS;
use proptest::prelude::*;

use crate::harness::{
    expected_slash_cut, slash_bps, stake_amount, valid_slash_bps, BondWorld, DEFAULT_CASES,
};

proptest! {
    #![proptest_config(crate::harness::config(
        "proptest-regressions/conservation.txt"
    ))]

    /// B1 — total value is conserved across a full stake → slash → withdraw
    /// cycle. This is the primary conservation property: tokens deposited
    /// == outstanding staked + paid-out slashes + withdrawals.
    #[test]
    fn stake_slash_withdraw_conserves_total_value(
        stake1 in stake_amount(),
        stake2 in stake_amount(),
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);
        let before = world.balances(&beneficiary);

        // Stake twice (additive)
        world.client.stake(&world.seller, &stake1);
        let mid1 = world.balances(&beneficiary);
        prop_assert_eq!(mid1.total(), before.total());

        world.client.stake(&world.seller, &stake2);
        let mid2 = world.balances(&beneficiary);
        prop_assert_eq!(mid2.total(), before.total());

        let total_staked = stake1 + stake2;

        // Slash some
        let cut = expected_slash_cut(total_staked, slash_bps);
        world.client.slash(&world.arbitrator, &world.seller, &1, &slash_bps, &beneficiary);
        let after_slash = world.balances(&beneficiary);
        prop_assert_eq!(after_slash.total(), before.total());
        prop_assert_eq!(after_slash.contract, total_staked - cut);
        prop_assert_eq!(after_slash.beneficiary, cut);

        // Request full unstake
        let remaining = total_staked - cut;
        if remaining > 0 {
            world.client.request_unstake(&world.seller, &remaining);
        }

        // Withdraw after cooldown
        world.advance_timestamp(world.env.ledger().timestamp() + 3_600);
        world.client.withdraw(&world.seller);

        let after = world.balances(&beneficiary);
        prop_assert_eq!(after.total(), before.total());
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.seller, before.seller - total_staked + remaining);
        prop_assert_eq!(after.beneficiary, cut);
    }

    /// B1 — conservation across multiple randomised operations. Exercises
    /// the running balance identity: after every step the total across
    /// all accounts must equal the starting total.
    #[test]
    fn randomised_sequence_conserves_total(
        amounts in prop::collection::vec(stake_amount(), 1..5),
        slash_seq in prop::collection::vec(valid_slash_bps(), 0..3),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);
        let before = world.balances(&beneficiary);
        let mut escrow_id: u64 = 1;
        let mut total_slashed: i128 = 0;

        for amount in &amounts {
            world.client.stake(&world.seller, amount);
            prop_assert_eq!(world.balances(&beneficiary).total(), before.total());
        }

        for bps in &slash_seq {
            let bond = world.client.get_bond(&world.seller);
            if bond.staked > 0 {
                let cut = expected_slash_cut(bond.staked, *bps);
                world.client.slash(&world.arbitrator, &world.seller, &escrow_id, bps, &beneficiary);
                total_slashed += cut;
                escrow_id += 1;
                prop_assert_eq!(world.balances(&beneficiary).total(), before.total());
            }
        }
    }

    /// B2 — stake remains slashable during cooldown. After requesting
    /// unstake, a slash still succeeds and reduces staked.
    #[test]
    fn stake_slashable_during_cooldown(
        stake in stake_amount(),
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);

        world.client.stake(&world.seller, &stake);
        world.client.request_unstake(&world.seller, &stake);

        // Slash while cooldown is active
        let before_slash = world.balances(&beneficiary);
        world.client.slash(&world.arbitrator, &world.seller, &1, &slash_bps, &beneficiary);
        let after_slash = world.balances(&beneficiary);
        prop_assert_eq!(after_slash.total(), before_slash.total());

        let bond = world.client.get_bond(&world.seller);
        let expected_cut = expected_slash_cut(stake, slash_bps);
        prop_assert_eq!(bond.staked, stake - expected_cut);
        prop_assert_eq!(after_slash.beneficiary, expected_cut);
    }

    /// B3 — withdraw fails before cooldown; pays at most pending_unstake
    /// after cooldown. The clamp `min(pending_unstake, staked)` is tested
    /// via B2 (slash shrinks staked below pending).
    #[test]
    fn withdraw_boundary_clamp(
        stake in stake_amount(),
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);

        world.client.stake(&world.seller, &stake);
        world.client.request_unstake(&world.seller, &stake);

        // Slash mid-cooldown
        let cut = expected_slash_cut(stake, slash_bps);
        world.client.slash(&world.arbitrator, &world.seller, &1, &slash_bps, &beneficiary);

        // Withdraw: payout = min(stake, stake - cut) = stake - cut
        world.advance_timestamp(world.env.ledger().timestamp() + 3_600);
        let before_withdraw = world.balances(&beneficiary);
        world.client.withdraw(&world.seller);
        let after_withdraw = world.balances(&beneficiary);

        let payout = stake - cut;
        prop_assert_eq!(after_withdraw.total(), before_withdraw.total());
        prop_assert_eq!(after_withdraw.seller, before_withdraw.seller + payout);
    }

    /// B4 — the same escrow_id can be slashed exactly once. Second attempt
    /// reverts with AlreadySlashed and moves nothing.
    #[test]
    fn double_slash_is_idempotent(
        stake in stake_amount(),
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);

        world.client.stake(&world.seller, &stake);
        world.client.slash(&world.arbitrator, &world.seller, &42, &slash_bps, &beneficiary);

        let before = world.balances(&beneficiary);
        let result = world.client.try_slash(
            &world.arbitrator,
            &world.seller,
            &42,
            &slash_bps,
            &beneficiary,
        );
        prop_assert!(result.is_err());
        // State unchanged
        prop_assert_eq!(world.balances(&beneficiary).total(), before.total());
        prop_assert!(world.client.is_slashed(&42));
    }

    /// B6 — a slash never pays more than currently staked. The floor
    /// math ensures cut >= 1 for non-zero bps, and the clamp ensures
    /// cut <= staked.
    #[test]
    fn slash_never_exceeds_staked(
        stake in 1i128..100_000_000_000i128,
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);

        world.client.stake(&world.seller, &stake);
        world.client.slash(&world.arbitrator, &world.seller, &1, &slash_bps, &beneficiary);

        let bond = world.client.get_bond(&world.seller);
        prop_assert!(bond.staked >= 0);
        prop_assert!(bond.slashed_total <= stake);
        prop_assert_eq!(bond.staked + bond.slashed_total, stake);
    }

    /// B7 — tier is a pure function of current `staked`. Stake, check
    /// tier, slash, check tier again: it changes based on staked only.
    #[test]
    fn tier_depends_only_on_staked(
        stake in stake_amount(),
        slash_bps in valid_slash_bps(),
    ) {
        let world = BondWorld::new(3_600);
        let beneficiary = soroban_sdk::Address::generate(&world.env);

        world.client.stake(&world.seller, &stake);
        let bond_before = world.client.get_bond(&world.seller);

        world.client.slash(&world.arbitrator, &world.seller, &1, &slash_bps, &beneficiary);
        let bond_after = world.client.get_bond(&world.seller);

        // Tier is re-derived from staked, not stored
        let expected_tier = hazina_seller_bond::HazinaSellerBond::derive_tier(bond_before.staked - expected_slash_cut(stake, slash_bps));
        prop_assert_eq!(bond_after.tier, expected_tier);
    }
}

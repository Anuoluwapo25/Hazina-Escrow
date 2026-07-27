//! Circuit breakers under fuzzed load — I15, I16, I17 (issue #537).
//!
//! Both breakers are boundary rules, and the existing example tests pick the
//! boundary by hand. These drive the limit *and* the load from the same case so
//! the "just under / exactly on / just over" transition is checked wherever the
//! generator puts it, not only where someone thought to look.

use hazina_escrow::{SellerShare, DEFAULT_MAX_ESCROWS_PER_LEDGER, MIN_LOCK_AMOUNT};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Vec as SorobanVec};

use crate::harness::{config, config_with_cases, fee_bps, World};

const DATASETS: [&str; 16] = [
    "ds-cb-0", "ds-cb-1", "ds-cb-2", "ds-cb-3", "ds-cb-4", "ds-cb-5", "ds-cb-6", "ds-cb-7",
    "ds-cb-8", "ds-cb-9", "ds-cb-a", "ds-cb-b", "ds-cb-c", "ds-cb-d", "ds-cb-e", "ds-cb-f",
];

/// Attempt a lock that is expected to be judged only by the breakers: valid
/// amount aside, everything else about it is fine.
fn try_lock(world: &World, amount: i128, dataset: &str) -> bool {
    world
        .client
        .try_lock(
            &world.buyer,
            &world.seller,
            &world.token_address(),
            &amount,
            &world.dataset(dataset),
            &3_600u64,
        )
        .is_ok()
}

proptest! {
    #![proptest_config(config("proptest-regressions/circuit_breakers.txt"))]

    /// I15 — the amount breaker is an inclusive ceiling: a lock succeeds iff
    /// `amount <= max`, and a rejected lock moves no tokens and writes no
    /// record. The generator picks both sides, so the boundary is hit from
    /// above, below and exactly on.
    #[test]
    fn amount_breaker_is_an_inclusive_ceiling(
        max in MIN_LOCK_AMOUNT..1_000_000_000i128,
        delta in -4i128..=4,
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        world.client.set_max_escrow_amount(&world.admin, &max);
        prop_assert_eq!(world.client.get_max_escrow_amount(), max);

        let amount = (max + delta).max(MIN_LOCK_AMOUNT);
        let before = world.balances();
        let accepted = try_lock(&world, amount, DATASETS[0]);

        prop_assert_eq!(accepted, amount <= max, "amount {} vs max {}", amount, max);
        if accepted {
            prop_assert_eq!(world.client.get_escrow_count(), 1);
            prop_assert_eq!(world.balances().contract, amount);
        } else {
            prop_assert_eq!(world.client.get_escrow_count(), 0);
            prop_assert_eq!(world.balances(), before);
        }
    }

    /// I15 — the breaker is per share, not per batch. A batch whose shares are
    /// each under the ceiling goes through even when the total is far over it;
    /// a single share above the ceiling kills the whole batch.
    #[test]
    fn amount_breaker_applies_per_share_not_per_batch(
        share in MIN_LOCK_AMOUNT..10_000_000i128,
        count in 2usize..=6,
        push_one_over in any::<bool>(),
    ) {
        let world = World::new(500);
        // Ceiling sits above one share but below the batch total.
        world.client.set_max_escrow_amount(&world.admin, &share);

        let mut shares = SorobanVec::new(&world.env);
        let mut dataset_ids = SorobanVec::new(&world.env);
        for i in 0..count {
            let amount = if push_one_over && i == count - 1 { share + 1 } else { share };
            shares.push_back(SellerShare { seller: world.new_seller(), amount });
            dataset_ids.push_back(world.dataset(DATASETS[i]));
        }

        let accepted = world
            .client
            .try_lock_multi(&world.buyer, &world.token_address(), &shares, &dataset_ids)
            .is_ok();

        prop_assert_eq!(accepted, !push_one_over);
        prop_assert_eq!(
            world.client.get_escrow_count(),
            if push_one_over { 0 } else { count as u64 }
        );
    }

    /// I16 — at most `max_escrows_per_ledger` escrows exist after any number of
    /// single locks in one ledger. Everything past the limit is rejected, and
    /// the ones that got through are intact.
    #[test]
    fn rate_breaker_caps_escrows_per_ledger(
        limit in 1u32..=8,
        attempts in 1usize..=12,
    ) {
        let world = World::new(500);
        world.client.set_max_escrows_per_ledger(&world.admin, &limit);
        prop_assert_eq!(world.client.get_max_escrows_per_ledger(), limit);

        let mut accepted = 0u32;
        for i in 0..attempts {
            if try_lock(&world, MIN_LOCK_AMOUNT, DATASETS[i]) {
                accepted += 1;
            }
        }

        let expected = limit.min(attempts as u32);
        prop_assert_eq!(accepted, expected);
        prop_assert_eq!(world.client.get_escrow_count(), expected as u64);
        for i in 0..expected as u64 {
            prop_assert_eq!(world.client.get_escrow(&i).amount, MIN_LOCK_AMOUNT);
        }
    }

    /// I16 — `lock_multi` spends `shares.len()` of the ledger budget in one
    /// call, so a batch larger than the remaining budget is rejected whole
    /// rather than partially filled.
    #[test]
    fn rate_breaker_counts_lock_multi_as_batch_size(
        limit in 1u32..=8,
        batch in 1usize..=12,
    ) {
        let world = World::new(500);
        world.client.set_max_escrows_per_ledger(&world.admin, &limit);

        let mut shares = SorobanVec::new(&world.env);
        let mut dataset_ids = SorobanVec::new(&world.env);
        for i in 0..batch {
            shares.push_back(SellerShare {
                seller: world.new_seller(),
                amount: MIN_LOCK_AMOUNT,
            });
            dataset_ids.push_back(world.dataset(DATASETS[i]));
        }

        let accepted = world
            .client
            .try_lock_multi(&world.buyer, &world.token_address(), &shares, &dataset_ids)
            .is_ok();

        prop_assert_eq!(accepted, batch as u32 <= limit);
        prop_assert_eq!(
            world.client.get_escrow_count(),
            if accepted { batch as u64 } else { 0 }
        );
    }

    /// I17 — a rejected lock does not consume rate budget.
    ///
    /// `check_rate_circuit_breaker_n` runs *after* the amount check, so a lock
    /// rejected on size must leave the counter untouched. If it did not, one
    /// oversized request could lock out the rest of the ledger for everyone.
    #[test]
    fn rejected_locks_do_not_consume_rate_budget(
        limit in 1u32..=6,
        rejected_attempts in 1usize..=6,
    ) {
        let world = World::new(500);
        world.client.set_max_escrows_per_ledger(&world.admin, &limit);
        world.client.set_max_escrow_amount(&world.admin, &MIN_LOCK_AMOUNT);

        // Burn attempts that the amount breaker rejects.
        for i in 0..rejected_attempts {
            prop_assert!(!try_lock(&world, MIN_LOCK_AMOUNT + 1, DATASETS[i]));
        }
        prop_assert_eq!(world.client.get_escrow_count(), 0);

        // The full per-ledger budget must still be available.
        let mut accepted = 0u32;
        for i in 0..limit as usize {
            if try_lock(&world, MIN_LOCK_AMOUNT, DATASETS[i]) {
                accepted += 1;
            }
        }
        prop_assert_eq!(accepted, limit);
    }

    /// I16 — the counter is keyed on the ledger sequence, so advancing the
    /// ledger restores the full budget however many ledgers are crossed.
    #[test]
    fn rate_breaker_counter_resets_when_the_ledger_advances(
        limit in 1u32..=5,
        ledgers in 1u32..=4,
    ) {
        let world = World::new(500);
        world.client.set_max_escrows_per_ledger(&world.admin, &limit);

        let mut total = 0u64;
        for _ in 0..ledgers {
            let mut accepted = 0u32;
            for i in 0..(limit as usize + 2) {
                if try_lock(&world, MIN_LOCK_AMOUNT, DATASETS[i]) {
                    accepted += 1;
                }
            }
            prop_assert_eq!(accepted, limit);
            total += limit as u64;
            prop_assert_eq!(world.client.get_escrow_count(), total);
            world.advance_ledgers(1);
        }
    }
}

proptest! {
    #![proptest_config(config_with_cases("proptest-regressions/circuit_breakers.txt", 24))]

    /// I15 + I22 — breaker configuration is admin-only and validated, and the
    /// unset defaults are what the contract falls back to.
    #[test]
    fn breaker_config_is_admin_only_and_validated(
        bad_amount in i128::MIN..=0,
        good_amount in 1i128..1_000_000_000i128,
        good_rate in 1u32..1_000,
    ) {
        let world = World::new(500);
        let outsider = Address::generate(&world.env);

        prop_assert_eq!(world.client.get_max_escrows_per_ledger(), DEFAULT_MAX_ESCROWS_PER_LEDGER);

        prop_assert!(world.client.try_set_max_escrow_amount(&outsider, &good_amount).is_err());
        prop_assert!(world.client.try_set_max_escrows_per_ledger(&outsider, &good_rate).is_err());
        prop_assert!(world.client.try_set_max_escrow_amount(&world.admin, &bad_amount).is_err());
        prop_assert!(world.client.try_set_max_escrows_per_ledger(&world.admin, &0).is_err());

        // None of the rejected writes stuck.
        prop_assert_eq!(world.client.get_max_escrows_per_ledger(), DEFAULT_MAX_ESCROWS_PER_LEDGER);

        world.client.set_max_escrow_amount(&world.admin, &good_amount);
        world.client.set_max_escrows_per_ledger(&world.admin, &good_rate);
        prop_assert_eq!(world.client.get_max_escrow_amount(), good_amount);
        prop_assert_eq!(world.client.get_max_escrows_per_ledger(), good_rate);
    }
}

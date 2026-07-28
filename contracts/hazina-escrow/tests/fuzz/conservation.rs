//! Value conservation — I1, I2, I3, I4 (issues #532, #533).
//!
//! Same shape throughout: snapshot every account the escrow flow can reach, run
//! a settlement path, assert the tokens landed somewhere rather than being
//! created or destroyed.

use hazina_escrow::MIN_LOCK_AMOUNT;
use proptest::prelude::*;

use crate::harness::{
    amount, config, expected_platform_cut, expected_seller_cut, expiry_seconds, fee_bps, World,
};

proptest! {
    #![proptest_config(config("proptest-regressions/conservation.txt"))]

    /// I1 — release splits the locked amount and nothing else: the two cuts sum
    /// to `amount` exactly, the contract is left flat, and the buyer is not
    /// touched again after the lock.
    #[test]
    fn release_conserves_locked_value(
        amount in amount(),
        fee_bps in fee_bps(),
        expiry in expiry_seconds(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-release-conservation", expiry);

        let locked = world.balances();
        prop_assert_eq!(locked.buyer, before.buyer - amount);
        prop_assert_eq!(locked.contract, amount);
        prop_assert_eq!(locked.total(), before.total());

        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        let platform_cut = expected_platform_cut(amount, fee_bps);
        let seller_cut = expected_seller_cut(amount, fee_bps);
        let after = world.balances();

        prop_assert_eq!(seller_cut + platform_cut, amount);
        prop_assert_eq!(after.seller, seller_cut);
        prop_assert_eq!(world.fee_recipient_balance(), platform_cut);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.buyer, before.buyer - amount);
        prop_assert_eq!(after.total(), before.total());

        let record = world.client.get_escrow(&escrow_id);
        prop_assert!(record.released);
        prop_assert!(!record.refunded);
        prop_assert_eq!(record.amount, amount);
        prop_assert_eq!(record.platform_fee_bps, fee_bps);
    }

    /// I1 — with no treasury configured the admin is the fee recipient and
    /// conservation still holds. Covers `release_one`'s `unwrap_or(admin)`
    /// branch, which the treasury-set path skips.
    #[test]
    fn release_conserves_value_when_treasury_unset(amount in amount(), fee_bps in fee_bps()) {
        let world = World::without_treasury(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-release-no-treasury", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        let platform_cut = expected_platform_cut(amount, fee_bps);
        let after = world.balances();

        prop_assert_eq!(after.admin, platform_cut);
        prop_assert_eq!(after.seller, amount - platform_cut);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.total(), before.total());
    }

    /// I1 + I10 — a dataset fee override is snapshotted at lock time and drives
    /// the split; repricing afterwards cannot move the numbers.
    #[test]
    fn release_uses_snapshotted_dataset_fee(
        amount in amount(),
        locked_fee in fee_bps(),
        later_fee in fee_bps(),
    ) {
        let world = World::new(0);
        let dataset = world.dataset("ds-snapshot-fee");
        world.client.set_dataset_fee(&world.admin, &dataset, &locked_fee);

        let before = world.balances();
        let escrow_id = world.lock(amount, "ds-snapshot-fee", 3_600);
        prop_assert_eq!(world.client.get_escrow(&escrow_id).platform_fee_bps, locked_fee);

        world.client.set_dataset_fee(&world.admin, &dataset, &later_fee);
        world.client.set_default_fee(&world.admin, &later_fee);

        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);

        let after = world.balances();
        prop_assert_eq!(after.seller, expected_seller_cut(amount, locked_fee));
        prop_assert_eq!(world.fee_recipient_balance(), expected_platform_cut(amount, locked_fee));
        prop_assert_eq!(after.total(), before.total());
    }

    /// I2 — refund returns the entire amount to the buyer. No fee is taken on a
    /// refund at any rate, so every other account must be untouched.
    #[test]
    fn refund_returns_all_locked_value_to_buyer(
        amount in amount(),
        fee_bps in fee_bps(),
        expiry in expiry_seconds(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-refund-conservation", expiry);
        world.client.refund(&world.admin, &escrow_id);

        let after = world.balances();
        prop_assert_eq!(after.buyer, before.buyer);
        prop_assert_eq!(after.seller, 0);
        prop_assert_eq!(world.fee_recipient_balance(), 0);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.total(), before.total());

        let record = world.client.get_escrow(&escrow_id);
        prop_assert!(record.refunded);
        prop_assert!(!record.released);
    }

    /// I2 — buyer confirmation does not weaken the refund guarantee.
    #[test]
    fn refund_after_confirmation_still_returns_everything(
        amount in amount(),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-refund-confirmed", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.refund(&world.admin, &escrow_id);

        let after = world.balances();
        prop_assert_eq!(after.buyer, before.buyer);
        prop_assert_eq!(after.seller, 0);
        prop_assert_eq!(after.total(), before.total());
    }

    /// I2 — an arbitrator ruling for the buyer is a refund, and inherits the
    /// same guarantee.
    #[test]
    fn dispute_resolved_for_buyer_refunds_in_full(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-dispute-refund", 3_600);
        let evidence = soroban_sdk::BytesN::from_array(&world.env, &[3u8; 32]);
        world.client.raise_dispute(&world.buyer, &escrow_id, &evidence);
        world.client.resolve_dispute(&world.admin, &escrow_id, &true);

        let after = world.balances();
        prop_assert_eq!(after.buyer, before.buyer);
        prop_assert_eq!(after.seller, 0);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.total(), before.total());

        let record = world.client.get_escrow(&escrow_id);
        prop_assert!(record.refunded);
        prop_assert!(!record.disputed);
    }

    /// I3 — `claim_expired` is deliberately not symmetric with `release`: the
    /// seller is paid `amount - platform_cut` and the cut stays in the contract
    /// for the admin to sweep via `emergency_withdraw`, rather than going to the
    /// treasury. Value is conserved; it just does not all leave. Pinned so a
    /// future "fix" can't silently move where the fee lands.
    #[test]
    fn claim_expired_pays_seller_and_retains_fee_in_contract(
        amount in amount(),
        fee_bps in fee_bps(),
        expiry in expiry_seconds(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let escrow_id = world.lock(amount, "ds-claim-conservation", expiry);
        let deadline = world.client.get_escrow(&escrow_id).deadline;
        world.advance_past(deadline);
        world.client.claim_expired(&escrow_id, &world.seller);

        let platform_cut = expected_platform_cut(amount, fee_bps);
        let after = world.balances();

        prop_assert_eq!(after.seller, amount - platform_cut);
        prop_assert_eq!(after.contract, platform_cut);
        prop_assert_eq!(world.fee_recipient_balance(), 0);
        prop_assert_eq!(after.buyer, before.buyer - amount);
        prop_assert_eq!(after.total(), before.total());

        let record = world.client.get_escrow(&escrow_id);
        prop_assert!(record.released);
        prop_assert!(!record.refunded);
    }

    /// I4 — no path creates or destroys tokens. Runs a batch of escrows through
    /// a fuzzed mix of release, refund and expiry-claim in one world, checking
    /// the total after every step: a leak that only appears once several
    /// escrows share a contract balance is invisible to the properties above.
    #[test]
    fn total_supply_is_invariant_across_mixed_settlements(
        amounts in prop::collection::vec(MIN_LOCK_AMOUNT..50_000_000i128, 1..6),
        fee_bps in fee_bps(),
        routes in prop::collection::vec(0u8..3, 1..6),
    ) {
        let world = World::new(fee_bps);
        let expected_total = world.balances().total();

        let datasets = ["ds-mix-0", "ds-mix-1", "ds-mix-2", "ds-mix-3", "ds-mix-4"];
        let mut ids = std::vec::Vec::new();
        for (i, amount) in amounts.iter().enumerate() {
            ids.push((world.lock(*amount, datasets[i], 3_600), *amount));
            prop_assert_eq!(world.balances().total(), expected_total);
        }

        // Push past every deadline so the expiry route is always reachable.
        world.advance_past(world.client.get_escrow(&ids[ids.len() - 1].0).deadline);

        let mut settled_out = 0i128;
        for (i, (escrow_id, amount)) in ids.iter().enumerate() {
            match routes[i % routes.len()] {
                0 => {
                    world.client.confirm_delivery(escrow_id, &world.buyer);
                    world.client.release(&world.admin, escrow_id);
                    settled_out += amount;
                }
                1 => {
                    world.client.refund(&world.admin, escrow_id);
                    settled_out += amount;
                }
                _ => {
                    world.client.claim_expired(escrow_id, &world.seller);
                    settled_out += amount - expected_platform_cut(*amount, fee_bps);
                }
            }
            prop_assert_eq!(world.balances().total(), expected_total);
        }

        let locked_total: i128 = amounts.iter().sum();
        prop_assert_eq!(world.balances().contract, locked_total - settled_out);
    }
}

//! Settlement exclusivity — I5, I6, I7 (issue #534).
//!
//! An escrow has three ways out (`release`, `refund`, `claim_expired`) plus two
//! arbitrator wrappers. The example tests cover a few hand-picked pairs; what
//! must hold for *any* ordering is that at most one of them ever moves money
//! and the record freezes once one has. These properties drive a fuzzed
//! sequence of attempts at one escrow and check after every step.

use hazina_escrow::MIN_LOCK_AMOUNT;
use proptest::prelude::*;

use crate::harness::{amount, config, expiry_seconds, fee_bps, World};

/// The settlement entry points, as a fuzzable alphabet.
#[derive(Clone, Copy, Debug)]
enum Attempt {
    Release,
    Refund,
    ClaimExpired,
    ResolveForBuyer,
    ResolveForSeller,
}

fn attempt() -> impl Strategy<Value = Attempt> {
    prop_oneof![
        Just(Attempt::Release),
        Just(Attempt::Refund),
        Just(Attempt::ClaimExpired),
        Just(Attempt::ResolveForBuyer),
        Just(Attempt::ResolveForSeller),
    ]
}

proptest! {
    #![proptest_config(config("proptest-regressions/settlement.txt"))]

    /// I5 + I7 — across any sequence of settlement attempts exactly one can
    /// succeed, and `released && refunded` is never true.
    ///
    /// The escrow is pre-confirmed and the clock pushed past the deadline so
    /// every attempt is genuinely reachable on the first step; anything that
    /// fails later fails because the escrow is settled, not because a
    /// precondition happened to be unmet.
    #[test]
    fn release_xor_refund_under_any_settlement_ordering(
        amount in amount(),
        fee_bps in fee_bps(),
        attempts in prop::collection::vec(attempt(), 1..7),
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-xor-settlement", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.advance_past(world.client.get_escrow(&escrow_id).deadline);

        let mut successes = 0;
        let mut frozen_balances = None;

        for attempt in attempts {
            let ok = match attempt {
                Attempt::Release =>
                    world.client.try_release(&world.admin, &escrow_id).is_ok(),
                Attempt::Refund =>
                    world.client.try_refund(&world.admin, &escrow_id).is_ok(),
                Attempt::ClaimExpired =>
                    world.client.try_claim_expired(&escrow_id, &world.seller).is_ok(),
                // Neither resolve can succeed here — nothing is disputed, so
                // they bail with NotDisputed. Included so the alphabet covers
                // the arbitrator surface too.
                Attempt::ResolveForBuyer =>
                    world.client.try_resolve_dispute(&world.admin, &escrow_id, &true).is_ok(),
                Attempt::ResolveForSeller =>
                    world.client.try_resolve_dispute(&world.admin, &escrow_id, &false).is_ok(),
            };

            let record = world.client.get_escrow(&escrow_id);
            prop_assert!(!(record.released && record.refunded));

            if ok {
                successes += 1;
                frozen_balances = Some(world.balances());
            } else if let Some(frozen) = frozen_balances {
                // I6 — a rejected attempt must not move a single stroop.
                prop_assert_eq!(world.balances(), frozen);
            }
        }

        prop_assert!(successes <= 1, "{} settlements succeeded", successes);
        let record = world.client.get_escrow(&escrow_id);
        prop_assert_eq!(successes == 1, record.released || record.refunded);
    }

    /// I6 — terminal states are absorbing. After a first successful settlement
    /// every mutating entry point on that escrow fails and balances are frozen.
    #[test]
    fn settled_escrow_rejects_every_further_mutation(
        amount in amount(),
        fee_bps in fee_bps(),
        route in 0u8..3,
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-absorbing", 3_600);

        match route {
            0 => {
                world.client.confirm_delivery(&escrow_id, &world.buyer);
                world.client.release(&world.admin, &escrow_id);
            }
            1 => world.client.refund(&world.admin, &escrow_id),
            _ => {
                world.advance_past(world.client.get_escrow(&escrow_id).deadline);
                world.client.claim_expired(&escrow_id, &world.seller);
            }
        }

        let settled = world.balances();
        let record_before = world.client.get_escrow(&escrow_id);
        prop_assert!(record_before.released || record_before.refunded);
        prop_assert!(!(record_before.released && record_before.refunded));

        let evidence = soroban_sdk::BytesN::from_array(&world.env, &[1u8; 32]);
        prop_assert!(world.client.try_release(&world.admin, &escrow_id).is_err());
        prop_assert!(world.client.try_refund(&world.admin, &escrow_id).is_err());
        prop_assert!(world.client.try_claim_expired(&escrow_id, &world.seller).is_err());
        prop_assert!(world.client.try_confirm_delivery(&escrow_id, &world.buyer).is_err());
        prop_assert!(world.client.try_raise_dispute(&world.buyer, &escrow_id, &evidence).is_err());
        prop_assert!(world.client.try_resolve_dispute(&world.admin, &escrow_id, &true).is_err());

        prop_assert_eq!(world.balances(), settled);
        prop_assert_eq!(world.client.get_escrow(&escrow_id), record_before);
    }

    /// I5 + I21 — whichever way a dispute is resolved, a second resolution and
    /// every direct settlement afterwards must fail.
    #[test]
    fn dispute_resolution_settles_exactly_once(
        amount in amount(),
        fee_bps in fee_bps(),
        favour_buyer in any::<bool>(),
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-dispute-once", 3_600);
        let evidence = soroban_sdk::BytesN::from_array(&world.env, &[2u8; 32]);
        world.client.raise_dispute(&world.buyer, &escrow_id, &evidence);
        world.client.resolve_dispute(&world.admin, &escrow_id, &favour_buyer);

        let settled = world.balances();
        let record = world.client.get_escrow(&escrow_id);
        prop_assert_eq!(record.refunded, favour_buyer);
        prop_assert_eq!(record.released, !favour_buyer);
        prop_assert!(!record.disputed);

        prop_assert!(world.client.try_resolve_dispute(&world.admin, &escrow_id, &favour_buyer).is_err());
        prop_assert!(world.client.try_resolve_dispute(&world.admin, &escrow_id, &!favour_buyer).is_err());
        prop_assert!(world.client.try_release(&world.admin, &escrow_id).is_err());
        prop_assert!(world.client.try_refund(&world.admin, &escrow_id).is_err());
        prop_assert_eq!(world.balances(), settled);
    }

    /// I7 — settlement is per-escrow: settling one must not disturb a sibling's
    /// record or funds.
    #[test]
    fn settling_one_escrow_leaves_siblings_untouched(
        amounts in prop::collection::vec(MIN_LOCK_AMOUNT..10_000_000i128, 2..5),
        fee_bps in fee_bps(),
        target in 0usize..4,
        expiry in expiry_seconds(),
    ) {
        let world = World::new(fee_bps);
        let datasets = ["ds-sib-0", "ds-sib-1", "ds-sib-2", "ds-sib-3"];
        let ids: std::vec::Vec<u64> = amounts
            .iter()
            .enumerate()
            .map(|(i, amount)| world.lock(*amount, datasets[i], expiry))
            .collect();

        let target = target % ids.len();
        world.client.refund(&world.admin, &ids[target]);

        for (i, escrow_id) in ids.iter().enumerate() {
            let record = world.client.get_escrow(escrow_id);
            if i == target {
                prop_assert!(record.refunded);
            } else {
                prop_assert!(!record.refunded);
                prop_assert!(!record.released);
                prop_assert!(!record.buyer_confirmed);
                prop_assert_eq!(record.amount, amounts[i]);
            }
        }

        let still_locked: i128 = amounts.iter().sum::<i128>() - amounts[target];
        prop_assert_eq!(world.balances().contract, still_locked);
    }
}

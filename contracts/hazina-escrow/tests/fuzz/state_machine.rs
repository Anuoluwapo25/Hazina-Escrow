//! Dispute, confirmation, access control and pause — I18–I23 (issue #538).
//!
//! The escrow lifecycle is a small state machine with four gates: buyer
//! confirmation, the dispute window, the arbitrator, and the pause flag. These
//! properties fuzz *where in the lifecycle* each call lands rather than
//! scripting one ordering by hand.
//!
//! Two of them deliberately pin behaviour listed under "Known asymmetries" in
//! `docs/INVARIANTS.md` (A2, A3). That is not an endorsement — it is so a
//! change to either shows up as a failing test rather than a silent one.

use hazina_escrow::DISPUTE_WINDOW_LEDGERS;
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN};

use crate::harness::{amount, config, fee_bps, World};

fn evidence(world: &World, tag: u8) -> BytesN<32> {
    BytesN::from_array(&world.env, &[tag; 32])
}

proptest! {
    #![proptest_config(config("proptest-regressions/state_machine.txt"))]

    /// I18 — `release` is gated on buyer confirmation, and nothing else opens
    /// that gate. An unconfirmed escrow stays fully locked no matter how many
    /// times release is retried.
    #[test]
    fn release_requires_buyer_confirmation(
        amount in amount(),
        fee_bps in fee_bps(),
        retries in 1usize..4,
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-gate-confirm", 3_600);

        for _ in 0..retries {
            prop_assert!(world.client.try_release(&world.admin, &escrow_id).is_err());
            prop_assert_eq!(world.balances().contract, amount);
            prop_assert_eq!(world.balances().seller, 0);
            prop_assert!(!world.client.get_escrow(&escrow_id).released);
        }

        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.release(&world.admin, &escrow_id);
        prop_assert!(world.client.get_escrow(&escrow_id).released);
    }

    /// I18 — confirmation is buyer-only and single-use. Neither the seller, the
    /// admin, nor an outsider can confirm on the buyer's behalf.
    #[test]
    fn confirm_delivery_is_single_use_and_buyer_only(
        amount in amount(),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        let outsider = Address::generate(&world.env);
        let escrow_id = world.lock(amount, "ds-gate-confirm-once", 3_600);

        for caller in [&world.seller, &world.admin, &outsider] {
            prop_assert!(world.client.try_confirm_delivery(&escrow_id, caller).is_err());
            prop_assert!(!world.client.get_escrow(&escrow_id).buyer_confirmed);
        }

        world.client.confirm_delivery(&escrow_id, &world.buyer);
        prop_assert!(world.client.get_escrow(&escrow_id).buyer_confirmed);
        prop_assert!(world.client.try_confirm_delivery(&escrow_id, &world.buyer).is_err());
    }

    /// I19 — the dispute window is `[lock_sequence, lock_sequence +
    /// DISPUTE_WINDOW_LEDGERS]`, inclusive on both ends. The generator lands
    /// the clock on either side of the edge and on it.
    #[test]
    fn dispute_window_is_enforced(
        amount in amount(),
        fee_bps in fee_bps(),
        offset in 0u32..=(DISPUTE_WINDOW_LEDGERS + 4),
    ) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-dispute-window", 3_600);
        let deadline = world.client.get_escrow(&escrow_id).dispute_deadline.unwrap();

        world.advance_ledgers(offset);
        let inside = world.env.ledger().sequence() as u64 <= deadline;

        let raised = world
            .client
            .try_raise_dispute(&world.buyer, &escrow_id, &evidence(&world, 1))
            .is_ok();

        prop_assert_eq!(raised, inside, "offset {} vs deadline {}", offset, deadline);
        prop_assert_eq!(world.client.get_escrow(&escrow_id).disputed, inside);
    }

    /// I19 — raising a dispute is buyer-only and single-use.
    #[test]
    fn raise_dispute_is_buyer_only_and_single_use(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let outsider = Address::generate(&world.env);
        let escrow_id = world.lock(amount, "ds-dispute-once-only", 3_600);

        for caller in [&world.seller, &world.admin, &outsider] {
            prop_assert!(world
                .client
                .try_raise_dispute(caller, &escrow_id, &evidence(&world, 2))
                .is_err());
            prop_assert!(!world.client.get_escrow(&escrow_id).disputed);
        }

        world.client.raise_dispute(&world.buyer, &escrow_id, &evidence(&world, 3));
        prop_assert!(world.client.get_escrow(&escrow_id).disputed);
        prop_assert!(world
            .client
            .try_raise_dispute(&world.buyer, &escrow_id, &evidence(&world, 4))
            .is_err());
    }

    /// I20 — a disputed escrow is frozen: release, claim-after-expiry and
    /// confirmation all fail, and only the arbitrator can move it. A delegated
    /// arbitrator displaces the admin, who then cannot resolve either.
    #[test]
    fn disputed_escrow_is_frozen_until_resolved(
        amount in amount(),
        fee_bps in fee_bps(),
        delegate in any::<bool>(),
        favour_buyer in any::<bool>(),
    ) {
        let world = World::new(fee_bps);
        let arbitrator = Address::generate(&world.env);
        if delegate {
            world.client.set_arbitrator(&world.admin, &arbitrator);
        }

        let escrow_id = world.lock(amount, "ds-frozen", 3_600);
        world.client.raise_dispute(&world.buyer, &escrow_id, &evidence(&world, 5));
        world.advance_past(world.client.get_escrow(&escrow_id).deadline);

        let frozen = world.balances();
        prop_assert!(world.client.try_release(&world.admin, &escrow_id).is_err());
        prop_assert!(world.client.try_claim_expired(&escrow_id, &world.seller).is_err());
        prop_assert!(world.client.try_confirm_delivery(&escrow_id, &world.buyer).is_err());
        prop_assert_eq!(world.balances(), frozen);

        // Only the configured arbitrator can rule.
        let (ruler, rejected) = if delegate {
            (&arbitrator, &world.admin)
        } else {
            (&world.admin, &arbitrator)
        };
        prop_assert!(world.client.try_resolve_dispute(rejected, &escrow_id, &favour_buyer).is_err());
        prop_assert_eq!(world.balances(), frozen);

        world.client.resolve_dispute(ruler, &escrow_id, &favour_buyer);
        let record = world.client.get_escrow(&escrow_id);
        prop_assert!(!record.disputed);
        prop_assert_eq!(record.refunded, favour_buyer);
        prop_assert_eq!(record.released, !favour_buyer);
    }

    /// I22 — the admin surface rejects everyone else, and a rejected call
    /// changes nothing. `mock_all_auths` satisfies `require_auth`, so what this
    /// exercises is `assert_admin` itself rather than signature checking.
    #[test]
    fn admin_surface_rejects_non_admin_callers(amount in amount(), new_fee in fee_bps()) {
        let world = World::new(500);
        let outsider = Address::generate(&world.env);
        let dataset = world.dataset("ds-admin-surface");
        let escrow_id = world.lock(amount, "ds-admin-surface", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        let before = world.balances();

        prop_assert!(world.client.try_pause(&outsider).is_err());
        prop_assert!(world.client.try_set_default_fee(&outsider, &new_fee).is_err());
        prop_assert!(world.client.try_set_dataset_fee(&outsider, &dataset, &new_fee).is_err());
        prop_assert!(world.client.try_clear_dataset_fee(&outsider, &dataset).is_err());
        prop_assert!(world.client.try_schedule_set_treasury(&outsider, &outsider).is_err());
        prop_assert!(world.client.try_schedule_admin_change(&outsider, &outsider).is_err());
        prop_assert!(world.client.try_set_arbitrator(&outsider, &outsider).is_err());
        prop_assert!(world.client.try_set_whitelist_enforced(&outsider, &true).is_err());
        prop_assert!(world.client.try_set_address_blacklisted(&outsider, &world.buyer, &true).is_err());
        prop_assert!(world.client.try_release(&outsider, &escrow_id).is_err());
        prop_assert!(world.client.try_refund(&outsider, &escrow_id).is_err());

        prop_assert!(!world.client.is_paused());
        prop_assert_eq!(world.client.get_default_fee(), 500);
        prop_assert_eq!(world.balances(), before);

        // The real admin still works, and can hand the role over via the
        // timelocked two-step: schedule → wait → accept.
        world.client.schedule_admin_change(&world.admin, &outsider);
        world.advance_ledgers(world.get_timelock_delay());
        world.client.accept_admin(&outsider);
        prop_assert!(world.client.try_set_default_fee(&world.admin, &new_fee).is_err());
        world.client.set_default_fee(&outsider, &new_fee);
        prop_assert_eq!(world.client.get_default_fee(), new_fee);
    }

    /// I23 — pause blocks writes and leaves reads working.
    ///
    /// Also pins asymmetries A2 and A3: `claim_expired` has no pause check, and
    /// `resolve_dispute` reaches `release_one` directly rather than through the
    /// public `release`, so both still settle while paused.
    #[test]
    fn pause_blocks_writes_and_leaves_reads_working(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-paused", 3_600);
        world.client.confirm_delivery(&escrow_id, &world.buyer);
        world.client.pause(&world.admin);
        prop_assert!(world.client.is_paused());

        let paused_balances = world.balances();
        prop_assert!(world.client.try_lock(
            &world.buyer, &world.seller, &world.token_address(),
            &amount, &world.dataset("ds-paused-2"), &3_600u64).is_err());
        prop_assert!(world.client.try_release(&world.admin, &escrow_id).is_err());
        prop_assert!(world.client.try_refund(&world.admin, &escrow_id).is_err());
        prop_assert_eq!(world.balances(), paused_balances);

        // Reads are unaffected.
        prop_assert_eq!(world.client.get_escrow(&escrow_id).amount, amount);
        prop_assert_eq!(world.client.get_escrow_count(), 1);
        prop_assert_eq!(world.client.get_default_fee(), fee_bps);

        // I23 — emergency_withdraw requires the paused state AND the timelock.
        // Propose the sweep while paused; advance past the delay; then execute.
        world.client.schedule_emergency_withdraw(
            &world.admin, &world.token_address(), &world.treasury, &amount,
        );
        world.advance_ledgers(world.get_timelock_delay());
        // The timelock has now elapsed and the contract is still paused, so execute succeeds.
        world.client.execute_emergency_withdraw();
        prop_assert_eq!(world.balances().contract, 0);

        world.client.unpause(&world.admin);
        prop_assert!(!world.client.is_paused());
        // After unpausing, no further emergency withdraw is possible.
        prop_assert!(world.client.try_execute_emergency_withdraw().is_err());
    }

    /// A2 — `claim_expired` is reachable while paused. Pinned, not endorsed:
    /// see "Known asymmetries" in `docs/INVARIANTS.md`.
    #[test]
    fn claim_expired_is_not_blocked_by_pause(amount in amount(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let escrow_id = world.lock(amount, "ds-paused-claim", 3_600);
        world.advance_past(world.client.get_escrow(&escrow_id).deadline);
        world.client.pause(&world.admin);

        prop_assert!(world.client.try_claim_expired(&escrow_id, &world.seller).is_ok());
        prop_assert!(world.client.get_escrow(&escrow_id).released);
    }
}

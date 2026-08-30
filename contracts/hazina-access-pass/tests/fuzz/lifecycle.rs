//! Lifecycle state-machine property.
//!
//! Drives random `Subscribe / Renew / Revoke / SettleExpired / AdvanceTime`
//! sequences against a fresh world and, after EVERY op, checks the model
//! mirrors the contract exactly:
//!
//! 1. Custody conservation: contract token balance equals the sum of
//!    unsettled `amount_paid` across non-revoked passes. Failed ops change
//!    nothing (the invocation reverts whole).
//! 2. Access predicate: `has_access(buyer)` equals
//!    `pass exists && !revoked && now < expiry` for every buyer.
//! 3. Seat accounting: `get_seats_used` equals the number of holders with an
//!    unrevoked pass, including expired-but-held seats.
//! 4. Payout conservation: cumulative seller + treasury earnings track every
//!    settlement exactly.

use crate::harness::{
    config, prop_period, prop_price, prop_seats, prop_time_delta, World, DEFAULT_FEE_BPS,
};
use proptest::prelude::*;
use soroban_sdk::testutils::Ledger as _;

/// Model of one buyer's pass; mirrors the PassRecord fields we assert on.
#[derive(Clone, Debug)]
struct PassModel {
    start: u64,
    expiry: u64,
    period: u64,
    amount_paid: i128,
    revoked: bool,
}

impl PassModel {
    fn active_at(&self, now: u64) -> bool {
        !self.revoked && now < self.expiry
    }

    /// A holder occupies a seat from first subscribe until revoke; expired
    /// passes keep holding their seat by design (plan section 11 Q1).
    fn holds_seat(&self) -> bool {
        !self.revoked
    }
}

#[derive(Debug, Clone)]
enum Op {
    Subscribe(usize),
    Renew(usize),
    Revoke(usize),
    Settle(usize),
    Advance(u64),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0usize..3).prop_map(Op::Subscribe),
        4 => (0usize..3).prop_map(Op::Renew),
        2 => (0usize..3).prop_map(Op::Revoke),
        2 => (0usize..3).prop_map(Op::Settle),
        5 => prop_time_delta().prop_map(Op::Advance),
    ]
}

/// Platform cut with the escrow 1-stroop floor, recomputed independently of
/// the contract.
fn fee_with_floor(amount: i128, fee_bps: u32) -> i128 {
    let cut = amount * fee_bps as i128 / 10_000;
    if cut == 0 && amount > 0 && fee_bps > 0 {
        1
    } else {
        cut
    }
}

proptest! {
    #![proptest_config(config("lifecycle_conservation.txt"))]

    #[test]
    fn lifecycle_ops_conserve_value_and_match_model(
        price in prop_price(),
        period in prop_period(),
        max_seats in prop_seats(),
        ops in proptest::collection::vec(op_strategy(), 1..14),
    ) {
        let world = World::new(price, period, max_seats);
        let mut passes: [Option<PassModel>; 3] = [None, None, None];
        let mut custody: i128 = 0;
        let mut seller_earned: i128 = 0;
        let mut treasury_earned: i128 = 0;

        for op in ops.iter() {
            match op.clone() {
                Op::Subscribe(i) => {
                    let now = world.env.ledger().timestamp();
                    let seat_held = passes[i].as_ref().is_some_and(|p| p.holds_seat());
                    let active = passes[i].as_ref().is_some_and(|p| p.active_at(now));
                    let seats_held =
                        passes.iter().flatten().filter(|p| p.holds_seat()).count() as u32;

                    if active || (!seat_held && seats_held >= max_seats) {
                        prop_assert!(
                            world
                                .client
                                .try_subscribe(&world.buyers[i], &world.dataset_id, &world.plan_id)
                                .is_err(),
                            "subscribe should revert after {op:?}"
                        );
                        continue;
                    }

                    world.client.subscribe(&world.buyers[i], &world.dataset_id, &world.plan_id);
                    custody += price;
                    passes[i] = Some(PassModel {
                        start: now,
                        expiry: now.saturating_add(period),
                        period,
                        amount_paid: price,
                        revoked: false,
                    });
                }
                Op::Renew(i) => {
                    let now = world.env.ledger().timestamp();
                    let renewable = passes[i]
                        .as_ref()
                        .is_some_and(|p| !p.revoked);
                    if !renewable {
                        prop_assert!(
                            world
                                .client
                                .try_renew(&world.buyers[i], &world.dataset_id)
                                .is_err(),
                            "renew should revert after {op:?}"
                        );
                        continue;
                    }
                    let pass = passes[i].clone().unwrap();

                    if pass.amount_paid > 0 {
                        let fee = fee_with_floor(pass.amount_paid, DEFAULT_FEE_BPS);
                        seller_earned += pass.amount_paid - fee;
                        treasury_earned += fee;
                        custody -= pass.amount_paid;
                    }
                    custody += price;

                    let (start, expiry) = if now >= pass.expiry {
                        (now, now.saturating_add(period))
                    } else {
                        (pass.expiry, pass.expiry.saturating_add(period))
                    };
                    world.client.renew(&world.buyers[i], &world.dataset_id);
                    passes[i] = Some(PassModel {
                        start,
                        expiry,
                        period,
                        amount_paid: price,
                        revoked: false,
                    });
                }
                Op::Revoke(i) => {
                    let revocable = passes[i].as_ref().is_some_and(|p| !p.revoked);
                    if !revocable {
                        prop_assert!(
                            world
                                .client
                                .try_revoke(&world.seller, &world.buyers[i], &world.dataset_id)
                                .is_err(),
                            "revoke should revert after {op:?}"
                        );
                        continue;
                    }
                    let pass = passes[i].clone().unwrap();
                    let now = world.env.ledger().timestamp();
                    let elapsed = now.min(pass.expiry).saturating_sub(pass.start);
                    let remaining = pass.period - elapsed;
                    let refund = pass.amount_paid * remaining as i128 / pass.period as i128;
                    let earned = pass.amount_paid - refund;
                    let fee = fee_with_floor(earned, DEFAULT_FEE_BPS);

                    world.client.revoke(&world.seller, &world.buyers[i], &world.dataset_id);
                    custody -= pass.amount_paid;
                    seller_earned += earned - fee;
                    treasury_earned += fee;
                    passes[i].as_mut().unwrap().revoked = true;
                }
                Op::Settle(i) => {
                    let now = world.env.ledger().timestamp();
                    let settable = passes[i].as_ref().is_some_and(|p| {
                        !p.revoked && now >= p.expiry && p.amount_paid > 0
                    });
                    if !settable {
                        prop_assert!(
                            world
                                .client
                                .try_settle_expired(&world.buyers[i], &world.dataset_id)
                                .is_err(),
                            "settle_expired should revert after {:?}",
                            op
                        );
                        continue;
                    }
                    let pass = passes[i].clone().unwrap();
                    let fee = fee_with_floor(pass.amount_paid, DEFAULT_FEE_BPS);

                    world.client.settle_expired(&world.buyers[i], &world.dataset_id);
                    custody -= pass.amount_paid;
                    seller_earned += pass.amount_paid - fee;
                    treasury_earned += fee;
                    passes[i].as_mut().unwrap().amount_paid = 0;
                }
                Op::Advance(delta) => {
                    let now = world.env.ledger().timestamp();
                    world.env.ledger().set_timestamp(now + delta);
                }
            }

            // Post-op model checks run after every op, including Advance.
            let now = world.env.ledger().timestamp();
            prop_assert_eq!(
                world.token.balance(&world.client.address),
                custody,
                "custody diverged after {:?}",
                op
            );
            prop_assert_eq!(
                world.token.balance(&world.seller),
                seller_earned,
                "seller earnings diverged after {:?}",
                op
            );
            prop_assert_eq!(
                world.token.balance(&world.admin),
                treasury_earned,
                "treasury earnings diverged after {:?}",
                op
            );

            let seats_model = passes
                .iter()
                .flatten()
                .filter(|p| p.holds_seat())
                .count() as u32;
            prop_assert_eq!(
                world.client.get_seats_used(&world.plan_id),
                seats_model,
                "seat counter diverged after {:?}",
                op
            );

            for (i, slot) in passes.iter().enumerate() {
                let chain_access = world.client.has_access(&world.buyers[i], &world.dataset_id);
                let model_access = slot
                    .as_ref()
                    .is_some_and(|p| p.active_at(now));
                prop_assert_eq!(
                    chain_access, model_access,
                    "has_access diverged from model for buyer {} after {:?}",
                    i, op
                );
            }
        }
    }
}

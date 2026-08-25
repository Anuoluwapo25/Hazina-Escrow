//! `lock_multi` invariants — I12, I13, I14 (issue #536).
//!
//! `lock_multi` is the only entry point that moves one aggregate transfer and
//! then writes N independent records. That split is where an off-by-one in the
//! id sequence, a double-count in the total, or a partially applied batch would
//! hide, so these properties check the aggregate and the per-record view
//! against each other on the same run.

use hazina_escrow::{SellerShare, MIN_LOCK_AMOUNT};
use proptest::prelude::*;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, String as SorobanString, Vec as SorobanVec};

use crate::harness::{
    config, config_with_cases, expected_platform_cut, fee_bps, small_amount, World, BUYER_FLOAT,
};

/// Batches stay well under `DEFAULT_MAX_ESCROWS_PER_LEDGER` (100) so the rate
/// breaker is never why a case fails here — it has its own properties in
/// `circuit_breakers.rs`.
const MAX_BATCH: usize = 8;

const DATASET_IDS: [&str; MAX_BATCH] = [
    "ds-multi-0", "ds-multi-1", "ds-multi-2", "ds-multi-3",
    "ds-multi-4", "ds-multi-5", "ds-multi-6", "ds-multi-7",
];

/// Build the `(shares, dataset_ids)` pair `lock_multi` takes, one fresh seller
/// per share so no two can be collapsed by accident.
fn build_batch(
    world: &World,
    amounts: &[i128],
) -> (SorobanVec<SellerShare>, SorobanVec<SorobanString>, std::vec::Vec<Address>) {
    let mut shares = SorobanVec::new(&world.env);
    let mut dataset_ids = SorobanVec::new(&world.env);
    let mut sellers = std::vec::Vec::new();

    for (i, amount) in amounts.iter().enumerate() {
        let seller = world.new_seller();
        shares.push_back(SellerShare { seller: seller.clone(), amount: *amount });
        dataset_ids.push_back(world.dataset(DATASET_IDS[i]));
        sellers.push(seller);
    }
    (shares, dataset_ids, sellers)
}

fn batch_amounts() -> impl Strategy<Value = std::vec::Vec<i128>> {
    prop::collection::vec(small_amount(), 1..=MAX_BATCH)
}

/// Per-share amounts that individually pass every validator except the one we
/// are probing: they are well above `MIN_LOCK_AMOUNT`, and once the admin
/// raises the per-share circuit breaker to `i128::MAX` they pass that too, so
/// the *only* thing left to reject a batch is the unguarded
/// `total_amount += share.amount` wrapping past `i128::MAX`.
///
/// Every generated value is strictly greater than `i128::MAX / 2`, so any two
/// of them sum to more than `i128::MAX` — the accumulator is guaranteed to
/// overflow (not just approach) for a batch of length `>= 2`.
fn massive_amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        1 => Just(i128::MAX),
        1 => Just(i128::MAX - 1),
        1 => Just(i128::MAX - MIN_LOCK_AMOUNT),
        1 => Just(i128::MAX / 2 + 1),
        3 => (i128::MAX / 2 + 1)..=i128::MAX,
    ]
}

proptest! {
    #![proptest_config(config("proptest-regressions/lock_multi.txt"))]

    /// I12 — the buyer is debited exactly the sum of the shares and the
    /// contract holds exactly that sum. Not more (double charge), not less (a
    /// share silently dropped).
    #[test]
    fn lock_multi_total_equals_sum_of_shares(amounts in batch_amounts(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let before = world.balances();
        let expected_total: i128 = amounts.iter().sum();

        let (shares, dataset_ids, _) = build_batch(&world, &amounts);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        let after = world.balances();
        prop_assert_eq!(before.buyer - after.buyer, expected_total);
        prop_assert_eq!(after.contract, expected_total);
        prop_assert_eq!(after.total(), before.total());
        prop_assert_eq!(first_id, 0);

        // The per-record view must add back up to the aggregate transfer.
        let recorded_total: i128 = (0..amounts.len() as u64)
            .map(|i| world.client.get_escrow(&(first_id + i)).amount)
            .sum();
        prop_assert_eq!(recorded_total, expected_total);
    }

    /// I13 — ids are contiguous from the returned `first_id`, one per share, and
    /// the counter advances by exactly the batch size. A second batch continues
    /// the sequence rather than restarting it.
    #[test]
    fn lock_multi_assigns_contiguous_ids(
        first_batch in batch_amounts(),
        second_batch in batch_amounts(),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);

        let (shares, dataset_ids, sellers) = build_batch(&world, &first_batch);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        prop_assert_eq!(first_id, 0);
        prop_assert_eq!(world.client.get_escrow_count(), first_batch.len() as u64);

        for (i, amount) in first_batch.iter().enumerate() {
            let record = world.client.get_escrow(&(first_id + i as u64));
            prop_assert_eq!(record.escrow_id, first_id + i as u64);
            prop_assert_eq!(record.amount, *amount);
            prop_assert_eq!(&record.seller, &sellers[i]);
            prop_assert_eq!(&record.buyer, &world.buyer);
            prop_assert!(!record.buyer_confirmed);
            prop_assert!(!record.released);
            prop_assert!(!record.refunded);
            prop_assert!(!record.disputed);
        }

        world.advance_ledgers(1);
        let (shares_2, dataset_ids_2, _) = build_batch(&world, &second_batch);
        let second_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares_2, &dataset_ids_2);

        prop_assert_eq!(second_id, first_batch.len() as u64);
        prop_assert_eq!(
            world.client.get_escrow_count(),
            (first_batch.len() + second_batch.len()) as u64
        );
    }

    /// I12 — releasing the batch pays out exactly what was locked. The fee is
    /// charged per escrow, not on the batch total; those differ once truncation
    /// is in play, and this pins which one the contract does.
    #[test]
    fn releasing_a_batch_conserves_the_batch_total(
        amounts in batch_amounts(),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();
        let expected_total: i128 = amounts.iter().sum();

        let (shares, dataset_ids, sellers) = build_batch(&world, &amounts);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        let mut escrow_ids = SorobanVec::new(&world.env);
        for i in 0..amounts.len() as u64 {
            world.client.confirm_delivery(&(first_id + i), &world.buyer);
            escrow_ids.push_back(first_id + i);
        }
        world.client.release_multi(&world.admin, &escrow_ids);

        let expected_platform: i128 =
            amounts.iter().map(|a| expected_platform_cut(*a, fee_bps)).sum();

        let mut paid_to_sellers = 0i128;
        for (i, seller) in sellers.iter().enumerate() {
            let paid = world.token.balance(seller);
            prop_assert_eq!(paid, amounts[i] - expected_platform_cut(amounts[i], fee_bps));
            paid_to_sellers += paid;
        }

        prop_assert_eq!(world.fee_recipient_balance(), expected_platform);
        prop_assert_eq!(paid_to_sellers + expected_platform, expected_total);
        prop_assert_eq!(world.balances().contract, 0);
        // `Balances` only tracks the world's fixed accounts and a batch pays
        // freshly generated sellers, so add those back for the sum to close.
        prop_assert_eq!(world.balances().total() + paid_to_sellers, before.total());
    }

    /// I14 — the batch is atomic. `lock_multi` validates in one pass and writes
    /// in a second; a check moved into the write loop would leave a partial
    /// batch behind, and this catches that.
    #[test]
    fn lock_multi_is_atomic_when_a_share_is_invalid(
        amounts in prop::collection::vec(small_amount(), 2..=MAX_BATCH),
        bad_index in 0usize..MAX_BATCH,
        bad_amount in -1_000i128..MIN_LOCK_AMOUNT,
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let mut amounts = amounts;
        let bad_index = bad_index % amounts.len();
        amounts[bad_index] = bad_amount;

        let (shares, dataset_ids, _) = build_batch(&world, &amounts);
        let result = world.client.try_lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        prop_assert!(result.is_err(), "share of {} was accepted", bad_amount);
        prop_assert_eq!(world.balances(), before);
        prop_assert_eq!(world.client.get_escrow_count(), 0);
        prop_assert!(world.client.try_get_escrow(&0).is_err());
    }

    /// I14 — a shares/dataset-ids length mismatch is rejected in either
    /// direction, with no partial batch left behind.
    #[test]
    fn lock_multi_rejects_length_mismatch(
        amounts in prop::collection::vec(small_amount(), 1..=MAX_BATCH),
        drop_from_shares in any::<bool>(),
    ) {
        let world = World::new(500);
        let before = world.balances();
        let (mut shares, mut dataset_ids, _) = build_batch(&world, &amounts);

        if drop_from_shares { shares.pop_back(); } else { dataset_ids.pop_back(); }

        let result = world.client.try_lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        prop_assert!(result.is_err());
        prop_assert_eq!(world.balances(), before);
        prop_assert_eq!(world.client.get_escrow_count(), 0);
    }

    /// I14 — an empty batch is rejected, not treated as a no-op that still
    /// advances the counter.
    #[test]
    fn lock_multi_rejects_empty_batch(fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let before = world.balances();
        let shares: SorobanVec<SellerShare> = SorobanVec::new(&world.env);
        let dataset_ids: SorobanVec<SorobanString> = SorobanVec::new(&world.env);

        let result = world.client.try_lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        prop_assert!(result.is_err());
        prop_assert_eq!(world.balances(), before);
        prop_assert_eq!(world.client.get_escrow_count(), 0);
    }

    /// I12 + I13 — the aggregate property for `lock_multi`: the single debited
    /// total equals `sum(share.amount)`, the sum of the created escrow records
    /// equals that same total, and a second batch continues the monotonic,
    /// gap-free id sequence with the counter advancing by exactly the batch
    /// size. Rejects mismatched shares/dataset_ids lengths.
    #[test]
    fn lock_multi_sums(amounts in batch_amounts(), fee_bps in fee_bps()) {
        let world = World::new(fee_bps);
        let before = world.balances();

        // Mismatched shares/dataset_ids lengths must reject before any tokens
        // move and without advancing the counter (I14).
        let (full_shares, mut full_datasets, _) = build_batch(&world, &amounts);
        full_datasets.pop_back();
        let rejected = world.client.try_lock_multi(
            &world.buyer, &world.token_address(), &full_shares, &full_datasets);
        prop_assert!(rejected.is_err());
        prop_assert_eq!(world.balances(), before);
        prop_assert_eq!(world.client.get_escrow_count(), 0);

        // The valid batch now locks the aggregate.
        let expected_total: i128 = amounts.iter().sum();
        let (shares, dataset_ids, _) = build_batch(&world, &amounts);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        let after = world.balances();
        // I12 — the single aggregate transfer debits exactly the sum of the shares.
        prop_assert_eq!(before.buyer - after.buyer, expected_total);
        prop_assert_eq!(after.contract, expected_total);
        prop_assert_eq!(after.total(), before.total());

        // I12 — the sum of the created escrow records re-superposes onto that
        // same total, and they form a monotonic, gap-free id sequence.
        let mut recorded_total: i128 = 0;
        for i in 0..amounts.len() as u64 {
            let id = first_id + i;
            let record = world.client.get_escrow(&id);
            prop_assert_eq!(record.escrow_id, id);
            prop_assert_eq!(record.amount, amounts[i as usize]);
            recorded_total += record.amount;
        }
        prop_assert_eq!(recorded_total, expected_total);
        // I13 — the counter advanced by exactly the batch size, not more.
        prop_assert_eq!(world.client.get_escrow_count(), amounts.len() as u64);

        // I13 — continuing with a second batch keeps the sequence monotonic and
        // gap-free rather than restarting from 0.
        world.advance_ledgers(1);
        let (shares_2, dataset_ids_2, _) = build_batch(&world, &amounts);
        let second_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares_2, &dataset_ids_2);
        prop_assert_eq!(second_id, first_id + amounts.len() as u64);
        for i in 0..amounts.len() as u64 {
            prop_assert_eq!(world.client.get_escrow(&(second_id + i)).escrow_id, second_id + i);
        }
        prop_assert_eq!(
            world.client.get_escrow_count(),
            first_id + 2 * amounts.len() as u64
        );
    }

    /// i128-boundary probe — I12 running head-first into the unguarded
    /// `total_amount += share.amount` accumulator in `lock_multi`. Once the
    /// admin raises the per-share circuit breaker to `i128::MAX`, every
    /// generated share is individually legal (`>= MIN_LOCK_AMOUNT`, `<=`
    /// breaker), so the *only* thing that can reject the batch is the sum
    /// overflowing `i128::MAX`. Every `massive_amount()` value sits above
    /// `i128::MAX / 2`, so any two of them push the accumulator over the edge.
    ///
    /// With `overflow-checks` on (release profile and the test env) the
    /// overflow is a trap that fires in the aggregation loop — *before* the
    /// token transfer — and `try_lock_multi` surfaces it as a rejection with
    /// zero side effects (I14): no tokens move, no records exist, the counter
    /// does not advance.
    #[test]
    fn lock_multi_sums_rejects_overflow(
        shares in prop::collection::vec(massive_amount(), 2..=5),
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        world.client.set_max_escrow_amount(&world.admin, &i128::MAX);
        let before = world.balances();

        // Every share is legal on its own; the batch total is what overflows.
        prop_assert!(shares.iter().all(|a| *a >= MIN_LOCK_AMOUNT && *a <= i128::MAX));
        let total = shares.iter().fold(0i128, |acc, a| acc.saturating_add(*a));
        prop_assert_eq!(total, i128::MAX, "massive batch must saturate past the limit");

        let (share_vec, dataset_ids, _) = build_batch(&world, &shares);
        let result = world.client.try_lock_multi(
            &world.buyer, &world.token_address(), &share_vec, &dataset_ids);

        prop_assert!(result.is_err(), "a batch summing past i128::MAX was accepted");
        // Atomic — nothing flowed, nothing was written, the counter is idle.
        prop_assert_eq!(world.balances(), before);
        prop_assert_eq!(world.client.get_escrow_count(), 0);
        prop_assert!(world.client.try_get_escrow(&0).is_err());
    }

    /// I12 at the top of the range — the sum/transfer/record triequality holds
    /// when the *total* is right up against `i128::MAX` but still representable.
    /// Unlike the overflow probe above, shares here are constrained so the batch
    /// sum stays `<= i128::MAX`, and the buyer is minted enough to actually fund
    /// a transfer of that size (the default float of 64e12 stroops cannot).
    #[test]
    fn lock_multi_sums_just_under_i128(
        shares_count in 2usize..=4,
        fee_bps in fee_bps(),
    ) {
        let world = World::new(fee_bps);
        world.client.set_max_escrow_amount(&world.admin, &i128::MAX);

        // Split the top of the range so the sum is representable: each share is a
        // little shy of i128::MAX / count, so the total is far above any ordinary
        // amount but still `<= i128::MAX`.
        let floor = i128::MAX / shares_count as i128;
        let amounts: std::vec::Vec<i128> = (0..shares_count as u64)
            .map(|i| {
                // Bring i-th share down by (i+1) to keep room for the rest.
                floor - (i as i128 + 1)
            })
            .collect();
        let expected_total: i128 = amounts.iter().sum();
        prop_assert!(amounts.iter().all(|a| *a >= MIN_LOCK_AMOUNT));
        prop_assert!(expected_total > 1_000_000_000_000_000i128); // genuinely near the top
        prop_assert!(expected_total <= i128::MAX);

        // Fund the buyer for a transfer of `expected_total`. The world already
        // minted `BUYER_FLOAT` (64e12), so minting the full `expected_total` on
        // top would overflow the balance near `i128::MAX`; top up to exactly
        // `expected_total` instead.
        let top_up = expected_total - BUYER_FLOAT;
        StellarAssetClient::new(&world.env, &world.token_address()).mint(&world.buyer, &top_up);
        prop_assert_eq!(world.token.balance(&world.buyer), expected_total);
        let before = world.balances();

        let (shares, dataset_ids, _) = build_batch(&world, &amounts);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        let after = world.balances();
        prop_assert_eq!(before.buyer - after.buyer, expected_total);
        prop_assert_eq!(after.contract, expected_total);
        prop_assert_eq!(after.total(), before.total());

        let recorded: i128 = (0..shares_count as u64)
            .map(|i| world.client.get_escrow(&(first_id + i)).amount)
            .sum();
        prop_assert_eq!(recorded, expected_total);
        prop_assert_eq!(world.client.get_escrow_count(), shares_count as u64);
    }
}

proptest! {
    // Up to 8 escrows individually refunded is the most expensive case shape in
    // the suite; give it a smaller budget.
    #![proptest_config(config_with_cases("proptest-regressions/lock_multi.txt", 24))]

    /// I12 — refunding a whole batch returns the buyer to exactly where they
    /// started, whatever order the refunds happen in.
    #[test]
    fn refunding_a_batch_returns_the_exact_total(
        amounts in batch_amounts(),
        fee_bps in fee_bps(),
        rotation in 0usize..MAX_BATCH,
    ) {
        let world = World::new(fee_bps);
        let before = world.balances();

        let (shares, dataset_ids, sellers) = build_batch(&world, &amounts);
        let first_id = world.client.lock_multi(
            &world.buyer, &world.token_address(), &shares, &dataset_ids);

        let n = amounts.len();
        for step in 0..n {
            world.client.refund(&world.admin, &(first_id + ((step + rotation) % n) as u64));
        }

        let after = world.balances();
        prop_assert_eq!(after.buyer, before.buyer);
        prop_assert_eq!(after.contract, 0);
        prop_assert_eq!(after.total(), before.total());
        for seller in &sellers {
            prop_assert_eq!(world.token.balance(seller), 0);
        }
    }
}

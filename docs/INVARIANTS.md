# Escrow contract invariants

The properties that must hold for **any** input to `contracts/hazina-escrow`.

This is the specification the property-based suite in
`contracts/hazina-escrow/tests/fuzz/` tests against. Every invariant below
carries an ID (`I1`, `I2`, …) and the property that enforces it. If you change
the contract's money-moving math, change this document in the same commit.

Run the suite:

```bash
cd contracts/hazina-escrow
cargo test --features fuzz-tests --test fuzz
```

See `docs/FUZZING.md` for the runbook (case budgets, regression seeds,
reproducing a failure).

## Vocabulary

| Term         | Meaning                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| stroop       | Smallest indivisible token unit. All contract math is in stroops.                                     |
| bps          | Basis points. `MAX_BASIS_POINTS = 10_000` = 100 %.                                                    |
| `amount`     | Stroops locked for one escrow. `lock` requires `amount >= MIN_LOCK_AMOUNT` (10 000).                  |
| `fee_bps`    | Platform rate snapshotted into the record at lock time. `0 <= fee_bps <= MAX_FEE_BPS` (2 000 = 20 %). |
| platform cut | `max(1, amount * fee_bps / 10_000)` when `fee_bps > 0`, else `0`. See I9.                             |
| seller cut   | `amount - platform_cut`.                                                                              |
| settled      | `released == true` or `refunded == true`.                                                             |

Accounts value can reach: **buyer**, **seller**, **treasury** (falls back to
**admin** when unset), and the **contract** itself.

---

## Value conservation

### I1 — release splits the locked amount exactly

`release` (and `release_multi`, and `resolve_dispute(favour_buyer = false)`)
pays `seller_cut` to the seller and `platform_cut` to the treasury, where
`seller_cut + platform_cut == amount`. The contract retains nothing for that
escrow and the buyer's balance is unchanged from immediately after the lock.

> `conservation::release_conserves_locked_value`,
> `conservation::release_conserves_value_when_treasury_unset`,
> `conservation::release_uses_snapshotted_dataset_fee`

### I2 — refund returns the whole amount to the buyer

`refund` and `resolve_dispute(favour_buyer = true)` return exactly `amount` to
the buyer. No fee is taken on a refund at any rate, and the seller and treasury
receive nothing. This holds whether or not the buyer had already confirmed
delivery.

> `conservation::refund_returns_all_locked_value_to_buyer`,
> `conservation::refund_after_confirmation_still_returns_everything`,
> `conservation::dispute_resolved_for_buyer_refunds_in_full`

### I3 — `claim_expired` withholds the fee inside the contract

Deliberately **not** symmetric with `release`. The seller receives
`amount - platform_cut`; the platform cut stays in the contract balance rather
than being forwarded to the treasury, and the admin sweeps it later with
`emergency_withdraw`. Value is still conserved — it just does not all leave.

> `conservation::claim_expired_pays_seller_and_retains_fee_in_contract`

### I4 — no path creates or destroys tokens

For every entry point, the sum of balances over {buyer, seller, treasury,
admin, contract} is unchanged. Every transfer is a move between two of those
accounts.

> `conservation::total_supply_is_invariant_across_mixed_settlements`

---

## Settlement exclusivity

### I5 — release XOR refund

`released && refunded` is never true for any escrow, under any ordering of
settlement calls.

> `settlement::release_xor_refund_under_any_settlement_ordering`,
> `settlement::dispute_resolution_settles_exactly_once`

### I6 — terminal states are absorbing

Once an escrow is settled, every mutating entry point on it fails:
`release`, `refund`, `claim_expired`, `confirm_delivery`, `raise_dispute`,
`resolve_dispute`. A rejected call moves no value.

> `settlement::settled_escrow_rejects_every_further_mutation`

### I7 — settlement pays out at most once

Across any sequence of settlement attempts against one escrow, at most one
succeeds. Settling one escrow never touches a sibling escrow's record or funds.

> `settlement::release_xor_refund_under_any_settlement_ordering`,
> `settlement::settling_one_escrow_leaves_siblings_untouched`

---

## Fee bounds

### I8 — the seller always receives at least 80 %

`MAX_FEE_BPS = 2_000`, so for any escrow created through `lock` the seller cut
is at least 80 % of the locked amount and the platform cut is at most
`amount * 2_000 / 10_000`. Holds for both settlement paths that take a fee
(`release`, `claim_expired`).

The bound depends on the min-1-stroop floor never firing on a locked escrow,
which is guaranteed by `MIN_LOCK_AMOUNT == MAX_BASIS_POINTS == 10_000`: for
`amount >= 10_000` and `fee_bps >= 1`, `amount * fee_bps / 10_000 >= 1`
already. **Lowering `MIN_LOCK_AMOUNT` below `MAX_BASIS_POINTS` breaks I8.**

> `fee_bounds::seller_receives_at_least_eighty_percent`,
> `fee_bounds::claim_expired_pays_seller_at_least_eighty_percent`,
> `fee_bounds::fee_model_is_bounded_over_the_whole_input_space`

### I9 — min-1-stroop: the cut is zero exactly when the rate is zero

```rust
let calculated = amount * fee_bps / 10_000;         // truncating
let platform_cut = if calculated == 0 && amount > 0 && fee_bps > 0 { 1 }
                   else { calculated };
```

So `platform_cut == 0` ⟺ `fee_bps == 0` (for `amount > 0`). A non-zero rate
never truncates away to nothing, and a zero rate never picks up the floor. On
`amount == 1` the floor consumes the entire payment and the seller receives 0 —
allowed, and conservation still holds.

The floor is unreachable through `lock` (see I8). It is reachable through
records written straight to storage, which is how the properties exercise it.

> `fee_bounds::platform_cut_is_zero_iff_fee_bps_is_zero`,
> `fee_bounds::min_one_stroop_floor_holds_on_dust_amounts`,
> `fee_bounds::zero_fee_takes_nothing_even_on_dust`

### I10 — the fee is snapshotted at lock time

`record.platform_fee_bps` is resolved once, in `lock` / `lock_multi`, from the
dataset override or the default. Later `set_default_fee` / `set_dataset_fee` /
`clear_dataset_fee` calls cannot reprice an existing escrow.

> `fee_bounds::locked_fee_is_immune_to_later_repricing`,
> `conservation::release_uses_snapshotted_dataset_fee`

### I11 — no fee above the cap can ever be stored

`initialize`, `set_default_fee`, `set_fee`, `update_fee` and `set_dataset_fee`
all reject `fee_bps > MAX_FEE_BPS`, and a rejected write leaves the previous
value untouched. The cap itself is inclusive.

> `fee_bounds::fees_above_the_cap_are_rejected_everywhere`,
> `fee_bounds::initialize_rejects_fees_above_the_cap`

---

## `lock_multi`

### I12 — total debited equals the sum of the shares

One aggregate transfer of `sum(share.amount)` leaves the buyer, and the same
figure is recoverable by summing the individual escrow records. Releasing the
batch pays out `sum(seller_cut_i) + sum(platform_cut_i) == sum(amount_i)`; the
fee is computed **per escrow**, not on the batch total (these differ once
truncation is in play).

> `lock_multi::lock_multi_total_equals_sum_of_shares`,
> `lock_multi::releasing_a_batch_conserves_the_batch_total`,
> `lock_multi::refunding_a_batch_returns_the_exact_total`

### I13 — ids are contiguous and the counter advances by the batch size

`lock_multi` returns `first_id`; the batch occupies
`first_id .. first_id + shares.len()` with no gaps, and `EscrowCount` advances
by exactly `shares.len()`. A second batch continues the sequence.

> `lock_multi::lock_multi_assigns_contiguous_ids`

### I14 — the batch is atomic

Validation runs in a full pass before any state is written, so one invalid
share (amount below `MIN_LOCK_AMOUNT`, blacklisted seller, over the amount
breaker), a shares/dataset-ids length mismatch, or an empty batch rejects the
whole call: no tokens move, no records exist, the counter does not advance.

> `lock_multi::lock_multi_is_atomic_when_a_share_is_invalid`,
> `lock_multi::lock_multi_rejects_length_mismatch`,
> `lock_multi::lock_multi_rejects_empty_batch`

---

## Circuit breakers

### I15 — the amount breaker is an inclusive ceiling

`lock` succeeds iff `amount <= max_escrow_amount` (default
`DEFAULT_MAX_ESCROW_AMOUNT`, admin-settable to any positive value). Applied per
share in `lock_multi`, never to the batch total. A rejected lock moves no
tokens and creates no record.

> `circuit_breakers::amount_breaker_is_an_inclusive_ceiling`,
> `circuit_breakers::amount_breaker_applies_per_share_not_per_batch`

### I16 — the rate breaker caps escrow creation per ledger

At most `max_escrows_per_ledger` escrows are created in any single ledger
sequence, counting `lock` as 1 and `lock_multi` as `shares.len()`. The counter
is keyed on the ledger sequence and resets when the sequence advances.

> `circuit_breakers::rate_breaker_caps_escrows_per_ledger`,
> `circuit_breakers::rate_breaker_counts_lock_multi_as_batch_size`,
> `circuit_breakers::rate_breaker_counter_resets_when_the_ledger_advances`,
> `contracts/hazina-escrow/src/lib.rs::tests::test_rate_limit_counter_resets_on_new_ledger`

### I17 — a rejected call does not consume budget

A lock rejected by either breaker leaves the per-ledger counter where it was,
so a single oversized request cannot lock out the rest of the ledger.

> `circuit_breakers::rejected_locks_do_not_consume_rate_budget`

---

## State machine

### I18 — confirmation gates release, once

`release` requires `buyer_confirmed`. Only the buyer can confirm, only once,
and only before settlement or dispute.

> `state_machine::release_requires_buyer_confirmation`,
> `state_machine::confirm_delivery_is_single_use_and_buyer_only`

### I19 — disputes are buyer-only, single-use, and window-bounded

`raise_dispute` requires: caller is the buyer, escrow is unsettled and not
already disputed, and `ledger.sequence() <= dispute_deadline` (set at lock time
to `sequence + DISPUTE_WINDOW_LEDGERS`).

> `state_machine::dispute_window_is_enforced`,
> `state_machine::raise_dispute_is_buyer_only_and_single_use`

### I20 — a disputed escrow is frozen except to the arbitrator

While `disputed`, `release`, `claim_expired` and `confirm_delivery` all fail.
Only `resolve_dispute` — callable by the arbitrator, defaulting to the admin —
can move it, and it clears the flag either way.

> `state_machine::disputed_escrow_is_frozen_until_resolved`

### I21 — the arbitrator's ruling maps onto the normal settlement paths

`favour_buyer = true` → the refund path (I2). `favour_buyer = false` → the
release path (I1), and it overrides the missing buyer confirmation.

> `settlement::dispute_resolution_settles_exactly_once`,
> `conservation::dispute_resolved_for_buyer_refunds_in_full`

---

## Access control and pause

### I22 — the admin surface rejects everyone else

`pause`, `unpause`, `set_default_fee` / `set_fee` / `update_fee`,
`set_dataset_fee`, `clear_dataset_fee`, `schedule_set_treasury` / `execute_set_treasury` / `cancel_set_treasury`,
`schedule_admin_change` / `accept_admin` / `cancel_admin_change`,

`schedule_upgrade` / `execute_upgrade` / `cancel_upgrade`, `set_whitelist_enforced`, `set_address_whitelisted`,
`set_address_blacklisted`, `set_max_escrow_amount`,
`set_max_escrows_per_ledger`, `set_arbitrator`, `release`, `release_multi`,
`schedule_emergency_withdraw` / `execute_emergency_withdraw` / `cancel_emergency_withdraw` all require the stored admin.
`resolve_dispute` requires the arbitrator.

> `state_machine::admin_surface_rejects_non_admin_callers`,
> `circuit_breakers::breaker_config_is_admin_only_and_validated`

### I23 — pause blocks writes, not reads

While paused: `lock`, `lock_multi`, `release`, `release_multi` and `refund`
fail; `get_escrow`, `get_escrow_count` and the config getters still work.
`emergency_withdraw` requires the _paused_ state AND the timelock to have elapsed.

> `state_machine::pause_blocks_writes_and_leaves_reads_working`

---

## Known asymmetries

Real, current behaviour. They are pinned by tests so they cannot change
silently, but they are **not** claimed to be desirable.

| #   | Behaviour                                                                                                                                                                              | Where                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| A1  | `claim_expired` leaves the platform cut in the contract instead of paying the treasury (I3).                                                                                           | `lib.rs::claim_expired`   |
| A2  | `claim_expired` does not check the pause flag, so a seller can claim an expired escrow while the contract is paused. Pinned by `state_machine::claim_expired_is_not_blocked_by_pause`. | `lib.rs::claim_expired`   |
| A3  | `resolve_dispute` reaches `release_one` directly and so bypasses the pause check that public `release` performs.                                                                       | `lib.rs::resolve_dispute` |
| A4  | `lock_multi` does not call `assert_valid_parties`, so a buyer may be their own seller in a batch — `lock` forbids it.                                                                  | `lib.rs::lock_multi`      |
| A5  | `lock_multi` has no expiry parameter; every escrow it creates gets a fixed 1-hour deadline.                                                                                            | `lib.rs::lock_multi`      |
| A6  | `refund_one` clears `disputed` on refund, but `release_disputed_one` clears it _and_ forces `buyer_confirmed = true`.                                                                  | `lib.rs`                  |
| A7  | **Emergency withdraw now requires both the paused flag _and_ the timelock to have elapsed**, so a fully compromised admin key cannot instantly drain all funds — there is a observable window. | `lib.rs::schedule_emergency_withdraw` |
| A8  | **Upgrade now requires the timelock to have elapsed**, so a malicious admin cannot instantly swap the contract WASM without observation.                                                   | `lib.rs::schedule_upgrade` |
| A9  | **Admin change is now two-step**: proposer schedules, candidate must `accept_admin` with their own signature. A typo'd or hostile address cannot take over unilaterally.               | `lib.rs::schedule_admin_change` |
| A10 | **Timelock delay itself is timelocked**: changing `MIN_TIMELOCK_DELAY_LEDGERS` or `DEFAULT_TIMELOCK_DELAY_LEDGERS` requires the current delay to have elapsed first.                  | `lib.rs::schedule_set_timelock_delay` |

---

## Contract fee math vs. backend fee math

The backend (`backend/src/common/constants.ts`) computes the same split in
floating point for display and accounting. The two will not agree stroop-for-
stroop, and the differences are characterised — not eliminated — by the
differential test.

**Contract** — integer, basis points, truncating, min-1-stroop floor,
`platform_cut + seller_cut == amount` by construction.

**Backend** —

```ts
export const PLATFORM_FEE_RATE = parseFloat(process.env.PLATFORM_FEE_RATE ?? '0.05');
export const PLATFORM_FEE_BPS = Math.round(PLATFORM_FEE_RATE * 10_000);
export function platformFee(pricePerQuery: number): number {
  return parseFloat((pricePerQuery * PLATFORM_FEE_RATE).toFixed(4)); // 4 dp
}
export function sellerShare(pricePerQuery: number): number {
  return parseFloat((pricePerQuery * SELLER_PAYOUT_RATE).toFixed(7)); // 7 dp
}
```

Points of divergence:

1. **Precision.** Integer bps vs. IEEE-754 doubles.
2. **Rounding.** Truncation vs. half-up rounding at 4 dp (fee) and 7 dp
   (seller share).
3. **Minimum fee.** The contract's min-1-stroop floor has no backend
   equivalent; a small enough price rounds the backend fee to 0.
4. **Conservation.** The contract's two cuts sum to `amount` by construction.
   The backend rounds each side independently, so
   `platformFee(p) + sellerShare(p)` may not equal `p`.

`PLATFORM_FEE_BPS` is the shared handle: the backend derives it from the same
`PLATFORM_FEE_RATE` it uses off-chain and passes it to the contract, so the
_rate_ cannot diverge even though the _rounding_ does.

### I24 — the divergence is bounded at 501 stroops

The backend quantises the fee to four decimals of a whole token unit — 1 000
stroops — so its answer can sit up to 500 stroops from the exact fee. The
contract truncates, costing under one. The budget is therefore 501 stroops, and
it is dominated entirely by the backend's rounding rather than the contract's.

Neither side is reimplemented in the other's language: `toFixed(4)` rounds ties
away from zero while Rust's formatter rounds to even, so a hand-port would be
testing the port. Instead `backend/scripts/gen-fee-vectors.ts` runs the real
backend functions over a fixed price grid into
`contracts/hazina-escrow/tests/fixtures/fee_vectors.json`, and the two sides are
checked against that file from opposite directions.

> `fee_differential::contract_fee_tracks_backend_fee_within_tolerance`,
> `fee_differential::contract_truncation_error_is_under_one_stroop`,
> `fee_differential::real_contract_matches_the_model_on_every_vector`,
> `fee_differential::backend_bps_is_the_rate_the_backend_uses`,
> `backend/src/common/constants.differential.test.ts`

Guidance: treat backend figures as display values, and the contract's integer
result as authoritative for settlement. Never reconcile a payout against a
backend-computed number without allowing the 501-stroop budget. See
[`FUZZING.md`](FUZZING.md) for regenerating the fixture.

---

# Seller bond contract invariants

The properties that must hold for **any** input to `contracts/hazina-seller-bond`.

Every invariant below carries an ID (`B1`, `B2`, …) and the property that
enforces it. Run the suite:

```bash
cd contracts/hazina-seller-bond
cargo test --features fuzz-tests --test fuzz
```

See `docs/FUZZING.md` for the runbook.

## Vocabulary

| Term         | Meaning                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| stroop       | Smallest indivisible token unit. All contract math is in stroops.                                       |
| bps          | Basis points. `MAX_BASIS_POINTS = 10_000` = 100 %.                                                      |
| `staked`     | Total USDC deposited by a seller via `stake`.                                                           |
| `cut`        | `min(staked, max(1, staked * bps / MAX_BASIS_POINTS))` — the amount transferred to the beneficiary.     |
| slashable    | `staked` remains fully slashable during cooldown and until actually withdrawn.                           |

---

## Value conservation

### B1 — total value is conserved across all operations

Tokens deposited via `stake` == outstanding `staked` + paid-out slashes +
withdrawals, at every step. For every entry point, the sum of balances over
{seller, arbitrator, beneficiary, contract} is unchanged. Every transfer is
a move between two of those accounts.

> `conservation::stake_slash_withdraw_conserves_total_value`
> `conservation::randomised_sequence_conserves_total_value`

### B2 — stake remains slashable during cooldown

After `request_unstake`, `slash` still succeeds and reduces `staked`. The
seller's funds are not protected by a pending unstake request.

> `conservation::stake_slashable_during_cooldown`

### B3 — withdrawal is gated by cooldown and clamped

`withdraw` fails before `cooldown_ends`. After cooldown, it pays at most
`min(pending_unstake, staked)`. A rejected call moves no value.

> `conservation::withdraw_boundary_clamp`

---

## Slash properties

### B4 — double slash on one escrow reverts with typed error

The same `escrow_id` can be slashed exactly once. The second attempt reverts
with `AlreadySlashed` (error #14) and moves nothing.

> `conservation::double_slash_is_idempotent`

### B5 — slash bounds are enforced everywhere

`0 < bps <= MAX_SLASH_BPS` (2 000) enforced everywhere. `InvalidSlashBps`
(error #13) rejects out-of-range values; the call moves nothing.

> Gate: `test_slash_rejects_zero_bps`, `test_slash_rejects_bps_above_max`

### B6 — a slash never pays more than currently staked

The clamp `min(staked, max(1, raw_cut))` ensures `cut <= staked` for any
`bps` in `(0, MAX_SLASH_BPS]`.

> `conservation::slash_never_exceeds_staked`

---

## Tier and dispute properties

### B7 — tier is a pure function of current `staked`

Tier is derived, never stored. Nothing besides the current `staked` amount
influences the tier. Slashing changes tier automatically.

> `conservation::tier_depends_only_on_staked`
> Gate: `test_tier_derived_in_get_bond`

### B8 — dispute lock blocks unstake

`request_unstake` fails while the escrow contract reports open disputes for
the seller (`OpenDisputeBlocksUnstake`, error #11). Succeeds after they
resolve. This is enforced via cross-contract read of the escrow's
`dspt_cnt` function.

> Formal: `formal_dispute_locked_stake_cannot_be_withdrawn`

### B9 — failed calls move no value

For every entry point, a rejected call (error or auth failure) leaves all
balances and state unchanged.

> Gate: all `#[should_panic]` tests in the gate suite

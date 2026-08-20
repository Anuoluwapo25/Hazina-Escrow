# Invariants – Hazina Escrow

This document lists all invariants that must hold for the Hazina Escrow contract.  
They are the single source of truth for property‑based tests and manual review.  
Each invariant includes:

- A plain‑English statement of what must always be true.
- The code path(s) that enforce it.
- The error code that is raised when the invariant is violated.

The contract’s full source is at [`src/lib.rs`](../src/lib.rs).

---

## 1. Initialization & Admin

### I‑1: Contract can be initialized only once
- **Statement**: The `initialize` function must be called exactly once. Subsequent calls are rejected.
- **Code paths**: `initialize()` checks `DataKey::Initialized` before writing any other state.
- **Error**: `AlreadyInitialized` (#1).

### I‑2: Admin‑only functions are protected
- **Statement**: All administrative actions (fee changes, pausing, circuit‑breaker tuning, address policy, etc.) may be invoked only by the current admin address.
- **Code paths**: `assert_admin()` is called at the start of every admin function.
- **Error**: `NotAdmin` (#3).

---

## 2. Pause State

### I‑3: Pause blocks all fund‑moving operations
- **Statement**: When `paused` is `true`, any call to `lock`, `lock_multi`, `release`, `release_multi`, `refund`, `claim_expired`, or `emergency_withdraw` fails. Read‑only functions (`get_escrow`, etc.) remain available.
- **Code paths**: `assert_not_paused()` is called in `lock`, `lock_multi`, `release`, `release_multi`, `refund_one`, and `claim_expired`. `assert_paused()` is called in `emergency_withdraw`.
- **Error**: `Paused` (#12) or `NotPaused` (#15) respectively.

---

## 3. Value Conservation

### I‑4: Contract balance equals sum of unsettled escrow amounts (excluding fees)
- **Statement**: For every escrow that is neither `released` nor `refunded`, the contract’s USDC balance must include the full `amount` of that escrow. Upon settlement (`release` / `refund` / `claim_expired`), the total transferred out (to seller + treasury or to buyer) equals the original `amount`.
- **Code paths**: This is a global invariant, not enforced by a single error. It is guaranteed by the transfer logic in `lock` (incoming), `release_one` (outgoing to seller and treasury), `refund_one` (outgoing to buyer), and `claim_expired` (outgoing to seller). The property tests check it via balance comparisons.
- **Error**: No direct error; failure would be a critical bug.

### I‑5: Release and refund are mutually exclusive
- **Statement**: For any escrow, at most one of `released` or `refunded` can be `true`. They must be mutually exclusive.
- **Code paths**: `release_one()` checks `if record.refunded`; `refund_one()` checks `if record.released`; `claim_expired()` checks both. Additionally, after a successful settlement, one flag is set to `true`, and no other settlement can occur.
- **Error**: `AlreadyReleased` (#6) or `AlreadyRefunded` (#7).

### I‑6: Settlement is exclusive – exactly one of release, refund, or claim_expired succeeds
- **Statement**: For a given escrow, only one of `release`, `refund`, or `claim_expired` can ever complete successfully. After that, the escrow is final.
- **Code paths**: The mutual-exclusion checks above ensure that once `released` or `refunded` is set, all other settlement calls fail. `claim_expired` also checks both flags.
- **Error**: `AlreadyReleased` / `AlreadyRefunded` as above.

---

## 4. Fee Invariants

### I‑7: Fee basis points are within the hard cap
- **Statement**: Any fee set (default, dataset, or in an escrow snapshot) must be ≤ `MAX_FEE_BPS` (2000 bps = 20%).
- **Code paths**: `assert_valid_fee()` is called in `initialize`, `set_default_fee`, `set_dataset_fee`. Also `resolve_fee_bps` reads existing values; they are guaranteed by earlier validation.
- **Error**: `InvalidFeeBps` (#4).

### I‑8: Fee calculation does not exceed the escrow amount
- **Statement**: The platform fee deducted from an escrow is always ≤ the escrow `amount`. The fee is calculated as `amount * fee_bps / 10_000`, with a floor of `1` stroop when `fee_bps > 0` and the arithmetic result would be zero.
- **Code paths**: `release_one()` and `claim_expired()` compute `calculated_cut` and apply the floor. The floor ensures that at most `amount` tokens are taken (when `fee_bps` is large, the calculation yields ≤ `amount`).
- **Error**: None; the logic ensures it.

### I‑9: Fee is snapshotted at lock time
- **Statement**: The `platform_fee_bps` stored in an `EscrowRecord` is determined when the escrow is created (from the dataset‑specific or default fee at that moment) and never changes afterwards, even if admin updates the fee configuration.
- **Code paths**: `lock()` and `lock_multi()` call `resolve_fee_bps()` and store the value in the record. Subsequent fee updates do not modify existing records.
- **Error**: No error; this is a consistency property.

---

## 5. Multi‑Escrow Operations (`lock_multi` / `release_multi`)

### I‑10: `lock_multi` transfers the exact sum of all shares
- **Statement**: The total USDC transferred from the buyer to the contract equals the sum of all `amount` fields in the `shares` vector.
- **Code paths**: `lock_multi()` accumulates `total_amount` and then calls `token_client.transfer` with that total.
- **Error**: No direct error; mismatch would be a bug. The property tests verify this.

### I‑11: `lock_multi` creates exactly one escrow per share
- **Statement**: The number of escrows created by `lock_multi` equals the length of the `shares` vector, and each escrow’s `amount` matches the corresponding share amount.
- **Code paths**: `lock_multi()` iterates over `shares` and creates a record for each; `EscrowCount` is incremented by `shares.len()`.
- **Error**: The function panics if `shares.len() != dataset_ids.len()` or if any share is invalid. Also `assert_valid_amount` and circuit breakers apply per escrow.

### I‑12: `release_multi` releases each escrow exactly once
- **Statement**: `release_multi()` calls `release_one()` for every escrow ID in the input vector, and each call respects all release invariants (mutual exclusivity, confirmation, dispute state).
- **Code paths**: `release_multi()` loops and invokes `release_one()`.
- **Error**: Any error from `release_one` is propagated.

---

## 6. Circuit Breakers

### I‑13: Per‑escrow amount cannot exceed the configured maximum
- **Statement**: Each `lock` or `lock_multi` share amount must be ≤ `MaxEscrowAmount` (admin‑set or default).
- **Code paths**: `check_amount_circuit_breaker()` is called from `lock` (for the single amount) and from `lock_multi` (for each share).
- **Error**: `AmountExceedsCircuitBreaker` (#13).

### I‑14: Number of escrows created per ledger cannot exceed the configured rate limit
- **Statement**: The total number of escrow records created in a single ledger (sum of single `lock` + all shares of `lock_multi`) must be ≤ `MaxEscrowsPerLedger` (admin‑set or default). The counter resets when the ledger sequence changes.
- **Code paths**: `check_rate_circuit_breaker_n()` is called from `lock` (with `n=1`) and `lock_multi` (with `n=shares.len()`). It reads `EscrowsThisLedger` and `LastEscrowLedger` to enforce the limit.
- **Error**: `RateLimitExceeded` (#14).

---

## 7. Dispute State Machine

### I‑15: Dispute can be raised only within the dispute window
- **Statement**: A buyer may call `raise_dispute` only if the current ledger sequence is ≤ the `dispute_deadline` stored in the escrow record (set at lock time as `lock_ledger + DISPUTE_WINDOW_LEDGERS`).
- **Code paths**: `raise_dispute()` checks `env.ledger().sequence() > record.dispute_deadline` and panics if true.
- **Error**: `DisputeDeadlinePassed` (#22).

### I‑16: A disputed escrow cannot be released or refunded normally
- **Statement**: While `disputed` is `true`, calls to `release_one` (via `release` or `release_multi`) and `refund_one` (via `refund`) must fail. Also `claim_expired` fails for disputed escrows.
- **Code paths**: `release_one()` checks `if record.disputed`; `refund_one()` does not check `disputed` directly (but `resolve_dispute` calls `refund_one` after clearing dispute), `claim_expired` checks `if record.disputed`. Normal `release` and `refund` are blocked.
- **Error**: `DisputedEscrow` (#24) for `release_one` and `claim_expired`; `refund_one` will be called only after dispute resolution, so it doesn't check.

### I‑17: Dispute resolution clears the dispute flag and performs exactly one settlement
- **Statement**: When `resolve_dispute` is called by the arbitrator, it either calls `refund_one` (if `favour_buyer`) or `release_disputed_one` (which forces `buyer_confirmed = true` and then calls `release_one`). In both cases, the `disputed` flag is cleared and the escrow becomes final (released or refunded).
- **Code paths**: `resolve_dispute()` sets `record.disputed = false` before calling the settlement function. `release_disputed_one` also sets `record.disputed = false` and `buyer_confirmed = true`.
- **Error**: `NotDisputed` (#25) if called on an escrow that is not disputed.

### I‑18: Only the arbitrator can resolve a dispute
- **Statement**: `resolve_dispute` requires the caller to be the current arbitrator address (or admin if arbitrator not set).
- **Code paths**: `resolve_dispute` calls `assert_arbitrator()`.
- **Error**: `NotArbitrator` (#23).

### I‑19: After dispute resolution, the escrow behaves as settled
- **Statement**: Once dispute is resolved, the escrow is either `released` or `refunded`, and both flags are mutually exclusive. Further attempts to call `release`, `refund`, `claim_expired`, or `raise_dispute` on that escrow fail.
- **Code paths**: The settlement functions enforce the mutual‑exclusion checks, and `raise_dispute` checks `released`/`refunded` and `disputed`.
- **Error**: `AlreadyReleased` / `AlreadyRefunded` / `AlreadyDisputed` as appropriate.

---

## 8. Buyer Confirmation

### I‑20: Release requires buyer confirmation (unless via dispute resolution)
- **Statement**: The admin can call `release` only if the buyer has called `confirm_delivery` (setting `buyer_confirmed = true`) and the escrow is not disputed. The only exception is when `resolve_dispute` forces `buyer_confirmed = true` via `release_disputed_one`.
- **Code paths**: `release_one()` checks `if !record.buyer_confirmed`.
- **Error**: `BuyerNotConfirmed` (#17).

### I‑21: Buyer confirmation cannot be reversed
- **Statement**: Once `buyer_confirmed` is set to `true`, it cannot be changed back. The only modifications to the record after confirmation are settlement‑related flags (`released`, `refunded`, `disputed`).
- **Code paths**: `confirm_delivery()` sets the flag and does not provide an un‑confirm function.
- **Error**: No error; it’s a state‑transition property.

---

## 9. Expiry / `claim_expired`

### I‑22: Claim expired is only possible after the deadline
- **Statement**: The seller may call `claim_expired` only when the current ledger timestamp is strictly greater than the `deadline` stored in the escrow record.
- **Code paths**: `claim_expired()` checks `env.ledger().timestamp() <= record.deadline`.
- **Error**: `NotExpired` (#20).

### I‑23: Claim expired fails if the escrow is disputed
- **Statement**: `claim_expired` cannot be called on an escrow that is currently disputed. The seller must wait for dispute resolution (or the buyer must not have raised a dispute).
- **Code paths**: `claim_expired()` checks `if record.disputed`.
- **Error**: `DisputedEscrow` (#24).

### I‑24: Claim expired withholds the platform fee
- **Statement**: When `claim_expired` succeeds, the seller receives `amount - fee`, and the fee remains in the contract (to be later withdrawn by admin via `emergency_withdraw`). The record is marked `released = true`.
- **Code paths**: `claim_expired()` computes the fee, transfers the seller’s share, and does **not** transfer the fee to treasury. This is documented in the function comment.
- **Error**: No error; it’s a design invariant.

---

## 10. Address Policy

### I‑25: Blacklisted addresses cannot participate in escrows
- **Statement**: If an address is blacklisted, it cannot be a buyer or seller in any `lock` or `lock_multi` operation.
- **Code paths**: `require_operational_address()` is called for buyer and seller in `lock` and for buyer and each seller in `lock_multi`. It checks `policy.blacklisted`.
- **Error**: `AddressBlacklisted` (#9).

### I‑26: Whitelist enforcement restricts participation to whitelisted addresses
- **Statement**: When `whitelist_enforced` is `true`, only addresses that have been explicitly whitelisted can act as buyers or sellers.
- **Code paths**: `require_operational_address()` checks `policy.whitelist_enforced && !policy.whitelisted`.
- **Error**: `AddressNotWhitelisted` (#10).

---

## 11. Data Consistency

### I‑27: Escrow records are identifiable and accessible
- **Statement**: Every escrow stored has a unique `escrow_id`, and `get_escrow` returns the record for any existing ID. Non‑existent IDs cause an error.
- **Code paths**: `read_escrow()` uses `env.storage().persistent().get()` and panics if not found.
- **Error**: `EscrowNotFound` (#8).

### I‑28: Dataset IDs are non‑empty
- **Statement**: All dataset IDs provided to `lock`, `lock_multi`, or fee‑management functions must be non‑empty strings.
- **Code paths**: `assert_valid_dataset_id()` checks `dataset_id.is_empty()`.
- **Error**: `EmptyDatasetId` (#11).

### I‑29: Lock amount meets the minimum
- **Statement**: Every escrow amount must be ≥ `MIN_LOCK_AMOUNT` (10,000 stroops = 0.001 USDC).
- **Code paths**: `assert_valid_amount()` checks `amount < MIN_LOCK_AMOUNT`.
- **Error**: `InvalidAmount` (#5).

---

## 12. Emergency Withdraw

### I‑30: Emergency withdraw requires the contract to be paused
- **Statement**: `emergency_withdraw` can be called only when `paused` is `true`. It is an admin‑only function that transfers arbitrary tokens from the contract to a destination address.
- **Code paths**: `emergency_withdraw()` calls `assert_paused()`.
- **Error**: `NotPaused` (#15) if the contract is not paused.

---

## Property‑Based Testing

All invariants listed above are candidates for inclusion in the fuzz test suite.  
The tests in `tests/fuzz/` will use this document as their reference model.

**Reviewers**: When accepting a PR that changes the contract, ensure that this document is updated to reflect any new invariants or modifications to existing ones.

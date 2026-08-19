# Hazina Escrow Contract

The Soroban contract now supports:

- A default platform fee plus dataset-specific fee overrides
- Admin-managed whitelist and blacklist controls for buyer and seller addresses
- An admin-controlled pause/unpause circuit breaker for emergencies
- An admin-only upgrade path for swapping the current WASM executable
- Invariant-focused verification tests that can be run independently
- Buyer-confirmed release flow and expiry-based seller claims
- `emergency_withdraw` for stuck tokens (admin-only, contract must be paused)

## Emergency withdrawal policy

`schedule_emergency_withdraw` / `execute_emergency_withdraw` / `cancel_emergency_withdraw` is an escape hatch for stuck assets and is intentionally constrained:

- Only the contract admin can propose the sweep (`schedule_emergency_withdraw`).
- The contract must be paused first — the admin's instant signal that something is wrong.
- The sweep is constrained to the configured treasury address; an arbitrary `to` address is rejected, so even a fully compromised admin key can only ever steer funds to the treasury.
- A mandatory timelock delay separates proposal from execution, giving buyers/sellers/observers a real window to notice a suspicious pending action (via the emitted `em_sched` event) before it takes effect.
- Anyone may execute the sweep once the timelock has elapsed and the contract is still paused (the emergency has not been stood down).
- The admin may cancel a proposed sweep at any time before execution.
- Every execution emits an `em_exec` event with `(token, to, amount)`.

## Input validation

`lock()` now rejects invalid inputs early:

- `amount` must be greater than zero
- `dataset_id` must not be empty
- the token address must resolve to a valid token contract
- buyer and seller must be different addresses
- seller must not be the contract address placeholder used for invalid addresses

These checks fail before any transfer is attempted, which keeps contract state and balances consistent.

## Upgrades

The contract exposes admin-only `schedule_upgrade(admin, new_wasm_hash)` entrypoint that proposes a contract WASM swap, followed by `execute_upgrade()` (callable by anyone after the timelock has elapsed) or `cancel_upgrade(admin)` to abort. This gives all users a real window to observe a pending upgrade before it can take effect.

Upgrade flow:

1. Build and upload the new contract Wasm to Stellar.
2. Capture the returned Wasm hash.
3. Call `schedule_upgrade(admin, new_wasm_hash)` from the current admin address — the hash is now public and immutable until execution.
4. After the timelock has elapsed, anyone may call `execute_upgrade()` to deploy the new WASM via Soroban's `update_current_contract_wasm`, or the admin may call `cancel_upgrade()` to abort.
5. Verify the deployment by re-reading the existing escrow state.

Non-admin callers are rejected at the `schedule_upgrade` step. The timelock ensures no surprise upgrades take effect without observable lead time.

## Verification scripts

From the repository root:

```sh
npm run contracts:check
npm run contracts:formal
```

`contracts:check` runs formatting, clippy, the full Rust test suite, and a release wasm build.

`contracts:formal` runs the invariant-oriented tests whose names start with `formal_`.

## Property-based invariant suite

```sh
cargo test                                     # examples only, sub-second gate
cargo test --features fuzz-tests --test fuzz   # the invariant suite
```

The suite lives in `tests/fuzz/` and fuzzes the money-moving paths against the
invariants specified in [`docs/INVARIANTS.md`](../../docs/INVARIANTS.md). The
target declares `required-features = ["fuzz-tests"]`, so a plain `cargo test`
does not build it. Case budgets, regression seeds and the cross-language fee
fixture are covered in [`docs/FUZZING.md`](../../docs/FUZZING.md).

## Integration Tests (Stellar Testnet)

These tests run against the real Stellar testnet. They are ignored by default.

### Setup

1.  **Fund accounts**: Create and fund three accounts on testnet (Admin, Buyer, Seller). You can use the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator).
2.  **USDC Trustlines**: Ensure the Buyer and Seller accounts have trustlines for USDC on testnet (`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`).
3.  **Fund Buyer with USDC**: Send some testnet USDC to the Buyer account.
4.  **Configure Env**: Copy `contracts/hazina-escrow/.env.test` and fill in the real secrets and contract ID.

### Running

From `contracts/hazina-escrow`:

```sh
cargo test -- --ignored
```

Or specific test:

```sh
cargo test integration_lock_and_release -- --ignored
```


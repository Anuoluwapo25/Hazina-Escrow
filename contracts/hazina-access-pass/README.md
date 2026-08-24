# hazina-access-pass

Soroban subscription access-pass contract for Hazina datasets. A buyer
subscribes to a dataset for a seller-defined plan, pays the plan price plus a
platform fee through the escrow custody flow, and receives time-boxed access
that survives as long as the subscription is kept alive.

Spec and stage plan: `docs/ACCESS_PASS_PLAN.md`.

## Model

- **Plans** are defined per `(seller, dataset_id)` by the seller:
  price per period, period length in seconds, seat cap.
- **Passes** are held per `(buyer, dataset_id)`. One pass per buyer per
  dataset; resubscribing after expiry reuses the same record.
- **Custody**: payment flows through the configured `hazina-escrow` contract
  (`lock` on subscribe/renew, release paths on revoke/settle). The pass
  contract never holds tokens itself; it only orchestrates escrow calls.
- **Fees**: at charge time the contract reads the live fee config (#551)
  from the escrow contract via cross-contract call and applies the same
  floor rule. No fee state is duplicated here; lookup failure fails closed.

## Lifecycle

| Action | Who | Effect |
| --- | --- | --- |
| `define_plan` | seller | Registers plan, returns `plan_id`. |
| `subscribe` | buyer | Charges first period via escrow lock, mints pass, takes a seat. |
| `renew` | buyer | Extends an active (non-revoked, non-expired) pass one period. |
| `revoke` | admin or seller | Settles the unused remainder pro rata and frees the seat. |
| `settle_expired` | anyone | Permissionless settlement once `expires_at` passes. |

Access checks are pure reads: `has_access(buyer, dataset_id)` returns true iff
a non-revoked pass exists with `expires_at > ledger timestamp`.

## Guarantees

- Custody is conserved: every stroop charged is later paid out exactly once,
  across subscribe/renew/revoke/settle interleavings. Enforced by the
  property suite in `tests/fuzz/lifecycle.rs`.
- Revoked passes cannot be renewed or re-settled (`PassNotFound`).
- Empty/malformed dataset ids are rejected on writes and are total-no-op
  reads (`has_access` returns false, never traps).
- Instance + persistent entries are bump-extended on every write and read so
  live passes never fall out of storage while subscribed.

## Errors

Numbered from 1 on the `HazinaAccessPassError` enum; see `src/lib.rs` for the
authoritative list (`AlreadyInitialized` ... `NothingToSettle`). Contract
panics use `panic_with_error!`, matching `hazina-escrow` conventions.

## Development

```sh
rustup target add wasm32v1-none

cargo test --manifest-path Cargo.toml          # gate tests
cargo test --features fuzz-tests --test fuzz   # property/invariant suite
cargo clippy --all-targets -- -D warnings
cargo build --release --target wasm32v1-none   # wasm artifact
```

Or run both contracts' full gate from the repo root:

```sh
sh scripts/contracts/checks.sh
```

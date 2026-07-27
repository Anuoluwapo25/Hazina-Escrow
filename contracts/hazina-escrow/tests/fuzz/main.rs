//! Property-based invariant suite for the Hazina escrow contract.
//!
//! Gated behind the `fuzz-tests` feature so the default `cargo test` stays a
//! sub-second gate. Run it with:
//!
//! ```text
//! cargo test --features fuzz-tests --test fuzz
//! PROPTEST_CASES=1024 cargo test --features fuzz-tests --test fuzz
//! ```
//!
//! Every property here maps to a numbered invariant in `docs/INVARIANTS.md`.
//! Failing seeds are persisted under `proptest-regressions/` and are meant to
//! be committed — see `docs/FUZZING.md`.
//!
//! The target declares `required-features = ["fuzz-tests"]` in `Cargo.toml`,
//! so a plain `cargo test` skips building it entirely.

mod harness;

mod conservation;
mod fee_bounds;
mod lock_multi;
mod settlement;

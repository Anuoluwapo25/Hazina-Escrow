//! Property-based lifecycle suite for the Hazina access-pass contract.
//!
//! Gated behind the `fuzz-tests` feature so the default `cargo test` stays a
//! sub-second gate. Run it with:
//!
//! ```text
//! cargo test --features fuzz-tests --test fuzz
//! PROPTEST_CASES=1024 cargo test --features fuzz-tests --test fuzz
//! ```
//!
//! The properties mirror the numbered boundary behaviors in
//! docs/ACCESS_PASS_PLAN.md §5: value conservation across subscribe / renew /
//! revoke / settle_expired sequences, `has_access` matching its documented
//! predicate at all times, and seat accounting that never drifts from state.
//! Failing seeds are persisted under `proptest-regressions/` and are meant to
//! be committed — see docs/FUZZING.md in hazina-escrow for the runbook.
//!
//! The target declares `required-features = ["fuzz-tests"]` in `Cargo.toml`,
//! so a plain `cargo test` skips building it entirely.

mod harness;

mod lifecycle;

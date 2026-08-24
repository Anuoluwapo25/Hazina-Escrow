#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"

# All contract crates to lint, test, and build.
CONTRACT_CRATES="hazina-escrow hazina-seller-bond hazina-access-pass"

if ! rustup target list --installed | grep -q '^wasm32v1-none$'; then
  echo "Missing Rust target wasm32v1-none. Install it with: rustup target add wasm32v1-none" >&2
  exit 1
fi

for crate in $CONTRACT_CRATES; do
  CONTRACT_DIR="$ROOT_DIR/contracts/$crate"
  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  $crate"
  echo "══════════════════════════════════════════════════════════════════"

  echo "Running cargo fmt --check"
  cargo fmt --manifest-path "$CONTRACT_DIR/Cargo.toml" --all -- --check

  echo "Running cargo clippy"
  cargo clippy --manifest-path "$CONTRACT_DIR/Cargo.toml" --all-targets -- -D warnings

  echo "Running cargo test"
  cargo test --manifest-path "$CONTRACT_DIR/Cargo.toml"

  echo "Building release wasm artifact"
  cargo build --manifest-path "$CONTRACT_DIR/Cargo.toml" --release --target wasm32v1-none
done

echo ""
echo "All contract crates passed."

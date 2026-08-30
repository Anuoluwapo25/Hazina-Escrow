#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CONTRACTS="hazina-escrow hazina-access-pass"

for contract in $CONTRACTS; do
  CONTRACT_DIR="$ROOT_DIR/contracts/$contract"

  echo ""
  echo "═══════════════ $contract ═══════════════"
  echo "Running invariant-oriented contract checks"
  cargo test --manifest-path "$CONTRACT_DIR/Cargo.toml" formal_
done

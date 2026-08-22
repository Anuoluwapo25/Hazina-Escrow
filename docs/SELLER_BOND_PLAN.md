# Seller quality bonds — implementation plan

Spec: [Hazina-Escrow/Hazina-Escrow#591](https://github.com/Hazina-Escrow/Hazina-Escrow/issues/591).
Branch: `feature/seller-bond-contract`. Status: plan for review, nothing implemented yet.

A new Soroban contract (`contracts/hazina-seller-bond/`) where sellers post a USDC
quality bond, earn a derived trust tier (Bronze/Silver/Gold), and get slashed when
an arbitrator resolves an escrow dispute against them. Slashed funds pay the
wronged buyer directly.

---

## 0. Conventions the new code must match (from the audit)

**Contract** (`contracts/hazina-escrow/src/lib.rs`, 2516 lines):

- One `#[contracterror]` enum, discriminants from 1, raised with `panic_with_error!`. Tests assert `"Error(Contract, #N)"` strings.
- Events are raw tuples: `env.events().publish((symbol_short!("xxx"),), payload)`, symbols at most 9 chars.
- Storage split: `instance()` for config/counters, `persistent()` for per-entity records. Hot-path persistent reads bump TTL via `extend_ttl(ESCROW_MIN_TTL, ESCROW_BUMP_LEDGERS)` (lib.rs:622-626, lib.rs:864-868).
- Constants are `pub` with doc comments on purpose: the fuzz harness derives input strategies and expected-value models from them so tests and contract cannot disagree about a boundary (lib.rs:13-16).
- Timelocked admin actions use schedule/execute/cancel triads over single pending slots through shared `store_pending` / `read_pending` / `remove_pending` helpers (lib.rs:1179-1201).
- Disputes: buyer-only `raise_dispute` with a `BytesN<32>` evidence hash and window `lock_seq + DISPUTE_WINDOW_LEDGERS`; `resolve_dispute` is callable by the configured arbitrator, falling back to admin when unset (lib.rs:845-859); a ruling routes onto the normal refund/release paths.

**Test lanes** (two budgets, per CLAUDE.md):

| Lane | Where | Run by |
|---|---|---|
| Gate | unit tests in `lib.rs::tests` + `tests/unit.rs` + `tests/integration.rs` | `scripts/contracts/checks.sh`: fmt --check, clippy `-D warnings`, cargo test, wasm32v1-none release build |
| Formal | tests named `formal_*` inside `lib.rs` | `npm run contracts:formal` → `scripts/contracts/formal-checks.sh` runs `cargo test formal_` |
| Periodic evals | `tests/fuzz/` proptest suite behind the `fuzz-tests` feature (`[[test]] required-features`, Cargo.toml:20-30) | `contract-fuzz.yml`: 512 cases per PR, 4096 nightly |

Fuzz suite house style (`tests/fuzz/`): a `World` harness building one fresh env per case (`bare_env` disables snapshot-at-drop and raises TTL bounds), strategies derived from the contract's pub constants, expected-value math in one place in `harness.rs`, seeds persisted to `proptest-regressions/<module>.txt` with `FileFailurePersistence::Direct`, every property tagged with an invariant ID from `docs/INVARIANTS.md`, known-but-undesired behaviour pinned as "asymmetries".

**Backend**: Express 4. Hand-written wrapper module `backend/src/lib/escrow.client.ts` (exported async functions, no codegen), ScVal helpers centralized in `backend/src/lib/scval.ts`, env/config in `backend/src/lib/stellar.config.ts` (`getEscrowContractId()`, fail-fast `validateEscrowConfig()` at `main.ts:13`). Error translation mirrors contract panic codes in `CONTRACT_ERROR_MESSAGES` plus a regex on `Error(Contract, #N)` (`extractContractErrorCode`, escrow.client.ts:90). All RPC goes through the `'soroban-rpc'` circuit breaker. Admin-signed calls use `callContract` (`backend/src/agent/agent.wallet.ts:159-219`); buyer-signed flows build unsigned XDR for wallet signing (`buildBuyerSignedCall`, escrow.client.ts:441-467). Routers follow `payments/escrow.router.ts`: zod schemas + `validateBody`, `requireAdminKey`, `ensureContract` returning 503 when unconfigured (:96-107).

**Frontend**: Vite + React + Tailwind. Central API client `frontend/src/lib/api.ts` (escrow endpoints at :615-667), flow helpers `frontend/src/lib/escrow.ts` (build -> wallet signs -> backend submits), i18n messages maintained in en/fr/es/sw.

**CI gap found**: both `scripts/contracts/checks.sh` and `formal-checks.sh` hardcode
`CONTRACT_DIR=contracts/hazina-escrow`, and `contract-fuzz.yml` jobs pin
`working-directory: contracts/hazina-escrow`. None of them would see a second
crate. Wiring the new crate into these three places is part of this feature, not
a follow-up.

---

## 1. Design decisions needing a call before implementation

### D1 — how the bond contract learns "this seller has an open dispute"

#591's non-negotiable: stake earmarked for an open dispute cannot be withdrawn.

- **Option A (recommended)**: the escrow contract maintains an O(1) counter
  `OpenDisputesBySeller(Address) -> u32`, incremented in `raise_dispute`,
  decremented wherever a disputed escrow settles (`refund_one`,
  `release_disputed_one`) or the flag clears. The bond contract stores the escrow
  address at init and does a cross-contract read in `request_unstake`, rejecting
  while the count is positive.
  - Cost: a small audited change to the escrow contract plus one timelocked
    `upgrade` on testnet before the bond contract goes live.
  - Benefit: pull-based; no new failure path inside money-settling calls; the UI
    gets an "open disputes" signal for free without iterating escrows.
- **Option B**: push-based — escrow calls `lock_for_dispute` / `unlock_for_dispute`
  on the bond contract from raise/resolve. Rejected: couples settlement to a
  second contract's availability; a bug in the bond crate would revert dispute
  resolution in the escrow.
- **Option C**: no linkage; rely on the unstake cooldown alone. Rejected:
  violates the issue's stated safety property outright.

Deviation to sign off under Option A: issue table shows
`init(admin, token, arbitrator, cooldown_secs)`; we need one more parameter,
`escrow_contract: Address`, for the cross-contract read. Flagged in the PR.

### D2 — slash bound

`slash(arbitrator, seller, escrow_id, bps, beneficiary)` rejects
`bps == 0 || bps > MAX_SLASH_BPS`. Proposal: `MAX_SLASH_BPS = 2_000` (20 % per
incident), matching the existing `MAX_FEE_BPS` ceiling idiom. A repeat offender
bleeds 20 % per lost dispute instead of being zeroed by a single call.

### D3 — tier thresholds

Tiers are derived in `get_bond`, never stored (issue requirement). Proposal,
USDC has 7 decimals:

| Tier | Staked >= | Stroops |
|---|---|---|
| None | 0 | 0 |
| Bronze | 100 USDC | 1_000_000_000 |
| Silver | 500 USDC | 5_000_000_000 |
| Gold | 2_500 USDC | 25_000_000_000 |

Published as consts (`TIER_BRONZE_MIN`, `TIER_SILVER_MIN`, `TIER_GOLD_MIN`) so
the fuzz harness and the frontend derive from the same numbers.

---

## 2. Contract design: `contracts/hazina-seller-bond/`

New crate mirroring hazina-escrow: single-file `src/lib.rs`, `#![no_std]`,
`soroban-sdk = 22`, `crate-type = ["cdylib", "rlib"]`, same release profile
(`overflow-checks = true`, LTO), `fuzz-tests` feature + `[[test]]` fuzz target
with `required-features`.

### Storage (`DataKey`)

```
Initialized, Admin, Token, Arbitrator, EscrowContract, CooldownSecs
Bond(Address)            -> BondRecord
SlashedEscrow(u64)       -> ()   // idempotency marker keyed by escrow id
```

```rust
pub struct BondRecord {
    staked: i128,
    pending_unstake: i128,
    cooldown_ends: u64,      // 0 while no unstake request is open
    slashed_total: i128,
    slash_count: u32,
}
pub struct Bond {              // public getter shape, per issue
    staked: i128,
    pending_unstake: i128,
    cooldown_ends: u64,
    slash_count: u32,
    slashed_total: i128,
    tier: Tier,                // derived here, never stored
}
pub enum Tier { None, Bronze, Silver, Gold }
```

### Errors (`HazinaBondError`, from 1)

`AlreadyInitialized`, `NotInitialized`, `NotAdmin`, `NotArbitrator`,
`InvalidAmount`, `InvalidCooldown`, `InvalidSlashBps`, `NothingStaked`,
`InsufficientStake` (request exceeds `staked - pending_unstake`),
`UnstakeAlreadyPending` (single-slot rule, mirroring `PendingActionExists`),
`CooldownNotElapsed`, `OpenDisputeBlocksUnstake`, `AlreadySlashed`.

### Entry points

| Function | Caller | Behaviour |
|---|---|---|
| `init(admin, token, arbitrator, escrow_contract, cooldown_secs)` | deployer | One-time; `Initialized` written first (lib.rs:239-256 pattern); validates `MIN_COOLDOWN_SECS <= cooldown_secs <= MAX_COOLDOWN_SECS` (proposed 1 h .. 365 d) |
| `stake(seller, amount)` | seller | `require_auth` on seller; token transfer in; additive; emits `staked` |
| `request_unstake(seller, amount)` | seller | Rejects if `amount > staked - pending_unstake`, if a request is already pending, or if the escrow reports open disputes for this seller (D1-A). Sets `pending_unstake += amount`, `cooldown_ends = now + cooldown`. Stake stays fully slashable during cooldown |
| `withdraw(seller)` | seller | Requires `now >= cooldown_ends`; pays `min(pending_unstake, staked)` (a slash may have shrunk it); clears the slot; emits `withdrew` |
| `slash(arbitrator, seller, escrow_id, bps, beneficiary)` | arbitrator | Auth against stored arbitrator; rejects reused `escrow_id` (`AlreadySlashed`) and out-of-range `bps`; `cut = min(staked, max(1, staked * bps / MAX_BASIS_POINTS))` when `bps > 0` (same floor idiom as the fee math); transfers cut to beneficiary; bumps counters; emits `slashed` |
| `set_arbitrator(admin, arbitrator)` | admin | Keeps the bond's arbitrator copy rotatable when the escrow rotates theirs; emits `arbit_set` |
| `get_bond(seller) -> Bond` | anyone | Read-only; derives tier from current `staked` |
| `has_open_unstake(seller) -> bool`, `is_slashed(escrow_id) -> bool` | anyone | Cheap read helpers for backend/UI |

Events (all `symbol_short!`): `staked`, `unstk_req`, `withdrew`, `slashed`, `arbit_set`.

### Escrow-side change (Option A)

In `contracts/hazina-escrow/src/lib.rs`:

- New key `DataKey::OpenDisputesBySeller(Address)`.
- Increment in `raise_dispute` (after all guards pass), decrement wherever
  `disputed` transitions to false: `refund_one` (lib.rs:884-885),
  `release_disputed_one` (lib.rs:898).
- New read-only `open_disputes_for(env, seller) -> u32`.
- Counter updates ride existing TTL discipline; no math changes, so I1-I24 stay
  intact. INVARIANTS.md gains a note that this counter exists and what maintains
  it.

### Invariants (new `B` section in docs/INVARIANTS.md)

- **B1 conservation**: tokens deposited == outstanding staked + paid-out slashes + withdrawals, at every step.
- **B2 slashability**: stake remains slashable during cooldown and until actually withdrawn.
- **B3 withdrawal gating**: `withdraw` fails before `cooldown_ends`; pays at most the requested amount; a rejected call moves nothing.
- **B4 idempotency**: the same `escrow_id` can be slashed exactly once; second attempt reverts with `AlreadySlashed` and moves nothing.
- **B5 bounds**: `0 < bps <= MAX_SLASH_BPS` enforced everywhere; rejected slash leaves state untouched.
- **B6 clamp**: a slash never pays more than currently staked.
- **B7 pure tiers**: tier is a pure function of current `staked`; nothing else moves it.
- **B8 dispute lock**: `request_unstake` fails while the escrow reports open disputes for the seller; succeeds after they resolve.
- **B9 failed calls move no value**, for every entry point.

---

## 3. Test plan

- **Gate** (`lib.rs::tests`): init-once; init validation bounds; stake adds and transfers in; request_unstake accounting incl. `InsufficientStake` and double-request rejection; withdraw boundary at exactly `cooldown_ends` (both sides of the edge, like `state_machine::dispute_window_is_enforced`); withdraw-after-mid-cooldown-slash pays the shrunken amount; non-arbitrator/non-admin/non-seller rejections with exact `Error(Contract, #N)` assertions.
- **Formal** (`formal_*` prefix, picked up by `contracts:formal`):
  - `formal_bond_conserves_total_value` across a fixed multi-step sequence (stake, unstake request, slash, withdraw).
  - `formal_dispute_locked_stake_cannot_be_withdrawn`: raise a real dispute in the escrow world, assert `request_unstake` fails with `OpenDisputeBlocksUnstake`, resolve, assert it then succeeds. This is the acceptance-criteria proof.
- **Periodic evals** (`tests/fuzz/` in the new crate, same harness style):
  - `harness.rs` clone: `BondWorld` (bond contract + token + optionally a full escrow world for B8), strategies from the pub consts, expected-value model for the slash math, `proptest-regressions/bond-*.txt` persistence, `DEFAULT_CASES = 48`.
  - Properties tagged B1-B9. The conservation property drives randomized sequences of stake/request/slash/withdraw and asserts the running balance identity after every step, mirroring `conservation.rs`'s mixed-settlement property.
- **CI/scripts wiring**:
  - `scripts/contracts/checks.sh` and `formal-checks.sh`: loop over both crates.
  - `.github/workflows/contract-fuzz.yml`: gate job builds/tests both crates; fuzz job gains the bond suite (separate step or matrix entry); regression-seed upload path extended.

---

## 4. Backend

- `backend/src/lib/bond.client.ts`, shaped like `escrow.client.ts`:
  - Reads via simulation: `getBond(seller)`, decoded through new ScVal helpers in `backend/src/lib/scval.ts` (bond record struct decoder next to `decodeEscrowRecord`).
  - Seller-signed builders: `buildStakeTx`, `buildRequestUnstakeTx`, `buildWithdrawTx` following the `buildBuyerSignedCall` XDR pattern.
  - Admin/arbitrator call: `slashSeller(...)` via `callContract` from `backend/src/agent/agent.wallet.ts`.
  - `BOND_ERROR_MESSAGES` mirror table for the new error enum, wired through the same `extractContractErrorCode` translation path; RPC wrapped in the `'soroban-rpc'` circuit breaker.
- `backend/src/lib/stellar.config.ts`: `getBondContractId()` reading `BOND_CONTRACT_ID`. Bond config stays optional in `validateEscrowConfig` so deploys without the bond contract still boot; bond endpoints return 503 via the `ensureContract` pattern.
- Wire slashing into the payments service path that calls `resolveDispute(favour_buyer = false)` today: after a successful resolution against a seller, look up the buyer and call `slashSeller(arbitrator, seller, escrowId, SLASH_BPS, buyer)`. Slash failure logs and surfaces in monitoring but does not roll back the settlement (the escrow ruling is already final); a retry is safe because slash is idempotent per escrow id.
- Routes in a new `backend/src/payments/bond.router.ts` (or appended to `escrow.router.ts` if reviewers prefer one payments surface): `GET /payments/bond/:seller` public read; `POST /payments/bond/stake/build|submit`, `/unstake/build|submit`, `/withdraw/build|submit` following the zod + `validateBody` conventions.
- Tests alongside: `bond.client.test.ts` + router tests, mirroring the existing colocated test style.

## 5. Frontend

- `frontend/src/lib/api.ts`: `getBond(seller)` endpoint next to the escrow block (:615-667).
- `frontend/src/lib/bond.ts`: seller-side stake/unstake/withdraw flows (build -> wallet signs -> submit), mirroring `frontend/src/lib/escrow.ts`; a `tierLabel(tier)` helper alongside `escrowStatusLabel`.
- `TrustBadge` component: tier chip, staked amount, slash count, link to the bond contract on Stellar Expert. Plain "no bond posted" state shown honestly rather than hidden (issue requirement).
- Dataset detail page renders `TrustBadge`; marketplace gains an optional "bonded sellers only" filter (issue marks it optional; ship it behind the badge work if cheap).
- i18n keys added to en/fr/es/sw message files.
- vitest coverage for `bond.ts` flow logic and badge state mapping, mirroring `escrow.test.ts`.

## 6. Docs

- `docs/SELLER_BONDS.md`: tiers table, slashing rules, cooldown mechanics, the dispute-lock rule, known asymmetries (e.g. arbitrator copy staleness window between escrow rotation and bond rotation).
- `docs/INVARIANTS.md`: new `B` section (B1-B9) plus the note on the escrow's `OpenDisputesBySeller` counter.
- `docs/FUZZING.md`: runbook line for the bond suite (case budget, seed paths).

---

## 7. Build order (each step lands green on its own)

1. **Crate skeleton**: `contracts/hazina-seller-bond/` with Cargo.toml, `init`, `stake`, `get_bond`, tier derivation; unit tests; scripts still escrow-only.
2. **Cooldown lifecycle**: `request_unstake`, `withdraw`, single-slot rule, boundary tests.
3. **Slash**: idempotency marker, bounds, clamp, floor math, `set_arbitrator`; typed-error tests.
4. **Formal + fuzz lanes**: `formal_*` tests, `tests/fuzz/` suite, INVARIANTS `B` section.
5. **Escrow counter change**: `OpenDisputesBySeller`, `open_disputes_for`, bond-side `OpenDisputeBlocksUnstake` check, formal dispute-lock proof; update scripts/CI to cover both crates.
6. **Backend**: config + `bond.client.ts` + router + slash hook in the resolve path + tests.
7. **Frontend**: api + `bond.ts` + `TrustBadge` + marketplace filter + i18n + tests.
8. **Docs finish + testnet walkthrough**: deploy escrow upgrade then bond contract, record stake -> dispute -> resolve-for-buyer -> slash-pays-buyer -> tier-drop walkthrough in the PR (acceptance criteria in #591).

Steps 6 and 7 are parallelizable once the contract interface freezes at step 5.

## 8. Acceptance criteria mapping (#591)

| Issue requirement | Covered by |
|---|---|
| New crate matching escrow idioms | Section 2; audit conventions section 0 |
| Cooldown accounting distinguishing staked / pending / locked | `BondRecord` fields + B2/B3/B8 |
| Rust tests for every invariant | Section 3 gate + formal lists |
| Property/fuzz: total value in == staked + slashed + withdrawn | B1 conservation property |
| Backend `bond.client.ts` with display reads + resolve-time slash | Section 4 |
| Marketplace/detail UI: badge, staked amount, slash history, Stellar Expert link, honest no-bond state | Section 5 |
| Optional bonded-sellers filter | Section 5 (flagged optional) |
| `docs/SELLER_BONDS.md` | Section 6 |
| Stake earmarked for an open dispute cannot be withdrawn | D1-A + `formal_dispute_locked_stake_cannot_be_withdrawn` |
| Double slash on one escrow reverts with typed error | B4 + `AlreadySlashed` |
| Testnet walkthrough in PR | Step 8 |
| `contracts:check` and `contracts:formal` green | Scripts extended in step 5 |

## Decisions (locked)

1. **D1 — Dispute linkage:** Option A adopted. Escrow maintains `OpenDisputesBySeller(Address) -> u32` counter; bond pulls it cross-contract in `request_unstake`. `escrow_contract: Address` added as a param to `init`.
2. **D2 — Slash bounds:** `MAX_SLASH_BPS = 2_000` (20 %). Backend default slash: `SLASH_BPS = 1_000` per incident (half the cap).
3. **D3 — Tier thresholds:** Bronze >= 100 USDC (1_000_000_000 stroops), Silver >= 500 USDC (5_000_000_000), Gold >= 2_500 USDC (25_000_000_000). USDC has 7 decimals.

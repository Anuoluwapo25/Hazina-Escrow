# Dataset Subscription Access Pass — Implementation Plan

Branch: `feature/access-pass-contract` (off `main` @ `1eabd78`, fork synced with upstream).
Issue: Dataset Subscription Access Pass. New crate `contracts/hazina-access-pass/` plus backend and UI integration.
Status: APPROVED. All four blocking decisions resolved (see §11). Stage 1 (contract + tests) DONE. Stage 2 (backend + UI integration) DONE — see §9 for the stage 2 completion note.

---

## 0. Audit summary (what the new code must match)

| Area               | Source of truth                                            | What the new work copies                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract layout    | `contracts/hazina-escrow/src/lib.rs`                       | `#![no_std]`, `// ─── Section ───` headers, `pub const` with doc comments for test-visible constants, `panic_with_error!` everywhere, `require_auth()` before `assert_*` helpers                                                                               |
| Errors             | `HazinaEscrowError` (lib.rs:104)                           | `#[contracterror]` enum, explicit discriminants from 1, tests assert `"Error(Contract, #N)"`                                                                                                                                                                   |
| Storage split      | lib.rs:60-98                                               | Instance storage: init flag, admin, counters, config. Persistent storage: per-entity records. TTL bumps on every write AND in read getters (`get_escrow`, lib.rs:1127)                                                                                         |
| TTL idiom          | lib.rs:19-22, 622-626                                      | `extend_ttl(key, MIN_TTL, BUMP_LEDGERS)` = `(17_280, 518_400)` (~24h floor, ~60d bump)                                                                                                                                                                         |
| Fee model (#551)   | lib.rs:283-355, 1259-1264                                  | Default fee in instance storage (default 500 bps), per-dataset override in persistent storage, `MAX_FEE_BPS = 2_000`, effective = override or default, 1-stroop fee floor on settlement (lib.rs:932-939)                                                       |
| Events             | throughout lib.rs                                          | `env.events().publish((topic,), payload)`; one event per state change                                                                                                                                                                                          |
| Tests              | lib.rs:1388+ inline module                                 | `setup()` helper (mock auths, raised TTLs, minted USDC), `#[should_panic(expected = "Error(Contract, #N)")]`, `formal_` prefix for invariant tests                                                                                                             |
| Fuzz suite         | `contracts/hazina-escrow/tests/fuzz/`                      | proptest behind `fuzz-tests` feature + `required-features`, committed regressions, harness with raised-TTL `bare_env()`                                                                                                                                        |
| Backend client     | `backend/src/lib/escrow.client.ts`                         | Read-only sim via `rpc.simulateTransaction` (no signing), shared `'soroban-rpc'` circuit breaker, panic-code to sanitized message map (`CONTRACT_ERROR_MESSAGES`), unsigned-XDR builders for buyer-signed calls, scval helpers from `backend/src/lib/scval.ts` |
| Contract ID config | `backend/src/lib/stellar.config.ts:33-62`                  | Per-call env reads, `getXContractId()` throws naming the missing env var, startup validation                                                                                                                                                                   |
| Frontend           | `frontend/src/pages/SellPage.tsx`, `DatasetDetailPage.tsx` | lucide icons, `clsx`, `useI18n()` catalog, Toast system, react-query (`useQuery` with `queryKey`), badges as `type-badge` spans (`border-emerald-400/30 bg-emerald-400/10 text-emerald-400`), cards as `glass-card`, CTAs as `btn-gold`                        |

### CI gaps found (same class of gap as seller-bond)

A new crate is invisible to every contract check today because all of them hardcode `hazina-escrow`:

1. `scripts/contracts/checks.sh` and `scripts/contracts/formal-checks.sh`: `CONTRACT_DIR="$ROOT_DIR/contracts/hazina-escrow"`.
2. `.github/workflows/ci.yml`: `contract` job and `contract-artifacts` job use `working-directory: contracts/hazina-escrow`.
3. `.github/workflows/contract-fuzz.yml`: all three jobs (`gate`, `fuzz`, plus cache config) target only `contracts/hazina-escrow`.
4. `.prettierignore` lists `contracts/hazina-escrow/target` and `contracts/hazina-escrow/Cargo.lock` explicitly.
5. `.gitignore` ignored only root `/target`. **Already fixed on this branch** (added `**/target/`; verified nothing tracked lives under any `target/`). The stray untracked `contracts/hazina-seller-bond/target/` build cache from the other branch no longer shows in status.

---

## 1. Crate structure

```
contracts/hazina-access-pass/
├── Cargo.toml          # mirrors hazina-escrow/Cargo.toml
└── src/
    └── lib.rs          # single file, same section order as hazina-escrow/src/lib.rs
```

`Cargo.toml` differences from escrow: package name/version only. Same deps (`soroban-sdk = { version = "22.0.0", features = ["alloc"] }`, dev-deps `testutils` + `proptest`), same `[features] fuzz-tests = []`, same `[profile.release]` block (`opt-level = "z"`, `overflow-checks = true`, `lto = true`, `panic = "abort"`). Crates are standalone (no workspace Cargo.toml at `contracts/` level; checks.sh drives each crate via `--manifest-path`), so the new crate needs no parent manifest change.

`lib.rs` section order (matches escrow): Constants → Storage keys → Errors → Types → Contract impl → Unit tests (`mod tests`) → Fuzz module (`#[cfg(all(test, feature = "fuzz-tests"))] mod fuzz_tests`).

---

## 2. Storage design

### Keys

```rust
#[contracttype]
pub enum DataKey {
    Initialized,               // instance — re-init guard, written first
    Admin,                     // instance
    Treasury,                  // instance — optional, falls back to admin
    Token,                     // instance — payment token (SAC address)
    EscrowContract,            // instance — escrow contract address for fee lookups
    PlanCount,                 // instance — u64 counter, plans assigned from 0
    SeatsUsed(u64),            // persistent — active seats per plan_id
}

#[contracttype]
pub enum PlanKey {
    Record(u64),               // persistent — PlanRecord
}

#[contracttype]
pub enum PassKey {
    Holder(Address, String),   // persistent — keyed by (buyer, dataset_id)
}
```

One pass per `(buyer, dataset_id)` pair, per the issue. A resubscribe after expiry or revoke overwrites the same key in place.

### Records

```rust
pub struct PlanRecord {
    pub plan_id: u64,
    pub seller: Address,
    pub dataset_id: String,
    pub price_per_period: i128,
    pub period_seconds: u64,
    pub max_seats: u32,
    pub active: bool,
}

pub struct PassRecord {
    pub plan_id: u64,
    pub buyer: Address,
    pub dataset_id: String,
    pub start: u64,              // current term start (unix seconds)
    pub expiry: u64,             // current term expiry (unix seconds)
    pub term_period_seconds: u64,// length of CURRENT term; snapshot for pro-rata math that survives plan edits
    pub amount_paid: i128,       // stroops paid for the current term
    pub fee_bps: u32,            // fee snapshotted at payment time (same rule as escrow's platform_fee_bps at lock, lib.rs:1682-1703)
    pub revoked: bool,
}
```

### TTL policy

Constants mirror escrow exactly:

```rust
const PASS_BUMP_LEDGERS: u32 = 518_400; // ~60 days
const PASS_MIN_TTL: u32 = 17_280;       // ~24h
```

- Every write to a plan/pass entry is followed by `extend_ttl(key, PASS_MIN_TTL, PASS_BUMP_LEDGERS)`.
- **Bump-on-renew**: `renew` bumps the pass entry after writing the new term.
- Read paths `has_access` and `get_pass` also bump the pass entry (same idiom as `get_escrow`, lib.rs:1127-1135): an actively-checked pass never archives.
- The instance entry is bumped inside `initialize` once (config is small and hot).

### Seat accounting (design decision — see §11 Q1)

`SeatsUsed(plan_id)` counts passes occupying a seat. Semantics chosen:

- `subscribe`, brand-new buyer: require `seats < max_seats`, then increment.
- `subscribe` by a buyer whose previous pass expired or was revoked: slot reuse, counter unchanged.
- `renew`: counter unchanged.
- `revoke`: decrement.
- An expired-but-not-revoked pass held by buyer X keeps holding its seat until X resubscribes (reuses the slot) or anyone triggers `revoke`. This is conservative: a plan can read "full" while stale seats linger. Rejected alternative: sweeping expired seats on subscribe, which needs unbounded iteration over buyers and does not fit O(1) Soroban storage access.

---

## 3. Functions

Error enum (numbering fixed here so backend message maps and tests agree):

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HazinaAccessPassError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    NotSeller = 4,            // revoker is neither plan seller nor admin
    EmptyDatasetId = 5,
    InvalidAmount = 6,        // price below MIN_SUB_AMOUNT
    InvalidPeriod = 7,        // 0 or > MAX_PERIOD_SECONDS
    InvalidSeats = 8,         // max_seats == 0
    PlanNotFound = 9,
    PlanInactive = 10,        // renew/subscribe against deactivated plan
    MaxSeatsReached = 11,
    AlreadySubscribed = 12,   // active pass exists for (buyer, dataset_id)
    PassNotFound = 13,
    FeeLookupFailed = 14,     // cross-contract fee read failed (fail closed)
    InvalidRecipient = 15,    // treasury misconfiguration guard, mirrors escrow #31
}
```

### `initialize(env, admin, escrow_contract, token)`

- Guard: `Initialized` checked and set FIRST (escrow pattern, lib.rs:239-256). Second call panics `AlreadyInitialized`.
- Stores admin, escrow contract address, token. Treasury unset until `set_treasury` (falls back to admin, like escrow's `unwrap_or(admin)`, lib.rs:1306-1310).
- Event: `initialized` (admin, escrow_contract, token).

### `set_treasury(env, admin, treasury)`

- Admin-gated. Event: `trs_set` (treasury).

### `define_plan(env, seller, dataset_id, price_per_period, period_seconds, max_seats) -> u64`

Checks:

- `seller.require_auth()`
- `dataset_id` non-empty else `EmptyDatasetId`
- `price_per_period >= MIN_SUB_AMOUNT` (10_000 stroops, mirrors `MIN_LOCK_AMOUNT`) else `InvalidAmount`
- `1 <= period_seconds <= MAX_PERIOD_SECONDS` (30 days, mirrors `MAX_EXPIRY_SECONDS`) else `InvalidPeriod`
- `max_seats >= 1` (capped at `MAX_SEATS_CAP = 10_000`) else `InvalidSeats`

Invariants: plan ids strictly increase from 0; a defined plan is immutable except `active` flips via `set_plan_active` (seller or admin). Repricing creates a NEW plan so existing passes keep their snapshot economics.

Event: `plan_new` (plan_id, seller, dataset_id, price_per_period, period_seconds, max_seats).

### `subscribe(env, buyer, dataset_id, plan_id)`

Checks, in order:

1. Not paused-equivalent: n/a (no pause in v1 scope; noted in §11 Q4).
2. `buyer.require_auth()`
3. Plan exists else `PlanNotFound`; `plan.active` else `PlanInactive`
4. Existing pass for `(buyer, dataset_id)`: if present, not revoked, and `now < expiry` → `AlreadySubscribed`. True even when `now == expiry - 1` (boundary case from the issue). At `now >= expiry` it falls through to fresh-term handling.
5. Seat: if this is a fresh holder (or prior pass expired/revoked by same buyer), enforce/increment per §2 seat rules; full → `MaxSeatsReached`
6. **Fee lookup (reuse of #551)**: cross-contract call `EscrowContract::get_dataset_fee_config(dataset_id)` → take `effective_fee_bps`. Any failure → `FeeLookupFailed`. No local fallback fee, ever (fail closed).
7. **Settled payment BEFORE any state write**: `token::Client.transfer(buyer → contract, price_per_period)`. If the transfer fails the whole invocation reverts and NOTHING persists. This is the "no pass without settled payment" invariant enforced structurally, not by checks after the fact.

Then: compute and persist `PassRecord` (`start = now`, `expiry = now + period_seconds`, `amount_paid`, `fee_bps` snapshot), bump TTL, bump plan record TTL.

Funds custody: the contract holds the full price for the term (needed for pro-rata refund on revoke). Seller/treasury are paid out of custody on `renew` (prior term), `revoke`, and `settle_expired`.

Event: `subscribed` (buyer, dataset_id, plan_id, expiry, amount_paid, fee_bps).

### `renew(env, buyer, dataset_id)`

Checks:

- `buyer.require_auth()`
- Pass exists and `!revoked` else `PassNotFound`; plan exists and active else `PlanInactive`
- Seat already held; unchanged.

Settlement sequence:

1. **Settle prior term out of custody**: `fee = amount_paid * fee_bps / 10_000` with the escrow 1-stroop floor when `fee_bps > 0` (lib.rs:932-939); transfer net to `plan.seller`, fee to treasury.
2. **Charge the new term**: fresh fee lookup (step 6 of subscribe), `transfer(buyer → contract, plan.price_per_period)` before any write.
3. **Fresh-term semantics** (issue boundary case):
   - Renewing before expiry extends: `new_expiry = old_expiry + period_seconds` (no lost paid time).
   - Renewing after expiry starts a FRESH term: `new_start = now`, `new_expiry = now + period_seconds` — NOT `old_expiry + period`. Test asserts the exact arithmetic both sides of the boundary.
4. Update `PassRecord` (new start/expiry, new amount_paid, new fee snapshot, refreshed `term_period_seconds`), bump-on-renew.

Event: `renewed` (buyer, dataset_id, old_expiry, new_expiry, amount_charged).

### `has_access(env, buyer, dataset_id) -> bool`

- Pure read. Returns `false` unless: record exists AND `!revoked` AND `env.ledger().timestamp() < expiry`.
- Never panics on a missing pass. Bumps the pass entry TTL (active readers keep their record alive).

### `get_pass(env, buyer, dataset_id) -> Option<PassRecord>`

- Returns `None` when absent (deviation from escrow's panicking getter, see §11 Q3): the UI polls this constantly and a trap-per-miss read would be hostile to the frontend and to read-only simulations.
- Bumps pass entry TTL.

### `settle_expired(env, buyer, dataset_id)` — NEW function, see §11 Q2

- Permissionless (anyone may trigger; follows escrow precedents where anyone executes an already-determined action, e.g. `execute_upgrade`, lib.rs:436).
- Requires `now >= expiry`, pass exists, `!revoked`, prior term unsettled.
- Pays prior term out of custody (same settle math as renew step 1), marks the pass settled (`amount_paid = 0`, keep record for history).
- Without this function, a term that ends by natural expiry (no renew, no revoke) leaks value in the contract forever. It closes the loop with one O(1) call.
- Event: `settled` (buyer, dataset_id, seller_net, fee).

### `revoke(env, caller, buyer, dataset_id)`

Checks:

- `caller.require_auth()`; caller must be `plan.seller` OR `admin` else `NotSeller` / `NotAdmin`
- Pass exists and `!revoked` else `PassNotFound`

Pro-rata arithmetic (the issue boundary case):

```
elapsed   = min(now, expiry) - start                 // saturating
remaining = term_period_seconds - elapsed            // saturating, >= 0
refund    = amount_paid * remaining / term_period_seconds   // integer floor
earned    = amount_paid - refund
fee       = earned * fee_bps / 10_000                // floor, 1-stroop minimum when fee_bps > 0 and earned > 0
seller_net = earned - fee
```

Transfers: `refund → buyer`, `seller_net → plan.seller`, `fee → treasury`, all out of custody. Conservation invariant: `amount_paid == refund + seller_net + fee + dust_in_contract` where dust is zero by construction (floor rounding pushes remainder into `seller_net`... verify in tests; if a 1-stroop case leaves dust, assert conservation including contract balance delta instead).

Mark `revoked = true`, decrement seats, bump TTL. Record kept (audit trail); a later subscribe overwrites the key.

Event: `revoked` (buyer, dataset_id, refund, earned).

### Read helpers

- `get_plan(plan_id) -> PlanRecord` (panics `PlanNotFound`, matches escrow getter style)
- `get_seats_used(plan_id) -> u32`

### Event naming note

The issue names events `subscribed`, `renewed`, `revoked`. `subscribed` is 10 characters; `symbol_short!` panics above 9. Escrow uses `symbol_short!` everywhere because its topics are short (`locked`, `released`). Here we use `Symbol::new(&env, "subscribed")` etc. for ALL five events (consistent, and keeps the issue's names verbatim). Deliberate, documented deviation from the `symbol_short!` idiom.

---

## 4. Fee model reuse strategy (#551)

The access-pass contract NEVER stores or computes its own fee configuration. At every charge point (subscribe step 6, renew step 2) it makes one cross-contract read:

```rust
let cfg: DatasetFeeConfig = env.invoke_contract(
    &escrow_contract,
    &symbol_short!("get_ds_fc"),  // actual fn name resolved at impl time
    ...
);
```

- Source of truth stays `contracts/hazina-escrow/src/lib.rs` (`set_default_fee` / `set_dataset_fee` / `get_dataset_fee_config`, lines 285-355). Admin changes fees in ONE place; subscriptions follow automatically.
- The returned `effective_fee_bps` is snapshotted into the pass at payment time, matching the escrow rule that a locked escrow keeps its lock-time fee (test `test_lock_and_release_use_snapshot_fee`, lib.rs:1682).
- Fail closed: if the escrow contract is unset, undeployed, or the call fails → `FeeLookupFailed`, no subscription. No default-fee fallback duplicated locally.
- Trade-off accepted: deployment order matters (escrow must be deployed and fee-configured first). On testnet this is already true.

---

## 5. Test plan

All in `contracts/hazina-access-pass/src/lib.rs` inline modules, using an escrow-style `setup()` (mock auths, `TEST_ENTRY_TTL = 1_000_000`, registered Stellar asset, minted buyer, registered access-pass contract, registered a REAL escrow contract instance for fee lookups so the cross-contract path is exercised end to end, not mocked).

### Issue boundary cases

| #   | Case                                                     | Test                                                        | Assertion                                                                                                                                                    |
| --- | -------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Active pass blocks subscribe up to the last second       | `test_subscribe_blocked_at_expiry_minus_one`                | advance to `expiry - 1`; `try_subscribe` errs `#12`; `has_access` true                                                                                       |
| B2  | Expired pass allows fresh subscribe                      | `test_subscribe_allowed_at_exact_expiry`                    | at `now == expiry`: `has_access` false, subscribe succeeds, new `start == now`                                                                               |
| B3  | Renew after expiry is a FRESH term                       | `test_renew_after_expiry_is_fresh_term`                     | renew at `expiry + 3600`; assert `expiry == renew_now + period`, NOT `old_expiry + period`                                                                   |
| B4  | Renew before expiry extends                              | `test_renew_before_expiry_extends`                          | renew at `expiry - 100`; assert `expiry == old_expiry + period`                                                                                              |
| B5  | Max seats reached                                        | `test_subscribe_fails_when_max_seats_reached`               | fill to `max_seats`; next distinct buyer errs `#11`                                                                                                          |
| B6  | Slot reuse does not double-count                         | `test_resubscribe_after_expiry_reuses_seat`                 | full plan; expired holder resubscribes; succeeds; `get_seats_used` unchanged                                                                                 |
| B7  | Pro-rata refund arithmetic                               | `test_revoke_refunds_pro_rata_half_term` (+ rounding cases) | revoke at half term: exact expected numbers for refund/earned/fee incl. the 1-stroop floor case (`amount_paid` odd, `fee_bps` small)                         |
| B8  | Revoke after natural expiry refunds zero, settles seller | `test_revoke_after_expiry_settles_not_refunds`              | balances move to seller+treasury only; buyer refund 0                                                                                                        |
| B9  | TTL bump behavior                                        | `test_ttl_bumped_on_write_and_read`                         | assert persistent entry TTL `>= PASS_MIN_TTL` after subscribe, after renew, and after `has_access` on an aging entry (SDK `storage().persistent().get_ttl`)  |
| B10 | No pass without settled payment                          | `test_no_pass_when_transfer_fails`                          | drain buyer below price; `catch_unwind(try_subscribe)`; assert `get_pass == None`, `has_access == false`, `seats_used` unchanged, contract balance unchanged |
| B11 | AlreadySubscribed mid-term                               | `test_double_subscribe_panics`                              | second subscribe same buyer errs `#12`                                                                                                                       |

### Auth / validation matrix (escrow style, `should_panic(expected = ...)`)

Non-admin `initialize` params tampering, non-seller `define_plan` (mock auth off via `set_auths`), non-owner `renew`, outsider `revoke` (`#4`), empty dataset id (`#5`), zero price / period / seats (`#6/#7/#8`), unknown plan (`#9`), inactive plan (`#10`), unknown pass (`#13`).

### `formal_` invariant tests (run by formal-checks.sh)

```rust
formal_no_pass_without_settled_payment   // every existing pass implies contract received amount_paid; failed-payment attempts leave zero trace
formal_revoke_conserves_value            // refund + seller_net + fee == amount_paid for arbitrary revoke times (property over timestamps)
formal_access_monotonic_within_term      // has_access true at t < expiry implies true at t-1; false at t >= expiry for every sampled t
formal_seat_count_matches_state          // seats_used equals count of non-revoked holders minus reusable slots, after random op sequences
```

### Fuzz suite (stage 1b, mirrors escrow wiring exactly)

`tests/fuzz/{main.rs, harness.rs, lifecycle.rs}` behind `fuzz-tests` feature:

- Strategy: sequences of `Subscribe / Renew / Revoke / AdvanceTime / SettleExpired` over a small buyer pool and 1-2 plans.
- Properties: value conservation across custody at every step; `has_access(b) == (pass exists && !revoked && now < expiry)` at all times; no successful money-moving op leaves the pass unwritten; seat counter consistency.

Regressions committed under `proptest-regressions/` like escrow.

---

## 6. CI plan (exact changes)

| File                                  | Change                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/contracts/checks.sh`         | Replace single `CONTRACT_DIR` with a loop over `hazina-escrow hazina-access-pass`; fmt/clippy/test/wasm-build run per crate; `set -eu` keeps fail-fast. Root `npm run contracts:check` picks this up with zero package.json changes                                                                                                     |
| `scripts/contracts/formal-checks.sh`  | Same loop; `cargo test ... formal_` per crate                                                                                                                                                                                                                                                                                           |
| `.github/workflows/ci.yml`            | `contract` job: add `strategy.matrix.crate: [hazina-escrow, hazina-access-pass]`, working-directory `contracts/${{ matrix.crate }}`. `contract-artifacts` job: add a parallel WASM build + spec extraction for `hazina_access_pass.wasm`; artifact path gains the new wasm/spec (artifact name suffixed per crate)                      |
| `.github/workflows/contract-fuzz.yml` | `gate` job: matrix over both crates (`cargo test --locked`, release build). `fuzz` job: keep escrow suite as-is; add a step running the access-pass suite with the same budget env vars; extend `Swatinem/rust-cache` `workspaces:` to list both crates; regression-seed upload path becomes a glob `contracts/*/proptest-regressions/` |
| `.prettierignore`                     | Replace the two `contracts/hazina-escrow/...` entries with `contracts/*/target` and `contracts/*/Cargo.lock`                                                                                                                                                                                                                            |
| `.gitignore`                          | DONE on this branch (`**/target/`)                                                                                                                                                                                                                                                                                                      |
| ESLint/Prettier TS globs              | NO change needed: root `format`/`lint` scripts glob `backend/src/**/*.{ts,tsx}` and `frontend/src/**/*.{ts,tsx}`; new files land inside them automatically                                                                                                                                                                              |
| Husky `lint-staged`                   | NO change needed: same reason                                                                                                                                                                                                                                                                                                           |

Definition of done for stage 1: a push containing ONLY contract code goes green on `format`, `lint`, `typecheck`, `contract` (both matrix legs), `Contract Gate Tests` (both crates), and `Invariant Suite`.

---

## 7. Backend integration plan

### Config — `backend/src/lib/stellar.config.ts`

Add alongside the escrow block (lines 33-62), same idioms (per-call env read, throws naming the var, strkey validation):

- `isAccessPassConfigured()`, `getAccessPassContractId()` reading `ACCESS_PASS_CONTRACT_ID`
- `validateAccessPassConfig()` called at startup next to `validateEscrowConfig()`

### New client — `backend/src/lib/access-pass.client.ts`

Modeled line-for-line on `escrow.client.ts`:

Read-only simulation calls (NO signing, source account = agent pubkey ?? contract id, fallback `new StellarSdk.Account(sourceAddr, '0')` exactly like `getEscrow`, escrow.client.ts:473-505):

- `hasAccess(buyer, datasetId): Promise<boolean>` — simulates `has_access`, decodes `scvBool`
- `getPass(buyer, datasetId): Promise<AccessPassState | null>` — simulates `get_pass`, `None` maps to null
- `getPlan(planId): Promise<PlanState>`

Write-path builders (unsigned XDR, buyer signs in wallet — mirrors `buildConfirmDeliveryTx` / `buildBuyerSignedCall`):

- `buildSubscribeTx({ buyer, datasetId, planId })`
- `buildRenewTx({ buyer, datasetId })`
- `submitSignedAccessTx(signedXdr)` relay + poll, returning `{ txHash }`

Shared infrastructure:

- Reuses the SAME `'soroban-rpc'` circuit breaker registry entry (escrow.client.ts:48-54) so subscription reads trip the shared breaker during RPC outage.
- `ACCESS_PASS_ERROR_MESSAGES: Record<number, string>` mirroring the error enum numbering in §3; `throwSanitized` copy keeps raw sim payloads out of thrown messages.

**Short cache**: module-level `Map<key, { value, expiresAt }>`, key `` `${buyer}:${datasetId}` ``, TTL 15 seconds, applied to `hasAccess` and `getPass` results only (never to builders/submits). Purpose: the dataset detail page and any middleware check can poll without hammering Soroban RPC. Cache is bypassed entirely on error paths.

**Fail-closed behavior (the load-bearing rule)**: if Soroban RPC is unreachable, the breaker is open, simulation fails, or decoding fails, `hasAccess` THROWS (`AccessCheckUnavailableError`). It never returns `true` on failure and never returns `false`-with-error-swallowed. Documented contract for callers: a thrown error means DENY access and surface a "verification temporarily unavailable" state. A vitest case asserts the throw on simulated RPC failure and that no code path maps an exception to `true`.

### Routes

New `backend/src/datasets/access-pass.routes.ts` following `datasets.router.ts` conventions, mounted in `main.ts` next to the datasets router:

- `GET /api/datasets/:id/access-pass?buyer=...` → cached `hasAccess` + pass details
- `GET /api/datasets/:id/plans` → plans for dataset, indexed OFF-CHAIN from `plan_new` events (Soroban cannot enumerate keys cheaply; a small indexer table populated from event polling, same pattern the receipts/sentinel modules use for chain observation)
- `POST /api/datasets/:id/plans/subscribe-tx` → returns unsigned XDR for wallet signature
- `POST /api/datasets/:id/plans/renew-tx` → same

### Backend tests (`access-pass.client.test.ts`, vitest, colocated like `escrow.client.test.ts`)

Decode happy path; sim failure → throw (fail closed); breaker open → throw; cache hit within TTL; cache miss after TTL; error map coverage for every enum code; builder arg-order snapshots against known ScVal encodings.

---

## 8. Frontend integration plan

### Seller side — `SellPage.tsx` "Offer a subscription"

- New collapsible section in the sell form (after pricing): toggle "Offer a subscription", fields price-per-period (presets row matching `PRICE_PRESETS` idiom, SellPage.tsx:24), period selector (day/week/month mapped to seconds), max seats number input.
- Extends `FormState`, draft persistence, preview tab, and i18n catalog keys (`sell.subscription.*`).
- Submit flow: existing POST creates the dataset; then the page requests `subscribe-tx`-style builder for `define_plan`, Freighter-signs, submits via the relay endpoint. Toast feedback reuses `useToastContext`.

### Buyer side — `DatasetDetailPage.tsx` sidebar

- `SubscriptionPlanCard` component (`frontend/src/components/ui/SubscriptionPlanCard.tsx`): `glass-card` section listing plans (price/period/seats-left), primary CTA `btn-gold` "Subscribe". Clicking builds the unsigned XDR via API, signs with the connected wallet, submits, then invalidates the access-pass query.
- `ActivePassBadge` component (`frontend/src/components/ui/ActivePassBadge.tsx`): emerald badge variant copied from the live-feed badge (DatasetDetailPage.tsx:129-139): `border-emerald-400/30 bg-emerald-400/10 text-emerald-400`, pulsing dot icon, text "Active · expires {timeAgo}". Renders from `useAccessPass`.
- `useAccessPass(datasetId)` hook: react-query, `queryKey: ['access-pass', wallet, datasetId]`, `queryFn` hits `GET /api/datasets/:id/access-pass`, `staleTime: 15_000` (mirrors backend cache), `refetchInterval: 60_000`. On query ERROR renders a neutral "Access status unavailable" state and DISABLES data-purchase actions (fail closed at the UI layer too).
- Skeleton states reuse `SkeletonLoader`. Storybook stories for both components (precedent: `DatasetCard.stories.tsx`).
- Vitest component tests: badge renders from mocked hook states (active/expired/unavailable), plan card disables CTA when `seatsLeft === 0`, subscribe happy path calls sign+submit once.

---

## 9. Staged breakdown

**Stage 1 — contract + tests (this branch, first PR-ready unit)**

1. Crate scaffold: `Cargo.toml`, `src/lib.rs` skeleton with constants/keys/errors/types.
2. Full impl: init, define_plan, subscribe, renew, has_access, get_pass, settle_expired, revoke, getters.
3. Inline unit tests (B1-B11 + auth matrix) green: `cargo test --manifest-path contracts/hazina-access-pass/Cargo.toml`.
4. `formal_` invariants green via formal-checks.sh loop.
5. Fuzz suite + `required-features` wiring, regressions dir.
6. CI extensions from §6 (checks.sh loops, ci.yml matrix, fuzz workflow steps, .prettierignore).
7. `cargo fmt` + `cargo clippy -- -D warnings` clean for BOTH crates.

Commit 1: `feat(access-pass): subscription access pass contract with boundary tests`.
Commit 2 (if separated): `ci(contracts): include hazina-access-pass in checks, CI matrix, and fuzz suite`.

**Stage 2 — backend/UI integration**

1. stellar.config additions + startup validation (+ test).
2. `access-pass.client.ts` with cache/fail-closed/breaker (+ vitest suite).
3. Routes + minimal event indexer table for plans (+ router tests).
4. Frontend: hook, `SubscriptionPlanCard`, `ActivePassBadge`, SellPage subscription section (+ component tests + stories + i18n).
5. Full local gate: root `npm run lint`, `npm run format:check`, backend/frontend typecheck + tests.

Commit 3: `feat(access-pass): backend client with fail-closed reads and subscription APIs` — DONE (c4de72f).
Commit 4: `feat(frontend): subscription offer UI and active-pass badge` — this commit.

Stage 2 status: COMPLETE. Beyond the plan above, stage 2 shipped:
- `GET /:id/plans` enriches each indexed plan with live `seatsUsed`/`seatsLeft`
  (fail-open to `null` on seat-read failure so listings stay up).
- Frontend: `useAccessPass` hook, `ActivePassBadge`, `SubscriptionPlanCard`,
  SellPage "Offer a subscription" section with draft persistence, i18n for
  en/es/fr/sw, component tests + stories.
- Local gate: backend typecheck/lint clean, 54 access-pass tests green;
  frontend typecheck/lint clean (2 pre-existing warnings), prettier@3.8.3
  clean on all touched files, full vitest suite 125 passed / 6 skipped.

Not in scope (explicitly): deploying either contract to testnet/mainnet, mainnet fee configuration, pause/circuit-breaker surface on the pass contract (see Q4).

---

## 10. Measurable outcome

- A buyer can hold provable, chain-enforced time-boxed access to a dataset without a per-purchase escrow; `has_access` is the single authorization primitive.
- Traceable evidence: `subscribed/renewed/revoked/settled` events on-chain; `formal_*` + fuzz suites prove conservation and the no-pass-without-payment invariant; CI matrix proves the new crate cannot regress silently again.

---

## 11. Decisions — RESOLVED by Babigdk

**Q1 — Seat semantics (§2).** APPROVED: expired passes keep their seat until the holder resubscribes (slot reuse) or someone revokes. Conservative but O(1) and deterministic.

**Q2 — `settle_expired` (§3).** APPROVED: permissionless `settle_expired(buyer, dataset_id)` ships in stage 1 so sellers get paid on natural expiry without buyer action.

**Q3 — `get_pass` returns `Option`.** APPROVED.

**Q4 — Pause/circuit-breaker.** RESOLVED: v1 ships WITHOUT pause/circuit-breaker. Filed as a fast-follow; not blocking this PR. Consequence for the error enum: no `Paused` code; enum gains `NotExpired = 16` (settle_expired before expiry) and `NothingToSettle = 17` (settle on an already-settled pass), which the original numbering did not anticipate.

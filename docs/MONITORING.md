# Sentinel — escrow contract monitoring

Sentinel is the always-on watcher for `contracts/hazina-escrow`: it streams
the contract's on-chain events via Soroban RPC, continuously re-checks the
safety invariants in [`docs/INVARIANTS.md`](./INVARIANTS.md) against live
state, and pages a human when something is wrong. #519 documents that the
admin key has instant, untimelocked power to move escrowed funds — Sentinel
is the mitigation for that risk you can't design away: you can't stop the
key, but you can guarantee everyone knows within seconds of it being used.

Code lives in `backend/src/sentinel/`. See that directory's modules for the
implementation; this document is the operational side — every alert this
system can raise, its severity, and what to actually do about it.

## Running it

- **In-process**: set `SENTINEL_ENABLED=true` on the main API process
  (`backend/src/main.ts` starts it behind that flag). Simplest to operate,
  but a compromised or crashed API host takes the watcher down with it.
- **Standalone container** (recommended for production): run
  `node dist/sentinel/standalone.js` — see the `sentinel` service in
  `docker-compose.yml`. Independent process, independent failure domain.
  Exposes `GET /health` and the same `/api/solvency` + `/api/sentinel/alerts*`
  routes on `SENTINEL_PORT` (default 3002).

Both modes share `backend/src/sentinel/bootstrap.ts` — same env config,
same engine, same alert routing — so they can't silently drift apart.

### Config

| Env var                          | Default | Meaning                                                                 |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| `SENTINEL_ENABLED`                | `false` | Arms the in-process watcher in `main.ts`. Standalone mode ignores this for the HTTP server but still gates the watcher loop. |
| `SENTINEL_START_LEDGER`           | `0`     | Ledger to start ingestion from when no cursor has been persisted yet.  |
| `SENTINEL_PAGE_LIMIT`             | `100`   | Events fetched per `getEvents` page.                                   |
| `SENTINEL_TICK_MS`                | `15000` | How often the engine fetches a new event page and re-runs timer checks. |
| `SENTINEL_STALL_SECONDS`          | `120`   | How long the ledger can go without advancing before a stream-stall alert fires. |
| `SENTINEL_ALERT_SUPPRESS_SECONDS` | `3600`  | Re-notification window for a still-open alert of the same (invariant, escrow). A resolved alert that recurs always re-notifies immediately, ignoring this. |
| `SENTINEL_SOLVENCY_MAX_SCAN`      | `5000`  | Cap on how many escrow ids the solvency/expiry sweep reads per tick.   |
| `SENTINEL_FEE_BAND_MIN_BPS` / `SENTINEL_FEE_BAND_MAX_BPS` | `0` / `2000` | The operator-configured band a fee change must stay inside. |
| `SENTINEL_ALERT_WEBHOOK_URL`      | unset   | Slack/Discord-compatible incoming webhook for every alert.             |
| `SENTINEL_ALERT_EMAIL`            | unset   | Recipient for critical-only email alerts (via the existing Resend wiring; needs `RESEND_API_KEY`). |
| `SENTINEL_PORT`                   | `3002`  | Standalone container's HTTP port.                                      |

## Ground truth, not just the event stream

Every invariant reads live contract state (`get_escrow`, `get_escrow_count`,
token `balance()`) rather than trusting a locally rebuilt history from
ingested events. Two consequences:

- **Restart safety is simple.** The only state that must survive a restart
  is the ingestion cursor itself (persisted only after a batch's events have
  all been evaluated) plus the last-observed ledger/WASM hash the two
  comparison checks (stream stall, upgrade watch) diff against. A crash
  mid-batch just re-fetches and re-evaluates the same page next start; alert
  dedupe makes that idempotent rather than a duplicate page.
- **RPC event retention is a real limitation.** Public Soroban RPC providers
  typically only retain events for a rolling window (days, not the
  contract's full history). If Sentinel is down longer than that window,
  ingestion resumes from the persisted cursor but some event-based
  invariants may have a gap for the missed period — the timer-based checks
  (solvency, expiry) are unaffected since they always read current state.
  For longer outages, use `replay.ts` against an archival RPC provider if
  one is configured, or treat the gap itself as an incident.

## Invariants, severities, and runbooks

| ID | Invariant | Severity | Fires on |
| -- | --------- | -------- | -------- |
| solvency | On-chain token balance ≥ sum of open escrow amounts | **critical** | Timer |
| release_conservation | `released` event's seller + treasury amounts sum to the locked amount | **critical** | `released` |
| unknown_escrow_settlement | release/refund/claim for an escrow id the contract has no record of | **critical** | `released`/`refunded`/`claimed` |
| admin_action | `emergency_withdraw`, `transfer_admin`/`set_admin` called at all | **critical** | `emerg_wd`/`admin` |
| contract_upgrade | `upgrade()` changed the deployed WASM | **critical** | Timer (WASM hash poll — `upgrade()` emits no event) |
| pause_state | `pause`/`unpause` called | **high** | `paused`/`unpaused` |
| delivery_record | `released` with no matching backend delivery record | **high** | `released` |
| fee_band | Default or per-dataset fee changed outside the configured band | **high** | `fee_upd`/`dsf_upd` |
| stream_stall | No ledger progress for `SENTINEL_STALL_SECONDS` | **high** | Timer |
| expiry_without_claim | Open escrow past its deadline, unclaimed | **medium** | Timer |

### solvency — critical

**What it means:** the contract's on-chain balance for a token is less than
the sum of every open (locked, unsettled) escrow in that token. Money the
contract owes buyers/sellers isn't actually there.

**Runbook:**

1. Pull the alert's `details.token`, `onChainBalance`, `openLiability` and
   `delta`. Cross-check independently against `GET /api/solvency` and the
   token's SAC balance on Stellar Expert.
2. Check for a recent `emergency_withdraw` (see admin_action alerts around
   the same time) — the most likely legitimate cause of a balance drop.
3. If there is no matching legitimate withdrawal, treat this as an active
   incident: page the on-call lead immediately, do not wait for
   confirmation. Consider whether the admin key needs rotating.
4. Do not `pause()` unilaterally without lead sign-off — pausing blocks
   `release`/`refund` for buyers with genuinely settled escrows too.
5. Resolve only once the discrepancy is explained (a legitimate withdrawal,
   a since-corrected accounting bug, etc.) and documented in the incident
   record.

### release_conservation — critical

**What it means:** a `release` paid out `seller_cut + platform_cut` that
doesn't equal what was locked — i.e. the contract's core money-split
invariant (I1 in `docs/INVARIANTS.md`) failed on a live release.

**Runbook:**

1. This should be **impossible** given the current contract — the fuzz
   suite (`contracts/hazina-escrow/tests/fuzz/`) exists specifically to
   catch this before deploy. Firing at all means either a contract bug that
   escaped fuzzing, or a bug in Sentinel's own decoding (check `details` for
   sane-looking numbers first).
2. Pull the escrow id and tx hash, verify against Stellar Expert.
3. If confirmed on-chain: this is a contract-correctness incident, not an
   operational one. Escalate to whoever owns the contract, and strongly
   consider pausing new escrow creation (`lock`) while the affected release
   is investigated — settled escrows are unaffected by a pause.

### unknown_escrow_settlement — critical

**What it means:** a settlement event referenced an escrow id the contract
has no record for. Also should be impossible given contract logic — see the
comment in `invariants/unknownEscrow.ts` for why this check exists anyway.

**Runbook:**

1. First check: is `ESCROW_CONTRACT_ID` actually pointed at the right
   contract? A misconfiguration (Sentinel watching one contract, backend
   talking to another) can produce this without any real anomaly.
2. If the config is correct, escalate as a contract-correctness incident —
   same path as release_conservation.

### admin_action — critical

**What it means:** `emergency_withdraw`, `transfer_admin`, or `set_admin`
was called. There is no "wrong" call to distinguish from a "right" one here
— every occurrence pages, because the whole point is a human sees it happen
(#519).

**Runbook:**

1. Confirm the action was expected (a planned admin rotation, a documented
   emergency sweep, ...). Check the incident/change log first.
2. If unexpected: treat as a compromised-key incident immediately. Assume
   the admin secret is no longer trustworthy; begin key-rotation procedure.
3. If expected: resolve with a note linking the change record. Every
   legitimate admin action should still leave this trail — don't skip
   raising it just because it was planned.

### contract_upgrade — critical

**What it means:** the deployed contract's WASM hash changed. `upgrade()`
emits no contract event, so this is caught by polling the hash on the timer
instead — see `invariants/upgradeWatch.ts`.

**Runbook:**

1. Confirm this matches a planned, reviewed deployment (check the WASM hash
   in `details` against the release you expect to be live).
2. If unplanned: treat as critical as `admin_action` — an unplanned upgrade
   can replace the entire contract's logic. Assume compromise until proven
   otherwise.
3. After a planned upgrade, update the operational baseline (nothing to do
   in Sentinel itself — it just remembers the new hash going forward).

### pause_state — high

**What it means:** `pause()` or `unpause()` was called.

**Runbook:**

1. Confirm this matches planned maintenance or a documented incident
   response. A pause blocks `release`/`refund`/`claim_expired`/`lock` for
   the affected token(s), so an unplanned pause is itself user-impacting.
2. If unplanned: check for a correlated `admin_action` or `solvency` alert
   around the same time — pausing is often step one of a real incident.
3. Resolve once the cause is understood; if it was legitimate maintenance,
   link the maintenance window.

### delivery_record — high

**What it means:** an escrow released on-chain but the backend has no
matching `transactions` record with `status = 'completed'` and
`deliveryStatus = 'delivered'`. Funds moved without the off-chain system
agreeing delivery happened.

**Runbook:**

1. Look up the escrow id in the backend `transactions` table — is there a
   record at all, and if so what status is it stuck in?
2. Check `payments.router.ts`/`payments.service.ts` logs around the release
   tx timestamp for a delivery failure that never got reconciled.
3. If the buyer never actually received their data despite the seller being
   paid, this is a buyer-support incident — reach out proactively.
4. Resolve once the backend record is reconciled (backfilled or explained,
   e.g. a manually-triggered release for a legitimate off-platform reason).

### fee_band — high

**What it means:** the default fee or a per-dataset fee was set outside
`[SENTINEL_FEE_BAND_MIN_BPS, SENTINEL_FEE_BAND_MAX_BPS]`.

**Runbook:**

1. Usually a fat-fingered admin call, not an attack. Check who made the
   call and whether the new value was intentional.
2. If intentional and the band itself is just stale, update
   `SENTINEL_FEE_BAND_MIN_BPS`/`MAX_BPS` and resolve.
3. If unintentional, call `set_default_fee`/`set_dataset_fee` again with the
   correct value — this does not require pausing the contract.

### stream_stall — high

**What it means:** Sentinel hasn't observed ledger progress for
`SENTINEL_STALL_SECONDS`. Either the RPC endpoint is down/unreachable, the
network itself has halted, or Sentinel is wedged.

**Runbook:**

1. Check `SOROBAN_RPC_URL`'s health directly (`getHealth`/`getLatestLedger`
   against it manually).
2. Check Sentinel's own process logs for repeated RPC errors (circuit
   breaker trips log at `warn`/`error`).
3. If the RPC endpoint is down, failing over to a backup provider unblocks
   Sentinel; if the network itself has halted, this is expected and should
   resolve itself once the network resumes — no action needed beyond
   confirming that's actually what's happening.
4. If Sentinel's own process is wedged (RPC is healthy but Sentinel isn't
   progressing), restart it — restart safety is covered by `engine.test.ts`,
   so this is safe to do without losing or duplicating alerts.

### expiry_without_claim — medium

**What it means:** an open escrow's deadline has passed and nobody has
settled it (seller via `claim_expired`, admin via `release`, buyer via
`refund`).

**Runbook:**

1. Not urgent — money isn't missing, it's just sitting exposed longer than
   necessary. No action required beyond visibility.
2. If the same escrow keeps reappearing across days, consider nudging the
   seller (most sellers don't know `claim_expired` exists) or having an
   admin release it if delivery was in fact confirmed off-chain.

## Public transparency endpoint

`GET /api/solvency` (or `GET /api/v1/solvency`) is unauthenticated by design
— publishing it is a genuine trust signal and costs nothing once the checker
exists. It returns, per token: on-chain balance, open escrow liability, the
delta, and the ledger the figures were checked against.

## Replay / incident forensics

```bash
cd backend
npx ts-node src/sentinel/replay.ts --start <ledger> --end <ledger>
```

Re-runs the event-based invariants (pause, admin action, fee band, release
conservation, unknown escrow) against a historical ledger range without
touching the live cursor or the persisted alert table. The timer-based
invariants (solvency, expiry, stream stall, upgrade) aren't replayable —
`get_escrow`/`balance` return *current* contract state, not a snapshot at
some past ledger.

## Out of scope

Sentinel detects and pages; it never acts. No auto-pausing, no automatic
remediation of any kind — humans decide. It also only watches the escrow
contract; nothing else in the stack is in scope for this system.

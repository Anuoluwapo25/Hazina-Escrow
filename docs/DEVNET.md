# Local Stellar devnet

One command boots a private Stellar network, deploys the escrow contract, issues
a test USDC asset, funds every role, seeds the marketplace, and writes a ready
`.env`.

```bash
npm run devnet
```

No testnet accounts. No personal keys. No friendbot begging. Every contributor
gets the same addresses and the same contract id, every time.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Quickstart](#quickstart)
- [What `npm run devnet` does](#what-npm-run-devnet-does)
- [The accounts](#the-accounts)
- [Commands](#commands)
- [Running the on-chain test suite](#running-the-on-chain-test-suite)
- [Pointing the backend at the devnet](#pointing-the-backend-at-the-devnet)
- [Safety: the network guard](#safety-the-network-guard)
- [Determinism](#determinism)
- [CI](#ci)
- [Troubleshooting](#troubleshooting)
- [How it is built](#how-it-is-built)

---

## Why this exists

Before this, exercising a real payment locally meant provisioning testnet
accounts by hand, or using demo mode and never touching Stellar at all. The
on-chain half of the codebase was tested only by mocks.

Mocks do not catch operation ordering bugs, trustline failures, sequence number
races, or fee bumps. They return whatever the developer expected. The devnet
catches them because it is a real network — the same `stellar-core` and protocol
version that public testnet runs.

It also makes reviewing on-chain PRs possible. Instead of "trust the
screenshot":

```bash
npm run devnet && npm run e2e:chain
```

---

## Quickstart

**Prerequisites**

| Tool                   | Version                | Why                                        |
| ---------------------- | ---------------------- | ------------------------------------------ |
| Docker                 | 20.10+, running        | Hosts the network                          |
| Node.js                | 22.6+ (24 recommended) | The provisioner is TypeScript run natively |
| Rust + `wasm32v1-none` | 1.75+                  | Builds the contract                        |

```bash
rustup target add wasm32v1-none   # once
npm install                       # root deps
npm run devnet
```

First run takes 2–4 minutes (Docker pulls a ~700MB image and cargo builds the
contract cold). Subsequent runs take about 6 seconds.

You will get a summary like this:

```
Endpoints
  Horizon      http://localhost:8000
  Soroban RPC  http://localhost:8000/rpc
  Friendbot    http://localhost:8000/friendbot
  Passphrase   Standalone Network ; February 2017

Contract
  Escrow id    CCUL6I3SM3H2FMIEHSPJHNDNTCQCD3FIJGSXEM5RDX5SDF4HSM6ACZ2W
  Platform fee 500 bps (5% — 95/5 split)
```

---

## What `npm run devnet` does

Ten steps, all idempotent — re-running is safe and skips work already done.

| #   | Step      | Detail                                                                        |
| --- | --------- | ----------------------------------------------------------------------------- |
| 1   | Guard     | Refuses to continue unless the target is a local network                      |
| 2   | Boot      | `docker compose up` on the pinned quickstart image                            |
| 3   | Health    | Waits for Horizon **ingesting**, RPC healthy, friendbot **serving**           |
| 4   | Accounts  | Derives 7 deterministic keypairs, funds them via friendbot                    |
| 5   | Asset     | Issues devnet USDC, establishes trustlines, distributes balances              |
| 6   | SAC       | Deploys the Soroban Asset Contract wrappers for USDC and XLM                  |
| 7   | Contract  | `cargo build` → upload wasm → deploy at fixed salt → `initialize(admin, 500)` |
| 8   | Config    | `set_treasury`, `set_arbitrator`                                              |
| 9   | Seed      | Writes three deterministic marketplace datasets                               |
| 10  | Artifacts | Writes `.env.devnet`, `devnet.accounts.json`, prints the summary              |

### Why the health wait matters

Quickstart starts services in sequence: core, then Horizon ingestion, then —
only once the network finishes its protocol upgrade — friendbot. Horizon
answering on `/` is **not** proof that friendbot will fund an account; it
returns `502` for roughly ten more seconds.

That is why step 3 waits on all three independently, with exponential backoff
rather than a fixed sleep. Measured on a clean boot: Horizon ready at ~12s,
friendbot ~7 polls later.

---

## The accounts

All seven are derived from `sha256("hazina-devnet:v1:<role>")`. Identical for
every contributor, on every machine, forever.

| Role                | Address         | USDC   | Trustline | Purpose                                         |
| ------------------- | --------------- | ------ | --------- | ----------------------------------------------- |
| `issuer`            | `GD4XUZEY…HMBN` | —      | no        | Issues devnet USDC                              |
| `admin`             | `GA7SSV6Q…DTMN` | 0      | yes       | Contract admin + deployer; signs release/refund |
| `treasury`          | `GBRE5IW2…WDQP` | 0      | yes       | Receives the 5% platform fee                    |
| `arbitrator`        | `GBK4J5EA…LW6X` | 0      | yes       | Resolves disputes                               |
| `buyer`             | `GAY7W32I…IZAD` | 10,000 | yes       | Locks funds into escrow                         |
| `seller`            | `GB5XWX2O…XE4U` | 0      | yes       | Receives the 95% seller cut                     |
| `sellerNoTrustline` | `GBOZADVV…KGOZ` | 0      | **no**    | Payout-failure fixture                          |

Full addresses and secrets land in `devnet.accounts.json` and `.env.devnet`.

> `sellerNoTrustline` has no trustline **on purpose**. It is the fixture for the
> payout-failure scenario. Do not "fix" it by adding one.

Every secret here is a throwaway key for a throwaway network. They are
deterministic, public, and worthless. Never reuse them anywhere else.

---

## Commands

| Command                 | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run devnet`        | Boot + provision. Idempotent.                                          |
| `npm run devnet:status` | Is it up? Which network? What balances? Exits non-zero if unusable.    |
| `npm run devnet:reset`  | Destroy everything and reprovision from zero, then verify determinism. |
| `npm run devnet:down`   | Stop and remove the container and volumes.                             |
| `npm run devnet:logs`   | Tail the container logs.                                               |
| `npm run e2e:chain`     | Run the on-chain e2e suite against the running devnet.                 |
| `npm run test:devnet`   | Gate tests for the devnet tooling — offline, ~2s.                      |

### Environment overrides

| Variable            | Default     | Purpose                                      |
| ------------------- | ----------- | -------------------------------------------- |
| `DEVNET_PORT`       | `8000`      | Change if 8000 is taken                      |
| `DEVNET_HOST`       | `localhost` | Change for container-to-container access     |
| `DEVNET_SKIP_BUILD` | `false`     | Skip `cargo build` and use the existing wasm |

Nothing else is read from your environment. A devnet that silently picked up
your personal `STELLAR_*` variables is exactly the failure this removes.

---

## Running the on-chain test suite

```bash
npm run devnet        # if not already up
npm run e2e:chain
```

Sixteen tests across five scenarios, roughly 45 seconds. **Every assertion reads
authoritative on-chain state** — token balances come from a read-only simulation
of the SAC's `balance()`, escrow state from the contract's own `get_escrow`.
Nothing trusts an API response body.

| File                      | Scenario                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| `escrow-lifecycle.e2e.ts` | lock → confirm → release, 95/5 split asserted from balances              |
| `refund.e2e.ts`           | Full refund, no fee skimmed, no double-refund                            |
| `dispute.e2e.ts`          | dispute → resolve both ways; non-arbitrator rejected                     |
| `trustline-payout.e2e.ts` | Payout to a trustline-less account fails, strands nothing, then succeeds |
| `double-spend.e2e.ts`     | Replayed signed transaction cannot double-spend                          |

### Two findings worth knowing

**A replayed transaction can look like a success.** A replayed envelope has the
same transaction hash as the original. The sequence number was consumed, so it
can never be included again — but RPC resolves `getTransaction(hash)` against
the original, already-successful transaction. So the replay may return a
_success_ carrying the original's escrow id. Any caller that
submits-and-reads-`returnValue` without tracking hashes can mistake that for a
second escrow. It is not. The tests assert on balances and the escrow counter
for exactly this reason.

**`balance()` traps for a trustline-less account.** The SAC does not return `0`
— it fails with `trustline entry is missing for account`. No trustline is not
the same as a zero balance. Use `tokenBalanceOrZero` in
[test/chain/helpers.ts](../test/chain/helpers.ts) when you want the former.

---

## Pointing the backend at the devnet

```bash
npm run devnet
cp .env.devnet backend/.env
npm run dev
```

`.env.devnet` is a complete environment file, not a fragment: contract id, SAC
addresses, issuer, every keypair, and the admin signer the backend uses for
release/refund.

To load the devnet's marketplace datasets into the backend database — their
`sellerWallet` values are real devnet addresses, so a purchase actually pays the
devnet seller:

```bash
SEED_DATA_PATH=../data/devnet.datasets.json npm run seed --prefix backend
```

The seeder is idempotent; re-running skips datasets that already exist.

> **Known gap.** The backend currently pins `@stellar/stellar-sdk@13.x`, which
> cannot parse protocol-23+ transaction metadata (`TransactionMeta` v4). The
> devnet runs protocol 27, and so does public testnet — so this affects the
> backend against real testnet too, not just the devnet. The devnet tooling and
> chain tests use SDK 17 at the repo root and are unaffected. Upgrading the
> backend SDK is tracked separately.

---

## Safety: the network guard

**Nothing in the devnet path can touch public testnet or mainnet.**

[scripts/devnet/lib/guard.ts](../scripts/devnet/lib/guard.ts) rejects:

- any passphrase that is not `Standalone Network ; February 2017` (or its
  `--randomize-network-passphrase` variant), naming mainnet / testnet /
  futurenet explicitly when it refuses one
- any endpoint whose host is not loopback-ish — `horizon.stellar.org`,
  `horizon-testnet.stellar.org` and friends are refused
- mixed configurations, e.g. a local passphrase pointed at a public Horizon
- a network that _reports_ a different passphrase than expected, which catches a
  stale tunnel or another project's container on port 8000

The guard runs at every entry point and again inside every signing path. It is
pure and synchronous, and is covered by 28 offline gate tests
(`npm run test:devnet`).

---

## Determinism

`npm run devnet:reset` produces byte-identical account addresses and contract
id. Verified: `.env.devnet` is unchanged byte-for-byte across a full teardown
and reprovision, and `devnet:reset` fails loudly if that ever stops being true.

It holds because nothing depends on ledger state:

- **Accounts** — `sha256("hazina-devnet:v1:<role>")` used as the raw ed25519
  seed. One seed, one key.
- **Contract id** — the standard `ENVELOPE_TYPE_CONTRACT_ID` preimage over
  (network id, deployer address, salt). All three are fixed, so the id is
  computable _before the network boots_. The provisioner precomputes it and
  aborts if the deploy produces anything else.
- **SAC address** — a pure function of (asset, network).
- **Marketplace seed** — hand-written records with a frozen timestamp, not
  faker-generated.

Frozen expected values live in
[scripts/devnet/\_\_tests\_\_/determinism.test.ts](../scripts/devnet/__tests__/determinism.test.ts).
If a change breaks them, every contributor's `.env.devnet` has gone stale — which
is precisely what should block the merge.

---

## CI

[.github/workflows/devnet-chain-e2e.yml](../.github/workflows/devnet-chain-e2e.yml)

Deliberately **not** in the fast PR lane. It runs when:

- a PR is labelled **`chain-e2e`**
- `contracts/**`, `scripts/devnet/**` or `test/chain/**` changes on `main`
- nightly at 03:30 UTC
- manually via workflow dispatch

The job is blocking (`continue-on-error: false`), budgeted at ~10 minutes, and
reports its runtime back to the PR as a comment. The WASM build is cached twice:
`Swatinem/rust-cache` for the cargo tree, plus a direct artifact cache keyed on
the contract source hash, so an unrelated commit skips cargo entirely.

### Flake gate

Flaky chain tests are worse than no chain tests. The `soak` job runs the suite
**10 consecutive times** and fails if any run fails. It runs nightly and on
demand, and must be green before merging chain-affecting changes.

All ten runs execute against one devnet on purpose: reprovisioning between runs
would test provisioning rather than the suite's stability, and the tests assert
on balance _deltas_, so accumulated ledger state is exactly the condition they
must survive.

---

## Troubleshooting

### Port 8000 already in use

```
Error: docker compose up exited with code 1
```

Another service (often a local Horizon, Jenkins, or a previous devnet) holds the
port.

```bash
lsof -i :8000              # find the culprit
npm run devnet:down        # if it is a stale devnet
DEVNET_PORT=8100 npm run devnet   # or just move
```

`DEVNET_PORT` flows through to the compose file, the provisioner and the test
suite, so set it once per shell and everything follows.

### Docker not running

```
Docker is installed but the daemon is not running.
```

Start Docker Desktop (macOS/Windows) or `sudo systemctl start docker` (Linux).

### Docker out of memory

Symptoms: the container starts, then Horizon never reaches a ready state, or the
health wait times out after 3 minutes. `npm run devnet:logs` shows core being
killed mid-catchup.

Quickstart runs core + PostgreSQL + Horizon + RPC in one container. It needs
~2GB and the compose file requests 4GB. Docker Desktop defaults to less on some
installs.

**Fix:** Docker Desktop → Settings → Resources → Memory → 4GB or more, then
`npm run devnet:reset`.

### Stale volumes / weird ledger state

The container is ephemeral by design (no volume is mounted), but a half-torn-down
project can leave orphans.

```bash
npm run devnet:reset                       # the usual fix
docker compose -f docker-compose.devnet.yml -p hazina-devnet down -v --remove-orphans
docker volume prune                        # nuclear; affects other projects too
```

### `wasm32v1-none` target missing

```
The wasm32v1-none Rust target is missing.
```

```bash
rustup target add wasm32v1-none
```

### Health wait times out

```
Horizon did not become ready within 180s (42 attempts). Last error: …
```

Check the logs first — the last error in the message usually names the cause.

```bash
npm run devnet:logs
```

Most common causes: not enough Docker memory (see above), or the image still
pulling on a slow connection. The pull happens inside `docker compose up`, so a
first run on a slow link can look like a hang. Pre-pull it:

```bash
docker pull stellar/quickstart:v657-b1330.1-latest
```

### `Account not found` right after boot

Friendbot was not ready when funding was attempted. The provisioner waits for it
and retries with backoff, so this should not happen — if it does, it is a bug
worth reporting, with `npm run devnet:logs` output attached.

### Tests fail with "Escrow contract … is not deployed"

The devnet is up but was never provisioned (e.g. the container was started by
hand rather than through `npm run devnet`).

```bash
npm run devnet
```

### Chain tests fail after many local runs

Balances accumulate across runs; the tests assert on deltas so this is normally
fine. If state has become genuinely confusing:

```bash
npm run devnet:reset
```

---

## How it is built

```
docker-compose.devnet.yml        pinned quickstart image, ephemeral, 4GB
scripts/devnet/
  provision.ts                   the 10 steps above
  status.ts                      devnet:status
  reset.ts                       devnet:reset + determinism check
  lib/
    config.ts                    every constant, one place
    guard.ts                     the blast shield (pure, gate-tested)
    accounts.ts                  deterministic keys + contract id precompute
    health.ts                    backoff waiters (clock injected, gate-tested)
    chain.ts                     the only code that signs and submits
    compose.ts                   Docker wrapper with actionable errors
    artifacts.ts                 .env.devnet + devnet.accounts.json rendering
    marketplace.ts               deterministic dataset seed
    summary.ts                   the summary a contributor reads
  __tests__/                     91 offline gate tests, ~1.4s
test/chain/                      16 on-chain e2e tests, ~45s
```

### Why the SDK and not the Stellar CLI

Everything on-chain goes through `@stellar/stellar-sdk` — wasm upload, contract
deploy, SAC creation, invocations — rather than shelling out to `stellar`. The
CLI would be less code, but it adds a version-drift surface between every
contributor's machine and CI. The only external toolchain the devnet needs is
`cargo`, which the repo already requires for contract work.

### Image pinning

The quickstart image is pinned **by digest**, not by tag, per issue #457. The
tag `v657-b1330.1-latest` is informational — a human reading `docker ps` should
be able to tell what is running. Bump the tag and the digest together, never one
alone.

That version ships `stellar-core 28.0.1` / protocol 27, which is what public
testnet runs. The devnet matching production protocol is the point: a devnet on
an older protocol would not catch the class of bug this feature exists to find.

# Hazina Data Escrow

> _Hazina_ means **treasure** in Swahili.

A Web3 data marketplace where **sellers** list valuable on-chain intelligence and **buyers** — including autonomous AI agents — purchase access using micropayments on Stellar. A Soroban smart contract enforces escrow on-chain: buyers lock their own USDC into the contract, and it performs the 95/5 split on release — funds never route through a Hazina-controlled wallet. Claude AI synthesises every dataset into instant insights.

---

## Table of Contents

1. [What Problem Does Hazina Solve?](#what-problem-does-hazina-solve)
2. [Soroban Smart Contract](#soroban-smart-contract)
3. [How the App Works](#how-the-app-works)
4. [AI Research Agent](#ai-research-agent)
5. [Tech Stack](#tech-stack)
6. [Project Structure](#project-structure)
7. [Getting Started](#getting-started)
8. [Run with Docker](#run-with-docker)
9. [Pages & Features](#pages--features)
10. [API Reference](#api-reference)
11. [Payment Flow Deep Dive](#payment-flow-deep-dive)
12. [Environment Variables](#environment-variables)

---

## What Problem Does Hazina Solve?

**AI agents can't pay for data they need.** When an autonomous agent requires paid on-chain intelligence, it hits a wall — rate limits, waiting for a human to set up a subscription, or going without. Meanwhile, data creators can't charge per-use because traditional payment rails ($0.30 minimum fees) make micropayments impossible.

**Hazina fixes both sides:**

- Agents autonomously discover and pay for data via **x402 micropayments on Stellar** — no human needed.
- Sellers earn **USDC per query** at fractions of a cent, enforced by a **Soroban smart contract**.

---

## Soroban Smart Contract

The Hazina escrow contract is written in **Rust**, compiled to **WebAssembly**, and deployed on the **Stellar Soroban** smart contract platform.

> **⚠️ Current status — the on-chain escrow is not yet wired into the live payment flow.**
> The contract below is deployed and fully tested, but the running application does **not** invoke it today. In the current flow, buyers send USDC to a Hazina-controlled wallet, the backend verifies the payment on Horizon, and the backend forwards the seller's share from a hot wallet — a **custodial** model, not the trustless on-chain escrow described in this section. Making this section true is tracked in the non-custodial escrow epic ([#545](https://github.com/Hazina-Escrow/Hazina-Escrow/issues/545)). The rest of this section describes the **intended** design once that work lands.

### Deployed Contract

|                  |                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Contract ID**  | `CCPG2CSL6WDUA2IFUDHFN5SCJQUTFCLFKMTARALQ5RWGB2RGG345HEEH`                                                                          |
| **Network**      | Stellar Testnet                                                                                                                     |
| **Explorer**     | [View on Stellar Expert](https://stellar.expert/explorer/testnet/contract/CCPG2CSL6WDUA2IFUDHFN5SCJQUTFCLFKMTARALQ5RWGB2RGG345HEEH) |
| **Admin**        | `GA72WMKUB52OD2X437YOTJZXP3J7MV5G2RYC2JHFJJHWF6MBGQHVUMLO`                                                                          |
| **Platform Fee** | Default 5% (500 basis points), configurable per dataset                                                                             |
| **Source**       | `contracts/hazina-escrow/src/lib.rs`                                                                                                |

### What the Contract Does

The contract is designed as a **trustless escrow** — it is meant to hold a buyer's USDC payment and only release it when the Hazina backend confirms data delivery, so that neither the buyer nor the seller can cheat. This is the target design (see status note above); the diagram below shows the intended flow, not the current one:

```
Buyer           Contract              Seller
  │                │                    │
  │──lock(USDC)──► │                    │
  │                │  (funds held       │
  │                │   on-chain)        │
  │                │                    │
  │         [Backend verifies           │
  │          data was delivered]        │
  │                │                    │
  │                │──release(95%)────► │
  │                │──platform fee────► Admin
```

### Contract Functions

| Function                                               | Who Calls It           | What It Does                                                                          |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| `initialize(admin, fee_bps)`                           | Deployer (once)        | Sets the admin address and default platform fee (500 = 5%)                            |
| `pause(admin)`                                         | Hazina backend (admin) | Emergency circuit breaker: disables `lock`/`lock_multi` and `release`/`release_multi` |
| `unpause(admin)`                                       | Hazina backend (admin) | Resumes normal operations after a pause                                               |
| `is_paused()`                                          | Anyone                 | Returns whether the contract is currently paused                                      |
| `set_default_fee(admin, fee_bps)`                      | Hazina backend (admin) | Updates the fallback fee used when no dataset override exists                         |
| `set_dataset_fee(admin, dataset_id, fee_bps)`          | Hazina backend (admin) | Sets a custom platform fee for a specific dataset                                     |
| `clear_dataset_fee(admin, dataset_id)`                 | Hazina backend (admin) | Removes a dataset-specific fee override                                               |
| `set_whitelist_enforced(admin, enforced)`              | Hazina backend (admin) | Toggles whitelist mode for participant addresses                                      |
| `set_address_whitelisted(admin, address, whitelisted)` | Hazina backend (admin) | Marks an address as whitelist-approved                                                |
| `set_address_blacklisted(admin, address, blacklisted)` | Hazina backend (admin) | Blocks or unblocks a malicious address                                                |
| `lock(buyer, seller, token, amount, dataset_id)`       | Buyer                  | Transfers USDC from buyer into the contract. Returns an `escrow_id`.                  |
| `release(admin, escrow_id)`                            | Hazina backend (admin) | Sends seller share to seller, platform fee to treasury. Fires a `released` event.     |
| `refund(admin, escrow_id)`                             | Hazina backend (admin) | Returns full amount to buyer if something goes wrong.                                 |
| `get_escrow(escrow_id)`                                | Anyone                 | Reads an escrow record (buyer, seller, amount, status).                               |
| `get_default_fee()`                                    | Anyone                 | Returns the default platform fee in basis points.                                     |
| `get_dataset_fee_config(dataset_id)`                   | Anyone                 | Returns the effective fee config for a dataset override.                              |
| `get_address_policy(address)`                          | Anyone                 | Returns whitelist and blacklist status for an address.                                |

### Why Soroban?

Once the escrow is wired into the live flow ([#545](https://github.com/Hazina-Escrow/Hazina-Escrow/issues/545)), it gives:

- **On-chain enforcement** — the payment routing (95/5 split) becomes code, not promises.
- **Trustless** — buyers won't have to trust the Hazina server to route their money correctly.
- **Auditable** — every `lock`, `release`, and `refund` emits an on-chain event visible to anyone.
- **Native USDC** — operates directly on Stellar's USDC, same asset as the x402 payments.

### Building & Deploying the Contract

```bash
# Install Stellar CLI
brew install stellar-cli

# Build
cd contracts/hazina-escrow
stellar contract build

# Add your keypair
stellar keys add hazina-admin --secret-key

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/hazina_escrow.wasm \
  --source hazina-admin \
  --network testnet

# Initialise (run once after deploy)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source hazina-admin \
  --network testnet \
  -- initialize \
  --admin <YOUR_WALLET> \
  --platform_fee_bps 500
```

### Verification Scripts

```bash
npm run contracts:check
npm run contracts:formal
```

- `contracts:check` runs `cargo fmt --check`, `cargo clippy`, the full Rust test suite, and a release wasm build.
- `contracts:formal` runs the invariant-oriented contract tests prefixed with `formal_`.

---

## How the App Works

### Step 1 — Seller Lists Data

```
Seller → /sell page
  → Name, description, price, Stellar wallet address, JSON data
  → Click "Publish to Marketplace"
  → Dataset live instantly, earnings tracked per query
```

### Step 2 — Buyer Finds a Dataset

```
Buyer → /marketplace
  → Filter by type (whale wallets, DeFi yields, sentiment, risk scores…)
  → Click "Buy Query" on any dataset
  → Modal shows price, seller wallet, payment instructions
```

### Step 3 — The Non-Custodial Escrow Flow

The buyer locks their own USDC **into the Soroban contract** from their own
wallet. The backend never receives or forwards the buyer's funds — it only
triggers the contract's pre-programmed 95/5 split once data is delivered.

```
Browser (Freighter)        Backend (admin)          Escrow Contract
  │                           │                        │
  │  POST /api/query/:id       │                        │
  │ ─────────────────────────► │                        │
  │ ◄───────────────────────── │                        │
  │  402 { mode: "escrow",    │                        │
  │    escrowContractId,      │                        │
  │    amount, memo }         │                        │
  │                           │                        │
  │  POST /payments/escrow/lock/build                  │
  │ ─────────────────────────► │  build unsigned lock() │
  │ ◄───────────────────────── │                        │
  │  { xdr }                  │                        │
  │                           │                        │
  │  [Buyer signs in Freighter]                        │
  │  POST /payments/escrow/lock/submit { signedXdr }   │
  │ ─────────────────────────► │  lock(buyer,seller,…) │
  │                           │ ──────────────────────►│  funds held on-chain
  │ ◄───────────────────────── │ ◄──────────────────────│
  │  { escrowId }             │  escrow_id             │
  │                           │                        │
  │  POST /api/verify/:id/escrow { escrowId }          │
  │ ─────────────────────────► │  get_escrow() ✓       │
  │                           │  [Claude AI summary]   │
  │                           │  release(escrow_id) ──►│  95% seller / 5% treasury
  │ ◄───────────────────────── │                        │
  │  200 { data, AI summary } │                        │
```

**Verification on every escrow release:**

1. The on-chain `EscrowRecord` is read from the contract (authoritative state)
2. The escrow's `dataset_id` matches the dataset being unlocked
3. The escrow's `seller` matches the dataset's seller wallet
4. The locked `amount` equals the dataset price (within 0.001 tolerance)
5. The escrow is not already `released` or `refunded`

> **Demo / custodial fallback.** When `ESCROW_CONTRACT_ID` is **unset**, Hazina
> falls back to a labelled custodial path: the buyer pays a Hazina-controlled
> wallet and the backend forwards the seller's 95% from a hot wallet. The 402
> response advertises `mode: "custodial-demo"` so this is never mistaken for the
> non-custodial flow. Set `ESCROW_CONTRACT_ID` for real escrow.

### Step 4 — Data + AI Delivered

```
Buyer receives:
  ✓ Full raw dataset (JSON, downloadable)
  ✓ Claude AI executive summary (3 key insights)
  ✓ Answer to their custom question
  ✓ On-chain proof: the escrow release tx (funds split by the contract)
```

### Step 5 — Contract Splits the Funds On-Chain

```
On release(escrow_id) the CONTRACT (not the backend) transfers:
  → 95% → seller's Stellar wallet
  → 5%  → platform treasury
  → Emits a `released` event, auditable on Stellar Expert
  → Stats updated (queriesServed, totalEarned)
```

---

## AI Research Agent

The flagship feature. An autonomous agent that **buys data from multiple sellers and synthesises a research report** — with no human in the loop.

### How It Works

```
User pays 1 USDC to agent escrow wallet
  │
  ▼
Agent verifies payment on Stellar (real tx)
  │
  ▼
Agent autonomously pays 4 data sellers via x402:
  ├── DeFi Yield Snapshot     →  0.02 USDC
  ├── Whale Wallet Movements  →  0.05 USDC
  ├── Wallet Risk Scores      →  0.03 USDC
  └── Social Sentiment        →  0.04 USDC
  │
  ▼
Claude synthesises all 4 datasets into a research report:
  ├── Top opportunity (protocol, APY, chain, risk level)
  ├── Reasoning (cross-referencing all 4 data sources)
  ├── 2 alternative opportunities
  └── Risk warnings
  │
  ▼
Agent keeps 0.86 USDC profit
```

### Agent Endpoints

| Endpoint                        | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `GET /api/agent/info`           | Agent wallet address, fee, seller list, profit model  |
| `POST /api/agent/research`      | Real mode — requires 1 USDC Stellar payment + txHash  |
| `POST /api/agent/research/demo` | Demo mode — simulates payments, calls Claude for real |

### Example Query

```bash
curl -X POST http://localhost:3001/api/agent/research/demo \
  -H "Content-Type: application/json" \
  -d '{"query": "best low risk USDC yield with $500 budget"}'
```

Returns a full JSON research report with top opportunity, reasoning, alternatives, and warnings.

---

## Tech Stack

| Layer              | Technology                             | What It Does                                          |
| ------------------ | -------------------------------------- | ----------------------------------------------------- |
| **Frontend**       | React 18 + Vite + TypeScript           | Marketplace, sell, dashboard, agent UI                |
| **Styling**        | TailwindCSS                            | Afrofuturist dark gold theme                          |
| **Backend**        | Node.js + Express + TypeScript         | API server, payment verification, agent orchestration |
| **Smart Contract** | Rust + Soroban (WebAssembly)           | On-chain escrow, trustless payment routing            |
| **Blockchain**     | Stellar Testnet + x402 protocol        | Micropayments, USDC settlement                        |
| **AI**             | Anthropic Claude (`claude-sonnet-4-6`) | Data analysis + research synthesis                    |
| **Storage**        | JSON file (`data/datasets.json`)       | Datasets and transaction history                      |

---

## Project Structure

```
Hazina-Escrow/
│
├── contracts/                           ← Soroban smart contracts (Rust)
│   └── hazina-escrow/
│       ├── Cargo.toml                   ← Rust package config
│       └── src/lib.rs                   ← Escrow contract: lock/release/refund
│
├── backend/                             ← Node.js API server (port 3001)
│   ├── .env                             ← API keys, wallet secrets, contract ID
│   └── src/
│       ├── main.ts                      ← Express setup, routes
│       ├── common/
│       │   └── storage.ts               ← Reads/writes data/datasets.json
│       ├── datasets/
│       │   └── datasets.router.ts       ← List, create, get datasets
│       ├── payments/
│       │   ├── payments.router.ts       ← x402 flow + seller auto-payment
│       │   └── stellar.service.ts       ← Stellar Horizon payment verification
│       ├── agent/
│       │   ├── agent.router.ts          ← /api/agent/* endpoints
│       │   ├── agent.service.ts         ← Orchestrates: verify → buy → synthesise
│       │   └── agent.wallet.ts          ← Signs & sends USDC from agent keypair
│       └── ai/
│           ├── claude.service.ts        ← Dataset summaries for marketplace
│           └── research.service.ts      ← Full research report synthesis
│
├── frontend/                            ← React app (port 5173)
│   └── src/
│       ├── App.tsx                      ← Routing
│       ├── pages/
│       │   ├── LandingPage.tsx          ← Hero, stats, how-it-works
│       │   ├── MarketplacePage.tsx      ← Browse, filter, buy datasets
│       │   ├── SellPage.tsx             ← Upload data, set price, publish
│       │   ├── DashboardPage.tsx        ← Earnings & transaction history
│       │   └── AgentPage.tsx            ← AI research agent UI
│       ├── components/
│       │   ├── layout/Navbar.tsx        ← Navigation
│       │   └── ui/
│       │       ├── DatasetCard.tsx      ← Dataset cards in marketplace
│       │       └── QueryModal.tsx       ← Payment flow modal
│       └── lib/
│           ├── api.ts                   ← Typed API client (datasets + agent)
│           └── utils.ts                 ← Formatting helpers
│
├── data/
│   └── datasets.json                    ← 6 seeded datasets + 42 transactions
│
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- Rust + `stellar-cli` (only needed to rebuild the contract)

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure environment

Edit `backend/.env`:

```bash
PORT=3001
CORS_ALLOWED_ORIGINS=http://localhost:5173

# Required
ANTHROPIC_API_KEY=sk-ant-...

# Escrow wallet (receives buyer payments, forwards to sellers)
ESCROW_WALLET=GA72WMKUB52OD2X437YOTJZXP3J7MV5G2RYC2JHFJJHWF6MBGQHVUMLO
ESCROW_SECRET=your_escrow_wallet_secret_here

# Agent wallet (pays data sellers autonomously)
AGENT_WALLET_SECRET=your_agent_wallet_secret_here
AGENT_WALLET_PUBLIC=your_agent_wallet_public_key_here

# Soroban escrow contract (Stellar Testnet)
ESCROW_CONTRACT_ID=CCPG2CSL6WDUA2IFUDHFN5SCJQUTFCLFKMTARALQ5RWGB2RGG345HEEH

PLATFORM_FEE=0.05
```

### 3. Start the app

```bash
# Terminal 1 — Backend
cd backend && npm run start:dev

# Terminal 2 — Frontend
cd frontend && npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

### 4. Test without a real wallet

Every dataset has **demo mode** — in the buy modal, tick **"Demo mode"** to get a full Claude AI analysis without sending a real Stellar payment.

The AI Agent also has demo mode — go to `/agent`, type any query, click **Run Agent**.

---

## Run with Docker

### Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- A configured `backend/.env` file

### Development (hot reload)

```bash
docker compose up --build
```

- Frontend (Vite HMR): http://localhost:5173
- Backend API: http://localhost:3001
- Backend uses `backend/.env` via `env_file`
- `data/datasets.json` is bind-mounted to `/app/data/datasets.json` so data persists across container restarts

### Production-style local run

```bash
docker compose -f docker-compose.prod.yml up --build
```

- Frontend is built and served by nginx on http://localhost
- nginx proxies `/api/*` traffic to the backend container
- Backend is compiled with `tsc` and run via `node dist/main.js`

### Stop containers

```bash
docker compose down
docker compose -f docker-compose.prod.yml down
```

### Image vulnerability scanning

The production backend and frontend images are scanned for known CVEs by the
[`Container Image Scan`](.github/workflows/container-scan.yml) GitHub Actions
workflow. On every pull request and push to `main` that touches `backend/` or
`frontend/`, each image is built and scanned with
[Trivy](https://github.com/aquasecurity/trivy); the build fails on any fixable
`HIGH` or `CRITICAL` OS/library vulnerability. Results are also published to the
repository's **Security → Code scanning** tab, and a weekly scheduled run
re-scans the images to catch CVEs disclosed after the last build.

To reproduce a scan locally:

```bash
docker build -t hazina-backend:scan --target production ./backend
trivy image --severity HIGH,CRITICAL --ignore-unfixed hazina-backend:scan
```

---

## Pages & Features

### `/` — Landing Page

- Live animated stats (datasets, queries, USDC earned)
- How It Works walkthrough
- Featured datasets
- Links to marketplace and agent

### `/marketplace` — Browse & Buy

- 6 seeded datasets (whale wallets, DeFi yields, risk scores, sentiment, NFT, arbitrage)
- Filter by type, sort by price/popularity, search
- Click any card → payment modal with demo mode checkbox

### `/sell` — List Your Data

- Form: name, description, type, price, Stellar wallet, JSON data
- Live preview card
- Earnings calculator (10 / 100 / 1000 query projections)
- Instant publish to marketplace

### `/agent` — AI Research Agent

- Natural language query input
- Example queries to click
- Returns: top opportunity, reasoning, 2 alternatives, warnings, full analysis
- Shows payment trail (4 seller payments + agent profit)

### `/dashboard` — Earnings & History

- Real-time transaction list
- Per-dataset earnings
- Queries served counter

---

## API Reference

### Datasets

| Method | Endpoint                         | Description                  |
| ------ | -------------------------------- | ---------------------------- |
| `GET`  | `/health`                        | Server health check          |
| `GET`  | `/api/datasets`                  | All datasets (metadata only) |
| `GET`  | `/api/datasets/stats`            | Platform totals              |
| `GET`  | `/api/datasets/:id`              | Single dataset metadata      |
| `POST` | `/api/datasets`                  | Create new listing           |
| `GET`  | `/api/datasets/:id/transactions` | Transaction history          |

### Payments (x402)

| Method | Endpoint               | Description                                                   |
| ------ | ---------------------- | ------------------------------------------------------------- |
| `POST` | `/api/query/:id`       | Initiate query → 402 with payment instructions                |
| `POST` | `/api/verify/:id`      | Submit txHash → verify on Stellar → release data + pay seller |
| `POST` | `/api/verify/:id/demo` | Demo mode — skip payment, get AI analysis                     |

### AI Agent

| Method | Endpoint                   | Description                                           |
| ------ | -------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/agent/info`          | Agent wallet, fee, sellers, profit model              |
| `POST` | `/api/agent/research`      | Real mode — requires txHash of 1 USDC payment         |
| `POST` | `/api/agent/research/demo` | Demo mode — simulated payments, real Claude synthesis |

---

## Payment Flow Deep Dive

### What is x402?

HTTP's `402 Payment Required` status code — defined in 1991, never widely used until now. Hazina implements it as a machine-readable payment protocol: any client (browser or AI agent) receives structured payment instructions and can act on them without human intervention.

### Why Stellar?

- **3–5 second finality** — no waiting for confirmations
- **$0.00001 fees** — viable for $0.02 micropayments
- **Native USDC** — stable, no price volatility
- **Soroban** — WebAssembly smart contracts in any language

### Seller Payment Flow (Real Mode)

```
1. Buyer connects Freighter and requests an unsigned lock() tx from
   POST /payments/escrow/lock/build
2. Buyer signs it — 0.05 USDC is locked INTO the escrow contract (not a Hazina wallet)
3. Buyer submits the signed tx via POST /payments/escrow/lock/submit → gets escrowId
4. Buyer calls POST /api/verify/:id/escrow { escrowId }
5. Backend reads get_escrow() (amount ✓ seller ✓ dataset ✓), Claude generates the summary
6. Backend calls release(escrowId) — the CONTRACT sends 95% to seller, 5% to treasury
7. Response includes: data + AI summary
   (When ESCROW_CONTRACT_ID is unset, the legacy custodial demo path is used instead.)
```

### Agent Payment Flow (Real Mode)

```
1. User sends 1 USDC to agent escrow wallet
2. POST /api/agent/research { query, txHash }
3. Agent verifies incoming payment on Stellar
4. For each seller, the agent locks funds in the escrow contract, then the
   backend releases — the contract performs the 95/5 split on-chain
   (falls back to a direct hot-wallet payment when no contract is configured)
5. Claude synthesises all 4 datasets into research report
6. Response: report + payment trail + agent profit
```

---

## Seeded Datasets

| ID     | Dataset                                   | Price | Seller Wallet |
| ------ | ----------------------------------------- | ----- | ------------- |
| ds-001 | Top 100 Whale Wallet Movements            | $0.05 | `GB37MSLK...` |
| ds-002 | DEX Arbitrage Signals — Last 24hrs        | $0.10 | `GA62DGF2...` |
| ds-003 | DeFi Yield Snapshot — 20+ Protocols       | $0.02 | `GD4GDOPE...` |
| ds-004 | Wallet Risk Scores — Top 500 DeFi Wallets | $0.03 | `GBMVCBYW...` |
| ds-005 | NFT Floor Price Movements — Last 7 Days   | $0.02 | `GCDDN2PN...` |
| ds-006 | Crypto Social Sentiment Scores            | $0.04 | `GC42G7GQ...` |

All seller wallets are funded Stellar testnet accounts with USDC trustlines, ready to receive payments.

---

## Environment Variables

### Backend Variables (`backend/.env`)

| Variable                 | Required | Description                                                             |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Yes      | Claude API key — [console.anthropic.com](https://console.anthropic.com) |
| `DATABASE_URL`           | Yes      | Database connection string (e.g. `file:./sqlite.db`)                    |
| `ESCROW_WALLET`          | Yes      | Stellar address that receives buyer payments                            |
| `AGENT_WALLET_SECRET`    | Yes      | Agent's Stellar secret key (signs outgoing seller payments)             |
| `ESCROW_CONTRACT_ID`     | Yes      | Soroban contract address for on-chain escrow enforcement                |
| `API_KEY`                | Yes      | Key for dataset creation (must match frontend `VITE_API_KEY`)           |
| `ADMIN_API_KEY`          | Yes      | Key for administrative actions like backups                             |
| `SELLER_JWT_SECRET`      | Yes      | Secret for signing/verifying seller dashboard JWTs                      |
| `PAYMENT_WEBHOOK_SECRET` | Yes      | Shared secret for verifying incoming payment webhooks                   |
| `STELLAR_NETWORK`        | No       | 'testnet' or 'mainnet' (default: 'testnet')                             |
| `PORT`                   | No       | API port (default: 3001)                                                |
| `FRONTEND_URL`           | No       | URL of the frontend for CORS                                            |

### Frontend Variables (`frontend/.env`)

| Variable                       | Required | Description                                              |
| ------------------------------ | -------- | -------------------------------------------------------- |
| `VITE_API_URL`                 | Yes      | Base URL of the backend API (e.g. http://localhost:3001) |
| `VITE_API_KEY`                 | Yes      | API key for backend auth (must match backend `API_KEY`)  |
| `VITE_STELLAR_NETWORK`         | No       | 'testnet' or 'public' (default: 'testnet')               |
| `VITE_USDC_ISSUER`             | No       | Override for USDC asset issuer address                   |
| `VITE_MAX_CONCURRENT_REQUESTS` | No       | Limit on parallel API calls (default: 8)                 |

---

## Design

Afrofuturist aesthetic — luxury dark theme inspired by the Kente cloth geometric patterns of West Africa. The name _Hazina_ (treasure in Swahili) reflects the untapped value in on-chain intelligence.

| Token        | Value                            |
| ------------ | -------------------------------- |
| Background   | `#0A0A0F` (void black)           |
| Accent       | `#C9A84C` (gold)                 |
| Heading font | Playfair Display                 |
| Body font    | DM Sans                          |
| Cards        | Glass morphism with gold borders |
| Patterns     | Kente-inspired SVG geometry      |

---

## API Versioning

All backend HTTP routes are now served under /api/v1/.

- The server still accepts requests to legacy /api/ paths and redirects them to /api/v1/ with a deprecation Warning header.
- During the migration we updated the frontend and backend tests to use /api/v1/.

If you're running locally, update any proxies or API clients to use /api/v1/.

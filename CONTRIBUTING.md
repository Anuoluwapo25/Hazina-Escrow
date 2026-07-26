# Contributing to Hazina Escrow

Hazina is a Web3 data marketplace on Stellar — data sellers list on-chain intelligence, buyers pay per query using the x402 micropayment protocol, and an autonomous AI Research Agent synthesises insights via Claude. Contributions that move it from a working demo to a live, production-grade product are very welcome.

---

## Table of Contents

- [Quick Setup](#quick-setup)
- [Project Structure](#project-structure)
- [Branch & Commit Conventions](#branch--commit-conventions)
- [Code Quality Standards](#code-quality-standards)
- [Testing Requirements](#testing-requirements)
- [Deployment CI Secrets](#deployment-ci-secrets)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Issue Labels Explained](#issue-labels-explained)
- [Getting Help](#getting-help)

---

## Quick Setup

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| npm | 10+ |
| Rust | 1.75+ (for contract work) |
| Stellar CLI (`stellar`) | latest (for contract work) |

### 1. Clone and install

```bash
git clone https://github.com/<your-fork>/Hazina-Escrow.git
cd Hazina-Escrow
npm install          # root workspace
cd backend && npm install
cd ../frontend && npm install
```

### 2. Environment variables

Copy the example file and fill in your values:

```bash
cp .env.example backend/.env
```

Required variables are documented in [.env.example](.env.example). You do **not** need a funded Stellar wallet to run in demo mode — the backend has a `demo` route that bypasses real payments.

### 3. Start dev servers

```bash
# Terminal 1 — backend (port 3001)
cd backend && npm run start:dev

# Terminal 2 — frontend (port 5173)
cd frontend && npm run dev
```

Open `http://localhost:5173`. Use "Demo Mode" checkboxes in the UI to test without real USDC.

### 4. Run the test suite

```bash
# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test

# Rust contract tests
cd contracts/hazina-escrow && cargo test
```

All tests must pass before opening a PR.

---

## Project Structure

```
Hazina-Escrow/
├── backend/src/
│   ├── main.ts                  # Express app entry, env validation
│   ├── common/storage.ts        # Data layer (currently JSON, target: DB)
│   ├── datasets/                # CRUD endpoints for dataset listings
│   ├── payments/                # x402 flow, Stellar verification, escrow
│   ├── agent/                   # Autonomous research agent + wallet
│   └── ai/                      # Claude summarisation & research synthesis
├── frontend/src/
│   ├── pages/                   # Route-level page components
│   ├── components/              # Reusable UI components
│   └── lib/                     # API client, utilities
├── contracts/hazina-escrow/
│   └── src/lib.rs               # Soroban escrow contract (lock/release/refund)
└── data/datasets.json           # Seed data (not a real DB — see issue #12)
```

---

## Branch & Commit Conventions

### Branch naming

```
<type>/<short-description>

feat/add-rate-limiting
fix/update-claude-model
chore/add-env-example
test/backend-unit-tests
docs/api-swagger
```

Types: `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `perf`

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(scope): <short imperative description>

feat(payments): add zod validation to verify endpoint
fix(ai): update claude model from deprecated claude-3-haiku-20240307
test(storage): add unit tests for txHashUsed replay prevention
chore(ci): add GitHub Actions workflow for lint and test
```

- Use present tense: "add", not "added"
- Keep subject under 72 characters
- Reference the issue: `Closes #12` in the body

### One concern per PR

Don't mix a bug fix with a refactor in the same PR. Reviewers can't reason about two different things at once.

---

## Code Quality Standards

These are enforced by ESLint + Prettier on every PR. Run `npm run lint` and `npm run format` before pushing.

### TypeScript

**Always type function signatures explicitly.** Avoid `any`.

```typescript
// Bad
async function getDataset(id) {
  return readStore().datasets.find(d => d.id === id);
}

// Good
async function getDataset(id: string): Promise<Dataset | undefined> {
  return readStore().datasets.find((d) => d.id === id);
}
```

**Use zod for runtime validation at all API boundaries.**

```typescript
import { z } from 'zod';

const VerifyBodySchema = z.object({
  txHash: z.string().min(1).max(128),
  buyerQuestion: z.string().max(500).optional(),
});

// In your route handler:
const parsed = VerifyBodySchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({ error: parsed.error.flatten() });
}
const { txHash, buyerQuestion } = parsed.data;
```

**Always handle errors explicitly.** Don't swallow unknowns.

```typescript
// Bad
} catch (e) {
  console.error(e);
}

// Good
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown error';
  logger.error({ err, context: 'payment-verification' }, message);
  return res.status(500).json({ error: 'Verification failed', detail: message });
}
```

### React / Frontend

**Keep page components thin.** Data fetching and business logic belong in custom hooks or `lib/api.ts`, not in JSX.

```tsx
// Bad — fetching inside the component body
export function MarketplacePage() {
  const [datasets, setDatasets] = useState([]);
  useEffect(() => { fetch('/api/datasets').then(...) }, []);
  ...
}

// Good — fetch in a hook, component only renders
export function MarketplacePage() {
  const { datasets, isLoading, error } = useDatasets();
  ...
}
```

**Use discriminated unions for async state** instead of separate `loading`/`error` booleans:

```typescript
type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string };
```

**No magic strings or numbers.** Move constants to a shared `lib/constants.ts`:

```typescript
// Bad
const sellerAmount = dataset.pricePerQuery * 0.95;

// Good
import { PLATFORM_FEE_RATE } from '../lib/constants';
const sellerAmount = dataset.pricePerQuery * (1 - PLATFORM_FEE_RATE);
```

### Rust / Smart Contract

- Every public function needs a `#[test]` covering the happy path and at least one failure path.
- Use `soroban_sdk::panic_with_error!` over panics for predictable error codes.
- Bump the contract version in `Cargo.toml` for any interface change.

### General

- **No `console.log` in committed code.** Use the `logger` (pino) instead.
- **No hardcoded secrets, keys, or addresses.** All config comes from environment variables via `.env`.
- **No commented-out code.** Delete it — git history preserves the past.
- **Write self-documenting names.** Comments should explain *why*, not *what*.

---

## Testing Requirements

Every PR that touches backend logic must include or update tests. PRs with zero test coverage for new code will not be merged.

---

## Deployment CI Secrets

The repository includes `.github/workflows/deploy-frontend.yml` to automate frontend deployment to Vercel and Netlify from `main`.

Add these repository secrets before enabling production deploys:

### Vercel

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

### Netlify

- `NETLIFY_AUTH_TOKEN`
- `NETLIFY_SITE_ID`

If one provider's secrets are missing, that provider's deploy job is skipped while other jobs can still run.

### Backend (Vitest)

```typescript
// File: backend/src/payments/__tests__/payments.router.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../main';

// Mock the storage layer — don't touch the real JSON file in tests
vi.mock('../../common/storage', () => ({
  getDataset: vi.fn(),
  txHashUsed: vi.fn().mockReturnValue(false),
  updateDataset: vi.fn(),
  addTransaction: vi.fn(),
}));

describe('POST /api/verify/:id', () => {
  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockReturnValue(undefined);
    const res = await request(app).post('/api/verify/nonexistent').send({ txHash: 'abc' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when txHash is missing', async () => {
    const res = await request(app).post('/api/verify/some-id').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/txHash/i);
  });
});
```

**Coverage target:** 80% line coverage on all new files.

### Frontend (Vitest + React Testing Library)

```tsx
// File: frontend/src/components/ui/__tests__/QueryModal.test.tsx

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryModal } from '../QueryModal';
import { mockDataset } from '../../__fixtures__/datasets';

it('shows payment instructions after clicking "Query Dataset"', () => {
  render(<QueryModal dataset={mockDataset} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /query dataset/i }));
  expect(screen.getByText(/payment required/i)).toBeInTheDocument();
});
```

### What does NOT need tests

- Visual-only changes (colour, spacing, typography)
- Straight pass-through functions with no logic
- Seed data files

---

## Submitting a Pull Request

1. **Fork** the repo and create your branch from `main`.
2. Make your changes following the standards above.
3. Run `npm test` in both `backend/` and `frontend/` — all green.
4. Run `npm run lint` — zero warnings.
5. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully — especially the "How to test" section.
6. Link the issue your PR closes: `Closes #<number>` in the PR description.
7. Request a review. A maintainer will respond within 48 hours.

### PR size

Aim for PRs under 400 lines changed. Large PRs are hard to review and more likely to have subtle bugs. If your issue is big, split it into sequential PRs (e.g., "add DB schema" → "migrate storage layer" → "add DB tests").

---

## Issue Labels Explained

| Label | Meaning |
|-------|---------|
| `good first issue` | Well-scoped, isolated, good for newcomers |
| `bug` | Something that is broken or incorrect |
| `enhancement` | New capability or improvement |
| `security` | Security-sensitive change — discuss in issue before coding |
| `infrastructure` | CI, Docker, deployment, env config |
| `tests` | Adding or fixing tests |
| `frontend` | React/Vite/UI changes only |
| `backend` | Express/Node.js changes only |
| `contract` | Soroban Rust contract changes |
| `ai` | Claude API or research agent changes |
| `database` | Storage layer changes |
| `blocked` | Waiting on another issue or external dependency |

---

## Getting Help

- Open a **Discussion** on GitHub for questions about architecture or approach before writing code.
- Tag `@Anuoluwapo25` if you're stuck on Stellar testnet setup or the x402 payment flow.
- Demo mode works entirely without a Stellar wallet — use it for all frontend and AI-related issues.

# Hazina Overhaul — Live Marketplace + Real Data

## Goal
Turn the marketplace from static placeholder datasets into **live, provider-backed data feeds** that refresh from real external sources, with a proper provider abstraction, richer schema, categories, freshness indicators, and an agent that buys from these real feeds. Ambitious scope: touches backend data layer, a new provider subsystem, DB schema, seed, agent alignment, and marketplace/detail frontend.

## Design principles
- **Graceful degradation**: providers fall back to structured, realistic snapshots when offline (CI/tests have no network). Never crash on a failed fetch — reuse the existing circuit-breaker pattern.
- **No churn for its own sake**: reuse existing modular structure; the main new structure is `backend/src/providers/`.
- **Backwards compatible API**: extend the dataset payload, don't break existing consumers/tests.

---

## Backend

### 1. Provider subsystem — `backend/src/providers/`
- `provider.types.ts` — `DataProvider` interface: `{ id, type, category, refresh(): Promise<ProviderSnapshot> }` where `ProviderSnapshot = { data, points, fetchedAt, live }`.
- `defillama.provider.ts` — real DeFi yields from `https://yields.llama.fi/pools` (free, no key) → `yield-data`.
- `coingecko.provider.ts` — wraps existing `MarketService` (finally connecting the dead code) for prices/market metrics → `sentiment` / `market` datasets.
- `stellar-horizon.provider.ts` — real on-chain large-payment/whale movement summaries via Horizon (already have `HORIZON_URL`) → `whale-wallets`.
- `risk.provider.ts` — derives protocol risk scores from DeFiLlama TVL/volatility → `risk-scores`.
- `registry.ts` — maps dataset `type` → provider; central list of provider-backed types.
- Each provider wrapped in a circuit breaker; on failure returns last-known or a bundled realistic fallback snapshot.

### 2. Refresh scheduler — `backend/src/providers/refresh.scheduler.ts`
- Interval worker (like `backup.scheduler.ts`) that refreshes live datasets, updates `data` + `lastRefreshedAt`.
- Start/stop wired into `main.ts` lifecycle alongside existing workers. Configurable interval env `DATA_REFRESH_INTERVAL_MS` (default 5 min), disabled when unset in test.

### 3. Schema upgrade (Drizzle migration, pg + sqlite)
Add to `datasets`: `category` (text), `provider` (text, nullable), `lastRefreshedAt` (text, nullable), `live` (bool/int default false), `tags` (text/json). Generate migration, update both pg + sqlite tables in `schema.ts`, update `Dataset` interface in `storage.ts` and mappers in `datasets.repository.ts`.

### 4. New coherent seed
Rewrite `backend/data/datasets.json` + `backend/src/db/seed.ts` with ~16 real, categorized datasets whose `type` values match the provider registry and the agent's `SELLER_TYPES`. Live datasets get an initial provider snapshot; static ones get realistic structured data (not random UUIDs). Fix the `seed.ts` faker script to emit the same coherent types/categories.

### 5. Routes (`datasets.router.ts`)
- `GET /` list: add `category` filter and `live` filter; include `category`, `live`, `lastRefreshedAt`, `provider` in the item payload.
- `GET /:id/preview` — returns a small live sample (redacted) for the detail page.
- Keep existing pagination/sort/search intact.

### 6. Agent alignment (`agent.service.ts` / `research.service.ts`)
- Make `SELLER_TYPES` reference the real registry types (dynamic pick of best-priced live dataset per type instead of hardcoded assumptions). This finally makes the flagship agent consume the live marketplace.

---

## Frontend

### 7. Marketplace (`MarketplacePage.tsx`, `DatasetCard.tsx`)
- Category tabs/filter driven by new `category` field.
- "LIVE" badge + relative freshness ("updated 2m ago") from `lastRefreshedAt`; provider attribution chip.

### 8. Dataset detail (`DatasetDetailPage.tsx`)
- Live preview panel (calls `/:id/preview`), freshness indicator, small sparkline (recharts already installed) of `points`.

### 9. Landing/stats
- Surface real "live feeds" count and last-refresh in stats.

### 10. Shared types
- Extend `DatasetMeta` in `frontend/src/lib/api.ts` with the new fields; keep zod parsing in sync.

---

## Verification
- Backend: `npm run typecheck --prefix backend`, `npm run test --prefix backend` (add provider unit tests with mocked fetch + fallback tests; scheduler test).
- Frontend: `npm run typecheck --prefix frontend`, `npm run test --prefix frontend` (marketplace/detail render with new fields).
- Root `npm run lint` + `format:check`.
- Providers tested offline (mocked fetch) so CI stays green without network.

## Out of scope this pass
- Soroban contract changes; agent streaming/tool-loop (that was the alternate direction, not chosen); auth model changes.

## Sequencing
1. Schema + storage + repository + migration
2. Provider subsystem + registry + fallbacks + tests
3. Refresh scheduler + main.ts wiring
4. New seed + agent type alignment
5. Routes (list fields, category/live filter, preview)
6. Frontend api types → marketplace → detail → landing
7. Full verify + lint/format

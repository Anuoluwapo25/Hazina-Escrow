/**
 * access-pass.plans.ts — minimal off-chain index of subscription plans.
 *
 * Soroban cannot enumerate contract storage keys cheaply, so "list the plans
 * for this dataset" is served from a small local table populated by polling
 * the access-pass contract's `plan_new` / `plan_set` events through Soroban
 * RPC — the same chain-observation pattern the receipts anchor worker and the
 * Sentinel ingest loop use.
 *
 * The table is regenerable operational state, NOT business data: it can be
 * rebuilt at any time by replaying events from ACCESS_PASS_START_LEDGER
 * (default: the latest ledger at boot), so it deliberately stays out of the
 * main Store. A restart only loses plans defined before boot unless an
 * operator pins the start ledger.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  SOROBAN_RPC_URL,
  getAccessPassContractId,
  isAccessPassConfigured,
} from '../lib/stellar.config';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { stroopsToAmount } from '../lib/access-pass.client';
import { logger } from '../lib/logger';

const sorobanBreaker = getCircuitBreaker('soroban-rpc', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

const POLL_INTERVAL_MS = 15_000;
/** Page size for getEvents; small contract, small pages are fine. */
const PAGE_LIMIT = 200;

export interface IndexedPlan {
  planId: number;
  datasetId: string;
  seller: string;
  pricePerPeriodStroops: string;
  pricePerPeriod: number;
  periodSeconds: number;
  maxSeats: number;
  active: boolean;
  ledger: number;
}

/** datasetId → plans, insertion-ordered by plan id. */
const plansByDataset = new Map<string, IndexedPlan[]>();
let nextStartLedger: number | null = null;
let cursor: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

/**
 * Decode one raw Soroban event into a table mutation. Returns true when the
 * event was recognised and applied. Exported for direct unit testing.
 */
export function ingestPlanEvent(
  raw: Pick<StellarSdk.rpc.Api.EventResponse, 'topic' | 'value' | 'ledger'>,
): boolean {
  const topic = raw.topic[0] ? StellarSdk.scValToNative(raw.topic[0]) : undefined;
  const value = StellarSdk.scValToNative(raw.value);
  const data = Array.isArray(value) ? value : [value];

  if (topic === 'plan_new') {
    if (data.length < 6) return false;
    const plan: IndexedPlan = {
      planId: Number(data[0]),
      datasetId: String(data[2] ?? ''),
      seller: String(data[1] ?? ''),
      pricePerPeriodStroops: BigInt(data[3] ?? 0).toString(),
      pricePerPeriod: stroopsToAmount(BigInt(data[3] ?? 0)),
      periodSeconds: Number(data[4]),
      maxSeats: Number(data[5]),
      active: true,
      ledger: raw.ledger,
    };
    if (!plan.datasetId) return false;
    const list = plansByDataset.get(plan.datasetId) ?? [];
    const existingIdx = list.findIndex(p => p.planId === plan.planId);
    if (existingIdx >= 0) list[existingIdx] = plan;
    else list.push(plan);
    list.sort((a, b) => a.planId - b.planId);
    plansByDataset.set(plan.datasetId, list);
    return true;
  }

  if (topic === 'plan_set') {
    if (data.length < 2) return false;
    const planId = Number(data[0]);
    const active = Boolean(data[1]);
    let applied = false;
    for (const list of plansByDataset.values()) {
      const plan = list.find(p => p.planId === planId);
      if (plan) {
        plan.active = active;
        applied = true;
      }
    }
    return applied;
  }

  // subscribed/renewed/settled/revoked or system noise — not part of this index.
  return false;
}

/** Plans indexed so far for a dataset (empty until the poller catches up). */
export function getIndexedPlans(datasetId: string): IndexedPlan[] {
  return plansByDataset.get(datasetId) ?? [];
}

async function pollOnce(): Promise<void> {
  const contractId = getAccessPassContractId();
  const rpc = getRpc();

  if (cursor === null && nextStartLedger === null) {
    const latest = await sorobanBreaker.execute(() => rpc.getLatestLedger());
    nextStartLedger = process.env.ACCESS_PASS_START_LEDGER
      ? parseInt(process.env.ACCESS_PASS_START_LEDGER, 10)
      : latest.sequence;
    logger.info(`[AccessPlans] Indexer starting from ledger ${nextStartLedger}`);
  }

  // First page anchors at a ledger number; later pages chain on the RPC's own
  // paging token (same shape as the Sentinel ingest loop).
  const request: Parameters<typeof rpc.getEvents>[0] =
    cursor !== null
      ? { filters: [{ type: 'contract', contractIds: [contractId] }], limit: PAGE_LIMIT, cursor }
      : {
          filters: [{ type: 'contract', contractIds: [contractId] }],
          limit: PAGE_LIMIT,
          startLedger: nextStartLedger as number,
        };
  const response = await sorobanBreaker.execute(() => rpc.getEvents(request));
  let applied = 0;
  for (const raw of response.events) {
    if (ingestPlanEvent(raw)) applied += 1;
  }
  cursor = response.cursor;
  if (applied > 0) {
    logger.info(`[AccessPlans] Indexed ${applied} plan event(s) up to cursor ${cursor}`);
  }
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await pollOnce();
  } catch (err) {
    // Transient RPC failures just postpone the next page; log and keep going.
    logger.warn(`[AccessPlans] Poll failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

/**
 * Start background plan indexing. No-op when the access-pass contract is not
 * configured or the worker is already running. Returns immediately; failures
 * inside the loop never crash the server.
 */
export function startPlanIndexerWorker(): void {
  if (!isAccessPassConfigured()) {
    logger.info('[AccessPlans] ACCESS_PASS_CONTRACT_ID unset — plan indexer disabled');
    return;
  }
  if (timer !== null) return;
  void loop();
  timer = setInterval(() => void loop(), POLL_INTERVAL_MS);
  logger.info(`[AccessPlans] Plan indexer started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
}

export function stopPlanIndexerWorker(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  logger.info('[AccessPlans] Plan indexer stopped');
}

/** Test hook: reset the whole table + cursor. */
export function resetPlanIndex(): void {
  plansByDataset.clear();
  cursor = null;
  nextStartLedger = null;
}

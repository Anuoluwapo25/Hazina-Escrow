/**
 * engine.ts — Sentinel's core orchestrator: fetches event pages, folds them
 * through the event-based invariants, runs the timer-based ones, and routes
 * anything raised through the alert router.
 *
 * Deliberately dependency-injected (EventSource, EscrowReader, CursorStore,
 * AlertChannel[]) so it can be driven entirely by fixtures in tests — see
 * engine.test.ts — with the real Soroban-RPC-backed wiring living in rpc.ts
 * and store.ts instead.
 *
 * Restart safety: every invariant reads ground truth live (get_escrow /
 * get_escrow_count / balance) rather than from a locally rebuilt event
 * history, so the *only* state that must survive a restart is the cursor
 * itself — persisted only after a batch's events have all been evaluated.
 * A crash mid-batch just re-fetches and re-evaluates the same page next
 * start; alert dedupe (see alerts.ts) makes that idempotent rather than a
 * duplicate page.
 */
import { logger } from '../lib/logger';
import { fireAlert, type AlertChannel } from './alerts';
import { scanOpenEscrows } from './invariants/scan';
import * as pauseState from './invariants/pauseState';
import * as adminActions from './invariants/adminActions';
import * as feeBand from './invariants/feeBand';
import * as releaseConservation from './invariants/releaseConservation';
import * as unknownEscrow from './invariants/unknownEscrow';
import * as deliveryRecord from './invariants/deliveryRecord';
import * as solvency from './invariants/solvency';
import * as expiryWithoutClaim from './invariants/expiryWithoutClaim';
import * as streamStall from './invariants/streamStall';
import * as upgradeWatch from './invariants/upgradeWatch';
import type {
  CursorStore,
  EscrowReader,
  EventSource,
  RaisedAlert,
  SentinelCursorState,
  SentinelEvent,
} from './types';

export interface SentinelEngineDeps {
  eventSource: EventSource;
  reader: EscrowReader;
  cursorStore: CursorStore;
  channels: AlertChannel[];
  hasDeliveryRecord: (escrowId: number) => Promise<boolean>;
  /** Ledger to start from when no cursor has been persisted yet. */
  startLedger?: number;
  pageLimit?: number;
  stallThresholdSeconds?: number;
  timerIntervalMs?: number;
  now?: () => Date;
}

function initialCursorState(startLedger: number): SentinelCursorState {
  return {
    cursor: null,
    lastLedger: startLedger,
    lastProgressAt: new Date(0).toISOString(),
    lastWasmHash: null,
  };
}

export class SentinelEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly deps: SentinelEngineDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.scheduleNextTick(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.processNextBatch();
    } catch (err) {
      logger.error(
        `[Sentinel] Event batch processing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.runTimerChecks();
    } catch (err) {
      logger.error(
        `[Sentinel] Timer checks failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.scheduleNextTick(this.deps.timerIntervalMs ?? 15_000);
  }

  /** Fetches and evaluates one page of events. Returns how many events were processed. */
  async processNextBatch(): Promise<number> {
    const cursorState =
      (await this.deps.cursorStore.load()) ?? initialCursorState(this.deps.startLedger ?? 0);

    const page = await this.deps.eventSource.getPage({
      cursor: cursorState.cursor ?? undefined,
      startLedger: cursorState.cursor ? undefined : (this.deps.startLedger ?? 0),
      limit: this.deps.pageLimit ?? 100,
    });

    for (const event of page.events) {
      // eslint-disable-next-line no-await-in-loop -- events within a page must be evaluated in order
      await this.evaluateEvent(event);
    }

    const progressed = page.latestLedger > cursorState.lastLedger;
    await this.deps.cursorStore.save({
      cursor: page.cursor,
      lastLedger: Math.max(page.latestLedger, cursorState.lastLedger),
      lastProgressAt: progressed ? this.now().toISOString() : cursorState.lastProgressAt,
    });

    return page.events.length;
  }

  private async evaluateEvent(event: SentinelEvent): Promise<void> {
    const alerts: RaisedAlert[] = [
      ...pauseState.evaluate(event),
      ...adminActions.evaluate(event),
      ...feeBand.evaluate(event),
      ...(await releaseConservation.evaluate(event, this.deps.reader)),
      ...(await unknownEscrow.evaluate(event, this.deps.reader)),
      ...(await deliveryRecord.evaluate(event, { hasDeliveryRecord: this.deps.hasDeliveryRecord })),
    ];
    await this.raiseAll(alerts);
  }

  /** Runs every timer-based invariant once: solvency, expiry, stream stall, upgrade watch. */
  async runTimerChecks(): Promise<void> {
    const cursorState =
      (await this.deps.cursorStore.load()) ?? initialCursorState(this.deps.startLedger ?? 0);
    const now = this.now();

    const [open, currentLedger, currentWasmHash] = await Promise.all([
      scanOpenEscrows(this.deps.reader),
      this.deps.reader.getLatestLedger(),
      this.deps.reader.getContractWasmHash(),
    ]);

    const solvencyAlerts = await solvency.evaluate(this.deps.reader, open);
    const expiryAlerts = expiryWithoutClaim.evaluate(open, Math.floor(now.getTime() / 1000));
    const stall = streamStall.evaluate({
      previousLedger: cursorState.lastLedger,
      previousProgressAt: new Date(cursorState.lastProgressAt),
      currentLedger,
      now,
      stallThresholdSeconds: this.deps.stallThresholdSeconds ?? 120,
    });
    const upgradeAlerts = upgradeWatch.evaluate({
      previousHash: cursorState.lastWasmHash,
      currentHash: currentWasmHash,
    });

    await this.raiseAll([...solvencyAlerts, ...expiryAlerts, ...stall.alerts, ...upgradeAlerts]);

    const ledgerProgressed = currentLedger > cursorState.lastLedger;
    await this.deps.cursorStore.save({
      lastWasmHash: currentWasmHash,
      lastLedger: Math.max(currentLedger, cursorState.lastLedger),
      lastProgressAt:
        stall.progressed || ledgerProgressed ? now.toISOString() : cursorState.lastProgressAt,
    });
  }

  private async raiseAll(alerts: RaisedAlert[]): Promise<void> {
    for (const alert of alerts) {
      // eslint-disable-next-line no-await-in-loop -- alerts must dedupe/persist in order
      await fireAlert(alert, this.deps.channels);
    }
  }
}

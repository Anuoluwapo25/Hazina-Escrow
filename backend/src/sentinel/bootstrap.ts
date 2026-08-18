/**
 * bootstrap.ts — builds a real, RPC-wired SentinelEngine from env config.
 * Shared by the in-process flag in main.ts and the standalone container
 * entrypoint (standalone.ts) so the two modes can never drift apart.
 */
import { parsePositiveInt } from '../common/env';
import { isEscrowContractConfigured } from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { SentinelEngine } from './engine';
import { createRpcEventSource, createRpcEscrowReader } from './rpc';
import { createStorageBackedCursorStore, hasBackendDeliveryRecord } from './store';
import { defaultChannels } from './channels';

let engine: SentinelEngine | null = null;

export function isSentinelEnabled(): boolean {
  return (process.env.SENTINEL_ENABLED ?? '').toLowerCase() === 'true';
}

export function buildSentinelEngine(): SentinelEngine {
  return new SentinelEngine({
    eventSource: createRpcEventSource(),
    reader: createRpcEscrowReader(),
    cursorStore: createStorageBackedCursorStore(),
    channels: defaultChannels(),
    hasDeliveryRecord: hasBackendDeliveryRecord,
    startLedger: parsePositiveInt(process.env.SENTINEL_START_LEDGER, 0),
    pageLimit: parsePositiveInt(process.env.SENTINEL_PAGE_LIMIT, 100),
    stallThresholdSeconds: parsePositiveInt(process.env.SENTINEL_STALL_SECONDS, 120),
    timerIntervalMs: parsePositiveInt(process.env.SENTINEL_TICK_MS, 15_000),
  });
}

/** Starts the watcher if SENTINEL_ENABLED=true and a contract is configured. Safe to call unconditionally. */
export async function startSentinelIfEnabled(): Promise<void> {
  if (!isSentinelEnabled()) {
    logger.info('[Sentinel] SENTINEL_ENABLED is not "true" — watcher not started');
    return;
  }
  if (!isEscrowContractConfigured()) {
    logger.warn('[Sentinel] ESCROW_CONTRACT_ID is unset — watcher not started');
    return;
  }
  engine = buildSentinelEngine();
  await engine.start();
  logger.info('[Sentinel] Escrow contract watcher started');
}

export function stopSentinel(): void {
  engine?.stop();
  engine = null;
}

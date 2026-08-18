/**
 * streamStall.ts — if the ledger stops advancing (RPC outage, network halt,
 * or Sentinel itself wedged on a bad request), the watcher goes blind
 * without anyone noticing unless something says so.
 */
import type { RaisedAlert } from '../types';

export interface StallCheckResult {
  alerts: RaisedAlert[];
  /** True when the ledger has advanced since the last check — callers should reset their progress timestamp. */
  progressed: boolean;
}

export function evaluate(params: {
  previousLedger: number;
  previousProgressAt: Date;
  currentLedger: number;
  now: Date;
  stallThresholdSeconds: number;
}): StallCheckResult {
  const progressed = params.currentLedger > params.previousLedger;
  if (progressed) {
    return { alerts: [], progressed: true };
  }

  const stalledSeconds = (params.now.getTime() - params.previousProgressAt.getTime()) / 1000;
  if (stalledSeconds < params.stallThresholdSeconds) {
    return { alerts: [], progressed: false };
  }

  return {
    alerts: [
      {
        invariant: 'stream_stall',
        severity: 'high',
        message: `No ledger progress for ${Math.round(stalledSeconds)}s (stuck at ledger ${params.previousLedger})`,
        details: { stalledSeconds: Math.round(stalledSeconds), ledger: params.previousLedger },
      },
    ],
    progressed: false,
  };
}

/**
 * pauseState.ts — pause()/unpause() fire a high alert every time, no
 * suppression across distinct calls (dedupe keys off the triggering event's
 * own id, so only a restart-replay of the exact same event collapses).
 */
import type { RaisedAlert, SentinelEvent } from '../types';

export function evaluate(event: SentinelEvent): RaisedAlert[] {
  if (event.topic !== 'paused' && event.topic !== 'unpaused') return [];

  const admin = typeof event.data[0] === 'string' ? event.data[0] : undefined;
  const action = event.topic === 'paused' ? 'paused' : 'unpaused';

  return [
    {
      invariant: 'pause_state',
      severity: 'high',
      dedupeSuffix: event.id,
      txHash: event.txHash,
      ledger: event.ledger,
      message: `Escrow contract ${action} by ${admin ?? 'unknown admin'}`,
      details: { admin, action },
    },
  ];
}

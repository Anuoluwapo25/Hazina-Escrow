/**
 * upgradeWatch.ts — `upgrade()` is the one admin action that emits no
 * contract event at all (see contracts/hazina-escrow/src/lib.rs), so it
 * can't be caught by the event-based adminActions invariant. Instead this
 * polls the deployed WASM's hash on the timer and alerts on any change.
 */
import type { RaisedAlert } from '../types';

export function evaluate(params: {
  previousHash: string | null;
  currentHash: string;
}): RaisedAlert[] {
  // No prior observation to compare against — record it silently, don't
  // treat "first time we ever checked" as an upgrade.
  if (params.previousHash === null || params.previousHash === params.currentHash) {
    return [];
  }

  return [
    {
      invariant: 'contract_upgrade',
      severity: 'critical',
      dedupeSuffix: params.currentHash,
      message: `Escrow contract WASM changed from ${params.previousHash} to ${params.currentHash} — upgrade() was called`,
      details: { previousHash: params.previousHash, currentHash: params.currentHash },
    },
  ];
}

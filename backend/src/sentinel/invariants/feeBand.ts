/**
 * feeBand.ts — the platform fee (default or per-dataset) should only ever
 * move inside an operator-configured band. A change outside it is probably a
 * fat-fingered admin call, not an attack — high, not critical — but still
 * needs a human to look before the next release/claim_expired uses it.
 */
import { parsePositiveInt } from '../../common/env';
import type { RaisedAlert, SentinelEvent } from '../types';

function getFeeBandBps(): { min: number; max: number } {
  const min = parsePositiveInt(process.env.SENTINEL_FEE_BAND_MIN_BPS, 0);
  const max = parsePositiveInt(process.env.SENTINEL_FEE_BAND_MAX_BPS, 2_000);
  return { min, max };
}

export function evaluate(event: SentinelEvent): RaisedAlert[] {
  if (event.topic !== 'fee_upd' && event.topic !== 'dsf_upd') return [];

  const { min, max } = getFeeBandBps();
  const feeBps = Number(event.topic === 'fee_upd' ? event.data[1] : event.data[1]);
  if (Number.isNaN(feeBps) || (feeBps >= min && feeBps <= max)) return [];

  const scope =
    event.topic === 'fee_upd' ? 'default fee' : `dataset fee (${String(event.data[0])})`;

  return [
    {
      invariant: 'fee_band',
      severity: 'high',
      dedupeSuffix: event.id,
      txHash: event.txHash,
      ledger: event.ledger,
      message: `${scope} set to ${feeBps} bps, outside the configured [${min}, ${max}] band`,
      details: { scope, feeBps, band: { min, max } },
    },
  ];
}

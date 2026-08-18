import { describe, expect, it } from 'vitest';
import { evaluate } from './pauseState';
import type { SentinelEvent } from '../types';

function ev(topic: SentinelEvent['topic'], data: unknown[]): SentinelEvent {
  return {
    id: 'evt-1',
    topic,
    ledger: 42,
    ledgerClosedAt: new Date().toISOString(),
    txHash: 'tx-1',
    pagingToken: '42-0',
    data,
  };
}

describe('pauseState.evaluate', () => {
  it('fires high on paused', () => {
    const alerts = evaluate(ev('paused', ['GADMIN']));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ invariant: 'pause_state', severity: 'high' });
  });

  it('fires high on unpaused', () => {
    const alerts = evaluate(ev('unpaused', ['GADMIN']));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.details).toMatchObject({ action: 'unpaused' });
  });

  it('ignores unrelated topics', () => {
    expect(evaluate(ev('locked', [1, 'GBUYER', 'GSELLER', '1000', 500]))).toEqual([]);
  });
});

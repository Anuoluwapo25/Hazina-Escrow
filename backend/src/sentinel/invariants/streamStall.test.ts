import { describe, expect, it } from 'vitest';
import { evaluate } from './streamStall';

describe('streamStall.evaluate', () => {
  it('reports progress and no alert when the ledger has advanced', () => {
    const result = evaluate({
      previousLedger: 100,
      previousProgressAt: new Date('2026-01-01T00:00:00Z'),
      currentLedger: 105,
      now: new Date('2026-01-01T00:10:00Z'),
      stallThresholdSeconds: 60,
    });
    expect(result.progressed).toBe(true);
    expect(result.alerts).toEqual([]);
  });

  it('does not alert before the threshold elapses', () => {
    const result = evaluate({
      previousLedger: 100,
      previousProgressAt: new Date('2026-01-01T00:00:00Z'),
      currentLedger: 100,
      now: new Date('2026-01-01T00:00:30Z'), // 30s, under a 60s threshold
      stallThresholdSeconds: 60,
    });
    expect(result.progressed).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it('fires a high alert once the threshold elapses with no progress', () => {
    const result = evaluate({
      previousLedger: 100,
      previousProgressAt: new Date('2026-01-01T00:00:00Z'),
      currentLedger: 100,
      now: new Date('2026-01-01T00:02:00Z'), // 120s, over a 60s threshold
      stallThresholdSeconds: 60,
    });
    expect(result.progressed).toBe(false);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ invariant: 'stream_stall', severity: 'high' });
  });
});

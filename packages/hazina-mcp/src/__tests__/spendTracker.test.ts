import { describe, expect, it } from 'vitest';
import { SpendLimitError, SpendTracker } from '../spendTracker.js';

describe('SpendTracker', () => {
  it('allows a purchase within both limits', () => {
    const tracker = new SpendTracker(1, 5);
    expect(() => tracker.assertWithinLimits(0.5)).not.toThrow();
  });

  it('blocks a single purchase over the per-call limit', () => {
    const tracker = new SpendTracker(1, 5);
    expect(() => tracker.assertWithinLimits(1.5)).toThrow(SpendLimitError);
  });

  it('blocks the 3rd purchase once the session cap is reached', () => {
    const tracker = new SpendTracker(2, 3);

    tracker.assertWithinLimits(1);
    tracker.record({ datasetId: 'a', amount: 1, txHash: 'tx-1', demo: true });

    tracker.assertWithinLimits(1.5);
    tracker.record({ datasetId: 'b', amount: 1.5, txHash: 'tx-2', demo: true });

    // Session total is now 2.5; a 3rd purchase of 1 would push it to 3.5, over the 3 cap.
    expect(() => tracker.assertWithinLimits(1)).toThrow(SpendLimitError);
    expect(tracker.getLog()).toHaveLength(2);
  });

  it('reports which limit was breached', () => {
    const tracker = new SpendTracker(1, 5);
    try {
      tracker.assertWithinLimits(2);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpendLimitError);
      expect((err as SpendLimitError).limit).toBe('per-call');
    }
  });

  it('records purchases and accumulates the session total', () => {
    const tracker = new SpendTracker(10, 10);
    tracker.record({ datasetId: 'a', amount: 1, txHash: 'tx-1', demo: false });
    tracker.record({ datasetId: 'b', amount: 2, txHash: 'tx-2', demo: false });

    expect(tracker.getSessionTotal()).toBe(3);
    expect(tracker.getLog()).toHaveLength(2);
    expect(tracker.getLog()[0]).toMatchObject({ datasetId: 'a', amount: 1, txHash: 'tx-1' });
  });

  it('finds a logged entry by transaction hash', () => {
    const tracker = new SpendTracker(10, 10);
    tracker.record({ datasetId: 'a', amount: 1, txHash: 'tx-abc', demo: false });

    expect(tracker.findByTxHash('tx-abc')).toMatchObject({ datasetId: 'a' });
    expect(tracker.findByTxHash('missing')).toBeUndefined();
  });

  it('getLog returns a copy, not the live array', () => {
    const tracker = new SpendTracker(10, 10);
    tracker.record({ datasetId: 'a', amount: 1, txHash: 'tx-1', demo: false });

    const log = tracker.getLog();
    log.push({ datasetId: 'x', amount: 99, txHash: 'fake', demo: true, timestamp: 'now' });

    expect(tracker.getLog()).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { estimateStorage, formatBytes } from './snapshots.estimator';
import { DEFAULT_RETENTION_POLICY } from './snapshots.types';

describe('estimateStorage', () => {
  it('counts only refreshes that actually change the payload', () => {
    const estimate = estimateStorage({
      avgSnapshotBytes: 1000,
      refreshesPerDay: 288, // every five minutes
      changeRate: 0.25,
      policy: DEFAULT_RETENTION_POLICY,
    });
    expect(estimate.snapshotsPerDay).toBe(72);
  });

  it('shows downsampling saving most of an unbounded projection', () => {
    const estimate = estimateStorage({
      avgSnapshotBytes: 2048,
      refreshesPerDay: 288,
      changeRate: 1,
      policy: DEFAULT_RETENTION_POLICY,
    });
    expect(estimate.steadyStateSnapshots).toBeLessThan(estimate.uncompactedSnapshots / 4);
    expect(estimate.steadyStateBytes).toBe(estimate.steadyStateSnapshots * 2048);
  });

  it('never claims a band stores more than the cadence produces', () => {
    const estimate = estimateStorage({
      avgSnapshotBytes: 500,
      refreshesPerDay: 2,
      changeRate: 1,
      policy: DEFAULT_RETENTION_POLICY,
    });
    // Two changes a day can never fill an hourly band's 24-per-day ceiling.
    expect(estimate.breakdown.hourly).toBe(2 * (90 - 7));
    expect(estimate.breakdown.daily).toBe(365 - 90);
  });

  it('treats unlimited retention as a one-year projection', () => {
    const unlimited = estimateStorage({
      avgSnapshotBytes: 100,
      refreshesPerDay: 24,
      changeRate: 1,
      policy: { ...DEFAULT_RETENTION_POLICY, retentionDays: null },
    });
    const yearly = estimateStorage({
      avgSnapshotBytes: 100,
      refreshesPerDay: 24,
      changeRate: 1,
      policy: { ...DEFAULT_RETENTION_POLICY, retentionDays: 365 },
    });
    expect(unlimited).toEqual(yearly);
  });

  it('returns zero for a dataset that never changes', () => {
    const estimate = estimateStorage({
      avgSnapshotBytes: 1000,
      refreshesPerDay: 288,
      changeRate: 0,
      policy: DEFAULT_RETENTION_POLICY,
    });
    expect(estimate.steadyStateSnapshots).toBe(0);
    expect(estimate.steadyStateBytes).toBe(0);
  });

  it('clamps a nonsensical change rate instead of projecting negative storage', () => {
    const estimate = estimateStorage({
      avgSnapshotBytes: 10,
      refreshesPerDay: 10,
      changeRate: -1,
      policy: DEFAULT_RETENTION_POLICY,
    });
    expect(estimate.snapshotsPerDay).toBe(0);
  });
});

describe('formatBytes', () => {
  it('scales to human units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
  });
});

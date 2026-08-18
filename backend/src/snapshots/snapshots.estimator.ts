/**
 * snapshots.estimator.ts — what a refresh cadence costs in storage (#600).
 *
 * A seller choosing a five-minute feed should be able to see, before they turn
 * it on, what that implies for a year of history. The estimate is deliberately
 * simple and explainable: only *changed* refreshes create rows, and compaction
 * thins those rows once they age past the policy's resolution bands.
 */

import type { SnapshotRetentionPolicy } from './snapshots.types';

export interface StorageEstimateInput {
  /** Average stored (compressed) size of one snapshot, in bytes. */
  avgSnapshotBytes: number;
  /** How often the provider is polled, per day. */
  refreshesPerDay: number;
  /** Fraction of refreshes that actually change the payload, in [0, 1]. */
  changeRate: number;
  policy: SnapshotRetentionPolicy;
}

export interface StorageEstimate {
  /** Rows written per day before compaction. */
  snapshotsPerDay: number;
  /** Rows still stored once the policy reaches steady state. */
  steadyStateSnapshots: number;
  steadyStateBytes: number;
  /** Rows that would exist with no compaction at all — the saving. */
  uncompactedSnapshots: number;
  uncompactedBytes: number;
  breakdown: {
    fullResolution: number;
    hourly: number;
    daily: number;
  };
}

const HOURS_PER_DAY = 24;

/**
 * Project steady-state storage for one dataset.
 *
 * Within a resolution band the row count is the smaller of what the cadence
 * produces and what the band's resolution allows — a feed that changes twice a
 * day never reaches the hourly band's 24 rows/day ceiling.
 */
export function estimateStorage(input: StorageEstimateInput): StorageEstimate {
  const { avgSnapshotBytes, refreshesPerDay, changeRate, policy } = input;

  const snapshotsPerDay = Math.max(0, refreshesPerDay) * Math.min(Math.max(changeRate, 0), 1);
  const horizonDays = policy.retentionDays ?? 365;

  const fullDays = Math.min(policy.fullResolutionDays, horizonDays);
  const hourlyDays = Math.max(0, Math.min(policy.hourlyDays, horizonDays) - fullDays);
  const dailyDays = Math.max(0, horizonDays - Math.max(policy.hourlyDays, fullDays));

  const fullResolution = snapshotsPerDay * fullDays;
  const hourly = Math.min(snapshotsPerDay, HOURS_PER_DAY) * hourlyDays;
  const daily = Math.min(snapshotsPerDay, 1) * dailyDays;

  const steadyStateSnapshots = Math.round(fullResolution + hourly + daily);
  const uncompactedSnapshots = Math.round(snapshotsPerDay * horizonDays);

  return {
    snapshotsPerDay,
    steadyStateSnapshots,
    steadyStateBytes: Math.round(steadyStateSnapshots * avgSnapshotBytes),
    uncompactedSnapshots,
    uncompactedBytes: Math.round(uncompactedSnapshots * avgSnapshotBytes),
    breakdown: {
      fullResolution: Math.round(fullResolution),
      hourly: Math.round(hourly),
      daily: Math.round(daily),
    },
  };
}

/** Format a byte count for seller-facing copy. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

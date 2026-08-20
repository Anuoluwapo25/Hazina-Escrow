import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTransaction,
  writeStore,
  type Dataset,
  type Store,
  type Transaction,
} from '../common/storage';
import { compactAllSnapshots, planCompaction } from './snapshots.compaction';
import {
  deleteSnapshotsForDataset,
  getSnapshotAsOf,
  listAllSnapshots,
} from './snapshots.repository';
import { recordDatasetSnapshot } from './snapshots.service';
import { DEFAULT_RETENTION_POLICY, type DatasetSnapshot } from './snapshots.types';

const DATASET_ID = 'ds-compaction';
const NOW = Date.parse('2026-08-18T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: DATASET_ID,
    name: 'Yield Table',
    description: 'DeFi yields',
    type: 'yield-data',
    pricePerQuery: 1,
    sellerWallet: `G${'A'.repeat(55)}`,
    data: {},
    queriesServed: 0,
    totalEarned: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seed(dataset: Dataset, transactions: Transaction[] = []): Promise<void> {
  const store: Store = {
    datasets: [dataset],
    transactions,
    webhooks: [],
    payoutFailures: [],
    claimableBalances: [],
  };
  await writeStore(store);
  await deleteSnapshotsForDataset(dataset.id);
}

/** Write `count` snapshots, one every `stepMs`, ending `endDaysAgo` before NOW. */
async function buildHistory(count: number, stepMs: number, startDaysAgo: number): Promise<void> {
  const start = NOW - startDaysAgo * MS_PER_DAY;
  for (let i = 0; i < count; i += 1) {
    await recordDatasetSnapshot(
      DATASET_ID,
      { tick: i },
      { at: new Date(start + i * stepMs).toISOString() },
    );
  }
}

/** Index into a fixture list, failing loudly instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

function snapshot(overrides: Partial<DatasetSnapshot>): DatasetSnapshot {
  return {
    id: 'snap-x',
    datasetId: DATASET_ID,
    contentHash: 'h',
    payload: '{}',
    encoding: 'json',
    validFrom: '2026-08-01T00:00:00.000Z',
    validTo: '2026-08-01T01:00:00.000Z',
    byteSize: 10,
    rawByteSize: 20,
    observations: 1,
    lastObservedAt: '2026-08-01T00:00:00.000Z',
    providerRunId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('planCompaction', () => {
  it('keeps every snapshot inside the full-resolution window', () => {
    const ordered = Array.from({ length: 10 }, (_, i) =>
      snapshot({
        id: `snap-${i}`,
        validFrom: new Date(NOW - 2 * MS_PER_DAY + i * MS_PER_HOUR).toISOString(),
        validTo: new Date(NOW - 2 * MS_PER_DAY + (i + 1) * MS_PER_HOUR).toISOString(),
      }),
    );
    expect(planCompaction(ordered, DEFAULT_RETENTION_POLICY, new Set(), NOW).deleteIds).toEqual([]);
  });

  it('never deletes the open snapshot, however old it is', () => {
    const ordered = [
      snapshot({
        id: 'snap-ancient',
        validFrom: new Date(NOW - 900 * MS_PER_DAY).toISOString(),
        validTo: null,
      }),
    ];
    expect(planCompaction(ordered, DEFAULT_RETENTION_POLICY, new Set(), NOW).deleteIds).toEqual([]);
  });

  it('thins an aged hour down to its first snapshot', () => {
    const hourStart = NOW - 30 * MS_PER_DAY;
    const ordered = Array.from({ length: 4 }, (_, i) =>
      snapshot({
        id: `snap-${i}`,
        validFrom: new Date(hourStart + i * 10 * 60_000).toISOString(),
        validTo: new Date(hourStart + (i + 1) * 10 * 60_000).toISOString(),
      }),
    );
    const plan = planCompaction(ordered, DEFAULT_RETENTION_POLICY, new Set(), NOW);
    expect(plan.deleteIds).toEqual(['snap-1', 'snap-2', 'snap-3']);
  });

  it('drops everything past the retention window', () => {
    const ordered = [
      snapshot({
        id: 'snap-expired',
        validFrom: new Date(NOW - 400 * MS_PER_DAY).toISOString(),
        validTo: new Date(NOW - 399 * MS_PER_DAY).toISOString(),
      }),
    ];
    const plan = planCompaction(ordered, DEFAULT_RETENTION_POLICY, new Set(), NOW);
    expect(plan.deleteIds).toEqual(['snap-expired']);
  });

  it('keeps an expired snapshot that a completed purchase pinned', () => {
    const ordered = [
      snapshot({
        id: 'snap-sold',
        validFrom: new Date(NOW - 400 * MS_PER_DAY).toISOString(),
        validTo: new Date(NOW - 399 * MS_PER_DAY).toISOString(),
      }),
    ];
    const plan = planCompaction(ordered, DEFAULT_RETENTION_POLICY, new Set(['snap-sold']), NOW);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.pinnedRetained).toBe(1);
  });

  it('keeps everything when retention is unlimited and resolution is full', () => {
    const ordered = Array.from({ length: 5 }, (_, i) =>
      snapshot({
        id: `snap-${i}`,
        validFrom: new Date(NOW - (500 - i) * MS_PER_DAY).toISOString(),
        validTo: new Date(NOW - (499 - i) * MS_PER_DAY).toISOString(),
      }),
    );
    const policy = { retentionDays: null, fullResolutionDays: 3650, hourlyDays: 3650 };
    expect(planCompaction(ordered, policy, new Set(), NOW).deleteIds).toEqual([]);
  });
});

describe('compactAllSnapshots', () => {
  beforeEach(async () => {
    await seed(makeDataset());
  });

  it('downsamples aged history and leaves the timeline gap-free', async () => {
    // 12 changes five minutes apart, 30 days ago — one aged hour.
    await buildHistory(12, 5 * 60_000, 30);
    expect(await listAllSnapshots(DATASET_ID)).toHaveLength(12);

    const result = await compactAllSnapshots(NOW);
    expect(result.snapshotsDeleted).toBeGreaterThan(0);

    // One survivor for the aged hour, plus the open snapshot that is never cut.
    const rows = await listAllSnapshots(DATASET_ID);
    expect(rows).toHaveLength(2);
    expect(rows[rows.length - 1]?.validTo).toBeNull();

    // Survivors absorbed the deleted rows' time — the timeline still tiles.
    rows.forEach((row, index) => {
      const next = rows[index + 1];
      if (next) expect(row.validTo).toBe(next.validFrom);
    });
  });

  it('keeps every asOf inside the compacted window resolvable', async () => {
    await buildHistory(12, 5 * 60_000, 30);
    await compactAllSnapshots(NOW);

    const midWindow = new Date(NOW - 30 * MS_PER_DAY + 25 * 60_000).toISOString();
    expect(await getSnapshotAsOf(DATASET_ID, midWindow)).toBeDefined();
  });

  it('never destroys a snapshot referenced by a completed purchase', async () => {
    await buildHistory(12, 5 * 60_000, 30);
    const rows = await listAllSnapshots(DATASET_ID);
    const sold = at(rows, 4);

    await addTransaction({
      id: 'tx-sold',
      datasetId: DATASET_ID,
      txHash: 'hash-sold',
      amount: 1,
      status: 'completed',
      snapshotId: sold.id,
      timestamp: '2026-07-19T00:00:00.000Z',
    });

    const result = await compactAllSnapshots(NOW);
    expect(result.pinnedRetained).toBeGreaterThan(0);

    const survivors = await listAllSnapshots(DATASET_ID);
    expect(survivors.map(row => row.id)).toContain(sold.id);
    // The pinned snapshot is still readable at the instant it was sold.
    expect(await getSnapshotAsOf(DATASET_ID, sold.validFrom)).toMatchObject({ id: sold.id });
  });

  it('honours a per-dataset retention policy', async () => {
    await seed(
      makeDataset({
        snapshotPolicy: { retentionDays: 10, fullResolutionDays: 1, hourlyDays: 5 },
      }),
    );
    await buildHistory(3, 5 * 60_000, 40);
    await recordDatasetSnapshot(DATASET_ID, { tick: 'now' }, { at: new Date(NOW).toISOString() });

    await compactAllSnapshots(NOW);

    const rows = await listAllSnapshots(DATASET_ID);
    // Everything 40 days old is past a 10-day window; only the open row remains.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.validTo).toBeNull();
  });

  it('is a no-op when there is nothing to compact', async () => {
    await recordDatasetSnapshot(DATASET_ID, { tick: 1 }, { at: new Date(NOW).toISOString() });
    const result = await compactAllSnapshots(NOW);
    expect(result.snapshotsDeleted).toBe(0);
    expect(await listAllSnapshots(DATASET_ID)).toHaveLength(1);
  });
});

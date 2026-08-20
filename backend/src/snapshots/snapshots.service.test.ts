import { beforeEach, describe, expect, it } from 'vitest';
import { writeStore, type Dataset, type Store } from '../common/storage';
import { payloadContentHash } from './canonical';
import {
  deleteSnapshotsForDataset,
  getCurrentSnapshot,
  getSnapshotAsOf,
  listAllSnapshots,
  listSnapshotsInRange,
} from './snapshots.repository';
import {
  backfillSnapshots,
  getPayloadAsOf,
  readSnapshotPayload,
  recordDatasetSnapshot,
} from './snapshots.service';

const DATASET_ID = 'ds-time-machine';
const OTHER_DATASET_ID = 'ds-time-machine-other';

function makeDataset(id: string, overrides: Partial<Dataset> = {}): Dataset {
  return {
    id,
    name: 'Whale Movements',
    description: 'Large stellar wallet movements',
    type: 'whale-data',
    category: 'whales',
    pricePerQuery: 1,
    sellerWallet: `G${'A'.repeat(55)}`,
    data: { wallets: [] },
    queriesServed: 0,
    totalEarned: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Index into a fixture list, failing loudly instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

async function seed(datasets: Dataset[]): Promise<void> {
  const store: Store = {
    datasets,
    transactions: [],
    webhooks: [],
    payoutFailures: [],
    claimableBalances: [],
  };
  await writeStore(store);
  for (const dataset of datasets) {
    await deleteSnapshotsForDataset(dataset.id);
  }
}

describe('recordDatasetSnapshot — de-duplication', () => {
  beforeEach(async () => {
    await seed([makeDataset(DATASET_ID)]);
  });

  it('creates the first snapshot and marks it current', async () => {
    const payload = { wallets: [{ address: 'GA', balance: 10 }] };
    const result = await recordDatasetSnapshot(DATASET_ID, payload, {
      at: '2026-08-01T00:00:00.000Z',
    });

    expect(result.created).toBe(true);
    expect(result.snapshot.contentHash).toBe(payloadContentHash(payload));
    expect(result.snapshot.validTo).toBeNull();
    expect(await listAllSnapshots(DATASET_ID)).toHaveLength(1);
  });

  it('creates zero new rows when the content is unchanged', async () => {
    const payload = { wallets: [{ address: 'GA', balance: 10 }] };
    await recordDatasetSnapshot(DATASET_ID, payload, { at: '2026-08-01T00:00:00.000Z' });

    for (const minute of [5, 10, 15]) {
      const repeat = await recordDatasetSnapshot(DATASET_ID, payload, {
        at: `2026-08-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
      });
      expect(repeat.created).toBe(false);
    }

    const rows = await listAllSnapshots(DATASET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observations).toBe(4);
    expect(rows[0]?.lastObservedAt).toBe('2026-08-01T00:15:00.000Z');
    expect(rows[0]?.validTo).toBeNull();
  });

  it('ignores the refresh timestamp the provider stamps on the payload', async () => {
    const at = '2026-08-01T00:00:00.000Z';
    await recordDatasetSnapshot(DATASET_ID, { rows: [1], _fetchedAt: at }, { at });
    const repeat = await recordDatasetSnapshot(
      DATASET_ID,
      { rows: [1], _fetchedAt: '2026-08-01T00:05:00.000Z' },
      { at: '2026-08-01T00:05:00.000Z' },
    );

    expect(repeat.created).toBe(false);
    expect(await listAllSnapshots(DATASET_ID)).toHaveLength(1);
  });

  it('closes the old range and opens a new one when content changes', async () => {
    await recordDatasetSnapshot(DATASET_ID, { v: 1 }, { at: '2026-08-01T00:00:00.000Z' });
    await recordDatasetSnapshot(DATASET_ID, { v: 2 }, { at: '2026-08-01T01:00:00.000Z' });

    const rows = await listAllSnapshots(DATASET_ID);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.validTo).toBe('2026-08-01T01:00:00.000Z');
    expect(rows[1]?.validFrom).toBe('2026-08-01T01:00:00.000Z');
    expect(rows[1]?.validTo).toBeNull();
  });

  it('never opens a range at or before the one it replaces, even on a clock regression', async () => {
    await recordDatasetSnapshot(DATASET_ID, { v: 1 }, { at: '2026-08-01T01:00:00.000Z' });
    await recordDatasetSnapshot(DATASET_ID, { v: 2 }, { at: '2026-08-01T00:00:00.000Z' });

    const rows = await listAllSnapshots(DATASET_ID);
    expect(rows).toHaveLength(2);
    expect(Date.parse(at(rows, 1).validFrom)).toBeGreaterThan(Date.parse(at(rows, 0).validFrom));
    expect(rows[0]?.validTo).toBe(rows[1]?.validFrom);
  });

  it('keeps each dataset history independent', async () => {
    await seed([makeDataset(DATASET_ID), makeDataset(OTHER_DATASET_ID)]);
    await recordDatasetSnapshot(DATASET_ID, { v: 1 }, { at: '2026-08-01T00:00:00.000Z' });
    await recordDatasetSnapshot(OTHER_DATASET_ID, { v: 9 }, { at: '2026-08-01T00:00:00.000Z' });

    expect(await listAllSnapshots(DATASET_ID)).toHaveLength(1);
    const other = at(await listAllSnapshots(OTHER_DATASET_ID), 0);
    expect(readSnapshotPayload(other)).toEqual({ v: 9 });
  });
});

describe('point-in-time reads', () => {
  // Hand-built timeline: A live from 00:00, B from 06:00, C from 12:00 (open).
  const TIMELINE = [
    { at: '2026-08-03T00:00:00.000Z', payload: { table: 'A' } },
    { at: '2026-08-03T06:00:00.000Z', payload: { table: 'B' } },
    { at: '2026-08-03T12:00:00.000Z', payload: { table: 'C' } },
  ];

  beforeEach(async () => {
    await seed([makeDataset(DATASET_ID)]);
    for (const step of TIMELINE) {
      await recordDatasetSnapshot(DATASET_ID, step.payload, { at: step.at });
    }
  });

  it('returns the payload that was live at that instant', async () => {
    const resolved = await getPayloadAsOf(DATASET_ID, '2026-08-03T09:30:00.000Z');
    expect(resolved?.payload).toEqual({ table: 'B' });
  });

  it('returns the snapshot that opened at an asOf exactly on its validFrom', async () => {
    const resolved = await getPayloadAsOf(DATASET_ID, '2026-08-03T06:00:00.000Z');
    expect(resolved?.payload).toEqual({ table: 'B' });
  });

  it('returns the previous snapshot one millisecond before a boundary', async () => {
    const resolved = await getPayloadAsOf(DATASET_ID, '2026-08-03T05:59:59.999Z');
    expect(resolved?.payload).toEqual({ table: 'A' });
  });

  it('returns the open snapshot for any instant after the last change', async () => {
    const resolved = await getPayloadAsOf(DATASET_ID, '2030-01-01T00:00:00.000Z');
    expect(resolved?.payload).toEqual({ table: 'C' });
  });

  it('returns nothing for an instant before history begins', async () => {
    expect(await getSnapshotAsOf(DATASET_ID, '2026-08-02T23:59:59.999Z')).toBeUndefined();
  });

  it('accepts a non-UTC asOf and resolves it to the same instant', async () => {
    const resolved = await getPayloadAsOf(DATASET_ID, '2026-08-03T07:00:00.000+01:00');
    expect(resolved?.payload).toEqual({ table: 'B' });
  });

  it('lists only snapshots overlapping a requested window', async () => {
    const rows = await listSnapshotsInRange(DATASET_ID, {
      from: '2026-08-03T06:00:00.000Z',
      to: '2026-08-03T12:00:00.000Z',
      limit: 50,
    });
    expect(rows.map(row => readSnapshotPayload(row))).toEqual([{ table: 'B' }]);
  });

  it('caps a large-history query at the requested row limit', async () => {
    for (let i = 0; i < 40; i += 1) {
      await recordDatasetSnapshot(
        DATASET_ID,
        { table: `gen-${i}` },
        { at: new Date(Date.parse('2026-08-04T00:00:00.000Z') + i * 60_000).toISOString() },
      );
    }
    const rows = await listSnapshotsInRange(DATASET_ID, { limit: 10 });
    expect(rows).toHaveLength(10);
  });
});

describe('validity ranges (property)', () => {
  it('never overlap and never leave a gap, for any refresh sequence', async () => {
    const payloads = ['a', 'b', 'c', 'd'];
    // 60 pseudo-random refreshes: repeats, changes, and out-of-order clocks.
    const steps = Array.from({ length: 60 }, (_, i) => ({
      payload: { v: payloads[(i * 7 + (i % 3)) % payloads.length] },
      at: new Date(
        Date.parse('2026-08-05T00:00:00.000Z') + (i * 5 - (i % 4) * 3) * 60_000,
      ).toISOString(),
    }));

    await seed([makeDataset(DATASET_ID)]);
    for (const step of steps) {
      await recordDatasetSnapshot(DATASET_ID, step.payload, { at: step.at });
    }

    const rows = await listAllSnapshots(DATASET_ID);
    expect(rows.length).toBeGreaterThan(1);

    const open = rows.filter(row => row.validTo === null);
    expect(open).toHaveLength(1);
    expect(rows[rows.length - 1]?.validTo).toBeNull();

    rows.forEach((row, index) => {
      // Every closed range is non-empty …
      if (row.validTo !== null) {
        expect(Date.parse(row.validTo)).toBeGreaterThan(Date.parse(row.validFrom));
      }
      // … and hands over exactly at its successor's start: no gap, no overlap.
      const next = rows[index + 1];
      if (next) expect(row.validTo).toBe(next.validFrom);
    });

    // Consecutive snapshots always differ in content — otherwise they'd be one row.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.contentHash).not.toBe(rows[i - 1]?.contentHash);
    }
  });
});

describe('backfillSnapshots', () => {
  beforeEach(async () => {
    await seed([
      makeDataset(DATASET_ID, { lastRefreshedAt: '2026-07-15T00:00:00.000Z' }),
      makeDataset(OTHER_DATASET_ID, { data: { rows: [1, 2, 3] } }),
    ]);
  });

  it('opens history for every dataset that has none', async () => {
    const result = await backfillSnapshots();
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);

    const backfilled = await getCurrentSnapshot(DATASET_ID);
    expect(backfilled?.validFrom).toBe('2026-07-15T00:00:00.000Z');
    expect(backfilled?.providerRunId).toBe('backfill');
  });

  it('falls back to the creation date when a dataset has never refreshed', async () => {
    await backfillSnapshots();
    const backfilled = await getCurrentSnapshot(OTHER_DATASET_ID);
    expect(backfilled?.validFrom).toBe('2026-07-01T00:00:00.000Z');
  });

  it('is idempotent — running it twice changes nothing', async () => {
    await backfillSnapshots();
    const before = await listAllSnapshots(DATASET_ID);

    const second = await backfillSnapshots();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
    expect(await listAllSnapshots(DATASET_ID)).toEqual(before);
  });
});

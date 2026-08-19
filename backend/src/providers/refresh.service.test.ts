import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { writeStore, getDataset, type Dataset, type Store } from '../common/storage';
import { deleteSnapshotsForDataset, listAllSnapshots } from '../snapshots/snapshots.repository';
import { readSnapshotPayload } from '../snapshots/snapshots.service';
import { refreshDataset, refreshAllLiveDatasets } from './refresh.service';

function mockFetchReject() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
}

const liveDataset: Dataset = {
  id: 'ds-live-yield',
  name: 'Live Yield Feed',
  description: 'DeFi yields',
  type: 'yield-data',
  category: 'defi-yields',
  pricePerQuery: 1,
  sellerWallet: `G${'A'.repeat(55)}`,
  data: {},
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
  provider: 'defillama',
  live: true,
};

const staticDataset: Dataset = {
  ...liveDataset,
  id: 'ds-static',
  name: 'Static',
  provider: undefined,
  live: false,
};

/** Index into a fixture list, failing loudly instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

async function seed(): Promise<void> {
  const store: Store = {
    datasets: [liveDataset, staticDataset],
    transactions: [],
    webhooks: [],
    payoutFailures: [],
    claimableBalances: [],
  };
  await writeStore(store);
  await deleteSnapshotsForDataset(liveDataset.id);
  await deleteSnapshotsForDataset(staticDataset.id);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refresh.service', () => {
  beforeEach(async () => {
    mockFetchReject();
    await seed();
  });

  it('refreshes a live dataset with a fallback snapshot and stamps metadata', async () => {
    const result = await refreshDataset(liveDataset);
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('defillama');
    // Fallback (offline) → live=false but data still written.
    expect(result.live).toBe(false);

    const updated = await getDataset('ds-live-yield');
    expect(updated?.lastRefreshedAt).toBeTruthy();
    expect(updated?.provider).toBe('defillama');
    expect(updated?.data._points).toBeDefined();
    expect(updated?.data.opportunities).toBeDefined();
  });

  it('only refreshes datasets flagged live', async () => {
    const results = await refreshAllLiveDatasets();
    expect(results).toHaveLength(1);
    expect(results[0]?.datasetId).toBe('ds-live-yield');
  });

  it('reports ok:false when no provider matches', async () => {
    const orphan: Dataset = { ...liveDataset, id: 'x', type: 'nonexistent', provider: undefined };
    const result = await refreshDataset(orphan);
    expect(result.ok).toBe(false);
  });
});

describe('refresh.service — snapshot history (#600)', () => {
  beforeEach(async () => {
    mockFetchReject();
    await seed();
  });

  it('opens a snapshot on the first refresh', async () => {
    const result = await refreshDataset(liveDataset);

    expect(result.snapshotCreated).toBe(true);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const rows = await listAllSnapshots(liveDataset.id);
    expect(rows).toHaveLength(1);
    expect(readSnapshotPayload(at(rows, 0))).toMatchObject({ source: 'DeFiLlama Yields' });
  });

  it('creates zero new rows when a refresh returns unchanged content', async () => {
    await refreshDataset(liveDataset);
    const repeat = await refreshDataset(liveDataset);
    await refreshDataset(liveDataset);

    expect(repeat.snapshotCreated).toBe(false);

    const rows = await listAllSnapshots(liveDataset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observations).toBe(3);
    expect(rows[0]?.validTo).toBeNull();
  });

  it('stamps one provider run id across a sweep', async () => {
    await refreshAllLiveDatasets();
    const rows = await listAllSnapshots(liveDataset.id);
    expect(rows[0]?.providerRunId).toMatch(/^run-/);
  });
});

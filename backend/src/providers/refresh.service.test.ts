import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { writeStore, getDataset, type Dataset, type Store } from '../common/storage';
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

async function seed(): Promise<void> {
  const store: Store = {
    datasets: [liveDataset, staticDataset],
    transactions: [],
    webhooks: [],
    payoutFailures: [],
  };
  await writeStore(store);
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

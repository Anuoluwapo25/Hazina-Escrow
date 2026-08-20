import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Dataset } from '../common/storage';
import type { StoredEmbedding, VectorMatch, VectorStore } from './vector-store';

const { mockEmbedOne, mockIsAvailable } = vi.hoisted(() => ({
  mockEmbedOne: vi.fn(),
  mockIsAvailable: vi.fn(),
}));

vi.mock('./embeddings', async () => {
  const actual = await vi.importActual<typeof import('./embeddings')>('./embeddings');
  return {
    ...actual,
    embedOne: mockEmbedOne,
    isEmbeddingAvailable: mockIsAvailable,
  };
});

import { indexDataset, reindexAll } from './indexer';
import { EMBEDDING_MODEL_ID } from './embeddings';

class FakeVectorStore implements VectorStore {
  rows = new Map<string, StoredEmbedding>();

  async upsert(entry: {
    datasetId: string;
    contentHash: string;
    model: string;
    vector: Float32Array;
  }): Promise<void> {
    this.rows.set(entry.datasetId, {
      ...entry,
      dims: entry.vector.length,
      updatedAt: new Date().toISOString(),
    });
  }
  async get(datasetId: string): Promise<StoredEmbedding | null> {
    return this.rows.get(datasetId) ?? null;
  }
  async delete(datasetId: string): Promise<void> {
    this.rows.delete(datasetId);
  }
  async getAll(): Promise<StoredEmbedding[]> {
    return Array.from(this.rows.values());
  }
  async queryTopK(): Promise<VectorMatch[]> {
    return [];
  }
}

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    name: 'Whale Wallet Movements',
    description: 'Tracks large token transfers',
    type: 'whale-wallets',
    pricePerQuery: 1,
    sellerWallet: 'GABC',
    data: {},
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('indexDataset', () => {
  let store: FakeVectorStore;

  beforeEach(() => {
    store = new FakeVectorStore();
    mockEmbedOne.mockReset();
    mockIsAvailable.mockReset();
    mockIsAvailable.mockResolvedValue(true);
    mockEmbedOne.mockResolvedValue(new Float32Array([1, 2, 3]));
  });

  it('embeds and stores a new dataset', async () => {
    const outcome = await indexDataset(makeDataset(), store);
    expect(outcome).toEqual({ indexed: true, reason: 'embedded' });
    expect(mockEmbedOne).toHaveBeenCalledTimes(1);
    const stored = await store.get('ds-1');
    expect(stored?.model).toBe(EMBEDDING_MODEL_ID);
    expect(Array.from(stored?.vector ?? [])).toEqual([1, 2, 3]);
  });

  it('skips re-embedding when the content hash is unchanged — no model call', async () => {
    await indexDataset(makeDataset(), store);
    mockEmbedOne.mockClear();

    const outcome = await indexDataset(makeDataset(), store);
    expect(outcome).toEqual({ indexed: false, reason: 'unchanged' });
    expect(mockEmbedOne).not.toHaveBeenCalled();
  });

  it('re-embeds when the dataset content changes', async () => {
    await indexDataset(makeDataset(), store);
    mockEmbedOne.mockClear();
    mockEmbedOne.mockResolvedValue(new Float32Array([4, 5, 6]));

    const outcome = await indexDataset(
      makeDataset({ description: 'A brand new description' }),
      store,
    );
    expect(outcome).toEqual({ indexed: true, reason: 'embedded' });
    expect(mockEmbedOne).toHaveBeenCalledTimes(1);
  });

  it('re-embeds when the stored model differs from the current model (model upgrade)', async () => {
    await store.upsert({
      datasetId: 'ds-1',
      contentHash: 'irrelevant-because-model-differs',
      model: 'some-older-model',
      vector: new Float32Array([0, 0, 0]),
    });
    const outcome = await indexDataset(makeDataset(), store);
    expect(outcome).toEqual({ indexed: true, reason: 'embedded' });
  });

  it('skips indexing (without error) when the embedding model is unavailable', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const outcome = await indexDataset(makeDataset(), store);
    expect(outcome).toEqual({ indexed: false, reason: 'embeddings-unavailable' });
    expect(mockEmbedOne).not.toHaveBeenCalled();
  });

  it('never throws — returns reason "error" if embedding fails unexpectedly', async () => {
    mockEmbedOne.mockRejectedValue(new Error('unexpected crash'));
    const outcome = await indexDataset(makeDataset(), store);
    expect(outcome).toEqual({ indexed: false, reason: 'error' });
  });
});

describe('reindexAll', () => {
  let store: FakeVectorStore;

  beforeEach(() => {
    store = new FakeVectorStore();
    mockEmbedOne.mockReset();
    mockIsAvailable.mockReset();
    mockIsAvailable.mockResolvedValue(true);
    mockEmbedOne.mockResolvedValue(new Float32Array([1, 2, 3]));
  });

  it('summarizes embedded/unchanged/skipped/errors across many datasets', async () => {
    const datasets = [
      makeDataset({ id: 'ds-a' }),
      makeDataset({ id: 'ds-b' }),
      makeDataset({ id: 'ds-c' }),
    ];
    // Pre-index ds-b so it comes back "unchanged".
    await indexDataset(datasets[1] as Dataset, store);
    mockEmbedOne.mockClear();

    mockEmbedOne
      .mockResolvedValueOnce(new Float32Array([1, 1, 1])) // ds-a
      .mockRejectedValueOnce(new Error('boom')); // ds-c

    const summary = await reindexAll(datasets, store);
    expect(summary).toEqual({ total: 3, embedded: 1, unchanged: 1, skipped: 0, errors: 1 });
  });
});

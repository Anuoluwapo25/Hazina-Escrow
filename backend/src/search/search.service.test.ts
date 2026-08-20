import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dataset } from '../common/storage';

const {
  mockGetAllDatasets,
  mockIsEmbeddingAvailable,
  mockEmbedOne,
  mockQueryTopK,
  mockIsRerankEnabled,
  mockRerankCandidates,
} = vi.hoisted(() => ({
  mockGetAllDatasets: vi.fn(),
  mockIsEmbeddingAvailable: vi.fn(),
  mockEmbedOne: vi.fn(),
  mockQueryTopK: vi.fn(),
  mockIsRerankEnabled: vi.fn(),
  mockRerankCandidates: vi.fn(),
}));

vi.mock('../common/storage', () => ({
  getAllDatasets: mockGetAllDatasets,
}));

vi.mock('./embeddings', () => ({
  isEmbeddingAvailable: mockIsEmbeddingAvailable,
  embedOne: mockEmbedOne,
}));

vi.mock('./vector-store', () => ({
  getVectorStore: () => ({ queryTopK: mockQueryTopK }),
}));

vi.mock('./rerank', () => ({
  isRerankEnabled: mockIsRerankEnabled,
  rerankCandidates: mockRerankCandidates,
}));

import { search } from './search.service';

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    name: 'Dataset One',
    description: 'A dataset',
    type: 'other',
    category: 'on-chain',
    pricePerQuery: 1,
    sellerWallet: 'GABC',
    data: {},
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const WHALE = makeDataset({
  id: 'ds-whale',
  name: 'Whale Wallet Movements',
  description: 'Tracks token transfers by top-balance addresses',
  category: 'on-chain',
  type: 'whale-wallets',
  queriesServed: 5,
});
const VALIDATOR = makeDataset({
  id: 'ds-validator',
  name: 'Validator Uptime Report',
  description: 'Uptime and slashing history for Stellar validators',
  category: 'network',
  type: 'validator-health',
  pricePerQuery: 3,
  queriesServed: 20,
});
const WEATHER = makeDataset({
  id: 'ds-weather',
  name: 'Lagos Weather Forecast',
  description: 'Daily forecast for Lagos',
  category: 'other',
  type: 'weather',
  pricePerQuery: 0.5,
  queriesServed: 1,
});
const INACTIVE = makeDataset({
  id: 'ds-inactive',
  name: 'Inactive Dataset',
  description: 'Should never appear',
  active: false,
});

describe('search', () => {
  beforeEach(() => {
    mockGetAllDatasets.mockReset();
    mockIsEmbeddingAvailable.mockReset();
    mockEmbedOne.mockReset();
    mockQueryTopK.mockReset();
    mockIsRerankEnabled.mockReset();
    mockRerankCandidates.mockReset();

    mockGetAllDatasets.mockResolvedValue([WHALE, VALIDATOR, WEATHER, INACTIVE]);
    mockIsEmbeddingAvailable.mockResolvedValue(false);
    mockIsRerankEnabled.mockReturnValue(false);
    delete process.env.ENABLE_SEARCH_RERANK;
  });

  it('excludes inactive (soft-deleted) datasets', async () => {
    const result = await search({ query: 'validator' });
    expect(result.results.map(r => r.id)).not.toContain('ds-inactive');
  });

  it('browse mode (empty query) orders by popularity, most-queried first', async () => {
    const result = await search({ query: '' });
    expect(result.results.map(r => r.id)).toEqual(['ds-validator', 'ds-whale', 'ds-weather']);
    expect(result.mode).toBe('keyword-only');
  });

  it('falls back to keyword-only mode when embeddings are unavailable (graceful degradation)', async () => {
    mockIsEmbeddingAvailable.mockResolvedValue(false);
    const result = await search({ query: 'validator uptime' });
    expect(result.mode).toBe('keyword-only');
    expect(result.results[0]?.id).toBe('ds-validator');
    expect(mockEmbedOne).not.toHaveBeenCalled();
  });

  it('uses hybrid mode when embeddings are available, surfacing a semantic-only match with zero keyword overlap', async () => {
    mockIsEmbeddingAvailable.mockResolvedValue(true);
    mockEmbedOne.mockResolvedValue(new Float32Array([1, 0]));
    // Vector arm ranks the whale dataset highly even though the query shares
    // no tokens with its name/description — this is the acceptance behaviour.
    mockQueryTopK.mockResolvedValue([
      { datasetId: 'ds-whale', score: 0.83 },
      { datasetId: 'ds-weather', score: 0.1 },
    ]);

    const result = await search({ query: 'large holder activity' });
    expect(result.mode).toBe('hybrid');
    expect(result.results.map(r => r.id).slice(0, 1)).toEqual(['ds-whale']);
  });

  it('degrades this request to keyword-only if the query embedding call itself fails', async () => {
    mockIsEmbeddingAvailable.mockResolvedValue(true);
    mockEmbedOne.mockRejectedValue(new Error('model crashed'));

    const result = await search({ query: 'validator' });
    expect(result.mode).toBe('keyword-only');
    expect(result.results[0]?.id).toBe('ds-validator');
  });

  it('promotes an exact dataset-id match to rank 1 even in hybrid mode', async () => {
    mockIsEmbeddingAvailable.mockResolvedValue(true);
    mockEmbedOne.mockResolvedValue(new Float32Array([1, 0]));
    mockQueryTopK.mockResolvedValue([{ datasetId: 'ds-weather', score: 0.9 }]);

    const result = await search({ query: 'ds-whale' });
    expect(result.results[0]?.id).toBe('ds-whale');
  });

  it('applies category filter after retrieval', async () => {
    const result = await search({ query: 'e', category: 'network' });
    expect(result.results.every(r => r.category === 'network')).toBe(true);
  });

  it('applies price filters after retrieval', async () => {
    const result = await search({ query: '', minPrice: 2, maxPrice: 5 });
    expect(result.results.map(r => r.id)).toEqual(['ds-validator']);
  });

  it('paginates results', async () => {
    const page1 = await search({ query: '', limit: 2, page: 1 });
    const page2 = await search({ query: '', limit: 2, page: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page2.results).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
  });

  it('caps limit at MAX_PAGE_SIZE', async () => {
    const result = await search({ query: '', limit: 10000 });
    expect(result.limit).toBe(100);
  });

  describe('explain', () => {
    it('omits matchedBecause when explain is not requested', async () => {
      const result = await search({ query: 'validator' });
      expect(result.results[0]?.matchedBecause).toBeUndefined();
    });

    it('explains an exact match distinctly', async () => {
      const result = await search({ query: 'ds-validator', explain: true });
      expect(result.results[0]?.matchedBecause).toContain('Exact match');
    });

    it('explains a keyword match by listing the overlapping tokens', async () => {
      const result = await search({ query: 'validator uptime', explain: true });
      const validatorResult = result.results.find(r => r.id === 'ds-validator');
      expect(validatorResult?.matchedBecause).toContain('validator');
      expect(validatorResult?.matchedBecause).toContain('uptime');
    });

    it('explains a semantic-only match (no shared keywords) using the vector similarity score', async () => {
      mockIsEmbeddingAvailable.mockResolvedValue(true);
      mockEmbedOne.mockResolvedValue(new Float32Array([1, 0]));
      mockQueryTopK.mockResolvedValue([{ datasetId: 'ds-whale', score: 0.75 }]);

      const result = await search({ query: 'large holder activity', explain: true });
      const whaleResult = result.results.find(r => r.id === 'ds-whale');
      expect(whaleResult?.matchedBecause).toContain('Semantically related');
      expect(whaleResult?.matchedBecause).toContain('75%');
      expect(whaleResult?.matchedBecause).toContain('no shared keywords');
    });
  });

  describe('rerank', () => {
    it('does not rerank when the request does not ask for it, even if the flag is enabled', async () => {
      mockIsRerankEnabled.mockReturnValue(true);
      const result = await search({ query: 'validator' });
      expect(result.reranked).toBe(false);
      expect(mockRerankCandidates).not.toHaveBeenCalled();
    });

    it('does not rerank when requested but the server-side flag is off', async () => {
      mockIsRerankEnabled.mockReturnValue(false);
      const result = await search({ query: 'validator', rerank: true });
      expect(result.reranked).toBe(false);
      expect(mockRerankCandidates).not.toHaveBeenCalled();
    });

    it('reranks when both the request opts in and the server flag is enabled', async () => {
      mockIsRerankEnabled.mockReturnValue(true);
      mockIsEmbeddingAvailable.mockResolvedValue(true);
      mockEmbedOne.mockResolvedValue(new Float32Array([1, 0]));
      // Vector arm surfaces all three, so there's more than one candidate
      // for reranking to actually reorder.
      mockQueryTopK.mockResolvedValue([
        { datasetId: 'ds-validator', score: 0.5 },
        { datasetId: 'ds-whale', score: 0.4 },
        { datasetId: 'ds-weather', score: 0.3 },
      ]);
      mockRerankCandidates.mockResolvedValue(['ds-weather', 'ds-whale', 'ds-validator']);

      const result = await search({ query: 'validator', rerank: true });
      expect(result.reranked).toBe(true);
      expect(result.results.map(r => r.id)).toEqual(['ds-weather', 'ds-whale', 'ds-validator']);
    });

    it('does not rerank a single-candidate pool (nothing to reorder)', async () => {
      mockIsRerankEnabled.mockReturnValue(true);
      const result = await search({ query: 'validator', rerank: true });
      expect(result.reranked).toBe(false);
      expect(mockRerankCandidates).not.toHaveBeenCalled();
    });
  });
});

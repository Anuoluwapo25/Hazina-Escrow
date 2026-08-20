import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RRF_K,
  keywordSearch,
  promoteExactMatches,
  reciprocalRankFusion,
  type KeywordDocument,
} from './hybrid';

const WHALE: KeywordDocument = {
  datasetId: 'ds-whale',
  name: 'Whale Wallet Movements',
  description: 'Tracks large token transfers between major holders',
  category: 'on-chain',
  type: 'whale-wallets',
  tags: ['stellar', 'whales'],
};

const VALIDATOR: KeywordDocument = {
  datasetId: 'ds-validator',
  name: 'Validator Uptime Report',
  description: 'Uptime and slashing history for Stellar validators',
  category: 'network',
  type: 'validator-health',
};

const WEATHER: KeywordDocument = {
  datasetId: 'ds-weather',
  name: 'Lagos Weather Forecast',
  description: 'Daily weather forecast for Lagos, Nigeria',
  category: 'other',
  type: 'weather',
};

describe('keywordSearch', () => {
  it('returns [] for an empty query', () => {
    expect(keywordSearch('', [WHALE, VALIDATOR])).toEqual([]);
    expect(keywordSearch('   ', [WHALE, VALIDATOR])).toEqual([]);
  });

  it('scores token overlap and excludes documents with zero overlap', () => {
    const results = keywordSearch('validator uptime', [WHALE, VALIDATOR, WEATHER]);
    const ids = results.map(r => r.datasetId);
    expect(ids).toContain('ds-validator');
    expect(ids).not.toContain('ds-weather');
    expect(ids).not.toContain('ds-whale');
  });

  it('weights name-field overlap above description overlap', () => {
    const descriptionOnlyMatch: KeywordDocument = {
      datasetId: 'ds-description-match',
      name: 'Network Health Report',
      description: 'Includes uptime statistics',
      type: 'other',
    };
    const nameMatch: KeywordDocument = {
      datasetId: 'ds-name-match',
      name: 'Uptime Tracker',
      description: 'Unrelated content',
      type: 'other',
    };
    const results = keywordSearch('uptime', [descriptionOnlyMatch, nameMatch]);
    expect(results[0]?.datasetId).toBe('ds-name-match');
  });

  it('gives an exact dataset-id match the largest bonus', () => {
    const results = keywordSearch('ds-whale', [WHALE, VALIDATOR]);
    expect(results[0]?.datasetId).toBe('ds-whale');
  });

  it('gives an exact title match a large bonus over a partial match', () => {
    const partial: KeywordDocument = {
      datasetId: 'ds-partial',
      name: 'Whale Wallet Movements and More',
      description: 'x',
      type: 'other',
    };
    const results = keywordSearch('whale wallet movements', [partial, WHALE]);
    expect(results[0]?.datasetId).toBe('ds-whale');
  });

  it('breaks score ties deterministically by dataset id', () => {
    const a: KeywordDocument = { datasetId: 'ds-b', name: 'x y', description: '', type: 't' };
    const b: KeywordDocument = { datasetId: 'ds-a', name: 'x y', description: '', type: 't' };
    const results = keywordSearch('x y', [a, b]);
    expect(results.map(r => r.datasetId)).toEqual(['ds-a', 'ds-b']);
  });

  it('is case-insensitive', () => {
    const results = keywordSearch('WHALE WALLET', [WHALE]);
    expect(results).toHaveLength(1);
  });
});

describe('reciprocalRankFusion', () => {
  it('combines two ranked lists using 1/(k+rank) per list, summed', () => {
    const keywordList = [
      { datasetId: 'a', score: 10 },
      { datasetId: 'b', score: 5 },
    ];
    const vectorList = [
      { datasetId: 'b', score: 0.9 },
      { datasetId: 'a', score: 0.5 },
    ];
    const fused = reciprocalRankFusion([keywordList, vectorList], { k: 60 });

    // a: rank 1 in keyword (1/61) + rank 2 in vector (1/62)
    // b: rank 2 in keyword (1/62) + rank 1 in vector (1/61)
    // Symmetric ranks → tied scores → alphabetical tie-break decides order.
    const expectedScore = 1 / 61 + 1 / 62;
    expect(fused[0]?.datasetId).toBe('a');
    expect(fused[0]?.score).toBeCloseTo(expectedScore, 10);
    expect(fused[1]?.score).toBeCloseTo(expectedScore, 10);
  });

  it('a document ranked #1 in both lists outscores one ranked #1 in only one', () => {
    const list1 = [
      { datasetId: 'both', score: 1 },
      { datasetId: 'only-in-1', score: 0.5 },
    ];
    const list2 = [
      { datasetId: 'both', score: 1 },
      { datasetId: 'only-in-2', score: 0.5 },
    ];
    const fused = reciprocalRankFusion([list1, list2]);
    expect(fused[0]?.datasetId).toBe('both');
    expect(fused[0]?.score).toBeCloseTo(2 / (DEFAULT_RRF_K + 1), 10);
  });

  it('a document present in only one list still scores and ranks', () => {
    const list1 = [{ datasetId: 'only-here', score: 1 }];
    const fused = reciprocalRankFusion([list1, []]);
    expect(fused).toEqual([{ datasetId: 'only-here', score: 1 / (DEFAULT_RRF_K + 1) }]);
  });

  it('is deterministic and order-stable for equal scores', () => {
    const fused = reciprocalRankFusion([
      [
        { datasetId: 'z', score: 1 },
        { datasetId: 'a', score: 1 },
      ],
    ]);
    // Both rank differently (rank 1 vs rank 2) so 'z' (rank 1) naturally wins —
    // confirms fusion respects input rank order, not alphabetical by default.
    expect(fused[0]?.datasetId).toBe('z');
  });

  it('empty input lists produce an empty result', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('promoteExactMatches', () => {
  const documents = [WHALE, VALIDATOR, WEATHER];

  it('moves an exact dataset-id match to rank 1 even if fused rank was low', () => {
    const ranked = [
      { datasetId: 'ds-weather', score: 0.9 },
      { datasetId: 'ds-validator', score: 0.5 },
      { datasetId: 'ds-whale', score: 0.01 },
    ];
    const promoted = promoteExactMatches('ds-whale', documents, ranked);
    expect(promoted[0]?.datasetId).toBe('ds-whale');
    expect(promoted).toHaveLength(3);
  });

  it('moves an exact title match (case-insensitive) to rank 1', () => {
    const ranked = [
      { datasetId: 'ds-weather', score: 0.9 },
      { datasetId: 'ds-whale', score: 0.01 },
    ];
    const promoted = promoteExactMatches('whale wallet movements', documents, ranked);
    expect(promoted[0]?.datasetId).toBe('ds-whale');
  });

  it('is a no-op when no document exactly matches the query', () => {
    const ranked = [
      { datasetId: 'ds-weather', score: 0.9 },
      { datasetId: 'ds-whale', score: 0.5 },
    ];
    expect(promoteExactMatches('large holder activity', documents, ranked)).toEqual(ranked);
  });

  it('is a no-op for an empty query', () => {
    const ranked = [{ datasetId: 'ds-whale', score: 0.5 }];
    expect(promoteExactMatches('', documents, ranked)).toEqual(ranked);
  });

  it('inserts the exact match at rank 1 even if it was entirely absent from the fused list', () => {
    const ranked = [{ datasetId: 'ds-weather', score: 0.9 }];
    const promoted = promoteExactMatches('ds-whale', documents, ranked);
    expect(promoted[0]).toEqual({ datasetId: 'ds-whale', score: 0 });
    expect(promoted).toHaveLength(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cosineSimilarity, DbVectorStore, topKBySimilarity } from './vector-store';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(
      1,
      6,
    );
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(
      -1,
      6,
    );
  });

  it('matches a hand-computed value for a non-trivial pair', () => {
    // a=[1,2,3], b=[4,5,6] → dot=32, |a|=sqrt(14), |b|=sqrt(77)
    // cos = 32 / (sqrt(14)*sqrt(77)) = 32 / sqrt(1078) ≈ 0.9746318461970762
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(32 / Math.sqrt(1078), 5);
  });

  it('is scale-invariant (normalizes out magnitude)', () => {
    const a = new Float32Array([1, 2, 3]);
    const scaled = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, scaled)).toBeCloseTo(1, 5);
  });

  it('is 0 when either vector is all zeros, rather than dividing by zero', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toThrow(
      /dimension mismatch/i,
    );
  });
});

describe('topKBySimilarity', () => {
  const entries = [
    { datasetId: 'up', vector: new Float32Array([0, 1]) },
    { datasetId: 'down', vector: new Float32Array([0, -1]) },
    { datasetId: 'right', vector: new Float32Array([1, 0]) },
    { datasetId: 'up-ish', vector: new Float32Array([0.1, 0.99]) },
  ];

  it('ranks by cosine similarity, closest first', () => {
    const results = topKBySimilarity(entries, new Float32Array([0, 1]), 4);
    expect(results.map(r => r.datasetId)).toEqual(['up', 'up-ish', 'right', 'down']);
  });

  it('respects k', () => {
    const results = topKBySimilarity(entries, new Float32Array([0, 1]), 2);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.datasetId)).toEqual(['up', 'up-ish']);
  });

  it('breaks exact-score ties deterministically by dataset id', () => {
    const tied = [
      { datasetId: 'b', vector: new Float32Array([1, 0]) },
      { datasetId: 'a', vector: new Float32Array([1, 0]) },
    ];
    const results = topKBySimilarity(tied, new Float32Array([1, 0]), 2);
    expect(results.map(r => r.datasetId)).toEqual(['a', 'b']);
  });

  it('returns [] for an empty entry list', () => {
    expect(topKBySimilarity([], new Float32Array([1, 0]), 5)).toEqual([]);
  });
});

describe('DbVectorStore', () => {
  const store = new DbVectorStore();
  const ids = ['ds-vstore-test-1', 'ds-vstore-test-2'];

  afterEach(async () => {
    await Promise.all(ids.map(id => store.delete(id)));
  });

  it('upsert then get round-trips the vector exactly', async () => {
    const vector = new Float32Array([0.1, -0.2, 0.3]);
    await store.upsert({
      datasetId: ids[0] as string,
      contentHash: 'hash-1',
      model: 'test-model',
      vector,
    });

    const stored = await store.get(ids[0] as string);
    expect(stored).not.toBeNull();
    expect(stored?.contentHash).toBe('hash-1');
    expect(stored?.model).toBe('test-model');
    expect(stored?.dims).toBe(3);
    expect(Array.from(stored?.vector ?? [])).toEqual([
      Math.fround(0.1),
      Math.fround(-0.2),
      Math.fround(0.3),
    ]);
  });

  it('get returns null for a dataset that was never indexed', async () => {
    expect(await store.get('ds-vstore-never-indexed')).toBeNull();
  });

  it('upsert overwrites the previous vector for the same dataset id', async () => {
    await store.upsert({
      datasetId: ids[0] as string,
      contentHash: 'hash-a',
      model: 'm',
      vector: new Float32Array([1, 0]),
    });
    await store.upsert({
      datasetId: ids[0] as string,
      contentHash: 'hash-b',
      model: 'm',
      vector: new Float32Array([0, 1]),
    });

    const stored = await store.get(ids[0] as string);
    expect(stored?.contentHash).toBe('hash-b');
    expect(Array.from(stored?.vector ?? [])).toEqual([0, 1]);
  });

  it('delete removes the row', async () => {
    await store.upsert({
      datasetId: ids[0] as string,
      contentHash: 'hash',
      model: 'm',
      vector: new Float32Array([1]),
    });
    await store.delete(ids[0] as string);
    expect(await store.get(ids[0] as string)).toBeNull();
  });

  it('queryTopK ranks stored vectors by cosine similarity to the query', async () => {
    await store.upsert({
      datasetId: ids[0] as string,
      contentHash: 'h1',
      model: 'm',
      vector: new Float32Array([1, 0]),
    });
    await store.upsert({
      datasetId: ids[1] as string,
      contentHash: 'h2',
      model: 'm',
      vector: new Float32Array([0, 1]),
    });

    const results = await store.queryTopK(new Float32Array([0, 1]), 1);
    expect(results[0]?.datasetId).toBe(ids[1]);
  });
});

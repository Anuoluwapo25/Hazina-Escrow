import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPipeline, mockExtractor } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  mockExtractor: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
}));

function makeOutput(vectors: number[][]): { dims: number[]; data: Float32Array } {
  const hidden = vectors[0]?.length ?? 0;
  const flat = new Float32Array(vectors.length * hidden);
  vectors.forEach((v, i) => flat.set(v, i * hidden));
  return { dims: [vectors.length, hidden], data: flat };
}

describe('embeddings', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPipeline.mockReset();
    mockExtractor.mockReset();
    mockPipeline.mockResolvedValue(mockExtractor);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] for an empty batch without touching the model', async () => {
    const { embedBatch } = await import('./embeddings');
    const result = await embedBatch([]);
    expect(result).toEqual([]);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('loads the documented model once and requests mean-pooled, normalized output', async () => {
    mockExtractor.mockResolvedValue(makeOutput([[1, 0, 0]]));
    const { embedBatch, EMBEDDING_MODEL_ID } = await import('./embeddings');
    await embedBatch(['hello']);
    expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', EMBEDDING_MODEL_ID, {
      dtype: 'q8',
    });
    expect(mockExtractor).toHaveBeenCalledWith(['hello'], { pooling: 'mean', normalize: true });
  });

  it('splits a batched tensor output back into one vector per input text', async () => {
    mockExtractor.mockResolvedValue(
      makeOutput([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]),
    );
    const { embedBatch } = await import('./embeddings');
    const vectors = await embedBatch(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    expect(Array.from(vectors[0] as Float32Array)).toEqual([1, 2, 3]);
    expect(Array.from(vectors[1] as Float32Array)).toEqual([4, 5, 6]);
    expect(Array.from(vectors[2] as Float32Array)).toEqual([7, 8, 9]);
  });

  it('loads the model only once across multiple embedBatch calls (singleton)', async () => {
    mockExtractor.mockResolvedValue(makeOutput([[1, 1]]));
    const { embedBatch } = await import('./embeddings');
    await embedBatch(['x']);
    await embedBatch(['y']);
    await embedBatch(['z']);
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockExtractor).toHaveBeenCalledTimes(3);
  });

  it('embedOne delegates to embedBatch and returns a single vector', async () => {
    mockExtractor.mockResolvedValue(makeOutput([[9, 8, 7]]));
    const { embedOne } = await import('./embeddings');
    const vector = await embedOne('solo');
    expect(Array.from(vector)).toEqual([9, 8, 7]);
  });

  it('isEmbeddingAvailable returns false and records a reason when the model fails to load', async () => {
    mockPipeline.mockRejectedValue(new Error('ENOTFOUND huggingface.co'));
    const { isEmbeddingAvailable, lastEmbeddingFailureReason } = await import('./embeddings');
    const available = await isEmbeddingAvailable();
    expect(available).toBe(false);
    expect(lastEmbeddingFailureReason()).toContain('ENOTFOUND');
  });

  it('retries the model load on a later call after a failure, instead of wedging permanently', async () => {
    mockPipeline.mockReset();
    mockPipeline.mockRejectedValueOnce(new Error('transient network error'));
    mockPipeline.mockRejectedValueOnce(new Error('still down'));
    const { embedBatch, isEmbeddingAvailable } = await import('./embeddings');

    await expect(embedBatch(['x'])).rejects.toThrow('transient network error');
    // A second attempt genuinely retries the load (not a cached rejection) —
    // it fails again here only because the network is still down in this test.
    expect(await isEmbeddingAvailable()).toBe(false);

    mockExtractor.mockResolvedValue(makeOutput([[1, 2]]));
    mockPipeline.mockResolvedValueOnce(mockExtractor);
    expect(await isEmbeddingAvailable()).toBe(true);
  });

  it('clears the failure reason once embedBatch succeeds again', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('boom'));
    const { embedBatch, lastEmbeddingFailureReason } = await import('./embeddings');
    await expect(embedBatch(['x'])).rejects.toThrow('boom');
    expect(lastEmbeddingFailureReason()).toBe('boom');

    mockPipeline.mockResolvedValueOnce(mockExtractor);
    mockExtractor.mockResolvedValue(makeOutput([[1, 2]]));
    await embedBatch(['x']);
    expect(lastEmbeddingFailureReason()).toBeNull();
  });
});

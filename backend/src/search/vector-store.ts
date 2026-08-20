/**
 * vector-store.ts — the storage interface for dataset embeddings, plus a
 * brute-force in-database implementation.
 *
 * At the current catalogue size (low hundreds of datasets), loading every
 * vector and computing cosine similarity in-process is both correct and fast
 * — well under the 200ms p95 budget — and it keeps CI dependency-free (no
 * hosted vector service). `VectorStore` is the seam: swapping this
 * implementation for a pgvector-backed one later never touches
 * hybrid.ts/search.service.ts, which only depend on this interface.
 */

import { eq } from 'drizzle-orm';
import db from '../db/client';
import { datasetEmbeddings } from '../db/schema';

export interface StoredEmbedding {
  datasetId: string;
  contentHash: string;
  model: string;
  dims: number;
  vector: Float32Array;
  updatedAt: string;
}

export interface VectorMatch {
  datasetId: string;
  /** Cosine similarity in [-1, 1] (in practice [0, 1] for normalized text embeddings). */
  score: number;
}

export interface VectorStore {
  /** Insert or replace the embedding for a dataset. */
  upsert(entry: {
    datasetId: string;
    contentHash: string;
    model: string;
    vector: Float32Array;
  }): Promise<void>;

  /** Fetch the stored embedding for a dataset, or null if never indexed. */
  get(datasetId: string): Promise<StoredEmbedding | null>;

  /** Remove a dataset's embedding (e.g. on delete). */
  delete(datasetId: string): Promise<void>;

  /** All stored embeddings — the brute-force scan set. */
  getAll(): Promise<StoredEmbedding[]>;

  /** Top-K datasets by cosine similarity to `queryVector`. */
  queryTopK(queryVector: Float32Array, k: number): Promise<VectorMatch[]>;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function encodeVector(vector: Float32Array): string {
  return JSON.stringify(Array.from(vector));
}

function decodeVector(raw: string): Float32Array {
  return Float32Array.from(JSON.parse(raw) as number[]);
}

/** Brute-force cosine-similarity vector store backed by the app's existing DB. */
export class DbVectorStore implements VectorStore {
  async upsert(entry: {
    datasetId: string;
    contentHash: string;
    model: string;
    vector: Float32Array;
  }): Promise<void> {
    const row = {
      datasetId: entry.datasetId,
      contentHash: entry.contentHash,
      model: entry.model,
      dims: entry.vector.length,
      vector: encodeVector(entry.vector),
      updatedAt: new Date().toISOString(),
    };
    await db
      .insert(datasetEmbeddings)
      .values(row)
      .onConflictDoUpdate({ target: datasetEmbeddings.datasetId, set: row });
  }

  async get(datasetId: string): Promise<StoredEmbedding | null> {
    const rows = await db
      .select()
      .from(datasetEmbeddings)
      .where(eq(datasetEmbeddings.datasetId, datasetId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      datasetId: row.datasetId,
      contentHash: row.contentHash,
      model: row.model,
      dims: row.dims,
      vector: decodeVector(row.vector),
      updatedAt: row.updatedAt,
    };
  }

  async delete(datasetId: string): Promise<void> {
    await db.delete(datasetEmbeddings).where(eq(datasetEmbeddings.datasetId, datasetId));
  }

  async getAll(): Promise<StoredEmbedding[]> {
    const rows = (await db.select().from(datasetEmbeddings)) as Array<{
      datasetId: string;
      contentHash: string;
      model: string;
      dims: number;
      vector: string;
      updatedAt: string;
    }>;
    return rows.map(row => ({
      datasetId: row.datasetId,
      contentHash: row.contentHash,
      model: row.model,
      dims: row.dims,
      vector: decodeVector(row.vector),
      updatedAt: row.updatedAt,
    }));
  }

  async queryTopK(queryVector: Float32Array, k: number): Promise<VectorMatch[]> {
    const all = await this.getAll();
    return topKBySimilarity(all, queryVector, k);
  }
}

/** Pure helper (no DB) so the ranking logic can be unit-tested against hand-built vectors. */
export function topKBySimilarity(
  entries: Pick<StoredEmbedding, 'datasetId' | 'vector'>[],
  queryVector: Float32Array,
  k: number,
): VectorMatch[] {
  const scored = entries.map(entry => ({
    datasetId: entry.datasetId,
    score: cosineSimilarity(queryVector, entry.vector),
  }));
  scored.sort((a, b) => b.score - a.score || a.datasetId.localeCompare(b.datasetId));
  return scored.slice(0, k);
}

let sharedStore: VectorStore | null = null;

/** Process-wide singleton — one store instance shared across requests. */
export function getVectorStore(): VectorStore {
  if (!sharedStore) sharedStore = new DbVectorStore();
  return sharedStore;
}

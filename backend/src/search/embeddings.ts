/**
 * embeddings.ts — turns text into vectors for semantic search.
 *
 * Model choice: `Xenova/all-MiniLM-L6-v2` (sentence-transformers/all-MiniLM-L6-v2,
 * ONNX-converted for in-process inference via `@huggingface/transformers`),
 * mean-pooled and L2-normalized to 384 dims.
 *
 *   - Runs locally, in-process — no hosted embeddings API, no new API key.
 *     CLAUDE.md requires LLM calls to route through local Claude Code rather
 *     than a hosted LLM API; Claude has no embeddings endpoint, and a local
 *     sentence-transformer is the closest fit to that constraint (zero new
 *     vendor, zero marginal cost, works fully offline).
 *   - 384 dims / ~90MB keeps memory and brute-force cosine-similarity scans
 *     cheap at this catalogue size — a larger model wouldn't move search
 *     quality enough here to be worth the extra latency.
 *   - Trained on 1B+ sentence pairs including general web/paraphrase data,
 *     so it captures common crypto-slang synonymy (e.g. "whale" ~ "large
 *     holder") without any domain fine-tuning.
 *
 * The model is fetched from the Hugging Face Hub on first use and cached
 * locally by `@huggingface/transformers` afterwards (no re-download).
 */

import { logger } from '../lib/logger';

export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

// Minimal structural type for the piece of the transformers.js API this file
// uses — avoids depending on the package's (ESM-only) types from a CJS build.
interface FeatureExtractionOutput {
  dims: number[];
  data: Float32Array;
}
type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<FeatureExtractionOutput>;

let extractorPromise: Promise<FeatureExtractor> | null = null;
let unavailableReason: string | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  // Dynamic import: @huggingface/transformers is ESM-only, and this is the
  // standard, TypeScript-preserved way to load an ESM package from a
  // CommonJS module (tsc does not downlevel `import()` to `require`).
  const { pipeline } = await import('@huggingface/transformers');
  // q8 (int8) quantized weights: ~4x smaller download than fp32, faster CPU
  // inference, and no meaningful loss for sentence-similarity ranking at
  // this scale — the difference shows up in the 4th decimal of cosine
  // similarity, well below anything that could flip a ranking.
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' });
  return extractor as unknown as FeatureExtractor;
}

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = loadExtractor().catch((err: unknown) => {
      // Reset so a later call can retry (e.g. a transient network blip on the
      // very first model download) rather than permanently wedging the process.
      extractorPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      unavailableReason = message;
      logger.error(
        `[Search] Embedding model unavailable, falling back to keyword-only: ${message}`,
      );
      throw err;
    });
  }
  return extractorPromise;
}

/**
 * True once the embedding model has failed to load at least once. Callers
 * use this to skip straight to a keyword-only search instead of retrying a
 * model load on every request (see search.service.ts's graceful degradation).
 * Cleared automatically the next time `embedBatch` succeeds.
 */
export function lastEmbeddingFailureReason(): string | null {
  return unavailableReason;
}

/** Embeds a batch of texts in a single model call. Returns `[]` for `[]`. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  unavailableReason = null;

  const dims = output.dims;
  const hiddenSize = dims[dims.length - 1] as number;
  const flat = output.data;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(flat.slice(i * hiddenSize, (i + 1) * hiddenSize));
  }
  return vectors;
}

/** Embeds a single text. Convenience wrapper around {@link embedBatch}. */
export async function embedOne(text: string): Promise<Float32Array> {
  const [vector] = await embedBatch([text]);
  return vector as Float32Array;
}

/**
 * Attempts to load the model without throwing. Used at indexing/query time to
 * decide whether to run semantic search at all (graceful degradation to
 * keyword-only search — see search.service.ts).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getExtractor();
    return true;
  } catch {
    return false;
  }
}

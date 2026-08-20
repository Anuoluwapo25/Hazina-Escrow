/**
 * indexer.ts — keeps the search index (vector-store.ts) in sync with
 * dataset content. Called on publish, on edit, and on provider refresh.
 *
 * Never throws: indexing is a best-effort side effect of a write that has
 * already succeeded (the dataset is published either way), matching the
 * fire-and-forget pattern used for webhook notifications elsewhere in this
 * codebase. Failures are logged, not surfaced to the caller.
 */

import type { Dataset } from '../common/storage';
import { composeSearchDocument, stableSearchDocument, contentHashOf } from './document';
import { embedOne, isEmbeddingAvailable, EMBEDDING_MODEL_ID } from './embeddings';
import { getVectorStore, type VectorStore } from './vector-store';
import { logger } from '../lib/logger';

export type IndexOutcome =
  | { indexed: true; reason: 'embedded' }
  | { indexed: false; reason: 'unchanged' | 'embeddings-unavailable' | 'error' };

/**
 * Indexes a single dataset. Re-embeds only when the *stable* document (shape,
 * not sample values — see document.ts) hash differs from what's stored, so a
 * live-refreshed dataset whose numbers change every cycle doesn't re-embed
 * every cycle. The full document (including sample values) is still what
 * actually gets embedded, for richer signal.
 */
export async function indexDataset(
  dataset: Dataset,
  store: VectorStore = getVectorStore(),
): Promise<IndexOutcome> {
  const contentHash = contentHashOf(stableSearchDocument(dataset));

  try {
    const existing = await store.get(dataset.id);
    if (existing && existing.contentHash === contentHash && existing.model === EMBEDDING_MODEL_ID) {
      return { indexed: false, reason: 'unchanged' };
    }

    // Checked explicitly (rather than just catching embedOne's rejection) so
    // an unavailable model is reported as a distinct, expected outcome —
    // search still works via keyword-only fallback — not lumped in with a
    // genuine indexing bug.
    if (!(await isEmbeddingAvailable())) {
      return { indexed: false, reason: 'embeddings-unavailable' };
    }

    const vector = await embedOne(composeSearchDocument(dataset));
    await store.upsert({ datasetId: dataset.id, contentHash, model: EMBEDDING_MODEL_ID, vector });
    return { indexed: true, reason: 'embedded' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Search] Failed to index dataset ${dataset.id}: ${message}`);
    return { indexed: false, reason: 'error' };
  }
}

/** Fire-and-forget wrapper for call sites that must not block on indexing. */
export function indexDatasetInBackground(dataset: Dataset): void {
  indexDataset(dataset).catch(err => {
    logger.error(
      `[Search] Unexpected indexing error for ${dataset.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export interface ReindexSummary {
  total: number;
  embedded: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

/** Re-indexes every dataset given. Used by the backfill script and tests. */
export async function reindexAll(
  datasets: Dataset[],
  store: VectorStore = getVectorStore(),
): Promise<ReindexSummary> {
  const summary: ReindexSummary = {
    total: datasets.length,
    embedded: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
  };
  for (const dataset of datasets) {
    const outcome = await indexDataset(dataset, store);
    if (outcome.indexed) summary.embedded += 1;
    else if (outcome.reason === 'unchanged') summary.unchanged += 1;
    else if (outcome.reason === 'embeddings-unavailable') summary.skipped += 1;
    else summary.errors += 1;
  }
  return summary;
}

/**
 * backfill-search-index.ts — indexes every existing dataset for semantic
 * search. Run once after deploying the search feature (new installs index
 * automatically on publish/refresh — this is only for datasets that already
 * existed before the feature shipped).
 *
 * Usage: npm run search:backfill --prefix backend
 */
import { getAllDatasets } from '../src/common/storage';
import { reindexAll } from '../src/search/indexer';
import { logger } from '../src/lib/logger';

async function main(): Promise<void> {
  const datasets = await getAllDatasets();
  logger.info(`[Search] Backfilling search index for ${datasets.length} datasets...`);

  const summary = await reindexAll(datasets);

  logger.info(
    `[Search] Backfill complete: ${summary.embedded} embedded, ${summary.unchanged} already up to date, ` +
      `${summary.skipped} skipped (embedding model unavailable), ${summary.errors} errors ` +
      `(out of ${summary.total} total).`,
  );

  if (summary.skipped > 0) {
    logger.warn(
      '[Search] Some datasets were skipped because the embedding model was unavailable — ' +
        're-run this script once the model can load (see search/embeddings.ts).',
    );
  }
  if (summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  logger.error(`[Search] Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

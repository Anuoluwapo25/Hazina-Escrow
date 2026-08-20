/**
 * Backfill script: gives every existing dataset an opening snapshot so its
 * history starts today rather than at its next refresh (#600).
 *
 * Usage:
 *   npm run snapshots:backfill --prefix backend
 *
 * Idempotent — a dataset that already has an open snapshot is left alone, so
 * running this twice changes nothing.
 */
import { logger } from '../lib/logger';
import { backfillSnapshots } from './snapshots.service';

backfillSnapshots()
  .then(result => {
    logger.info(
      `[Snapshots] Backfill created ${result.created} snapshots; ${result.skipped} datasets already had history`,
    );
    process.exit(0);
  })
  .catch((err: unknown) => {
    logger.error(
      `[Snapshots] Backfill failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });

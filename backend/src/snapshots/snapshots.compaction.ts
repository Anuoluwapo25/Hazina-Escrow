/**
 * snapshots.compaction.ts — retention and downsampling (#600).
 *
 * History grows without bound unless something bounds it. Compaction thins old
 * snapshots to a coarser resolution the further back they sit — every snapshot
 * for the first week, one an hour for the first quarter, one a day after that —
 * and drops anything past the dataset's retention window entirely.
 *
 * Two rules are absolute:
 *
 * 1. The snapshot that is live now is never deleted.
 * 2. A snapshot referenced by a completed purchase is never deleted, whatever
 *    the policy says — it is the evidence a dispute is settled against.
 *
 * Deletions hand their time back to the preceding survivor, so the timeline
 * stays gap-free: reading `asOf` any instant still resolves to the snapshot that
 * best represents what the dataset held then.
 */

import { getAllDatasets, getPurchasedSnapshotIds } from '../common/storage';
import { logger } from '../lib/logger';
import {
  deleteSnapshotsWithHandover,
  listAllSnapshots,
  listDatasetIdsWithHistory,
} from './snapshots.repository';
import { resolveRetentionPolicy } from './snapshots.service';
import {
  DEFAULT_RETENTION_POLICY,
  type DatasetSnapshot,
  type SnapshotRetentionPolicy,
} from './snapshots.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CompactionResult {
  datasetsScanned: number;
  snapshotsDeleted: number;
  bytesReclaimed: number;
  /** Snapshots a policy would have dropped but a purchase pinned. */
  pinnedRetained: number;
}

/** Bucket key a snapshot collapses into at its age. */
function bucketKey(validFrom: string, ageDays: number, policy: SnapshotRetentionPolicy): string {
  if (ageDays <= policy.hourlyDays) return validFrom.slice(0, 13); // YYYY-MM-DDTHH
  return validFrom.slice(0, 10); // YYYY-MM-DD
}

/**
 * Decide which snapshots of one dataset a policy discards.
 *
 * Exported for testing: the decision is pure, so compaction correctness can be
 * asserted against a hand-built timeline without touching the database.
 */
export function planCompaction(
  ordered: DatasetSnapshot[],
  policy: SnapshotRetentionPolicy,
  pinned: Set<string>,
  now: number,
): { deleteIds: string[]; pinnedRetained: number } {
  const deleteIds: string[] = [];
  const keptPerBucket = new Set<string>();
  let pinnedRetained = 0;

  for (const snapshot of ordered) {
    // The open range is the dataset's current payload — always keep it.
    if (snapshot.validTo === null) continue;

    const ageDays = (now - Date.parse(snapshot.validFrom)) / MS_PER_DAY;
    if (ageDays <= policy.fullResolutionDays) continue;

    const expired = policy.retentionDays !== null && ageDays > policy.retentionDays;
    if (!expired) {
      const key = bucketKey(snapshot.validFrom, ageDays, policy);
      if (!keptPerBucket.has(key)) {
        keptPerBucket.add(key);
        continue;
      }
    }

    if (pinned.has(snapshot.id)) {
      pinnedRetained += 1;
      continue;
    }
    deleteIds.push(snapshot.id);
  }

  return { deleteIds, pinnedRetained };
}

/**
 * Re-link survivors so their ranges stay contiguous after deletions: each one
 * runs until the next survivor starts.
 */
function planHandover(
  ordered: DatasetSnapshot[],
  deleteIds: Set<string>,
): Map<string, string | null> {
  const survivors = ordered.filter(snapshot => !deleteIds.has(snapshot.id));
  const extendTo = new Map<string, string | null>();

  survivors.forEach((snapshot, index) => {
    const next = survivors[index + 1];
    const desired = next ? next.validFrom : snapshot.validTo;
    if (desired !== snapshot.validTo) extendTo.set(snapshot.id, desired);
  });

  return extendTo;
}

async function compactDataset(
  datasetId: string,
  policy: SnapshotRetentionPolicy,
  now: number,
): Promise<{ deleted: number; bytes: number; pinnedRetained: number }> {
  const ordered = await listAllSnapshots(datasetId);
  if (ordered.length === 0) return { deleted: 0, bytes: 0, pinnedRetained: 0 };

  const pinned = await getPurchasedSnapshotIds(datasetId);
  const { deleteIds, pinnedRetained } = planCompaction(ordered, policy, pinned, now);
  if (deleteIds.length === 0) return { deleted: 0, bytes: 0, pinnedRetained };

  const deleteSet = new Set(deleteIds);
  const bytes = ordered
    .filter(snapshot => deleteSet.has(snapshot.id))
    .reduce((sum, snapshot) => sum + snapshot.byteSize, 0);

  await deleteSnapshotsWithHandover(deleteIds, planHandover(ordered, deleteSet));
  return { deleted: deleteIds.length, bytes, pinnedRetained };
}

/**
 * Compact every dataset's history. Snapshots whose dataset no longer exists are
 * compacted under the platform default policy, so a deleted dataset's history
 * ages out instead of living forever.
 */
export async function compactAllSnapshots(now: number = Date.now()): Promise<CompactionResult> {
  const datasets = await getAllDatasets();
  const policyByDataset = new Map(
    datasets.map(dataset => [dataset.id, resolveRetentionPolicy(dataset)]),
  );
  const datasetIds = await listDatasetIdsWithHistory();

  const result: CompactionResult = {
    datasetsScanned: datasetIds.length,
    snapshotsDeleted: 0,
    bytesReclaimed: 0,
    pinnedRetained: 0,
  };

  for (const datasetId of datasetIds) {
    const policy = policyByDataset.get(datasetId) ?? DEFAULT_RETENTION_POLICY;
    const { deleted, bytes, pinnedRetained } = await compactDataset(datasetId, policy, now);
    result.snapshotsDeleted += deleted;
    result.bytesReclaimed += bytes;
    result.pinnedRetained += pinnedRetained;
  }

  if (result.snapshotsDeleted > 0 || result.pinnedRetained > 0) {
    logger.info(
      `[Snapshots] Compaction removed ${result.snapshotsDeleted} snapshots ` +
        `(${result.bytesReclaimed} bytes) across ${result.datasetsScanned} datasets; ` +
        `${result.pinnedRetained} retained for completed purchases`,
    );
  }

  return result;
}

const DEFAULT_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_COMPACTION_INTERVAL_MS = 60_000;

let compactionTimer: NodeJS.Timeout | null = null;

function getCompactionIntervalMs(): number {
  const raw = process.env.SNAPSHOT_COMPACTION_INTERVAL_MS;
  if (!raw) return DEFAULT_COMPACTION_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= MIN_COMPACTION_INTERVAL_MS
    ? parsed
    : DEFAULT_COMPACTION_INTERVAL_MS;
}

/**
 * Start the scheduled compaction job. Disabled with
 * `SNAPSHOT_COMPACTION_ENABLED=false` (tests and CI set this).
 */
export function startSnapshotCompactionWorker(): void {
  if (process.env.SNAPSHOT_COMPACTION_ENABLED === 'false') {
    logger.info('[Snapshots] Compaction disabled via SNAPSHOT_COMPACTION_ENABLED=false');
    return;
  }
  if (compactionTimer) return;

  const intervalMs = getCompactionIntervalMs();
  logger.info(
    `[Snapshots] Starting compaction worker (every ${Math.round(intervalMs / 60_000)} min)`,
  );

  compactionTimer = setInterval(() => {
    compactAllSnapshots().catch(err =>
      logger.error(
        `[Snapshots] compaction run failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, intervalMs);
  compactionTimer.unref?.();
}

export function stopSnapshotCompactionWorker(): void {
  if (!compactionTimer) return;
  clearInterval(compactionTimer);
  compactionTimer = null;
  logger.info('[Snapshots] Compaction worker stopped');
}

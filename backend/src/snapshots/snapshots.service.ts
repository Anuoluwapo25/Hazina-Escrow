/**
 * snapshots.service.ts — the snapshot writer and its readers (#600).
 *
 * A refresh no longer overwrites a dataset's payload and forgets the old one:
 * it appends to an immutable, content-addressed history. Identical consecutive
 * payloads — the normal case for a polled provider — cost zero extra rows.
 */

import { getAllDatasets, type Dataset } from '../common/storage';
import { logger } from '../lib/logger';
import { canonicalize, contentHash, stripVolatileKeys } from './canonical';
import { decodePayload, encodePayload } from './compression';
import {
  getCurrentSnapshot,
  getSnapshotAsOf,
  recordObservation,
  writeSnapshotTransition,
} from './snapshots.repository';
import {
  DEFAULT_RETENTION_POLICY,
  toIsoInstant,
  type DatasetSnapshot,
  type SnapshotRetentionPolicy,
} from './snapshots.types';

export interface RecordSnapshotOptions {
  /** Instant the payload became live; defaults to now. */
  at?: string | Date;
  /** Correlates every snapshot written by one refresh sweep. */
  providerRunId?: string;
}

export interface RecordSnapshotResult {
  snapshot: DatasetSnapshot;
  /** False when the payload was unchanged and an observation was recorded. */
  created: boolean;
}

/**
 * Append `payload` to a dataset's history.
 *
 * Unchanged content extends the live snapshot instead of duplicating it, which
 * is what keeps a five-minute feed from writing 288 identical blobs a day.
 */
export async function recordDatasetSnapshot(
  datasetId: string,
  payload: Record<string, unknown>,
  options: RecordSnapshotOptions = {},
): Promise<RecordSnapshotResult> {
  const content = stripVolatileKeys(payload);
  const canonicalJson = canonicalize(content);
  const hash = contentHash(content);
  const observedAt = toIsoInstant(options.at ?? new Date());

  const current = await getCurrentSnapshot(datasetId);
  if (current && current.contentHash === hash) {
    const lastObservedAt =
      observedAt > current.lastObservedAt ? observedAt : current.lastObservedAt;
    await recordObservation(current.id, lastObservedAt);
    return {
      created: false,
      snapshot: {
        ...current,
        observations: current.observations + 1,
        lastObservedAt,
      },
    };
  }

  // A snapshot may never open before (or exactly on) the one it replaces:
  // equal bounds would produce a zero-length range that no `asOf` can address,
  // and an earlier bound would invert the timeline. Provider clocks and
  // sub-millisecond refreshes both make this reachable, so nudge instead.
  const validFrom =
    current && observedAt <= current.validFrom
      ? new Date(Date.parse(current.validFrom) + 1).toISOString()
      : observedAt;

  const encoded = encodePayload(canonicalJson);
  const snapshot = await writeSnapshotTransition({
    datasetId,
    contentHash: hash,
    payload: encoded.payload,
    encoding: encoded.encoding,
    validFrom,
    byteSize: encoded.byteSize,
    rawByteSize: encoded.rawByteSize,
    providerRunId: options.providerRunId,
  });

  return { created: true, snapshot };
}

/** Decode a stored snapshot back into the payload that was live at the time. */
export function readSnapshotPayload(snapshot: DatasetSnapshot): Record<string, unknown> {
  const json = decodePayload(snapshot.payload, snapshot.encoding);
  return JSON.parse(json) as Record<string, unknown>;
}

/** The payload a dataset served at `asOf`, or undefined if history predates it. */
export async function getPayloadAsOf(
  datasetId: string,
  asOf: string | Date,
): Promise<{ snapshot: DatasetSnapshot; payload: Record<string, unknown> } | undefined> {
  const snapshot = await getSnapshotAsOf(datasetId, asOf);
  if (!snapshot) return undefined;
  return { snapshot, payload: readSnapshotPayload(snapshot) };
}

/** Read a dataset's retention policy, falling back to platform defaults. */
export function resolveRetentionPolicy(dataset: Dataset): SnapshotRetentionPolicy {
  if (!dataset.snapshotPolicy) return DEFAULT_RETENTION_POLICY;
  return { ...DEFAULT_RETENTION_POLICY, ...dataset.snapshotPolicy };
}

export interface BackfillResult {
  created: number;
  skipped: number;
}

/**
 * Give every existing dataset a first snapshot so history starts today rather
 * than at its next refresh.
 *
 * Idempotent: a dataset that already has an open snapshot is left untouched, so
 * running this twice changes nothing. The initial range opens at the dataset's
 * last refresh (or its creation date) because that is when the payload on the
 * row actually became live.
 */
export async function backfillSnapshots(): Promise<BackfillResult> {
  const datasets = await getAllDatasets();
  let created = 0;
  let skipped = 0;

  for (const dataset of datasets) {
    const current = await getCurrentSnapshot(dataset.id);
    if (current) {
      skipped += 1;
      continue;
    }
    const at = dataset.lastRefreshedAt ?? dataset.createdAt ?? new Date().toISOString();
    const result = await recordDatasetSnapshot(dataset.id, dataset.data, {
      at,
      providerRunId: 'backfill',
    });
    if (result.created) created += 1;
    else skipped += 1;
  }

  logger.info(`[Snapshots] Backfill complete — ${created} created, ${skipped} already had history`);
  return { created, skipped };
}

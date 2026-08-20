/**
 * snapshots.types.ts — the vocabulary of dataset history (#600).
 */

/** A stored, immutable version of a dataset payload. */
export interface DatasetSnapshot {
  id: string;
  datasetId: string;
  /** `sha256` of the canonical payload — the content address. */
  contentHash: string;
  /** Encoded payload as stored; decode with `decodePayload`. */
  payload: string;
  encoding: string;
  /** ISO instant this content became live (inclusive). */
  validFrom: string;
  /** ISO instant this content stopped being live (exclusive); null = current. */
  validTo: string | null;
  /** Bytes stored after compression. */
  byteSize: number;
  /** Bytes the canonical JSON occupies uncompressed. */
  rawByteSize: number;
  /** How many refreshes observed this exact content. */
  observations: number;
  lastObservedAt: string;
  providerRunId: string | null;
  createdAt: string;
}

/** Snapshot without its payload — safe to hand to any caller. */
export type SnapshotMeta = Omit<DatasetSnapshot, 'payload' | 'encoding'>;

/**
 * Per-dataset history retention. Defaults keep every snapshot for a week, one
 * per hour for a quarter, then one per day until `retentionDays` elapses.
 */
export interface SnapshotRetentionPolicy {
  /** Snapshots older than this are deleted outright; null = keep forever. */
  retentionDays: number | null;
  /** Age (days) below which every snapshot is kept. */
  fullResolutionDays: number;
  /** Age (days) below which one snapshot per hour is kept. */
  hourlyDays: number;
}

export const DEFAULT_RETENTION_POLICY: SnapshotRetentionPolicy = {
  retentionDays: 365,
  fullResolutionDays: 7,
  hourlyDays: 90,
};

/** Hard ceiling on snapshots returned by any single history request. */
export const MAX_SNAPSHOTS_PER_REQUEST = 200;

/** Default page size for history listings. */
export const DEFAULT_SNAPSHOTS_PER_REQUEST = 50;

/**
 * Normalise any accepted timestamp to a UTC ISO instant with milliseconds.
 *
 * Validity ranges are compared as text in SQL, which is only sound when every
 * stored and queried instant shares one format — so every timestamp entering
 * the snapshot layer goes through here. Throws on an unparseable input.
 */
export function toIsoInstant(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/**
 * snapshots.repository.ts — persistence for dataset history (#600).
 *
 * The invariant every function here protects: for a given dataset the validity
 * ranges of its snapshots tile the timeline exactly — sorted by `validFrom`,
 * each row's `validTo` equals the next row's `validFrom`, and only the last row
 * is open (`validTo IS NULL`). No overlaps, no gaps. Callers get point-in-time
 * and range reads on top of that guarantee.
 */

import { and, asc, desc, eq, gt, isNull, isNotNull, lt, lte, or, sql, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/client';
import { datasetSnapshotsSqlite } from '../db/schema';
import { toIsoInstant, type DatasetSnapshot, type SnapshotMeta } from './snapshots.types';

const snapshots = datasetSnapshotsSqlite;

/**
 * better-sqlite3 executes statements synchronously, so a real BEGIN/COMMIT can
 * wrap a group of writes only when the callback is synchronous too. Detect that
 * driver once by looking for the sync `.all()` escape hatch on a query builder;
 * on any other driver we fall back to running the same statements sequentially.
 */
const driverProbe: unknown = db.select().from(snapshots);
const supportsSyncTransaction: boolean =
  typeof (driverProbe as { all?: unknown }).all === 'function';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function rowToSnapshot(row: Row): DatasetSnapshot {
  return {
    id: row.id,
    datasetId: row.datasetId,
    contentHash: row.contentHash,
    payload: row.payload,
    encoding: row.encoding,
    validFrom: row.validFrom,
    validTo: row.validTo ?? null,
    byteSize: Number(row.byteSize ?? 0),
    rawByteSize: Number(row.rawByteSize ?? 0),
    observations: Number(row.observations ?? 1),
    lastObservedAt: row.lastObservedAt,
    providerRunId: row.providerRunId ?? null,
    createdAt: row.createdAt,
  };
}

/** Drop the payload so history can be listed without leaking paid content. */
export function toSnapshotMeta(snapshot: DatasetSnapshot): SnapshotMeta {
  const { payload: _payload, encoding: _encoding, ...meta } = snapshot;
  return meta;
}

export interface NewSnapshot {
  datasetId: string;
  contentHash: string;
  payload: string;
  encoding: string;
  validFrom: string;
  byteSize: number;
  rawByteSize: number;
  providerRunId?: string;
}

/** The snapshot that is live right now, if the dataset has any history. */
export async function getCurrentSnapshot(datasetId: string): Promise<DatasetSnapshot | undefined> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.datasetId, datasetId), isNull(snapshots.validTo)))
    .orderBy(desc(snapshots.validFrom))
    .limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : undefined;
}

/**
 * Point-in-time read: the snapshot whose range contains `asOf`.
 *
 * Ranges are half-open — `validFrom <= asOf < validTo` — so an `asOf` exactly
 * equal to a `validFrom` resolves to that snapshot, never its predecessor.
 */
export async function getSnapshotAsOf(
  datasetId: string,
  asOf: string | Date,
): Promise<DatasetSnapshot | undefined> {
  const at = toIsoInstant(asOf);
  const rows = await db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.datasetId, datasetId),
        lte(snapshots.validFrom, at),
        or(isNull(snapshots.validTo), gt(snapshots.validTo, at)),
      ),
    )
    .orderBy(desc(snapshots.validFrom))
    .limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : undefined;
}

export async function getSnapshotById(id: string): Promise<DatasetSnapshot | undefined> {
  const rows = await db.select().from(snapshots).where(eq(snapshots.id, id)).limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : undefined;
}

export async function getSnapshotByHash(
  datasetId: string,
  contentHash: string,
): Promise<DatasetSnapshot | undefined> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.datasetId, datasetId), eq(snapshots.contentHash, contentHash)))
    .orderBy(asc(snapshots.validFrom))
    .limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : undefined;
}

export interface RangeQuery {
  /** Inclusive lower bound (ISO); omit for "since the beginning". */
  from?: string;
  /** Exclusive upper bound (ISO); omit for "up to now". */
  to?: string;
  limit: number;
  offset?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rangeCondition(datasetId: string, from?: string, to?: string): any {
  const clauses = [eq(snapshots.datasetId, datasetId)];
  if (to !== undefined) clauses.push(lt(snapshots.validFrom, toIsoInstant(to)));
  if (from !== undefined) {
    const start = toIsoInstant(from);
    // A snapshot belongs to the window when its range overlaps it — including
    // the one that opened before `from` and was still live at `from`.
    const stillLiveAtStart = or(isNull(snapshots.validTo), gt(snapshots.validTo, start));
    if (stillLiveAtStart) clauses.push(stillLiveAtStart);
  }
  return and(...clauses);
}

/** Snapshots overlapping `[from, to)`, oldest first, capped by `limit`. */
export async function listSnapshotsInRange(
  datasetId: string,
  query: RangeQuery,
): Promise<DatasetSnapshot[]> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(rangeCondition(datasetId, query.from, query.to))
    .orderBy(asc(snapshots.validFrom))
    .limit(query.limit)
    .offset(query.offset ?? 0);
  return rows.map(rowToSnapshot);
}

/** Total snapshots overlapping `[from, to)` — the pagination denominator. */
export async function countSnapshotsInRange(
  datasetId: string,
  from?: string,
  to?: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(snapshots)
    .where(rangeCondition(datasetId, from, to));
  return Number(rows[0]?.count ?? 0);
}

/** Every snapshot of a dataset, oldest first. Compaction and tests only. */
export async function listAllSnapshots(datasetId: string): Promise<DatasetSnapshot[]> {
  const rows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.datasetId, datasetId))
    .orderBy(asc(snapshots.validFrom));
  return rows.map(rowToSnapshot);
}

/** Distinct dataset ids that have history — the compaction work list. */
export async function listDatasetIdsWithHistory(): Promise<string[]> {
  const rows = await db.selectDistinct({ datasetId: snapshots.datasetId }).from(snapshots);
  return rows.map((row: Row) => row.datasetId as string);
}

/**
 * Record another sighting of already-stored content: no new row, the current
 * range simply keeps running and the observation counter advances.
 */
export async function recordObservation(snapshotId: string, observedAt: string): Promise<void> {
  await db
    .update(snapshots)
    .set({
      observations: sql`${snapshots.observations} + 1`,
      lastObservedAt: toIsoInstant(observedAt),
    })
    .where(eq(snapshots.id, snapshotId));
}

/**
 * Close the open range and open a new one at `validFrom`, atomically.
 *
 * Doing this in two independent statements would leave a window in which the
 * dataset has either two live snapshots (overlap) or none (gap), so the pair is
 * wrapped in a transaction wherever the driver can provide one.
 */
export async function writeSnapshotTransition(next: NewSnapshot): Promise<DatasetSnapshot> {
  const validFrom = toIsoInstant(next.validFrom);
  const row = {
    id: `snap-${uuidv4()}`,
    datasetId: next.datasetId,
    contentHash: next.contentHash,
    payload: next.payload,
    encoding: next.encoding,
    validFrom,
    validTo: null,
    byteSize: next.byteSize,
    rawByteSize: next.rawByteSize,
    observations: 1,
    lastObservedAt: validFrom,
    providerRunId: next.providerRunId ?? null,
    createdAt: new Date().toISOString(),
  };

  const closeCondition = and(eq(snapshots.datasetId, next.datasetId), isNull(snapshots.validTo));

  if (supportsSyncTransaction) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.transaction((tx: any) => {
      tx.update(snapshots).set({ validTo: validFrom }).where(closeCondition).run();
      tx.insert(snapshots).values(row).run();
    });
  } else {
    await db.update(snapshots).set({ validTo: validFrom }).where(closeCondition);
    await db.insert(snapshots).values(row);
  }

  return rowToSnapshot(row);
}

/**
 * Delete snapshots and hand their time back to the surviving predecessor so the
 * timeline stays gap-free. `extendTo` maps a surviving snapshot id to the
 * `validTo` it must adopt (the `validTo` of the last row deleted after it).
 */
export async function deleteSnapshotsWithHandover(
  ids: string[],
  extendTo: Map<string, string | null>,
): Promise<void> {
  if (ids.length === 0 && extendTo.size === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apply = (executor: any, run: boolean): void => {
    for (const [id, validTo] of extendTo) {
      const statement = executor.update(snapshots).set({ validTo }).where(eq(snapshots.id, id));
      if (run) statement.run();
    }
    if (ids.length > 0) {
      const statement = executor.delete(snapshots).where(inArray(snapshots.id, ids));
      if (run) statement.run();
    }
  };

  if (supportsSyncTransaction) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.transaction((tx: any) => apply(tx, true));
    return;
  }

  for (const [id, validTo] of extendTo) {
    await db.update(snapshots).set({ validTo }).where(eq(snapshots.id, id));
  }
  if (ids.length > 0) {
    await db.delete(snapshots).where(inArray(snapshots.id, ids));
  }
}

/** Remove every snapshot of a dataset (dataset deletion, test teardown). */
export async function deleteSnapshotsForDataset(datasetId: string): Promise<void> {
  await db.delete(snapshots).where(eq(snapshots.datasetId, datasetId));
}

export interface SnapshotStorageStats {
  snapshotCount: number;
  /** Snapshots whose range has closed — i.e. actual history. */
  closedCount: number;
  storedBytes: number;
  rawBytes: number;
  observations: number;
  oldestValidFrom: string | null;
  newestValidFrom: string | null;
}

/** Aggregate storage footprint of a dataset's history. */
export async function getStorageStats(datasetId: string): Promise<SnapshotStorageStats> {
  const rows = await db
    .select({
      snapshotCount: sql<number>`count(*)`,
      storedBytes: sql<number>`coalesce(sum(${snapshots.byteSize}), 0)`,
      rawBytes: sql<number>`coalesce(sum(${snapshots.rawByteSize}), 0)`,
      observations: sql<number>`coalesce(sum(${snapshots.observations}), 0)`,
      oldestValidFrom: sql<string | null>`min(${snapshots.validFrom})`,
      newestValidFrom: sql<string | null>`max(${snapshots.validFrom})`,
    })
    .from(snapshots)
    .where(eq(snapshots.datasetId, datasetId));

  const closed = await db
    .select({ count: sql<number>`count(*)` })
    .from(snapshots)
    .where(and(eq(snapshots.datasetId, datasetId), isNotNull(snapshots.validTo)));

  const row = rows[0];
  return {
    snapshotCount: Number(row?.snapshotCount ?? 0),
    closedCount: Number(closed[0]?.count ?? 0),
    storedBytes: Number(row?.storedBytes ?? 0),
    rawBytes: Number(row?.rawBytes ?? 0),
    observations: Number(row?.observations ?? 0),
    oldestValidFrom: row?.oldestValidFrom ?? null,
    newestValidFrom: row?.newestValidFrom ?? null,
  };
}

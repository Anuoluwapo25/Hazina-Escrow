/**
 * snapshots.router.ts — the dataset time machine's HTTP surface (#600).
 *
 * Mounted alongside the datasets router, so every route hangs off a dataset:
 * `/api/datasets/:id/history`, `/api/datasets/:id/snapshots/...`.
 *
 * ## Who sees what
 *
 * The *shape* of a dataset's history — when it changed, how often, how big — is
 * public: it is what makes a back catalogue worth buying. The *payloads* are the
 * product, so they are returned only to the owning seller (seller JWT) or to a
 * buyer presenting the `txHash` of a completed purchase of that dataset. A diff
 * follows the same rule: counts are public, changed values are not.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDataset, getTransactionByHash, updateDataset } from '../common/storage';
import { attachSellerAuthIfPresent, requireSellerJwt } from '../common/auth.middleware';
import { validateBody } from '../common/validate';
import { diffPayloads, DEFAULT_MAX_DIFF_ENTRIES } from './snapshots.diff';
import { estimateStorage } from './snapshots.estimator';
import {
  countSnapshotsInRange,
  getSnapshotAsOf,
  getSnapshotByHash,
  getStorageStats,
  listSnapshotsInRange,
  toSnapshotMeta,
} from './snapshots.repository';
import { getPayloadAsOf, readSnapshotPayload, resolveRetentionPolicy } from './snapshots.service';
import {
  DEFAULT_SNAPSHOTS_PER_REQUEST,
  MAX_SNAPSHOTS_PER_REQUEST,
  toIsoInstant,
  type DatasetSnapshot,
} from './snapshots.types';

const CONTENT_HASH_REGEX = /^[0-9a-f]{64}$/;
const DEFAULT_SPARKLINE_DAYS = 30;
const MAX_SPARKLINE_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const snapshotsRouter = Router();

const isoInstant = z
  .string()
  .trim()
  .refine(value => !Number.isNaN(new Date(value).getTime()), {
    message: 'must be an ISO-8601 instant',
  });

const paginationSchema = z.object({
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  limit: z.coerce.number().int().positive().max(MAX_SNAPSHOTS_PER_REQUEST).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const retentionPolicySchema = z.object({
  retentionDays: z.number().int().positive().max(3650).nullable(),
  fullResolutionDays: z.number().int().nonnegative().max(3650),
  hourlyDays: z.number().int().nonnegative().max(3650),
});

/** A buyer's proof of purchase, or the owning seller's token, unlocks payloads. */
async function canReadPayloads(req: Request, datasetId: string, sellerWallet: string) {
  if (req.sellerAuth?.sellerWallet === sellerWallet) return true;

  const txHash = req.query.txHash;
  if (typeof txHash !== 'string' || txHash.length === 0) return false;

  const transaction = await getTransactionByHash(txHash);
  return (
    transaction !== undefined &&
    transaction.datasetId === datasetId &&
    transaction.status === 'completed'
  );
}

function badRequest(res: Response, error: z.ZodError): Response {
  const messages = error.issues.map(
    issue => `${issue.path.join('.') || 'query'}: ${issue.message}`,
  );
  return res.status(400).json({ error: messages.join('; ') });
}

/**
 * Change frequency per day over the window — enough to draw the sparkline that
 * tells a buyer whether this feed is worth buying history for.
 */
function buildSparkline(snapshots: DatasetSnapshot[], days: number, now: number) {
  const buckets = new Map<string, number>();
  for (let day = days - 1; day >= 0; day -= 1) {
    buckets.set(new Date(now - day * MS_PER_DAY).toISOString().slice(0, 10), 0);
  }
  for (const snapshot of snapshots) {
    const key = snapshot.validFrom.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, changes]) => ({ date, changes }));
}

/**
 * @openapi
 * /api/datasets/{id}/history:
 *   get:
 *     summary: List a dataset's snapshot history
 *     description: Public metadata for every stored snapshot, plus a per-day change-frequency sparkline. Payloads are never included here.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 200, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Snapshot metadata and sparkline }
 *       400: { description: Invalid query parameters }
 *       404: { description: Dataset not found }
 */
snapshotsRouter.get('/:id/history', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing dataset id' });
  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  const parsed = paginationSchema
    .extend({ days: z.coerce.number().int().positive().max(MAX_SPARKLINE_DAYS).optional() })
    .safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);

  const { from, to, days } = parsed.data;
  const limit = parsed.data.limit ?? DEFAULT_SNAPSHOTS_PER_REQUEST;
  const offset = parsed.data.offset ?? 0;

  const [page, total] = await Promise.all([
    listSnapshotsInRange(id, { from, to, limit, offset }),
    countSnapshotsInRange(id, from, to),
  ]);

  const now = Date.now();
  const sparklineDays = days ?? DEFAULT_SPARKLINE_DAYS;
  const recent = await listSnapshotsInRange(id, {
    from: new Date(now - sparklineDays * MS_PER_DAY).toISOString(),
    limit: MAX_SNAPSHOTS_PER_REQUEST,
  });

  return res.json({
    success: true,
    datasetId: id,
    total,
    limit,
    offset,
    maxLimit: MAX_SNAPSHOTS_PER_REQUEST,
    snapshots: page.map(toSnapshotMeta),
    changeFrequency: buildSparkline(recent, sparklineDays, now),
  });
});

/**
 * @openapi
 * /api/datasets/{id}/snapshots/at:
 *   get:
 *     summary: Read a dataset as of a point in time
 *     description: Resolves the snapshot whose validity range contains `asOf` (validFrom <= asOf < validTo). The payload is included only for the owning seller or a completed purchase's txHash.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: asOf
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: txHash
 *         schema: { type: string }
 *     responses:
 *       200: { description: The snapshot live at that instant }
 *       404: { description: Dataset not found, or history does not reach that far back }
 */
snapshotsRouter.get(
  '/:id/snapshots/at',
  attachSellerAuthIfPresent,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const parsed = z.object({ asOf: isoInstant }).safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    const resolved = await getPayloadAsOf(id, parsed.data.asOf);
    if (!resolved) {
      return res.status(404).json({ error: 'No snapshot was live at that instant' });
    }

    const authorised = await canReadPayloads(req, id, dataset.sellerWallet);
    return res.json({
      success: true,
      asOf: toIsoInstant(parsed.data.asOf),
      snapshot: toSnapshotMeta(resolved.snapshot),
      ...(authorised ? { data: resolved.payload } : { payloadWithheld: true }),
    });
  },
);

/**
 * @openapi
 * /api/datasets/{id}/snapshots/range:
 *   get:
 *     summary: Read a range of snapshots (time-series purchase)
 *     description: Snapshots overlapping [from, to), oldest first. Payloads are included only for the owning seller or a completed purchase's txHash, and the row count is hard-capped.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 200, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Snapshots in the requested window }
 *       400: { description: Invalid query parameters }
 *       404: { description: Dataset not found }
 */
snapshotsRouter.get(
  '/:id/snapshots/range',
  attachSellerAuthIfPresent,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    const { from, to } = parsed.data;
    if (from && to && toIsoInstant(from) > toIsoInstant(to)) {
      return res.status(400).json({ error: 'from must not be after to' });
    }

    const limit = parsed.data.limit ?? DEFAULT_SNAPSHOTS_PER_REQUEST;
    const offset = parsed.data.offset ?? 0;

    const [rows, total] = await Promise.all([
      listSnapshotsInRange(id, { from, to, limit, offset }),
      countSnapshotsInRange(id, from, to),
    ]);
    const authorised = await canReadPayloads(req, id, dataset.sellerWallet);

    return res.json({
      success: true,
      datasetId: id,
      total,
      limit,
      offset,
      maxLimit: MAX_SNAPSHOTS_PER_REQUEST,
      snapshots: rows.map(snapshot => ({
        ...toSnapshotMeta(snapshot),
        ...(authorised ? { data: readSnapshotPayload(snapshot) } : {}),
      })),
      ...(authorised ? {} : { payloadWithheld: true }),
    });
  },
);

/**
 * @openapi
 * /api/datasets/{id}/snapshots/diff:
 *   get:
 *     summary: Structural diff between two snapshots
 *     description: Accepts either ISO instants or 64-character content hashes for `from` and `to`. Counts are public; the changed values require the owning seller's token or a completed purchase's txHash.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Diff summary, and entries when authorised }
 *       400: { description: Invalid query parameters }
 *       404: { description: Dataset or either endpoint snapshot not found }
 */
snapshotsRouter.get(
  '/:id/snapshots/diff',
  attachSellerAuthIfPresent,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const parsed = z
      .object({
        from: z.string().trim().min(1),
        to: z.string().trim().min(1),
        maxEntries: z.coerce.number().int().positive().max(DEFAULT_MAX_DIFF_ENTRIES).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    const resolve = async (reference: string): Promise<DatasetSnapshot | undefined> => {
      if (CONTENT_HASH_REGEX.test(reference)) return getSnapshotByHash(id, reference);
      if (Number.isNaN(new Date(reference).getTime())) return undefined;
      return getSnapshotAsOf(id, reference);
    };

    const [before, after] = await Promise.all([resolve(parsed.data.from), resolve(parsed.data.to)]);
    if (!before || !after) {
      return res.status(404).json({ error: 'No snapshot matches one or both endpoints' });
    }

    const diff = diffPayloads(
      readSnapshotPayload(before),
      readSnapshotPayload(after),
      parsed.data.maxEntries ?? DEFAULT_MAX_DIFF_ENTRIES,
    );
    const authorised = await canReadPayloads(req, id, dataset.sellerWallet);

    return res.json({
      success: true,
      from: toSnapshotMeta(before),
      to: toSnapshotMeta(after),
      identical: diff.identical,
      summary: diff.summary,
      truncated: diff.truncated,
      ...(authorised ? { entries: diff.entries } : { entriesWithheld: true }),
    });
  },
);

/**
 * @openapi
 * /api/datasets/{id}/snapshots/storage:
 *   get:
 *     summary: Storage footprint and cost projection for a dataset's history
 *     description: Seller-only. Reports what history costs today and what the current cadence implies once retention reaches steady state.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Storage stats, policy, and projection }
 *       403: { description: Dataset belongs to another seller }
 */
snapshotsRouter.get(
  '/:id/snapshots/storage',
  requireSellerJwt,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    if (dataset.sellerWallet !== req.sellerAuth?.sellerWallet) {
      return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
    }

    const stats = await getStorageStats(id);
    const policy = resolveRetentionPolicy(dataset);

    const observedDays =
      stats.oldestValidFrom && stats.newestValidFrom
        ? Math.max(
            (Date.parse(stats.newestValidFrom) - Date.parse(stats.oldestValidFrom)) / MS_PER_DAY,
            1 / 24,
          )
        : 1;
    const refreshesPerDay = stats.observations / observedDays;
    const changeRate = stats.observations > 0 ? stats.snapshotCount / stats.observations : 1;
    const avgSnapshotBytes =
      stats.snapshotCount > 0 ? Math.round(stats.storedBytes / stats.snapshotCount) : 0;

    return res.json({
      success: true,
      datasetId: id,
      policy,
      stats: {
        ...stats,
        avgSnapshotBytes,
        compressionRatio:
          stats.rawBytes > 0 ? Number((stats.storedBytes / stats.rawBytes).toFixed(4)) : null,
      },
      projection: estimateStorage({ avgSnapshotBytes, refreshesPerDay, changeRate, policy }),
    });
  },
);

/**
 * @openapi
 * /api/datasets/{id}/snapshots/policy:
 *   put:
 *     summary: Set a dataset's snapshot retention policy
 *     description: Seller-only. Controls how long history is kept and how aggressively it is downsampled.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: The stored policy and its projected cost }
 *       400: { description: Invalid policy }
 *       403: { description: Dataset belongs to another seller }
 */
snapshotsRouter.put(
  '/:id/snapshots/policy',
  requireSellerJwt,
  validateBody(retentionPolicySchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
    if (dataset.sellerWallet !== req.sellerAuth?.sellerWallet) {
      return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
    }

    const policy = req.body as z.infer<typeof retentionPolicySchema>;
    if (policy.fullResolutionDays > policy.hourlyDays) {
      return res.status(400).json({ error: 'fullResolutionDays must not exceed hourlyDays' });
    }
    if (policy.retentionDays !== null && policy.hourlyDays > policy.retentionDays) {
      return res.status(400).json({ error: 'hourlyDays must not exceed retentionDays' });
    }

    await updateDataset(id, { snapshotPolicy: policy });
    return res.json({ success: true, datasetId: id, policy });
  },
);

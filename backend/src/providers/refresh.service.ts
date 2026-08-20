import { randomUUID } from 'crypto';
import { getAllDatasets, updateDataset, type Dataset } from '../common/storage';
import { getProviderById, getProviderByType } from './registry';
import { logger } from '../lib/logger';
import { recordDatasetSnapshot } from '../snapshots/snapshots.service';
import { indexDatasetInBackground } from '../search/indexer';
import type { ProviderSnapshot } from './provider.types';

export interface RefreshResult {
  datasetId: string;
  provider: string;
  live: boolean;
  ok: boolean;
  /** True when the refresh changed the payload and opened a new snapshot (#600). */
  snapshotCreated?: boolean;
  /** Content address of the payload now live. */
  contentHash?: string;
}

/** Resolve the provider for a dataset by explicit id, else by type. */
function resolveProvider(dataset: Dataset) {
  if (dataset.provider) {
    const byId = getProviderById(dataset.provider);
    if (byId) return byId;
  }
  return getProviderByType(dataset.type);
}

/**
 * Build the persisted `data` payload from a snapshot, preserving the provider's
 * points + freshness metadata alongside the raw source data.
 */
function snapshotToData(snapshot: ProviderSnapshot): Record<string, unknown> {
  return {
    ...snapshot.data,
    _points: snapshot.points,
    _headline: snapshot.headline,
    _live: snapshot.live,
    _fetchedAt: snapshot.fetchedAt,
  };
}

/**
 * Refresh a single live dataset. Never throws — returns ok:false on error.
 *
 * The refresh writes the new payload to the dataset row *and* appends it to the
 * dataset's immutable history (#600). An unchanged payload costs no new row —
 * `recordDatasetSnapshot` extends the live one instead.
 */
export async function refreshDataset(
  dataset: Dataset,
  providerRunId?: string,
): Promise<RefreshResult> {
  const provider = resolveProvider(dataset);
  if (!provider) {
    return { datasetId: dataset.id, provider: 'none', live: false, ok: false };
  }
  try {
    const snapshot = await provider.refresh();
    const data = snapshotToData(snapshot);
    const updated = await updateDataset(dataset.id, {
      data,
      provider: provider.id,
      live: true,
      lastRefreshedAt: snapshot.fetchedAt,
    });

    // Re-index for search. The stable-document hash (see search/document.ts)
    // means this is a no-op embed call on most refreshes — only a genuine
    // change in name/description/field-shape triggers a re-embed, not the
    // fresh sample values a live feed produces every cycle.
    if (updated) indexDatasetInBackground(updated);

    const recorded = await recordDatasetSnapshot(dataset.id, data, {
      at: snapshot.fetchedAt,
      providerRunId,
    });

    return {
      datasetId: dataset.id,
      provider: provider.id,
      live: snapshot.live,
      ok: true,
      snapshotCreated: recorded.created,
      contentHash: recorded.snapshot.contentHash,
    };
  } catch (err) {
    logger.error(
      `[refresh] dataset ${dataset.id} via ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { datasetId: dataset.id, provider: provider.id, live: false, ok: false };
  }
}

/** Refresh every dataset flagged `live`. Returns per-dataset results. */
export async function refreshAllLiveDatasets(): Promise<RefreshResult[]> {
  const datasets = await getAllDatasets();
  const live = datasets.filter(d => d.live);
  if (live.length === 0) return [];
  // One id per sweep, stamped on every snapshot it writes, so a suspect row can
  // be traced back to the refresh run that produced it.
  const providerRunId = `run-${randomUUID()}`;
  const results = await Promise.all(live.map(dataset => refreshDataset(dataset, providerRunId)));
  const liveCount = results.filter(r => r.live).length;
  const changed = results.filter(r => r.snapshotCreated).length;
  logger.info(
    `[refresh] refreshed ${results.length} live datasets (${liveCount} from real sources, ${results.length - liveCount} fallback); ${changed} produced a new snapshot`,
  );
  return results;
}

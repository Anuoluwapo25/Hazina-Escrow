import { getAllDatasets, updateDataset, type Dataset } from '../common/storage';
import { getProviderById, getProviderByType } from './registry';
import { logger } from '../lib/logger';
import type { ProviderSnapshot } from './provider.types';

export interface RefreshResult {
  datasetId: string;
  provider: string;
  live: boolean;
  ok: boolean;
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

/** Refresh a single live dataset. Never throws — returns ok:false on error. */
export async function refreshDataset(dataset: Dataset): Promise<RefreshResult> {
  const provider = resolveProvider(dataset);
  if (!provider) {
    return { datasetId: dataset.id, provider: 'none', live: false, ok: false };
  }
  try {
    const snapshot = await provider.refresh();
    await updateDataset(dataset.id, {
      data: snapshotToData(snapshot),
      provider: provider.id,
      live: true,
      lastRefreshedAt: snapshot.fetchedAt,
    });
    return { datasetId: dataset.id, provider: provider.id, live: snapshot.live, ok: true };
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
  const results = await Promise.all(live.map(refreshDataset));
  const liveCount = results.filter(r => r.live).length;
  logger.info(
    `[refresh] refreshed ${results.length} live datasets (${liveCount} from real sources, ${results.length - liveCount} fallback)`,
  );
  return results;
}

import { logger } from '../lib/logger';
import { refreshAllLiveDatasets } from './refresh.service';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalId: NodeJS.Timeout | null = null;

function getIntervalMs(): number {
  const raw = process.env.DATA_REFRESH_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Start the live-data refresh worker. Refreshes all `live` datasets on an
 * interval so the marketplace stays current with external sources. Disabled
 * when DATA_REFRESH_ENABLED is explicitly "false" (e.g. in tests/CI). Runs an
 * initial refresh shortly after start rather than blocking boot.
 */
export function startDataRefreshWorker(): void {
  if (process.env.DATA_REFRESH_ENABLED === 'false') {
    logger.info('[Data Refresh] Disabled via DATA_REFRESH_ENABLED=false');
    return;
  }
  if (intervalId) {
    logger.info('[Data Refresh] Already running');
    return;
  }
  const intervalMs = getIntervalMs();
  logger.info(`[Data Refresh] Starting live-data worker (every ${Math.round(intervalMs / 1000)}s)`);

  // Kick off an initial refresh without blocking startup.
  setTimeout(() => {
    refreshAllLiveDatasets().catch(err =>
      logger.error(
        `[Data Refresh] initial refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, 2_000).unref?.();

  intervalId = setInterval(() => {
    refreshAllLiveDatasets().catch(err =>
      logger.error(
        `[Data Refresh] scheduled refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, intervalMs);
  intervalId.unref?.();
}

export function stopDataRefreshWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[Data Refresh] Stopped');
  }
}

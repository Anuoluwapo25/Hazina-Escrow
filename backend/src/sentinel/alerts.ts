/**
 * alerts.ts — Sentinel's alert router.
 *
 * "A monitor that cries wolf gets muted, and a muted monitor is worse than
 * none" — so every alert is deduped by (invariant, escrowId), repeats within
 * a suppression window update the record but don't re-notify, and closing
 * one out requires an explicit resolve(). A resolved alert that recurs
 * always re-notifies immediately, regardless of the suppression window —
 * "already told you" only applies while the problem is still open.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  addSentinelAlert,
  getSentinelAlertByDedupeKey,
  updateSentinelAlert,
  getOpenSentinelAlerts,
  getAllSentinelAlerts,
  type SentinelAlert,
} from '../common/storage';
import { logger } from '../lib/logger';
import { parsePositiveInt } from '../common/env';
import type { RaisedAlert } from './types';

export interface AlertChannel {
  readonly name: string;
  dispatch(alert: SentinelAlert): Promise<void>;
}

const getSuppressWindowMs = () =>
  parsePositiveInt(process.env.SENTINEL_ALERT_SUPPRESS_SECONDS, 3600) * 1000;

export function dedupeKeyFor(invariant: string, escrowId?: number, dedupeSuffix?: string): string {
  return `${invariant}:${escrowId ?? dedupeSuffix ?? 'global'}`;
}

async function dispatchToChannels(alert: SentinelAlert, channels: AlertChannel[]): Promise<void> {
  await Promise.all(
    channels.map(async channel => {
      try {
        await channel.dispatch(alert);
      } catch (err) {
        logger.error(
          `[Sentinel] Alert channel "${channel.name}" failed for ${alert.dedupeKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }),
  );
}

/**
 * Raises an alert. Idempotent under re-processing the same event twice (e.g.
 * after a restart replays a not-yet-cursor-committed batch) — the second
 * call just bumps `count`/`lastSeenAt` on the same dedupe key rather than
 * creating a duplicate or re-notifying inside the suppression window.
 */
export async function fireAlert(
  raised: RaisedAlert,
  channels: AlertChannel[],
): Promise<SentinelAlert> {
  const dedupeKey = dedupeKeyFor(raised.invariant, raised.escrowId, raised.dedupeSuffix);
  const nowIso = new Date().toISOString();
  const existing = await getSentinelAlertByDedupeKey(dedupeKey);

  if (!existing) {
    const alert: SentinelAlert = {
      id: `sentinel-alert-${uuidv4()}`,
      dedupeKey,
      invariant: raised.invariant,
      severity: raised.severity,
      status: 'open',
      escrowId: raised.escrowId,
      txHash: raised.txHash,
      ledger: raised.ledger,
      message: raised.message,
      details: raised.details,
      count: 1,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      lastNotifiedAt: nowIso,
    };
    await addSentinelAlert(alert);
    await dispatchToChannels(alert, channels);
    return alert;
  }

  const wasResolved = existing.status === 'resolved';
  const withinSuppressWindow =
    !wasResolved &&
    existing.lastNotifiedAt !== undefined &&
    Date.now() - new Date(existing.lastNotifiedAt).getTime() < getSuppressWindowMs();

  const shouldNotify = wasResolved || !withinSuppressWindow;

  const merged: SentinelAlert = {
    ...existing,
    status: 'open',
    severity: raised.severity,
    message: raised.message,
    details: raised.details,
    txHash: raised.txHash ?? existing.txHash,
    ledger: raised.ledger ?? existing.ledger,
    count: existing.count + 1,
    lastSeenAt: nowIso,
    lastNotifiedAt: shouldNotify ? nowIso : existing.lastNotifiedAt,
    resolvedAt: wasResolved ? undefined : existing.resolvedAt,
    resolvedBy: wasResolved ? undefined : existing.resolvedBy,
  };
  await updateSentinelAlert(existing.id, merged);

  if (shouldNotify) {
    await dispatchToChannels(merged, channels);
  }

  return merged;
}

export async function resolveAlert(id: string, resolvedBy: string): Promise<SentinelAlert | null> {
  return updateSentinelAlert(id, {
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolvedBy,
  });
}

export { getOpenSentinelAlerts, getAllSentinelAlerts };

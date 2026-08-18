import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SentinelAlert } from '../common/storage';

const { alertStore } = vi.hoisted(() => ({ alertStore: new Map<string, SentinelAlert>() }));

vi.mock('../common/storage', () => ({
  addSentinelAlert: vi.fn((alert: SentinelAlert) => {
    alertStore.set(alert.id, alert);
    return Promise.resolve();
  }),
  getSentinelAlertByDedupeKey: vi.fn((dedupeKey: string) =>
    Promise.resolve([...alertStore.values()].find(a => a.dedupeKey === dedupeKey)),
  ),
  updateSentinelAlert: vi.fn((id: string, updates: Partial<SentinelAlert>) => {
    const existing = alertStore.get(id);
    if (!existing) return Promise.resolve(null);
    const merged = { ...existing, ...updates } as SentinelAlert;
    alertStore.set(id, merged);
    return Promise.resolve(merged);
  }),
  getOpenSentinelAlerts: vi.fn(() =>
    Promise.resolve([...alertStore.values()].filter(a => a.status === 'open')),
  ),
  getAllSentinelAlerts: vi.fn(() => Promise.resolve([...alertStore.values()])),
}));

import { fireAlert, resolveAlert, dedupeKeyFor } from './alerts';
import type { AlertChannel } from './alerts';

class RecordingChannel implements AlertChannel {
  name = 'recording';
  dispatched: SentinelAlert[] = [];
  async dispatch(alert: SentinelAlert) {
    this.dispatched.push(alert);
  }
}

beforeEach(() => {
  alertStore.clear();
  vi.useRealTimers();
  delete process.env.SENTINEL_ALERT_SUPPRESS_SECONDS;
});

describe('dedupeKeyFor', () => {
  it('keys by escrowId when present', () => {
    expect(dedupeKeyFor('release_conservation', 7)).toBe('release_conservation:7');
  });
  it('falls back to dedupeSuffix when there is no escrowId', () => {
    expect(dedupeKeyFor('pause_state', undefined, 'evt-abc')).toBe('pause_state:evt-abc');
  });
  it('falls back to "global" when neither is present', () => {
    expect(dedupeKeyFor('solvency')).toBe('solvency:global');
  });
});

describe('fireAlert', () => {
  it('dispatches and persists a brand-new alert', async () => {
    const channel = new RecordingChannel();
    const alert = await fireAlert(
      { invariant: 'pause_state', severity: 'high', dedupeSuffix: 'evt-1', message: 'paused' },
      [channel],
    );

    expect(alert.status).toBe('open');
    expect(alert.count).toBe(1);
    expect(channel.dispatched).toHaveLength(1);
  });

  it('suppresses a repeat within the suppression window — updates count, does not re-notify', async () => {
    process.env.SENTINEL_ALERT_SUPPRESS_SECONDS = '3600';
    const channel = new RecordingChannel();
    const raised = { invariant: 'solvency', severity: 'critical' as const, message: 'short' };

    await fireAlert(raised, [channel]);
    const second = await fireAlert(raised, [channel]);

    expect(second.count).toBe(2);
    expect(channel.dispatched).toHaveLength(1); // second call did not notify again
  });

  it('re-notifies once the suppression window has elapsed', async () => {
    process.env.SENTINEL_ALERT_SUPPRESS_SECONDS = '1'; // 1 second
    const channel = new RecordingChannel();
    const raised = { invariant: 'solvency', severity: 'critical' as const, message: 'short' };

    await fireAlert(raised, [channel]);
    await new Promise(r => setTimeout(r, 1100));
    await fireAlert(raised, [channel]);

    expect(channel.dispatched).toHaveLength(2);
  });

  it('a resolved alert that recurs re-notifies immediately, ignoring the suppression window', async () => {
    process.env.SENTINEL_ALERT_SUPPRESS_SECONDS = '3600';
    const channel = new RecordingChannel();
    const raised = {
      invariant: 'pause_state',
      severity: 'high' as const,
      dedupeSuffix: 'evt-x',
      message: 'paused',
    };

    const first = await fireAlert(raised, [channel]);
    await resolveAlert(first.id, 'ops@hazina.example');

    const recurred = await fireAlert(raised, [channel]);

    expect(recurred.status).toBe('open');
    expect(recurred.resolvedAt).toBeUndefined();
    expect(channel.dispatched).toHaveLength(2); // both the original and the recurrence notified
  });
});

describe('resolveAlert', () => {
  it('marks an alert resolved with an audit trail', async () => {
    const channel = new RecordingChannel();
    const created = await fireAlert(
      { invariant: 'pause_state', severity: 'high', dedupeSuffix: 'evt-y', message: 'paused' },
      [channel],
    );

    const resolved = await resolveAlert(created.id, 'ops@hazina.example');

    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedBy).toBe('ops@hazina.example');
    expect(resolved?.resolvedAt).toBeDefined();
  });

  it('returns null for an unknown alert id', async () => {
    const resolved = await resolveAlert('does-not-exist', 'ops@hazina.example');
    expect(resolved).toBeNull();
  });
});

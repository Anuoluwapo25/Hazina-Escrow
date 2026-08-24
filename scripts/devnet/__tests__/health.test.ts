/**
 * Gate tests for the health-wait backoff.
 *
 * The issue is explicit that flaky startup is what kills devnets, so the retry
 * logic gets tested rather than trusted. Clock and sleeper are injected, so this
 * suite verifies the real backoff schedule and timeout behaviour in
 * milliseconds of actual runtime — no waiting, never flaky.
 */

import { describe, expect, it, vi } from 'vitest';
import { HealthTimeoutError, backoffDelay, isFundedResponse, waitFor } from '../lib/health.ts';
import { BACKOFF } from '../lib/config.ts';

/** A controllable clock: time only advances when the sleeper is called. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleeper: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('backoffDelay', () => {
  it('starts at the initial delay', () => {
    expect(backoffDelay(0)).toBe(BACKOFF.initialMs);
  });

  it('grows exponentially', () => {
    const first = backoffDelay(1);
    const second = backoffDelay(2);
    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThan(backoffDelay(0));
  });

  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(backoffDelay(attempt)).toBeLessThanOrEqual(BACKOFF.maxMs);
    }
  });

  it('reaches the cap rather than growing without bound', () => {
    expect(backoffDelay(50)).toBe(BACKOFF.maxMs);
  });

  it('honours custom bounds', () => {
    expect(backoffDelay(0, { initialMs: 10 })).toBe(10);
    expect(backoffDelay(99, { initialMs: 10, maxMs: 40 })).toBe(40);
  });

  it('is not a fixed sleep', () => {
    // The explicit anti-requirement from the issue: "real backoff, not sleep 30".
    const delays = [0, 1, 2, 3].map(n => backoffDelay(n));
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});

describe('waitFor', () => {
  it('returns the first truthy probe result without sleeping', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const result = await waitFor(probe, {
      label: 'test',
      timeoutMs: 10_000,
      now: clock.now,
      sleeper: clock.sleeper,
    });
    expect(result).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(0);
  });

  it('retries until the probe reports ready', async () => {
    const clock = fakeClock();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('ready');
    const result = await waitFor(probe, {
      label: 'test',
      timeoutMs: 60_000,
      now: clock.now,
      sleeper: clock.sleeper,
    });
    expect(result).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBeGreaterThan(0);
  });

  it('treats a throwing probe as not-ready and keeps retrying', async () => {
    const clock = fakeClock();
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValue('up');
    await expect(
      waitFor(probe, { label: 'test', timeoutMs: 60_000, now: clock.now, sleeper: clock.sleeper }),
    ).resolves.toBe('up');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('treats false as not-ready', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(
      waitFor(probe, { label: 'test', timeoutMs: 60_000, now: clock.now, sleeper: clock.sleeper }),
    ).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('throws HealthTimeoutError once the budget is spent', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(null);
    await expect(
      waitFor(probe, {
        label: 'Horizon',
        timeoutMs: 5_000,
        now: clock.now,
        sleeper: clock.sleeper,
      }),
    ).rejects.toBeInstanceOf(HealthTimeoutError);
  });

  it('never overshoots the timeout budget', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(null);
    await waitFor(probe, {
      label: 'test',
      timeoutMs: 5_000,
      now: clock.now,
      sleeper: clock.sleeper,
    }).catch(() => undefined);
    expect(clock.now()).toBeLessThanOrEqual(5_000);
  });

  it('reports the last error, so a timeout explains itself', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000'));
    await expect(
      waitFor(probe, {
        label: 'Horizon',
        timeoutMs: 3_000,
        now: clock.now,
        sleeper: clock.sleeper,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('names the service that timed out', async () => {
    const clock = fakeClock();
    await expect(
      waitFor(vi.fn().mockResolvedValue(null), {
        label: 'Friendbot',
        timeoutMs: 2_000,
        now: clock.now,
        sleeper: clock.sleeper,
      }),
    ).rejects.toThrow(/Friendbot did not become ready/);
  });

  it('reports progress through onAttempt', async () => {
    const clock = fakeClock();
    const onAttempt = vi.fn();
    await waitFor(vi.fn().mockResolvedValueOnce(null).mockResolvedValue('ok'), {
      label: 'test',
      timeoutMs: 60_000,
      now: clock.now,
      sleeper: clock.sleeper,
      onAttempt,
    });
    expect(onAttempt).toHaveBeenCalled();
  });
});

describe('isFundedResponse', () => {
  it('accepts a 200', () => {
    expect(isFundedResponse(200, '{}')).toBe(true);
  });

  it('accepts an already-funded 400 — idempotent re-provisioning', () => {
    expect(isFundedResponse(400, 'account already funded to starting balance')).toBe(true);
  });

  it('rejects a gateway error', () => {
    expect(isFundedResponse(502, 'Bad Gateway')).toBe(false);
    expect(isFundedResponse(503, 'Service Unavailable')).toBe(false);
  });

  it('rejects an unrelated 400', () => {
    expect(isFundedResponse(400, 'invalid address')).toBe(false);
  });
});

/**
 * health.ts — readiness gating.
 *
 * The issue is explicit: "Wait for Horizon and RPC health — with real backoff,
 * not sleep 30. Flaky startup is what kills devnets."
 *
 * The subtlety that bites people is ordering. Quickstart brings services up in
 * sequence — core, then Horizon ingestion, then (only once the network has
 * finished its protocol upgrade) friendbot. Horizon answering on / is NOT proof
 * that friendbot will fund an account; it 502s for another ~10 seconds after
 * Horizon is live. Measured on a clean boot: Horizon ~12s, friendbot ~7 more
 * polls after that. So friendbot gets its own explicit wait rather than being
 * assumed ready.
 *
 * `waitFor` is pure of any Stellar specifics and takes its clock and sleeper by
 * injection, so the backoff schedule is gate-testable with no real waiting.
 */

import { BACKOFF } from './config.ts';

export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
}

/**
 * The delay before attempt `n` (0-indexed), capped at `maxMs`. Exponential, not
 * a fixed sleep: fast when the service is nearly up, cheap when it is not.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { initialMs = BACKOFF.initialMs, maxMs = BACKOFF.maxMs, factor = BACKOFF.factor } = opts;
  if (attempt <= 0) {
    return initialMs;
  }
  return Math.min(Math.round(initialMs * factor ** attempt), maxMs);
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface WaitForOptions extends BackoffOptions {
  timeoutMs: number;
  label: string;
  /** Injected for tests; defaults to the real clock and a real sleep. */
  now?: () => number;
  sleeper?: (ms: number) => Promise<void>;
  /** Called before each retry, for progress output. */
  onAttempt?: (attempt: number, elapsedMs: number, lastError: string) => void;
}

export class HealthTimeoutError extends Error {
  readonly attempts: number;
  readonly lastError: string;
  constructor(label: string, timeoutMs: number, attempts: number, lastError: string) {
    super(
      `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
        `(${attempts} attempts). Last error: ${lastError}`,
    );
    this.name = 'HealthTimeoutError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Polls `probe` with exponential backoff until it resolves truthy or the budget
 * is spent. A probe that throws counts as not-ready; its message is kept so the
 * timeout can explain *why* rather than just that it timed out.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  options: WaitForOptions,
): Promise<T> {
  const { timeoutMs, label, now = Date.now, sleeper = sleep, onAttempt } = options;
  const started = now();
  let attempt = 0;
  let lastError = 'probe never reported ready';

  for (;;) {
    try {
      const result = await probe();
      if (result !== null && result !== undefined && result !== false) {
        return result as T;
      }
      lastError = 'probe reported not ready';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    const elapsed = now() - started;
    const delay = backoffDelay(attempt, options);
    // Check the budget against the time we *would* have spent after sleeping, so
    // we fail at the deadline instead of overshooting it by a full backoff step.
    if (elapsed + delay >= timeoutMs) {
      throw new HealthTimeoutError(label, timeoutMs, attempt + 1, lastError);
    }
    onAttempt?.(attempt, elapsed, lastError);
    attempt += 1;
    await sleeper(delay);
  }
}

// ── Stellar-specific probes ──────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export interface HorizonReady {
  passphrase: string;
  latestLedger: number;
}

/**
 * Horizon is ready only once it has *ingested* a ledger. A fresh Horizon answers
 * `/` before ingestion catches up, and submitting then fails in confusing ways,
 * so we require history_latest_ledger > 0.
 */
export async function probeHorizon(horizonUrl: string): Promise<HorizonReady | null> {
  const body = (await fetchJson(horizonUrl)) as Record<string, unknown>;
  const passphrase = body.network_passphrase;
  const latest = Number(body.history_latest_ledger ?? 0);
  if (typeof passphrase !== 'string' || !Number.isFinite(latest) || latest <= 0) {
    return null;
  }
  return { passphrase, latestLedger: latest };
}

export interface RpcReady {
  status: string;
  latestLedger: number;
}

/** Soroban RPC is ready when getHealth reports "healthy". */
export async function probeRpc(rpcUrl: string): Promise<RpcReady | null> {
  const body = (await fetchJson(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  })) as { result?: { status?: string; latestLedger?: number }; error?: unknown };
  if (body.error) {
    throw new Error(`RPC error: ${JSON.stringify(body.error).slice(0, 160)}`);
  }
  if (body.result?.status !== 'healthy') {
    return null;
  }
  return { status: body.result.status, latestLedger: Number(body.result.latestLedger ?? 0) };
}

/** Asks RPC which network it thinks it is on — used by the guard cross-check. */
export async function fetchRpcPassphrase(rpcUrl: string): Promise<string> {
  const body = (await fetchJson(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
  })) as { result?: { passphrase?: string } };
  const passphrase = body.result?.passphrase;
  if (typeof passphrase !== 'string') {
    throw new Error('RPC getNetwork did not return a passphrase');
  }
  return passphrase;
}

/**
 * Friendbot is ready when it stops returning a gateway error. A 400 counts as
 * ready — "account already funded" is a real answer from a live friendbot.
 */
export async function probeFriendbot(
  friendbotUrl: string,
  probeAddress: string,
): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${friendbotUrl}?addr=${probeAddress}`, { signal: controller.signal });
    const text = await res.text();
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(`friendbot not up yet (HTTP ${res.status})`);
    }
    if (res.ok || text.includes('already funded') || res.status === 400) {
      return true;
    }
    throw new Error(`friendbot HTTP ${res.status}: ${text.slice(0, 160)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the friendbot response means "this account now exists". */
export function isFundedResponse(status: number, body: string): boolean {
  return status === 200 || body.includes('already funded');
}

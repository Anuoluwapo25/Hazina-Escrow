/**
 * fetch() with an AbortController-based timeout. Providers use this so a slow
 * external source can't hang the refresh scheduler. Throws on timeout or
 * network error — callers are expected to wrap this in a circuit breaker and
 * fall back to a bundled snapshot.
 */
export async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

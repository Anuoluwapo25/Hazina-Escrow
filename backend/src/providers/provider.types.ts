/**
 * Live data provider abstraction.
 *
 * A provider knows how to fetch a fresh snapshot of a particular kind of
 * on-chain / market intelligence from an external source. Providers back the
 * marketplace's "live" datasets: a refresh scheduler periodically calls
 * `refresh()` and writes the returned snapshot into the dataset's `data`.
 *
 * Providers must NEVER throw on a network failure. They wrap external calls in
 * a circuit breaker and fall back to a bundled realistic snapshot so the
 * marketplace keeps serving data offline (and so CI/tests stay green without
 * network access). The `live` flag on the snapshot records whether the data
 * came from the real source or the fallback.
 */
export interface ProviderPoint {
  /** ISO timestamp or short label for the x-axis. */
  label: string;
  /** Numeric value for sparkline / charting. */
  value: number;
}

export interface ProviderSnapshot {
  /** Structured payload stored as the dataset's `data`. */
  data: Record<string, unknown>;
  /** Small numeric series for the detail-page sparkline. */
  points: ProviderPoint[];
  /** ISO timestamp the snapshot was produced. */
  fetchedAt: string;
  /** True when data came from the live source; false when it's the fallback. */
  live: boolean;
  /** Short human summary of what changed / headline metric. */
  headline: string;
}

export interface DataProvider {
  /** Stable id persisted on the dataset row (e.g. "defillama"). */
  id: string;
  /** Dataset `type` this provider feeds (must match SELLER_TYPES / registry). */
  type: string;
  /** Marketplace category tab this provider's datasets belong to. */
  category: string;
  /** Human label shown as provider attribution in the UI. */
  displayName: string;
  /** External source URL for attribution / deep-linking. */
  sourceUrl: string;
  /** Fetch a fresh snapshot. Resolves with a fallback snapshot on failure. */
  refresh(): Promise<ProviderSnapshot>;
}

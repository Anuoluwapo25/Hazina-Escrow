import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { logger } from '../lib/logger';
import { fetchJson } from './fetchWithTimeout';
import type { DataProvider, ProviderSnapshot, ProviderPoint } from './provider.types';

const breaker = getCircuitBreaker('defillama', {
  failureThreshold: 4,
  resetTimeoutMs: 120_000,
});

const POOLS_URL = 'https://yields.llama.fi/pools';

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  pool: string;
}

interface LlamaResponse {
  status: string;
  data: LlamaPool[];
}

/** Stablecoin-only, sane-APY pools sorted by TVL — the useful yield universe. */
function selectPools(pools: LlamaPool[], limit = 12): LlamaPool[] {
  return pools
    .filter(
      p =>
        p.stablecoin &&
        typeof p.apy === 'number' &&
        p.apy > 0 &&
        p.apy < 100 &&
        p.tvlUsd > 1_000_000,
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);
}

function toSnapshot(pools: LlamaPool[], live: boolean): ProviderSnapshot {
  const opportunities = pools.map(p => ({
    protocol: p.project,
    chain: p.chain,
    symbol: p.symbol,
    apy: Number((p.apy ?? 0).toFixed(2)),
    apyBase: Number((p.apyBase ?? 0).toFixed(2)),
    apyReward: Number((p.apyReward ?? 0).toFixed(2)),
    tvlUsd: Math.round(p.tvlUsd),
    ilRisk: p.ilRisk,
    exposure: p.exposure,
  }));
  const points: ProviderPoint[] = opportunities
    .slice(0, 8)
    .map(o => ({ label: `${o.protocol}`, value: o.apy }));
  const best = opportunities[0];
  const avgApy =
    opportunities.length > 0
      ? Number((opportunities.reduce((s, o) => s + o.apy, 0) / opportunities.length).toFixed(2))
      : 0;
  return {
    data: {
      source: 'DeFiLlama Yields',
      count: opportunities.length,
      avgApy,
      opportunities,
    },
    points,
    fetchedAt: new Date().toISOString(),
    live,
    headline: best
      ? `Top stable yield: ${best.protocol} ${best.symbol} @ ${best.apy}% APY (${avgApy}% avg)`
      : 'No qualifying stablecoin pools',
  };
}

/**
 * Deterministic fallback so the marketplace + tests work offline. Values are
 * realistic and stable (no randomness) to keep snapshot tests reproducible.
 */
function fallbackSnapshot(): ProviderSnapshot {
  const pools: LlamaPool[] = [
    mkPool('Aave V3', 'Ethereum', 'USDC', 5.4, 6_200_000_000),
    mkPool('Compound V3', 'Ethereum', 'USDC', 4.8, 1_900_000_000),
    mkPool('Aave V3', 'Arbitrum', 'USDT', 6.1, 820_000_000),
    mkPool('Morpho Blue', 'Ethereum', 'USDC', 7.3, 640_000_000),
    mkPool('Spark', 'Ethereum', 'DAI', 5.9, 1_400_000_000),
    mkPool('Curve', 'Ethereum', '3POOL', 3.2, 2_100_000_000),
  ];
  return toSnapshot(pools, false);
}

function mkPool(
  project: string,
  chain: string,
  symbol: string,
  apy: number,
  tvl: number,
): LlamaPool {
  return {
    chain,
    project,
    symbol,
    tvlUsd: tvl,
    apy,
    apyBase: apy,
    apyReward: 0,
    stablecoin: true,
    ilRisk: 'no',
    exposure: 'single',
    pool: `${project}-${chain}-${symbol}`,
  };
}

export const defillamaProvider: DataProvider = {
  id: 'defillama',
  type: 'yield-data',
  category: 'defi-yields',
  displayName: 'DeFiLlama',
  sourceUrl: 'https://defillama.com/yields',
  async refresh(): Promise<ProviderSnapshot> {
    try {
      const res = await breaker.execute(() => fetchJson<LlamaResponse>(POOLS_URL, 9000));
      const pools = selectPools(res.data ?? []);
      if (pools.length === 0) return fallbackSnapshot();
      return toSnapshot(pools, true);
    } catch (err) {
      if (!(err instanceof CircuitBreakerOpenError)) {
        logger.warn(
          `[defillama] refresh failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallbackSnapshot();
    }
  },
};

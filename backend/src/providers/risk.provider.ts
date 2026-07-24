import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { logger } from '../lib/logger';
import { fetchJson } from './fetchWithTimeout';
import type { DataProvider, ProviderSnapshot, ProviderPoint } from './provider.types';

const breaker = getCircuitBreaker('defillama-protocols', {
  failureThreshold: 4,
  resetTimeoutMs: 120_000,
});

const PROTOCOLS_URL = 'https://api.llama.fi/protocols';

interface LlamaProtocol {
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  change_1d: number | null;
  change_7d: number | null;
  audits?: string;
}

/**
 * A transparent, deterministic risk score in [0,100] (higher = riskier).
 * Derived from TVL (bigger = safer), 7d volatility, audit presence, and
 * multi-chain surface area. This is a heuristic, not financial advice.
 */
function riskScore(p: LlamaProtocol): number {
  const tvl = Math.max(p.tvl, 1);
  const tvlFactor = Math.max(0, 40 - Math.log10(tvl) * 4); // $10B → ~0, $1M → ~16
  const volatility = Math.min(30, Math.abs(p.change_7d ?? 0) * 1.5);
  const auditBonus = Number(p.audits ?? '0') > 0 ? 0 : 15;
  const chainSurface = Math.min(15, (p.chains?.length ?? 1) * 1.5);
  return Math.round(Math.min(100, tvlFactor + volatility + auditBonus + chainSurface));
}

function level(score: number): 'Low' | 'Medium' | 'High' {
  if (score < 30) return 'Low';
  if (score < 60) return 'Medium';
  return 'High';
}

function toSnapshot(protocols: LlamaProtocol[], live: boolean): ProviderSnapshot {
  const scored = protocols
    .filter(p => p.tvl > 50_000_000 && ['Lending', 'Dexes', 'Yield', 'CDP'].includes(p.category))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 12)
    .map(p => {
      const score = riskScore(p);
      return {
        protocol: p.name,
        category: p.category,
        chains: p.chains?.slice(0, 3) ?? [],
        tvlUsd: Math.round(p.tvl),
        change7d: Number((p.change_7d ?? 0).toFixed(2)),
        riskScore: score,
        riskLevel: level(score),
      };
    });
  const points: ProviderPoint[] = scored
    .slice(0, 8)
    .map(s => ({ label: s.protocol, value: s.riskScore }));
  const avg =
    scored.length > 0 ? Math.round(scored.reduce((s, p) => s + p.riskScore, 0) / scored.length) : 0;
  return {
    data: {
      source: 'DeFiLlama Protocols (derived risk model)',
      methodology: 'risk = f(TVL, 7d volatility, audit presence, chain surface)',
      avgRiskScore: avg,
      protocols: scored,
    },
    points,
    fetchedAt: new Date().toISOString(),
    live,
    headline: `${scored.length} protocols scored, avg risk ${avg}/100`,
  };
}

function fallbackSnapshot(): ProviderSnapshot {
  const protocols: LlamaProtocol[] = [
    mk('Aave', 'Lending', ['Ethereum', 'Arbitrum', 'Polygon'], 12_000_000_000, -1.2, '2'),
    mk('Uniswap', 'Dexes', ['Ethereum', 'Arbitrum'], 5_000_000_000, 0.6, '2'),
    mk('Curve', 'Dexes', ['Ethereum'], 2_100_000_000, -3.4, '2'),
    mk('Morpho', 'Lending', ['Ethereum'], 640_000_000, 4.1, '1'),
    mk('Pendle', 'Yield', ['Ethereum', 'Arbitrum'], 380_000_000, 8.7, '1'),
  ];
  return toSnapshot(protocols, false);
}

function mk(
  name: string,
  category: string,
  chains: string[],
  tvl: number,
  change7d: number,
  audits: string,
): LlamaProtocol {
  return { name, category, chains, tvl, change_1d: 0, change_7d: change7d, audits };
}

export const riskProvider: DataProvider = {
  id: 'defillama-risk',
  type: 'risk-scores',
  category: 'risk-intelligence',
  displayName: 'Hazina Risk Model',
  sourceUrl: 'https://defillama.com',
  async refresh(): Promise<ProviderSnapshot> {
    try {
      const protocols = await breaker.execute(() =>
        fetchJson<LlamaProtocol[]>(PROTOCOLS_URL, 9000),
      );
      if (!Array.isArray(protocols) || protocols.length === 0) return fallbackSnapshot();
      return toSnapshot(protocols, true);
    } catch (err) {
      if (!(err instanceof CircuitBreakerOpenError)) {
        logger.warn(
          `[defillama-risk] refresh failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallbackSnapshot();
    }
  },
};

import { MarketService } from '../market/market.service';
import { logger } from '../lib/logger';
import { fetchJson } from './fetchWithTimeout';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import type { DataProvider, ProviderSnapshot, ProviderPoint } from './provider.types';

const breaker = getCircuitBreaker('coingecko-sentiment', {
  failureThreshold: 4,
  resetTimeoutMs: 120_000,
});

// Broad market coins used to derive a simple market-sentiment read.
const COINS = ['stellar', 'bitcoin', 'ethereum'] as const;

interface MarketsRow {
  id: string;
  symbol: string;
  current_price: number;
  price_change_percentage_24h: number | null;
  total_volume: number;
}

function classifySentiment(avgChange: number): 'Bullish' | 'Neutral' | 'Bearish' {
  if (avgChange > 2) return 'Bullish';
  if (avgChange < -2) return 'Bearish';
  return 'Neutral';
}

function toSnapshot(rows: MarketsRow[], live: boolean): ProviderSnapshot {
  const assets = rows.map(r => ({
    asset: r.symbol.toUpperCase(),
    priceUsd: r.current_price,
    change24h: Number((r.price_change_percentage_24h ?? 0).toFixed(2)),
    volume24h: Math.round(r.total_volume),
  }));
  const avgChange =
    assets.length > 0
      ? Number((assets.reduce((s, a) => s + a.change24h, 0) / assets.length).toFixed(2))
      : 0;
  const sentiment = classifySentiment(avgChange);
  const points: ProviderPoint[] = assets.map(a => ({ label: a.asset, value: a.change24h }));
  return {
    data: {
      source: 'CoinGecko',
      sentiment,
      avgChange24h: avgChange,
      assets,
    },
    points,
    fetchedAt: new Date().toISOString(),
    live,
    headline: `Market sentiment: ${sentiment} (${avgChange >= 0 ? '+' : ''}${avgChange}% avg 24h)`,
  };
}

function fallbackSnapshot(): ProviderSnapshot {
  const rows: MarketsRow[] = [
    {
      id: 'stellar',
      symbol: 'xlm',
      current_price: 0.11,
      price_change_percentage_24h: 1.4,
      total_volume: 62_000_000,
    },
    {
      id: 'bitcoin',
      symbol: 'btc',
      current_price: 68_500,
      price_change_percentage_24h: 0.8,
      total_volume: 24_000_000_000,
    },
    {
      id: 'ethereum',
      symbol: 'eth',
      current_price: 3_450,
      price_change_percentage_24h: -0.3,
      total_volume: 12_000_000_000,
    },
  ];
  return toSnapshot(rows, false);
}

export const coingeckoProvider: DataProvider = {
  id: 'coingecko',
  type: 'sentiment',
  category: 'market-sentiment',
  displayName: 'CoinGecko',
  sourceUrl: 'https://www.coingecko.com',
  async refresh(): Promise<ProviderSnapshot> {
    try {
      const apiKey = process.env.COINGECKO_API_KEY;
      const url =
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${COINS.join(',')}` +
        `&price_change_percentage=24h`;
      const rows = await breaker.execute(() =>
        fetchJson<MarketsRow[]>(
          apiKey ? `${url}&x_cg_demo_api_key=${encodeURIComponent(apiKey)}` : url,
          9000,
        ),
      );
      if (!Array.isArray(rows) || rows.length === 0) return fallbackSnapshot();
      return toSnapshot(rows, true);
    } catch (err) {
      if (!(err instanceof CircuitBreakerOpenError)) {
        logger.warn(
          `[coingecko] refresh failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Best-effort: enrich fallback with a single live price if MarketService can get one.
      const price = await MarketService.getPrice('stellar').catch(() => null);
      const snap = fallbackSnapshot();
      const assets = snap.data.assets as Array<{ asset: string; priceUsd: number }>;
      if (price !== null && assets[0]) {
        assets[0].priceUsd = price;
      }
      return snap;
    }
  },
};

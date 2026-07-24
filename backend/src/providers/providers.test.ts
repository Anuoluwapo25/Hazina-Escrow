import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { defillamaProvider } from './defillama.provider';
import { riskProvider } from './risk.provider';
import { stellarWhaleProvider } from './stellar-horizon.provider';
import { coingeckoProvider } from './coingecko.provider';
import { getProviderById, getProviderByType, LIVE_TYPES, PROVIDERS } from './registry';

function mockFetchOnce(payload: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    })),
  );
}

function mockFetchReject() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network down');
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registry', () => {
  it('maps providers by id and type', () => {
    expect(getProviderById('defillama')).toBe(defillamaProvider);
    expect(getProviderByType('yield-data')).toBe(defillamaProvider);
    expect(LIVE_TYPES).toContain('sentiment');
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(4);
  });

  it('has unique ids and types', () => {
    const ids = new Set(PROVIDERS.map(p => p.id));
    const types = new Set(PROVIDERS.map(p => p.type));
    expect(ids.size).toBe(PROVIDERS.length);
    expect(types.size).toBe(PROVIDERS.length);
  });
});

describe('defillamaProvider', () => {
  it('returns a live snapshot from real-shaped data', async () => {
    mockFetchOnce({
      status: 'success',
      data: [
        {
          chain: 'Ethereum',
          project: 'Aave V3',
          symbol: 'USDC',
          tvlUsd: 5_000_000_000,
          apy: 5.5,
          apyBase: 5.5,
          apyReward: 0,
          stablecoin: true,
          ilRisk: 'no',
          exposure: 'single',
          pool: 'x',
        },
      ],
    });
    const snap = await defillamaProvider.refresh();
    expect(snap.live).toBe(true);
    expect(snap.data.count).toBe(1);
    expect(snap.points.length).toBeGreaterThan(0);
    expect(snap.headline).toContain('Aave V3');
  });

  it('falls back (live=false) on network failure without throwing', async () => {
    mockFetchReject();
    const snap = await defillamaProvider.refresh();
    expect(snap.live).toBe(false);
    expect(Array.isArray(snap.data.opportunities)).toBe(true);
    expect((snap.data.opportunities as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('riskProvider', () => {
  it('produces bounded risk scores', async () => {
    mockFetchReject();
    const snap = await riskProvider.refresh();
    const protocols = snap.data.protocols as Array<{ riskScore: number; riskLevel: string }>;
    for (const p of protocols) {
      expect(p.riskScore).toBeGreaterThanOrEqual(0);
      expect(p.riskScore).toBeLessThanOrEqual(100);
      expect(['Low', 'Medium', 'High']).toContain(p.riskLevel);
    }
  });
});

describe('stellarWhaleProvider', () => {
  it('falls back with movements on failure', async () => {
    mockFetchReject();
    const snap = await stellarWhaleProvider.refresh();
    expect(snap.data.movementCount).toBeGreaterThan(0);
    expect(Array.isArray(snap.data.movements)).toBe(true);
  });
});

describe('coingeckoProvider', () => {
  beforeEach(() => {
    delete process.env.COINGECKO_API_KEY;
  });

  it('classifies sentiment from live markets data', async () => {
    mockFetchOnce([
      {
        id: 'stellar',
        symbol: 'xlm',
        current_price: 0.12,
        price_change_percentage_24h: 5,
        total_volume: 1,
      },
      {
        id: 'bitcoin',
        symbol: 'btc',
        current_price: 70000,
        price_change_percentage_24h: 4,
        total_volume: 1,
      },
    ]);
    const snap = await coingeckoProvider.refresh();
    expect(snap.live).toBe(true);
    expect(snap.data.sentiment).toBe('Bullish');
  });
});

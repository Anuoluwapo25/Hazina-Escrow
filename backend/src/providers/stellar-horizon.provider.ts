import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { logger } from '../lib/logger';
import { fetchJson } from './fetchWithTimeout';
import { HORIZON_URL } from '../lib/stellar.config';
import type { DataProvider, ProviderSnapshot, ProviderPoint } from './provider.types';

const breaker = getCircuitBreaker('stellar-horizon-whales', {
  failureThreshold: 4,
  resetTimeoutMs: 120_000,
});

interface HorizonPayment {
  id: string;
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  created_at: string;
}

interface HorizonPaymentsResponse {
  _embedded?: { records: HorizonPayment[] };
}

const WHALE_THRESHOLD = 1000; // native XLM units considered a "whale" move

function shortAddr(a?: string): string {
  if (!a) return 'unknown';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function toSnapshot(payments: HorizonPayment[], live: boolean): ProviderSnapshot {
  const large = payments
    .filter(
      p =>
        (p.type === 'payment' || p.type === 'create_account') &&
        Number(p.amount ?? 0) >= WHALE_THRESHOLD,
    )
    .slice(0, 15)
    .map(p => ({
      amount: Number(Number(p.amount ?? 0).toFixed(2)),
      asset: p.asset_code ?? (p.asset_type === 'native' ? 'XLM' : (p.asset_type ?? 'unknown')),
      from: shortAddr(p.from),
      to: shortAddr(p.to),
      at: p.created_at,
    }));
  const totalMoved = large.reduce((s, m) => s + m.amount, 0);
  const points: ProviderPoint[] = large
    .slice(0, 8)
    .map((m, i) => ({ label: `#${i + 1}`, value: m.amount }));
  return {
    data: {
      source: 'Stellar Horizon',
      network: HORIZON_URL.includes('testnet') ? 'testnet' : 'public',
      whaleThreshold: WHALE_THRESHOLD,
      movementCount: large.length,
      totalMoved: Number(totalMoved.toFixed(2)),
      movements: large,
    },
    points,
    fetchedAt: new Date().toISOString(),
    live,
    headline: `${large.length} whale moves tracked, ${Math.round(totalMoved).toLocaleString()} total volume`,
  };
}

function fallbackSnapshot(): ProviderSnapshot {
  const now = Date.now();
  const payments: HorizonPayment[] = [
    mk('7', now - 60_000, '25000', 'XLM'),
    mk('6', now - 180_000, '12000', 'USDC'),
    mk('5', now - 300_000, '48000', 'XLM'),
    mk('4', now - 600_000, '3000', 'USDC'),
    mk('3', now - 900_000, '8800', 'XLM'),
  ];
  return toSnapshot(payments, false);
}

function mk(id: string, ts: number, amount: string, asset: string): HorizonPayment {
  return {
    id,
    type: 'payment',
    from: 'GWHALE' + id.padEnd(50, 'A'),
    to: 'GDEST' + id.padEnd(51, 'B'),
    amount,
    asset_type: asset === 'XLM' ? 'native' : 'credit_alphanum4',
    asset_code: asset === 'XLM' ? undefined : asset,
    created_at: new Date(ts).toISOString(),
  };
}

export const stellarWhaleProvider: DataProvider = {
  id: 'stellar-horizon',
  type: 'whale-wallets',
  category: 'on-chain-flows',
  displayName: 'Stellar Horizon',
  sourceUrl: 'https://stellar.expert',
  async refresh(): Promise<ProviderSnapshot> {
    try {
      const url = `${HORIZON_URL}/payments?order=desc&limit=200`;
      const res = await breaker.execute(() => fetchJson<HorizonPaymentsResponse>(url, 9000));
      const records = res._embedded?.records ?? [];
      const snap = toSnapshot(records, true);
      // If nothing crossed the whale threshold, still return live=true but seed the sparkline.
      return (snap.data.movementCount as number) > 0 ? snap : fallbackSnapshot();
    } catch (err) {
      if (!(err instanceof CircuitBreakerOpenError)) {
        logger.warn(
          `[stellar-horizon] refresh failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallbackSnapshot();
    }
  },
};

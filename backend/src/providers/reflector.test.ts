import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Configurable oracle RPC mock state (set fresh per test) ─────────────────
type MockState = {
  decimals: number;
  resolution: number;
  lastprice: { price: bigint | number; timestamp: number } | null;
  twap: { price: bigint | number; timestamp: number } | null;
  rpcFail?: boolean;
  failOnce?: Set<string>;
};

let state: MockState = {
  decimals: 7,
  resolution: 60,
  lastprice: null,
  twap: null,
};

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = (await vi.importActual('@stellar/stellar-sdk')) as Record<string, unknown>;

  class FakeAccount {
    constructor(
      public address: string,
      public sequence: string,
    ) {}
  }

  class FakeRpcServer {
    async getAccount() {
      return new FakeAccount('AAAAX', '0');
    }
    async simulateTransaction(tx: { _op?: { method?: string } | null }) {
      if (state.rpcFail) throw new Error('rpc unavailable');
      const method = tx._op?.method ?? 'decimals';
      if (state.failOnce?.has(method)) {
        state.failOnce.delete(method);
        throw new Error(`sim ${method} failed`);
      }
      let retval: unknown;
      if (method === 'decimals') retval = state.decimals;
      else if (method === 'resolution') retval = state.resolution;
      else if (method === 'lastprice') {
        retval = state.lastprice
          ? { price: state.lastprice.price, timestamp: state.lastprice.timestamp }
          : null;
      } else if (method === 'twap') {
        retval = state.twap ? { price: state.twap.price, timestamp: state.twap.timestamp } : null;
      } else retval = null;
      return { transactionData: { auth: [] }, latestLedger: 1, result: { retval } };
    }
  }

  class FakeContract {
    constructor(public _id: string) {}
    call(method: string) {
      return { method } as unknown;
    }
  }

  class FakeTxBuilder {
    _op: { method?: string } | null = null;
    constructor(_account: unknown, _opts: unknown) {}
    addOperation(op: { method?: string }) {
      this._op = op;
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return this as unknown;
    }
  }

  const isSimulationSuccess = (x: unknown) => !!x && typeof x === 'object' && 'result' in x;

  return {
    ...actual,
    rpc: {
      Server: FakeRpcServer,
      Api: { isSimulationSuccess },
    },
    Account: FakeAccount,
    BASE_FEE: '100',
    Contract: FakeContract,
    TransactionBuilder: FakeTxBuilder,
    nativeToScVal: (x: unknown) => ({ val: x }),
  };
});

vi.mock('../lib/scval', () => ({
  scValToNative: <T>(v: T) => v,
}));

vi.mock('../common/datadog', () => ({
  incrementMetric: vi.fn(),
  domainMetrics: { circuitBreakerTrip: vi.fn() },
}));

vi.mock('../common/env', () => ({
  parsePositiveInt: (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d),
}));

vi.mock('../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

// Resolve breaker after mocking datadog
import {
  absDiffBps,
  convertDatasetPrice,
  convertFixedPoint,
  getOraclePrice,
  OracleUnavailableError,
  OraclePrice,
} from './reflector.provider';

// ── Harness ─────────────────────────────────────────────────────────────────
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  process.env.ORACLE_MAX_DEVIATION_BPS = '200';
  process.env.ORACLE_STALENESS_MULTIPLIER = '3';
  process.env.ORACLE_TWAP_RECORDS = '12';
  process.env.QUOTE_EXPIRY_SECONDS = '120';
  // fresh default price: 0.1100000 USD/XLM with 7 decimals = 1_100_000, 10s old, res=60
  const t = nowSeconds() - 10;
  state = {
    decimals: 7,
    resolution: 60,
    lastprice: { price: 1_100_000n, timestamp: t },
    twap: { price: 1_100_500n, timestamp: t },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.ORACLE_MAX_DEVIATION_BPS;
  delete process.env.ORACLE_STALENESS_MULTIPLIER;
  delete process.env.ORACLE_TWAP_RECORDS;
  delete process.env.QUOTE_EXPIRY_SECONDS;
});

// ── Pure conversion tests (bigint exactness) ────────────────────────────────
describe('convertFixedPoint', () => {
  it('multiply direction: 5 USD at 7 decimals * XLM/USD 0.11 = 0.55 XLM (7 decimals)', () => {
    // price 0.11 USD per XLM, scaled 1e7 = 1_100_000
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 1_100_000n,
      decimals: 7,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    // invert=false: amount_out = amount_in * price / (1e7). 5 USD (7 decimals) * 1_100_000 / 1e7
    // We never actually use this direction for USD -> XLM datasets;
    // ensure multiply works: 10_000_000 (1.0000000) * 1_100_000 / 1e7 = 1_100_000 (0.11 XLM)
    const r = convertFixedPoint({
      amountIn: 10_000_000n,
      decimalsIn: 7,
      price,
      decimalsOut: 7,
      invert: false,
    });
    expect(r.toString()).toBe('1100000');
  });

  it('invert direction: 0.05 USD (7 dec) -> XLM at 0.11 USD/XLM gives exact amount', () => {
    // price 0.11 USD/XLM means 1 XLM costs 0.11 USD
    // USD->XLM conversion: amount_XLM = USD_amount / USD_per_XLM
    // 0.05 / 0.11 = 0.4545454... with 7 decimals => 4_545_454 (truncated, not rounded)
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 1_100_000n, // 0.11 scaled
      decimals: 7,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    const r = convertFixedPoint({
      amountIn: 500_000n, // 0.05 USD with 7 decimals
      decimalsIn: 7,
      price,
      decimalsOut: 7,
      invert: true,
    });
    // 500000 * 1e7 * 1e7 / (1100000 * 1e7) = 500000 * 1e7 / 1100000 = 4_545_454.545... truncated
    expect(r.toString()).toBe('4545454');
  });

  it('exact at 14 significant digits', () => {
    // Construct price: 0.12345678901234eX (14 sig digits scaled within 18-dec space)
    // price decimals 14: raw value 12345678901234 = 1.2345678901234
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 1_234_567_890_123_456n, // in decimals=15, value 1.234567890123456
      decimals: 15,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    // 100.000000 USD (6 decimals, amountIn=100 * 1e6 = 100_000_000)
    const r = convertFixedPoint({
      amountIn: 100_000_000n,
      decimalsIn: 6,
      price,
      decimalsOut: 6,
      invert: true,
    });
    // amountOut = 100e6 * 1e15 * 1e6 / (1.234567890123456e15 * 1e6)
    //          = 100e6 / 1.234567890123456 = 81.000000... compute precisely:
    // 100_000_000 * 1e15 / 1_234_567_890_123_456
    // = 1e23 / 1234567890123456 = 8100065610033 (let me compute via BigInt)
    const expected = (100_000_000n * 10n ** 15n) / 1_234_567_890_123_456n;
    expect(r).toBe(expected);
    // Confirm: when you re-compute back forward you don't drift due to float use
    const roundtrip = convertFixedPoint({
      amountIn: r,
      decimalsIn: 6,
      price,
      decimalsOut: 6,
      invert: false,
    });
    // forward should be <= 100e6 and within 1 unit at 6 decimals (truncation only)
    expect(roundtrip).toBeLessThanOrEqual(100_000_000n);
    expect(100_000_000n - roundtrip).toBeLessThanOrEqual(1n);
  });

  it('decimals mismatch: USD in 2 decimals, XLM out 7 decimals, price 7 decimals', () => {
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 1_100_000n,
      decimals: 7,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    // $1.00 USD in 2 decimals = 100 cents
    const r = convertFixedPoint({
      amountIn: 100n,
      decimalsIn: 2,
      price,
      decimalsOut: 7,
      invert: true,
    });
    // 100 * 1e7 * 1e7 / (1_100_000 * 1e2) = 100 * 1e12 / 1100000 = 90_909_090
    expect(r.toString()).toBe('90909090');
  });

  it('rejects negative amounts', () => {
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 1n,
      decimals: 7,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    expect(() =>
      convertFixedPoint({
        amountIn: -1n,
        decimalsIn: 7,
        price,
        decimalsOut: 7,
        invert: true,
      }),
    ).toThrow(OracleUnavailableError);
  });

  it('rejects zero price when inverting', () => {
    const price: OraclePrice = {
      base: 'XLM',
      quote: 'USD',
      price: 0n,
      decimals: 7,
      timestamp: 0,
      sourceContract: 'x',
      resolvedVia: 'lastprice',
      ageSeconds: 0,
    };
    expect(() =>
      convertFixedPoint({
        amountIn: 1n,
        decimalsIn: 7,
        price,
        decimalsOut: 7,
        invert: true,
      }),
    ).toThrow(OracleUnavailableError);
  });
});

describe('absDiffBps', () => {
  it('returns 0 for identical values', () => {
    expect(absDiffBps(100n, 100n)).toBe(0n);
  });
  it('computes 1% = 100 bps', () => {
    expect(absDiffBps(101n, 100n)).toBe(100n);
  });
  it('computes 2% = 200 bps (our threshold)', () => {
    expect(absDiffBps(102n, 100n)).toBe(200n);
  });
  it('handles division-by-zero fallback', () => {
    expect(absDiffBps(1n, 0n)).toBe(10_000n);
  });
});

// ── Oracle fetch / staleness / breaker / twap fallback ──────────────────────
describe('getOraclePrice', () => {
  it('fresh lastprice returns cleanly', async () => {
    const r = await getOraclePrice('XLM', 'USD');
    expect(r.base).toBe('XLM');
    expect(r.quote).toBe('USD');
    expect(r.price).toBe(1_100_000n);
    expect(r.resolvedVia).toBe('lastprice');
    expect(r.decimals).toBe(7);
    expect(r.ageSeconds).toBeLessThanOrEqual(60 * 3);
  });

  it('stale lastprice with fresh twap uses twap fallback', async () => {
    const t = nowSeconds();
    // last was 60*3 + 1 seconds ago → stale; twap is fresh
    state.lastprice = { price: 1_100_000n, timestamp: t - (60 * 3 + 1) };
    state.twap = { price: 1_100_500n, timestamp: t - 30 };
    const r = await getOraclePrice('XLM', 'USD');
    expect(r.resolvedVia).toBe('twap');
    expect(r.price).toBe(1_100_500n);
  });

  it('both stale → throws stale error', async () => {
    const t = nowSeconds();
    state.lastprice = { price: 1_100_000n, timestamp: t - 10_000 };
    state.twap = { price: 1_100_500n, timestamp: t - 10_000 };
    await expect(getOraclePrice('XLM', 'USD')).rejects.toMatchObject({
      name: 'OracleUnavailableError',
      reason: 'stale',
    });
  });

  it('no data at all → throws no_data', async () => {
    state.lastprice = null;
    state.twap = null;
    await expect(getOraclePrice('XLM', 'USD')).rejects.toMatchObject({
      reason: 'no_data',
    });
  });

  it('lastprice succeeds first call twap fails → still lastprice fresh works', async () => {
    state.failOnce = new Set(['twap']);
    const r = await getOraclePrice('XLM', 'USD');
    expect(r.resolvedVia).toBe('lastprice');
  });

  it('lastprice fails, twap fresh → twap fallback', async () => {
    state.failOnce = new Set(['lastprice']);
    const r = await getOraclePrice('XLM', 'USD');
    expect(r.resolvedVia).toBe('twap');
  });

  it('deviation >200 bps trips the breaker', async () => {
    const t = nowSeconds() - 5;
    // 50% deviation = 5000 bps
    state.lastprice = { price: 1_500_000n, timestamp: t };
    state.twap = { price: 1_000_000n, timestamp: t };
    const err = await getOraclePrice('XLM', 'USD').catch(e => e);
    expect(err).toBeInstanceOf(OracleUnavailableError);
    expect((err as OracleUnavailableError).reason).toBe('deviation');
  });

  it('deviation 199 bps is within threshold → ok', async () => {
    const t = nowSeconds() - 5;
    // last = 1.00199, twap = 1.0, diff/twap = 0.00199 → 19.9 bps? Wrong let me compute:
    // abs(1001990-1000000)/1000000 * 10000 = 1990/1000000*10000 = 19.9 bps. OK small.
    // I want 199 bps: diff/twap * 10_000 = 199 → diff = 0.0199 → last = 1.0199
    // 7 decimals: last = 10_199_000, twap = 10_000_000
    state.lastprice = { price: 10_199_000n, timestamp: t };
    state.twap = { price: 10_000_000n, timestamp: t };
    state.decimals = 7;
    state.resolution = 60;
    const r = await getOraclePrice('XLM', 'USD');
    expect(r.resolvedVia).toBe('lastprice');
  });

  it('zero price rejected', async () => {
    const t = nowSeconds() - 10;
    state.lastprice = { price: 0n, timestamp: t };
    state.twap = { price: 0n, timestamp: t };
    await expect(getOraclePrice('XLM', 'USD')).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('negative price (encoded via bigint) rejected', async () => {
    const t = nowSeconds() - 10;
    // decodePricePoint checks <= 0, so -1n becomes rejected before return;
    // but lastprice/twap are fed through decodePricePoint: price <= 0 returns null.
    // So provider sees null. End result: same as no_data.
    state.lastprice = { price: -1n, timestamp: t };
    state.twap = null;
    await expect(getOraclePrice('XLM', 'USD')).rejects.toMatchObject({
      name: 'OracleUnavailableError',
    });
  });

  it('USD base passes through as USDC for oracle lookup', async () => {
    const r = await getOraclePrice('USD', 'USD');
    // internal baseForOracle=USDC, but OraclePrice.base should be the original requested base
    expect(r.base).toBe('USD');
  });
});

// ── Dataset-level conversion ────────────────────────────────────────────────
describe('convertDatasetPrice', () => {
  it('USDC→USDC returns 1:1 identity with fake oracle', async () => {
    const r = await convertDatasetPrice({
      priceUsd: 5_000_000n,
      usdDecimals: 7,
      paymentAsset: 'USDC',
      paymentDecimals: 7,
    });
    expect(r.amountOut).toBe(5_000_000n);
    expect(r.decimalsOut).toBe(7);
    expect(r.price.price).toBe(10n ** 7n); // 1.0 USD/USDC synthetic
  });

  it('USD-priced dataset → XLM uses oracle invert', async () => {
    const r = await convertDatasetPrice({
      priceUsd: 500_000n, // 0.05 USD @ 7 decimals
      usdDecimals: 7,
      paymentAsset: 'XLM',
      paymentDecimals: 7,
    });
    // oracle price 0.11 USD/XLM, invert: 0.05/0.11 = 0.4545454 (7 decimals)
    expect(r.amountOut.toString()).toBe('4545454');
    expect(r.price.base).toBe('XLM');
  });

  it('XLM path sets expiry seconds in the future', async () => {
    const before = nowSeconds();
    const r = await convertDatasetPrice({
      priceUsd: 1_000_000n,
      usdDecimals: 7,
      paymentAsset: 'XLM',
      paymentDecimals: 7,
    });
    const after = nowSeconds();
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 119);
    expect(r.expiresAt).toBeLessThanOrEqual(after + 121);
  });
});

// ── Source-level guarantees: no float arithmetic in conversion path ─────────
describe('conversion path has no float arithmetic', () => {
  it('convertFixedPoint source contains no Number/parseFloat/toFixed/Math ops', () => {
    const src = convertFixedPoint.toString();
    const forbidden = [
      'parseFloat',
      'parseInt',
      'toFixed',
      'toPrecision',
      'Math.',
      /\bNumber\s*\(/,
      /\bNumber\./,
    ];
    for (const pattern of forbidden) {
      if (typeof pattern === 'string') {
        expect(src).not.toContain(pattern);
      } else {
        expect(src).not.toMatch(pattern);
      }
    }
  });

  it('absDiffBps source contains no float-only helpers', () => {
    const src = absDiffBps.toString();
    expect(src).not.toContain('parseFloat');
    expect(src).not.toContain('toFixed');
    expect(src).not.toMatch(/\bMath\./);
  });
});

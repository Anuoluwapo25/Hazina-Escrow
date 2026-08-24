import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL, STELLAR_NETWORK, getNetworkPassphrase } from '../lib/stellar.config';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { domainMetrics, incrementMetric } from '../common/datadog';
import { logger } from '../lib/logger';
import { scValToNative } from '../lib/scval';
import { parsePositiveInt } from '../common/env';

export type OracleAssetCode = 'XLM' | 'USDC' | 'EURC' | 'USD';
export type PriceQuoteCurrency = 'USD' | 'USDC';

export interface OraclePrice {
  base: OracleAssetCode;
  quote: PriceQuoteCurrency;
  price: bigint;
  decimals: number;
  timestamp: number;
  sourceContract: string;
  resolvedVia: 'lastprice' | 'twap';
  ageSeconds: number;
}

export interface ConversionResult {
  amountIn: bigint;
  decimalsIn: number;
  amountOut: bigint;
  decimalsOut: number;
  price: OraclePrice;
  expiresAt: number;
}

export class OracleUnavailableError extends Error {
  constructor(
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = 'OracleUnavailableError';
  }
}

const BPS_DENOMINATOR = 10_000n;

const ORACLE_MAX_DEVIATION_BPS = BigInt(
  parsePositiveInt(process.env.ORACLE_MAX_DEVIATION_BPS, 200),
);
const ORACLE_STALENESS_MULTIPLIER = parsePositiveInt(process.env.ORACLE_STALENESS_MULTIPLIER, 3);
const ORACLE_TWAP_RECORDS = parsePositiveInt(process.env.ORACLE_TWAP_RECORDS, 12);
const QUOTE_EXPIRY_SECONDS = parsePositiveInt(process.env.QUOTE_EXPIRY_SECONDS, 120);

const DEFAULT_REFLECTOR_TESTNET = 'CCNYW3JNS6I5P5XZ7LMZNBQ3VV4MZNXAFAUEUVVGBZMXQ7QYHVFGZ2P6';
const DEFAULT_REFLECTOR_MAINNET = 'CBMGHE654XZWWONZCHZZCHR7F525623HNRXZ4DZ7ZZZ523QYHVFGREFLECTOR';

export function getReflectorContractId(): string {
  const explicit = (process.env.REFLECTOR_CONTRACT_ID ?? '').trim();
  if (explicit) return explicit;
  return STELLAR_NETWORK === 'mainnet' ? DEFAULT_REFLECTOR_MAINNET : DEFAULT_REFLECTOR_TESTNET;
}

export function assetToSymbol(code: OracleAssetCode): string {
  switch (code) {
    case 'XLM':
      return 'XLM';
    case 'USDC':
      return 'USDC';
    case 'EURC':
      return 'EURC';
    case 'USD':
      return 'USD';
  }
}

const sorobanBreaker = getCircuitBreaker('soroban-rpc');
const reflectorBreaker = getCircuitBreaker('reflector-oracle', {
  failureThreshold: 4,
  resetTimeoutMs: 60_000,
});

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

async function simulateRead(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.xdr.ScVal> {
  const rpc = getRpc();
  const contract = new StellarSdk.Contract(contractId);
  const sourceAddr = contractId;
  const account = await sorobanBreaker
    .execute(() => rpc.getAccount(sourceAddr))
    .catch(() => new StellarSdk.Account(sourceAddr, '0'));

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`Reflector ${method}() sim failed`);
  }
  return sim.result.retval;
}

export async function readDecimals(contractId: string): Promise<number> {
  const retval = await simulateRead(contractId, 'decimals', []);
  return Number(scValToNative<number>(retval));
}

export async function readResolution(contractId: string): Promise<number> {
  const retval = await simulateRead(contractId, 'resolution', []);
  return Number(scValToNative<number>(retval));
}

interface Sep40PriceData {
  price: bigint;
  timestamp: number;
}

function decodePricePoint(raw: unknown): Sep40PriceData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const price = obj.price !== undefined ? BigInt(obj.price as string | number | bigint) : null;
  const timestamp = obj.timestamp !== undefined ? Number(obj.timestamp) : null;
  if (price === null || timestamp === null || !Number.isFinite(timestamp)) return null;
  return { price, timestamp };
}

export async function readLastPrice(
  contractId: string,
  asset: OracleAssetCode,
): Promise<Sep40PriceData | null> {
  const assetArg = StellarSdk.nativeToScVal(assetToSymbol(asset), { type: 'string' });
  const retval = await simulateRead(contractId, 'lastprice', [assetArg]);
  const native = scValToNative(retval);
  return decodePricePoint(native);
}

export async function readTwap(
  contractId: string,
  asset: OracleAssetCode,
  records: number,
): Promise<Sep40PriceData | null> {
  const assetArg = StellarSdk.nativeToScVal(assetToSymbol(asset), { type: 'string' });
  const recordsArg = StellarSdk.nativeToScVal(records, { type: 'u32' });
  const retval = await simulateRead(contractId, 'twap', [assetArg, recordsArg]);
  const native = scValToNative(retval);
  return decodePricePoint(native);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function absDiffBps(a: bigint, b: bigint): bigint {
  const diff = a > b ? a - b : b - a;
  if (b === 0n) return BPS_DENOMINATOR;
  return (diff * BPS_DENOMINATOR) / b;
}

export async function getOraclePrice(
  base: OracleAssetCode,
  quote: PriceQuoteCurrency = 'USD',
): Promise<OraclePrice> {
  const contractId = getReflectorContractId();
  const baseForOracle: OracleAssetCode = base === 'USD' ? 'USDC' : base;

  try {
    return await reflectorBreaker.execute(async () => {
      const [decimals, resolution] = await Promise.all([
        readDecimals(contractId),
        readResolution(contractId),
      ]);

      const stalenessLimit = resolution * ORACLE_STALENESS_MULTIPLIER;
      const now = nowSeconds();

      const last = await readLastPrice(contractId, baseForOracle).catch(() => null);
      const lastFresh = last && now - last.timestamp <= stalenessLimit ? last : null;

      const twap = await readTwap(contractId, baseForOracle, ORACLE_TWAP_RECORDS).catch(() => null);
      const twapFresh = twap && now - twap.timestamp <= stalenessLimit ? twap : null;

      let chosen: Sep40PriceData;
      let resolvedVia: 'lastprice' | 'twap';

      if (lastFresh) {
        chosen = lastFresh;
        resolvedVia = 'lastprice';
        if (chosen.price <= 0n) {
          throw new OracleUnavailableError('Oracle returned non-positive price', 'invalid');
        }
        if (twapFresh) {
          const deviation = absDiffBps(lastFresh.price, twapFresh.price);
          if (deviation > ORACLE_MAX_DEVIATION_BPS) {
            incrementMetric('oracle.deviation_breaker.trip', 1, {
              base,
              quote,
              deviation_bps: Number(deviation),
            });
            domainMetrics.circuitBreakerTrip({ service: 'reflector-oracle' });
            throw new OracleUnavailableError(
              `Oracle price deviation too high (${Number(deviation)} bps > ${Number(ORACLE_MAX_DEVIATION_BPS)} bps)`,
              'deviation',
            );
          }
        }
      } else if (twapFresh) {
        chosen = twapFresh;
        resolvedVia = 'twap';
        if (chosen.price <= 0n) {
          throw new OracleUnavailableError('Oracle returned non-positive price', 'invalid');
        }
        incrementMetric('oracle.twap_fallback.used', 1, { base, quote });
      } else if (last) {
        throw new OracleUnavailableError(
          `Oracle price stale: age ${now - last.timestamp}s > ${stalenessLimit}s`,
          'stale',
        );
      } else {
        throw new OracleUnavailableError('Oracle returned no price data', 'no_data');
      }

      if (chosen.price <= 0n) {
        throw new OracleUnavailableError('Oracle returned non-positive price', 'invalid');
      }

      incrementMetric('oracle.price.queried', 1, {
        base,
        quote,
        resolved_via: resolvedVia,
      });

      return {
        base,
        quote,
        price: chosen.price,
        decimals,
        timestamp: chosen.timestamp,
        sourceContract: contractId,
        resolvedVia,
        ageSeconds: now - chosen.timestamp,
      };
    });
  } catch (err) {
    if (err instanceof OracleUnavailableError) {
      incrementMetric('oracle.error', 1, {
        base,
        quote,
        reason: err.reason ?? 'unknown',
      });
      throw err;
    }
    if (err instanceof CircuitBreakerOpenError) {
      incrementMetric('oracle.error', 1, { base, quote, reason: 'breaker_open' });
      throw new OracleUnavailableError('Oracle circuit breaker open', 'breaker_open');
    }
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`[Reflector] price fetch failed: ${reason}`);
    incrementMetric('oracle.error', 1, { base, quote, reason: 'network' });
    throw new OracleUnavailableError(`Oracle unavailable: ${reason}`, 'network');
  }
}

export function convertFixedPoint(params: {
  amountIn: bigint;
  decimalsIn: number;
  price: OraclePrice;
  decimalsOut: number;
  invert?: boolean;
}): bigint {
  const { amountIn, decimalsIn, price, decimalsOut, invert = false } = params;
  if (amountIn < 0n) throw new OracleUnavailableError('Negative amount', 'invalid');

  const scaleIn = 10n ** BigInt(decimalsIn);
  const scaleOut = 10n ** BigInt(decimalsOut);
  const scalePrice = 10n ** BigInt(price.decimals);

  if (invert) {
    if (price.price === 0n) throw new OracleUnavailableError('Zero price', 'invalid');
    return (amountIn * scalePrice * scaleOut) / (price.price * scaleIn);
  }
  return (amountIn * price.price * scaleOut) / (scalePrice * scaleIn);
}

export async function convertDatasetPrice(params: {
  priceUsd: bigint;
  usdDecimals: number;
  paymentAsset: OracleAssetCode;
  paymentDecimals: number;
}): Promise<ConversionResult> {
  const { priceUsd, usdDecimals, paymentAsset, paymentDecimals } = params;

  if (paymentAsset === 'USDC' || paymentAsset === 'USD') {
    const contractId = getReflectorContractId();
    const now = nowSeconds();
    return {
      amountIn: priceUsd,
      decimalsIn: usdDecimals,
      amountOut: priceUsd,
      decimalsOut: paymentDecimals,
      price: {
        base: 'USDC',
        quote: 'USD',
        price: 10n ** BigInt(7),
        decimals: 7,
        timestamp: now,
        sourceContract: contractId,
        resolvedVia: 'lastprice',
        ageSeconds: 0,
      },
      expiresAt: now + QUOTE_EXPIRY_SECONDS,
    };
  }

  const oraclePrice = await getOraclePrice(paymentAsset, 'USD');
  const amountOut = convertFixedPoint({
    amountIn: priceUsd,
    decimalsIn: usdDecimals,
    price: oraclePrice,
    decimalsOut: paymentDecimals,
    invert: true,
  });
  return {
    amountIn: priceUsd,
    decimalsIn: usdDecimals,
    amountOut,
    decimalsOut: paymentDecimals,
    price: oraclePrice,
    expiresAt: nowSeconds() + QUOTE_EXPIRY_SECONDS,
  };
}

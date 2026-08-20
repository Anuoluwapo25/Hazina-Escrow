import * as StellarSdk from '@stellar/stellar-sdk';
import crypto from 'crypto';
import { HORIZON_URL, getTokenByCode } from '../lib/stellar.config';
import { getDataset } from '../common/storage';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const HMAC_SECRET = process.env.QUOTE_HMAC_SECRET || 'dev-hmac-secret-do-not-use-in-prod';

export interface QuoteRequest {
  datasetId: string;
  sourceAssetCode: string;
}

export interface Quote {
  destination: { asset: string; amount: string };
  source: { asset: string; maxAmount: string };
  path: string[];
  slippageBps: number;
  expiresAt: string;
  signature?: string;
}

/**
 * Generates an HMAC signature for the quote.
 */
function signQuote(quote: Omit<Quote, 'signature'>): string {
  const payload = `${quote.destination.asset}:${quote.destination.amount}:${quote.source.asset}:${quote.source.maxAmount}:${quote.expiresAt}`;
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

/**
 * Validates a quote signature and expiration.
 */
export function verifyQuoteSignature(quote: Quote): boolean {
  if (!quote.signature) return false;
  if (Date.now() > new Date(quote.expiresAt).getTime()) return false;

  const expectedSignature = signQuote({
    destination: quote.destination,
    source: quote.source,
    path: quote.path,
    slippageBps: quote.slippageBps,
    expiresAt: quote.expiresAt,
  });

  return crypto.timingSafeEqual(
    Buffer.from(quote.signature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  );
}

/**
 * Checks implied price against a reference to protect against thin orderbooks.
 * XLM reference ~0.10 USD
 * EURC reference ~1.10 USD
 */
export async function checkPriceSanity(
  sourceAssetCode: string,
  destTokenCode: string,
  impliedPrice: number,
): Promise<boolean> {
  let expectedRate = 1.0; // 1:1 default

  if (destTokenCode === 'USDC' || destTokenCode === 'EURC') {
    if (sourceAssetCode === 'XLM')
      expectedRate = 10.0; // 10 XLM per USDC roughly
    else if (sourceAssetCode === 'EURC') expectedRate = 0.9;
    else if (sourceAssetCode === 'USDC') expectedRate = 1.1; // EURC vs USDC
  }

  const deviation = Math.abs(impliedPrice - expectedRate) / expectedRate;
  // Reject if deviated by more than 20%
  if (deviation > 0.2) return false;

  return true;
}

/** Parses a decimal string to a stroops BigInt securely avoiding floating point precision loss. */
export function parseToStroops(valueStr: string): bigint {
  const parts = valueStr.split('.');
  const integerPart = parts[0] || '0';
  let fractionalPart = parts[1] || '';

  if (fractionalPart.length > 7) fractionalPart = fractionalPart.slice(0, 7);
  else while (fractionalPart.length < 7) fractionalPart += '0';

  return BigInt(integerPart + fractionalPart);
}

/** Formats a stroops BigInt back to a decimal string. */
export function formatFromStroops(stroops: bigint): string {
  const isNegative = stroops < 0n;
  const absStroops = isNegative ? -stroops : stroops;
  const str = absStroops.toString().padStart(8, '0');
  const intPart = str.slice(0, -7);
  const fracPart = str.slice(-7);
  const formatted = `${isNegative ? '-' : ''}${intPart}.${fracPart}`;
  return formatted.replace(/\.?0+$/, '') || '0'; // Trim trailing zeroes
}

export async function getQuote(datasetId: string, sourceAssetCode: string): Promise<Quote> {
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new Error('Dataset not found');
  }

  const destTokenCode = dataset.paymentToken || 'USDC';
  const destToken = getTokenByCode(destTokenCode);
  if (!destToken) {
    throw new Error(`Unsupported destination token: ${destTokenCode}`);
  }

  const sourceToken = getTokenByCode(sourceAssetCode) || { code: sourceAssetCode };

  const destAsset = destToken.issuer
    ? new StellarSdk.Asset(destToken.code, destToken.issuer)
    : StellarSdk.Asset.native();

  const sourceAssetObj =
    'issuer' in sourceToken && sourceToken.issuer
      ? new StellarSdk.Asset(sourceToken.code, sourceToken.issuer)
      : sourceAssetCode === 'XLM'
        ? StellarSdk.Asset.native()
        : null;

  if (!sourceAssetObj) {
    throw new Error('Invalid source asset');
  }

  const destAmountStr = dataset.pricePerQuery.toString();
  const destAmountStroops = parseToStroops(destAmountStr);

  // If source and destination are the same, return a trivial quote (1:1)
  if (sourceAssetCode === destTokenCode) {
    const quote: Omit<Quote, 'signature'> = {
      destination: { asset: destTokenCode, amount: formatFromStroops(destAmountStroops) },
      source: { asset: sourceAssetCode, maxAmount: formatFromStroops(destAmountStroops) },
      path: [],
      slippageBps: 0,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    return { ...quote, signature: signQuote(quote) };
  }

  // Horizon strict-receive path lookup
  // We want to receive exactly destAmountStr of destAsset
  const pathsResponse = await server
    .strictReceivePaths([sourceAssetObj], destAsset, destAmountStr)
    .call();

  if (!pathsResponse.records || pathsResponse.records.length === 0) {
    throw new Error('No path found to convert the requested asset');
  }

  // Pick the best path (Horizon sorts by cheapest source amount)
  const bestPath = pathsResponse.records[0];
  if (!bestPath) {
    throw new Error('No path found to convert the requested asset');
  }
  const sourceAmountStroops = parseToStroops(bestPath.source_amount);

  // Calculate implied price (source per dest) for sanity check
  const impliedPrice = Number(sourceAmountStroops) / Number(destAmountStroops);
  const isSane = await checkPriceSanity(sourceAssetCode, destTokenCode, impliedPrice);
  if (!isSane) {
    throw new Error(
      `Implied price deviates too much from reference (thin orderbook). Implied rate: ${impliedPrice}`,
    );
  }

  // Add 1% slippage buffer (100 bps)
  const slippageBps = 100n;
  const maxAmountStroops = (sourceAmountStroops * (10000n + slippageBps)) / 10000n;
  const maxAmountStr = formatFromStroops(maxAmountStroops);

  const quote: Omit<Quote, 'signature'> = {
    destination: {
      asset: destToken.issuer ? `${destToken.code}:${destToken.issuer}` : 'native',
      amount: formatFromStroops(destAmountStroops),
    },
    source: {
      asset:
        'issuer' in sourceToken && sourceToken.issuer
          ? `${sourceToken.code}:${sourceToken.issuer}`
          : 'native',
      maxAmount: maxAmountStr,
    },
    path: bestPath.path.map(a =>
      a.asset_type === 'native' ? 'native' : `${a.asset_code}:${a.asset_issuer}`,
    ),
    slippageBps: Number(slippageBps),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  return { ...quote, signature: signQuote(quote) };
}

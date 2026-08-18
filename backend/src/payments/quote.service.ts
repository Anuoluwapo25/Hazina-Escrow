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
    expiresAt: quote.expiresAt
  });
  
  return crypto.timingSafeEqual(
    Buffer.from(quote.signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

/**
 * Mocks a reference price oracle check for thin-orderbook protection.
 * In a real implementation, this would fetch from Reflector or CoinGecko.
 */
async function checkPriceSanity(sourceAsset: string, destAsset: string, exchangeRate: number): Promise<boolean> {
  // If native XLM to USDC, expect roughly 0.1 USDC per XLM (just a dummy check)
  // We'll just assume true for this implementation unless it's way off.
  if (exchangeRate <= 0) return false;
  return true;
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

  const sourceAssetObj = sourceToken.issuer 
    ? new StellarSdk.Asset(sourceToken.code, sourceToken.issuer)
    : (sourceAssetCode === 'XLM' ? StellarSdk.Asset.native() : null);

  if (!sourceAssetObj) {
    throw new Error('Invalid source asset');
  }

  const destAmountStr = dataset.pricePerQuery.toString();

  // If source and destination are the same, return a trivial quote (1:1)
  if (sourceAssetCode === destTokenCode) {
    const quote: Omit<Quote, 'signature'> = {
      destination: { asset: destTokenCode, amount: destAmountStr },
      source: { asset: sourceAssetCode, maxAmount: destAmountStr },
      path: [],
      slippageBps: 0,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    };
    return { ...quote, signature: signQuote(quote) };
  }

  // Horizon strict-receive path lookup
  // We want to receive exactly destAmountStr of destAsset
  const pathsResponse = await server.strictReceivePaths(
    [sourceAssetObj],
    destAsset,
    destAmountStr
  ).call();

  if (!pathsResponse.records || pathsResponse.records.length === 0) {
    throw new Error('No path found to convert the requested asset');
  }

  // Pick the best path (Horizon sorts by cheapest source amount)
  const bestPath = pathsResponse.records[0];
  const sourceAmount = parseFloat(bestPath.source_amount);
  
  // Calculate implied price (source per dest)
  const impliedPrice = sourceAmount / dataset.pricePerQuery;
  const isSane = await checkPriceSanity(sourceAssetCode, destTokenCode, impliedPrice);
  if (!isSane) {
    throw new Error('Implied price deviates too much from reference (thin orderbook)');
  }

  // Add 1% slippage buffer (100 bps)
  const slippageBps = 100;
  const maxAmount = (sourceAmount * (1 + slippageBps / 10000)).toFixed(7);

  const quote: Omit<Quote, 'signature'> = {
    destination: { 
      asset: destToken.issuer ? `${destToken.code}:${destToken.issuer}` : 'native', 
      amount: destAmountStr 
    },
    source: { 
      asset: sourceToken.issuer ? `${sourceToken.code}:${sourceToken.issuer}` : 'native', 
      maxAmount 
    },
    path: bestPath.path.map(a => a.asset_type === 'native' ? 'native' : `${a.asset_code}:${a.asset_issuer}`),
    slippageBps,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
  };

  return { ...quote, signature: signQuote(quote) };
}

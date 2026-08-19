/**
 * trustline.service.ts
 *
 * Destination preflight for seller payouts. Before Hazina attempts to send a
 * seller their earnings directly, we check whether the destination account
 * can actually receive the asset — does the account exist on-chain, does it
 * trust the token, and (for tokens with an authorization-required issuer) is
 * that trustline authorized? A payout to an account that fails any of these
 * checks would bounce with `op_no_destination` / `op_no_trust`, which is
 * exactly the failure mode the claimable-balance settlement fallback exists
 * to route around (see claimable.service.ts).
 *
 * Results are cached briefly (accounts rarely change trustline state inside
 * a few seconds) and calls go through the same circuit breaker pattern as
 * stellar.service.ts so a flaky Horizon doesn't cascade into every payout.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { HORIZON_URL, getTokenByCode } from '../lib/stellar.config';
import { parsePositiveInt } from '../common/env';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const preflightBreaker = getCircuitBreaker('stellar-horizon-preflight', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

const getPreflightTimeoutMs = () => parsePositiveInt(process.env.STELLAR_TIMEOUT_MS, 10000);

export type PreflightReason = 'account_not_found' | 'no_trustline' | 'not_authorized';

export interface PreflightResult {
  ready: boolean;
  reason?: PreflightReason;
}

interface CacheEntry {
  result: PreflightResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(destinationAddress: string, tokenCode: string): string {
  return `${destinationAddress}:${tokenCode}`;
}

/** Test-only: clears the preflight result cache between test cases. */
export function __clearPreflightCache(): void {
  cache.clear();
}

async function withPreflightTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const timeoutMs = getPreflightTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`Preflight check did not respond within ${timeoutMs / 1000}s`));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isNotFound(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}

/**
 * Checks whether `destinationAddress` can receive `tokenCode` right now.
 * XLM (native) never needs a trustline, so it is always ready once the
 * account exists. Cached for CACHE_TTL_MS per (address, token) pair.
 */
export async function checkDestinationReady(
  destinationAddress: string,
  tokenCode: string,
): Promise<PreflightResult> {
  const key = cacheKey(destinationAddress, tokenCode);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await computeDestinationReady(destinationAddress, tokenCode);
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function computeDestinationReady(
  destinationAddress: string,
  tokenCode: string,
): Promise<PreflightResult> {
  let account: StellarSdk.Horizon.AccountResponse;
  try {
    account = await withPreflightTimeout(() =>
      preflightBreaker.execute(() => server.loadAccount(destinationAddress)),
    );
  } catch (err) {
    if (isNotFound(err)) {
      return { ready: false, reason: 'account_not_found' };
    }
    throw err;
  }

  if (tokenCode === 'XLM') {
    return { ready: true };
  }

  const token = getTokenByCode(tokenCode);
  if (!token?.issuer) {
    // Unsupported/misconfigured token — treat as a trustline problem so the
    // caller falls back rather than attempting a payment that can't succeed.
    return { ready: false, reason: 'no_trustline' };
  }

  const balance = account.balances.find(b => {
    if (b.asset_type === 'native') return false;
    const bal = b as unknown as { asset_code: string; asset_issuer: string };
    return bal.asset_code === tokenCode && bal.asset_issuer === token.issuer;
  }) as { is_authorized?: boolean } | undefined;

  if (!balance) {
    return { ready: false, reason: 'no_trustline' };
  }
  if (balance.is_authorized === false) {
    return { ready: false, reason: 'not_authorized' };
  }
  return { ready: true };
}

/**
 * Parses a Horizon submitTransaction rejection to see whether it failed for
 * one of the destination-related reasons the claimable-balance fallback
 * exists to handle. Returns null for anything else (insufficient balance,
 * timeout, sequence errors, ...) so those keep going through the normal DLQ.
 */
export function classifyDestinationFailure(err: unknown): PreflightReason | null {
  if (!err || typeof err !== 'object') return null;
  const withResponse = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
  const resultCodes = withResponse.response?.data?.extras?.result_codes;
  const codes = extractOperationCodes(resultCodes);
  if (codes.includes('op_no_destination')) return 'account_not_found';
  if (codes.includes('op_no_trust')) return 'no_trustline';
  if (codes.includes('op_not_authorized')) return 'not_authorized';

  // Fall back to scanning the raw message for the same codes — some SDK
  // versions surface them only in a formatted error string.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('op_no_destination')) return 'account_not_found';
  if (message.includes('op_no_trust')) return 'no_trustline';
  if (message.includes('op_not_authorized')) return 'not_authorized';
  return null;
}

function extractOperationCodes(resultCodes: unknown): string[] {
  if (!resultCodes || typeof resultCodes !== 'object') return [];
  const operations = (resultCodes as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  return operations.filter((code): code is string => typeof code === 'string');
}

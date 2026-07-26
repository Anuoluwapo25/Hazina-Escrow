import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { domainMetrics } from '../common/datadog';
import { HORIZON_URL, getTokenByCode } from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { parsePositiveInt } from '../common/env';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const stellarBreaker = getCircuitBreaker('stellar-horizon', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000, // 60 s
});

// Configurable via env; read per-call so tests can override it after module load
const getStellarTimeoutMs = () => parsePositiveInt(process.env.STELLAR_TIMEOUT_MS, 10000);

interface VerifyParams {
  txHash: string;
  expectedAmount: number;
  destinationAddress: string;
  tokenCode: string; // USDC | EURC | XLM
}

interface VerifyResult {
  valid: boolean;
  reason?: string;
  actualAmount?: number;
  memo?: string;
}

/**
 * Runs `fn` with a hard deadline of `timeoutMs` milliseconds.
 * Throws a user-friendly StellarTimeoutError if the deadline is exceeded.
 */
async function withStellarTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new StellarTimeoutError(timeoutMs));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class StellarTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Stellar Horizon did not respond within ${timeoutMs / 1000} seconds. ` +
        'The payment network may be congested — please try again shortly.',
    );
    this.name = 'StellarTimeoutError';
  }
}

/**
 * Marker class for errors whose message is safe to forward to the client as-is.
 * Only throw this for messages written by us — never wrap a raw SDK or library error.
 */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}

async function withHorizonRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const is404 =
        err &&
        typeof err === 'object' &&
        'response' in err &&
        (err as { response?: { status?: number } }).response?.status === 404;
      if (is404 && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1_000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

function getTokenIssuer(tokenCode: string): string | null {
  const token = getTokenByCode(tokenCode);
  return token?.issuer || null;
}

export async function verifyStellarPayment(params: VerifyParams): Promise<VerifyResult> {
  const { txHash, expectedAmount, destinationAddress, tokenCode } = params;

  const expectedIssuer = getTokenIssuer(tokenCode);
  if (!getTokenByCode(tokenCode)) {
    return { valid: false, reason: `Unsupported token: ${tokenCode}` };
  }

  try {
    const [tx, ops] = await withStellarTimeout(
      () =>
        withHorizonRetry(() =>
          stellarBreaker.execute(() =>
            Promise.all([
              server.transactions().transaction(txHash).call(),
              server.operations().forTransaction(txHash).call(),
            ]),
          ),
        ),
      getStellarTimeoutMs(),
    );

    const paymentOps = ops.records.filter(
      op =>
        op.type === 'payment' &&
        (op as StellarSdk.Horizon.ServerApi.PaymentOperationRecord).to === destinationAddress,
    );

    if (paymentOps.length === 0) {
      domainMetrics.stellarPaymentVerified({
        datasetType: 'unknown',
        mode: 'real',
        status: 'failed',
        reason: 'no_payment_found',
      });
      return { valid: false, reason: 'No payment to escrow address found in transaction' };
    }

    // For XLM (native), check asset_type === 'native'
    // For USDC/EURC (tokens), match both asset_code and issuer
    const matchingOps = paymentOps.filter(op => {
      const payOp = op as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;

      if (tokenCode === 'XLM') {
        return payOp.asset_type === 'native';
      }

      return payOp.asset_code === tokenCode && payOp.asset_issuer === expectedIssuer;
    });

    if (matchingOps.length === 0) {
      domainMetrics.stellarPaymentVerified({
        datasetType: 'unknown',
        mode: 'real',
        status: 'failed',
        reason: `no_${tokenCode.toLowerCase()}_found`,
      });
      return {
        valid: false,
        reason: `No ${tokenCode} payment found — ensure you sent ${tokenCode} on Stellar testnet`,
      };
    }

    const payOp = matchingOps[0] as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;
    const actualAmount = parseFloat(payOp.amount);
    const tolerance = 0.001; // 0.001 token tolerance

    if (Math.abs(actualAmount - expectedAmount) > tolerance) {
      domainMetrics.stellarPaymentVerified({
        datasetType: 'unknown',
        mode: 'real',
        status: 'failed',
        reason: 'amount_mismatch',
      });
      return {
        valid: false,
        reason: `Amount mismatch: expected ${expectedAmount} ${tokenCode}, received ${actualAmount} ${tokenCode}`,
        actualAmount,
      };
    }

    // Check not too old (5 minute window)
    const txTime = new Date(tx.created_at).getTime();
    const now = Date.now();
    if (now - txTime > 300_000) {
      domainMetrics.stellarPaymentVerified({
        datasetType: 'unknown',
        mode: 'real',
        status: 'failed',
        reason: 'transaction_expired',
      });
      return { valid: false, reason: 'Transaction expired (older than 5 minutes)' };
    }

    // Log successful verification
    domainMetrics.stellarPaymentVerified({
      datasetType: 'unknown',
      mode: 'real',
      status: 'verified',
    });

    return {
      valid: true,
      actualAmount,
      memo: tx.memo || '',
    };
  } catch (err: unknown) {
    if (err instanceof StellarTimeoutError) {
      domainMetrics.stellarTimeout({ method: 'transaction' });
      throw err; // propagate the user-friendly timeout error as-is
    }
    if (err && typeof err === 'object' && 'response' in err) {
      const httpErr = err as { response?: { status?: number } };
      if (httpErr.response?.status === 404) {
        domainMetrics.stellarPaymentVerified({
          datasetType: 'unknown',
          mode: 'real',
          status: 'failed',
          reason: 'transaction_not_found',
        });
        return { valid: false, reason: 'Transaction not found on Stellar testnet' };
      }
    }
    // Log the full SDK error server-side but never forward it to the client —
    // Stellar errors can contain sequence numbers, account IDs, and other internals.
    logger.error(
      `[Stellar] Unexpected Horizon error: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new Error('Stellar network error — please try again shortly');
  }
}

import { v4 as uuidv4 } from 'uuid';
import {
  addPayoutFailure,
  getPendingPayoutFailures,
  getPayoutFailureByBuyerTxHash,
  getPayoutFailuresByStatus,
  type PayoutFailure,
  type PayoutFailureStatus,
  updatePayoutFailure,
} from '../common/storage';
import { sendTokenPayment } from '../agent/agent.wallet';
import { notifySeller } from '../webhooks/webhook.service';
import { logger } from '../lib/logger';

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
const MANUAL_REVIEW_RETRY_COUNT = RETRY_BACKOFF_MS.length;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function getRetryDelayMs(retryCount: number): number | null {
  return RETRY_BACKOFF_MS[retryCount] ?? null;
}

export async function getManualReviewPayouts(): Promise<PayoutFailure[]> {
  return getPayoutFailuresByStatus('manual_review_needed');
}

export async function getPayoutStatusByBuyerTxHash(
  buyerTxHash: string,
): Promise<PayoutFailureStatus | null> {
  return (await getPayoutFailureByBuyerTxHash(buyerTxHash))?.status ?? null;
}

export async function recordPayoutFailure(params: {
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  intendedAmount: number;
  paymentToken?: string;
  error: string;
}): Promise<PayoutFailure> {
  const existing = await getPayoutFailureByBuyerTxHash(params.buyerTxHash);
  const nowIso = new Date().toISOString();
  if (existing) {
    const updated = await updatePayoutFailure(existing.id, {
      status: 'pending_retry',
      lastError: params.error,
      updatedAt: nowIso,
      nextRetryAt: nowIso,
    });
    scheduleRetrySweep(100);
    return updated ?? existing;
  }

  const failure: PayoutFailure = {
    id: `payout-failure-${uuidv4()}`,
    datasetId: params.datasetId,
    sellerWallet: params.sellerWallet,
    buyerTxHash: params.buyerTxHash,
    intendedAmount: params.intendedAmount,
    paymentToken: params.paymentToken || 'USDC',
    status: 'pending_retry',
    retryCount: 0,
    nextRetryAt: nowIso,
    lastError: params.error,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await addPayoutFailure(failure);
  notifySeller(params.sellerWallet, 'payment.received', {
    delayed: true,
    reason: params.error,
    buyerTxHash: params.buyerTxHash,
    intendedAmount: params.intendedAmount,
    paymentToken: failure.paymentToken,
  }).catch(() => {});
  scheduleRetrySweep(100);
  return failure;
}

async function attemptRetry(failure: PayoutFailure): Promise<void> {
  try {
    // Retry in the token the buyer originally paid in, not whatever is default today
    const payment = await sendTokenPayment({
      destinationAddress: failure.sellerWallet,
      amount: failure.intendedAmount.toFixed(7),
      memo: `hazina-retry-${failure.datasetId.slice(0, 8)}`,
      tokenCode: failure.paymentToken || 'USDC',
    });

    await updatePayoutFailure(failure.id, {
      status: 'paid',
      sellerTxHash: payment.txHash,
      updatedAt: new Date().toISOString(),
    });

    notifySeller(failure.sellerWallet, 'payment.forwarded', {
      datasetId: failure.datasetId,
      sellerTxHash: payment.txHash,
      amount: failure.intendedAmount,
      paymentToken: payment.tokenCode,
      retried: true,
    }).catch(() => {});
    return;
  } catch (err) {
    const retryCount = failure.retryCount + 1;
    const nextDelayMs = getRetryDelayMs(retryCount);
    const now = Date.now();

    if (nextDelayMs === null || retryCount >= MANUAL_REVIEW_RETRY_COUNT) {
      await updatePayoutFailure(failure.id, {
        retryCount,
        status: 'manual_review_needed',
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(now).toISOString(),
      });

      notifySeller(failure.sellerWallet, 'payment.received', {
        manualReviewNeeded: true,
        buyerTxHash: failure.buyerTxHash,
        intendedAmount: failure.intendedAmount,
        paymentToken: failure.paymentToken,
      }).catch(() => {});
      return;
    }

    await updatePayoutFailure(failure.id, {
      retryCount,
      status: 'pending_retry',
      nextRetryAt: new Date(now + nextDelayMs).toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
      updatedAt: new Date(now).toISOString(),
    });
  }
}

export async function runDuePayoutRetries(): Promise<number> {
  const due = await getPendingPayoutFailures(new Date().toISOString());
  for (const failure of due) {
    await attemptRetry(failure);
  }
  if (due.length > 0) {
    scheduleRetrySweep(1_000);
  }
  return due.length;
}

export function scheduleRetrySweep(delayMs = 1_000): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
  }
  retryTimer = setTimeout(() => {
    runDuePayoutRetries().catch(err => {
      logger.error('[Escrow] payout retry sweep failed:', err);
    });
  }, delayMs);
}

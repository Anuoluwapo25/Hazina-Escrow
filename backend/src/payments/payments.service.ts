import { v4 as uuidv4 } from 'uuid';
import { sellerShare, platformFee as computePlatformFee } from '../common/constants';
import { generateDataSummary } from '../ai/claude.service';
import { notifySeller } from '../webhooks/webhook.service';
import { transactionEventEmitter } from '../websocket/transaction-events';
import { domainMetrics } from '../common/datadog';
import { verifyStellarPayment, PaymentError } from './stellar.service';
import { getEscrow, refundEscrow } from '../lib/escrow.client';
import { sendTokenPayment } from '../agent/agent.wallet';
import { logger } from '../lib/logger';
import {
  getDataset,
  getTransactionByHash,
  updateTransactionByHash,
  addTransaction,
  getTransactionByMemo,
  updateTransactionByMemo,
  getTransactionsWithFailedSellerNotification,
  updateDataset,
} from '../common/storage';
import type { Dataset } from '../common/storage';
import { Sentry } from '../common/sentry';
import { sendSellerNotificationEmail } from '../notifications/email.service';
import { recordDatasetSnapshot } from '../snapshots/snapshots.service';
import { getReceiptAnchorMode, storeReceipt } from '../receipts/receipt.service';

export interface DeliveryResult {
  success: boolean;
  pendingDelivery?: boolean;
  warning?: string | null;
  data?: Record<string, unknown>;
  receipt?: {
    id: string;
    receiptHash: string;
    leafHash: string;
    anchorMode: string;
    anchorStatus: string;
    deliveredAt: string;
  };
  ai?: {
    summary: string;
    answer?: string;
  };
  transaction: {
    hash: string;
    status: 'completed' | 'delivery_failed' | 'verified' | 'pending' | 'refunded';
    deliveryStatus: 'delivered' | 'failed' | 'pending' | 'refunded' | 'manual_review_needed';
    amount: number;
    sellerReceived: number;
    platformFee: number;
    deliveryError?: string;
  };
}

/**
 * Delivery retries are bounded — unlike the legacy custodial seller-payout
 * retry (payout-retry.service.ts), which keeps a failed payout in
 * 'manual_review_needed' forever, a buyer's payment must not stay stuck
 * indefinitely behind a delivery that can never succeed (bad dataset data, a
 * revoked API key, ...). After this many failed delivery attempts we resolve
 * the purchase instead of retrying forever: refund an escrow-backed buyer
 * on-chain, or refund a custodial buyer directly; if the refund itself fails,
 * escalate to manual review. Matches the 3-attempt shape of
 * payout-retry.service.ts's RETRY_BACKOFF_MS.
 */
const MAX_ESCROW_DELIVERY_ATTEMPTS = 3;
const MAX_CUSTODIAL_DELIVERY_ATTEMPTS = 3;

export async function deliverVerifiedPayment(params: {
  transactionId: string;
  txHash: string;
  datasetId: string;
  buyerQuestion?: string;
}): Promise<DeliveryResult> {
  const { transactionId, txHash, datasetId, buyerQuestion } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new Error('Dataset not found');
  }

  const summaryResult = await generateDataSummary(dataset.data, buyerQuestion);
  const sellerAmount = sellerShare(dataset.pricePerQuery);
  const platformFee = computePlatformFee(dataset.pricePerQuery);

  // Pin the exact snapshot this buyer was served (#600). Without it a later
  // refresh overwrites the row and nobody can reconstruct what was sold; with
  // it the purchase stays auditable and compaction is forbidden from ever
  // deleting that snapshot. History must never block a delivery, so a failure
  // here is logged and the sale proceeds.
  let snapshotId: string | undefined;
  try {
    const recorded = await recordDatasetSnapshot(dataset.id, dataset.data);
    snapshotId = recorded.snapshot.id;
  } catch (snapshotErr) {
    logger.error(
      `[Escrow] Could not pin snapshot for txHash=${txHash} dataset=${dataset.id}: ${
        snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)
      }`,
    );
  }

  await updateDataset(dataset.id, {
    queriesServed: dataset.queriesServed + 1,
    totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
  });

  await updateTransactionByHash(txHash, {
    status: 'completed',
    deliveryStatus: 'delivered',
    deliveryError: undefined,
    deliveredAt: new Date().toISOString(),
    aiSummary: summaryResult.summary,
    sellerPaid: true,
    sellerAmount,
    snapshotId,
  });

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'completed', {
    amount: dataset.pricePerQuery.toString(),
    aiSummary: summaryResult.summary,
    deliveryStatus: 'delivered',
  });

  // Notify seller via webhook. Failures are recorded on the transaction for
  // the retry worker to pick up — never silently dropped.
  notifySeller(dataset.sellerWallet, 'payment.received', {
    datasetId: dataset.id,
    datasetName: dataset.name,
    txHash,
    amount: dataset.pricePerQuery,
    paymentToken: dataset.paymentToken || 'USDC',
    buyerQuery: buyerQuestion,
  })
    .then(() => {
      void updateTransactionByHash(txHash, {
        sellerNotifiedAt: new Date().toISOString(),
        sellerNotificationError: undefined,
      });
    })
    .catch((notifyErr: unknown) => {
      const errMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      const attempts = 1; // first attempt; incremented on each retry
      void updateTransactionByHash(txHash, {
        sellerNotificationError: errMsg,
        sellerNotificationAttempts: attempts,
      });
      console.error(
        `[Escrow] Seller notification failed for txHash=${txHash} dataset=${dataset.id}: ${errMsg}`,
      );
      Sentry.captureException(notifyErr, {
        tags: { component: 'seller-notification' },
        extra: { txHash, datasetId: dataset.id, sellerWallet: dataset.sellerWallet },
      });
    });

  if (dataset.notificationEmail) {
    void sendSellerNotificationEmail({
      to: dataset.notificationEmail,
      datasetName: dataset.name,
      amount: dataset.pricePerQuery,
      sellerAmount,
      txHash,
      timestamp: new Date().toISOString(),
      paymentToken: dataset.paymentToken || 'USDC',
    }).catch((emailError: unknown) => {
      console.error(
        `[Escrow] Seller email notification failed for txHash=${txHash} dataset=${dataset.id}`,
      );
      Sentry.captureException(emailError, {
        tags: { component: 'seller-email-notification' },
        extra: { txHash, datasetId: dataset.id },
      });
    });
  }

  domainMetrics.datasetQueried({
    datasetType: dataset.type,
    mode: txHash.startsWith('demo-') ? 'demo' : 'real',
    source: 'buyer',
  });

  // Attach a verifiable delivery receipt committing to the exact bytes that
  // were delivered (dataset.data) plus the parties and amount. The receipt is
  // stored locally with a status of NOT_ANCHORED_YET; the anchoring worker
  // (anchor.service.ts) later writes the hash on-chain as a MEMO_HASH memo.
  // Creating the receipt must never block the delivery, so failures are logged
  // and the sale proceeds — the buyer still gets their data either way.
  let receipt: DeliveryResult['receipt'];
  try {
    const transaction = await getTransactionByHash(txHash);
    const stored = await storeReceipt({
      datasetId: dataset.id,
      buyer: transaction?.buyerWallet ?? dataset.sellerWallet,
      seller: dataset.sellerWallet,
      amount: dataset.pricePerQuery,
      paymentToken: dataset.paymentToken || 'USDC',
      txHash,
      deliveredAt: new Date().toISOString(),
      anchorMode: getReceiptAnchorMode(),
      datasetPayload: dataset.data,
    });
    receipt = {
      id: stored.id,
      receiptHash: stored.receiptHash,
      leafHash: stored.leafHash,
      anchorMode: stored.anchorMode,
      anchorStatus: stored.anchorStatus,
      deliveredAt: stored.deliveredAt,
    };
    logger.info(`[Receipt] Attached receipt ${stored.id} to tx ${txHash} (${stored.receiptHash})`);
  } catch (receiptErr) {
    logger.error(
      `[Receipt] Could not attach receipt for txHash=${txHash} dataset=${dataset.id}: ${
        receiptErr instanceof Error ? receiptErr.message : String(receiptErr)
      }`,
    );
  }

  return {
    success: true,
    data: dataset.data,
    receipt,
    ai: {
      summary: summaryResult.summary,
      answer: summaryResult.answer,
    },
    transaction: {
      hash: txHash,
      status: 'completed',
      deliveryStatus: 'delivered',
      amount: dataset.pricePerQuery,
      sellerReceived: sellerAmount,
      platformFee,
    },
  };
}

/**
 * Terminal state for a custodial delivery failure that could not be resolved
 * automatically (no buyer wallet on record, or the refund attempt itself
 * failed). Sets deliveryStatus to 'manual_review_needed' so it drops out of
 * getFailedDeliveryTransactions() and stops retrying forever — mirroring
 * payout-retry.service.ts's manual_review_needed escalation.
 */
async function markCustodialDeliveryForManualReview(params: {
  transactionId: string;
  txHash: string;
  dataset: Dataset;
  buyerQuestion?: string;
  attempts: number;
  message: string;
}): Promise<DeliveryResult> {
  const { transactionId, txHash, dataset, buyerQuestion, attempts, message } = params;

  await updateTransactionByHash(txHash, {
    status: 'delivery_failed',
    deliveryStatus: 'manual_review_needed',
    deliveryError: message,
    deliveryAttempts: attempts,
    buyerQuery: buyerQuestion,
  });

  Sentry.captureMessage(`Custodial delivery failure needs manual review — txHash=${txHash}`, {
    level: 'error',
    tags: { component: 'custodial-delivery-manual-review' },
    extra: { txHash, attempts },
  });

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'delivery_failed', {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery: buyerQuestion,
    deliveryStatus: 'manual_review_needed',
    error: message,
  });

  return {
    success: true,
    pendingDelivery: true,
    warning: 'MANUAL_REVIEW_NEEDED' as const,
    transaction: {
      hash: txHash,
      status: 'delivery_failed',
      deliveryStatus: 'manual_review_needed',
      amount: dataset.pricePerQuery,
      sellerReceived: 0,
      platformFee: 0,
      deliveryError: message,
    },
  };
}

export async function markDeliveryFailure(params: {
  transactionId: string;
  txHash: string;
  datasetId: string;
  buyerQuestion?: string;
  error: unknown;
}): Promise<DeliveryResult> {
  const { transactionId, txHash, datasetId, buyerQuestion, error } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new Error('Dataset not found');
  }

  const message = error instanceof Error ? error.message : String(error);
  const existing = await getTransactionByHash(txHash);
  const attempts = (existing?.deliveryAttempts ?? 0) + 1;

  // Escrow-backed purchase whose delivery has permanently failed: refund the
  // buyer instead of retrying forever, since (unlike the custodial demo path)
  // their funds are genuinely locked on-chain, not just a pending DB record.
  if (existing?.escrowId !== undefined && attempts >= MAX_ESCROW_DELIVERY_ATTEMPTS) {
    try {
      const refundTxHash = await refundEscrow(existing.escrowId);
      await updateTransactionByHash(txHash, {
        status: 'refunded',
        deliveryStatus: 'refunded',
        deliveryError: message,
        deliveryAttempts: attempts,
        buyerQuery: buyerQuestion,
      });

      logger.warn(
        `[Escrow] Delivery permanently failed for escrow #${existing.escrowId} after ${attempts} attempts — refunded buyer (${refundTxHash})`,
      );
      Sentry.captureMessage(
        `Escrow delivery failure exhausted retries — refunded #${existing.escrowId}`,
        {
          level: 'warning',
          tags: { component: 'escrow-delivery-refund' },
          extra: { escrowId: existing.escrowId, txHash, attempts, refundTxHash },
        },
      );

      transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'refunded', {
        amount: dataset.pricePerQuery.toString(),
        buyerQuery: buyerQuestion,
        deliveryStatus: 'failed',
        error: message,
      });

      return {
        success: true,
        transaction: {
          hash: txHash,
          status: 'refunded',
          deliveryStatus: 'refunded',
          amount: dataset.pricePerQuery,
          sellerReceived: 0,
          platformFee: 0,
          deliveryError: message,
        },
      };
    } catch (refundErr) {
      // The refund itself failed — fall through to the normal delivery_failed
      // marking below. deliveryStatus stays 'failed' so the retry sweep picks
      // this transaction up again and re-attempts the refund next pass.
      const refundErrMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
      logger.error(
        `[Escrow] Refund attempt failed for escrow #${existing.escrowId} after exhausted delivery retries: ${refundErrMsg}`,
      );
      Sentry.captureException(refundErr, {
        tags: { component: 'escrow-delivery-refund' },
        extra: { escrowId: existing.escrowId, txHash, attempts },
      });
    }
  } else if (existing?.escrowId === undefined && attempts >= MAX_CUSTODIAL_DELIVERY_ATTEMPTS) {
    // Custodial purchase whose delivery has permanently failed. The seller was
    // never paid for it (payout is now gated on delivery success — see
    // payments.router.ts), so refund the buyer directly rather than leaving
    // their payment stuck behind a delivery that will never succeed. If we
    // can't identify or reach the buyer's wallet, surface it for manual
    // review instead of silently eating the loss or retrying forever.
    const buyerWallet = existing?.buyerWallet;
    if (buyerWallet) {
      try {
        const refundPayment = await sendTokenPayment({
          destinationAddress: buyerWallet,
          amount: dataset.pricePerQuery.toFixed(7),
          memo: `hazina-refund-${dataset.id.slice(0, 10)}`,
          tokenCode: dataset.paymentToken || 'USDC',
        });
        await updateTransactionByHash(txHash, {
          status: 'refunded',
          deliveryStatus: 'refunded',
          deliveryError: message,
          deliveryAttempts: attempts,
          buyerQuery: buyerQuestion,
        });

        logger.warn(
          `[Escrow] Custodial delivery permanently failed for txHash=${txHash} after ${attempts} attempts — refunded buyer ${buyerWallet} (${refundPayment.txHash})`,
        );
        Sentry.captureMessage(
          `Custodial delivery failure exhausted retries — refunded buyer for txHash=${txHash}`,
          {
            level: 'warning',
            tags: { component: 'custodial-delivery-refund' },
            extra: { txHash, buyerWallet, attempts, refundTxHash: refundPayment.txHash },
          },
        );

        transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'refunded', {
          amount: dataset.pricePerQuery.toString(),
          buyerQuery: buyerQuestion,
          deliveryStatus: 'failed',
          error: message,
        });

        return {
          success: true,
          transaction: {
            hash: txHash,
            status: 'refunded',
            deliveryStatus: 'refunded',
            amount: dataset.pricePerQuery,
            sellerReceived: 0,
            platformFee: 0,
            deliveryError: message,
          },
        };
      } catch (refundErr) {
        const refundErrMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
        logger.error(
          `[Escrow] Refund attempt failed for custodial txHash=${txHash} after exhausted delivery retries: ${refundErrMsg}`,
        );
        return markCustodialDeliveryForManualReview({
          transactionId,
          txHash,
          dataset,
          buyerQuestion,
          attempts,
          message: `Refund failed: ${refundErrMsg}. Original delivery error: ${message}`,
        });
      }
    }

    logger.error(
      `[Escrow] Custodial delivery permanently failed for txHash=${txHash} with no buyer wallet on record — cannot auto-refund`,
    );
    return markCustodialDeliveryForManualReview({
      transactionId,
      txHash,
      dataset,
      buyerQuestion,
      attempts,
      message,
    });
  }

  await updateTransactionByHash(txHash, {
    status: 'delivery_failed',
    deliveryStatus: 'failed',
    deliveryError: message,
    deliveryAttempts: attempts,
    buyerQuery: buyerQuestion,
  });

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'delivery_failed', {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery: buyerQuestion,
    deliveryStatus: 'failed',
    error: message,
  });

  // Track delivery failure and retry attempt
  domainMetrics.paymentDeliveryFailed({
    datasetType: dataset.type,
    mode: txHash.startsWith('demo-') ? 'demo' : 'real',
    reason: message.toLowerCase().includes('ai') ? 'ai_error' : 'delivery_error',
  });

  domainMetrics.deliveryRetryAttempt({
    datasetType: dataset.type,
    mode: txHash.startsWith('demo-') ? 'demo' : 'real',
    attempt: attempts,
  });

  return {
    success: true,
    pendingDelivery: true,
    warning: 'DELIVERY_PENDING_RETRY' as const,
    transaction: {
      hash: txHash,
      status: 'delivery_failed',
      deliveryStatus: 'failed',
      amount: dataset.pricePerQuery,
      sellerReceived: sellerShare(dataset.pricePerQuery),
      platformFee: computePlatformFee(dataset.pricePerQuery),
      deliveryError: message,
    },
  };
}

export async function processPayment(params: {
  txHash: string;
  datasetId: string;
  buyerQuestion?: string;
  memo?: string;
}): Promise<DeliveryResult> {
  const { txHash, datasetId, buyerQuestion, memo } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new PaymentError('Dataset not found');
  }

  // Idempotency check
  let existing = await getTransactionByHash(txHash);
  if (!existing && memo) {
    existing = await getTransactionByMemo(memo);
  }

  if (existing && existing.status === 'completed') {
    return {
      success: true,
      transaction: {
        hash: existing.txHash,
        status: 'completed',
        deliveryStatus: 'delivered',
        amount: existing.amount,
        sellerReceived: existing.sellerAmount ?? 0,
        platformFee: computePlatformFee(existing.amount),
      },
      ai: {
        summary: existing.aiSummary ?? '',
      },
    };
  }

  const transactionId = existing?.id || `tx-${uuidv4()}`;
  const destinationAddress = process.env.ESCROW_WALLET || dataset.sellerWallet;
  const tokenCode = dataset.paymentToken || 'USDC';

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'verifying', {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery: buyerQuestion,
  });

  const verification = await verifyStellarPayment({
    txHash,
    expectedAmount: dataset.pricePerQuery,
    destinationAddress,
    tokenCode,
  });

  if (!verification.valid) {
    const mode = txHash.startsWith('demo-') ? 'demo' : 'real';
    domainMetrics.paymentVerificationError({
      mode,
      errorType: verification.reason?.toLowerCase().replace(/\s+/g, '_') || 'unknown',
    });

    transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'failed', {
      error: verification.reason || 'Stellar payment verification failed',
    });
    throw new PaymentError(verification.reason || 'Stellar payment verification failed');
  }

  // Bind the payment to this specific dataset via its memo.
  // Without this check a buyer could redirect a payment made for dataset A (using
  // its memo) to unlock dataset B if both share the same price — the memo on the
  // Stellar transaction is the only artefact that ties a payment to a purchase.
  const txMemo = verification.memo ?? '';
  if (!txMemo) {
    throw new PaymentError(
      'Payment must include the memo provided at query initiation — memo-less payments cannot be bound to a specific dataset',
    );
  }
  const memoOwner = await getTransactionByMemo(txMemo);
  if (!memoOwner) {
    throw new PaymentError(
      'Payment memo does not match any pending transaction — ensure you used the memo from your query initiation',
    );
  }
  if (memoOwner.datasetId !== datasetId) {
    throw new PaymentError(
      'Payment memo belongs to a different dataset — use the memo generated for this specific query',
    );
  }

  // Update or add transaction. buyerWallet (the payer of the verified Stellar
  // transaction) is the refund destination if delivery permanently fails.
  if (existing) {
    await updateTransactionByMemo(existing.memo || '', {
      txHash,
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      buyerWallet: verification.payerAddress,
    });
  } else {
    await addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash,
      memo,
      amount: dataset.pricePerQuery,
      status: 'verified',
      deliveryStatus: 'pending',
      sellerPaid: false,
      buyerQuery: buyerQuestion,
      buyerWallet: verification.payerAddress,
      timestamp: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      deliveryAttempts: 0,
    });
  }

  transactionEventEmitter.receivePayment(
    transactionId,
    dataset.id,
    dataset.pricePerQuery.toString(),
  );

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'delivery_pending', {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery: buyerQuestion,
    deliveryStatus: 'pending',
  });

  try {
    const response = await deliverVerifiedPayment({
      transactionId,
      txHash,
      datasetId: dataset.id,
      buyerQuestion,
    });

    transactionEventEmitter.queryDataset(transactionId, dataset.id, dataset.queriesServed + 1);

    domainMetrics.paymentVerified({
      datasetType: dataset.type,
      mode: 'real',
      status: 'delivered',
    });

    return response;
  } catch (deliveryErr) {
    logger.error(
      `[Escrow] Delivery failed — queued for retry: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`,
    );
    domainMetrics.paymentVerified({
      datasetType: dataset.type,
      mode: 'real',
      status: 'pending',
    });
    return await markDeliveryFailure({
      transactionId,
      txHash,
      datasetId: dataset.id,
      buyerQuestion,
      error: deliveryErr,
    });
  }
}

const MAX_SELLER_NOTIFICATION_ATTEMPTS = 10;

/**
 * Verify a non-custodial escrow lock on-chain and deliver the dataset.
 *
 * Unlike processPayment (which verifies a plain Horizon payment to a wallet),
 * this reads the authoritative EscrowRecord from the contract and checks that
 * the buyer genuinely locked the right amount for THIS dataset. The caller is
 * responsible for triggering the on-chain release afterwards.
 */
export async function processEscrowPayment(params: {
  escrowId: number;
  datasetId: string;
  buyerQuestion?: string;
}): Promise<DeliveryResult> {
  const { escrowId, datasetId, buyerQuestion } = params;
  const dataset = await getDataset(datasetId);
  if (!dataset) {
    throw new PaymentError('Dataset not found');
  }

  // Idempotency: an escrow id maps 1:1 to a purchase. Reuse a synthetic hash so
  // the existing hash-keyed transaction machinery (delivery retries, ratings)
  // works unchanged.
  const txHash = `escrow-${escrowId}`;
  const existing = await getTransactionByHash(txHash);
  if (existing && existing.status === 'completed') {
    return {
      success: true,
      transaction: {
        hash: existing.txHash,
        status: 'completed',
        deliveryStatus: 'delivered',
        amount: existing.amount,
        sellerReceived: existing.sellerAmount ?? sellerShare(dataset.pricePerQuery),
        platformFee: computePlatformFee(existing.amount),
      },
      ai: { summary: existing.aiSummary ?? '' },
    };
  }

  const transactionId = existing?.id || `tx-${uuidv4()}`;

  transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'verifying', {
    amount: dataset.pricePerQuery.toString(),
    buyerQuery: buyerQuestion,
  });

  // Read authoritative on-chain state.
  const escrow = await getEscrow(escrowId);

  // The escrow must be for this dataset, unspent, and for the right amount.
  if (escrow.datasetId !== dataset.id) {
    throw new PaymentError(
      `Escrow #${escrowId} was locked for a different dataset — cannot unlock this one`,
    );
  }
  if (escrow.released || escrow.refunded) {
    throw new PaymentError(`Escrow #${escrowId} is already settled`);
  }
  if (escrow.seller !== dataset.sellerWallet) {
    throw new PaymentError(`Escrow #${escrowId} seller does not match this dataset`);
  }
  const tolerance = 0.001;
  if (Math.abs(escrow.amount - dataset.pricePerQuery) > tolerance) {
    throw new PaymentError(
      `Escrow amount mismatch: locked ${escrow.amount}, expected ${dataset.pricePerQuery}`,
    );
  }

  if (existing) {
    await updateTransactionByHash(txHash, {
      status: 'verified',
      escrowId,
      verifiedAt: new Date().toISOString(),
    });
  } else {
    await addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash,
      buyerWallet: escrow.buyer,
      amount: dataset.pricePerQuery,
      paymentToken: dataset.paymentToken || 'USDC',
      status: 'verified',
      deliveryStatus: 'pending',
      sellerPaid: false,
      escrowId,
      buyerQuery: buyerQuestion,
      timestamp: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      deliveryAttempts: 0,
    });
  }

  transactionEventEmitter.receivePayment(
    transactionId,
    dataset.id,
    dataset.pricePerQuery.toString(),
  );

  try {
    const response = await deliverVerifiedPayment({
      transactionId,
      txHash,
      datasetId: dataset.id,
      buyerQuestion,
    });
    domainMetrics.paymentVerified({
      datasetType: dataset.type,
      mode: 'real',
      status: 'delivered',
    });
    return response;
  } catch (deliveryErr) {
    logger.error(
      `[Escrow] Delivery failed for escrow #${escrowId} — queued for retry: ${
        deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)
      }`,
    );
    return await markDeliveryFailure({
      transactionId,
      txHash,
      datasetId: dataset.id,
      buyerQuestion,
      error: deliveryErr,
    });
  }
}

export async function retryFailedSellerNotifications(): Promise<void> {
  const pending = await getTransactionsWithFailedSellerNotification();

  await Promise.all(
    pending.map(async tx => {
      const attempts = (tx.sellerNotificationAttempts ?? 1) + 1;
      if (attempts > MAX_SELLER_NOTIFICATION_ATTEMPTS) {
        // Exhausted retries — surface a durable alert so an operator can investigate
        console.error(
          `[Escrow] Seller notification permanently failed after ${MAX_SELLER_NOTIFICATION_ATTEMPTS} attempts ` +
            `txHash=${tx.txHash} dataset=${tx.datasetId} seller=${tx.datasetId}`,
        );
        Sentry.captureMessage(`Seller notification permanently failed: txHash=${tx.txHash}`, {
          level: 'error',
          tags: { component: 'seller-notification-dlq' },
          extra: { tx },
        });
        // Mark with a sentinel so it leaves the retry queue while staying visible
        await updateTransactionByHash(tx.txHash, {
          sellerNotificationError: `PERMANENT_FAILURE after ${MAX_SELLER_NOTIFICATION_ATTEMPTS} attempts: ${tx.sellerNotificationError}`,
          sellerNotificationAttempts: attempts,
        });
        return;
      }

      const dataset = await getDataset(tx.datasetId);
      if (!dataset) return;

      try {
        await notifySeller(dataset.sellerWallet, 'payment.received', {
          datasetId: dataset.id,
          datasetName: dataset.name,
          txHash: tx.txHash,
          amount: tx.amount,
          buyerQuery: tx.buyerQuery,
        });
        await updateTransactionByHash(tx.txHash, {
          sellerNotifiedAt: new Date().toISOString(),
          sellerNotificationError: undefined,
          sellerNotificationAttempts: attempts,
        });
        console.log(
          `[Escrow] Seller notification succeeded on retry attempt ${attempts} txHash=${tx.txHash}`,
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await updateTransactionByHash(tx.txHash, {
          sellerNotificationError: errMsg,
          sellerNotificationAttempts: attempts,
        });
        console.error(
          `[Escrow] Seller notification retry ${attempts}/${MAX_SELLER_NOTIFICATION_ATTEMPTS} failed ` +
            `txHash=${tx.txHash}: ${errMsg}`,
        );
      }
    }),
  );
}

let sellerNotificationRetryWorker: NodeJS.Timeout | null = null;

export function startSellerNotificationRetryWorker(intervalMs = 5 * 60_000): void {
  if (sellerNotificationRetryWorker) return;

  void retryFailedSellerNotifications().catch(err => {
    console.error('[Escrow] Initial seller notification retry run failed:', err);
  });

  sellerNotificationRetryWorker = setInterval(() => {
    void retryFailedSellerNotifications().catch(err => {
      console.error('[Escrow] Seller notification retry worker failed:', err);
    });
  }, intervalMs);
}

export function stopSellerNotificationRetryWorker(): void {
  if (!sellerNotificationRetryWorker) return;
  clearInterval(sellerNotificationRetryWorker);
  sellerNotificationRetryWorker = null;
}

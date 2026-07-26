import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { validateBody } from '../common/validate';
import { sellerShare, platformFee as computePlatformFee } from '../common/constants';
import { generateDataSummary } from '../ai/claude.service';
import { sanitizeUserText } from '../common/sanitize';
import { requireAdminKey } from '../common/auth.middleware';
import { transactionEventEmitter } from '../websocket/transaction-events';
import { domainMetrics } from '../common/datadog';
import { PaymentError, StellarTimeoutError } from './stellar.service';
import { logger } from '../lib/logger';
import {
  getDataset,
  updateDataset,
  addTransaction,
  getUnpaidTransactions,
  reserveTxHash,
  getFailedDeliveryTransactions,
  txHashUsed,
} from '../common/storage';
import {
  getManualReviewPayouts,
  recordPayoutFailure,
  runDuePayoutRetries,
  scheduleRetrySweep,
} from './payout-retry.service';
import { sendUsdcPayment } from '../agent/agent.wallet';
import {
  deliverVerifiedPayment,
  markDeliveryFailure,
  processPayment,
  startSellerNotificationRetryWorker,
  stopSellerNotificationRetryWorker,
} from './payments.service';

export const paymentsRouter = Router();

// Start the payout retry sweep scheduler
scheduleRetrySweep(1_000);

const verifySchema = z.object({
  txHash: z.string().min(1),
  buyerQuestion: z
    .string()
    .max(500)
    .transform(value => {
      const sanitized = sanitizeUserText(value);
      return sanitized.length > 0 ? sanitized : undefined;
    })
    .optional(),
});

const verifyDemoSchema = z.object({
  buyerQuestion: z
    .string()
    .max(500)
    .transform(value => {
      const sanitized = sanitizeUserText(value);
      return sanitized.length > 0 ? sanitized : undefined;
    })
    .optional(),
});

/**
 * @openapi
 * /api/query/{id}:
 *   post:
 *     summary: Initiate a dataset query
 *     description: Returns a 402 Payment Required response with payment instructions and memo
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       402:
 *         description: Payment Required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 x402:
 *                   type: boolean
 *                 dataset:
 *                   type: object
 *                 payment:
 *                   type: object
 *       404:
 *         description: Dataset not found
 */

/**
 * @openapi
 * /api/verify/{id}:
 *   post:
 *     summary: Verify payment and release data
 *     description: Verifies the Stellar payment transaction and releases the dataset content with an AI summary
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - txHash
 *             properties:
 *               txHash:
 *                 type: string
 *                 description: Stellar transaction hash for the buyer payment
 *               buyerQuestion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment verified and data delivered successfully
 *       202:
 *         description: Payment verified but delivery is pending retry
 *       400:
 *         description: Invalid transaction hash or payment
 *       404:
 *         description: Dataset not found
 */

/**
 * @openapi
 * /api/verify/{id}/demo:
 *   post:
 *     summary: Verify payment in demo mode (skip on-chain check)
 *     description: releases the dataset content with an AI summary without requiring a real Stellar transaction
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               buyerQuestion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Data released successfully (demo mode)
 *       404:
 *         description: Dataset not found
 */

// POST /api/query/:id — initiate query, returns 402 Payment Required
paymentsRouter.post('/query/:id', async (req: Request, res: Response) => {
  // Route requires :id, so Express guarantees this is present when matched.
  const id = req.params.id as string;

  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  const timestamp = Date.now();
  const memo = `haz-${id.slice(0, 8)}-${timestamp}`;

  const transactionId = `tx-${uuidv4()}`;
  const tokenCode = dataset.paymentToken || 'USDC';

  await addTransaction({
    id: transactionId,
    datasetId: dataset.id,
    // tx_hash is NOT NULL UNIQUE; the real hash isn't known until verification,
    // so use a placeholder unique to this transaction rather than ''  which
    // would collide across concurrent pending transactions.
    txHash: `pending-${transactionId}`,
    memo,
    amount: dataset.pricePerQuery,
    paymentToken: tokenCode,
    status: 'pending',
    deliveryStatus: 'pending',
    timestamp: new Date().toISOString(),
  });

  // x402 Payment Required response
  return res.status(402).json({
    error: 'Payment Required',
    x402: true,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      type: dataset.type,
    },
    payment: {
      paymentAddress: process.env.ESCROW_WALLET || dataset.sellerWallet,
      amount: dataset.pricePerQuery,
      currency: tokenCode,
      network: 'Stellar Testnet',
      memo,
      expiresIn: 300, // 5 minutes
      instructions: [
        `1. Open your Stellar wallet (Lobstr, StellarX, or testnet faucet)`,
        `2. Send exactly ${dataset.pricePerQuery} ${tokenCode} to the address above`,
        `3. Include memo: ${memo}`,
        `4. Submit the transaction hash below to receive your data`,
      ],
    },
  });
});

export async function retryFailedDeliveries(): Promise<void> {
  const failedTransactions = await getFailedDeliveryTransactions();

  await Promise.all(
    failedTransactions.map(async transaction => {
      try {
        await deliverVerifiedPayment({
          transactionId: transaction.id,
          txHash: transaction.txHash,
          datasetId: transaction.datasetId,
          buyerQuestion: transaction.buyerQuery,
        });
      } catch (error) {
        await markDeliveryFailure({
          transactionId: transaction.id,
          txHash: transaction.txHash,
          datasetId: transaction.datasetId,
          buyerQuestion: transaction.buyerQuery,
          error,
        });
      }
    }),
  );
}

let deliveryRetryWorker: NodeJS.Timeout | null = null;

export function startDeliveryRetryWorker(intervalMs = 60_000): void {
  if (deliveryRetryWorker) {
    return;
  }

  void retryFailedDeliveries().catch(error => {
    logger.error('[Escrow] Initial delivery retry run failed:', error);
  });

  deliveryRetryWorker = setInterval(() => {
    void retryFailedDeliveries().catch(error => {
      logger.error('[Escrow] Delivery retry worker failed:', error);
    });
  }, intervalMs);
}

export function stopDeliveryRetryWorker(): void {
  if (!deliveryRetryWorker) {
    return;
  }

  clearInterval(deliveryRetryWorker);
  deliveryRetryWorker = null;
  stopSellerNotificationRetryWorker();
}

export { startSellerNotificationRetryWorker };

// POST /api/verify/:id — verify payment on Stellar and release the dataset to the buyer
paymentsRouter.post(
  '/verify/:id',
  validateBody(verifySchema),
  async (req: Request, res: Response) => {
    const { txHash, buyerQuestion } = req.body as z.infer<typeof verifySchema>;
    // Route requires :id, so Express guarantees this is present when matched.
    const id = req.params.id as string;

    const dataset = await getDataset(id);

    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    if (await txHashUsed(txHash)) {
      return res.status(400).json({ error: 'Escrow already processed' });
    }

    const releaseReservation = reserveTxHash(txHash);
    try {
      const result = await processPayment({
        txHash,
        datasetId: dataset.id,
        buyerQuestion,
      });

      // Forward seller's share on-chain; failures enter the DLQ for retry
      const sellerAmount = sellerShare(dataset.pricePerQuery);
      try {
        const payment = await sendUsdcPayment({
          destinationAddress: dataset.sellerWallet,
          amount: sellerAmount.toFixed(7),
          memo: `hazina-${dataset.id.slice(0, 10)}`,
        });
        console.log(
          `[Escrow] Paid seller ${sellerAmount} USDC → ${dataset.sellerWallet} (${payment.txHash})`,
        );
      } catch (payErr) {
        console.warn(
          '[Escrow] Seller payment failed (data still delivered):',
          payErr instanceof Error ? payErr.message : payErr,
        );
        await recordPayoutFailure({
          datasetId: dataset.id,
          sellerWallet: dataset.sellerWallet,
          buyerTxHash: txHash,
          intendedAmount: sellerAmount,
          error: payErr instanceof Error ? payErr.message : String(payErr),
        });
      }

      if (result.pendingDelivery) {
        return res.status(202).json(result);
      }

      // result.pendingDelivery is guaranteed false here (handled above).
      return res.json({ ...result, warning: null });
    } catch (err) {
      if (err instanceof StellarTimeoutError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof PaymentError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[Verify] Unexpected error processing payment:', err);
      return res.status(500).json({ error: 'Payment verification failed — please try again' });
    } finally {
      releaseReservation();
    }
  },
);

/**
 * @openapi
 * /api/admin/payouts/stuck:
 *   get:
 *     summary: List payouts requiring manual review
 *     description: Returns seller payouts that have exhausted automatic retries. Requires admin key.
 *     responses:
 *       200:
 *         description: List of stuck payouts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payouts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Missing or invalid admin key
 */
// GET /api/admin/payouts/stuck — list payouts requiring manual review
paymentsRouter.get('/admin/payouts/stuck', requireAdminKey, (_req: Request, res: Response) => {
  return res.json({ payouts: getManualReviewPayouts() });
});

/**
 * @openapi
 * /api/admin/payouts/retry:
 *   post:
 *     summary: Trigger payout retry sweep
 *     description: Immediately runs due payout retries and reschedules the sweep. Requires admin key.
 *     responses:
 *       200:
 *         description: Retry sweep completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 processed:
 *                   type: integer
 *       401:
 *         description: Missing or invalid admin key
 */
// POST /api/admin/payouts/retry — trigger retry sweep now
paymentsRouter.post(
  '/admin/payouts/retry',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    const processed = await runDuePayoutRetries();
    scheduleRetrySweep(1_000);
    return res.json({ success: true, processed });
  },
);

// POST /api/verify/:id/demo — demo mode (skip Stellar check) for hackathon
paymentsRouter.post(
  '/verify/:id/demo',
  validateBody(verifyDemoSchema),
  async (req: Request, res: Response) => {
    const { buyerQuestion } = req.body as z.infer<typeof verifyDemoSchema>;
    // Route requires :id, so Express guarantees this is present when matched.
    const id = req.params.id as string;

    const dataset = await getDataset(id);

    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const transactionId = `tx-demo-id-${Date.now()}`; // Simplified for demo

    // Emit verifying status
    transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'verifying');

    // Emit payment received
    transactionEventEmitter.receivePayment(
      transactionId,
      dataset.id,
      dataset.pricePerQuery.toString(),
    );

    let summary = '';
    let answer: string | undefined;
    try {
      const result = await generateDataSummary(dataset.data, buyerQuestion);
      summary = result.summary;
      answer = result.answer;
    } catch (err) {
      logger.error(`Demo mode AI error: ${err instanceof Error ? err.message : String(err)}`);
      summary = 'Demo mode: AI summary unavailable. Set ANTHROPIC_API_KEY to enable.';
    }

    const sellerAmount = sellerShare(dataset.pricePerQuery);
    const platformFee = computePlatformFee(dataset.pricePerQuery);

    // Emit payment forwarded
    transactionEventEmitter.forwardPayment(
      transactionId,
      dataset.id,
      sellerAmount.toFixed(7),
      platformFee.toFixed(4),
    );

    await updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat((dataset.totalEarned + sellerAmount).toFixed(4)),
    });

    await addTransaction({
      id: transactionId,
      datasetId: dataset.id,
      txHash: `demo-${Date.now()}`,
      amount: dataset.pricePerQuery,
      status: 'completed',
      deliveryStatus: 'delivered',
      sellerPaid: true,
      sellerAmount,
      buyerQuery: buyerQuestion,
      aiSummary: summary,
      timestamp: new Date().toISOString(),
    });

    // Emit completed status
    transactionEventEmitter.updateTransactionStatus(transactionId, dataset.id, 'completed', {
      amount: dataset.pricePerQuery.toString(),
      aiSummary: summary,
    });

    domainMetrics.paymentVerified({
      datasetType: dataset.type,
      mode: 'demo',
      status: 'delivered',
    });
    domainMetrics.datasetQueried({
      datasetType: dataset.type,
      mode: 'demo',
      source: 'buyer',
    });

    return res.json({
      success: true,
      demo: true,
      data: dataset.data,
      ai: { summary, answer },
      transaction: {
        hash: `demo-${Date.now()}`,
        status: 'completed',
        deliveryStatus: 'delivered',
        amount: dataset.pricePerQuery,
        sellerReceived: parseFloat(sellerAmount.toFixed(4)),
        platformFee: parseFloat(platformFee.toFixed(4)),
      },
    });
  },
);

/**
 * @openapi
 * /api/admin/unpaid-sellers:
 *   get:
 *     summary: List unpaid seller transactions
 *     description: Returns completed transactions where the seller has not yet been paid. Requires admin key.
 *     responses:
 *       200:
 *         description: List of unpaid transactions with seller wallet info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 unpaidTransactions:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *       401:
 *         description: Missing or invalid admin key
 */
paymentsRouter.get(
  '/admin/unpaid-sellers',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    const unpaid = await getUnpaidTransactions();
    const unpaidTransactions = await Promise.all(
      unpaid.map(async transaction => {
        const dataset = await getDataset(transaction.datasetId);
        return {
          ...transaction,
          datasetName: dataset?.name ?? null,
          sellerWallet: dataset?.sellerWallet ?? null,
        };
      }),
    );

    return res.json({
      success: true,
      unpaidTransactions,
      total: unpaidTransactions.length,
    });
  },
);

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
  getManualReviewDeliveries,
  txHashUsed,
} from '../common/storage';
import type { Dataset } from '../common/storage';
import {
  getManualReviewPayouts,
  recordPayoutFailure,
  runDuePayoutRetries,
  scheduleRetrySweep,
} from './payout-retry.service';
import { checkDestinationReady, classifyDestinationFailure } from './trustline.service';
import { settleAsClaimableBalance } from './claimable.service';
import { sendTokenPayment } from '../agent/agent.wallet';
import { isEscrowContractConfigured, getEscrowContractId } from '../lib/stellar.config';
import { releaseEscrow } from '../lib/escrow.client';
import { PLATFORM_FEE_BPS } from '../common/constants';
import {
  convertDatasetPrice,
  OracleUnavailableError,
  OracleAssetCode,
} from '../providers/reflector.provider';
import {
  deliverVerifiedPayment,
  markDeliveryFailure,
  processPayment,
  processEscrowPayment,
  startSellerNotificationRetryWorker,
  stopSellerNotificationRetryWorker,
} from './payments.service';
import { getQuote } from './quote.service';

export const paymentsRouter = Router();

// Start the payout retry sweep scheduler
scheduleRetrySweep(1_000);

interface ResolvedPrice {
  amountPayment: number;
  amountPaymentFixed: string;
  decimalsPayment: number;
  expiresAt: number;
  oracle?: {
    base: string;
    quote: string;
    price: number;
    priceRaw: string;
    decimals: number;
    timestamp: number;
    ageSeconds: number;
    sourceContract: string;
    resolvedVia: string;
  };
}

async function resolveDatasetPrice(dataset: {
  pricePerQuery: number;
  priceCurrency?: 'USDC' | 'USD';
  paymentToken?: string;
}): Promise<ResolvedPrice> {
  const priceCurrency = dataset.priceCurrency ?? 'USDC';
  const paymentAsset = (dataset.paymentToken ?? 'USDC') as OracleAssetCode;
  const TOKEN_DECIMALS = 7;
  const priceFixed = BigInt(Math.round(dataset.pricePerQuery * 10 ** TOKEN_DECIMALS));

  if (priceCurrency === 'USDC' && (paymentAsset === 'USDC' || paymentAsset === 'USD')) {
    return {
      amountPayment: dataset.pricePerQuery,
      amountPaymentFixed: priceFixed.toString(),
      decimalsPayment: TOKEN_DECIMALS,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
  }

  const conversion = await convertDatasetPrice({
    priceUsd: priceFixed,
    usdDecimals: TOKEN_DECIMALS,
    paymentAsset,
    paymentDecimals: TOKEN_DECIMALS,
  });
  const displayAmount = Number(conversion.amountOut) / 10 ** TOKEN_DECIMALS;
  return {
    amountPayment: displayAmount,
    amountPaymentFixed: conversion.amountOut.toString(),
    decimalsPayment: TOKEN_DECIMALS,
    expiresAt: conversion.expiresAt,
    oracle: {
      base: conversion.price.base,
      quote: conversion.price.quote,
      price: Number(conversion.price.price) / 10 ** conversion.price.decimals,
      priceRaw: conversion.price.price.toString(),
      decimals: conversion.price.decimals,
      timestamp: conversion.price.timestamp,
      ageSeconds: conversion.price.ageSeconds,
      sourceContract: conversion.price.sourceContract,
      resolvedVia: conversion.price.resolvedVia,
    },
  };
}

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

const verifyEscrowSchema = z.object({
  escrowId: z.number().int().nonnegative(),
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
  const id = req.params.id as string;

  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  let resolved: ResolvedPrice;
  try {
    resolved = await resolveDatasetPrice(dataset);
  } catch (err) {
    if (err instanceof OracleUnavailableError) {
      return res.status(503).json({
        error: `Cannot quote: oracle unavailable`,
        oracleError: err.message,
        reason: err.reason,
      });
    }
    throw err;
  }

  const timestamp = Date.now();
  const memo = `haz-${id.slice(0, 8)}-${timestamp}`;

  const transactionId = `tx-${uuidv4()}`;
  const tokenCode = dataset.paymentToken || 'USDC';

  await addTransaction({
    id: transactionId,
    datasetId: dataset.id,
    txHash: `pending-${transactionId}`,
    memo,
    amount: resolved.amountPayment,
    paymentToken: tokenCode,
    status: 'pending',
    deliveryStatus: 'pending',
    timestamp: new Date().toISOString(),
  });

  const escrowEnabled = isEscrowContractConfigured();
  const expiresIn = Math.max(60, resolved.expiresAt - Math.floor(Date.now() / 1000));

  if (escrowEnabled) {
    return res.status(402).json({
      error: 'Payment Required',
      x402: true,
      mode: 'escrow',
      dataset: {
        id: dataset.id,
        name: dataset.name,
        type: dataset.type,
        priceCurrency: dataset.priceCurrency ?? 'USDC',
        priceListed: dataset.pricePerQuery,
      },
      payment: {
        mode: 'escrow',
        escrowContractId: getEscrowContractId(),
        amount: resolved.amountPayment,
        amountFixed: resolved.amountPaymentFixed,
        decimals: resolved.decimalsPayment,
        currency: tokenCode,
        network: 'Stellar Testnet',
        platformFeeBps: PLATFORM_FEE_BPS,
        memo,
        expiresIn,
        expiresAt: resolved.expiresAt,
        oracle: resolved.oracle ?? null,
        buildLockUrl: `/api/v1/payments/escrow/lock/build`,
        submitLockUrl: `/api/v1/payments/escrow/lock/submit`,
        instructions: [
          `1. Connect your Stellar wallet (Freighter)`,
          `2. Request the lock transaction from ${`/api/v1/payments/escrow/lock/build`} for this dataset`,
          `3. Sign it in your wallet — your ${resolved.amountPayment} ${tokenCode} is locked in the escrow contract, not a Hazina wallet`,
          `4. Submit the signed transaction; the returned escrow id proves your funds are held on-chain`,
        ],
      },
    });
  }

  return res.status(402).json({
    error: 'Payment Required',
    x402: true,
    mode: 'custodial-demo',
    dataset: {
      id: dataset.id,
      name: dataset.name,
      type: dataset.type,
      priceCurrency: dataset.priceCurrency ?? 'USDC',
      priceListed: dataset.pricePerQuery,
    },
    payment: {
      mode: 'custodial-demo',
      paymentAddress: process.env.ESCROW_WALLET || dataset.sellerWallet,
      amount: resolved.amountPayment,
      amountFixed: resolved.amountPaymentFixed,
      decimals: resolved.decimalsPayment,
      currency: tokenCode,
      network: 'Stellar Testnet',
      memo,
      expiresIn,
      expiresAt: resolved.expiresAt,
      oracle: resolved.oracle ?? null,
      instructions: [
        `NOTE: demo mode — funds route through a Hazina-controlled wallet. Set ESCROW_CONTRACT_ID for non-custodial escrow.`,
        `1. Open your Stellar wallet (Lobstr, StellarX, or testnet faucet)`,
        `2. Send exactly ${resolved.amountPayment} ${tokenCode} to the address above`,
        `3. Include memo: ${memo}`,
        `4. Submit the transaction hash below to receive your data`,
      ],
    },
  });
});

/**
 * @openapi
 * /api/query/{id}/quote:
 *   get:
 *     summary: Get a payment quote for an asset conversion
 *     description: Returns a signed quote to pay with a different Stellar asset
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: sourceAsset
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Signed quote
 *       400:
 *         description: Bad Request
 *       404:
 *         description: Dataset not found
 */
paymentsRouter.get('/query/:id/quote', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const sourceAsset = req.query.sourceAsset as string;

  if (!sourceAsset) {
    return res.status(400).json({ error: 'sourceAsset query parameter is required' });
  }

  try {
    const quote = await getQuote(id, sourceAsset);
    return res.json(quote);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: msg });
  }
});

/**
 * Pays the seller their share of a custodial (non-escrow) purchase. Called
 * only once delivery has actually succeeded — either on the buyer's initial
 * /verify/:id request, or later from retryFailedDeliveries() once a delivery
 * retry succeeds — so a seller is never paid for data the buyer never got.
 * Falls back to a claimable balance or the payout DLQ if the direct send fails.
 */
async function payoutSeller(dataset: Dataset, txHash: string): Promise<void> {
  const sellerAmount = sellerShare(dataset.pricePerQuery);
  const tokenCode = dataset.paymentToken || 'USDC';

  const preflight = await checkDestinationReady(dataset.sellerWallet, tokenCode).catch(
    // A preflight check failing (e.g. Horizon timeout) must not block the
    // payout attempt itself — fall through and let sendTokenPayment try.
    () => ({ ready: true as const }),
  );

  if (!preflight.ready) {
    console.warn(
      `[Escrow] Seller ${dataset.sellerWallet} cannot receive ${tokenCode} directly ` +
        `(${preflight.reason}) — settling as a claimable balance`,
    );
    await settleAsClaimableBalance({
      datasetId: dataset.id,
      sellerWallet: dataset.sellerWallet,
      buyerTxHash: txHash,
      amount: sellerAmount,
      tokenCode,
      notificationEmail: dataset.notificationEmail,
    });
    return;
  }

  try {
    const payment = await sendTokenPayment({
      destinationAddress: dataset.sellerWallet,
      amount: sellerAmount.toFixed(7),
      memo: `hazina-${dataset.id.slice(0, 10)}`,
      tokenCode,
    });
    console.log(
      `[Escrow] Paid seller ${sellerAmount} ${tokenCode} → ${dataset.sellerWallet} (${payment.txHash})`,
    );
  } catch (payErr) {
    console.warn(
      '[Escrow] Seller payment failed (data still delivered):',
      payErr instanceof Error ? payErr.message : payErr,
    );

    // Preflight passed but the live submit still bounced with a
    // destination-related error (stale cache, race with account
    // deletion, ...) — route to the same claimable-balance fallback
    // instead of the DLQ, since a retry would fail identically.
    const destinationFailure = classifyDestinationFailure(payErr);
    if (destinationFailure) {
      await settleAsClaimableBalance({
        datasetId: dataset.id,
        sellerWallet: dataset.sellerWallet,
        buyerTxHash: txHash,
        amount: sellerAmount,
        tokenCode,
        notificationEmail: dataset.notificationEmail,
      });
    } else {
      await recordPayoutFailure({
        datasetId: dataset.id,
        sellerWallet: dataset.sellerWallet,
        buyerTxHash: txHash,
        intendedAmount: sellerAmount,
        paymentToken: tokenCode,
        error: payErr instanceof Error ? payErr.message : String(payErr),
      });
    }
  }
}

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

        // Escrow-backed purchase: the initial /verify/:id/escrow request only
        // releases on an immediate success — a transaction that lands here
        // (delivered on a later retry) still needs its on-chain release
        // triggered, or the funds stay locked despite the buyer having data.
        if (transaction.escrowId !== undefined) {
          try {
            const releaseTx = await releaseEscrow(transaction.escrowId);
            logger.info(
              `[Escrow] Released escrow #${transaction.escrowId} on-chain after delivery retry (${releaseTx})`,
            );
          } catch (releaseErr) {
            logger.warn(
              `[Escrow] Release failed for escrow #${transaction.escrowId} after delivery retry (data delivered, funds still locked on-chain): ${
                releaseErr instanceof Error ? releaseErr.message : releaseErr
              }`,
            );
          }
        } else {
          // Custodial purchase: it wasn't paid on the initial (failed) attempt
          // since payout is now gated on delivery success — pay the seller now
          // that a retry finally delivered the data.
          const dataset = await getDataset(transaction.datasetId);
          if (dataset) {
            await payoutSeller(dataset, transaction.txHash);
          } else {
            logger.error(
              `[Escrow] Cannot pay seller for delivered txHash=${transaction.txHash} — dataset ${transaction.datasetId} no longer exists`,
            );
          }
        }
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

      if (result.pendingDelivery) {
        // Delivery failed (or is still pending manual review) — the seller
        // must NOT be paid for a purchase the buyer never received. Once
        // delivery does succeed, retryFailedDeliveries() pays the seller then.
        return res.status(202).json(result);
      }

      // Delivery succeeded — now, and only now, forward the seller's share
      // on-chain. Sellers are paid in the same token the buyer paid in;
      // failures enter the claimable-balance fallback or the payout DLQ.
      await payoutSeller(dataset, txHash);

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
 * /api/verify/{id}/escrow:
 *   post:
 *     summary: Verify an on-chain escrow lock and release data (non-custodial)
 *     description: >
 *       Confirms the buyer has locked funds in the escrow contract for this
 *       dataset, delivers the data, then releases the escrow so the contract
 *       performs the 95/5 split on-chain. No funds pass through a Hazina wallet.
 *     responses:
 *       200:
 *         description: Escrow verified, data delivered, release triggered
 *       400:
 *         description: Escrow does not match this dataset or is already settled
 *       404:
 *         description: Dataset not found
 *       503:
 *         description: Escrow contract not configured
 */
// POST /api/verify/:id/escrow — non-custodial: verify on-chain lock, deliver, release
paymentsRouter.post(
  '/verify/:id/escrow',
  validateBody(verifyEscrowSchema),
  async (req: Request, res: Response) => {
    if (!isEscrowContractConfigured()) {
      return res.status(503).json({
        error: 'Escrow contract not configured (ESCROW_CONTRACT_ID unset)',
      });
    }
    const { escrowId, buyerQuestion } = req.body as z.infer<typeof verifyEscrowSchema>;
    const id = req.params.id as string;

    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    try {
      const result = await processEscrowPayment({ escrowId, datasetId: dataset.id, buyerQuestion });

      // Data delivered — now release the escrow so the CONTRACT performs the
      // 95/5 split. If release fails, the buyer still has their data and the
      // escrow can be released later by an admin (funds remain safely on-chain).
      try {
        const releaseTx = await releaseEscrow(escrowId);
        console.log(`[Escrow] Released escrow #${escrowId} on-chain (${releaseTx})`);
      } catch (releaseErr) {
        console.warn(
          `[Escrow] Release failed for escrow #${escrowId} (data delivered, funds still locked on-chain):`,
          releaseErr instanceof Error ? releaseErr.message : releaseErr,
        );
      }

      if (result.pendingDelivery) {
        return res.status(202).json(result);
      }
      return res.json({ ...result, warning: null });
    } catch (err) {
      if (err instanceof StellarTimeoutError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof PaymentError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[Verify/Escrow] Unexpected error:', err);
      return res.status(500).json({ error: 'Escrow verification failed — please try again' });
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
 * /api/admin/deliveries/stuck:
 *   get:
 *     summary: List deliveries requiring manual review
 *     description: >
 *       Returns custodial-purchase transactions whose delivery permanently
 *       failed and could not be auto-refunded (no buyer wallet on record, or
 *       the refund attempt itself failed). Requires admin key.
 *     responses:
 *       200:
 *         description: List of stuck deliveries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deliveries:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Missing or invalid admin key
 */
// GET /api/admin/deliveries/stuck — list deliveries requiring manual review
paymentsRouter.get(
  '/admin/deliveries/stuck',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    return res.json({ deliveries: await getManualReviewDeliveries() });
  },
);

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

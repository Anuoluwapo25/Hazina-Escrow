/**
 * escrow.router.ts — Issues #546, #547, #548, #549
 *
 * HTTP surface for the non-custodial escrow flow. The buyer locks their own
 * funds into the Soroban contract from their own wallet; the backend (admin)
 * only ever assembles unsigned transactions or triggers the contract's
 * pre-programmed release/refund/resolve as admin. No user funds pass through a
 * Hazina-controlled key.
 *
 * Public (buyer) endpoints return UNSIGNED XDR for the buyer's wallet to sign:
 *   POST /escrow/lock/build      → build lock() XDR
 *   POST /escrow/lock/submit     → relay a buyer-signed lock() and return escrow_id
 *   POST /escrow/confirm/build   → build confirm_delivery() XDR
 *   POST /escrow/dispute/build   → build raise_dispute() XDR
 *   GET  /escrow/:id             → read live on-chain escrow state
 *
 * Admin endpoints (ADMIN_API_KEY) trigger admin-signed contract calls:
 *   POST /escrow/:id/release     → release() 95/5 split
 *   POST /escrow/:id/refund      → refund() 100% to buyer
 *   POST /escrow/:id/resolve     → resolve_dispute(favourBuyer)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { requireAdminKey } from '../common/auth.middleware';
import { logger } from '../lib/logger';
import { isEscrowContractConfigured } from '../lib/stellar.config';
import {
  buildLockTx,
  submitSignedLock,
  getEscrow,
  releaseEscrow,
  refundEscrow,
  resolveDispute,
  buildConfirmDeliveryTx,
  buildRaiseDisputeTx,
} from '../lib/escrow.client';
import { getDataset } from '../common/storage';

export const escrowRouter = Router();

const STELLAR_ADDRESS = z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar address');

const lockBuildSchema = z.object({
  buyer: STELLAR_ADDRESS,
  datasetId: z.string().min(1),
  amount: z.number().positive().optional(),
  expirySeconds: z.number().int().positive().max(30 * 24 * 60 * 60).optional(),
});

const lockSubmitSchema = z.object({
  signedXdr: z.string().min(1),
});

const buyerCallSchema = z.object({
  buyer: STELLAR_ADDRESS,
  escrowId: z.number().int().nonnegative(),
  evidenceHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'evidenceHash must be 32 bytes hex')
    .optional(),
});

const resolveSchema = z.object({
  favourBuyer: z.boolean(),
});

/** Guard: every escrow route needs a deployed contract. Returns 503 otherwise. */
function ensureContract(res: Response): boolean {
  if (!isEscrowContractConfigured()) {
    res.status(503).json({
      error:
        'Escrow contract not configured (ESCROW_CONTRACT_ID unset). ' +
        'The non-custodial escrow flow is unavailable; use demo mode.',
    });
    return false;
  }
  return true;
}

function reportError(res: Response, err: unknown, context: string) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[Escrow] ${context}: ${message}`);
  return res.status(502).json({ error: `Escrow ${context} failed`, detail: message });
}

// POST /escrow/lock/build — assemble an unsigned lock() XDR for the buyer to sign
escrowRouter.post(
  '/escrow/lock/build',
  validateBody(lockBuildSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer, datasetId, amount, expirySeconds } = req.body as z.infer<
      typeof lockBuildSchema
    >;

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    // Price is authoritative from the dataset; a client-supplied amount may only
    // match it (prevents a buyer under-locking for a dataset).
    const lockAmount = amount ?? dataset.pricePerQuery;
    if (Math.abs(lockAmount - dataset.pricePerQuery) > 1e-7) {
      return res.status(400).json({
        error: `Amount must equal the dataset price (${dataset.pricePerQuery})`,
      });
    }

    try {
      const { xdr, contractId } = await buildLockTx({
        buyer,
        seller: dataset.sellerWallet,
        amount: lockAmount,
        datasetId: dataset.id,
        tokenCode: dataset.paymentToken || 'USDC',
        expirySeconds,
      });
      return res.json({ success: true, xdr, contractId, amount: lockAmount });
    } catch (err) {
      return reportError(res, err, 'lock build');
    }
  },
);

// POST /escrow/lock/submit — relay a buyer-signed lock() and return the escrow id
escrowRouter.post(
  '/escrow/lock/submit',
  validateBody(lockSubmitSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { signedXdr } = req.body as z.infer<typeof lockSubmitSchema>;
    try {
      const { txHash, escrowId } = await submitSignedLock(signedXdr);
      return res.json({ success: true, txHash, escrowId });
    } catch (err) {
      return reportError(res, err, 'lock submit');
    }
  },
);

// POST /escrow/confirm/build — assemble an unsigned confirm_delivery() XDR
escrowRouter.post(
  '/escrow/confirm/build',
  validateBody(buyerCallSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer, escrowId } = req.body as z.infer<typeof buyerCallSchema>;
    try {
      const { xdr } = await buildConfirmDeliveryTx({ buyer, escrowId });
      return res.json({ success: true, xdr });
    } catch (err) {
      return reportError(res, err, 'confirm build');
    }
  },
);

// POST /escrow/dispute/build — assemble an unsigned raise_dispute() XDR
escrowRouter.post(
  '/escrow/dispute/build',
  validateBody(buyerCallSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer, escrowId, evidenceHash } = req.body as z.infer<typeof buyerCallSchema>;
    try {
      const { xdr } = await buildRaiseDisputeTx({
        buyer,
        escrowId,
        evidenceHash: evidenceHash ? Buffer.from(evidenceHash, 'hex') : undefined,
      });
      return res.json({ success: true, xdr });
    } catch (err) {
      return reportError(res, err, 'dispute build');
    }
  },
);

// GET /escrow/:id — live on-chain escrow state (#548)
escrowRouter.get('/escrow/:id', async (req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  const escrowId = Number(req.params.id);
  if (!Number.isInteger(escrowId) || escrowId < 0) {
    return res.status(400).json({ error: 'Invalid escrow id' });
  }
  try {
    const escrow = await getEscrow(escrowId);
    return res.json({ success: true, escrow });
  } catch (err) {
    return reportError(res, err, 'state read');
  }
});

// POST /escrow/:id/release — admin triggers the 95/5 split (#546)
escrowRouter.post('/escrow/:id/release', requireAdminKey, async (req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  const escrowId = Number(req.params.id);
  if (!Number.isInteger(escrowId) || escrowId < 0) {
    return res.status(400).json({ error: 'Invalid escrow id' });
  }
  try {
    const txHash = await releaseEscrow(escrowId);
    return res.json({ success: true, txHash });
  } catch (err) {
    return reportError(res, err, 'release');
  }
});

// POST /escrow/:id/refund — admin refunds 100% to buyer (#546)
escrowRouter.post('/escrow/:id/refund', requireAdminKey, async (req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  const escrowId = Number(req.params.id);
  if (!Number.isInteger(escrowId) || escrowId < 0) {
    return res.status(400).json({ error: 'Invalid escrow id' });
  }
  try {
    const txHash = await refundEscrow(escrowId);
    return res.json({ success: true, txHash });
  } catch (err) {
    return reportError(res, err, 'refund');
  }
});

// POST /escrow/:id/resolve — arbitrator resolves a dispute (#549)
escrowRouter.post(
  '/escrow/:id/resolve',
  requireAdminKey,
  validateBody(resolveSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const escrowId = Number(req.params.id);
    if (!Number.isInteger(escrowId) || escrowId < 0) {
      return res.status(400).json({ error: 'Invalid escrow id' });
    }
    const { favourBuyer } = req.body as z.infer<typeof resolveSchema>;
    try {
      const txHash = await resolveDispute(escrowId, favourBuyer);
      return res.json({ success: true, txHash, favourBuyer });
    } catch (err) {
      return reportError(res, err, 'resolve');
    }
  },
);

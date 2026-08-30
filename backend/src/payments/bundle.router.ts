/**
 * bundle.router.ts — #615
 *
 * HTTP surface for composed data bundles: a curator combines several
 * sellers' datasets into one product at one price, paid out atomically via
 * the escrow contract's `lock_multi` / `release_multi`.
 *
 *   POST /bundles                          → create a bundle (curator, wallet-owned)
 *   GET  /bundles                          → list bundles (with degraded state)
 *   GET  /bundles/:id                      → one bundle (with degraded state)
 *   POST /bundles/:id/purchase/build       → build lock_multi XDR for the buyer to sign
 *   POST /bundles/:id/purchase/submit      → relay the signed lock_multi, deliver components
 *   GET  /bundles/purchases/:purchaseId    → purchase + per-component status
 *   POST /bundles/purchases/:purchaseId/confirm/build   → build confirm_delivery XDRs (one per leg)
 *   POST /bundles/purchases/:purchaseId/confirm/submit  → relay one signed confirm_delivery
 *   GET  /bundles/dashboard/curator/:curatorWallet → curator earnings
 *   GET  /bundles/dashboard/seller/:sellerWallet   → seller's bundle earnings
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { requireCuratorMutationAuth } from '../common/auth.middleware';
import { sanitizeUserText } from '../common/sanitize';
import { logger } from '../lib/logger';
import { isEscrowContractConfigured } from '../lib/stellar.config';
import { PaymentError } from './stellar.service';
import { assertValidBundleSplit, InvalidBundleSplitError, BPS_DENOMINATOR } from './bundle.splits';
import {
  createBundleRecord,
  listBundlesWithAvailability,
  getBundleWithAvailability,
  buildBundlePurchaseLockTx,
  submitBundlePurchase,
  buildBundleConfirmTxs,
  submitBundleConfirmation,
  getBundlePurchaseDetail,
  getCuratorEarnings,
  getSellerBundleEarnings,
  getBundlesForSeller,
  BundleNotFoundError,
  BundleUnavailableError,
  BundlePurchaseNotFoundError,
  BundlePurchaseStateError,
  MAX_BUNDLE_COMPONENTS,
} from './bundle.service';
import { BundleShareMismatchError } from '../common/storage';

export const bundleRouter = Router();

// A buyer/curator wallet may be a classic G… account or a C… Soroban
// contract address (a passkey smart wallet, #587) — same convention as
// escrow.router.ts.
const STELLAR_ADDRESS = z
  .string()
  .regex(
    /^[GC][A-Z2-7]{55}$/,
    'Invalid Stellar address — expected a G… account or a C… contract address',
  );

const sanitizedText = (max: number) =>
  z
    .string()
    .transform(sanitizeUserText)
    .refine(v => v.length > 0, 'Required')
    .refine(v => v.length <= max, `Must be at most ${max} characters`);

const bundleComponentSchema = z.object({
  datasetId: z.string().trim().min(1),
  shareBps: z.number().int().positive().max(BPS_DENOMINATOR),
});

const createBundleSchema = z
  .object({
    name: sanitizedText(200),
    description: sanitizedText(2000),
    curatorWallet: STELLAR_ADDRESS,
    totalPrice: z.number().positive().max(1_000_000),
    paymentToken: z.string().trim().min(1).max(20).optional(),
    curatorFeeBps: z.number().int().min(0).max(BPS_DENOMINATOR),
    components: z.array(bundleComponentSchema).min(1).max(MAX_BUNDLE_COMPONENTS),
  })
  .superRefine((data, ctx) => {
    try {
      assertValidBundleSplit(data.components, data.curatorFeeBps);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid bundle split',
      });
    }
  });

const purchaseBuildSchema = z.object({ buyer: STELLAR_ADDRESS });
const purchaseSubmitSchema = z.object({ buyer: STELLAR_ADDRESS, signedXdr: z.string().min(1) });
const confirmBuildSchema = z.object({ buyer: STELLAR_ADDRESS });
const confirmSubmitSchema = z.object({
  escrowId: z.number().int().nonnegative(),
  signedXdr: z.string().min(1),
});

function ensureContract(res: Response): boolean {
  if (!isEscrowContractConfigured()) {
    res.status(503).json({
      error:
        'Escrow contract not configured (ESCROW_CONTRACT_ID unset). Bundles require the non-custodial escrow flow.',
    });
    return false;
  }
  return true;
}

function reportError(res: Response, err: unknown, context: string) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[Bundle] ${context}: ${message}`);

  if (
    err instanceof InvalidBundleSplitError ||
    err instanceof BundleShareMismatchError ||
    err instanceof BundlePurchaseStateError
  ) {
    return res.status(400).json({ error: message, code: err.name });
  }
  if (err instanceof BundleNotFoundError || err instanceof BundlePurchaseNotFoundError) {
    return res.status(404).json({ error: message, code: err.name });
  }
  if (err instanceof BundleUnavailableError) {
    return res.status(409).json({ error: message, code: err.name });
  }
  if (err instanceof PaymentError) {
    return res.status(400).json({ error: message });
  }
  return res.status(502).json({ error: `Bundle ${context} failed`, detail: message });
}

// POST /bundles — create a bundle (curator must own curatorWallet)
bundleRouter.post(
  '/bundles',
  requireCuratorMutationAuth,
  validateBody(createBundleSchema),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof createBundleSchema>;
    try {
      const bundle = await createBundleRecord(body);
      return res.status(201).json({ success: true, bundle });
    } catch (err) {
      return reportError(res, err, 'create');
    }
  },
);

// GET /bundles — list every bundle, annotated with degraded state
bundleRouter.get('/bundles', async (_req: Request, res: Response) => {
  try {
    const bundles = await listBundlesWithAvailability();
    return res.json({ success: true, bundles });
  } catch (err) {
    return reportError(res, err, 'list');
  }
});

// GET /bundles/dashboard/curator/:curatorWallet — curator earnings across every bundle they curate
bundleRouter.get(
  '/bundles/dashboard/curator/:curatorWallet',
  async (req: Request, res: Response) => {
    try {
      const bundles = await getCuratorEarnings(req.params.curatorWallet as string);
      return res.json({ success: true, bundles });
    } catch (err) {
      return reportError(res, err, 'curator dashboard');
    }
  },
);

// GET /bundles/dashboard/seller/:sellerWallet — which bundles include this seller's data, and what it earned
bundleRouter.get('/bundles/dashboard/seller/:sellerWallet', async (req: Request, res: Response) => {
  try {
    const sellerWallet = req.params.sellerWallet as string;
    const [bundles, earnings] = await Promise.all([
      getBundlesForSeller(sellerWallet),
      getSellerBundleEarnings(sellerWallet),
    ]);
    return res.json({ success: true, bundles, earnings });
  } catch (err) {
    return reportError(res, err, 'seller dashboard');
  }
});

// GET /bundles/purchases/:purchaseId — a purchase and every component's delivery/confirmation status
bundleRouter.get('/bundles/purchases/:purchaseId', async (req: Request, res: Response) => {
  try {
    const detail = await getBundlePurchaseDetail(req.params.purchaseId as string);
    if (!detail) return res.status(404).json({ error: 'Bundle purchase not found' });
    return res.json({ success: true, ...detail });
  } catch (err) {
    return reportError(res, err, 'purchase read');
  }
});

// POST /bundles/purchases/:purchaseId/confirm/build — build confirm_delivery XDRs for every unconfirmed leg
bundleRouter.post(
  '/bundles/purchases/:purchaseId/confirm/build',
  validateBody(confirmBuildSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer } = req.body as z.infer<typeof confirmBuildSchema>;
    try {
      const confirmations = await buildBundleConfirmTxs(req.params.purchaseId as string, buyer);
      return res.json({ success: true, confirmations });
    } catch (err) {
      return reportError(res, err, 'confirm build');
    }
  },
);

// POST /bundles/purchases/:purchaseId/confirm/submit — relay one signed confirm_delivery leg
bundleRouter.post(
  '/bundles/purchases/:purchaseId/confirm/submit',
  validateBody(confirmSubmitSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { escrowId, signedXdr } = req.body as z.infer<typeof confirmSubmitSchema>;
    try {
      const purchase = await submitBundleConfirmation(
        req.params.purchaseId as string,
        escrowId,
        signedXdr,
      );
      return res.json({ success: true, purchase });
    } catch (err) {
      return reportError(res, err, 'confirm submit');
    }
  },
);

// POST /bundles/:id/purchase/build — build the lock_multi XDR for the buyer to sign
bundleRouter.post(
  '/bundles/:id/purchase/build',
  validateBody(purchaseBuildSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer } = req.body as z.infer<typeof purchaseBuildSchema>;
    try {
      const built = await buildBundlePurchaseLockTx(req.params.id as string, buyer);
      return res.json({ success: true, ...built });
    } catch (err) {
      return reportError(res, err, 'purchase build');
    }
  },
);

// POST /bundles/:id/purchase/submit — relay the buyer-signed lock_multi and deliver
bundleRouter.post(
  '/bundles/:id/purchase/submit',
  validateBody(purchaseSubmitSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { buyer, signedXdr } = req.body as z.infer<typeof purchaseSubmitSchema>;
    try {
      const purchase = await submitBundlePurchase(req.params.id as string, buyer, signedXdr);
      return res.json({ success: true, purchase });
    } catch (err) {
      return reportError(res, err, 'purchase submit');
    }
  },
);

// GET /bundles/:id — one bundle, annotated with degraded state (must come after the more specific /bundles/... routes above)
bundleRouter.get('/bundles/:id', async (req: Request, res: Response) => {
  try {
    const bundle = await getBundleWithAvailability(req.params.id as string);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
    return res.json({ success: true, bundle });
  } catch (err) {
    return reportError(res, err, 'read');
  }
});

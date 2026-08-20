/**
 * claimable.router.ts — payout escape hatch HTTP surface (#589)
 *
 * Seller-facing:
 *   GET  /sellers/:sellerWallet/claimables   → pending claimable balances for this wallet
 *   POST /sellers/:sellerWallet/claim-tx     → unsigned (sponsor-signed only) claim XDR
 *
 * Admin-facing (ADMIN_API_KEY):
 *   GET  /admin/claimables/reclaimable       → balances past the treasury reclaim cutoff
 *   POST /admin/claimables/sweep             → sweep them back to the treasury
 *
 * The claim-tx endpoint NEVER signs on the seller's behalf — see
 * claimable.service.ts's buildSponsoredClaimTx for the signing boundary.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { requireAdminKey, requireSellerReadAuth } from '../common/auth.middleware';
import { logger } from '../lib/logger';
import {
  listClaimableBalancesForSeller,
  buildSponsoredClaimTx,
  sweepReclaimableBalances,
} from './claimable.service';
import { getClaimableBalancesForSeller, getReclaimableBalances } from '../common/storage';

export const claimableRouter = Router();

const STELLAR_ADDRESS = z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar address');
const BALANCE_ID = z.string().regex(/^[0-9a-fA-F]{8,}$/, 'Invalid claimable balance id');

const claimTxSchema = z.object({
  balanceId: BALANCE_ID,
});

function reportError(res: Response, err: unknown, context: string) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[Claimable] ${context}: ${message}`);
  return res.status(502).json({ error: `Claimable balance ${context} failed`, detail: message });
}

// GET /sellers/:sellerWallet/claimables — merge live Horizon state with our
// local record (dataset/age context) for this seller's pending balances.
claimableRouter.get(
  '/sellers/:sellerWallet/claimables',
  requireSellerReadAuth,
  async (req: Request, res: Response) => {
    const sellerWallet = req.params.sellerWallet as string;
    if (!STELLAR_ADDRESS.safeParse(sellerWallet).success) {
      return res.status(400).json({ error: 'Invalid Stellar address' });
    }

    try {
      const [horizon, local] = await Promise.all([
        listClaimableBalancesForSeller(sellerWallet),
        getClaimableBalancesForSeller(sellerWallet),
      ]);
      const localByBalanceId = new Map(local.map(cb => [cb.balanceId, cb]));

      const claimables = horizon.map(item => {
        const record = localByBalanceId.get(item.balanceId);
        return {
          balanceId: item.balanceId,
          amount: item.amount,
          assetCode: item.assetCode,
          // Horizon doesn't expose a creation timestamp on the claimable
          // balance itself — fall back to when we created it, if known.
          createdAt: record?.createdAt ?? null,
          reclaimableAt: record?.reclaimableAt ?? null,
          datasetId: record?.datasetId,
          status: record?.status ?? 'pending',
        };
      });

      return res.json({ success: true, claimables });
    } catch (err) {
      return reportError(res, err, 'listing');
    }
  },
);

// POST /sellers/:sellerWallet/claim-tx — unsigned (sponsor-signed) claim XDR
claimableRouter.post(
  '/sellers/:sellerWallet/claim-tx',
  requireSellerReadAuth,
  validateBody(claimTxSchema),
  async (req: Request, res: Response) => {
    const sellerWallet = req.params.sellerWallet as string;
    if (!STELLAR_ADDRESS.safeParse(sellerWallet).success) {
      return res.status(400).json({ error: 'Invalid Stellar address' });
    }
    const { balanceId } = req.body as z.infer<typeof claimTxSchema>;

    try {
      const { xdr } = await buildSponsoredClaimTx({ sellerWallet, balanceId });
      return res.json({ success: true, xdr });
    } catch (err) {
      return reportError(res, err, 'claim-tx build');
    }
  },
);

// GET /admin/claimables/reclaimable — balances past the treasury reclaim cutoff
claimableRouter.get(
  '/admin/claimables/reclaimable',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    try {
      const reclaimable = await getReclaimableBalances(new Date().toISOString());
      return res.json({ success: true, reclaimable });
    } catch (err) {
      return reportError(res, err, 'reclaimable listing');
    }
  },
);

// POST /admin/claimables/sweep — sweep expired balances back to the treasury
claimableRouter.post(
  '/admin/claimables/sweep',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    try {
      const result = await sweepReclaimableBalances();
      return res.json({ success: true, ...result });
    } catch (err) {
      return reportError(res, err, 'sweep');
    }
  },
);

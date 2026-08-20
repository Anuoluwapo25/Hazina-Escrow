/**
 * router.ts — Sentinel's HTTP surface.
 *
 *   GET  /solvency                → public transparency endpoint
 *   GET  /sentinel/alerts         → open alerts (admin)
 *   GET  /sentinel/alerts/all     → full alert history (admin)
 *   POST /sentinel/alerts/:id/resolve → explicit resolve (admin)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { requireAdminKey } from '../common/auth.middleware';
import { isEscrowContractConfigured } from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { createRpcEscrowReader } from './rpc';
import { computeSolvency } from './invariants/solvency';
import { resolveAlert, getOpenSentinelAlerts, getAllSentinelAlerts } from './alerts';

export const sentinelRouter = Router();

function ensureContract(res: Response): boolean {
  if (!isEscrowContractConfigured()) {
    res.status(503).json({
      error:
        'Escrow contract not configured (ESCROW_CONTRACT_ID unset) — nothing for Sentinel to watch.',
    });
    return false;
  }
  return true;
}

// GET /solvency — public. Total locked on-chain vs. total open escrow
// liability, per token, plus the ledger the figures were checked against.
sentinelRouter.get('/solvency', async (_req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  try {
    const report = await computeSolvency(createRpcEscrowReader());
    return res.json({ success: true, ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Sentinel] /solvency failed: ${message}`);
    return res.status(502).json({ error: 'Failed to compute solvency', detail: message });
  }
});

sentinelRouter.get('/sentinel/alerts', requireAdminKey, async (_req: Request, res: Response) => {
  const alerts = await getOpenSentinelAlerts();
  return res.json({ success: true, alerts });
});

sentinelRouter.get(
  '/sentinel/alerts/all',
  requireAdminKey,
  async (_req: Request, res: Response) => {
    const alerts = await getAllSentinelAlerts();
    return res.json({ success: true, alerts });
  },
);

const resolveSchema = z.object({
  resolvedBy: z.string().min(1),
});

sentinelRouter.post(
  '/sentinel/alerts/:id/resolve',
  requireAdminKey,
  validateBody(resolveSchema),
  async (req: Request, res: Response) => {
    const { resolvedBy } = req.body as z.infer<typeof resolveSchema>;
    const alert = await resolveAlert(req.params.id as string, resolvedBy);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    return res.json({ success: true, alert });
  },
);

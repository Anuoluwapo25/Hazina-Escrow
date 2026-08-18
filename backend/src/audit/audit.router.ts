import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireSellerMutationAuth } from '../common/auth.middleware';
import { validateBody } from '../common/validate';
import { auditDataset, requestAppeal, getAppeals, getAuditQueueStats, canAudit } from './auditor';
import { getDataset } from '../common/storage';
import { domainMetrics } from '../common/datadog';

export const auditRouter = Router();

auditRouter.get('/status', (_req: Request, res: Response) => {
  const stats = getAuditQueueStats();
  return res.json({
    success: true,
    queue: stats,
    canAudit: canAudit(),
  });
});

auditRouter.get('/report/:datasetId', async (req: Request, res: Response) => {
  const { datasetId } = req.params;
  if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });

  const dataset = await getDataset(datasetId);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  const ratings = dataset.ratings as Record<string, unknown> | undefined;
  const auditReport = ratings?.auditReport ?? null;

  return res.json({ success: true, auditReport });
});

const appealSchema = z.object({
  reason: z.string().max(1000).optional(),
});

auditRouter.post(
  '/appeal/:datasetId',
  requireSellerMutationAuth,
  validateBody(appealSchema),
  async (req: Request, res: Response) => {
    const { datasetId } = req.params;
    const sellerWallet = req.sellerAuth?.sellerWallet;
    if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
    if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    if (dataset.sellerWallet !== sellerWallet) {
      return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
    }

    const { reason } = req.body as z.infer<typeof appealSchema>;
    const appeal = requestAppeal(datasetId, sellerWallet, reason);
    if (!appeal) {
      return res.status(429).json({ error: 'Maximum daily appeal limit reached' });
    }

    try {
      const report = await auditDataset({
        datasetId,
        triggeredBy: 'appeal',
        sellerWallet,
      });

      appeal.completed = true;

      domainMetrics.auditAppeal({
        datasetType: dataset.type,
        status: 'completed',
      });

      return res.json({ success: true, report, appeal });
    } catch (err) {
      domainMetrics.auditAppeal({
        datasetType: dataset.type,
        status: 'denied',
      });
      throw err;
    }
  },
);

auditRouter.post(
  '/re-audit/:datasetId',
  requireSellerMutationAuth,
  async (req: Request, res: Response) => {
    const { datasetId } = req.params;
    const sellerWallet = req.sellerAuth?.sellerWallet;
    if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
    if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    if (dataset.sellerWallet !== sellerWallet) {
      return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
    }

    if (!canAudit()) {
      return res.status(429).json({ error: 'Daily audit spend cap reached' });
    }

    const report = await auditDataset({
      datasetId,
      triggeredBy: 'appeal',
      sellerWallet,
    });

    return res.json({ success: true, report });
  },
);

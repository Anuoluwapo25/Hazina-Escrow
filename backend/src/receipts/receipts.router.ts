/**
 * receipts.router.ts — public receipt verification HTTP surface.
 *
 *   GET /receipts/:id  → receipt + merkle proof + verification status (public)
 *
 * The endpoint is intentionally unauthenticated: a delivery receipt's whole
 * point is that anyone holding the id can confirm the commitment chain
 * (receipt hash, merkle proof against the anchored root, anchor status).
 * It exposes no payload bytes — only the commitment metadata — so it leaks
 * nothing about the underlying dataset.
 */
import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getReceipt, buildMerkleProof, verifyReceipt } from './receipt.service';

export const receiptsRouter = Router();

// GET /api/v1/receipts/:id — public. Resolve the receipt, attach its merkle
// proof (when anchored) and an independently-checkable verification result.
receiptsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing receipt id' });

  try {
    const receipt = await getReceipt(id);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

    const merkleProof = buildMerkleProof(receipt);
    const verification = await verifyReceipt(id);

    return res.json({
      success: true,
      receipt,
      merkleProof: merkleProof ?? undefined,
      verification,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Receipts] GET /receipts/:id failed: ${message}`);
    return res.status(502).json({ error: 'Failed to load receipt', detail: message });
  }
});

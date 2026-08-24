/**
 * access-pass.routes.ts — HTTP surface for dataset subscriptions.
 *
 * Mounted under /datasets (see main.ts) next to the datasets router:
 *   GET  /api/v1/datasets/:id/access-pass?buyer=G…   cached fail-closed read
 *   GET  /api/v1/datasets/:id/plans                  indexed plans for dataset
 *   POST /api/v1/datasets/:id/plans/define-tx        build define_plan() XDR
 *   POST /api/v1/datasets/:id/plans/subscribe-tx     build subscribe() XDR
 *   POST /api/v1/datasets/:id/plans/renew-tx         build renew() XDR
 *   POST /api/v1/datasets/:id/plans/submit           relay a wallet-signed XDR
 *
 * All writes are assembled as UNSIGNED XDR — the buyer/seller signs in their
 * own wallet and relays through /submit. No Hazina key ever touches user funds.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { logger } from '../lib/logger';
import { isAccessPassConfigured } from '../lib/stellar.config';
import {
  AccessCheckUnavailableError,
  AccessPassError,
  getPass,
  hasAccess,
  buildDefinePlanTx,
  buildRenewTx,
  buildSubscribeTx,
  submitSignedAccessTx,
} from '../lib/access-pass.client';
import { getDataset } from '../common/storage';
import { getIndexedPlans } from './access-pass.plans';

export const accessPassRouter = Router();

// Same boundary rule as the escrow router: a classic G… account (Freighter/
// Albedo) or a C… Soroban contract address (passkey smart wallet).
const STELLAR_ADDRESS = z
  .string()
  .regex(
    /^[GC][A-Z2-7]{55}$/,
    'Invalid Stellar address — expected a G… account or a C… contract address',
  );

const MAX_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const MAX_SEATS_CAP = 10_000;

const definePlanSchema = z.object({
  seller: STELLAR_ADDRESS,
  pricePerPeriod: z.number().finite().positive(),
  periodSeconds: z.number().int().positive().max(MAX_PERIOD_SECONDS),
  maxSeats: z.number().int().positive().max(MAX_SEATS_CAP),
});

const subscribeSchema = z.object({
  buyer: STELLAR_ADDRESS,
  planId: z.number().int().nonnegative(),
});

const renewSchema = z.object({
  buyer: STELLAR_ADDRESS,
});

const submitSchema = z.object({
  signedXdr: z.string().min(1),
});

/** Guard: every access-pass route needs a deployed contract. 503 otherwise. */
function ensureContract(res: Response): boolean {
  if (!isAccessPassConfigured()) {
    res.status(503).json({
      error:
        'Subscriptions not configured (ACCESS_PASS_CONTRACT_ID unset). ' +
        'The access-pass flow is unavailable on this deployment.',
    });
    return false;
  }
  return true;
}

/**
 * Fail-closed mapping: verification failures become 503 with a neutral
 * message so the UI can render its "unavailable" state and deny by default.
 */
function reportError(res: Response, err: unknown, context: string) {
  if (err instanceof AccessCheckUnavailableError) {
    return res.status(503).json({ error: err.message, code: 'ACCESS_CHECK_UNAVAILABLE' });
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[AccessPass] ${context}: ${message}`);
  // AccessPassError messages are ones we authored ourselves (see
  // access-pass.client.ts's contract panic-code mapping) and are safe to show
  // as-is with a 400 — they are client mistakes or contract business state.
  // Everything else is an infrastructure failure → 502.
  if (err instanceof AccessPassError) {
    return res.status(400).json({ error: message });
  }
  return res.status(502).json({ error: `Subscription request failed`, detail: message });
}

// GET /:id/access-pass?buyer=G… — cached has_access + optional pass details
accessPassRouter.get('/:id/access-pass', async (req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  const { id: datasetId } = req.params;
  if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });

  const rawBuyer = req.query.buyer;
  const buyer = typeof rawBuyer === 'string' ? rawBuyer.trim() : '';
  const parsed = STELLAR_ADDRESS.safeParse(buyer);
  if (!parsed.success) {
    return res.status(400).json({ error: 'buyer query parameter must be a Stellar address' });
  }

  try {
    const [access, pass] = await Promise.all([
      hasAccess(parsed.data, datasetId),
      getPass(parsed.data, datasetId),
    ]);
    return res.json({ success: true, hasAccess: access, pass });
  } catch (err) {
    return reportError(res, err, `access-pass read for ${datasetId}`);
  }
});

// GET /:id/plans — plans for this dataset from the off-chain event index
accessPassRouter.get('/:id/plans', async (req: Request, res: Response) => {
  if (!ensureContract(res)) return;
  const { id: datasetId } = req.params;
  if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
  return res.json({ success: true, plans: getIndexedPlans(datasetId) });
});

// POST /:id/plans/define-tx — assemble an unsigned define_plan() XDR for the seller
accessPassRouter.post(
  '/:id/plans/define-tx',
  validateBody(definePlanSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { id: datasetId } = req.params;
    if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
    const { seller, pricePerPeriod, periodSeconds, maxSeats } = req.body as z.infer<
      typeof definePlanSchema
    >;

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    try {
      const built = await buildDefinePlanTx({
        seller,
        datasetId,
        pricePerPeriod,
        periodSeconds,
        maxSeats,
      });
      return res.json({ success: true, ...built });
    } catch (err) {
      return reportError(res, err, 'define_plan build');
    }
  },
);

// POST /:id/plans/subscribe-tx — assemble an unsigned subscribe() XDR for the buyer
accessPassRouter.post(
  '/:id/plans/subscribe-tx',
  validateBody(subscribeSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { id: datasetId } = req.params;
    if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
    const { buyer, planId } = req.body as z.infer<typeof subscribeSchema>;

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    try {
      const built = await buildSubscribeTx({ buyer, datasetId, planId });
      return res.json({ success: true, ...built });
    } catch (err) {
      return reportError(res, err, 'subscribe build');
    }
  },
);

// POST /:id/plans/renew-tx — assemble an unsigned renew() XDR for the buyer
accessPassRouter.post(
  '/:id/plans/renew-tx',
  validateBody(renewSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { id: datasetId } = req.params;
    if (!datasetId) return res.status(400).json({ error: 'Missing dataset id' });
    const { buyer } = req.body as z.infer<typeof renewSchema>;

    const dataset = await getDataset(datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    try {
      const built = await buildRenewTx({ buyer, datasetId });
      return res.json({ success: true, ...built });
    } catch (err) {
      return reportError(res, err, 'renew build');
    }
  },
);

// POST /:id/plans/submit — relay a wallet-signed access-pass transaction
accessPassRouter.post(
  '/:id/plans/submit',
  validateBody(submitSchema),
  async (req: Request, res: Response) => {
    if (!ensureContract(res)) return;
    const { signedXdr } = req.body as z.infer<typeof submitSchema>;

    try {
      const { txHash } = await submitSignedAccessTx(signedXdr);
      return res.json({ success: true, txHash });
    } catch (err) {
      return reportError(res, err, 'submit');
    }
  },
);

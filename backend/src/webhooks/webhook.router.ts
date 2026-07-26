import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  WebhookEvent,
  addWebhook,
  getWebhookById,
  getWebhooksForSeller,
  removeWebhook,
  updateWebhook,
  getTransactionByMemo,
} from '../common/storage';
import { validateBody } from '../common/validate';
import { notifySeller, signPayload } from './webhook.service';
import {
  requireApiKey,
  requireSellerMutationAuth,
  requireSellerReadAuth,
} from '../common/auth.middleware';
import { encryptSecret } from '../common/secret-crypto';
import { processPayment } from '../payments/payments.service';
import { logger } from '../lib/logger';

/**
 * @openapi
 * components:
 *   schemas:
 *     Webhook:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         sellerWallet:
 *           type: string
 *         url:
 *           type: string
 *         events:
 *           type: array
 *           items:
 *             type: string
 *         active:
 *           type: boolean
 *         createdAt:
 *           type: string
 *           format: date-time
 */

export const webhooksRouter = Router();

const VALID_EVENTS: WebhookEvent[] = [
  'payment.received',
  'payment.forwarded',
  'dataset.queried',
  'dataset.created',
  'ping',
];

const webhookUrlField = z
  .string()
  .trim()
  .min(1, 'url is required')
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid URL format',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL must use http or https',
      });
    }
  });

const webhookEventsField = z
  .array(z.string())
  .superRefine((events, ctx) => {
    const invalid = events.filter(e => !VALID_EVENTS.includes(e as WebhookEvent));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid events: ${invalid.join(', ')}`,
      });
    }
  })
  .transform(events => events as WebhookEvent[]);

const createWebhookSchema = z.object({
  sellerWallet: z
    .string({ required_error: 'sellerWallet is required' })
    .trim()
    .min(1, 'sellerWallet is required')
    .max(200),
  url: webhookUrlField,
  secret: z.string({ required_error: 'secret is required' }).min(1, 'secret is required').max(500),
  events: webhookEventsField.optional(),
});

const updateWebhookSchema = z
  .object({
    url: webhookUrlField.optional(),
    secret: z.string().min(1, 'secret must be a non-empty string').max(500).optional(),
    events: webhookEventsField.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    data =>
      data.url !== undefined ||
      data.secret !== undefined ||
      data.events !== undefined ||
      data.active !== undefined,
    { message: 'At least one of url, secret, events, or active must be provided' },
  );

const paymentWebhookSchema = z.object({
  txHash: z.string().min(1),
  memo: z.string().min(1),
});

/**
 * @openapi
 * /api/webhooks/payment:
 *   post:
 *     summary: Receive external payment notification
 *     description: Entry point for Stellar network observers or payment processors to notify the platform of a completed payment. Requires a valid HMAC signature.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - txHash
 *               - memo
 *             properties:
 *               txHash:
 *                 type: string
 *               memo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment processed successfully
 *       401:
 *         description: Missing or invalid signature
 *       404:
 *         description: Transaction not found for memo
 */
webhooksRouter.post('/payment', async (req: Request, res: Response) => {
  const signature = req.headers['x-webhook-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('[Webhook] PAYMENT_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook configuration error' });
  }

  const bodyString = JSON.stringify(req.body);
  const expectedSignature = signPayload(bodyString, secret);

  if (signature !== expectedSignature) {
    logger.warn('[Webhook] Invalid signature received');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const { txHash, memo } = paymentWebhookSchema.parse(req.body);
    const transaction = await getTransactionByMemo(memo);

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found for memo' });
    }

    const result = await processPayment({
      txHash,
      datasetId: transaction.datasetId,
      buyerQuestion: transaction.buyerQuery,
      memo,
    });

    return res.json({
      success: true,
      message: 'Payment processed',
      delivery: result.transaction.deliveryStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Webhook] Payment processing failed: ${message}`);
    return res.status(400).json({ error: message });
  }
});

/**
 * @openapi
 * /api/webhooks:
 *   post:
 *     summary: Register a new webhook
 *     description: Subscribe a seller wallet to platform events via a webhook URL. Requires API key.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sellerWallet
 *               - url
 *               - secret
 *             properties:
 *               sellerWallet:
 *                 type: string
 *               url:
 *                 type: string
 *               secret:
 *                 type: string
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [payment.received, payment.forwarded, dataset.queried, dataset.created, ping]
 *     responses:
 *       201:
 *         description: Webhook created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 webhook:
 *                   $ref: '#/components/schemas/Webhook'
 *       400:
 *         description: Invalid request body
 */
// POST /api/webhooks — register a new webhook
webhooksRouter.post(
  '/',
  requireApiKey,
  validateBody(createWebhookSchema),
  async (req: Request, res: Response) => {
    const { sellerWallet, url, secret, events } = req.body as z.infer<typeof createWebhookSchema>;

    const webhook = {
      id: `wh-${uuidv4()}`,
      sellerWallet,
      url,
      secret: encryptSecret(secret),
      events: events ?? [],
      active: true,
      createdAt: new Date().toISOString(),
    };

    await addWebhook(webhook);

    return res.status(201).json({
      success: true,
      webhook: {
        id: webhook.id,
        sellerWallet: webhook.sellerWallet,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        createdAt: webhook.createdAt,
      },
    });
  },
);

/**
 * @openapi
 * /api/webhooks/{sellerWallet}:
 *   get:
 *     summary: List webhooks for a seller
 *     parameters:
 *       - in: path
 *         name: sellerWallet
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of webhooks (secret omitted)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 webhooks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Webhook'
 */
// GET /api/webhooks/:sellerWallet — list webhooks for a seller
// Requires shared API key (admin) OR seller JWT scoped to this wallet.
webhooksRouter.get('/:sellerWallet', requireSellerReadAuth, async (req: Request, res: Response) => {
  const { sellerWallet } = req.params;
  if (!sellerWallet) return res.status(400).json({ error: 'Missing sellerWallet' });
  const webhooks = await getWebhooksForSeller(sellerWallet);
  return res.json({
    success: true,
    webhooks: webhooks.map(({ secret: _secret, ...rest }) => rest),
  });
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   delete:
 *     summary: Remove a webhook
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook deleted
 *       404:
 *         description: Webhook not found
 */
// DELETE /api/webhooks/:id — remove a webhook
// When authenticated via seller JWT, only the owning seller may delete their webhook.
webhooksRouter.delete('/:id', requireSellerMutationAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing webhook id' });
  const webhook = await getWebhookById(id);
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  if (req.sellerAuth && req.sellerAuth.sellerWallet !== webhook.sellerWallet) {
    return res.status(403).json({ error: 'Not authorized to delete this webhook' });
  }
  await removeWebhook(id);
  return res.json({ success: true, message: 'Webhook deleted' });
});

/**
 * @openapi
 * /api/webhooks/{id}/test:
 *   post:
 *     summary: Send a test ping to a webhook
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test ping dispatched
 *       400:
 *         description: Webhook is inactive
 *       404:
 *         description: Webhook not found
 */
// POST /api/webhooks/:id/test — send a test ping event
// When authenticated via seller JWT, only the owning seller may trigger a test.
webhooksRouter.post('/:id/test', requireSellerMutationAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing webhook id' });
  const webhook = await getWebhookById(id);
  if (!webhook) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  if (req.sellerAuth && req.sellerAuth.sellerWallet !== webhook.sellerWallet) {
    return res.status(403).json({ error: 'Not authorized to test this webhook' });
  }
  if (!webhook.active) {
    return res.status(400).json({ error: 'Webhook is inactive' });
  }

  try {
    await notifySeller(webhook.sellerWallet, 'ping', {
      message: 'Test ping from Hazina Escrow',
      webhookId: webhook.id,
    });
    return res.json({ success: true, message: 'Test ping dispatched' });
  } catch {
    return res.status(500).json({ error: 'Failed to dispatch test ping' });
  }
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   patch:
 *     summary: Update a webhook
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
 *               url:
 *                 type: string
 *               secret:
 *                 type: string
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *               active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Webhook updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 webhook:
 *                   $ref: '#/components/schemas/Webhook'
 *       404:
 *         description: Webhook not found
 */
// PATCH /api/webhooks/:id — update webhook (url, secret, events, active)
// When authenticated via seller JWT, only the owning seller may update their webhook.
webhooksRouter.patch(
  '/:id',
  requireSellerMutationAuth,
  validateBody(updateWebhookSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing webhook id' });
    const webhook = await getWebhookById(id);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    if (req.sellerAuth && req.sellerAuth.sellerWallet !== webhook.sellerWallet) {
      return res.status(403).json({ error: 'Not authorized to update this webhook' });
    }

    const updates = req.body as z.infer<typeof updateWebhookSchema>;
    if (updates.secret !== undefined) {
      updates.secret = encryptSecret(updates.secret);
    }
    const updated = await updateWebhook(id, updates);
    if (!updated) {
      return res.status(500).json({ error: 'Failed to update webhook' });
    }

    const { secret: _secret, ...rest } = updated;
    return res.json({ success: true, webhook: rest });
  },
);

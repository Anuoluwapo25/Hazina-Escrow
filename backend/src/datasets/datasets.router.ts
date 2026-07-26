import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeUserText } from '../common/sanitize';
import { validateBody } from '../common/validate';
import {
  addDataset,
  getAllDatasets,
  getDataset,
  getTransactions,
  getTransactionsCount,
  getTransactionByHash,
  updateDataset,
  type Dataset,
  type Transaction,
} from '../common/storage';
import { requireSellerJwt, requireSellerMutationAuth } from '../common/auth.middleware';
import { domainMetrics } from '../common/datadog';
import { notifySeller } from '../webhooks/webhook.service';

const MAX_DATA_KB = 500;
const MAX_DATA_BYTES = MAX_DATA_KB * 1024;

const makeSanitizedTextField = (fieldName: string, maxLength: number) =>
  z
    .string()
    .transform(sanitizeUserText)
    .superRefine((value, ctx) => {
      if (value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} is required`,
        });
        return;
      }
      if (value.length > maxLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} must be at most ${maxLength} characters`,
        });
      }
    });

const dataField = z
  .union([z.string(), z.record(z.unknown())])
  .transform((val, ctx): Record<string, unknown> => {
    let parsed: unknown;
    if (typeof val === 'string') {
      try {
        parsed = JSON.parse(val);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'data must be valid JSON',
        });
        return z.NEVER;
      }
    } else {
      parsed = val;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'data must be a JSON object',
      });
      return z.NEVER;
    }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_DATA_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data exceeds ${MAX_DATA_KB} KB limit`,
      });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  });

const createDatasetSchema = z.object({
  name: makeSanitizedTextField('name', 200),
  description: makeSanitizedTextField('description', 2000),
  type: makeSanitizedTextField('type', 100),
  pricePerQuery: z.coerce.number().finite().positive(),
  paymentToken: z.enum(['USDC', 'EURC', 'XLM']).optional(),
  sellerWallet: z
    .string()
    .trim()
    .refine(StrKey.isValidEd25519PublicKey, { message: 'Invalid Stellar address' }),
  notificationEmail: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().email().max(320).optional(),
  ),
  data: dataField,
});

/**
 * @openapi
 * components:
 *   schemas:
 *     Dataset:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         type:
 *           type: string
 *         pricePerQuery:
 *           type: number
 *         sellerWallet:
 *           type: string
 *         notificationEmail:
 *           type: string
 *           format: email
 *         queriesServed:
 *           type: integer
 *         totalEarned:
 *           type: number
 *         createdAt:
 *           type: string
 *           format: date-time
 */

export const datasetsRouter = Router();

function maskSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^G[A-Z0-9]{55}$/.test(value) || /^0x[a-fA-F0-9]{40}$/.test(value)) {
      return `${value.slice(0, 6)}…${value.slice(-4)}`;
    }
    if (value.includes('@')) return value.replace(/(^.).*(@.*$)/, '$1***$2');
    return value.length > 42 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
  }
  if (Array.isArray(value)) return value.map(maskSensitiveValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskSensitiveValue(v)]),
    );
  }
  return value;
}

function getPreviewRow(data: Record<string, unknown>): Record<string, unknown> | unknown[] {
  const firstArray = Object.values(data).find(Array.isArray) as unknown[] | undefined;
  const first = firstArray?.[0] ?? data;
  return maskSensitiveValue(first) as Record<string, unknown> | unknown[];
}

function getSchemaFields(data: Record<string, unknown>): string[] {
  const preview = getPreviewRow(data);
  if (preview && typeof preview === 'object' && !Array.isArray(preview))
    return Object.keys(preview);
  return Object.keys(data);
}

function getSampleSize(data: Record<string, unknown>): number {
  const firstArray = Object.values(data).find(Array.isArray) as unknown[] | undefined;
  return firstArray?.length ?? Object.keys(data).length;
}

function withoutRawData(dataset: Dataset) {
  const { data: _data, ...meta } = dataset;
  return {
    ...meta,
    ratings: meta.ratings ?? { score: 0, count: 0 },
    priceHistory: meta.priceHistory ?? [
      { price: dataset.pricePerQuery, changedAt: dataset.createdAt },
    ],
  };
}

function toDatasetDetail(dataset: Dataset) {
  return {
    ...withoutRawData(dataset),
    metadata: {
      type: dataset.type,
      schemaFields: getSchemaFields(dataset.data),
      sampleSize: getSampleSize(dataset.data),
      lastUpdated: dataset.createdAt,
    },
    preview: getPreviewRow(dataset.data),
  };

  const { data: _data, notificationEmail: _notificationEmail, ...meta } = dataset;
  return meta;
}

function toTransactionResponse(tx: Transaction) {
  const { sellerAmount, ...rest } = tx;
  return {
    ...rest,
    ...(sellerAmount !== undefined ? { sellerReceived: sellerAmount } : {}),
  };
}

async function getSellerDashboardData(sellerWallet: string) {
  const allDatasets = await getAllDatasets();
  const sellerDatasets = allDatasets.filter(dataset => dataset.sellerWallet === sellerWallet);
  const sellerDatasetIds = new Set(sellerDatasets.map(dataset => dataset.id));
  const transactions = (await getTransactions()).filter(transaction =>
    sellerDatasetIds.has(transaction.datasetId),
  );

  return {
    datasets: sellerDatasets.map(withoutRawData),
    transactions: transactions.map(toTransactionResponse),
    stats: {
      totalDatasets: sellerDatasets.length,
      totalQueries: sellerDatasets.reduce((sum, dataset) => sum + dataset.queriesServed, 0),
      totalUsdcEarned: sellerDatasets.reduce((sum, dataset) => sum + dataset.totalEarned, 0),
      totalTransactions: transactions.length,
    },
  };
}

/**
 * @openapi
 * /api/datasets:
 *   get:
 *     summary: List datasets with pagination and filters
 *     description: Retrieve datasets excluding their raw data content, with support for pagination, searching, multi-select type filters, range filters, and sorting.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for name or description
 *       - in: query
 *         name: type
 *         schema:
 *           oneOf:
 *             - type: string
 *             - type: array
 *               items:
 *                 type: string
 *         description: Filter by one or more dataset types. Repeat the parameter or pass comma-separated values.
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *         description: Minimum price per query
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *         description: Maximum price per query
 *       - in: query
 *         name: minQueries
 *         schema:
 *           type: integer
 *         description: Minimum queries served
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [popular, price-asc, price-desc, newest]
 *           default: popular
 *         description: Sort order
 *     responses:
 *       200:
 *         description: A paginated list of datasets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dataset'
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 pageSize:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *       400:
 *         description: Invalid pagination parameters
 */

// GET /api/datasets — list datasets with pagination, filtering, and sorting
datasetsRouter.get('/', async (req: Request, res: Response) => {
  const parsedPage = Number.parseInt(req.query.page as string, 10);
  const parsedLimit = Number.parseInt(req.query.limit as string, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
  const search = ((req.query.search as string) || '').toLowerCase();
  const types = [req.query.type]
    .flat()
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
  const minPrice = req.query.minPrice === undefined ? undefined : Number(req.query.minPrice);
  const maxPrice = req.query.maxPrice === undefined ? undefined : Number(req.query.maxPrice);
  const minQueries = req.query.minQueries === undefined ? undefined : Number(req.query.minQueries);
  const sort = (req.query.sort as string) || 'popular';

  if (
    (req.query.page !== undefined && (!Number.isFinite(parsedPage) || parsedPage < 1)) ||
    (req.query.limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1))
  ) {
    return res.status(400).json({ error: 'Invalid page or limit' });
  }

  if (
    (minPrice !== undefined && (!Number.isFinite(minPrice) || minPrice < 0)) ||
    (maxPrice !== undefined && (!Number.isFinite(maxPrice) || maxPrice < 0)) ||
    (minQueries !== undefined && (!Number.isFinite(minQueries) || minQueries < 0))
  ) {
    return res.status(400).json({ error: 'Invalid filter range' });
  }

  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    return res.status(400).json({ error: 'Minimum price cannot exceed maximum price' });
  }

  let datasets = (await getAllDatasets()).map(withoutRawData);

  // Filter
  if (search) {
    datasets = datasets.filter(
      d => d.name.toLowerCase().includes(search) || d.description.toLowerCase().includes(search),
    );
  }
  if (types.length > 0) {
    const selectedTypes = new Set(types);
    datasets = datasets.filter(d => selectedTypes.has(d.type));
  }
  if (minPrice !== undefined) {
    datasets = datasets.filter(d => d.pricePerQuery >= minPrice);
  }
  if (maxPrice !== undefined) {
    datasets = datasets.filter(d => d.pricePerQuery <= maxPrice);
  }
  if (minQueries !== undefined) {
    datasets = datasets.filter(d => d.queriesServed >= minQueries);
  }

  // Sort
  datasets.sort((a, b) => {
    if (sort === 'popular') return b.queriesServed - a.queriesServed;
    if (sort === 'price-asc') return a.pricePerQuery - b.pricePerQuery;
    if (sort === 'price-desc') return b.pricePerQuery - a.pricePerQuery;
    if (sort === 'newest') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return 0;
  });

  const total = datasets.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const data = datasets.slice(start, start + limit);

  res.json({
    data,
    total,
    page,
    pageSize: limit,
    totalPages,
  });
});

/**
 * @openapi
 * /api/datasets/stats:
 *   get:
 *     summary: Get platform statistics
 *     description: Retrieve global statistics including total datasets, queries, and earnings
 *     responses:
 *       200:
 *         description: Platform statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalDatasets:
 *                       type: integer
 *                     totalQueries:
 *                       type: integer
 *                     totalUsdcEarned:
 *                       type: number
 *                     totalTransactions:
 *                       type: integer
 */
datasetsRouter.get('/stats', async (_req: Request, res: Response) => {
  const datasets = await getAllDatasets();
  const transactions = await getTransactions();
  res.json({
    success: true,
    stats: {
      totalDatasets: datasets.length,
      totalQueries: datasets.reduce((s, d) => s + d.queriesServed, 0),
      totalUsdcEarned: datasets.reduce((s, d) => s + d.totalEarned, 0),
      totalTransactions: transactions.length,
    },
  });
});

/**
 * @openapi
 * /api/datasets/seller/dashboard:
 *   get:
 *     summary: Get authenticated seller dashboard data
 *     description: Retrieve datasets, transactions, and summary stats scoped to the sellerWallet JWT claim.
 *     responses:
 *       200:
 *         description: Seller dashboard payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sellerWallet:
 *                   type: string
 *                 datasets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dataset'
 *                 stats:
 *                   type: object
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/seller/dashboard', requireSellerJwt, async (req: Request, res: Response) => {
  const sellerWallet = req.sellerAuth?.sellerWallet;
  if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

  const dashboard = await getSellerDashboardData(sellerWallet);
  return res.json({ success: true, sellerWallet, ...dashboard });
});

/**
 * @openapi
 * /api/datasets/transactions:
 *   get:
 *     summary: Get authenticated seller transactions
 *     description: Retrieve transactions scoped to the sellerWallet JWT claim.
 *     responses:
 *       200:
 *         description: List of seller transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/transactions', requireSellerJwt, async (req: Request, res: Response) => {
  const sellerWallet = req.sellerAuth?.sellerWallet;
  if (!sellerWallet) return res.status(401).json({ error: 'Invalid seller token' });

  const { transactions } = await getSellerDashboardData(sellerWallet);
  return res.json({ success: true, transactions });
});

/**
 * @openapi
 * /api/datasets/{id}:
 *   get:
 *     summary: Get dataset by ID
 *     description: Retrieve single dataset metadata by ID (excludes raw data)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dataset metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 dataset:
 *                   $ref: '#/components/schemas/Dataset'
 *       404:
 *         description: Dataset not found
 */
datasetsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing dataset id' });
  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  return res.json({ success: true, dataset: toDatasetDetail(dataset) });
});

/**
 * @openapi
 * /api/datasets/{id}/transactions:
 *   get:
 *     summary: Get dataset transactions
 *     description: Retrieve transaction history for a specific dataset
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactions:
 *                   type: array
 *                   items:
 *                     type: object
 */
datasetsRouter.get('/:id/transactions', requireSellerJwt, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing dataset id' });
  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
  if (dataset.sellerWallet !== req.sellerAuth?.sellerWallet) {
    return res.status(403).json({ error: 'Dataset does not belong to authenticated seller' });
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const transactions = await getTransactions(id, limit, offset);
  const total = await getTransactionsCount(id);

  return res.json({
    success: true,
    transactions: transactions.map(toTransactionResponse),
    total,
    limit,
    offset,
  });
});

/**
 * @openapi
 * /api/datasets/{id}/ratings:
 *   post:
 *     summary: Add a rating to a dataset
 *     description: Submit a 1-5 star rating and optional comment for a dataset, verified by transaction hash.
 */
const createRatingSchema = z.object({
  txHash: z.string().trim().min(1),
  score: z.number().int().min(1).max(5),
  comment: makeSanitizedTextField('comment', 500).optional(),
});

datasetsRouter.post(
  '/:id/ratings',
  validateBody(createRatingSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing dataset id' });
    const { txHash, score, comment } = req.body as z.infer<typeof createRatingSchema>;

    const dataset = await getDataset(id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

    const tx = await getTransactionByHash(txHash);
    if (!tx || tx.datasetId !== id) {
      return res.status(403).json({ error: 'Invalid transaction hash for this dataset' });
    }
    if (tx.deliveryStatus !== 'delivered') {
      return res.status(403).json({ error: 'Data must be delivered before rating' });
    }

    const ratings = dataset.ratings || { score: 0, count: 0, reviews: [] };
    if (ratings.reviews.some(r => r.txHash === txHash)) {
      return res.status(409).json({ error: 'Duplicate rating for this transaction' });
    }

    ratings.reviews.push({
      txHash,
      score,
      comment,
      timestamp: new Date().toISOString(),
    });

    const totalScore = ratings.reviews.reduce((sum, r) => sum + r.score, 0);
    ratings.count = ratings.reviews.length;
    ratings.score = totalScore / ratings.count;

    await updateDataset(id, { ratings });

    return res.status(201).json({ success: true, ratings });
  },
);

/**
 * @openapi
 * /api/datasets/{id}/ratings:
 *   get:
 *     summary: Get dataset ratings
 *     description: Retrieve paginated ratings and average score for a dataset.
 */
datasetsRouter.get('/:id/ratings', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing dataset id' });
  const dataset = await getDataset(id);
  if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

  const ratings = dataset.ratings || { score: 0, count: 0, reviews: [] };

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const start = (page - 1) * limit;
  const paginatedReviews = [...ratings.reviews].reverse().slice(start, start + limit);

  return res.json({
    success: true,
    score: ratings.score,
    count: ratings.count,
    reviews: paginatedReviews,
    page,
    totalPages: Math.ceil(ratings.reviews.length / limit),
  });
});

/**
 * @openapi
 * /api/datasets:
 *   post:
 *     summary: Create a new dataset
 *     description: List a new dataset on the platform
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *               - type
 *               - pricePerQuery
 *               - sellerWallet
 *               - data
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               type:
 *                 type: string
 *               pricePerQuery:
 *                 type: number
 *               sellerWallet:
 *                 type: string
 *               notificationEmail:
 *                 type: string
 *                 format: email
 *               data:
 *                 type: object
 *     responses:
 *       201:
 *         description: Dataset created successfully
 *       400:
 *         description: Missing required fields or invalid price
 */
datasetsRouter.post(
  '/',
  requireSellerMutationAuth,
  validateBody(createDatasetSchema),
  async (req: Request, res: Response) => {
    const {
      name,
      description,
      type,
      pricePerQuery,
      paymentToken,
      sellerWallet,
      notificationEmail,
      data,
    } = req.body as z.infer<typeof createDatasetSchema>;

    const now = new Date().toISOString();
    const dataset: Dataset = {
      id: `ds-${uuidv4()}`,
      name,
      description,
      type,
      pricePerQuery,
      paymentToken,
      sellerWallet,
      notificationEmail,
      data,
      queriesServed: 0,
      totalEarned: 0,
      createdAt: now,
      ratings: { score: 0, count: 0, reviews: [] },
      priceHistory: [{ price: pricePerQuery, changedAt: now }],
    };

    await addDataset(dataset);

    // Track dataset creation
    domainMetrics.datasetCreated({
      datasetType: type,
      pricePerQuery,
    });

    // Notify seller via webhook
    notifySeller(dataset.sellerWallet, 'dataset.created', {
      datasetId: dataset.id,
      datasetName: dataset.name,
      type: dataset.type,
      pricePerQuery: dataset.pricePerQuery,
    }).catch(() => {});

    const { data: _d, notificationEmail: _notificationEmail, ...meta } = dataset;
    return res.status(201).json({ success: true, dataset: meta });
  },
);

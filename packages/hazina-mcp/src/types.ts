/**
 * types.ts — response shapes for the Hazina backend REST API this server
 * wraps. Mirrors `backend/src/datasets/datasets.router.ts` and
 * `backend/src/payments/payments.router.ts` (see #593 research notes) rather
 * than re-exporting backend types directly, since this package is a
 * standalone sibling of backend/frontend (no shared workspace linking).
 */
import { z } from 'zod';

export const DatasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  category: z.string().optional(),
  pricePerQuery: z.number(),
  sellerWallet: z.string(),
  paymentToken: z.string().optional(),
  queriesServed: z.number(),
  totalEarned: z.number(),
  createdAt: z.string(),
  provider: z.string().optional(),
  live: z.boolean().optional(),
  lastRefreshedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const PaginatedDatasetsSchema = z.object({
  data: z.array(DatasetSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});
export type PaginatedDatasets = z.infer<typeof PaginatedDatasetsSchema>;

/** A single GET /api/search result — mirrors backend/src/search/search.service.ts's SearchResultItem. */
export const SearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  category: z.string().optional(),
  pricePerQuery: z.number(),
  paymentToken: z.string().optional(),
  queriesServed: z.number(),
  live: z.boolean().optional(),
  lastRefreshedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  score: z.number(),
  /** One-line reason this result matched — present when the request set explain=true. */
  matchedBecause: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** GET /api/search response — hybrid (keyword + embedding) search, mirrors backend/src/search/search.router.ts. */
export const SearchResponseSchema = z.object({
  success: z.literal(true),
  query: z.string(),
  results: z.array(SearchResultSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  mode: z.enum(['hybrid', 'keyword-only']),
  reranked: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const DatasetDetailSchema = DatasetSchema.extend({
  metadata: z.object({
    type: z.string(),
    schemaFields: z.array(z.string()),
    sampleSize: z.number(),
    lastUpdated: z.string(),
  }),
  preview: z.unknown(),
});
export type DatasetDetail = z.infer<typeof DatasetDetailSchema>;

export const GetDatasetResponseSchema = z.object({
  success: z.literal(true),
  dataset: DatasetDetailSchema,
});

/** The 402 payload returned by `POST /payments/query/:id` — a quote, not an error. */
export const QuotePayloadSchema = z.object({
  error: z.string(),
  x402: z.literal(true),
  mode: z.enum(['escrow', 'custodial-demo']),
  dataset: z.object({ id: z.string(), name: z.string(), type: z.string() }),
  payment: z.object({
    mode: z.enum(['escrow', 'custodial-demo']),
    amount: z.number(),
    currency: z.string(),
    network: z.string(),
    memo: z.string(),
    expiresIn: z.number(),
    escrowContractId: z.string().optional(),
    platformFeeBps: z.number().optional(),
    buildLockUrl: z.string().optional(),
    submitLockUrl: z.string().optional(),
    paymentAddress: z.string().optional(),
    instructions: z.array(z.string()),
  }),
});
export type QuotePayload = z.infer<typeof QuotePayloadSchema>;

export const QueryResultSchema = z.object({
  success: z.boolean(),
  demo: z.boolean().optional(),
  pendingDelivery: z.boolean().optional(),
  warning: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
  ai: z.object({ summary: z.string(), answer: z.string().optional() }).optional(),
  transaction: z.object({
    hash: z.string(),
    status: z.string(),
    deliveryStatus: z.string(),
    amount: z.number(),
    sellerReceived: z.number(),
    platformFee: z.number(),
    deliveryError: z.string().optional(),
  }),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

import { z } from 'zod';
import { getEnv } from './env';

const REQUEST_THROTTLE_MS = 250;

function getMaxConcurrentRequests(): number {
  try {
    return getEnv().maxConcurrentRequests;
  } catch {
    return 8;
  }
}

let inFlight = 0;
const inFlightWaiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < getMaxConcurrentRequests()) {
    inFlight += 1;
    return;
  }
  await new Promise<void>(resolve => inFlightWaiters.push(resolve));
  inFlight += 1;
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = inFlightWaiters.shift();
  if (next) next();
}

const requestQueues = new Map<string, Promise<void>>();
const requestStartedAt = new Map<string, number>();

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function getRequestKey(url: string, options?: RequestInit) {
  const method = (options?.method ?? 'GET').toUpperCase();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const { pathname } = new URL(url, origin);
  return `${method}:${pathname}`;
}

async function scheduleRequest<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = requestQueues.get(key) ?? Promise.resolve();

  const scheduled = previous.then(async () => {
    const lastStarted = requestStartedAt.get(key) ?? 0;
    const elapsed = Date.now() - lastStarted;

    if (elapsed < REQUEST_THROTTLE_MS) {
      await sleep(REQUEST_THROTTLE_MS - elapsed);
    }

    requestStartedAt.set(key, Date.now());
    return task();
  });

  const tracked = scheduled.then(
    () => undefined,
    () => undefined,
  );

  requestQueues.set(key, tracked);

  return scheduled.finally(() => {
    if (requestQueues.get(key) === tracked) {
      requestQueues.delete(key);
    }
  });
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000; // regular API calls should complete in 10-15 seconds
export const AGENT_REQUEST_TIMEOUT_MS = 120_000; // AI/agent operations may take longer than standard requests

function getApiBaseUrl(): string {
  const { apiUrl } = getEnv();
  return `${apiUrl}/api/v1`;
}

function getApiKey(): string {
  return getEnv().apiKey;
}

// ── Public interfaces ──────────────────────────────────────────────────────

export interface AgentSellerPayment {
  seller: string;
  type: string;
  amount: number;
  txHash: string;
  onChain: boolean;
}

export interface AgentReport {
  topOpportunity: {
    protocol: string;
    vault: string;
    chain: string;
    apy: number;
    riskLevel: string;
    whaleConfidence: string;
    sentimentScore: string;
  };
  reasoning: string;
  alternatives: string[];
  warnings: string[];
  rawAnalysis: string;
}

export interface AgentJob {
  success: boolean;
  demo?: boolean;
  jobId: string;
  query: string;
  report: AgentReport;
  payments: {
    humanPaid: number;
    currency: string;
    network: string;
    note?: string;
    sellerPayments: AgentSellerPayment[];
    totalSpent: number;
    agentProfit: number;
  };
  meta: {
    agentWallet: string;
    timestamp: string;
    datasetsQueried: number;
  };
}

export interface AgentInfo {
  success: boolean;
  agent: {
    name: string;
    version: string;
    description: string;
    agentWallet: string;
    fee: { amount: number; currency: string; network: string; description: string };
    sellers: { type: string; role: string; cost: number }[];
    agentProfit: number;
    escrowWallet: string;
  };
}

export interface SellerAnalytics {
  revenueSeries: { date: string; usdc: number }[];
  queryVolumeSeries: { date: string; count: number }[];
  datasetBreakdown: { id: string; name: string; earned: number; queries: number }[];
  topBuyers: { wallet: string; count: number }[];
}

export const DatasetMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  pricePerQuery: z.number(),
  sellerWallet: z.string().length(56),
  queriesServed: z.number(),
  totalEarned: z.number(),
  createdAt: z.string(),
  thumbnail: z.string().optional(),

  ratings: z.object({ score: z.number(), count: z.number() }).optional(),
  priceHistory: z.array(z.object({ price: z.number(), changedAt: z.string() })).optional(),
});

export const DatasetDetailSchema = DatasetMetaSchema.extend({
  metadata: z.object({
    type: z.string(),
    schemaFields: z.array(z.string()),
    sampleSize: z.number(),
    lastUpdated: z.string(),
  }),
  preview: z.unknown(),

  ratings: z
    .object({
      score: z.number(),
      count: z.number(),
      reviews: z.array(
        z.object({
          txHash: z.string(),
          score: z.number(),
          comment: z.string().optional(),
          timestamp: z.string(),
        }),
      ),
    })
    .optional(),
});
export type DatasetDetail = z.infer<typeof DatasetDetailSchema>;
export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;

export const TransactionSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  txHash: z.string(),
  amount: z.number(),
  sellerReceived: z.number().optional(),
  buyerQuery: z.string().optional(),
  aiSummary: z.string().optional(),
  timestamp: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const StatsSchema = z.object({
  totalDatasets: z.number(),
  totalQueries: z.number(),
  totalUsdcEarned: z.number(),
  totalTransactions: z.number(),
});
export type Stats = z.infer<typeof StatsSchema>;

export const PaginatedDatasetsSchema = z.object({
  data: z.array(DatasetMetaSchema),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});
export type PaginatedDatasets = z.infer<typeof PaginatedDatasetsSchema>;

export const QueryResultSchema = z.object({
  success: z.boolean(),
  demo: z.boolean().optional(),
  pendingDelivery: z.boolean().optional(),
  warning: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  ai: z.object({ summary: z.string(), answer: z.string().optional() }).optional(),
  transaction: z.object({
    hash: z.string(),
    status: z.string(),
    deliveryStatus: z.union([z.literal('pending'), z.literal('delivered'), z.literal('failed')]),
    amount: z.number(),
    sellerReceived: z.number(),
    platformFee: z.number(),
    deliveryError: z.string().optional(),
  }),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

interface RequestOptions extends RequestInit {
  /** Per-call override of the abort timeout, in milliseconds. */
  timeoutMs?: number;
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = getApiKey();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return { ...headers, ...(extra as Record<string, string>) };
}

async function fetchWithTimeout(url: string, options?: RequestOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...init } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: authHeaders(init.headers),
      ...init,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out — please try again');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Runtime response validation ────────────────────────────────────────────
// Lightweight guards that validate critical API response shapes at runtime.
// They throw a descriptive ApiValidationError when the server returns
// unexpected data, preventing silent undefined/null crashes downstream.

export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

function parseApiResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiValidationError(`Unexpected API shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ── HTTP helper ────────────────────────────────────────────────────────────

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  return scheduleRequest(getRequestKey(url, options), async () => {
    await acquireSlot();
    try {
      const res = await fetchWithTimeout(url, options);

      // Parse JSON body once. If parsing fails, we fallback to null.
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (data === null) {
        throw new Error('Invalid response from server');
      }

      // Handle business-level failures returned with 2xx status codes
      if (data && typeof data === 'object' && data.success === false) {
        throw new Error(data.error || 'API request failed');
      }

      return data as T;
    } finally {
      releaseSlot();
    }
  });
}

export const api = {
  getDatasets: (params?: {
    page?: number;
    limit?: number;
    search?: string;
    type?: string | string[];
    types?: string[];
    minPrice?: number;
    maxPrice?: number;
    minQueries?: number;
    sort?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      if (params.page) searchParams.append('page', params.page.toString());
      if (params.limit) searchParams.append('limit', params.limit.toString());
      if (params.search) searchParams.append('search', params.search);
      const typeValues = [
        ...(Array.isArray(params.type) ? params.type : params.type ? [params.type] : []),
        ...(params.types ?? []),
      ];
      typeValues.forEach(type => {
        if (type) searchParams.append('type', type);
      });
      if (params.minPrice !== undefined)
        searchParams.append('minPrice', params.minPrice.toString());
      if (params.maxPrice !== undefined)
        searchParams.append('maxPrice', params.maxPrice.toString());
      if (params.minQueries !== undefined)
        searchParams.append('minQueries', params.minQueries.toString());
      if (params.sort) searchParams.append('sort', params.sort);
    }
    const query = searchParams.toString();
    const url = `${getApiBaseUrl()}/datasets${query ? `?${query}` : ''}`;
    return request<unknown>(url).then(r => parseApiResponse(PaginatedDatasetsSchema, r));
  },

  getStats: () =>
    request<{ success: boolean; stats: unknown }>(`${getApiBaseUrl()}/datasets/stats`).then(r =>
      parseApiResponse(StatsSchema, r.stats),
    ),

  getDataset: (id: string) =>
    request<{ success: boolean; dataset: unknown }>(`${getApiBaseUrl()}/datasets/${id}`).then(r =>
      parseApiResponse(DatasetDetailSchema, r.dataset),
    ),

  getSellerAnalytics: (wallet: string) =>
    request<{ success: boolean } & SellerAnalytics>(
      `${getApiBaseUrl()}/analytics/seller/${encodeURIComponent(wallet)}`,
    ).then(r => ({
      revenueSeries: r.revenueSeries,
      queryVolumeSeries: r.queryVolumeSeries,
      datasetBreakdown: r.datasetBreakdown,
      topBuyers: r.topBuyers,
    })),

  getTransactions: (datasetId?: string) => {
    const url = datasetId
      ? `${getApiBaseUrl()}/datasets/${datasetId}/transactions`
      : `${getApiBaseUrl()}/datasets/transactions`;
    return request<{ success: boolean; transactions: unknown }>(url).then(r =>
      parseApiResponse(z.array(TransactionSchema), r.transactions),
    );
  },

  initiateQuery: (id: string) =>
    request<{ payment: { paymentAddress: string; amount: number; memo: string } }>(
      `${getApiBaseUrl()}/query/${id}`,
      { method: 'POST' },
    ),

  verifyPayment: (id: string, txHash: string, buyerQuestion?: string) =>
    request<unknown>(`${getApiBaseUrl()}/verify/${id}`, {
      method: 'POST',
      body: JSON.stringify({ txHash, buyerQuestion }),
    }).then(r => parseApiResponse(QueryResultSchema, r)),

  demoQuery: (id: string, buyerQuestion?: string) =>
    request<unknown>(`${getApiBaseUrl()}/verify/${id}/demo`, {
      method: 'POST',
      body: JSON.stringify({ buyerQuestion }),
    }).then(r => parseApiResponse(QueryResultSchema, r)),

  submitRating: (id: string, txHash: string, score: number, comment?: string) =>
    request<{ success: boolean; ratings: unknown }>(`${getApiBaseUrl()}/datasets/${id}/ratings`, {
      method: 'POST',
      body: JSON.stringify({ txHash, score, comment }),
    }),

  getRatings: (id: string, page = 1, limit = 10) =>
    request<{
      success: boolean;
      score: number;
      count: number;
      reviews: Array<{ txHash: string; score: number; comment?: string; timestamp: string }>;
      page: number;
      totalPages: number;
    }>(`${getApiBaseUrl()}/datasets/${id}/ratings?page=${page}&limit=${limit}`),

  agentInfo: () => request<AgentInfo>(`${getApiBaseUrl()}/agent/info`),

  agentDemo: (query: string) =>
    request<AgentJob>(`${getApiBaseUrl()}/agent/research/demo`, {
      method: 'POST',
      body: JSON.stringify({ query }),
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
    }),

  agentResearch: (query: string, txHash: string) =>
    request<AgentJob>(`${getApiBaseUrl()}/agent/research`, {
      method: 'POST',
      body: JSON.stringify({ query, txHash }),
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
    }),

  createDataset: (payload: {
    name: string;
    description: string;
    type: string;
    pricePerQuery: number;
    paymentToken?: 'USDC' | 'EURC' | 'XLM';
    sellerWallet: string;
    notificationEmail?: string;
    data: unknown;
  }) =>
    request<{ success: boolean; dataset: DatasetMeta }>(`${getApiBaseUrl()}/datasets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    }).then(r => r.dataset),
};

export function __resetRequestThrottleForTests() {
  requestQueues.clear();
  requestStartedAt.clear();
  inFlight = 0;
  inFlightWaiters.length = 0;
}

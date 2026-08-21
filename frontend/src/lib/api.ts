import { z } from 'zod';
import { getEnv } from './env';
import { getSellerToken } from './sellerAuth';

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

/** Live on-chain escrow state, as returned by GET /payments/escrow/:id (#548). */
export interface EscrowState {
  escrowId: number;
  datasetId: string;
  buyer: string;
  seller: string;
  amountStroops: string;
  amount: number;
  token: string;
  deadline: number;
  buyerConfirmed: boolean;
  platformFeeBps: number;
  released: boolean;
  refunded: boolean;
  disputed: boolean;
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

export interface ClaimableBalanceItem {
  balanceId: string;
  amount: string;
  assetCode: string;
  createdAt: string | null;
  reclaimableAt: string | null;
  datasetId?: string;
  status: string;
}

export interface ReclaimableBalance {
  id: string;
  balanceId: string;
  sellerWallet: string;
  amount: number;
  paymentToken?: string;
  reclaimableAt: string;
  createdAt: string;
}

export interface SellerAnalytics {
  revenueSeries: { date: string; usdc: number }[];
  queryVolumeSeries: { date: string; count: number }[];
  datasetBreakdown: { id: string; name: string; earned: number; queries: number }[];
  topBuyers: { wallet: string; count: number }[];
}

/** Sentinel's public transparency endpoint — see docs/MONITORING.md. */
export interface SolvencyReport {
  tokens: {
    token: string;
    onChainBalance: string;
    openLiability: string;
    delta: string;
  }[];
  openEscrowCount: number;
  lastCheckedLedger: number;
  checkedAt: string;
}

/** Verifiable delivery receipt — see docs/RECEIPTS.md. */
export interface ReceiptVerification {
  valid: boolean;
  receiptHashMatches: boolean;
  merkleProofValid?: boolean;
  anchorVerified?: boolean;
  anchorTxHash?: string;
  status: 'NOT_ANCHORED_YET' | 'ANCHORING' | 'ANCHORED' | 'ANCHOR_FAILED' | 'VERIFIED' | 'MISMATCH';
  error?: string;
}

export const ReceiptSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  buyer: z.string(),
  seller: z.string(),
  amount: z.number(),
  paymentToken: z.string(),
  txHash: z.string(),
  leafHash: z.string(),
  receiptHash: z.string(),
  anchorMode: z.enum(['direct', 'batched']),
  anchorStatus: z.enum([
    'NOT_ANCHORED_YET',
    'ANCHORING',
    'ANCHORED',
    'ANCHOR_FAILED',
    'VERIFIED',
    'MISMATCH',
  ]),
  anchorTxHash: z.string().optional(),
  merkleRoot: z.string().optional(),
  merkleIndex: z.number().optional(),
  merkleProof: z.array(z.string().nullable()).optional(),
  deliveredAt: z.string(),
  anchoredAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ReceiptMerkleProofSchema = z.object({
  leafIndex: z.number(),
  leafHash: z.string(),
  siblings: z.array(z.string().nullable()),
  root: z.string(),
});

export const ReceiptVerificationSchema = z.object({
  valid: z.boolean(),
  receiptHashMatches: z.boolean(),
  merkleProofValid: z.boolean().optional(),
  anchorVerified: z.boolean().optional(),
  anchorTxHash: z.string().optional(),
  status: z.enum([
    'NOT_ANCHORED_YET',
    'ANCHORING',
    'ANCHORED',
    'ANCHOR_FAILED',
    'VERIFIED',
    'MISMATCH',
  ]),
  error: z.string().optional(),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptMerkleProof = z.infer<typeof ReceiptMerkleProofSchema>;

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

  category: z.string().optional(),
  provider: z.string().nullish(),
  live: z.boolean().optional(),
  lastRefreshedAt: z.string().nullish(),
  tags: z.array(z.string()).optional(),

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

export const DatasetPreviewSchema = z.object({
  sample: z.unknown(),
  points: z.array(z.object({ label: z.string(), value: z.number() })).catch([]),
  headline: z.string().nullish(),
  live: z.boolean(),
  provider: z.string().nullish(),
  lastRefreshedAt: z.string().nullish(),
});
export type DatasetPreview = z.infer<typeof DatasetPreviewSchema>;

/** One immutable version of a dataset payload (#600). Metadata only — no payload. */
export const SnapshotMetaSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  contentHash: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  byteSize: z.number(),
  rawByteSize: z.number(),
  observations: z.number(),
  lastObservedAt: z.string(),
  providerRunId: z.string().nullish(),
  createdAt: z.string(),
});

export const DatasetHistorySchema = z.object({
  datasetId: z.string(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  snapshots: z.array(SnapshotMetaSchema).catch([]),
  changeFrequency: z.array(z.object({ date: z.string(), changes: z.number() })).catch([]),
});
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;
export type DatasetHistory = z.infer<typeof DatasetHistorySchema>;

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

/**
 * Bearer headers for seller-scoped endpoints. Prefers the in-memory SEP-10
 * seller JWT when the seller has signed in; falls back to the shared API key
 * (legacy deployments) when it has not.
 */
function sellerAuthHeaders(): HeadersInit {
  const token = getSellerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchWithTimeout(url: string, options?: RequestOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...init } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: authHeaders(init.headers),
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
    category?: string | string[];
    live?: boolean;
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
      const categoryValues = Array.isArray(params.category)
        ? params.category
        : params.category
          ? [params.category]
          : [];
      categoryValues.forEach(category => {
        if (category) searchParams.append('category', category);
      });
      if (params.live) searchParams.append('live', 'true');
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

  getDatasetPreview: (id: string) =>
    request<{ success: boolean; preview: unknown }>(
      `${getApiBaseUrl()}/datasets/${id}/preview`,
    ).then(r => parseApiResponse(DatasetPreviewSchema, r.preview)),

  getDatasetHistory: (id: string, params?: { limit?: number; days?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.days) searchParams.append('days', params.days.toString());
    const query = searchParams.toString();
    return request<unknown>(
      `${getApiBaseUrl()}/datasets/${id}/history${query ? `?${query}` : ''}`,
    ).then(r => parseApiResponse(DatasetHistorySchema, r));
  },

  getSellerAnalytics: (wallet: string) =>
    request<{ success: boolean } & SellerAnalytics>(
      `${getApiBaseUrl()}/analytics/seller/${encodeURIComponent(wallet)}`,
      { headers: sellerAuthHeaders() },
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
    return request<{ success: boolean; transactions: unknown }>(url, {
      headers: sellerAuthHeaders(),
    }).then(r => parseApiResponse(z.array(TransactionSchema), r.transactions));
  },

  initiateQuery: (id: string) =>
    request<{ payment: { paymentAddress: string; amount: number; memo: string } }>(
      `${getApiBaseUrl()}/query/${id}`,
      { method: 'POST' },
    ),

  getQuote: (id: string, sourceAsset: string) =>
    request<any>(
      `${getApiBaseUrl()}/query/${id}/quote?sourceAsset=${encodeURIComponent(sourceAsset)}`,
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

  // ── Non-custodial escrow (#547/#548) ─────────────────────────────────────

  /** Ask the backend to assemble an unsigned lock() transaction for the buyer. */
  buildEscrowLock: (
    buyer: string,
    datasetId: string,
    amount?: number,
    quote?: Record<string, unknown>,
  ) =>
    request<{ success: boolean; xdr: string; contractId: string; amount: number }>(
      `${getApiBaseUrl()}/payments/escrow/lock/build`,
      {
        method: 'POST',
        body: JSON.stringify({ buyer, datasetId, amount, quote }),
      },
    ),

  /** Relay a buyer-signed lock() transaction and receive the on-chain escrow id. */
  submitEscrowLock: (signedXdr: string) =>
    request<{ success: boolean; txHash: string; escrowId: number }>(
      `${getApiBaseUrl()}/payments/escrow/lock/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ signedXdr }),
      },
    ),

  /** Read live on-chain escrow state (#548). */
  getEscrow: (escrowId: number) =>
    request<{ success: boolean; escrow: EscrowState }>(
      `${getApiBaseUrl()}/payments/escrow/${escrowId}`,
    ).then(r => r.escrow),

  /** Verify a locked escrow, deliver the dataset, and trigger on-chain release. */
  verifyEscrowPayment: (id: string, escrowId: number, buyerQuestion?: string) =>
    request<unknown>(`${getApiBaseUrl()}/verify/${id}/escrow`, {
      method: 'POST',
      body: JSON.stringify({ escrowId, buyerQuestion }),
    }).then(r => parseApiResponse(QueryResultSchema, r)),

  /** Build an unsigned confirm_delivery() transaction for the buyer to sign. */
  buildConfirmDelivery: (buyer: string, escrowId: number) =>
    request<{ success: boolean; xdr: string }>(`${getApiBaseUrl()}/payments/escrow/confirm/build`, {
      method: 'POST',
      body: JSON.stringify({ buyer, escrowId }),
    }),

  /** Build an unsigned raise_dispute() transaction for the buyer to sign. */
  buildRaiseDispute: (buyer: string, escrowId: number, evidenceHash?: string) =>
    request<{ success: boolean; xdr: string }>(`${getApiBaseUrl()}/payments/escrow/dispute/build`, {
      method: 'POST',
      body: JSON.stringify({ buyer, escrowId, evidenceHash }),
    }),

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
      headers: sellerAuthHeaders(),
      body: JSON.stringify(payload),
    }).then(r => r.dataset),

  updateDataset: (
    id: string,
    payload: {
      name?: string;
      description?: string;
      pricePerQuery?: number;
      paymentToken?: 'USDC' | 'EURC' | 'XLM';
      notificationEmail?: string;
    },
  ) =>
    request<{ success: boolean; dataset: DatasetMeta }>(`${getApiBaseUrl()}/datasets/${id}`, {
      method: 'PATCH',
      headers: sellerAuthHeaders(),
      body: JSON.stringify(payload),
    }).then(r => r.dataset),

  deleteDataset: (id: string) =>
    request<{ success: boolean; message: string }>(`${getApiBaseUrl()}/datasets/${id}`, {
      method: 'DELETE',
      headers: sellerAuthHeaders(),
    }),

  // ── Claimable balance payout fallback (#589) ─────────────────────────────

  /** Pending claimable balances for a seller wallet, merged with our dataset context. */
  getSellerClaimables: (wallet: string) =>
    request<{ success: boolean; claimables: ClaimableBalanceItem[] }>(
      `${getApiBaseUrl()}/sellers/${encodeURIComponent(wallet)}/claimables`,
      { headers: sellerAuthHeaders() },
    ).then(r => r.claimables),

  /** Sponsor-signed (not seller-signed) claim XDR — the seller's wallet must still sign it. */
  buildClaimTx: (wallet: string, balanceId: string) =>
    request<{ success: boolean; xdr: string }>(
      `${getApiBaseUrl()}/sellers/${encodeURIComponent(wallet)}/claim-tx`,
      {
        method: 'POST',
        headers: sellerAuthHeaders(),
        body: JSON.stringify({ balanceId }),
      },
    ),

  /** Admin: balances past the treasury reclaim cutoff. */
  adminGetReclaimableBalances: (adminKey: string) =>
    request<{ success: boolean; reclaimable: ReclaimableBalance[] }>(
      `${getApiBaseUrl()}/admin/claimables/reclaimable`,
      { headers: { Authorization: `Bearer ${adminKey}` } },
    ).then(r => r.reclaimable),

  /** Admin: sweep expired balances back to the treasury. */
  adminSweepClaimables: (adminKey: string) =>
    request<{ success: boolean; swept: string[]; failed: string[] }>(
      `${getApiBaseUrl()}/admin/claimables/sweep`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminKey}` },
      },
    ),
  // ── Sentinel (#599) ───────────────────────────────────────────────────────

  /** Public: total locked on-chain vs. open escrow liability, per token. */
  getSolvency: () =>
    request<{ success: boolean } & SolvencyReport>(`${getApiBaseUrl()}/solvency`).then(r => ({
      tokens: r.tokens,
      openEscrowCount: r.openEscrowCount,
      lastCheckedLedger: r.lastCheckedLedger,
      checkedAt: r.checkedAt,
    })),

  // ── Receipt verification (#594) ────────────────────────────────────────────

  /** Public: fetch a delivery receipt with its merkle proof and verification. */
  getReceipt: (id: string) =>
    request<{
      success: boolean;
      receipt: unknown;
      merkleProof?: unknown;
      verification: unknown;
    }>(`${getApiBaseUrl()}/receipts/${encodeURIComponent(id)}`).then(r => ({
      receipt: parseApiResponse(ReceiptSchema, r.receipt),
      merkleProof: r.merkleProof
        ? parseApiResponse(ReceiptMerkleProofSchema, r.merkleProof)
        : undefined,
      verification: parseApiResponse(ReceiptVerificationSchema, r.verification),
    })),
};

export function __resetRequestThrottleForTests() {
  requestQueues.clear();
  requestStartedAt.clear();
  inFlight = 0;
  inFlightWaiters.length = 0;
}

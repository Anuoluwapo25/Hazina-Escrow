import db from '../db/client';
import { eq, sql, and } from 'drizzle-orm';
import {
  datasetsSqlite,
  transactionsSqlite,
  webhooksSqlite,
  payoutFailuresSqlite,
} from '../db/schema';

const pendingTxHashes = new Set<string>();

export function reserveTxHash(txHash: string): () => void {
  pendingTxHashes.add(txHash);
  return () => pendingTxHashes.delete(txHash);
}

export interface DatasetRating {
  score: number;
  count: number;
  reviews: Array<{ txHash: string; score: number; comment?: string; timestamp: string }>;
}
export interface DatasetPricePoint {
  price: number;
  changedAt: string;
}
export interface Dataset {
  id: string;
  name: string;
  description: string;
  type: string;
  pricePerQuery: number;
  sellerWallet: string;
  paymentToken?: string;
  notificationEmail?: string;
  data: Record<string, unknown>;
  queriesServed: number;
  totalEarned: number;
  createdAt: string;
  ratings?: DatasetRating;
  priceHistory?: DatasetPricePoint[];
}
export interface Transaction {
  id: string;
  datasetId: string;
  txHash: string;
  buyerWallet?: string;
  memo?: string;
  amount: number;
  paymentToken?: string;
  status?:
    | 'pending'
    | 'verifying'
    | 'verified'
    | 'completed'
    | 'failed'
    | 'refunded'
    | 'delivery_failed';
  deliveryStatus?: 'pending' | 'delivered' | 'failed';
  sellerPaid?: boolean;
  sellerAmount?: number;
  sellerTxHash?: string;
  sellerNotifiedAt?: string;
  sellerNotificationError?: string;
  sellerNotificationAttempts?: number;
  buyerQuery?: string;
  aiSummary?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  verifiedAt?: string;
  deliveredAt?: string;
  timestamp: string;
}
export type WebhookEvent =
  | 'payment.received'
  | 'payment.forwarded'
  | 'dataset.queried'
  | 'dataset.created'
  | 'ping';
export interface WebhookSubscription {
  id: string;
  sellerWallet: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
}
export type PayoutFailureStatus = 'pending_retry' | 'manual_review_needed' | 'paid';
export interface PayoutFailure {
  id: string;
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  intendedAmount: number;
  sellerTxHash?: string;
  status: PayoutFailureStatus;
  retryCount: number;
  nextRetryAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}
export interface Store {
  datasets: Dataset[];
  transactions: Transaction[];
  webhooks: WebhookSubscription[];
  payoutFailures: PayoutFailure[];
}

// ── Row ↔ domain converters ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDataset(row: any): Dataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    pricePerQuery: Number(row.pricePerQuery),
    sellerWallet: row.sellerWallet,
    paymentToken: row.paymentToken ?? undefined,
    notificationEmail: row.notificationEmail ?? undefined,
    data: row.data ? JSON.parse(row.data) : {},
    queriesServed: Number(row.queriesServed ?? 0),
    totalEarned: Number(row.totalEarned ?? 0),
    createdAt: row.createdAt,
    ratings: row.ratings ? JSON.parse(row.ratings) : undefined,
    priceHistory: row.priceHistory ? JSON.parse(row.priceHistory) : undefined,
  };
}

function datasetToRow(dataset: Dataset): Record<string, unknown> {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    type: dataset.type,
    pricePerQuery: String(dataset.pricePerQuery),
    paymentToken: dataset.paymentToken ?? 'USDC',
    sellerWallet: dataset.sellerWallet,
    notificationEmail: dataset.notificationEmail ?? null,
    data: JSON.stringify(dataset.data),
    queriesServed: dataset.queriesServed,
    totalEarned: String(dataset.totalEarned),
    createdAt: dataset.createdAt,
    ratings: dataset.ratings !== undefined ? JSON.stringify(dataset.ratings) : null,
    priceHistory: dataset.priceHistory !== undefined ? JSON.stringify(dataset.priceHistory) : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTransaction(row: any): Transaction {
  return {
    id: row.id,
    datasetId: row.datasetId,
    txHash: row.txHash,
    buyerWallet: row.buyerWallet ?? undefined,
    memo: row.memo ?? undefined,
    amount: Number(row.amount),
    paymentToken: row.paymentToken ?? undefined,
    status: row.status ?? undefined,
    deliveryStatus: row.deliveryStatus ?? undefined,
    sellerPaid:
      row.sellerPaid === null || row.sellerPaid === undefined ? undefined : Boolean(row.sellerPaid),
    sellerAmount: row.sellerAmount !== null ? Number(row.sellerAmount) : undefined,
    sellerTxHash: row.sellerTxHash ?? undefined,
    sellerNotifiedAt: row.sellerNotifiedAt ?? undefined,
    sellerNotificationError: row.sellerNotificationError ?? undefined,
    sellerNotificationAttempts: row.sellerNotificationAttempts ?? undefined,
    buyerQuery: row.buyerQuery ?? undefined,
    aiSummary: row.aiSummary ?? undefined,
    deliveryAttempts: row.deliveryAttempts ?? undefined,
    deliveryError: row.deliveryError ?? undefined,
    verifiedAt: row.verifiedAt ?? undefined,
    deliveredAt: row.deliveredAt ?? undefined,
    timestamp: row.timestamp,
  };
}

function transactionToRow(tx: Transaction): Record<string, unknown> {
  return {
    id: tx.id,
    datasetId: tx.datasetId,
    txHash: tx.txHash,
    buyerWallet: tx.buyerWallet ?? null,
    memo: tx.memo ?? null,
    amount: String(tx.amount),
    paymentToken: tx.paymentToken ?? 'USDC',
    status: tx.status ?? null,
    deliveryStatus: tx.deliveryStatus ?? null,
    sellerPaid: tx.sellerPaid === undefined ? null : tx.sellerPaid ? 1 : 0,
    sellerAmount: tx.sellerAmount !== undefined ? String(tx.sellerAmount) : null,
    sellerTxHash: tx.sellerTxHash ?? null,
    sellerNotifiedAt: tx.sellerNotifiedAt ?? null,
    sellerNotificationError: tx.sellerNotificationError ?? null,
    sellerNotificationAttempts: tx.sellerNotificationAttempts ?? null,
    buyerQuery: tx.buyerQuery ?? null,
    aiSummary: tx.aiSummary ?? null,
    deliveryAttempts: tx.deliveryAttempts ?? null,
    deliveryError: tx.deliveryError ?? null,
    verifiedAt: tx.verifiedAt ?? null,
    deliveredAt: tx.deliveredAt ?? null,
    timestamp: tx.timestamp,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToWebhook(row: any): WebhookSubscription {
  return {
    id: row.id,
    sellerWallet: row.sellerWallet,
    url: row.url,
    secret: row.secret,
    events:
      typeof row.events === 'string' ? JSON.parse(row.events) : (row.events as WebhookEvent[]),
    active: Boolean(row.active),
    createdAt: row.createdAt,
  };
}

function webhookToRow(webhook: WebhookSubscription): Record<string, unknown> {
  return {
    id: webhook.id,
    sellerWallet: webhook.sellerWallet,
    url: webhook.url,
    secret: webhook.secret,
    events: JSON.stringify(webhook.events),
    active: webhook.active ? 1 : 0,
    createdAt: webhook.createdAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPayoutFailure(row: any): PayoutFailure {
  return {
    id: row.id,
    datasetId: row.datasetId,
    sellerWallet: row.sellerWallet,
    buyerTxHash: row.buyerTxHash,
    intendedAmount: Number(row.intendedAmount),
    sellerTxHash: row.sellerTxHash ?? undefined,
    status: row.status as PayoutFailureStatus,
    retryCount: Number(row.retryCount ?? 0),
    nextRetryAt: row.nextRetryAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function payoutFailureToRow(pf: PayoutFailure): Record<string, unknown> {
  return {
    id: pf.id,
    datasetId: pf.datasetId,
    sellerWallet: pf.sellerWallet,
    buyerTxHash: pf.buyerTxHash,
    intendedAmount: String(pf.intendedAmount),
    sellerTxHash: pf.sellerTxHash ?? null,
    status: pf.status,
    retryCount: pf.retryCount,
    nextRetryAt: pf.nextRetryAt,
    lastError: pf.lastError,
    createdAt: pf.createdAt,
    updatedAt: pf.updatedAt,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function invalidateCache(): void {
  // No-op: SQLite has no application-level cache to invalidate.
}

export async function readStore(): Promise<Store> {
  const [datasets, transactions, webhooks, payoutFailures] = await Promise.all([
    db.select().from(datasetsSqlite),
    db.select().from(transactionsSqlite),
    db.select().from(webhooksSqlite),
    db.select().from(payoutFailuresSqlite),
  ]);
  return {
    datasets: datasets.map(rowToDataset),
    transactions: transactions.map(rowToTransaction),
    webhooks: webhooks.map(rowToWebhook),
    payoutFailures: payoutFailures.map(rowToPayoutFailure),
  };
}

export async function writeStore(store: Store): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.transaction(async (tx: any) => {
    await tx.delete(datasetsSqlite);
    await tx.delete(transactionsSqlite);
    await tx.delete(webhooksSqlite);
    await tx.delete(payoutFailuresSqlite);
    for (const dataset of store.datasets) {
      await tx.insert(datasetsSqlite).values(datasetToRow(dataset));
    }
    for (const transaction of store.transactions) {
      await tx.insert(transactionsSqlite).values(transactionToRow(transaction));
    }
    for (const webhook of store.webhooks) {
      await tx.insert(webhooksSqlite).values(webhookToRow(webhook));
    }
    for (const pf of store.payoutFailures) {
      await tx.insert(payoutFailuresSqlite).values(payoutFailureToRow(pf));
    }
  });
}

export async function getDataset(id: string): Promise<Dataset | undefined> {
  const result = await db.select().from(datasetsSqlite).where(eq(datasetsSqlite.id, id)).limit(1);
  return result[0] ? rowToDataset(result[0]) : undefined;
}

export async function getAllDatasets(): Promise<Dataset[]> {
  const result = await db.select().from(datasetsSqlite);
  return result.map(rowToDataset);
}

export async function updateDataset(
  id: string,
  updates: Partial<Dataset>,
): Promise<Dataset | null> {
  const existing = await db.select().from(datasetsSqlite).where(eq(datasetsSqlite.id, id)).limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToDataset(existing[0]), ...updates };
  await db.update(datasetsSqlite).set(datasetToRow(merged)).where(eq(datasetsSqlite.id, id));
  return merged;
}

export async function addDataset(dataset: Dataset): Promise<void> {
  await db.insert(datasetsSqlite).values(datasetToRow(dataset));
}

export async function addTransaction(tx: Transaction): Promise<void> {
  if (tx.txHash) pendingTxHashes.add(tx.txHash);
  try {
    await db.insert(transactionsSqlite).values(transactionToRow(tx));
  } finally {
    if (tx.txHash) pendingTxHashes.delete(tx.txHash);
  }
}

export async function getTransactionByHash(txHash: string): Promise<Transaction | undefined> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.txHash, txHash))
    .limit(1);
  return result[0] ? rowToTransaction(result[0]) : undefined;
}

export async function getAgentJobByTxHash(txHash: string): Promise<Transaction | undefined> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(
      and(eq(transactionsSqlite.txHash, txHash), eq(transactionsSqlite.datasetId, 'agent-job')),
    )
    .limit(1);
  return result[0] ? rowToTransaction(result[0]) : undefined;
}

export async function getTransactionByMemo(memo: string): Promise<Transaction | undefined> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.memo, memo))
    .limit(1);
  return result[0] ? rowToTransaction(result[0]) : undefined;
}

export async function updateTransactionByHash(
  txHash: string,
  updates: Partial<Transaction>,
): Promise<Transaction | null> {
  const existing = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.txHash, txHash))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToTransaction(existing[0]), ...updates };
  await db
    .update(transactionsSqlite)
    .set(transactionToRow(merged))
    .where(eq(transactionsSqlite.txHash, txHash));
  return merged;
}

export async function updateTransactionByMemo(
  memo: string,
  updates: Partial<Transaction>,
): Promise<Transaction | null> {
  const existing = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.memo, memo))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToTransaction(existing[0]), ...updates };
  await db
    .update(transactionsSqlite)
    .set(transactionToRow(merged))
    .where(eq(transactionsSqlite.memo, memo));
  return merged;
}

export async function getTransactions(
  datasetId?: string,
  limit?: number,
  offset?: number,
): Promise<Transaction[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db.select().from(transactionsSqlite);
  if (datasetId) query = query.where(eq(transactionsSqlite.datasetId, datasetId));
  if (offset && offset > 0) query = query.offset(offset);
  if (limit && limit > 0) query = query.limit(limit);
  const result = await query;
  return result.map(rowToTransaction);
}

export async function getTransactionsCount(datasetId?: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db.select({ count: sql<number>`count(*)` }).from(transactionsSqlite);
  if (datasetId) query = query.where(eq(transactionsSqlite.datasetId, datasetId));
  const result = await query;
  return Number(result[0]?.count ?? 0);
}

export async function txHashUsed(txHash: string): Promise<boolean> {
  if (!txHash) return false;
  if (pendingTxHashes.has(txHash)) return true;
  const result = await db
    .select({ id: transactionsSqlite.id })
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.txHash, txHash))
    .limit(1);
  return result.length > 0;
}

export async function getFailedDeliveryTransactions(): Promise<Transaction[]> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.deliveryStatus, 'failed'));
  return result.map(rowToTransaction);
}

export async function getAllWebhooks(): Promise<WebhookSubscription[]> {
  const result = await db.select().from(webhooksSqlite);
  return result.map(rowToWebhook);
}

export async function getWebhooksForSeller(sellerWallet: string): Promise<WebhookSubscription[]> {
  const result = await db
    .select()
    .from(webhooksSqlite)
    .where(and(eq(webhooksSqlite.sellerWallet, sellerWallet), eq(webhooksSqlite.active, 1)));
  return result.map(rowToWebhook);
}

export async function getWebhookById(id: string): Promise<WebhookSubscription | undefined> {
  const result = await db.select().from(webhooksSqlite).where(eq(webhooksSqlite.id, id)).limit(1);
  return result[0] ? rowToWebhook(result[0]) : undefined;
}

export async function addWebhook(webhook: WebhookSubscription): Promise<void> {
  await db.insert(webhooksSqlite).values(webhookToRow(webhook));
}

export async function removeWebhook(id: string): Promise<boolean> {
  const existing = await db
    .select({ id: webhooksSqlite.id })
    .from(webhooksSqlite)
    .where(eq(webhooksSqlite.id, id))
    .limit(1);
  if (existing.length === 0) return false;
  await db.delete(webhooksSqlite).where(eq(webhooksSqlite.id, id));
  return true;
}

export async function updateWebhook(
  id: string,
  updates: Partial<WebhookSubscription>,
): Promise<WebhookSubscription | null> {
  const existing = await db.select().from(webhooksSqlite).where(eq(webhooksSqlite.id, id)).limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToWebhook(existing[0]), ...updates };
  await db.update(webhooksSqlite).set(webhookToRow(merged)).where(eq(webhooksSqlite.id, id));
  return merged;
}

export async function addPayoutFailure(payoutFailure: PayoutFailure): Promise<void> {
  await db.insert(payoutFailuresSqlite).values(payoutFailureToRow(payoutFailure));
}

export async function getPayoutFailureByBuyerTxHash(
  buyerTxHash: string,
): Promise<PayoutFailure | undefined> {
  const result = await db
    .select()
    .from(payoutFailuresSqlite)
    .where(eq(payoutFailuresSqlite.buyerTxHash, buyerTxHash))
    .limit(1);
  return result[0] ? rowToPayoutFailure(result[0]) : undefined;
}

export async function updatePayoutFailure(
  id: string,
  updates: Partial<PayoutFailure>,
): Promise<PayoutFailure | null> {
  const existing = await db
    .select()
    .from(payoutFailuresSqlite)
    .where(eq(payoutFailuresSqlite.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToPayoutFailure(existing[0]), ...updates };
  await db
    .update(payoutFailuresSqlite)
    .set(payoutFailureToRow(merged))
    .where(eq(payoutFailuresSqlite.id, id));
  return merged;
}

export async function getPayoutFailuresByStatus(
  status: PayoutFailureStatus,
): Promise<PayoutFailure[]> {
  const result = await db
    .select()
    .from(payoutFailuresSqlite)
    .where(eq(payoutFailuresSqlite.status, status));
  return result.map(rowToPayoutFailure);
}

export async function getPendingPayoutFailures(nowIso: string): Promise<PayoutFailure[]> {
  const now = new Date(nowIso).getTime();
  const pending = await getPayoutFailuresByStatus('pending_retry');
  return pending.filter(pf => new Date(pf.nextRetryAt).getTime() <= now);
}

export async function getUnpaidTransactions(): Promise<Transaction[]> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.sellerPaid, 0));
  return result.map(rowToTransaction);
}

export async function getTransactionsWithFailedSellerNotification(): Promise<Transaction[]> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(
      and(
        eq(transactionsSqlite.status, 'completed'),
        sql`${transactionsSqlite.sellerNotificationError} IS NOT NULL`,
        sql`${transactionsSqlite.sellerNotifiedAt} IS NULL`,
      ),
    );
  return result.map(rowToTransaction);
}

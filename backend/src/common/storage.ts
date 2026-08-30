import db from '../db/client';
import { eq, sql, and, lte } from 'drizzle-orm';
import type { SnapshotRetentionPolicy } from '../snapshots/snapshots.types';
import {
  datasetsSqlite,
  transactionsSqlite,
  webhooksSqlite,
  payoutFailuresSqlite,
  claimableBalancesSqlite,
  sentinelCursorSqlite,
  sentinelAlertsSqlite,
  bundlesSqlite,
  bundleComponentsSqlite,
  bundlePurchasesSqlite,
  bundlePurchaseComponentsSqlite,
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
  /** Human-facing grouping used for marketplace category tabs. */
  category?: string;
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
  /** Provider id backing a live feed (e.g. "defillama"); undefined for static/user datasets. */
  provider?: string;
  /** True when this dataset is refreshed from an external live source. */
  live?: boolean;
  /** ISO timestamp of the last successful provider refresh. */
  lastRefreshedAt?: string;
  /** Free-form discovery tags. */
  tags?: string[];
  /** Soft-delete / visibility flag; defaults to true. */
  active?: boolean;
  /** Per-dataset snapshot retention overrides; platform defaults when unset. */
  snapshotPolicy?: Partial<SnapshotRetentionPolicy>;
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
  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'refunded' | 'manual_review_needed';
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
  /** On-chain escrow id (from the contract's lock()); undefined for demo/legacy txns. */
  escrowId?: number;
  /** Claimable balance id, set when the seller payout for this tx settled into a claimable balance instead of a direct payment. */
  balanceId?: string;
  /** Snapshot the buyer was served — what a dispute is reconstructed from (#600). */
  snapshotId?: string;
  timestamp: string;
}
export type WebhookEvent =
  | 'payment.received'
  | 'payment.forwarded'
  | 'payout.claimable'
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
export type PayoutFailureStatus =
  | 'pending_retry'
  | 'manual_review_needed'
  | 'paid'
  | 'settled_as_claimable';
export interface PayoutFailure {
  id: string;
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  intendedAmount: number;
  paymentToken?: string;
  sellerTxHash?: string;
  status: PayoutFailureStatus;
  retryCount: number;
  nextRetryAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}
export type ClaimableBalanceStatus = 'pending' | 'claimed' | 'reclaimed';
export interface ClaimableBalance {
  id: string;
  /** On-chain claimable balance id (Horizon's `balance_id`). */
  balanceId: string;
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  amount: number;
  paymentToken?: string;
  status: ClaimableBalanceStatus;
  /** Hash of the createClaimableBalance transaction. */
  creationTxHash: string;
  /** ISO timestamp after which Hazina's treasury claimant predicate becomes claimable. */
  reclaimableAt: string;
  claimedTxHash?: string;
  claimedAt?: string;
  reclaimedTxHash?: string;
  reclaimedAt?: string;
  createdAt: string;
  updatedAt: string;
}
// ── Bundles (#615) ───────────────────────────────────────────────────────────
// A curator-composed product: several sellers' datasets sold as one purchase
// at one price, settled atomically on-chain via lock_multi/release_multi.

export interface BundleComponentRecord {
  id: string;
  bundleId: string;
  datasetId: string;
  /** Basis points of `Bundle.totalPrice` this dataset's seller receives. */
  shareBps: number;
  /** Display order — the sequence the curator arranged components in. */
  position: number;
  createdAt: string;
}

export interface Bundle {
  id: string;
  name: string;
  description: string;
  curatorWallet: string;
  totalPrice: number;
  paymentToken?: string;
  /** Basis points of `totalPrice` the curator receives, on top of every component's shareBps. */
  curatorFeeBps: number;
  /** Soft-delete flag; defaults to true. */
  active?: boolean;
  createdAt: string;
  updatedAt: string;
  components: BundleComponentRecord[];
}

export type BundlePurchaseStatus =
  | 'locked'
  | 'delivering'
  | 'delivered'
  | 'released'
  | 'refunding'
  | 'refunded'
  | 'failed';

export interface BundlePurchase {
  id: string;
  bundleId: string;
  buyerWallet: string;
  firstEscrowId: number;
  /** Every escrow id in the lock_multi batch, in lock order (dataset legs, then the curator leg). */
  escrowIds: number[];
  totalAmount: number;
  paymentToken?: string;
  status: BundlePurchaseStatus;
  lockTxHash?: string;
  releaseTxHash?: string;
  /** Single cross-dataset synthesis (via research.service.ts) — never N stitched per-dataset summaries. */
  aiSummary?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type BundlePurchaseComponentRole = 'dataset' | 'curator';
export type BundlePurchaseComponentDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface BundlePurchaseComponent {
  id: string;
  purchaseId: string;
  /** The dataset id for a 'dataset' leg, or the synthetic curator-fee marker for the 'curator' leg. */
  datasetId: string;
  role: BundlePurchaseComponentRole;
  escrowId: number;
  sellerWallet: string;
  amount: number;
  buyerConfirmed: boolean;
  deliveryStatus: BundlePurchaseComponentDeliveryStatus;
  deliveryError?: string;
  deliveryAttempts: number;
  createdAt: string;
}

export interface Store {
  datasets: Dataset[];
  transactions: Transaction[];
  webhooks: WebhookSubscription[];
  payoutFailures: PayoutFailure[];
  claimableBalances: ClaimableBalance[];
}

// ── Sentinel (contract monitoring) ──────────────────────────────────────────
// Not part of Store/readStore/writeStore: this is regenerable operational
// state, not business data — a point-in-time restore of datasets/transactions
// must not rewind the monitoring cursor or resurrect resolved alerts.

export interface SentinelCursor {
  id: string;
  /** Soroban RPC event paging token; null before the first successful page. */
  cursor: string | null;
  lastLedger: number;
  /** True once the genesis→cursor state rebuild has completed at least once. */
  backfillComplete: boolean;
  /** sha256 of the contract's current WASM, used to detect `upgrade()` (which emits no event). */
  lastWasmHash: string | null;
  /** Last time ingestion observed forward ledger progress — powers the stalled-stream check. */
  lastProgressAt: string;
  updatedAt: string;
}

export type SentinelAlertSeverity = 'critical' | 'high' | 'medium';
export type SentinelAlertStatus = 'open' | 'resolved';
export interface SentinelAlert {
  id: string;
  /** Stable dedupe key: `${invariant}:${escrowId ?? 'global'}`. */
  dedupeKey: string;
  invariant: string;
  severity: SentinelAlertSeverity;
  status: SentinelAlertStatus;
  escrowId?: number;
  txHash?: string;
  ledger?: number;
  message: string;
  details?: Record<string, unknown>;
  /** How many times this exact (invariant, escrow) has re-fired since it was first seen. */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Last time this alert was actually dispatched to Sentry/Datadog/webhook/email (suppression window). */
  lastNotifiedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// ── Row ↔ domain converters (bundles) ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBundle(row: any): Omit<Bundle, 'components'> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    curatorWallet: row.curatorWallet,
    totalPrice: Number(row.totalPrice),
    paymentToken: row.paymentToken ?? undefined,
    curatorFeeBps: Number(row.curatorFeeBps),
    active: row.active === null || row.active === undefined ? undefined : Boolean(row.active),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bundleToRow(bundle: Omit<Bundle, 'components'>): Record<string, unknown> {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    curatorWallet: bundle.curatorWallet,
    totalPrice: String(bundle.totalPrice),
    paymentToken: bundle.paymentToken ?? 'USDC',
    curatorFeeBps: bundle.curatorFeeBps,
    active: bundle.active === false ? 0 : 1,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBundleComponent(row: any): BundleComponentRecord {
  return {
    id: row.id,
    bundleId: row.bundleId,
    datasetId: row.datasetId,
    shareBps: Number(row.shareBps),
    position: Number(row.position),
    createdAt: row.createdAt,
  };
}

function bundleComponentToRow(component: BundleComponentRecord): Record<string, unknown> {
  return {
    id: component.id,
    bundleId: component.bundleId,
    datasetId: component.datasetId,
    shareBps: component.shareBps,
    position: component.position,
    createdAt: component.createdAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBundlePurchase(row: any): BundlePurchase {
  return {
    id: row.id,
    bundleId: row.bundleId,
    buyerWallet: row.buyerWallet,
    firstEscrowId: Number(row.firstEscrowId),
    escrowIds: JSON.parse(row.escrowIds) as number[],
    totalAmount: Number(row.totalAmount),
    paymentToken: row.paymentToken ?? undefined,
    status: row.status as BundlePurchaseStatus,
    lockTxHash: row.lockTxHash ?? undefined,
    releaseTxHash: row.releaseTxHash ?? undefined,
    aiSummary: row.aiSummary ?? undefined,
    failureReason: row.failureReason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bundlePurchaseToRow(purchase: BundlePurchase): Record<string, unknown> {
  return {
    id: purchase.id,
    bundleId: purchase.bundleId,
    buyerWallet: purchase.buyerWallet,
    firstEscrowId: purchase.firstEscrowId,
    escrowIds: JSON.stringify(purchase.escrowIds),
    totalAmount: String(purchase.totalAmount),
    paymentToken: purchase.paymentToken ?? 'USDC',
    status: purchase.status,
    lockTxHash: purchase.lockTxHash ?? null,
    releaseTxHash: purchase.releaseTxHash ?? null,
    aiSummary: purchase.aiSummary ?? null,
    failureReason: purchase.failureReason ?? null,
    createdAt: purchase.createdAt,
    updatedAt: purchase.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToBundlePurchaseComponent(row: any): BundlePurchaseComponent {
  return {
    id: row.id,
    purchaseId: row.purchaseId,
    datasetId: row.datasetId,
    role: row.role as BundlePurchaseComponentRole,
    escrowId: Number(row.escrowId),
    sellerWallet: row.sellerWallet,
    amount: Number(row.amount),
    buyerConfirmed: Boolean(row.buyerConfirmed),
    deliveryStatus: row.deliveryStatus as BundlePurchaseComponentDeliveryStatus,
    deliveryError: row.deliveryError ?? undefined,
    deliveryAttempts: Number(row.deliveryAttempts ?? 0),
    createdAt: row.createdAt,
  };
}

function bundlePurchaseComponentToRow(component: BundlePurchaseComponent): Record<string, unknown> {
  return {
    id: component.id,
    purchaseId: component.purchaseId,
    datasetId: component.datasetId,
    role: component.role,
    escrowId: component.escrowId,
    sellerWallet: component.sellerWallet,
    amount: String(component.amount),
    buyerConfirmed: component.buyerConfirmed ? 1 : 0,
    deliveryStatus: component.deliveryStatus,
    deliveryError: component.deliveryError ?? null,
    deliveryAttempts: component.deliveryAttempts,
    createdAt: component.createdAt,
  };
}

// ── Row ↔ domain converters ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDataset(row: any): Dataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    category: row.category ?? undefined,
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
    provider: row.provider ?? undefined,
    live: row.live === null || row.live === undefined ? undefined : Boolean(row.live),
    lastRefreshedAt: row.lastRefreshedAt ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    active: row.active === null || row.active === undefined ? undefined : Boolean(row.active),
    snapshotPolicy: row.snapshotPolicy
      ? (JSON.parse(row.snapshotPolicy) as Partial<SnapshotRetentionPolicy>)
      : undefined,
  };
}

function datasetToRow(dataset: Dataset): Record<string, unknown> {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    type: dataset.type,
    category: dataset.category ?? 'other',
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
    provider: dataset.provider ?? null,
    live: dataset.live ? 1 : 0,
    lastRefreshedAt: dataset.lastRefreshedAt ?? null,
    tags: dataset.tags !== undefined ? JSON.stringify(dataset.tags) : null,
    active: dataset.active ? 1 : 0,
    snapshotPolicy:
      dataset.snapshotPolicy !== undefined ? JSON.stringify(dataset.snapshotPolicy) : null,
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
    escrowId:
      row.escrowId === null || row.escrowId === undefined ? undefined : Number(row.escrowId),
    balanceId: row.balanceId ?? undefined,
    snapshotId: row.snapshotId ?? undefined,
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
    escrowId: tx.escrowId ?? null,
    balanceId: tx.balanceId ?? null,
    snapshotId: tx.snapshotId ?? null,
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
    paymentToken: row.paymentToken ?? undefined,
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
    paymentToken: pf.paymentToken ?? 'USDC',
    sellerTxHash: pf.sellerTxHash ?? null,
    status: pf.status,
    retryCount: pf.retryCount,
    nextRetryAt: pf.nextRetryAt,
    lastError: pf.lastError,
    createdAt: pf.createdAt,
    updatedAt: pf.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToClaimableBalance(row: any): ClaimableBalance {
  return {
    id: row.id,
    balanceId: row.balanceId,
    datasetId: row.datasetId,
    sellerWallet: row.sellerWallet,
    buyerTxHash: row.buyerTxHash,
    amount: Number(row.amount),
    paymentToken: row.paymentToken ?? undefined,
    status: row.status as ClaimableBalanceStatus,
    creationTxHash: row.creationTxHash,
    reclaimableAt: row.reclaimableAt,
    claimedTxHash: row.claimedTxHash ?? undefined,
    claimedAt: row.claimedAt ?? undefined,
    reclaimedTxHash: row.reclaimedTxHash ?? undefined,
    reclaimedAt: row.reclaimedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function claimableBalanceToRow(cb: ClaimableBalance): Record<string, unknown> {
  return {
    id: cb.id,
    balanceId: cb.balanceId,
    datasetId: cb.datasetId,
    sellerWallet: cb.sellerWallet,
    buyerTxHash: cb.buyerTxHash,
    amount: String(cb.amount),
    paymentToken: cb.paymentToken ?? 'USDC',
    status: cb.status,
    creationTxHash: cb.creationTxHash,
    reclaimableAt: cb.reclaimableAt,
    claimedTxHash: cb.claimedTxHash ?? null,
    claimedAt: cb.claimedAt ?? null,
    reclaimedTxHash: cb.reclaimedTxHash ?? null,
    reclaimedAt: cb.reclaimedAt ?? null,
    createdAt: cb.createdAt,
    updatedAt: cb.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSentinelCursor(row: any): SentinelCursor {
  return {
    id: row.id,
    cursor: row.cursor ?? null,
    lastLedger: Number(row.lastLedger ?? 0),
    backfillComplete: Boolean(row.backfillComplete),
    lastWasmHash: row.lastWasmHash ?? null,
    lastProgressAt: row.lastProgressAt,
    updatedAt: row.updatedAt,
  };
}

function sentinelCursorToRow(c: SentinelCursor): Record<string, unknown> {
  return {
    id: c.id,
    cursor: c.cursor,
    lastLedger: c.lastLedger,
    backfillComplete: c.backfillComplete ? 1 : 0,
    lastWasmHash: c.lastWasmHash,
    lastProgressAt: c.lastProgressAt,
    updatedAt: c.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSentinelAlert(row: any): SentinelAlert {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    invariant: row.invariant,
    severity: row.severity as SentinelAlertSeverity,
    status: row.status as SentinelAlertStatus,
    escrowId:
      row.escrowId === null || row.escrowId === undefined ? undefined : Number(row.escrowId),
    txHash: row.txHash ?? undefined,
    ledger: row.ledger === null || row.ledger === undefined ? undefined : Number(row.ledger),
    message: row.message,
    details: row.details ? JSON.parse(row.details) : undefined,
    count: Number(row.count ?? 1),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastNotifiedAt: row.lastNotifiedAt ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
  };
}

function sentinelAlertToRow(a: SentinelAlert): Record<string, unknown> {
  return {
    id: a.id,
    dedupeKey: a.dedupeKey,
    invariant: a.invariant,
    severity: a.severity,
    status: a.status,
    escrowId: a.escrowId ?? null,
    txHash: a.txHash ?? null,
    ledger: a.ledger ?? null,
    message: a.message,
    details: a.details !== undefined ? JSON.stringify(a.details) : null,
    count: a.count,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    lastNotifiedAt: a.lastNotifiedAt ?? null,
    resolvedAt: a.resolvedAt ?? null,
    resolvedBy: a.resolvedBy ?? null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function invalidateCache(): void {
  // No-op: SQLite has no application-level cache to invalidate.
}

export async function readStore(): Promise<Store> {
  const [datasets, transactions, webhooks, payoutFailures, claimableBalances] = await Promise.all([
    db.select().from(datasetsSqlite),
    db.select().from(transactionsSqlite),
    db.select().from(webhooksSqlite),
    db.select().from(payoutFailuresSqlite),
    db.select().from(claimableBalancesSqlite),
  ]);
  return {
    datasets: datasets.map(rowToDataset),
    transactions: transactions.map(rowToTransaction),
    webhooks: webhooks.map(rowToWebhook),
    payoutFailures: payoutFailures.map(rowToPayoutFailure),
    claimableBalances: claimableBalances.map(rowToClaimableBalance),
  };
}

export async function writeStore(store: Store): Promise<void> {
  await db.delete(datasetsSqlite);
  await db.delete(transactionsSqlite);
  await db.delete(webhooksSqlite);
  await db.delete(payoutFailuresSqlite);
  await db.delete(claimableBalancesSqlite);
  for (const dataset of store.datasets) {
    await db.insert(datasetsSqlite).values(datasetToRow(dataset));
  }
  for (const transaction of store.transactions) {
    await db.insert(transactionsSqlite).values(transactionToRow(transaction));
  }
  for (const webhook of store.webhooks) {
    await db.insert(webhooksSqlite).values(webhookToRow(webhook));
  }
  for (const pf of store.payoutFailures) {
    await db.insert(payoutFailuresSqlite).values(payoutFailureToRow(pf));
  }
  for (const cb of store.claimableBalances) {
    await db.insert(claimableBalancesSqlite).values(claimableBalanceToRow(cb));
  }
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

/** Deliveries that exhausted their bounded retries and need a human to look — mirrors getManualReviewPayouts(). */
export async function getManualReviewDeliveries(): Promise<Transaction[]> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.deliveryStatus, 'manual_review_needed'));
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

export async function addClaimableBalance(cb: ClaimableBalance): Promise<void> {
  await db.insert(claimableBalancesSqlite).values(claimableBalanceToRow(cb));
}

export async function getClaimableBalanceByBalanceId(
  balanceId: string,
): Promise<ClaimableBalance | undefined> {
  const result = await db
    .select()
    .from(claimableBalancesSqlite)
    .where(eq(claimableBalancesSqlite.balanceId, balanceId))
    .limit(1);
  return result[0] ? rowToClaimableBalance(result[0]) : undefined;
}

export async function getClaimableBalancesForSeller(
  sellerWallet: string,
): Promise<ClaimableBalance[]> {
  const result = await db
    .select()
    .from(claimableBalancesSqlite)
    .where(eq(claimableBalancesSqlite.sellerWallet, sellerWallet));
  return result.map(rowToClaimableBalance);
}

export async function getReclaimableBalances(nowIso: string): Promise<ClaimableBalance[]> {
  const result = await db
    .select()
    .from(claimableBalancesSqlite)
    .where(
      and(
        eq(claimableBalancesSqlite.status, 'pending'),
        lte(claimableBalancesSqlite.reclaimableAt, nowIso),
      ),
    );
  return result.map(rowToClaimableBalance);
}

export async function updateClaimableBalance(
  id: string,
  updates: Partial<ClaimableBalance>,
): Promise<ClaimableBalance | null> {
  const existing = await db
    .select()
    .from(claimableBalancesSqlite)
    .where(eq(claimableBalancesSqlite.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToClaimableBalance(existing[0]), ...updates };
  await db
    .update(claimableBalancesSqlite)
    .set(claimableBalanceToRow(merged))
    .where(eq(claimableBalancesSqlite.id, id));
  return merged;
}

export async function getUnpaidTransactions(): Promise<Transaction[]> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.sellerPaid, 0));
  return result.map(rowToTransaction);
}

/**
 * Snapshot ids referenced by a completed purchase (#600).
 *
 * These are the rows compaction must never delete: they are the only record of
 * what a buyer actually received, and a dispute has to be resolvable against
 * them long after the retention window would otherwise have dropped them.
 */
export async function getPurchasedSnapshotIds(datasetId?: string): Promise<Set<string>> {
  const conditions = [
    eq(transactionsSqlite.status, 'completed'),
    sql`${transactionsSqlite.snapshotId} IS NOT NULL`,
  ];
  if (datasetId) conditions.push(eq(transactionsSqlite.datasetId, datasetId));
  const result = await db
    .select({ snapshotId: transactionsSqlite.snapshotId })
    .from(transactionsSqlite)
    .where(and(...conditions));
  return new Set(
    result
      .map((row: { snapshotId: string | null }) => row.snapshotId)
      .filter((id: string | null): id is string => typeof id === 'string' && id.length > 0),
  );
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

export async function getTransactionByEscrowId(escrowId: number): Promise<Transaction | undefined> {
  const result = await db
    .select()
    .from(transactionsSqlite)
    .where(eq(transactionsSqlite.escrowId, escrowId))
    .limit(1);
  return result[0] ? rowToTransaction(result[0]) : undefined;
}

// ── Sentinel ─────────────────────────────────────────────────────────────────

const SENTINEL_CURSOR_ID = 'escrow-contract';

export async function getSentinelCursor(): Promise<SentinelCursor | undefined> {
  const result = await db
    .select()
    .from(sentinelCursorSqlite)
    .where(eq(sentinelCursorSqlite.id, SENTINEL_CURSOR_ID))
    .limit(1);
  return result[0] ? rowToSentinelCursor(result[0]) : undefined;
}

export async function saveSentinelCursor(
  updates: Partial<Omit<SentinelCursor, 'id'>>,
): Promise<SentinelCursor> {
  const nowIso = new Date().toISOString();
  const existing = await getSentinelCursor();
  const merged: SentinelCursor = {
    id: SENTINEL_CURSOR_ID,
    cursor: existing?.cursor ?? null,
    lastLedger: existing?.lastLedger ?? 0,
    backfillComplete: existing?.backfillComplete ?? false,
    lastWasmHash: existing?.lastWasmHash ?? null,
    lastProgressAt: existing?.lastProgressAt ?? nowIso,
    ...existing,
    ...updates,
    updatedAt: nowIso,
  };
  if (existing) {
    await db
      .update(sentinelCursorSqlite)
      .set(sentinelCursorToRow(merged))
      .where(eq(sentinelCursorSqlite.id, SENTINEL_CURSOR_ID));
  } else {
    await db.insert(sentinelCursorSqlite).values(sentinelCursorToRow(merged));
  }
  return merged;
}

export async function addSentinelAlert(alert: SentinelAlert): Promise<void> {
  await db.insert(sentinelAlertsSqlite).values(sentinelAlertToRow(alert));
}

export async function getSentinelAlertByDedupeKey(
  dedupeKey: string,
): Promise<SentinelAlert | undefined> {
  const result = await db
    .select()
    .from(sentinelAlertsSqlite)
    .where(eq(sentinelAlertsSqlite.dedupeKey, dedupeKey))
    .limit(1);
  return result[0] ? rowToSentinelAlert(result[0]) : undefined;
}

export async function updateSentinelAlert(
  id: string,
  updates: Partial<SentinelAlert>,
): Promise<SentinelAlert | null> {
  const existing = await db
    .select()
    .from(sentinelAlertsSqlite)
    .where(eq(sentinelAlertsSqlite.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToSentinelAlert(existing[0]), ...updates };
  await db
    .update(sentinelAlertsSqlite)
    .set(sentinelAlertToRow(merged))
    .where(eq(sentinelAlertsSqlite.id, id));
  return merged;
}

export async function getOpenSentinelAlerts(): Promise<SentinelAlert[]> {
  const result = await db
    .select()
    .from(sentinelAlertsSqlite)
    .where(eq(sentinelAlertsSqlite.status, 'open'));
  return result.map(rowToSentinelAlert);
}

export async function getAllSentinelAlerts(): Promise<SentinelAlert[]> {
  const result = await db.select().from(sentinelAlertsSqlite);
  return result.map(rowToSentinelAlert);
}

// ── Bundles (#615) ───────────────────────────────────────────────────────────

/**
 * Thrown when a bundle's persisted components don't sum to 10 000 bps with
 * `curatorFeeBps`. The API layer already validates this on the request body
 * (zod); this is the DB-layer re-check against what actually landed in the
 * table, guarding against a lost/duplicated component write.
 */
export class BundleShareMismatchError extends Error {
  constructor(bundleId: string, sumBps: number) {
    super(`Bundle ${bundleId} components + curator fee sum to ${sumBps} bps, expected 10000`);
    this.name = 'BundleShareMismatchError';
  }
}

/**
 * Persists a bundle and its components, then re-reads what was actually
 * written and asserts the bps invariant against it. If the persisted rows
 * don't sum to exactly 10 000, the bundle and every component just written
 * are deleted and BundleShareMismatchError is thrown — no half-created bundle
 * is ever left behind for a buyer to purchase into.
 */
export async function createBundle(
  bundle: Omit<Bundle, 'components' | 'createdAt' | 'updatedAt'> & {
    createdAt: string;
    updatedAt: string;
  },
  components: BundleComponentRecord[],
): Promise<Bundle> {
  await db.insert(bundlesSqlite).values(bundleToRow(bundle));
  for (const component of components) {
    await db.insert(bundleComponentsSqlite).values(bundleComponentToRow(component));
  }

  const persistedComponents = await getBundleComponents(bundle.id);
  const sumBps = persistedComponents.reduce((sum, c) => sum + c.shareBps, 0) + bundle.curatorFeeBps;
  if (sumBps !== 10_000) {
    await db.delete(bundleComponentsSqlite).where(eq(bundleComponentsSqlite.bundleId, bundle.id));
    await db.delete(bundlesSqlite).where(eq(bundlesSqlite.id, bundle.id));
    throw new BundleShareMismatchError(bundle.id, sumBps);
  }

  return { ...bundle, components: persistedComponents };
}

export async function getBundleComponents(bundleId: string): Promise<BundleComponentRecord[]> {
  const result = await db
    .select()
    .from(bundleComponentsSqlite)
    .where(eq(bundleComponentsSqlite.bundleId, bundleId));
  return result
    .map(rowToBundleComponent)
    .sort((a: BundleComponentRecord, b: BundleComponentRecord) => a.position - b.position);
}

export async function getBundle(id: string): Promise<Bundle | undefined> {
  const result = await db.select().from(bundlesSqlite).where(eq(bundlesSqlite.id, id)).limit(1);
  if (!result[0]) return undefined;
  const components = await getBundleComponents(id);
  return { ...rowToBundle(result[0]), components };
}

export async function getAllBundles(): Promise<Bundle[]> {
  const rows = await db.select().from(bundlesSqlite);
  const bundles = await Promise.all(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows.map(async (row: any) => {
      const components = await getBundleComponents(row.id as string);
      return { ...rowToBundle(row), components };
    }),
  );
  return bundles;
}

export async function getBundlesByCurator(curatorWallet: string): Promise<Bundle[]> {
  const rows = await db
    .select()
    .from(bundlesSqlite)
    .where(eq(bundlesSqlite.curatorWallet, curatorWallet));
  return Promise.all(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows.map(async (row: any) => {
      const components = await getBundleComponents(row.id as string);
      return { ...rowToBundle(row), components };
    }),
  );
}

/** Every bundle that carries at least one component backed by `datasetId` — a seller's "which bundles include my data". */
export async function getBundlesContainingDataset(datasetId: string): Promise<Bundle[]> {
  const componentRows = await db
    .select()
    .from(bundleComponentsSqlite)
    .where(eq(bundleComponentsSqlite.datasetId, datasetId));
  const bundleIds: string[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...new Set<string>(componentRows.map((row: any): string => row.bundleId as string)),
  ];
  const bundles = await Promise.all(bundleIds.map(id => getBundle(id)));
  return bundles.filter((b): b is Bundle => b !== undefined);
}

export async function updateBundle(id: string, updates: Partial<Bundle>): Promise<Bundle | null> {
  const existing = await getBundle(id);
  if (!existing) return null;
  const { components: _components, ...updateFields } = updates;
  const merged = { ...existing, ...updateFields };
  await db.update(bundlesSqlite).set(bundleToRow(merged)).where(eq(bundlesSqlite.id, id));
  return merged;
}

export async function addBundlePurchase(purchase: BundlePurchase): Promise<void> {
  await db.insert(bundlePurchasesSqlite).values(bundlePurchaseToRow(purchase));
}

export async function getBundlePurchase(id: string): Promise<BundlePurchase | undefined> {
  const result = await db
    .select()
    .from(bundlePurchasesSqlite)
    .where(eq(bundlePurchasesSqlite.id, id))
    .limit(1);
  return result[0] ? rowToBundlePurchase(result[0]) : undefined;
}

export async function updateBundlePurchase(
  id: string,
  updates: Partial<BundlePurchase>,
): Promise<BundlePurchase | null> {
  const existing = await getBundlePurchase(id);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  await db
    .update(bundlePurchasesSqlite)
    .set(bundlePurchaseToRow(merged))
    .where(eq(bundlePurchasesSqlite.id, id));
  return merged;
}

export async function getBundlePurchasesForBundle(bundleId: string): Promise<BundlePurchase[]> {
  const result = await db
    .select()
    .from(bundlePurchasesSqlite)
    .where(eq(bundlePurchasesSqlite.bundleId, bundleId));
  return result.map(rowToBundlePurchase);
}

export async function addBundlePurchaseComponent(
  component: BundlePurchaseComponent,
): Promise<void> {
  await db.insert(bundlePurchaseComponentsSqlite).values(bundlePurchaseComponentToRow(component));
}

export async function getBundlePurchaseComponents(
  purchaseId: string,
): Promise<BundlePurchaseComponent[]> {
  const result = await db
    .select()
    .from(bundlePurchaseComponentsSqlite)
    .where(eq(bundlePurchaseComponentsSqlite.purchaseId, purchaseId));
  return result.map(rowToBundlePurchaseComponent);
}

export async function updateBundlePurchaseComponent(
  id: string,
  updates: Partial<BundlePurchaseComponent>,
): Promise<BundlePurchaseComponent | null> {
  const existing = await db
    .select()
    .from(bundlePurchaseComponentsSqlite)
    .where(eq(bundlePurchaseComponentsSqlite.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const merged = { ...rowToBundlePurchaseComponent(existing[0]), ...updates };
  await db
    .update(bundlePurchaseComponentsSqlite)
    .set(bundlePurchaseComponentToRow(merged))
    .where(eq(bundlePurchaseComponentsSqlite.id, id));
  return merged;
}

/** Every purchase-component leg paid to `sellerWallet` — a seller's "what did bundles earn me". */
export async function getBundlePurchaseComponentsForSeller(
  sellerWallet: string,
): Promise<BundlePurchaseComponent[]> {
  const result = await db
    .select()
    .from(bundlePurchaseComponentsSqlite)
    .where(eq(bundlePurchaseComponentsSqlite.sellerWallet, sellerWallet));
  return result.map(rowToBundlePurchaseComponent);
}

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, numeric, boolean, index } from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  text as sqliteText,
  integer as sqliteInteger,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';

// ── PostgreSQL tables ────────────────────────────────────────────────────────

export const datasets = pgTable(
  'datasets',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    type: text('type').notNull(),
    category: text('category').notNull().default('other'),
    pricePerQuery: numeric('price_per_query').notNull(),
    paymentToken: text('payment_token').notNull().default('USDC'),
    sellerWallet: text('seller_wallet').notNull(),
    notificationEmail: text('notification_email'),
    data: text('data').notNull().default('{}'),
    queriesServed: integer('queries_served').notNull().default(0),
    totalEarned: numeric('total_earned').notNull().default('0'),
    createdAt: text('created_at').notNull(),
    ratings: text('ratings'),
    priceHistory: text('price_history'),
    provider: text('provider'),
    live: boolean('live').notNull().default(false),
    lastRefreshedAt: text('last_refreshed_at'),
    tags: text('tags'),
    snapshotPolicy: text('snapshot_policy'),
  },
  table => ({
    typeIdx: index('datasets_type_idx').on(table.type),
    categoryIdx: index('datasets_category_idx').on(table.category),
    sellerWalletIdx: index('datasets_seller_wallet_idx').on(table.sellerWallet),
    createdAtIdx: index('datasets_created_at_idx').on(table.createdAt),
  }),
);

export const transactions = pgTable('transactions', {
  id: text('id').primaryKey(),
  datasetId: text('dataset_id').notNull(),
  txHash: text('tx_hash').notNull().unique(),
  amount: numeric('amount').notNull(),
  paymentToken: text('payment_token').notNull().default('USDC'),
  buyerWallet: text('buyer_wallet'),
  memo: text('memo'),
  status: text('status'),
  deliveryStatus: text('delivery_status'),
  sellerPaid: integer('seller_paid'),
  sellerAmount: numeric('seller_amount'),
  sellerTxHash: text('seller_tx_hash'),
  sellerNotifiedAt: text('seller_notified_at'),
  sellerNotificationError: text('seller_notification_error'),
  sellerNotificationAttempts: integer('seller_notification_attempts'),
  buyerQuery: text('buyer_query'),
  aiSummary: text('ai_summary'),
  deliveryAttempts: integer('delivery_attempts'),
  deliveryError: text('delivery_error'),
  verifiedAt: text('verified_at'),
  deliveredAt: text('delivered_at'),
  escrowId: integer('escrow_id'),
  balanceId: text('balance_id'),
  snapshotId: text('snapshot_id'),
  timestamp: text('timestamp').notNull(),
});

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  sellerWallet: text('seller_wallet').notNull(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: text('events')
    .array()
    .notNull()
    .default(sql`'{}'`),
  active: boolean('active').notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const payoutFailures = pgTable('payout_failures', {
  id: text('id').primaryKey(),
  datasetId: text('dataset_id').notNull(),
  sellerWallet: text('seller_wallet').notNull(),
  buyerTxHash: text('buyer_tx_hash').notNull().unique(),
  intendedAmount: numeric('intended_amount').notNull(),
  paymentToken: text('payment_token').notNull().default('USDC'),
  sellerTxHash: text('seller_tx_hash'),
  status: text('status').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: text('next_retry_at').notNull(),
  lastError: text('last_error').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const claimableBalances = pgTable('claimable_balances', {
  id: text('id').primaryKey(),
  balanceId: text('balance_id').notNull().unique(),
  datasetId: text('dataset_id').notNull(),
  sellerWallet: text('seller_wallet').notNull(),
  buyerTxHash: text('buyer_tx_hash').notNull(),
  amount: numeric('amount').notNull(),
  paymentToken: text('payment_token').notNull().default('USDC'),
  status: text('status').notNull(),
  creationTxHash: text('creation_tx_hash').notNull(),
  reclaimableAt: text('reclaimable_at').notNull(),
  claimedTxHash: text('claimed_tx_hash'),
  claimedAt: text('claimed_at'),
  reclaimedTxHash: text('reclaimed_tx_hash'),
  reclaimedAt: text('reclaimed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Immutable, content-addressed history of every dataset payload (#600).
 *
 * A snapshot owns a half-open validity interval `[valid_from, valid_to)`; the
 * single row with `valid_to IS NULL` is the payload that is live right now. Two
 * consecutive refreshes that produce the same `content_hash` never create a
 * second row — the existing one records another observation instead.
 */
export const datasetSnapshots = pgTable(
  'dataset_snapshots',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    contentHash: text('content_hash').notNull(),
    payload: text('payload').notNull(),
    encoding: text('encoding').notNull().default('gzip+base64'),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    byteSize: integer('byte_size').notNull(),
    rawByteSize: integer('raw_byte_size').notNull(),
    observations: integer('observations').notNull().default(1),
    lastObservedAt: text('last_observed_at').notNull(),
    providerRunId: text('provider_run_id'),
    createdAt: text('created_at').notNull(),
  },
  table => ({
    datasetValidFromIdx: index('dataset_snapshots_dataset_valid_from_idx').on(
      table.datasetId,
      table.validFrom,
    ),
    contentHashIdx: index('dataset_snapshots_content_hash_idx').on(table.contentHash),
    currentIdx: index('dataset_snapshots_current_idx').on(table.datasetId, table.validTo),
  }),
);

export const sentinelCursor = pgTable('sentinel_cursor', {
  id: text('id').primaryKey(),
  cursor: text('cursor'),
  lastLedger: integer('last_ledger').notNull().default(0),
  backfillComplete: boolean('backfill_complete').notNull().default(false),
  lastWasmHash: text('last_wasm_hash'),
  lastProgressAt: text('last_progress_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sentinelAlerts = pgTable('sentinel_alerts', {
  id: text('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  invariant: text('invariant').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  escrowId: integer('escrow_id'),
  txHash: text('tx_hash'),
  ledger: integer('ledger'),
  message: text('message').notNull(),
  details: text('details'),
  count: integer('count').notNull().default(1),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  lastNotifiedAt: text('last_notified_at'),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
});

/**
 * Verifiable delivery receipts — cryptographic commitments to delivered data.
 * Each receipt binds a delivered payload to a specific purchase and anchors
 * the commitment on-chain (direct or batched).
 */
export const receipts = pgTable(
  'receipts',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    buyer: text('buyer').notNull(),
    seller: text('seller').notNull(),
    amount: numeric('amount').notNull(),
    paymentToken: text('payment_token').notNull().default('USDC'),
    txHash: text('tx_hash').notNull().unique(),
    leafHash: text('leaf_hash').notNull(),
    receiptHash: text('receipt_hash').notNull().unique(),
    anchorMode: text('anchor_mode').notNull(),
    anchorStatus: text('anchor_status').notNull(),
    anchorTxHash: text('anchor_tx_hash'),
    merkleRoot: text('merkle_root'),
    merkleIndex: integer('merkle_index'),
    merkleProof: text('merkle_proof'),
    deliveredAt: text('delivered_at').notNull(),
    anchoredAt: text('anchored_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  table => ({
    datasetIdx: index('receipts_dataset_idx').on(table.datasetId),
    buyerIdx: index('receipts_buyer_idx').on(table.buyer),
    sellerIdx: index('receipts_seller_idx').on(table.seller),
    txHashIdx: index('receipts_tx_hash_idx').on(table.txHash),
    receiptHashIdx: index('receipts_receipt_hash_idx').on(table.receiptHash),
    anchorStatusIdx: index('receipts_anchor_status_idx').on(table.anchorStatus),
  }),
);

/**
 * SEP-10 challenge nonces.
 *
 * A challenge transaction is single-use: it must be redeemed exactly once before
 * it expires, and the redeeming account must be the one the challenge was
 * issued to. `redeemedAt` turns the redemption into an atomic conditional
 * update (UPDATE ... WHERE redeemed_at IS NULL AND expires_at > now), which is
 * what makes replay attacks structurally unreachable regardless of concurrency.
 */
export const sep10Nonces = pgTable(
  'sep10_nonces',
  {
    nonce: text('nonce').primaryKey(),
    clientAccount: text('client_account').notNull(),
    homeDomain: text('home_domain').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    redeemedAt: integer('redeemed_at'),
  },
  table => ({
    expiresAtIdx: index('sep10_nonces_expires_at_idx').on(table.expiresAt),
  }),
);

// ── SQLite tables (used when DATABASE_URL is not postgres) ───────────────────

export const datasetsSqlite = sqliteTable(
  'datasets',
  {
    id: sqliteText('id').primaryKey(),
    name: sqliteText('name').notNull(),
    description: sqliteText('description').notNull(),
    type: sqliteText('type').notNull(),
    category: sqliteText('category').notNull().default('other'),
    pricePerQuery: sqliteText('price_per_query').notNull(),
    paymentToken: sqliteText('payment_token').notNull().default('USDC'),
    sellerWallet: sqliteText('seller_wallet').notNull(),
    notificationEmail: sqliteText('notification_email'),
    data: sqliteText('data').notNull().default('{}'),
    queriesServed: sqliteInteger('queries_served').notNull().default(0),
    totalEarned: sqliteText('total_earned').notNull().default('0'),
    createdAt: sqliteText('created_at').notNull(),
    ratings: sqliteText('ratings'),
    priceHistory: sqliteText('price_history'),
    provider: sqliteText('provider'),
    live: sqliteInteger('live').notNull().default(0),
    lastRefreshedAt: sqliteText('last_refreshed_at'),
    tags: sqliteText('tags'),
    snapshotPolicy: sqliteText('snapshot_policy'),
  },
  table => ({
    typeIdx: sqliteIndex('datasets_type_idx').on(table.type),
    categoryIdx: sqliteIndex('datasets_category_idx').on(table.category),
    sellerWalletIdx: sqliteIndex('datasets_seller_wallet_idx').on(table.sellerWallet),
    createdAtIdx: sqliteIndex('datasets_created_at_idx').on(table.createdAt),
  }),
);

export const transactionsSqlite = sqliteTable('transactions', {
  id: sqliteText('id').primaryKey(),
  datasetId: sqliteText('dataset_id').notNull(),
  txHash: sqliteText('tx_hash').notNull().unique(),
  amount: sqliteText('amount').notNull(),
  paymentToken: sqliteText('payment_token').notNull().default('USDC'),
  buyerWallet: sqliteText('buyer_wallet'),
  memo: sqliteText('memo'),
  status: sqliteText('status'),
  deliveryStatus: sqliteText('delivery_status'),
  sellerPaid: sqliteInteger('seller_paid'),
  sellerAmount: sqliteText('seller_amount'),
  sellerTxHash: sqliteText('seller_tx_hash'),
  sellerNotifiedAt: sqliteText('seller_notified_at'),
  sellerNotificationError: sqliteText('seller_notification_error'),
  sellerNotificationAttempts: sqliteInteger('seller_notification_attempts'),
  buyerQuery: sqliteText('buyer_query'),
  aiSummary: sqliteText('ai_summary'),
  deliveryAttempts: sqliteInteger('delivery_attempts'),
  deliveryError: sqliteText('delivery_error'),
  verifiedAt: sqliteText('verified_at'),
  deliveredAt: sqliteText('delivered_at'),
  escrowId: sqliteInteger('escrow_id'),
  balanceId: sqliteText('balance_id'),
  snapshotId: sqliteText('snapshot_id'),
  timestamp: sqliteText('timestamp').notNull(),
});

export const webhooksSqlite = sqliteTable('webhooks', {
  id: sqliteText('id').primaryKey(),
  sellerWallet: sqliteText('seller_wallet').notNull(),
  url: sqliteText('url').notNull(),
  secret: sqliteText('secret').notNull(),
  events: sqliteText('events').notNull().default('[]'),
  active: sqliteInteger('active').notNull().default(1),
  createdAt: sqliteText('created_at').notNull(),
});

export const payoutFailuresSqlite = sqliteTable('payout_failures', {
  id: sqliteText('id').primaryKey(),
  datasetId: sqliteText('dataset_id').notNull(),
  sellerWallet: sqliteText('seller_wallet').notNull(),
  buyerTxHash: sqliteText('buyer_tx_hash').notNull().unique(),
  intendedAmount: sqliteText('intended_amount').notNull(),
  paymentToken: sqliteText('payment_token').notNull().default('USDC'),
  sellerTxHash: sqliteText('seller_tx_hash'),
  status: sqliteText('status').notNull(),
  retryCount: sqliteInteger('retry_count').notNull().default(0),
  nextRetryAt: sqliteText('next_retry_at').notNull(),
  lastError: sqliteText('last_error').notNull(),
  createdAt: sqliteText('created_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
});

export const claimableBalancesSqlite = sqliteTable('claimable_balances', {
  id: sqliteText('id').primaryKey(),
  balanceId: sqliteText('balance_id').notNull().unique(),
  datasetId: sqliteText('dataset_id').notNull(),
  sellerWallet: sqliteText('seller_wallet').notNull(),
  buyerTxHash: sqliteText('buyer_tx_hash').notNull(),
  amount: sqliteText('amount').notNull(),
  paymentToken: sqliteText('payment_token').notNull().default('USDC'),
  status: sqliteText('status').notNull(),
  creationTxHash: sqliteText('creation_tx_hash').notNull(),
  reclaimableAt: sqliteText('reclaimable_at').notNull(),
  claimedTxHash: sqliteText('claimed_tx_hash'),
  claimedAt: sqliteText('claimed_at'),
  reclaimedTxHash: sqliteText('reclaimed_tx_hash'),
  reclaimedAt: sqliteText('reclaimed_at'),
  createdAt: sqliteText('created_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
});

/** SQLite mirror of {@link datasetSnapshots}. */
export const datasetSnapshotsSqlite = sqliteTable(
  'dataset_snapshots',
  {
    id: sqliteText('id').primaryKey(),
    datasetId: sqliteText('dataset_id').notNull(),
    contentHash: sqliteText('content_hash').notNull(),
    payload: sqliteText('payload').notNull(),
    encoding: sqliteText('encoding').notNull().default('gzip+base64'),
    validFrom: sqliteText('valid_from').notNull(),
    validTo: sqliteText('valid_to'),
    byteSize: sqliteInteger('byte_size').notNull(),
    rawByteSize: sqliteInteger('raw_byte_size').notNull(),
    observations: sqliteInteger('observations').notNull().default(1),
    lastObservedAt: sqliteText('last_observed_at').notNull(),
    providerRunId: sqliteText('provider_run_id'),
    createdAt: sqliteText('created_at').notNull(),
  },
  table => ({
    datasetValidFromIdx: sqliteIndex('dataset_snapshots_dataset_valid_from_idx').on(
      table.datasetId,
      table.validFrom,
    ),
    contentHashIdx: sqliteIndex('dataset_snapshots_content_hash_idx').on(table.contentHash),
    currentIdx: sqliteIndex('dataset_snapshots_current_idx').on(table.datasetId, table.validTo),
  }),
);

export const sentinelCursorSqlite = sqliteTable('sentinel_cursor', {
  id: sqliteText('id').primaryKey(),
  cursor: sqliteText('cursor'),
  lastLedger: sqliteInteger('last_ledger').notNull().default(0),
  backfillComplete: sqliteInteger('backfill_complete').notNull().default(0),
  lastWasmHash: sqliteText('last_wasm_hash'),
  lastProgressAt: sqliteText('last_progress_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
});

export const sentinelAlertsSqlite = sqliteTable('sentinel_alerts', {
  id: sqliteText('id').primaryKey(),
  dedupeKey: sqliteText('dedupe_key').notNull().unique(),
  invariant: sqliteText('invariant').notNull(),
  severity: sqliteText('severity').notNull(),
  status: sqliteText('status').notNull(),
  escrowId: sqliteInteger('escrow_id'),
  txHash: sqliteText('tx_hash'),
  ledger: sqliteInteger('ledger'),
  message: sqliteText('message').notNull(),
  details: sqliteText('details'),
  count: sqliteInteger('count').notNull().default(1),
  firstSeenAt: sqliteText('first_seen_at').notNull(),
  lastSeenAt: sqliteText('last_seen_at').notNull(),
  lastNotifiedAt: sqliteText('last_notified_at'),
  resolvedAt: sqliteText('resolved_at'),
  resolvedBy: sqliteText('resolved_by'),
});

/** SQLite mirror of {@link receipts}. */
export const receiptsSqlite = sqliteTable(
  'receipts',
  {
    id: sqliteText('id').primaryKey(),
    datasetId: sqliteText('dataset_id').notNull(),
    buyer: sqliteText('buyer').notNull(),
    seller: sqliteText('seller').notNull(),
    amount: sqliteText('amount').notNull(),
    paymentToken: sqliteText('payment_token').notNull().default('USDC'),
    txHash: sqliteText('tx_hash').notNull().unique(),
    leafHash: sqliteText('leaf_hash').notNull(),
    receiptHash: sqliteText('receipt_hash').notNull().unique(),
    anchorMode: sqliteText('anchor_mode').notNull(),
    anchorStatus: sqliteText('anchor_status').notNull(),
    anchorTxHash: sqliteText('anchor_tx_hash'),
    merkleRoot: sqliteText('merkle_root'),
    merkleIndex: sqliteInteger('merkle_index'),
    merkleProof: sqliteText('merkle_proof'),
    deliveredAt: sqliteText('delivered_at').notNull(),
    anchoredAt: sqliteText('anchored_at'),
    createdAt: sqliteText('created_at').notNull(),
    updatedAt: sqliteText('updated_at').notNull(),
  },
  table => ({
    datasetIdx: sqliteIndex('receipts_dataset_idx').on(table.datasetId),
    buyerIdx: sqliteIndex('receipts_buyer_idx').on(table.buyer),
    sellerIdx: sqliteIndex('receipts_seller_idx').on(table.seller),
    txHashIdx: sqliteIndex('receipts_tx_hash_idx').on(table.txHash),
    receiptHashIdx: sqliteIndex('receipts_receipt_hash_idx').on(table.receiptHash),
    anchorStatusIdx: sqliteIndex('receipts_anchor_status_idx').on(table.anchorStatus),
  }),
);

/** SQLite mirror of {@link sep10Nonces}. */
export const sep10NoncesSqlite = sqliteTable(
  'sep10_nonces',
  {
    nonce: sqliteText('nonce').primaryKey(),
    clientAccount: sqliteText('client_account').notNull(),
    homeDomain: sqliteText('home_domain').notNull(),
    expiresAt: sqliteInteger('expires_at').notNull(),
    createdAt: sqliteInteger('created_at').notNull(),
    redeemedAt: sqliteInteger('redeemed_at'),
  },
  table => ({
    expiresAtIdx: sqliteIndex('sep10_nonces_expires_at_idx').on(table.expiresAt),
  }),
);

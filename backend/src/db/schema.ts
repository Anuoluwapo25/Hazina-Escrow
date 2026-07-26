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
  },
  table => ({
    typeIdx: index('datasets_type_idx').on(table.type),
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
  sellerTxHash: text('seller_tx_hash'),
  status: text('status').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: text('next_retry_at').notNull(),
  lastError: text('last_error').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── SQLite tables (used when DATABASE_URL is not postgres) ───────────────────

export const datasetsSqlite = sqliteTable(
  'datasets',
  {
    id: sqliteText('id').primaryKey(),
    name: sqliteText('name').notNull(),
    description: sqliteText('description').notNull(),
    type: sqliteText('type').notNull(),
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
  },
  table => ({
    typeIdx: sqliteIndex('datasets_type_idx').on(table.type),
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
  sellerTxHash: sqliteText('seller_tx_hash'),
  status: sqliteText('status').notNull(),
  retryCount: sqliteInteger('retry_count').notNull().default(0),
  nextRetryAt: sqliteText('next_retry_at').notNull(),
  lastError: sqliteText('last_error').notNull(),
  createdAt: sqliteText('created_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
});

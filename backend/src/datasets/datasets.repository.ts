import db from '../db/client';
import { datasets as datasetsTable, transactions as transactionsTable } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import type { Dataset, Transaction } from '../common/storage';

type DatasetRow = {
  id: string;
  name: string;
  description: string;
  type: string;
  category: string | null;
  pricePerQuery: string;
  sellerWallet: string;
  notificationEmail: string | null;
  data: string;
  queriesServed: number;
  totalEarned: string;
  createdAt: string;
  provider: string | null;
  live: number | boolean | null;
  lastRefreshedAt: string | null;
  tags: string | null;
};

type TransactionRow = {
  id: string;
  datasetId: string;
  txHash: string;
  amount: string;
  buyerQuery: string | null;
  aiSummary: string | null;
  timestamp: string;
};

function mapDataset(row: DatasetRow): Dataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    category: row.category ?? undefined,
    pricePerQuery: Number(row.pricePerQuery),
    sellerWallet: row.sellerWallet,
    notificationEmail: row.notificationEmail ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
    queriesServed: row.queriesServed,
    totalEarned: Number(row.totalEarned),
    createdAt: row.createdAt,
    provider: row.provider ?? undefined,
    live: row.live === null || row.live === undefined ? undefined : Boolean(row.live),
    lastRefreshedAt: row.lastRefreshedAt ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
  };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    datasetId: row.datasetId,
    txHash: row.txHash,
    amount: Number(row.amount),
    buyerQuery: row.buyerQuery ?? undefined,
    aiSummary: row.aiSummary ?? undefined,
    timestamp: row.timestamp,
  };
}

export async function getAllDatasets(): Promise<Dataset[]> {
  const rows = await db.select().from(datasetsTable);
  return rows.map(mapDataset);
}

export async function getDataset(id: string): Promise<Dataset | undefined> {
  const rows = await db.select().from(datasetsTable).where(eq(datasetsTable.id, id)).limit(1);
  return rows[0] ? mapDataset(rows[0] as DatasetRow) : undefined;
}

export async function addDataset(dataset: Dataset): Promise<void> {
  await db.insert(datasetsTable).values({
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    type: dataset.type,
    category: dataset.category ?? 'other',
    pricePerQuery: dataset.pricePerQuery.toString(),
    sellerWallet: dataset.sellerWallet,
    notificationEmail: dataset.notificationEmail,
    data: JSON.stringify(dataset.data),
    queriesServed: dataset.queriesServed,
    totalEarned: dataset.totalEarned.toString(),
    createdAt: dataset.createdAt,
    provider: dataset.provider ?? null,
    live: dataset.live ?? false,
    lastRefreshedAt: dataset.lastRefreshedAt ?? null,
    tags: dataset.tags !== undefined ? JSON.stringify(dataset.tags) : null,
  });
}

export async function getTransactions(
  datasetId?: string,
  limit?: number,
  offset?: number,
): Promise<Transaction[]> {
  let query = db.select().from(transactionsTable).$dynamic();
  if (datasetId) query = query.where(eq(transactionsTable.datasetId, datasetId));
  if (offset !== undefined && offset > 0) query = query.offset(offset);
  if (limit !== undefined && limit > 0) query = query.limit(limit);
  const rows = await query;
  return (rows as TransactionRow[]).map(r => mapTransaction(r));
}

export async function getTransactionsCount(datasetId?: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(transactionsTable)
    .where(datasetId ? eq(transactionsTable.datasetId, datasetId) : undefined);
  return Number(rows[0]?.count ?? 0);
}

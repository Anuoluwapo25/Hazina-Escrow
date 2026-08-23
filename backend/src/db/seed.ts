import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import db from './client';
import { datasets, transactions, datasetsSqlite, transactionsSqlite } from './schema';
import { logger } from '../lib/logger';
import { getProviderById } from '../providers/registry';

const isPostgres =
  (process.env.DATABASE_URL ?? '').startsWith('postgres://') ||
  (process.env.DATABASE_URL ?? '').startsWith('postgresql://');

const datasetsTable = isPostgres ? datasets : datasetsSqlite;
const transactionsTable = isPostgres ? transactions : transactionsSqlite;

interface DatasetFromJSON {
  id: string;
  name: string;
  description: string;
  type: string;
  category?: string;
  pricePerQuery: number;
  sellerWallet: string;
  data: Record<string, unknown>;
  queriesServed: number;
  totalEarned: number;
  createdAt: string;
  provider?: string;
  live?: boolean;
  tags?: string[];
}

interface TransactionFromJSON {
  id: string;
  datasetId: string;
  txHash: string;
  amount: number;
  buyerQuery?: string;
  aiSummary?: string;
  timestamp: string;
}

async function seedDatasets(jsonData: Record<string, unknown>): Promise<void> {
  if (!jsonData.datasets || !Array.isArray(jsonData.datasets)) {
    return;
  }

  for (const dataset of jsonData.datasets as DatasetFromJSON[]) {
    const existing = await db
      .select()
      .from(datasetsTable as typeof datasets)
      .where(eq((datasetsTable as typeof datasets).id, dataset.id))
      .limit(1);

    if (existing.length > 0) {
      logger.info(`⊘ Dataset already exists: ${dataset.id}`);
      continue;
    }

    // Bootstrap live datasets with an initial provider snapshot so the
    // marketplace has real (or fallback) data immediately after seeding.
    let data = dataset.data;
    let lastRefreshedAt: string | null = null;
    if (dataset.live && dataset.provider) {
      const provider = getProviderById(dataset.provider);
      if (provider) {
        try {
          const snapshot = await provider.refresh();
          data = {
            ...snapshot.data,
            _points: snapshot.points,
            _headline: snapshot.headline,
            _live: snapshot.live,
            _fetchedAt: snapshot.fetchedAt,
          };
          lastRefreshedAt = snapshot.fetchedAt;
        } catch (err) {
          logger.warn(
            `Could not bootstrap live snapshot for ${dataset.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await db.insert(datasetsTable as typeof datasets).values({
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      type: dataset.type,
      category: dataset.category ?? 'other',
      pricePerQuery: dataset.pricePerQuery.toString(),
      sellerWallet: dataset.sellerWallet,
      data: JSON.stringify(data),
      queriesServed: dataset.queriesServed,
      totalEarned: dataset.totalEarned.toString(),
      createdAt: dataset.createdAt,
      provider: dataset.provider ?? null,
      live: (isPostgres ? (dataset.live ?? false) : dataset.live ? 1 : 0) as never,
      lastRefreshedAt,
      tags: dataset.tags !== undefined ? JSON.stringify(dataset.tags) : null,
    });
    logger.info(`✓ Inserted dataset: ${dataset.id}`);
  }
}

async function seedTransactions(jsonData: Record<string, unknown>): Promise<void> {
  if (!jsonData.transactions || !Array.isArray(jsonData.transactions)) {
    return;
  }

  for (const tx of jsonData.transactions as TransactionFromJSON[]) {
    const existing = await db
      .select()
      .from(transactionsTable as typeof transactions)
      .where(eq((transactionsTable as typeof transactions).txHash, tx.txHash))
      .limit(1);

    if (existing.length > 0) {
      logger.info(`⊘ Transaction already exists: ${tx.txHash}`);
      continue;
    }

    await db.insert(transactionsTable as typeof transactions).values({
      id: tx.id,
      datasetId: tx.datasetId,
      txHash: tx.txHash,
      amount: tx.amount.toString(),
      buyerQuery: tx.buyerQuery || null,
      aiSummary: tx.aiSummary || null,
      timestamp: tx.timestamp,
    });
    logger.info(`✓ Inserted transaction: ${tx.txHash}`);
  }
}

async function seed(): Promise<void> {
  try {
    // SEED_DATA_PATH lets the local devnet seed the marketplace with its own
    // deterministic datasets (whose sellerWallet values are real devnet
    // addresses) instead of the demo fixtures. See docs/DEVNET.md.
    //   SEED_DATA_PATH=../data/devnet.datasets.json npm run seed --prefix backend
    const dataPath = process.env.SEED_DATA_PATH
      ? resolve(process.cwd(), process.env.SEED_DATA_PATH)
      : resolve(__dirname, '../../data/datasets.json');
    const fileContent = await fs.readFile(dataPath, 'utf-8');
    const jsonData = JSON.parse(fileContent);

    logger.info(`Seeding database from ${dataPath}...`);

    await seedDatasets(jsonData);
    await seedTransactions(jsonData);

    logger.info('Seeding complete!');
    process.exit(0);
  } catch (error) {
    logger.error(`Seed error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

seed();

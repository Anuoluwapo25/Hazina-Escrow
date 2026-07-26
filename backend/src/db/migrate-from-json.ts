/**
 * One-time migration script: reads the legacy data/datasets.json file and
 * inserts all records into the SQLite database via the storage layer.
 *
 * Usage:
 *   npx ts-node src/db/migrate-from-json.ts
 *
 * Set DATA_PATH env var to override the default path to datasets.json.
 * Set DATABASE_URL env var to target a PostgreSQL database instead of SQLite.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
  addDataset,
  addTransaction,
  addWebhook,
  addPayoutFailure,
  writeStore,
  type Store,
} from '../common/storage';

const DATA_PATH = process.env.DATA_PATH || path.resolve(process.cwd(), 'data/datasets.json');

async function migrate(): Promise<void> {
  if (!existsSync(DATA_PATH)) {
    console.log(`No JSON file found at ${DATA_PATH}. Nothing to migrate.`);
    return;
  }

  const raw = readFileSync(DATA_PATH, 'utf-8');
  const store = JSON.parse(raw) as Partial<Store>;

  const datasets = Array.isArray(store.datasets) ? store.datasets : [];
  const transactions = Array.isArray(store.transactions) ? store.transactions : [];
  const webhooks = Array.isArray(store.webhooks) ? store.webhooks : [];
  const payoutFailures = Array.isArray(store.payoutFailures) ? store.payoutFailures : [];

  console.log(
    `Migrating: ${datasets.length} datasets, ${transactions.length} transactions, ` +
      `${webhooks.length} webhooks, ${payoutFailures.length} payout failures`,
  );

  // Clear existing data then bulk-insert to avoid partial duplicates on re-run.
  await writeStore({ datasets: [], transactions: [], webhooks: [], payoutFailures: [] });

  for (const dataset of datasets) {
    await addDataset(dataset);
    console.log(`  dataset: ${dataset.id}`);
  }

  for (const tx of transactions) {
    await addTransaction(tx);
  }
  if (transactions.length > 0) console.log(`  ${transactions.length} transactions`);

  for (const webhook of webhooks) {
    await addWebhook(webhook);
  }
  if (webhooks.length > 0) console.log(`  ${webhooks.length} webhooks`);

  for (const pf of payoutFailures) {
    await addPayoutFailure(pf);
  }
  if (payoutFailures.length > 0) console.log(`  ${payoutFailures.length} payout failures`);

  console.log('Migration complete.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

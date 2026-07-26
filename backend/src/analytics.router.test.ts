import express, { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsRouter } from './analytics.router';
import { writeStore, type Dataset, type Store, type Transaction } from './common/storage';

const SELLER = `G${'S'.repeat(55)}`;
const OTHER_SELLER = `G${'O'.repeat(55)}`;

const datasets: Dataset[] = [
  {
    id: 'seller-ds-1',
    name: 'Seller Dataset One',
    description: 'First seller dataset',
    type: 'yield-data',
    pricePerQuery: 2,
    sellerWallet: SELLER,
    data: {},
    queriesServed: 2,
    totalEarned: 3.8,
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'seller-ds-2',
    name: 'Seller Dataset Two',
    description: 'Second seller dataset',
    type: 'sentiment',
    pricePerQuery: 3,
    sellerWallet: SELLER,
    data: {},
    queriesServed: 1,
    totalEarned: 2.85,
    createdAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'other-ds',
    name: 'Other Seller Dataset',
    description: 'Must not leak into analytics',
    type: 'wallets',
    pricePerQuery: 9,
    sellerWallet: OTHER_SELLER,
    data: {},
    queriesServed: 1,
    totalEarned: 8.55,
    createdAt: '2026-05-03T00:00:00.000Z',
  },
];

const transactions: Transaction[] = [
  {
    id: 'tx-1',
    datasetId: 'seller-ds-1',
    txHash: 'hash-1',
    buyerWallet: 'GBUYER1111111111111111111111111111111111111111111111111',
    amount: 2,
    timestamp: '2026-06-15T10:00:00.000Z',
  },
  {
    id: 'tx-2',
    datasetId: 'seller-ds-1',
    txHash: 'hash-2',
    buyerWallet: 'GBUYER1111111111111111111111111111111111111111111111111',
    amount: 2,
    timestamp: '2026-06-15T12:00:00.000Z',
  },
  {
    id: 'tx-3',
    datasetId: 'seller-ds-2',
    txHash: 'hash-3',
    buyerWallet: 'GBUYER2222222222222222222222222222222222222222222222222',
    amount: 3,
    timestamp: '2026-06-16T09:00:00.000Z',
  },
  {
    id: 'tx-other',
    datasetId: 'other-ds',
    txHash: 'hash-other',
    buyerWallet: 'GOTHERBUYER',
    amount: 9,
    timestamp: '2026-06-15T09:00:00.000Z',
  },
];

function makeApp(): Express {
  const app = express();
  app.use('/api/analytics', analyticsRouter);
  return app;
}

describe('analyticsRouter', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T00:00:00.000Z'));
    const store: Store = { datasets, transactions, webhooks: [], payoutFailures: [] };
    await writeStore(store);
  });

  it('aggregates seller revenue, query volume, datasets, and buyers', async () => {
    const res = await request(makeApp()).get(`/api/analytics/seller/${SELLER}`).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.revenueSeries).toHaveLength(30);
    expect(res.body.queryVolumeSeries).toHaveLength(30);
    expect(res.body.revenueSeries.at(-3)).toEqual({ date: '2026-06-15', usdc: 3.8 });
    expect(res.body.queryVolumeSeries.at(-3)).toEqual({ date: '2026-06-15', count: 2 });
    expect(res.body.revenueSeries.at(-2)).toEqual({ date: '2026-06-16', usdc: 2.85 });
    expect(res.body.datasetBreakdown).toEqual([
      { id: 'seller-ds-1', name: 'Seller Dataset One', earned: 3.8, queries: 2 },
      { id: 'seller-ds-2', name: 'Seller Dataset Two', earned: 2.85, queries: 1 },
    ]);
    expect(res.body.topBuyers[0]).toEqual({ wallet: transactions[0]?.buyerWallet, count: 2 });
    expect(JSON.stringify(res.body)).not.toContain('other-ds');
    expect(JSON.stringify(res.body)).not.toContain('GOTHERBUYER');
  });
});

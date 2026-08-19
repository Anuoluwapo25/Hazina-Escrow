import crypto from 'crypto';
import express, { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { writeStore, type Dataset, type Store, type Transaction } from '../common/storage';
import { datasetsRouter } from '../datasets/datasets.router';
import { deleteSnapshotsForDataset, listAllSnapshots } from './snapshots.repository';
import { recordDatasetSnapshot } from './snapshots.service';
import { snapshotsRouter } from './snapshots.router';
import { MAX_SNAPSHOTS_PER_REQUEST } from './snapshots.types';

const SELLER = `G${'A'.repeat(55)}`;
const OTHER_SELLER = `G${'B'.repeat(55)}`;
const DATASET_ID = 'ds-history-api';
const JWT_SECRET = 'test-secret';

const dataset: Dataset = {
  id: DATASET_ID,
  name: 'Whale Movements',
  description: 'Large stellar wallet movements',
  type: 'whale-data',
  pricePerQuery: 1,
  sellerWallet: SELLER,
  data: { wallets: [] },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: '2026-07-01T00:00:00.000Z',
};

const purchase: Transaction = {
  id: 'tx-history',
  datasetId: DATASET_ID,
  txHash: 'hash-completed',
  amount: 1,
  status: 'completed',
  timestamp: '2026-08-03T13:00:00.000Z',
};

const pendingPurchase: Transaction = {
  id: 'tx-pending',
  datasetId: DATASET_ID,
  txHash: 'hash-pending',
  amount: 1,
  status: 'verified',
  timestamp: '2026-08-03T13:00:00.000Z',
};

const TIMELINE = [
  { at: '2026-08-03T00:00:00.000Z', payload: { wallets: [{ address: 'GA', balance: 1 }] } },
  { at: '2026-08-03T06:00:00.000Z', payload: { wallets: [{ address: 'GA', balance: 2 }] } },
  {
    at: '2026-08-03T12:00:00.000Z',
    payload: {
      wallets: [
        { address: 'GA', balance: 2 },
        { address: 'GB', balance: 7 },
      ],
    },
  },
];

/** Index into a fixture list, failing loudly instead of yielding `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/datasets', snapshotsRouter);
  return app;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sellerToken(sellerWallet: string): string {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson({
    sellerWallet,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

const app = makeApp();
const originalSecret = process.env.SELLER_JWT_SECRET;

beforeEach(async () => {
  process.env.SELLER_JWT_SECRET = JWT_SECRET;
  const store: Store = {
    datasets: [dataset],
    transactions: [purchase, pendingPurchase],
    webhooks: [],
    payoutFailures: [],
  };
  await writeStore(store);
  await deleteSnapshotsForDataset(DATASET_ID);
  for (const step of TIMELINE) {
    await recordDatasetSnapshot(DATASET_ID, step.payload, { at: step.at });
  }
});

afterAll(() => {
  process.env.SELLER_JWT_SECRET = originalSecret;
});

describe('GET /:id/history', () => {
  it('returns snapshot metadata and a change-frequency sparkline', async () => {
    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/history`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.snapshots).toHaveLength(3);
    expect(res.body.maxLimit).toBe(MAX_SNAPSHOTS_PER_REQUEST);
    expect(res.body.changeFrequency.length).toBeGreaterThan(0);
  });

  it('never includes payloads, even for the owning seller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/history`)
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`);

    expect(res.status).toBe(200);
    expect(res.body.snapshots[0]).not.toHaveProperty('payload');
    expect(res.body.snapshots[0]).not.toHaveProperty('data');
    expect(res.body.snapshots[0]).toHaveProperty('contentHash');
  });

  it('paginates', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/history`)
      .query({ limit: 2, offset: 2 });

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it('rejects a limit above the hard cap', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/history`)
      .query({ limit: MAX_SNAPSHOTS_PER_REQUEST + 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('404s for an unknown dataset', async () => {
    const res = await request(app).get('/api/v1/datasets/ds-missing/history');
    expect(res.status).toBe(404);
  });
});

describe('GET /:id/snapshots/at', () => {
  it('withholds the payload from an anonymous caller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T09:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.payloadWithheld).toBe(true);
    expect(res.body.data).toBeUndefined();
    expect(res.body.snapshot.validFrom).toBe('2026-08-03T06:00:00.000Z');
  });

  it('returns the payload that was live at that instant to the owning seller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T09:00:00.000Z' })
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(at(TIMELINE, 1).payload);
  });

  it('returns the payload to a buyer holding a completed purchase', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T00:00:00.000Z', txHash: purchase.txHash });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(at(TIMELINE, 0).payload);
  });

  it('withholds the payload when the purchase has not completed', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T00:00:00.000Z', txHash: pendingPurchase.txHash });

    expect(res.status).toBe(200);
    expect(res.body.payloadWithheld).toBe(true);
  });

  it('withholds the payload from another seller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T00:00:00.000Z' })
      .set('Authorization', `Bearer ${sellerToken(OTHER_SELLER)}`);

    expect(res.status).toBe(200);
    expect(res.body.payloadWithheld).toBe(true);
  });

  it('resolves an asOf exactly on a boundary to the snapshot that opened there', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2026-08-03T06:00:00.000Z', txHash: purchase.txHash });

    expect(res.body.data).toEqual(at(TIMELINE, 1).payload);
  });

  it('400s without an asOf', async () => {
    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`);
    expect(res.status).toBe(400);
  });

  it('404s for an instant before history begins', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/at`)
      .query({ asOf: '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(404);
  });
});

describe('GET /:id/snapshots/range', () => {
  it('returns only snapshots overlapping the window', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/range`)
      .query({ from: '2026-08-03T06:00:00.000Z', to: '2026-08-03T12:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].validFrom).toBe('2026-08-03T06:00:00.000Z');
  });

  it('includes payloads for a completed purchase', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/range`)
      .query({ txHash: purchase.txHash });

    expect(res.status).toBe(200);
    expect(res.body.snapshots.map((row: { data: unknown }) => row.data)).toEqual(
      TIMELINE.map(step => step.payload),
    );
  });

  it('keeps a large history within the row cap', async () => {
    for (let i = 0; i < MAX_SNAPSHOTS_PER_REQUEST + 25; i += 1) {
      await recordDatasetSnapshot(
        DATASET_ID,
        { tick: i },
        { at: new Date(Date.parse('2026-08-04T00:00:00.000Z') + i * 60_000).toISOString() },
      );
    }
    expect((await listAllSnapshots(DATASET_ID)).length).toBeGreaterThan(MAX_SNAPSHOTS_PER_REQUEST);

    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/range`)
      .query({ limit: MAX_SNAPSHOTS_PER_REQUEST, txHash: purchase.txHash });

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(MAX_SNAPSHOTS_PER_REQUEST);
    expect(res.body.total).toBeGreaterThan(MAX_SNAPSHOTS_PER_REQUEST);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/range`)
      .query({ from: '2026-08-03T12:00:00.000Z', to: '2026-08-03T00:00:00.000Z' });

    expect(res.status).toBe(400);
  });
});

describe('GET /:id/snapshots/diff', () => {
  it('gives anyone the counts but not the values', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/diff`)
      .query({ from: '2026-08-03T06:00:00.000Z', to: '2026-08-03T12:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(res.body.entriesWithheld).toBe(true);
    expect(res.body.entries).toBeUndefined();
  });

  it('returns the changed values to a buyer with a completed purchase', async () => {
    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/snapshots/diff`).query({
      from: '2026-08-03T00:00:00.000Z',
      to: '2026-08-03T06:00:00.000Z',
      txHash: purchase.txHash,
    });

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { path: 'wallets[GA].balance', op: 'changed', before: 1, after: 2 },
    ]);
  });

  it('accepts content hashes as endpoints', async () => {
    const rows = await listAllSnapshots(DATASET_ID);
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/diff`)
      .query({ from: at(rows, 0).contentHash, to: at(rows, 2).contentHash });

    expect(res.status).toBe(200);
    expect(res.body.identical).toBe(false);
  });

  it('404s when an endpoint resolves to nothing', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/diff`)
      .query({ from: '2020-01-01T00:00:00.000Z', to: '2026-08-03T06:00:00.000Z' });

    expect(res.status).toBe(404);
  });
});

describe('seller storage and policy routes', () => {
  it('reports storage stats and a projection to the owning seller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/storage`)
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`);

    expect(res.status).toBe(200);
    expect(res.body.stats.snapshotCount).toBe(3);
    expect(res.body.stats.storedBytes).toBeGreaterThan(0);
    expect(res.body.projection.steadyStateBytes).toBeGreaterThanOrEqual(0);
    expect(res.body.policy.retentionDays).toBe(365);
  });

  it('refuses another seller', async () => {
    const res = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/storage`)
      .set('Authorization', `Bearer ${sellerToken(OTHER_SELLER)}`);

    expect(res.status).toBe(403);
  });

  it('requires a token', async () => {
    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/snapshots/storage`);
    expect(res.status).toBe(401);
  });

  it('stores a retention policy', async () => {
    const policy = { retentionDays: 90, fullResolutionDays: 3, hourlyDays: 30 };
    const res = await request(app)
      .put(`/api/v1/datasets/${DATASET_ID}/snapshots/policy`)
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`)
      .send(policy);

    expect(res.status).toBe(200);
    expect(res.body.policy).toEqual(policy);

    const readBack = await request(app)
      .get(`/api/v1/datasets/${DATASET_ID}/snapshots/storage`)
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`);
    expect(readBack.body.policy).toEqual(policy);
  });

  it('rejects a policy whose bands are inverted', async () => {
    const res = await request(app)
      .put(`/api/v1/datasets/${DATASET_ID}/snapshots/policy`)
      .set('Authorization', `Bearer ${sellerToken(SELLER)}`)
      .send({ retentionDays: 90, fullResolutionDays: 40, hourlyDays: 10 });

    expect(res.status).toBe(400);
  });
});

describe('co-mounting with the datasets router', () => {
  // main.ts mounts both routers on the same path; `/:id` and `/:id/history`
  // must not shadow one another.
  it('serves dataset detail and dataset history from the same mount point', async () => {
    const combined = express();
    combined.use(express.json());
    combined.use('/api/v1/datasets', datasetsRouter);
    combined.use('/api/v1/datasets', snapshotsRouter);

    const detail = await request(combined).get(`/api/v1/datasets/${DATASET_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.dataset.id).toBe(DATASET_ID);

    const history = await request(combined).get(`/api/v1/datasets/${DATASET_ID}/history`);
    expect(history.status).toBe(200);
    expect(history.body.total).toBe(3);
  });
});

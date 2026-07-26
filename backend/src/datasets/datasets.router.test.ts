import crypto from 'crypto';
import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../common/storage', () => ({
  getAllDatasets: vi.fn(),
  getDataset: vi.fn(),
  addDataset: vi.fn(),
  updateDataset: vi.fn(),
  getTransactions: vi.fn(),
  getTransactionsCount: vi.fn(),
  getTransactionByHash: vi.fn(),
}));

const { mockIsValidStellarAddress } = vi.hoisted(() => ({
  mockIsValidStellarAddress: vi.fn<(address: string) => boolean>(),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: mockIsValidStellarAddress },
}));

import { datasetsRouter } from './datasets.router';
import {
  getAllDatasets,
  getDataset,
  addDataset,
  updateDataset,
  getTransactions,
  getTransactionsCount,
  getTransactionByHash,
} from '../common/storage';
import type { Dataset, Transaction } from '../common/storage';

const SELLER_A = `G${'A'.repeat(55)}`;
const SELLER_B = `G${'B'.repeat(55)}`;

const datasetA: Dataset = {
  id: 'ds-seller-a',
  name: 'Seller A Dataset',
  description: 'Seller A private dashboard data',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER_A,
  data: { hidden: true },
  queriesServed: 2,
  totalEarned: 1.9,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const datasetB: Dataset = {
  id: 'ds-seller-b',
  name: 'Seller B Dataset',
  description: 'Seller B private dashboard data',
  type: 'sentiment',
  pricePerQuery: 2,
  sellerWallet: SELLER_B,
  data: { hidden: true },
  queriesServed: 1,
  totalEarned: 1.9,
  createdAt: '2026-01-02T00:00:00.000Z',
};

const transactions: Transaction[] = [
  {
    id: 'tx-a',
    datasetId: datasetA.id,
    txHash: 'hash-a',
    amount: 1,
    sellerPaid: true,
    timestamp: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'tx-b',
    datasetId: datasetB.id,
    txHash: 'hash-b',
    amount: 2,
    sellerPaid: true,
    timestamp: '2026-01-04T00:00:00.000Z',
  },
];

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/datasets', datasetsRouter);
  return app;
}

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signSellerJwt(
  payload: Record<string, unknown>,
  secret = process.env.SELLER_JWT_SECRET ?? 'test-secret',
) {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('datasets seller dashboard auth', () => {
  let app: Express;
  const originalSellerJwtSecret = process.env.SELLER_JWT_SECRET;

  beforeEach(async () => {
    app = makeApp();
    process.env.SELLER_JWT_SECRET = 'test-secret';

    vi.mocked(getAllDatasets).mockResolvedValue([datasetA, datasetB]);
    vi.mocked(getDataset).mockImplementation(async (id: string) =>
      [datasetA, datasetB].find(d => d.id === id),
    );
    vi.mocked(getTransactions).mockImplementation(async (datasetId?: string) =>
      datasetId ? transactions.filter(t => t.datasetId === datasetId) : transactions,
    );
    vi.mocked(getTransactionsCount).mockImplementation(async (datasetId?: string) =>
      datasetId ? transactions.filter(t => t.datasetId === datasetId).length : transactions.length,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalSellerJwtSecret === undefined) {
      delete process.env.SELLER_JWT_SECRET;
    } else {
      process.env.SELLER_JWT_SECRET = originalSellerJwtSecret;
    }
  });

  it('rejects seller dashboard requests when the JWT secret is missing', async () => {
    delete process.env.SELLER_JWT_SECRET;

    const res = await request(app).get('/api/v1/datasets/seller/dashboard');

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('SELLER_JWT_SECRET');
  });

  it('requires a bearer token for seller dashboard data', async () => {
    const res = await request(app).get('/api/v1/datasets/seller/dashboard');

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization header');
  });

  it('rejects expired seller JWTs', async () => {
    const expiredToken = signSellerJwt({
      sellerWallet: SELLER_A,
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    const res = await request(app)
      .get('/api/v1/datasets/seller/dashboard')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid or expired');
  });

  it('returns only datasets and transactions owned by the JWT seller wallet', async () => {
    const token = signSellerJwt({
      sellerWallet: SELLER_A,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await request(app)
      .get('/api/v1/datasets/seller/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sellerWallet).toBe(SELLER_A);
    expect(res.body.datasets).toHaveLength(1);
    expect(res.body.datasets[0]).toMatchObject({ id: datasetA.id, sellerWallet: SELLER_A });
    expect(res.body.datasets[0].data).toBeUndefined();
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0]).toMatchObject({ id: 'tx-a', datasetId: datasetA.id });
    expect(res.body.stats).toEqual({
      totalDatasets: 1,
      totalQueries: 2,
      totalUsdcEarned: 1.9,
      totalTransactions: 1,
    });
  });

  it('scopes the legacy transactions endpoint to the JWT seller wallet', async () => {
    const token = signSellerJwt({
      sellerWallet: SELLER_B,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await request(app)
      .get('/api/v1/datasets/transactions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([
      expect.objectContaining({ id: 'tx-b', datasetId: datasetB.id }),
    ]);
  });

  it('blocks dataset transaction history for another seller', async () => {
    const token = signSellerJwt({
      sellerWallet: SELLER_A,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await request(app)
      .get(`/api/v1/datasets/${datasetB.id}/transactions`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

const VALID_WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const validDatasetBody = {
  name: 'Test Dataset',
  description: 'A dataset for testing wallet validation',
  type: 'trading-signals',
  pricePerQuery: 1.5,
  sellerWallet: VALID_WALLET,
  data: { key: 'value' },
};

describe('wallet address validation on POST /api/datasets', () => {
  let app: Express;
  const originalApiKey = process.env.API_KEY;
  const originalSellerJwtSecret = process.env.SELLER_JWT_SECRET;

  beforeEach(async () => {
    app = makeApp();
    process.env.API_KEY = 'test-api-key';
    process.env.SELLER_JWT_SECRET = 'test-secret';
    vi.mocked(getAllDatasets).mockResolvedValue([]);
    vi.mocked(getDataset).mockResolvedValue(undefined);
    vi.mocked(getTransactions).mockResolvedValue([]);
    vi.mocked(getTransactionsCount).mockResolvedValue(0);
    vi.mocked(addDataset).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }

    if (originalSellerJwtSecret === undefined) {
      delete process.env.SELLER_JWT_SECRET;
    } else {
      process.env.SELLER_JWT_SECRET = originalSellerJwtSecret;
    }
  });

  it('returns 401 when the auth token is missing', async () => {
    const res = await request(app).post('/api/v1/datasets').send(validDatasetBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization header');
  });

  it('accepts a valid 56-char G-address and creates the dataset', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send(validDatasetBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.dataset.sellerWallet).toBe(VALID_WALLET);
  });

  it('stores a valid notification email without exposing it in the response', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({ ...validDatasetBody, notificationEmail: 'seller@example.com' });

    expect(res.status).toBe(201);
    expect(addDataset).toHaveBeenCalledWith(
      expect.objectContaining({ notificationEmail: 'seller@example.com' }),
    );
    expect(res.body.dataset.notificationEmail).toBeUndefined();
  });

  it('rejects an invalid notification email', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({ ...validDatasetBody, notificationEmail: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(addDataset).not.toHaveBeenCalled();
  });

  it('treats a blank notification email as opting out', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({ ...validDatasetBody, notificationEmail: '   ' });

    expect(res.status).toBe(201);
    expect(addDataset).toHaveBeenCalledWith(
      expect.objectContaining({ notificationEmail: undefined }),
    );
  });

  it('accepts a seller JWT when the wallet matches the request body', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const token = signSellerJwt({
      sellerWallet: VALID_WALLET,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', `Bearer ${token}`)
      .send(validDatasetBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('rejects a seller JWT when the wallet does not match the request body', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    const token = signSellerJwt({
      sellerWallet: SELLER_A,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', `Bearer ${token}`)
      .send(validDatasetBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('does not match');
  });

  it('rejects a wallet address that is too short', async () => {
    mockIsValidStellarAddress.mockReturnValue(false);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({
        ...validDatasetBody,
        sellerWallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFL',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid Stellar address');
  });

  it('rejects a wallet address that does not start with G', async () => {
    mockIsValidStellarAddress.mockReturnValue(false);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({
        ...validDatasetBody,
        sellerWallet: 'XBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid Stellar address');
  });

  it('rejects a wallet address that fails the Stellar SDK checksum check', async () => {
    mockIsValidStellarAddress.mockReturnValue(false);

    const res = await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send({
        ...validDatasetBody,
        sellerWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid Stellar address');
  });

  it('calls StrKey.isValidEd25519PublicKey with the submitted wallet address', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);

    await request(app)
      .post('/api/v1/datasets')
      .set('Authorization', 'Bearer test-api-key')
      .send(validDatasetBody);

    expect(mockIsValidStellarAddress).toHaveBeenCalledWith(VALID_WALLET);
  });
});

// ── POST/GET /:id/ratings ─────────────────────────────────────────────────────

const DATASET_ID = 'ds-rate-me';
const TX_HASH = 'abc123txhash';

const baseDataset: Dataset = {
  id: DATASET_ID,
  name: 'Rateable Dataset',
  description: 'A dataset with ratings',
  type: 'sentiment',
  pricePerQuery: 1,
  sellerWallet: SELLER_A,
  data: {},
  queriesServed: 1,
  totalEarned: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const deliveredTx: Transaction = {
  id: 'tx-rate',
  datasetId: DATASET_ID,
  txHash: TX_HASH,
  amount: 1,
  deliveryStatus: 'delivered',
  timestamp: '2026-01-05T00:00:00.000Z',
};

describe('POST /api/v1/datasets/:id/ratings', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockResolvedValue({ ...baseDataset });
    vi.mocked(getTransactionByHash).mockResolvedValue(deliveredTx);
    vi.mocked(updateDataset).mockImplementation(
      async (_id, updates) =>
        ({
          ...baseDataset,
          ...updates,
        }) as Dataset,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a valid txHash + score and returns the updated ratings', async () => {
    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 4 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.ratings.reviews).toHaveLength(1);
    expect(res.body.ratings.reviews[0]).toMatchObject({ txHash: TX_HASH, score: 4 });
    expect(res.body.ratings.count).toBe(1);
    expect(res.body.ratings.score).toBe(4);
  });

  it('stores an optional comment alongside the review', async () => {
    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 5, comment: 'Great dataset!' });

    expect(res.status).toBe(201);
    expect(res.body.ratings.reviews[0].comment).toBe('Great dataset!');
  });

  it('returns 400 when txHash is missing (bare score rejected)', async () => {
    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ score: 3 });

    expect(res.status).toBe(400);
    expect(updateDataset).not.toHaveBeenCalled();
  });

  it('returns 400 when score is out of range', async () => {
    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 6 });

    expect(res.status).toBe(400);
    expect(updateDataset).not.toHaveBeenCalled();
  });

  it('returns 404 when the dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/v1/datasets/nonexistent/ratings`)
      .send({ txHash: TX_HASH, score: 3 });

    expect(res.status).toBe(404);
  });

  it('returns 403 when txHash does not exist', async () => {
    vi.mocked(getTransactionByHash).mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: 'unknown-hash', score: 3 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Invalid transaction hash');
  });

  it('returns 403 when txHash belongs to a different dataset', async () => {
    vi.mocked(getTransactionByHash).mockResolvedValue({ ...deliveredTx, datasetId: 'other-ds' });

    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 3 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Invalid transaction hash');
  });

  it('returns 403 when delivery is not yet complete', async () => {
    vi.mocked(getTransactionByHash).mockResolvedValue({
      ...deliveredTx,
      deliveryStatus: 'pending',
    });

    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 3 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('delivered before rating');
  });

  it('returns 409 on duplicate txHash (prevents repeat ratings)', async () => {
    const datasetWithReview: Dataset = {
      ...baseDataset,
      ratings: {
        score: 4,
        count: 1,
        reviews: [{ txHash: TX_HASH, score: 4, timestamp: '2026-01-05T00:00:00.000Z' }],
      },
    };
    vi.mocked(getDataset).mockResolvedValue(datasetWithReview);

    const res = await request(app)
      .post(`/api/v1/datasets/${DATASET_ID}/ratings`)
      .send({ txHash: TX_HASH, score: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Duplicate rating');
    expect(updateDataset).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/datasets/:id/ratings', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns score, count, and paginated reviews', async () => {
    const datasetWithReviews: Dataset = {
      ...baseDataset,
      ratings: {
        score: 4.5,
        count: 2,
        reviews: [
          { txHash: 'tx-1', score: 4, timestamp: '2026-01-05T00:00:00.000Z' },
          { txHash: 'tx-2', score: 5, timestamp: '2026-01-06T00:00:00.000Z' },
        ],
      },
    };
    vi.mocked(getDataset).mockResolvedValue(datasetWithReviews);

    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/ratings`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.score).toBe(4.5);
    expect(res.body.count).toBe(2);
    expect(res.body.reviews).toHaveLength(2);
  });

  it('returns empty reviews for a dataset with no ratings', async () => {
    vi.mocked(getDataset).mockResolvedValue({ ...baseDataset });

    const res = await request(app).get(`/api/v1/datasets/${DATASET_ID}/ratings`);

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.count).toBe(0);
    expect(res.body.reviews).toEqual([]);
  });

  it('returns 404 when the dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app).get(`/api/v1/datasets/nonexistent/ratings`);

    expect(res.status).toBe(404);
  });
});
